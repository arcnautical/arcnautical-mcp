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
import { ListPromptsRequestSchema, ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ArcNauticalClient, ArcNauticalError, type ClientOptions } from './client.js';

export { ArcNauticalClient, ArcNauticalError } from './client.js';
export type { ClientOptions } from './client.js';

export const SERVER_NAME = 'arcnautical';
export const SERVER_VERSION = '0.2.0';

const IMO = z.string().regex(/^\d{7}$/, 'A seven-digit IMO number, e.g. 9274446').describe('Seven-digit IMO number of the vessel');

/**
 * Output shapes for the two keyless tools, declared so a client can plan on
 * the fields before calling. Deliberately loose (`passthrough`, only the
 * fields every answer carries): the API adds fields without notice under its
 * additive-change policy, and a strict schema here would turn a new field
 * into a failed tool call.
 */
const CHECK_OUTPUT = {
  imo: z.string().describe('The seven-digit IMO number screened'),
  sanctions: z.object({
    status: z.string().describe('RED | AMBER | GREEN | INCOMPLETE'),
    detail: z.string().optional().describe('One sentence explaining the status'),
    coverageComplete: z.boolean().optional().describe('false when a supplementary list was unavailable — re-screen before relying on a GREEN'),
  }).passthrough(),
  ownership: z.object({ opacity: z.string().nullable().optional(), score: z.number().nullable().optional() }).passthrough().optional(),
  vetting: z.object({ grade: z.string().nullable().optional(), score: z.number().nullable().optional(), status: z.string().optional() }).passthrough().optional(),
  assessed: z.boolean().optional().describe('false means ownership and vetting are defaults, not findings'),
  checkedAt: z.string().describe('ISO-8601 time the sources were read; designations change daily'),
  fullReport: z.string().optional().describe('Human-readable report URL for this hull'),
  rate_limit: z.object({ limit: z.number().nullable(), remaining: z.number().nullable(), reset: z.string().nullable() }).describe('Keyless allowance for the caller\'s address'),
};
const RECORD_OUTPUT = {
  id: z.string().optional().describe('Screening record id, retained ten years'),
  imo: z.string().optional(),
  sanctions: z.object({ status: z.string().optional().describe('RED | AMBER | GREEN | INCOMPLETE'), detail: z.string().optional() }).passthrough().optional(),
  ownership: z.object({ opacity: z.string().nullable().optional(), score: z.number().nullable().optional() }).passthrough().optional(),
  vetting: z.object({ grade: z.string().nullable().optional(), status: z.string().optional() }).passthrough().optional(),
  screened_at: z.string().optional().describe('ISO-8601 time the sources were read'),
  vessel_name: z.string().nullable().optional(),
};
const BATCH_OUTPUT = {
  batch: z.object({ id: z.string().optional(), status: z.string().optional().describe('queued | running | completed | partial | failed') }).passthrough().describe('The batch as last read'),
  items: z.array(z.object({
    imo: z.string().nullable().optional(),
    status: z.string().optional(),
    screening_id: z.string().nullable().optional(),
    result_body: z.object({ sanctions: z.object({ status: z.string().optional() }).passthrough().optional() }).passthrough().nullable().optional(),
  }).passthrough()).describe('One row per hull'),
};
const VOYAGE_OUTPUT = {
  id: z.string().optional().describe('Assessment id'),
  score: z.number().optional().describe('0-100, higher is riskier'),
  risk_level: z.string().optional().describe('low | moderate | elevated | high | severe'),
  confidence: z.number().optional().describe('0-1'),
  missing_sources: z.array(z.string()).optional().describe('Signals that could not be read for this assessment'),
  route: z.object({ distance_nm: z.number().optional() }).passthrough().optional(),
  signals: z.unknown().optional(),
};
const USAGE_OUTPUT = {
  environment: z.string().optional().describe('live | test'),
  assessments: z.object({}).passthrough().optional().describe('Allowance, used, remaining and reset per environment'),
  screenings: z.object({}).passthrough().optional(),
  limits: z.object({}).passthrough().optional(),
};
const PORTS_OUTPUT = {
  ports: z.array(z.object({
    locode: z.string().describe('UN/LOCODE, e.g. NLRTM'),
    name: z.string(),
    country: z.string().optional(),
  }).passthrough()).describe('Best matches first'),
};

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
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: 'ArcNautical',
      description: 'Screen any vessel by IMO for sanctions, ownership opacity and vetting grade. Keyless check included.',
      websiteUrl: 'https://arcnautical.com/developers/#mcp',
      icons: [{ src: 'https://arcnautical.com/logo-512.png', mimeType: 'image/png', sizes: ['512x512'] }],
    },
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
      outputSchema: CHECK_OUTPUT,
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
      outputSchema: PORTS_OUTPUT,
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
      outputSchema: RECORD_OUTPUT,
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
      outputSchema: BATCH_OUTPUT,
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
      outputSchema: RECORD_OUTPUT,
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
        vessel_type: z.enum(['container', 'bulk', 'tanker', 'lng', 'general']).optional().describe('Vessel class; changes which threat signals weigh most (default: general)'),
        load_condition: z.enum(['laden', 'ballast']).optional().describe('laden or ballast; affects exposure on the transit'),
        speed_knots: z.number().min(8).max(25).optional().describe('Planned service speed, 8-25 knots; sets transit time through each risk area'),
        dwt_tonnes: z.number().min(1).max(600000).optional().describe('Deadweight in tonnes; used for chokepoint and draught constraints'),
        customer_reference: z.string().max(128).optional().describe('Your own reference (voyage id, fixture); echoed on the assessment'),
      },
      outputSchema: VOYAGE_OUTPUT,
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
      outputSchema: USAGE_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async () => {
      try {
        const body = (await client.getUsage()) as Record<string, unknown>;
        return ok(body, `Usage for environment ${String(body.environment ?? '?')}: ${JSON.stringify(body.assessments ?? {})}`);
      } catch (err) { return fail(err); }
    },
  );

  // No resources and no prompts — say so with an empty list rather than
  // "method not found". Directory scanners (Smithery, 2026-09-18) ask for both
  // and log a warning per refusal; some clients treat -32601 as a broken server.
  server.server.registerCapabilities({ resources: {}, prompts: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  return server;
}
