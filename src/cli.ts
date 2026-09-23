#!/usr/bin/env node
/**
 * `npx @arcnautical/mcp` — stdio transport, the way Claude Desktop, Claude
 * Code, Cursor, VS Code and Windsurf launch a local MCP server.
 *
 *   ARCNAUTICAL_API_KEY   optional; unlocks screen_vessel, screen_vessels,
 *                         get_screening, score_voyage, get_usage.
 *   ARCNAUTICAL_BASE_URL  optional; defaults to https://arcnautical.com.
 *
 * Nothing is written to stdout except protocol frames — logs go to stderr.
 *
 * `--http` serves the remote transport instead (serve.ts). It is a flag and
 * not a second bin on purpose: with two bins and neither named `mcp`, npx
 * cannot tell which to run, and `npx -y @arcnautical/mcp` — the command in
 * the README, /developers/ and the MCP registry — failed with "could not
 * determine executable to run" for every install of 0.2.0.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './index.js';

if (process.argv.includes('--http')) {
  await import('./serve.js');
} else {
  const server = createServer({ transport: 'stdio' });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio${process.env.ARCNAUTICAL_API_KEY ? ' (API key configured)' : ' (keyless: check_vessel and find_port)'}\n`);
}
