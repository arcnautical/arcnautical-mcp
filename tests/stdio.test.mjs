/**
 * The server the way a client runs it: spawn dist/cli.js over stdio with the
 * official MCP client, list tools, call the two keyless tools against prod,
 * and call a keyed tool WITHOUT a key to see the remedy the model receives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

async function connect(env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: { ...process.env, ARCNAUTICAL_API_KEY: '', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

test('lists seven tools with the two keyless ones marked read-only', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['check_vessel', 'find_port', 'get_screening', 'get_usage', 'score_voyage', 'screen_vessel', 'screen_vessels']);
  const check = tools.find(t => t.name === 'check_vessel');
  assert.equal(check.annotations.readOnlyHint, true);
  assert.match(check.description, /no API key/i);
  assert.deepEqual(check.inputSchema.required, ['imo']);
  await client.close();
});

test('check_vessel screens a real hull with no key (prod)', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'check_vessel', arguments: { imo: '9274446' } });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.imo, '9274446');
  assert.ok(['RED', 'AMBER', 'GREEN', 'INCOMPLETE'].includes(r.structuredContent.sanctions.status));
  assert.match(r.content[0].text, /IMO 9274446: sanctions (RED|AMBER|GREEN|INCOMPLETE)/);
  assert.ok(r.structuredContent.rate_limit.limit === 100, 'keyless limit header should be 100');
  await client.close();
});

test('check_vessel refuses a malformed IMO before any request', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'check_vessel', arguments: { imo: '12345' } });
  assert.equal(r.isError, true);
  await client.close();
});

test('find_port resolves rotterdam to NLRTM with no key (prod)', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'find_port', arguments: { query: 'rotterdam', limit: 3 } });
  assert.equal(r.isError, undefined);
  assert.ok(r.structuredContent.ports.some(p => p.locode === 'NLRTM'));
  assert.match(r.content[0].text, /NLRTM/);
  await client.close();
});

test('a keyed tool without a key returns the remedy, not a crash', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'screen_vessel', arguments: { imo: '9274446' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ARCNAUTICAL_API_KEY/);
  assert.match(r.content[0].text, /get-a-key/);
  assert.match(r.content[0].text, /check_vessel/);
  await client.close();
});
