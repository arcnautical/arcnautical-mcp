/**
 * ArcNautical MCP server.
 *
 * Seven tools over the ArcNautical API (https://arcnautical.com/developers/).
 * Two work with no key at all — `check_vessel` and `find_port` — so a client
 * that installs this with no configuration can already answer "is this ship
 * sanctioned?". The rest use ARCNAUTICAL_API_KEY when it is set and explain
 * how to get one when it is not.
 *
 * Every tool returns the API's JSON as structured content AND a short text
 * rendering, because some clients show only one of the two.
 *
 * The same server is served two ways: over stdio by cli.ts (a local install)
 * and over Streamable HTTP by http.ts (https://mcp.arcnautical.com/mcp). The
 * tools do not know which; only the client's key remedy and the forwarded
 * caller address differ, and both arrive through ClientOptions.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ArcNauticalClient, ArcNauticalError, type ClientOptions } from './client.js';

export { ArcNauticalClient, ArcNauticalError } from './client.js';
export type { ClientOptions } from './client.js';

export const SERVER_NAME = 'arcnautical';
export const SERVER_VERSION = '0.2.0';

const IMO = z.string().regex(/^\d{7}$/, 'A seven-digit IMO number, e.g. 9274446').describe('Seven-digit IMO number of the vessel');

const KEYLESS_NOTE =
  'Works with no API key. Rate-limited to 100 requests per hour per IP. Returns the VERDICT SUMMARY only; ' +
  'for every sanctions match with its source list and confidence class use screen_vessel (needs a key).';

function text(s: string) {
  return { type: 'text' as const, text: s };
}

function ok(structured: Record<string, unknown>, summary: string) {
  return { content: [text(summary), text(JSON.stringify(structured, null, 2))], structuredContent: structured };
}

function fail(err: unknown) {
  if (err instanceof ArcNauticalError) {
    const lines = [`ArcNautical API error ${err.status || ''} ${err.body.code ?? ''}`.trim(), err.body.message ?? ''];
    if (err.body.remedy) lines.push(`Remedy: ${err.body.remedy}`);
    if (err.body.field_violations?.length) lines.push(...err.body.field_violations.map(v => `- ${v.field}: ${v.message}`));
    if (err.requestId) lines.push(`request_id: ${err.requestId}`);
    return { content: [text(lines.filter(Boolean).join('\n'))], isError: true as const, structuredContent: { error: err.body, status: err.status } };
  }
  return { content: [text(`Unexpected error: ${(err as Error).message}`)], isError: true as const };
}

function verdictLine(imo: string, s: { sanctions?: { status?: string; detail?: string; coverage_complete?: boolean; coverageComplete?: boolean }; ownership?: { opacity?: string | null }; vetting?: { grade?: string | null; status?: string }; assessed?: boolean; vessel_name?: string | null }) {
  const name = s.vessel_name ? ` ${s.vessel_name}` : '';
  const status = s.sanctions?.status ?? 'UNKNOWN';
  const detail = s.sanctions?.detail ? ` — ${s.sanctions.detail.replace(/\.$/, '')}` : '';
  const coverage = (s.sanctions?.coverage_complete ?? s.sanctions?.coverageComplete) === false ? ' (a sanctions source was unreachable: re-screen before relying on a clear)' : '';
  const assessed = s.assessed === false ? ' NOT ASSESSED: ownership and vetting are defaults, not findings.' : '';
  const ownership = s.ownership?.opacity ? ` Ownership opacity ${s.ownership.opacity}.` : '';
  const vetting = s.vetting?.grade ? ` Vetting grade ${s.vetting.grade}${s.vetting.status ? ` (${s.vetting.status})` : ''}.` : '';
  return `IMO ${imo}${name}: sanctions ${status}${detail}${coverage}.${assessed}${ownership}${vetting}`;
}

export function createServer(opts: ClientOptions = {}): McpServer {
  const apiKey = opts.apiKey ?? process.env.ARCNAUTICAL_API_KEY;
  const client = new ArcNauticalClient({ ...opts, apiKey, baseUrl: opts.baseUrl ?? process.env.ARCNAUTICAL_BASE_URL });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'ArcNautical screens commercial vessels for sanctions and risk. Identify a ship by its seven-digit IMO number ' +
        '(never by name alone: names repeat and change). Use check_vessel for a quick verdict with no key; use screen_vessel ' +
        'for the full evidence record when an API key is configured. Sanctions status semantics: RED = confirmed match on ' +
        'the vessel identifier, AMBER = possible match needing review, GREEN = no match against the sources reached, ' +
        'INCOMPLETE = a core source could not be read, which must never be presented as clear. Always quote the status, ' +
        'the checkedAt/screened_at time, and say that designations change daily.',
    },
  );

  server.registerTool(
    'check_vessel',
    {
      title: 'Check a vessel (no key)',
      description:
        'Screen one vessel by IMO number against OFAC SDN, EU, UN, UK OFSI and OpenSanctions, with an ownership-opacity score ' +
        'and an A–E vetting grade from port-state-control history. ' + KEYLESS_NOTE,
      inputSchema: { imo: IMO },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ imo }) => {
      try {
        const { body, rateLimit } = await client.checkVessel(imo);
        const summary = `${verdictLine(imo, body)} Checked ${body.checkedAt}.` +
          (rateLimit.remaining !== null ? ` (${rateLimit.remaining} keyless checks left this hour.)` : '') +
          (body.fullReport ? ` Report: ${body.fullReport}` : '');
        return ok({ ...body, rate_limit: rateLimit }, summary);
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    'find_port',
    {
      title: 'Find a port / UN/LOCODE (no key)',
      description:
        'Resolve a port name, country or partial UN/LOCODE to the LOCODEs the routing engine knows. Routes are addressed by ' +
        'LOCODE, so call this before score_voyage rather than guessing a code. Works with no API key.',
      inputSchema: {
        query: z.string().min(2).describe('Port name, country, or LOCODE fragment, e.g. "rotterdam", "NLRTM", "Piraeus"'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum matches to return (default 5)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ query, limit }) => {
      try {
        const body = (await client.findPort(query, limit ?? 5)) as { ports?: Array<{ locode: string; name: string; country?: string }> };
        const ports = body.ports ?? [];
        const summary = ports.length
          ? `${ports.length} match(es) for "${query}": ` + ports.map(p => `${p.locode} ${p.name}${p.country ? `, ${p.country}` : ''}`).join('; ')
          : `No port matches "${query}".`;
        return ok(body as Record<string, unknown>, summary);
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    'screen_vessel',
    {
      title: 'Screen a vessel (full record, API key)',
      description:
        'The authenticated screening record for one vessel: every sanctions match with its source list, programme and ' +
        'confidence class, ownership opacity, the graded vetting factors, per-source freshness, and a retained record id. ' +
        'Needs ARCNAUTICAL_API_KEY. Metered: 5,000 live screenings a month are included with a self-serve key. The same ' +
        'vessel asked again on the same day replays the stored record free. If the result is INCOMPLETE for identity, ' +
        'call again with vessel_name.',
      inputSchema: {
        imo: IMO,
        vessel_name: z.string().min(1).max(200).optional().describe('Only when a previous screen was INCOMPLETE for identity; a name you can confirm'),
        customer_reference: z.string().max(128).optional().describe('Your own reference (order id, voyage id); echoed on the record'),
        include_vetting: z.boolean().optional().describe('false skips the vetting grade for a faster sanctions-only screen'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    async (input) => {
      try {
        const { body, replayed } = await client.screenVessel(input);
        const rec = body as Parameters<typeof verdictLine>[1] & { id?: string; screened_at?: string; notices?: unknown[] };
        const summary = `${verdictLine(input.imo, rec)} Record ${rec.id ?? '?'} screened ${rec.screened_at ?? '?'}${replayed ? ' (replayed from an earlier screen today, no unit spent)' : ''}.`;
        return ok(body as Record<string, unknown>, summary);
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    'screen_vessels',
    {
      title: 'Screen up to 50 vessels (API key)',
      description:
        'Batch-screen a list of IMO numbers and wait for the results (up to two minutes). Returns one verdict per hull plus the ' +
        'batch status. Needs ARCNAUTICAL_API_KEY. Each hull spends one screening unit unless it was already screened today.',
      inputSchema: {
        imos: z.array(IMO).min(1).max(50).describe('Up to 50 seven-digit IMO numbers'),
        include_vetting: z.boolean().optional().describe('false skips the vetting grade for a faster sanctions-only screen'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ imos, include_vetting }) => {
      try {
        const { batch, items, timedOut } = await client.screenVessels(imos, { include_vetting });
        const rows = (items as Array<{ imo: string | null; status: string; screening_id: string | null; result_body?: Parameters<typeof verdictLine>[1]; error_body?: { message?: string } | null }>);
        const lines = rows.map(r => r.result_body
          ? verdictLine(r.imo ?? '?', r.result_body)
          : `IMO ${r.imo ?? '?'}: ${r.status}${r.error_body?.message ? ` — ${r.error_body.message}` : ''}`);
        const head = `Batch ${batch.id} ${batch.status}${timedOut ? ' (still running when the wait expired; call get_screening_batch later)' : ''}: ${rows.length} hull(s).`;
        return ok({ batch, items }, [head, ...lines].join('\n'));
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    'get_screening',
    {
      title: 'Retrieve a screening record (API key)',
      description: 'Fetch a stored screening record by id — the audit copy, retained ten years. Needs ARCNAUTICAL_API_KEY.',
      inputSchema: { id: z.string().uuid().describe('Screening id returned by screen_vessel or in a batch item') },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      try {
        const body = (await client.getScreening(id)) as Parameters<typeof verdictLine>[1] & { imo?: string; screened_at?: string };
        return ok(body as Record<string, unknown>, `${verdictLine(body.imo ?? '?', body)} Screened ${body.screened_at ?? '?'}.`);
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    'score_voyage',
    {
      title: 'Score a voyage route (API key)',
      description:
        'Route risk between two ports (UN/LOCODEs): a 0–100 score, risk level, the signals driving it (war-risk areas, piracy, ' +
        'chokepoints, weather, sanctions exposure of transited EEZs), confidence and any missing sources. Resolve port names ' +
        'with find_port first. Needs ARCNAUTICAL_API_KEY; 10,000 assessments a month are included with a self-serve key.',
      inputSchema: {
        origin: z.string().regex(/^[A-Za-z]{5}$/).describe('Origin UN/LOCODE, e.g. NLRTM'),
        destination: z.string().regex(/^[A-Za-z]{5}$/).describe('Destination UN/LOCODE, e.g. CNSHA'),
        vessel_type: z.enum(['container', 'bulk', 'tanker', 'lng', 'general']).optional(),
        load_condition: z.enum(['laden', 'ballast']).optional(),
        speed_knots: z.number().min(8).max(25).optional(),
        dwt_tonnes: z.number().min(1).max(600000).optional(),
        customer_reference: z.string().max(128).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    async (input) => {
      try {
        const { body, replayed } = await client.scoreVoyage(input);
        const a = body as { id?: string; score?: number; risk_level?: string; confidence?: number; missing_sources?: string[]; route?: { distance_nm?: number } };
        const summary = `${input.origin.toUpperCase()} → ${input.destination.toUpperCase()}: score ${a.score} (${a.risk_level}), confidence ${a.confidence}` +
          (a.route?.distance_nm ? `, ${a.route.distance_nm} nm` : '') +
          (a.missing_sources?.length ? `. Missing sources: ${a.missing_sources.join(', ')}` : '') +
          (replayed ? '. (Replayed from an earlier assessment today.)' : '.');
        return ok(body as Record<string, unknown>, summary);
      } catch (err) { return fail(err); }
    },
  );

  server.registerTool(
    'get_usage',
    {
      title: 'Usage and quota (API key)',
      description: 'Live and test usage, remaining allowance, reset time, batch limits and monitor capacity for the configured key.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async () => {
      try {
        const body = (await client.getUsage()) as Record<string, unknown>;
        return ok(body, `Usage for environment ${String(body.environment ?? '?')}: ${JSON.stringify(body.assessments ?? {})}`);
      } catch (err) { return fail(err); }
    },
  );

  return server;
}
