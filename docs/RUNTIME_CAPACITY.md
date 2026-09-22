# Runtime capacity (NOT-245)

Provider-neutral observed capacity for runtime accounts. Capacity belongs to
an authenticated runtime account, not an Agent profile: the Agents page and
`GET /api/runtime-capacity` report one entry per configured runtime, no matter
how many Agent profiles share it.

## Adapter interface

`packages/server/src/capacity/adapter.ts`. One adapter per provider surface:

```ts
interface CapacityAdapter {
  runtime: Runtime;
  source: "supported_protocol" | "observed_event" | "experimental_api";
  read(nowMs?: number): AdapterReadResult | Promise<AdapterReadResult>;
}
```

A read returns raw window readings plus unavailable readings:

- `AdapterWindowReading` — `windowKey` (stable per runtime, e.g.
  `weekly_all_models`), `providerBucket`, optional `durationMinutes`, the
  provider's own `providerLabel`, raw `usedValue`/`usedUnit`, and **one** used
  scale: `usedPercent` (0–100) or `usedFraction` (0–1). Optional `resetAt`,
  `observedAt`, `staleAfterMs`/`expiresAfterMs` overrides, and `evidenceRef`.
- `AdapterUnavailableReading` — same keys plus a machine-readable `reason`
  (`unsupported` | `missing` | `expired` | `unparsable` | `stale`).

Normalization (`normalizeAdapterWindow`) derives the snapshot:

- `displayLabel` from duration when defensible (300 min → `5H`,
  10,080 min → `1W`, ~30 d → `1M`, other exact hours/days → `NH`/`ND`);
  otherwise the provider label is kept verbatim — never guessed.
- `remainingPercent` as `clamp(100 - usedPercent, 0, 100)`; fractions are
  normalized to percent *before* the calculation. No usable scale →
  `unparsable`, `remainingPercent: null`.
- `freshUntil`/`expiresAt` default to observed + 15 min / + 60 min.

Provider live reads (auth, subprocess protocol) land in sibling tickets.
Until then, `fixtureMultiWindowAdapter` / `fixtureUnsupportedAdapter` /
`fixtureStaleAdapter` stand in deterministically. The first live provider is
Codex (NOT-246, `packages/server/src/capacity/codex-app-server.ts`) — see
"Provider: Codex App Server" below.

## Freshness rules

| Condition | Rendered as |
|---|---|
| `remainingPercent` present, reset/expiry/freshness all future | remaining % |
| `resetAt` in the past (or unparsable reset) | N/A `expired` — a past reset is never current capacity |
| past `expiresAt` | N/A `expired` |
| past `freshUntil` but inside expiry | N/A `stale` |
| provider reports no surface | N/A `unsupported` |
| supported but nothing recorded yet | N/A `missing` |
| payload arrived but no usable scale | N/A `unparsable` |

Classification happens at read time in `capacity/service.ts`, so a snapshot
that ages out flips to N/A without a writer round-trip.

## API

`GET /api/runtime-capacity` → `RuntimeCapacityResponse`: every configured
runtime (distinct `agents.runtime` values plus any runtime holding snapshots),
its windows with freshness applied, and an explicit entry-level
`unavailableReason` when no window is current. Normalized snapshots only —
`evidence_ref` and raw provider payloads never leave the server.

## Persistence

`runtime_capacity_snapshots(runtime, window_key, …)` — one row per window, so
a provider can report several independently resetting windows per account.
Writes are per-window upserts; a partial re-observation never deletes a
still-valid sibling window. Independent of `runtime_availability` (NOT-111
hard caps): capacity snapshots neither read nor clear hard-cap rows, and
connection health stays a separate state — green health never implies known
capacity.

## Provider: Codex App Server (NOT-246)

Source: the official App Server interface
(`https://developers.openai.com/codex/app-server`). The adapter speaks the App
Server JSONL protocol over a managed `codex app-server` subprocess: the
`initialize` handshake, then a single `account/rateLimits/read`, then shutdown.
`account/rateLimits/updated` notifications received while the connection is
alive are recorded. The client enforces a read-only allowlist (`initialize`,
`initialized`, `account/rateLimits/read`) — any other method throws before it
is written, so polling can never create a thread, submit a turn, or run a
model prompt. It is bounded (default 15 s overall,
`AGENT_DEALER_CODEX_CAPACITY_TIMEOUT_MS` override) and never billed.

Normalization keeps both maps:

- `rateLimits` entries → window keys `codex_rate_limit_<name>`
  (`primary`/`secondary` keep their provider identity as `providerBucket`).
- `rateLimitsByLimitId` buckets are nested snapshots
  (`{ limitId, limitName, primary, secondary }`); each present
  primary/secondary sub-window becomes its own reading with window key
  `codex_limit_<limitId>_<primary|secondary>`, provider bucket
  `<limitId>/<primary|secondary>`, and the bucket's `limitName` as label — so
  per-limit buckets stay distinguishable and can never overwrite each other
  or the top-level windows.
- Each window keeps `usedPercent`, `windowDurationMins` → `durationMinutes`,
  and `resetsAt` (epoch seconds/ms or ISO-8601 → ISO).

The `initialize` handshake sends a versioned client identity
(`{ name: "agent-dealer", title: "agent-dealer", version }`, version kept in
sync with `packages/server/package.json`).

