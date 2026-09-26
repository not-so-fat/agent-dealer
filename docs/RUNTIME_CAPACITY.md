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
"Provider: Codex App Server" below; Muse (NOT-247,
`packages/server/src/capacity/muse.ts`) — see "Provider: Muse Code" below;
further providers land in sibling tickets.

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

## Compact presentation (NOT-266)

The top bar (`TopBarCapacity`) and the Agents-page strip
(`RuntimeCapacityStrip`) are a compact decision aid, not a diagnostics dump.
Presentation selection is explicit — never inferred from a provider label,
window key, or duration:

- Claude / Codex / Muse render exactly the tagged account-wide pair
  (`criticalRole=five_hour|weekly`), 5H then 1W. A partial or missing pair
  synthesizes the missing half as a public `5H N/A` / `1W N/A` row; it never
  substitutes another window's label.
- Cursor renders exactly its one `billing_cycle` window, labeled `1M`, with
  a tooltip naming the current billing cycle and its reset.
- Everything else stays in `GET /api/runtime-capacity` for diagnostics but
  never renders in the compact UI: provider failure sentinels (Codex's
  `codex_account_rate_limits` / `account_rate_limits`, Muse's
  `muse_account_usage` / `account_usage`) and model-specific, overage, or
  other diagnostic windows. Tooltips and accessibility text use only the
  public labels plus value/used-share/reset/staleness detail — raw window
  keys, provider buckets, and sentinel labels never appear.
- The Agents page shows the single normalized Cursor billing-cycle snapshot
  as the primary Cursor readout. The separate Team billing card
  (`CursorTeamBillingCard`) and Individual billing card
  (`CursorIndividualBillingCard`) are not part of the default capacity block;
  their API routes and components remain for compatibility. Provider
  acquisition is unchanged.

## Provider identity in the header (NOT-271)

Agent cards render all four runtimes through the same image-based logo tile
(`AgentRuntimeIcon` → `LogoTile`, `h-8 w-8`): Claude, Cursor, Codex, and
Muse. The Codex mark is the verbatim first-party app icon (`codex.png`);
the Muse mark is an interim redraw (`muse.svg`) — see the asset note in
`apps/web/src/assets/logos/` for provenance; nothing is hotlinked at
runtime.

The top bar (`TopBarCapacityView`) reuses that same mapping at `h-4 w-4`
per runtime block instead of a visible provider-name span — the compact
`5H`/`1W` (or Cursor `1M`) labels and values stay visible beside the logo.
The name is not lost: each block is a named group (`role="group"`,
`aria-label="<Provider> capacity"`) and keeps the full-detail `title`
(provider name plus window/reset/staleness detail), while the logo image
itself is decorative (`alt=""`). Exhausted, missing, stale, loading, and
unavailable styling still applies to the whole block; the logo tile keeps
its own treatment in every state. An unknown runtime falls back to the
generic icon, announced as "Unknown runtime capacity" — the fallback is
selected by membership of the raw key in the shared `Runtime` enum, never
by matching the human-readable label.

## Provider: Muse Code (NOT-247)

Sources: the Muse Code docs (`https://dev.meta.ai/docs/muse-code`) and the
subscriptions reference (`https://dev.meta.ai/docs/muse-code/subscriptions`),
plus the stable schema embedded in the shipped binary (regenerable offline
with `muse schema generate-json-schema`). The adapter speaks the stable
Session Protocol over a managed `muse serve` subprocess (no `--protocol`
flag — the shipped binary exits 2 on it): the `initialize` handshake with a
`clientInfo` identity (`name` matching `^[a-z0-9_]+$`, currently
`agent_dealer`, plus a version), then the `initialized` notification, then
exactly one `usage/read`, then shutdown. `usage/changed` notifications
received while the connection is alive are recorded. The client enforces a
read-only allowlist (`initialize`, `initialized`, `usage/read`) — any other
method throws before it is written, so polling can never start a session,
send a prompt, or consume model tokens. It is bounded (default 15 s overall,
`AGENT_DEALER_MUSE_CAPACITY_TIMEOUT_MS` override) and never billed.
No Keychain access, no undocumented endpoints.

Normalization keeps the two stable windows independently:

