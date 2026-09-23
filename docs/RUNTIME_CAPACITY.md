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

## Provider: Claude unified windows (NOT-248, observed events only)

`packages/server/src/capacity/claude-events.ts`. Claude Code already emits
`rate_limit_event` with `rate_limit_info.unifiedWindows` during real
Dealer-managed sessions; the developer/reviewer session effects persist those
windows best-effort via `recordClaudeCapacityFromLog` right after the NOT-111
cap check. There is deliberately **no** live refresh path for `claude_code`:

- No synthetic probe — never `claude -p`, `/usage`, or another model call
  merely to refresh capacity.
- No dependency on Anthropic's undocumented OAuth usage endpoint.
- No prediction from plan name, token totals, or session cost.

Parsing (`claudeUnifiedWindowsToReadings`):

- Accepts `unifiedWindows` as an array of window objects or a map of
  bucket-name → window object. Array entries name their bucket via `window`,
  `bucket`, `name`, `id`, `key`, `limitType`/`rateLimitType` (either case),
  or `type`.
- `utilization`/`used`/`usedFraction` read as a 0–1 fraction; an explicit
  0–100 `usedPercent` (or `*_percent` spelling) takes precedence. Entries
  with no usable scale are skipped — never fabricated.
- Resets accept epoch seconds, epoch milliseconds, or ISO-8601; missing
  resets persist as null.
- Duration is inferred from well-known bucket names only (`five_hour` →
  300 min, `seven_day*`/`weekly` → 10,080 min); unknown buckets keep duration
  null and their provider label verbatim.
- Identity is never collapsed: `providerBucket` is the raw bucket string and
  `windowKey` is namespaced from it (`claude_unified_<bucket>`), so
  five-hour, seven-day, and model/overage-specific seven-day buckets persist
  as independent per-window rows. Partial re-observations upsert only the
  windows present and leave siblings untouched.

Observed-at semantics (a session-end stamp would lie for a long session, so
each event keeps its own time):

- An event timestamp on the `rate_limit_event` wins when present (ISO-8601,
  epoch seconds, or epoch milliseconds; clamped to session end).
- Otherwise the session's spawn start applies — the event happened no
  earlier than spawn, so freshness is understated, never overstated.
- A reading never overwrites a stored row whose `observed_at` is newer, so a
  later-finishing long session cannot clobber a concurrent session's fresher
  reading.

Snapshots persist with source `observed_event`, so the Agents strip and API
present them as passive observations under the shared 15-min freshness /
60-min expiry rules — never as live polling. Capacity ingestion never reads
or writes `runtime_availability`: rejected events still drive NOT-111
defer/admission exactly as before, and allowed events persist capacity
without opening a cap.

Fixture provenance: the `claude-rate-limit-*-unified-windows.ndjson`
fixtures are hand-written shapes covering the accepted spellings (array and
map forms, utilization scales, reset formats). They have not yet been
verified against a captured real Dealer-managed Claude log — confirm the
real event carries `unifiedWindows` in these shapes on one live session
after landing; if it does not, nothing persists and the strip stays N/A.