Failure semantics (shared enum only, never thrown, never health rows):

| App Server outcome | N/A reason |
|---|---|
| binary missing / spawn error / exit / timeout / unauthenticated | `missing` |
| malformed payload | `unparsable` |
| server without the method (`-32601`) | `unsupported` |

The exact cause is logged server-side as a static string; no access token or
raw account payload reaches the browser, the API, or the logs — the adapter
passes no credentials (the subprocess uses its ambient session) and evidence
refs are static (`codex-app-server:account/rateLimits/read`).

Refresh via `refreshCodexCapacityFromAppServer()` (bounded ingest through the
shared service path); a successful refresh deletes the failure sentinel so a
stale N/A row never lingers next to fresh windows. `GET /api/runtime-capacity`
additionally triggers `refreshCodexCapacityIfStale()`: when `codex_local` is a
configured runtime account and its stored snapshot is missing or older than
the 15-minute stale window, the read performs one bounded non-billable poll
(single-flight across concurrent requests, still under the overall timeout)
and then serves the result — fresh snapshots short-circuit with no
subprocess, and `AGENT_DEALER_CODEX_CAPACITY_REFRESH=off` disables the
refresh. Tests use the committed fake JSONL server
(`packages/server/src/capacity/fixtures/fake-codex-app-server.mjs`); CI
performs no live provider request.

## Provider: Cursor Team Admin API (NOT-249)

Source: the official Admin API
(`https://docs.cursor.com/en/account/teams/admin-api`), base URL
`https://api.cursor.com` (`CURSOR_ADMIN_API_BASE_URL` override exists for
tests only). Optional: the adapter runs only when the operator explicitly
configures `CURSOR_ADMIN_API_KEY` (server env / `.env`, same secret mechanism
as `LINEAR_API_KEY`; see `scripts/templates/*.env.example`). It stays
distinct from the local Cursor CLI login — no session token is read, no
undocumented dashboard API is called, and individual accounts are unsupported
(team scope only).

Reads (bounded: 15 s per request,
`AGENT_DEALER_CURSOR_TEAM_CAPACITY_TIMEOUT_MS` override; documented HTTP
Basic auth — API key as the username, empty password — header-only):

- `POST /teams/spend` (`{ page }` 1-based, paged via `totalPages`, capped at
  100 pages) → per-member `teamMemberSpend` rows (`spendCents`,
  `hardLimitOverrideDollars`, …), `subscriptionCycleStart` (epoch ms),
  `totalMembers`, `totalPages`. Team spend is the exact sum of the reported
  `spendCents` (unit `cents`, never converted); `totalMembers` is stored as
  the team size; members reporting a `hardLimitOverrideDollars` are counted
  as per-member overrides — never relabeled as a team hard limit. The API
  reports no team-level hard limit and no cycle end, so both stay null.
- `POST /teams/daily-usage-data` (`{ startDate, endDate }` epoch ms, trailing
  30 days) → activity/request-count rows, not spend: a 2xx records the
  queried usage period and nothing monetary.

Only the documented fields above are contractual (camelCase/snake_case
aliases and epoch-ms/ISO dates tolerated). No `5H`/`1W`-style windows are
invented: this surface has no durations at all, and money is never rendered
as a token percentage.

Normalized snapshots persist in `cursor_team_billing_snapshots` (single row),
independent of `runtime_capacity_snapshots` and `runtime_availability`.
`GET /api/cursor-team-billing` → `CursorTeamBilling` serves the stored
snapshot with freshness applied (15-min stale / 60-min expiry, same horizons
as quota windows); a `cycleEnd` in the past reads `expired` — a finished
cycle is never current billing. Transient auth/transport/rate-limit failures
do not overwrite a stored snapshot (last-known values keep serving as
stale/expired); without stored data they read `missing`.

Failure semantics (shared enum only, never thrown, never health rows):

| Admin API outcome | N/A reason |
|---|---|
| key absent (`configured: false`, no HTTP) | `missing` |
| 401/403 (bad key or missing admin permission) | `missing` |
| network error / 5xx / timeout / 429 (rate limited) | `missing` (stored snapshot still serves as stale/expired) |
| 2xx without a usable billing value | `unparsable` |
| documented path absent (404/405 on both endpoints) | `missing` |
| daily-usage failure with a successful spend read | spend serves, usage period `null` |

The exact cause is logged server-side as a static string; the key, URLs
carrying secrets, and raw payloads never reach the browser, the API, or the
logs, and evidence refs are static (`cursor-admin-api:…`).

`GET /api/cursor-team-billing` triggers `refreshCursorTeamBillingIfStale()`:
with a key configured and a missing/stale stored snapshot, the read performs
one bounded poll (single-flight, each request under the per-request timeout)
and then serves the result — fresh snapshots short-circuit with no HTTP, and a failed
poll backs off for 60 s before polling again (no per-request retry storm
after a 429/5xx). `AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH=off` disables
the refresh. The Agents page renders team billing in its own labeled section
(`CursorTeamBillingCard`, "Cursor team billing · Admin API") below the
per-runtime quota strip: summed spend in cents, cycle start, team size, and
per-member override counts — never as percent chips. Tests inject a mock
fetch; CI performs no live Cursor request.
