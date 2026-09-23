/**
 * A thin client for the ArcNautical API, shaped by the two things a caller
 * gets wrong first:
 *
 *   - the keyless check ignores credentials and is rate-limited per IP, so it
 *     never sends a key and always reports the remaining allowance;
 *   - every resource-creating POST needs an Idempotency-Key, and a key derived
 *     from the QUESTION (hull + day) makes a repeat of the same question replay
 *     the stored answer free instead of spending a unit. A key derived from the
 *     attempt (a fresh UUID) does not. The screening docs measured 42% of one
 *     customer's month as same-day repeats billed only because of that choice.
 *
 * Errors come back as the API's own envelope: `code`, `message`, and where the
 * API knows the fix, `remedy`. They are surfaced verbatim to the model, which
 * is the point — the message names the remedy.
 */

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Milliseconds before a request is abandoned. A screen with vetting enrichment can take several seconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * How the model reached us. It only changes the remedy in the "this tool
   * needs a key" error: on stdio the key is an environment variable of the
   * process; on the remote endpoint it is an Authorization header on the
   * request, and telling an HTTP caller to edit an environment they do not
   * have is a dead end.
   */
  transport?: 'stdio' | 'http';
  /**
   * The ORIGINAL caller's address, forwarded as X-Forwarded-For (and, when
   * known, CF-Connecting-IP). Set by the remote endpoint only: it sits behind
   * the edge and calls the API from one address, and without this every
   * remote user would share one keyless allowance and one audit identity.
   * The edge trusts the header only from the docker network, so a stdio
   * install setting it changes nothing.
   */
  forwardedFor?: string;
  cfConnectingIp?: string;
}

export interface ApiErrorBody {
  code?: string;
  message?: string;
  remedy?: string;
  request_id?: string;
  field_violations?: Array<{ field: string; message: string }>;
}

export class ArcNauticalError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
    public readonly requestId: string | null,
  ) {
    super(body.message ?? `ArcNautical API returned ${status}`);
    this.name = 'ArcNauticalError';
  }
}

