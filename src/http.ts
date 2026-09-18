/**
 * The remote endpoint: the same seven tools over MCP Streamable HTTP, at
 * https://mcp.arcnautical.com/mcp — so an assistant that cannot run a local
 * process (claude.ai custom connectors, ChatGPT, a hosted agent) can still
 * screen a hull.
 *
 * Shape, and why:
 *
 *   STATELESS. Every POST gets a fresh McpServer and transport and is
 *   answered as plain JSON, never a long-lived stream. The tools are
 *   request/response, so a session buys nothing and costs a sticky-routing
 *   problem the moment there are two containers. GET /mcp (the server-to-client
 *   stream) is therefore 405, which the spec allows.
 *
 *   A THIN CLIENT OF THE PUBLIC API. Tool calls become the same REST requests
 *   a curl user makes, sent to ARCNAUTICAL_BASE_URL. On prod that is the edge
 *   itself over the docker network, with the original caller's address in
 *   X-Forwarded-For — so the keyless/keyed lane split, the rate zones, the
 *   access log and the per-address keyless allowance apply to a remote MCP
 *   caller exactly as to anyone else. Nothing here bypasses anything.
 *
 *   AUTH IS A HEADER, OR NOTHING. `Authorization: Bearer <api key>` on the MCP
 *   request is forwarded to the keyed endpoints. No header = the keyless door:
 *   check_vessel and find_port work, the rest return the remedy. That is what
 *   "add connector, no authentication" produces in every hosted client.
 *
 * Env: PORT (3005), HOST (0.0.0.0), ARCNAUTICAL_BASE_URL, MCP_TRUST_PROXY=1
 * (read X-Real-IP / CF-Connecting-IP / X-Request-Id from the reverse proxy —
 * only when nothing but the proxy can reach this port).
 */
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './index.js';

export const DOCS_URL = 'https://arcnautical.com/developers/#mcp';
export const MCP_PATH = '/mcp';
/** A batch of 50 IMOs is under 2 KB; nothing legitimate approaches this. */
const MAX_BODY_BYTES = 256 * 1024;

export interface HttpServerOptions {
  /** Where the tools send their REST calls. Default https://arcnautical.com. */
  baseUrl?: string;
  /** Trust the reverse proxy's X-Real-IP / CF-Connecting-IP / X-Request-Id. */
  trustProxy?: boolean;
  /** One line per request, to stderr. Default on. */
  log?: boolean;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, X-Request-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, X-Request-Id',
  'Access-Control-Max-Age': '86400',
};

/** Build the node http.Server. It is not listening; the caller decides the port. */
export function createHttpServer(opts: HttpServerOptions = {}): Server {
  const baseUrl = opts.baseUrl ?? process.env.ARCNAUTICAL_BASE_URL ?? 'https://arcnautical.com';
  const trustProxy = opts.trustProxy ?? process.env.MCP_TRUST_PROXY === '1';
  const log = opts.log ?? true;

  return createNodeServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const requestId = (trustProxy && header('x-request-id')) || randomUUID();
    const callerIp = (trustProxy && (header('x-real-ip') || header('x-forwarded-for')?.split(',')[0]?.trim()))
      || req.socket.remoteAddress || 'unknown';
    const cfIp = trustProxy ? header('cf-connecting-ip') : undefined;
    let note = '';

    res.setHeader('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (log) {
      res.once('finish', () => {
        process.stderr.write(`[mcp-http] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms ip=${callerIp} rid=${requestId}${note}\n`);
      });
    }

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (url.pathname === '/health') {
        json(res, 200, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, transport: 'streamable-http', stateless: true, upstream: baseUrl, docs: DOCS_URL });
        return;
      }
      if (url.pathname === '/' || url.pathname === '') {
        res.writeHead(302, { Location: DOCS_URL, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`ArcNautical MCP server ${SERVER_VERSION}. Endpoint: POST ${MCP_PATH}. Docs: ${DOCS_URL}\n`);
        return;
      }
      if (url.pathname !== MCP_PATH) {
        json(res, 404, rpcError(-32601, `Not found. The MCP endpoint is POST ${MCP_PATH}; documentation is at ${DOCS_URL}.`, requestId));
        return;
      }
      if (req.method !== 'POST') {
        // Stateless: there is no server-to-client stream to open (GET) and no
        // session to end (DELETE). Say so in JSON-RPC, with Allow, rather than
        // let a client conclude the URL is wrong.
        res.setHeader('Allow', 'POST, OPTIONS');
        json(res, 405, rpcError(-32000, `This server is stateless: ${req.method} has nothing to return. Send JSON-RPC as POST ${MCP_PATH}.`, requestId));
        return;
      }

      const raw = await readBody(req, MAX_BODY_BYTES);
      if (raw === null) {
        json(res, 413, rpcError(-32600, `Request body exceeds ${MAX_BODY_BYTES} bytes.`, requestId));
        return;
      }
      let body: unknown;
      try { body = JSON.parse(raw); } catch {
        json(res, 400, rpcError(-32700, 'Parse error: the body is not JSON.', requestId));
        return;
      }
      const method = rpcMethod(body);
      note = ` method=${method ?? '?'}`;
      if (method === 'tools/call') note += ` tool=${rpcToolName(body) ?? '?'}`;

      // The spec has the client accept both JSON and an event stream, and the
      // SDK refuses (406) an Accept header naming only one. We only ever answer
      // JSON, so a curl with `Accept: application/json` — or none — is fine:
      // widen the header before the transport reads it.
      const accept = header('accept') ?? '';
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        req.headers.accept = 'application/json, text/event-stream';
      }
      if (!(header('content-type') ?? '').includes('application/json')) req.headers['content-type'] = 'application/json';

      const auth = header('authorization') ?? '';
      const apiKey = /^bearer\s+(\S+)/i.exec(auth)?.[1];
      note += ` keyed=${apiKey ? 'yes' : 'no'}`;

      const server = createServer({ baseUrl, apiKey, transport: 'http', forwardedFor: callerIp, cfConnectingIp: cfIp });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      note += ` error=${(err as Error).message}`;
      if (!res.headersSent) json(res, 500, rpcError(-32603, `Internal error: ${(err as Error).message}`, requestId));
      else res.end();
    }
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function rpcError(code: number, message: string, requestId: string) {
  return { jsonrpc: '2.0' as const, error: { code, message, data: { request_id: requestId, docs: DOCS_URL } }, id: null };
}

function rpcMethod(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body;
  return first && typeof first === 'object' && typeof (first as { method?: unknown }).method === 'string' ? (first as { method: string }).method : undefined;
}

function rpcToolName(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body;
  const name = (first as { params?: { name?: unknown } } | undefined)?.params?.name;
  return typeof name === 'string' ? name : undefined;
}

/** The body, or null when it exceeds the limit (drained, not destroyed, so the 413 is delivered). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