- `window` → window key `rolling_all_models` (`providerBucket`
  `all_models`), `windowDurationMins` → `durationMinutes` so the shared
  normalization derives the label (`300` → `5H`, `720` → `12H`, …) instead of
  hardcoding it; `usedPercent` and `resetsAtMs` pass through. (A legacy
  `rolling` spelling maps to the same snapshot.)
- `weekly` → window key `weekly_all_models` with the definitional
  `durationMinutes: 10080` (the stable schema reports no weekly duration),
  `usedPercent` and `resetsAt` likewise.
- `observedAtMs` becomes the snapshot `observedAt`; `tier` is dropped at the
  adapter boundary — tier metadata beyond the runtime account context never
  persists and never reaches the browser.

Failure semantics (shared enum only, never thrown, never health rows):

| Serve outcome | N/A reason |
|---|---|
| `usage` omitted / empty, no credential, unauthenticated, spawn error, bad exit, timeout | `missing` |
| malformed payload | `unparsable` |
| binary unavailable (ENOENT) or server without the method (`-32601`) | `unsupported` |

A present-but-malformed sibling window becomes a per-window `unparsable`
reading rather than sinking the good window. The exact cause is logged
server-side as a static string; no credential, tier, or raw account payload
reaches the browser, the API, or the logs — evidence refs are static
(`muse-serve:usage/read`).

Refresh via `refreshMuseCapacityFromServe()` (bounded ingest through the
shared service path). The only production trigger is `GET
/api/runtime-capacity`: when `muse_code` is configured it runs
`maybeRefreshMuseCapacityFromServe()` first — throttled (default 5 min,
`AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS` override, `off` disables),
best-effort, never failing the read. A successful refresh deletes the
`muse_account_usage` failure sentinel so a stale N/A window cannot linger
next to recovered windows. Tests use the committed fake MSP server
(`packages/server/src/capacity/fixtures/fake-muse-serve.mjs`), which
enforces the stable contract: it rejects the removed `--protocol` argv,
requires `initialize` (with a valid `clientInfo`) → `initialized` → exactly
one `usage/read`, and serves the stable `usage.window` / `usage.weekly`
fields; CI performs no live Muse request.

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

Normalization keeps both maps, deduplicated (NOT-263):

- `rateLimits` entries → window keys `codex_rate_limit_<name>`
  (`primary`/`secondary` keep their provider identity as `providerBucket`).
- `rateLimitsByLimitId` buckets are nested snapshots
  (`{ limitId, limitName, primary, secondary }`); each present
  primary/secondary sub-window becomes its own reading with window key
  `codex_limit_<limitId>_<primary|secondary>`, provider bucket
  `<limitId>/<primary|secondary>`, and the bucket's `limitName` as label — so
  per-limit buckets stay distinguishable and can never overwrite each other
  or the top-level windows.
- When the aggregate `primary`/`secondary` pair exactly mirrors one detailed
  bucket's pair — same used scale and value, same `windowDurationMins`, same
  normalized `resetsAt` — the aggregate aliases collapse and the detailed
  identity wins, so each logical window is reported once. The comparison is
  semantic (`codexWindowValuesEqual`): display labels (`5H`/`1W`) are never
  compared, so genuinely distinct buckets sharing a duration stay visible,
  and a partial overlap (only one sub-window matches) never collapses.
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
stale N/A row never lingers next to fresh windows, plus any aggregate alias
keys the fresh payload collapsed — per-window upserts never delete siblings,
so without this the obsolete `codex_rate_limit_primary/secondary` duplicates
persisted by older versions would linger next to the surviving detailed rows
and upgrading would not heal already-persisted databases. `GET /api/runtime-capacity`
additionally triggers `refreshCodexCapacityIfStale()`: when `codex_local` is a
configured runtime account and its stored snapshot is missing or older than
the 15-minute stale window, the read performs one bounded non-billable poll
(single-flight across concurrent requests, still under the overall timeout)
and then serves the result — fresh snapshots short-circuit with no
subprocess, and `AGENT_DEALER_CODEX_CAPACITY_REFRESH=off` disables the
refresh. Tests use the committed fake JSONL server
(`packages/server/src/capacity/fixtures/fake-codex-app-server.mjs`); its
`mirror` mode reproduces the production duplicate shape (aggregate pair
value-identical to one bucket, second bucket distinct); CI performs no live
provider request.

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
the refresh. Team billing is not a primary personal-capacity readout: since
NOT-266 the Agents page no longer renders the separate team billing section
(`CursorTeamBillingCard`, "Cursor team billing · Admin API") in the default
capacity block — the one normalized Cursor billing-cycle snapshot is the
primary UI. The card, its API route, and its unit (summed spend in cents,
cycle start, team size, per-member override counts — never percent chips)
remain for compatibility. Tests inject a mock fetch; CI performs no live
Cursor request.