export interface KeylessCheck {
  imo: string;
  sanctions: { status: string; detail: string; coverageComplete: boolean; coverageGaps?: string[] };
  ownership: { opacity: string | null; score: number | null };
  vetting: { grade: string | null; score: number | null; status: string };
  assessed: boolean;
  checkedAt: string;
  fullReport?: string;
  tier?: string;
  tierDetail?: string;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

const DEFAULT_BASE = 'https://arcnautical.com';
const USER_AGENT = '@arcnautical/mcp';

/** The 401 the model receives when a keyed tool is called with no key. */
export function keyRequiredError(transport: 'stdio' | 'http'): ArcNauticalError {
  const where = transport === 'http'
    ? 'Send it as an Authorization: Bearer header on the MCP request (Claude Code: `claude mcp add --transport http arcnautical https://mcp.arcnautical.com/mcp --header "Authorization: Bearer arc_live_..."`).'
    : 'Set ARCNAUTICAL_API_KEY in the MCP server environment.';
  return new ArcNauticalError(401, {
    code: 'api_key_required',
    message: `This tool needs an ArcNautical API key. ${where}`,
    remedy: 'Keys are free and self-serve, no card and no approval step: https://arcnautical.com/get-a-key?from=mcp — the check_vessel and find_port tools work without one.',
  }, null);
}

export class ArcNauticalClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly transport: 'stdio' | 'http';
  private readonly forwarded: Record<string, string>;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.transport = opts.transport ?? 'stdio';
    this.forwarded = {};
    if (opts.forwardedFor) this.forwarded['X-Forwarded-For'] = opts.forwardedFor;
    if (opts.cfConnectingIp) this.forwarded['CF-Connecting-IP'] = opts.cfConnectingIp;
  }

  get hasKey(): boolean {
    return this.apiKey !== undefined;
  }

  /** Keyless. Verdict summary for one hull; 100 requests/hour per IP. */
  async checkVessel(imo: string): Promise<{ body: KeylessCheck; rateLimit: RateLimitInfo }> {
    const res = await this.request('GET', `/api/v1/vessels/${encodeURIComponent(imo)}/check`, { keyless: true });
    return { body: (await res.json()) as KeylessCheck, rateLimit: rateLimitFrom(res) };
  }

  /** Keyless. Resolve a port name to UN/LOCODEs. */
  async findPort(query: string, limit = 5): Promise<unknown> {
    const qs = new URLSearchParams({ query, limit: String(limit) });
    const res = await this.request('GET', `/api/v1/ports?${qs}`, { keyless: true });
    return res.json();
  }

  /** Keyed. The full screening record for one hull. */
  async screenVessel(input: {
    imo: string;
    vessel_name?: string;
    customer_reference?: string;
    include_vetting?: boolean;
  }): Promise<{ body: unknown; replayed: boolean }> {
    const res = await this.request('POST', '/api/v1/screenings', {
      body: input,
      idempotencyKey: questionKey('screening', input.imo, input.vessel_name),
    });
    return { body: await res.json(), replayed: res.headers.get('x-arcnautical-idempotent-replay') === 'true' };
  }

  async getScreening(id: string): Promise<unknown> {
    const res = await this.request('GET', `/api/v1/screenings/${encodeURIComponent(id)}`);
    return res.json();
  }

  /** Keyed. Up to 50 hulls; returns when the batch has finished or the deadline passes. */
  async screenVessels(
    imos: string[],
    opts: { include_vetting?: boolean; deadlineMs?: number; pollMs?: number } = {},
  ): Promise<{ batch: Record<string, unknown>; items: unknown[]; timedOut: boolean }> {
    const created = await this.request('POST', '/api/v1/screening-batches', {
      body: { imos, ...(opts.include_vetting === undefined ? {} : { include_vetting: opts.include_vetting }) },
      idempotencyKey: questionKey('batch', [...imos].sort().join(','), opts.include_vetting === false ? 'novet' : undefined),
    });
    const batch = (await created.json()) as Record<string, unknown>;
    const id = String(batch.id);
    const deadline = Date.now() + (opts.deadlineMs ?? 120_000);
    const pollMs = opts.pollMs ?? 2_000;
    let status = (await this.getBatch(id)) as Record<string, unknown>;
    while (!['completed', 'partial', 'failed'].includes(String(status.status)) && Date.now() < deadline) {
      await sleep(pollMs);
      status = (await this.getBatch(id)) as Record<string, unknown>;
    }
    const items = await this.listBatchItems(id);
    return { batch: status, items, timedOut: !['completed', 'partial', 'failed'].includes(String(status.status)) };
  }

  async getBatch(id: string): Promise<unknown> {
    const res = await this.request('GET', `/api/v1/screening-batches/${encodeURIComponent(id)}`);
    return res.json();
  }

  async listBatchItems(id: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: number | null = null;
    do {
      const qs = new URLSearchParams({ limit: '50' });
      if (cursor !== null) qs.set('cursor', String(cursor));
      const res = await this.request('GET', `/api/v1/screening-batches/${encodeURIComponent(id)}/items?${qs}`);
      const page = (await res.json()) as { items: unknown[]; next_cursor: number | null };
      out.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor !== null);
    return out;
  }

  /** Keyed. Route risk between two UN/LOCODEs. */
  async scoreVoyage(input: {
    origin: string;
    destination: string;
    vessel_type?: string;
    load_condition?: string;
    speed_knots?: number;
    dwt_tonnes?: number;
    customer_reference?: string;
  }): Promise<{ body: unknown; replayed: boolean }> {
    const { origin, destination, customer_reference, ...vessel } = input;
    const body = {
      ...(customer_reference ? { customer_reference } : {}),
      route: { origin: { locode: origin.toUpperCase() }, destination: { locode: destination.toUpperCase() }, ...vessel },
    };
    const res = await this.request('POST', '/api/v1/voyage-assessments', {
      body,
      idempotencyKey: questionKey('voyage', `${origin}-${destination}`, JSON.stringify(vessel)),
    });
    return { body: await res.json(), replayed: res.headers.get('x-arcnautical-idempotent-replay') === 'true' };
  }

  async getUsage(): Promise<unknown> {
    const res = await this.request('GET', '/api/v1/usage');
    return res.json();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { keyless?: boolean; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.transport === 'http' ? `${USER_AGENT} (remote)` : USER_AGENT,
      ...this.forwarded,
    };
    if (!opts.keyless) {
      if (!this.apiKey) throw keyRequiredError(this.transport);
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ArcNauticalError(0, {
        code: controller.signal.aborted ? 'client_timeout' : 'network_error',
        message: controller.signal.aborted
          ? `No response within ${this.timeoutMs}ms. A screen with vetting enrichment can take several seconds; the same request sent again replays the answer once it has finished.`
          : `Could not reach ${this.baseUrl}: ${(err as Error).message}`,
      }, null);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let body: ApiErrorBody = {};
      try { body = (await res.json()) as ApiErrorBody; } catch { body = { message: await res.text().catch(() => res.statusText) }; }
      throw new ArcNauticalError(res.status, body, res.headers.get('x-request-id'));
    }
    return res;
  }
}

/** `<kind>:<subject>:<UTC day>[:<qualifier>]` — the same question on the same day is the same key. */
export function questionKey(kind: string, subject: string, qualifier?: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const q = qualifier ? `:${hash(qualifier)}` : '';
  return `mcp:${kind}:${subject}:${day}${q}`.slice(0, 200);
}

function hash(s: string): string {
  // FNV-1a, enough to distinguish qualifiers inside a 200-char header.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

function rateLimitFrom(res: Response): RateLimitInfo {
  const num = (v: string | null) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    limit: num(res.headers.get('x-ratelimit-limit')),
    remaining: num(res.headers.get('x-ratelimit-remaining')),
    reset: res.headers.get('x-ratelimit-reset'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
