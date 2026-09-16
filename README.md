# @arcnautical/mcp

An [MCP](https://modelcontextprotocol.io) server for the [ArcNautical API](https://arcnautical.com/developers/): screen any commercial vessel by IMO number for sanctions, ownership opacity and a vetting grade — from Claude, ChatGPT, Cursor, VS Code, Windsurf or any MCP client.

**Two tools need no API key at all.** Install it, ask "is IMO 9274446 sanctioned?", get the answer.

```
IMO 9274446 HS STAR: sanctions RED — 4 confirmed matches on vessel identifier.
Ownership opacity MEDIUM. Vetting grade E (unacceptable). Checked 2026-09-12T08:10:40Z.
```

## Install

Requires Node 18+. No install step — every client below runs it with `npx`.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arcnautical": {
      "command": "npx",
      "args": ["-y", "@arcnautical/mcp"]
    }
  }
}
```

**Claude Code**

```
claude mcp add arcnautical -- npx -y @arcnautical/mcp
```

**Cursor / Windsurf / VS Code** — same `command` / `args` shape in the client's MCP settings.

To unlock the full record, batches and voyage scoring, add an API key to the `env` block:

```json
{
  "mcpServers": {
    "arcnautical": {
      "command": "npx",
      "args": ["-y", "@arcnautical/mcp"],
      "env": { "ARCNAUTICAL_API_KEY": "arc_live_…" }
    }
  }
}
```

Keys are self-serve at https://arcnautical.com/arcnautical.html#/developer-api — no approval step. A key includes 5,000 vessel screenings and 10,000 voyage assessments a month.

## Tools

| Tool | Key? | What it does |
|---|---|---|
| `check_vessel` | no | Sanctions status (OFAC SDN, EU, UN, UK OFSI, OpenSanctions), ownership-opacity score, A–E vetting grade for one IMO. 100/hour per IP. |
| `find_port` | no | Resolve a port name or country to UN/LOCODEs — call before `score_voyage`. |
| `screen_vessel` | yes | The full screening record: every match with its source list, programme and confidence class, the graded vetting factors, per-source freshness, a retained record id. Same hull asked again today replays free. |
| `screen_vessels` | yes | Batch up to 50 IMOs and wait for the results. |
| `get_screening` | yes | Retrieve a stored record by id (retained ten years). |
| `score_voyage` | yes | Route risk between two LOCODEs: score, level, drivers, confidence, missing sources. |
| `get_usage` | yes | Remaining allowance and limits for the configured key. |

### Reading a verdict

- **RED** — confirmed match on the vessel identifier. **AMBER** — possible match, review it. **GREEN** — no match against the sources reached. **INCOMPLETE** — a core source could not be read; never present it as clear.
- `coverage_complete: false` on a GREEN means one supplementary list was unavailable: re-screen before relying on it.
- `assessed: false` means ownership and vetting are defaults, not findings.
- The keyless check matches the vessel's **current** name and identifiers only. A hull renamed after a designation can read GREEN there; `screen_vessel` covers that case.
- Designations change daily. Quote the `checkedAt` / `screened_at` time with any answer.

## Idempotency

Every resource-creating call sends an `Idempotency-Key` derived from the *question* — the hull and the UTC day — not from the attempt. Asking about the same vessel twice in a day returns the stored record and spends nothing. The API's docs measured 42% of one integration's monthly screenings as same-day repeats billed only because their client generated a random key per call; this server does not do that.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ARCNAUTICAL_API_KEY` | unset | Enables the keyed tools. |
| `ARCNAUTICAL_BASE_URL` | `https://arcnautical.com` | Override for testing. |

## Links

- Guide: https://arcnautical.com/developers/
- Reference: https://arcnautical.com/developers/reference/
- OpenAPI 3.1: https://arcnautical.com/api/v1/openapi.json
- Postman: https://www.postman.com/arcnautical-6322764/arcnautical-s-workspace
- For agents: https://arcnautical.com/llms.txt

## Development

```
npm install
npm test        # builds, then drives dist/cli.js over stdio against the live keyless endpoints
```

MIT © ArcNautical