## Provider: Cursor Individual dashboard — EXPERIMENTAL, opt-in (NOT-250, NOT-267)

Source: undocumented Cursor dashboard endpoints (usage-summary /
current-period shape, as commonly called by community tools) using the
existing local Cursor login — the desktop app login first, the Cursor Agent
login as the fallback. There is deliberately NO supported contract here: the
endpoints and credential stores may change without notice, carry no support
guarantee, and are never scraped via browser automation or HTML parsing.

Opt-in (disabled by default — no silent opt-in, no credential migration):

- `AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY=experimental` enables the adapter.
  Any other value (including unset) short-circuits before any credential file
  is read and before any HTTP is attempted, and serves `enabled: false` N/A.
- Unset the variable to disable again. `CURSOR_INDIVIDUAL_CREDENTIAL_FILE`
  pins an explicit credential file (fixtures/tests); otherwise the adapter
  never hunts the home directory beyond its two fixed candidates.
- Credential lookup is isolated in
  `packages/server/src/capacity/cursor-individual-credentials.ts`, in order:
  1. Cursor desktop `state.vscdb`, key `cursorAuth/accessToken` only —
     opened read-only, never copied, never written, no unrelated key read.
     Per-OS database path: macOS
     `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
     Windows `%APPDATA%/Cursor/User/globalStorage/state.vscdb`, Linux
     `~/.config/Cursor/User/globalStorage/state.vscdb`.
     (`CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE` pins an explicit database for
     fixtures/tests.)
  2. Cursor Agent `auth.json` (`~/.cursor/auth.json`, shape-tolerant within
     an explicit allowlist).
  Unknown shapes read `unparsable` (changed format), and diagnostics return
  presence/source/path/format only, never secret material. The session cookie
  needs a WorkOS user id alongside the token — for Agent auth an explicit
  `userId`/`user_id` field wins, otherwise it's derived locally from the
  token's own JWT `sub` claim (no network, no signature check); desktop
  tokens always use the JWT `sub` derivation. Either source is normalized to
  strip a provider connection-type prefix (`google-oauth2|user_abc` →
  `user_abc`). A token with no derivable id reads `unparsable`.
- The adapter never writes Cursor's database, refreshes tokens, or touches
  the Keychain or auth files. A rejected login (401/403) keeps last-good
  data and logs a static `forbidden` diagnostic telling the operator to
  refresh the Cursor login — Dealer never mutates Cursor auth to recover.

Reads (bounded: 10 s per request covering the full response — headers AND
body, `AGENT_DEALER_CURSOR_INDIVIDUAL_TIMEOUT_MS` override; a
`WorkosCursorSessionToken=<userId>%3A%3A<token>` session cookie built from
the local login (the `::` delimiter percent-encoded, matching the live
dashboard cookie), never an `Authorization` header — the dashboard rejects
Bearer auth):

- `GET /api/usage-summary/current-period`, falling back to
  `/api/usage-summary` on 404 (endpoint drift). Default origin
  `https://cursor.com` (its `www.` alias canonicalizes to the bare domain via
  a same-site redirect); requests and redirects are allowlisted to exactly
  `https://cursor.com`, `https://www.cursor.com`, and `https://api.cursor.com`
  — a redirect elsewhere (or a non-allowlisted base URL) fails as
  `unsafe-redirect` before the credential travels. Manual redirect handling
  (max 3 hops), 512 KiB response cap enforced while streaming the body (never
  buffered past the cap first), JSON-schema validation.
