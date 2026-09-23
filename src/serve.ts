#!/usr/bin/env node
/**
 * `arcnautical-mcp --http` — the remote endpoint as a process. Listens on
 * PORT (3005) and serves POST /mcp; see http.ts for the shape. This is what
 * the arcnautical-mcp container on prod runs, and what anyone self-hosting a
 * keyed endpoint for their own assistants would run.
 */
import { createHttpServer, MCP_PATH } from './http.js';
import { SERVER_NAME, SERVER_VERSION } from './index.js';

const port = Number(process.env.PORT ?? 3005);
// No host unless one is given: node then binds dual-stack (`::`, falling back
// to 0.0.0.0 where the container has no IPv6). Binding 0.0.0.0 explicitly cost
// the first deploy: alpine's /etc/hosts lists ::1 for localhost first, so the
// container's own `wget http://localhost:3005/health` was refused and the
// standby never reported healthy.
const host = process.env.HOST;
const server = createHttpServer();

const ready = () => {
  const upstream = process.env.ARCNAUTICAL_BASE_URL ?? 'https://arcnautical.com';
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready: POST http://${host ?? 'localhost'}:${port}${MCP_PATH} → ${upstream}${process.env.MCP_TRUST_PROXY === '1' ? ' (trusting the reverse proxy)' : ''}\n`);
};
if (host) server.listen(port, host, ready); else server.listen(port, ready);

// Docker sends SIGTERM and waits; finish in-flight responses, then exit.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
