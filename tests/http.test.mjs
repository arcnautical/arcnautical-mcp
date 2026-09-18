/**
 * The remote endpoint the way a hosted client uses it: the official MCP client
 * over Streamable HTTP against createHttpServer(), with the REST API replaced
 * by a stub that records what it was sent — so the forwarded caller address
 * and the Bearer key are asserted, not assumed — plus one keyless round trip
 * to prod, as the stdio tests do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNodeServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../dist/http.js';

const CHECK = {
  imo: '9274446', sanctions: { status: 'RED', detail: '4 confirmed matches on vessel identifier.', coverageComplete: true },
  ownership: { opacity: 'HIGH', score: 90 }, vetting: { grade: 'E', score: 12, status: 'unacceptable' }, assessed: true,
  checkedAt: '2026-09-18T12:00:00.000Z', fullReport: 'https://arcnautical.com/check?imo=9274446',
};

/** A stand-in for arcnautical.com that remembers every request's headers. */
function stubApi() {
  const seen = [];
  const server = createNodeServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
      if (/^\/api\/v1\/vessels\/\d{7}\/check$/.test(req.url)) return send(200, CHECK, { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '97', 'x-ratelimit-reset': '2026-09-18T13:00:00.000Z' });
      if (req.url.startsWith('/api/v1/ports')) return send(200, { ports: [{ locode: 'NLRTM', name: 'Rotterdam', country: 'NL' }] });
      if (req.url === '/api/v1/screenings' && req.method === 'POST') {
        if (!/^Bearer /.test(req.headers.authorization ?? '')) return send(401, { code: 'unauthorized', message: 'no key' });
        return send(201, { id: 'a1b2', imo: JSON.parse(body).imo, sanctions: { status: 'GREEN', detail: 'No match.' }, screened_at: '2026-09-18T12:00:01.000Z' });
      }
      send(404, { code: 'not_found', message: req.url });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function connect(base, headers = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

test('remote: initialize, list seven tools, call the keyless tool, and the stub sees the caller address', async (t) => {
  const api = await stubApi();
  const http = createHttpServer({ baseUrl: api.url, trustProxy: true, log: false });
  const base = await listen(http);
  t.after(() => { http.close(); api.server.close(); });

  const client = await connect(base, { 'X-Real-IP': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['check_vessel', 'find_port', 'get_screening', 'get_usage', 'score_voyage', 'screen_vessel', 'screen_vessels']);

  const r = await client.callTool({ name: 'check_vessel', arguments: { imo: '9274446' } });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.sanctions.status, 'RED');
  assert.match(r.content[0].text, /IMO 9274446: sanctions RED/);
  assert.equal(r.structuredContent.rate_limit.remaining, 97);

  // Declared output shapes, and empty (not refused) resource/prompt lists.
  const check = tools.find((x) => x.name === 'check_vessel');
  assert.ok(check.outputSchema?.properties?.sanctions, 'check_vessel declares its output');
  for (const tool of tools) {
    assert.ok(tool.outputSchema?.type === 'object', `${tool.name} declares an output shape`);
    for (const [name, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.ok(prop.description, `${tool.name}.${name} has a parameter description`);
    }
  }
  const init = client.getServerVersion();
  assert.equal(init.title, 'ArcNautical');
  assert.match(init.description, /sanctions/);
  assert.equal(init.icons[0].src, 'https://arcnautical.com/logo-512.png');
  assert.deepEqual((await client.listResources()).resources, []);
  assert.deepEqual((await client.listPrompts()).prompts, []);
  await client.close();

  const upstream = api.seen.find((s) => s.url.endsWith('/check'));
  assert.ok(upstream, 'the stub API received the check');
  assert.equal(upstream.headers['x-forwarded-for'], '203.0.113.9', 'the ORIGINAL caller is forwarded, not the endpoint');
  assert.equal(upstream.headers['cf-connecting-ip'], '203.0.113.9');
  assert.equal(upstream.headers.authorization, undefined, 'the keyless endpoint never receives a key');
  assert.match(upstream.headers['user-agent'], /@arcnautical\/mcp \(remote\)/);
});

test('remote: a Bearer header on the MCP request reaches the keyed endpoint; without it the remedy names the header', async (t) => {
  const api = await stubApi();
  const http = createHttpServer({ baseUrl: api.url, trustProxy: false, log: false });
  const base = await listen(http);
  t.after(() => { http.close(); api.server.close(); });

  const keyed = await connect(base, { Authorization: 'Bearer arc_test_abc' });
  const ok = await keyed.callTool({ name: 'screen_vessel', arguments: { imo: '9274446' } });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.structuredContent.id, 'a1b2');
  assert.match(ok.content[0].text, /sanctions GREEN/);
  await keyed.close();
  const screening = api.seen.find((s) => s.url === '/api/v1/screenings');
  assert.equal(screening.headers.authorization, 'Bearer arc_test_abc');
  assert.match(screening.headers['idempotency-key'], /^mcp:screening:9274446:\d{4}-\d{2}-\d{2}$/);

  // A gateway in front of the endpoint (Smithery) forwards the user's key as a
  // header of its own naming, with no scheme; a bare Authorization also works.
  for (const headers of [{ 'arcnautical-api-key': 'arc_test_gw' }, { 'X-API-Key': 'arc_test_gw' }, { Authorization: 'arc_test_gw' }]) {
    api.seen.length = 0;
    const gw = await connect(base, headers);
    const r = await gw.callTool({ name: 'screen_vessel', arguments: { imo: '9274446' } });
    assert.equal(r.isError, undefined, JSON.stringify(headers));
    assert.equal(api.seen.find((s) => s.url === '/api/v1/screenings').headers.authorization, 'Bearer arc_test_gw', JSON.stringify(headers));
    await gw.close();
  }

  const anon = await connect(base);
  const no = await anon.callTool({ name: 'screen_vessel', arguments: { imo: '9274446' } });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /Authorization: Bearer/);
  assert.match(no.content[0].text, /developer-api/);
  assert.match(no.content[0].text, /check_vessel/);
  assert.doesNotMatch(no.content[0].text, /ARCNAUTICAL_API_KEY/, 'an HTTP caller has no environment to set');
  await anon.close();
});

test('remote: HTTP shape — JSON for curl, 405 with Allow on GET, CORS preflight, /health, 413, no session id', async (t) => {
  const api = await stubApi();
  const http = createHttpServer({ baseUrl: api.url, log: false });
  const base = await listen(http);
  t.after(() => { http.close(); api.server.close(); });

  // curl with a narrow Accept — the spec wants both media types, we answer JSON regardless.
  const curl = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_port', arguments: { query: 'rotterdam' } } }) });
  assert.equal(curl.status, 200);
  assert.match(curl.headers.get('content-type'), /application\/json/);
  assert.equal(curl.headers.get('mcp-session-id'), null, 'stateless: a client must never be asked to hold a session');
  assert.match(curl.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const body = await curl.json();
  assert.match(body.result.content[0].text, /NLRTM/);

  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
  assert.equal((await get.json()).error.code, -32000);

  const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.equal(h.status, 'ok');
  assert.equal(h.upstream, api.url);

  const big = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"pad":"${'x'.repeat(300 * 1024)}"}` });
  assert.equal(big.status, 413);

  const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);

  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.match(root.headers.get('location'), /developers\/#mcp$/);
});

test('remote: check_vessel screens a real hull with no key through the endpoint (prod upstream)', async (t) => {
  const http = createHttpServer({ baseUrl: 'https://arcnautical.com', log: false });
  const base = await listen(http);
  t.after(() => http.close());
  const client = await connect(base);
  const r = await client.callTool({ name: 'check_vessel', arguments: { imo: '9274446' } });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.imo, '9274446');
  assert.ok(['RED', 'AMBER', 'GREEN', 'INCOMPLETE'].includes(r.structuredContent.sanctions.status));
  assert.equal(r.structuredContent.rate_limit.limit, 100);
  await client.close();
});