- Billing-cycle values only: reported cycle label/start/end, reported usage
  value/unit, and remaining percent from a used/remaining scale. No durations
  are invented (monthly data never becomes a 5H/1W window), no cycle label is
  synthesized, and money is never rendered as a token percentage.
- Exactly one personal `billing_cycle` window per read: the primary value is
  `100 - individualUsage.plan.totalPercentUsed` (the account-total included
  usage), with the billing-cycle end as the reset. Per-pool scales such as
  `apiPercentUsed` are never substituted for the account total; when the
  total percent is absent the plan's explicit used/limit pair (or a reported
  remaining scale) is the only fallback. No second capacity window is ever
  emitted from additional pools.
- `agent-dealer doctor` reports the login the adapter would use while the
  opt-in is enabled: "desktop login found", "Agent login found", or "no
  usable local login" — static labels only, never paths, tokens, or ids.

A supported Cursor Individual usage surface is preferred automatically:
`readCursorIndividualBilling()` checks an injected `supportedReader` first
and skips the credential + dashboard entirely when one answers (source
`supported_protocol`). No supported surface exists as of NOT-250, so the
default reader returns null — wire a real reader in as the default when
Cursor ships one and the dashboard becomes the fallback with no operator
action.

Normalized snapshots persist in `cursor_individual_billing_snapshots`
(single row) plus one `billing_cycle` window for `cursor_local` in
`runtime_capacity_snapshots`, independent of `runtime_availability`.
`GET /api/cursor-individual-billing` → `CursorIndividualBilling` serves the
stored snapshot with freshness applied (15-min stale / 60-min expiry, same
horizons as quota windows); a `cycleEnd` in the past reads `expired`. The
read model carries `enabled`/`configured` flags and `experimental_api`
source. Transient auth/transport/rate-limit/redirect failures do not
overwrite a stored snapshot (last-known values keep serving as
stale/expired); without stored data they read `missing`. The shared poll
(see below) applies this the same way to BOTH stores: a transient failure
skips the `runtime_capacity_snapshots` write too, not just the billing
snapshot, so the two surfaces agree after the same failed poll.

Failure semantics (shared enum only, never thrown, never health rows):

| Dashboard outcome | N/A reason |
|---|---|
| feature disabled (`enabled: false`, no credential/HTTP) | `missing` |
| no usable local credential | `missing` |
| unreadable/changed credential format | `unparsable` |
| 401/403 (rejected login) / 429 (rate limited) | `missing` |
| network error / 5xx / timeout | `missing` (stored snapshot still serves as stale/expired) |
| 2xx without a usable billing value / oversized / non-JSON | `unparsable` |
| endpoint absent on all candidates (404/405 drift) | `missing` |
| redirect off the allowlist / non-allowlisted base URL | `missing` (`unsafe-redirect` in the server log) |

The exact cause is logged server-side as a static string; the token, URLs
carrying secrets (auth is header-only), and raw payloads never reach the
browser, the API, or the logs, and evidence refs are static
(`cursor-dashboard:…`).

`GET /api/cursor-individual-billing` triggers
`refreshCursorIndividualBillingIfStale()`, and `GET /api/runtime-capacity`
triggers `refreshCursorIndividualCapacityIfStale()` (disabled = strict
no-op) to ingest the billing-cycle window. Each checks its OWN stored
table's freshness first (the billing snapshot row vs. the
`runtime_capacity_snapshots` window) and short-circuits with no
credential/HTTP when fresh — but the two routes are usually mounted at once
(the billing card and the capacity strip both render on the Agents page), so
when BOTH decide they're stale they share one poll: a single in-flight
dashboard read, its observation ingested into both stores, rather than one
poll per route. A failed poll backs off for 60 s (shared by both routes).
`AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH=off` disables the refresh. Since
NOT-266 the Agents page no longer renders the separate individual billing
section (`CursorIndividualBillingCard`, "Cursor individual billing ·
Experimental") alongside the runtime window — the one normalized
`billing_cycle` snapshot (the `1M` readout) is the primary UI, and the card
and its API route remain for compatibility: cycle label, remaining percent,
reported usage, and reset — plus the
`AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY` setting that disables it. Tests use
temporary fixture credentials and a mock fetch; CI touches neither the real
local login nor the network.
