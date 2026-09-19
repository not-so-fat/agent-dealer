---
status: contract
linear: NOT-167
epic: NOT-161
---

# Execution analysis contract

The single authoritative definition of how agent-dealer measures where execution time goes, why attempts fail, and how much retry work is wasted (epic NOT-161). Every implementation ticket under that epic — telemetry events, projections, API, UI, backfill — uses the phase boundaries, overlap rules, vocabularies, aggregation semantics, and missing-data behavior below. Other docs link here; they do not restate it.

This document is a contract, not an implementation. Nothing here is emitted today unless the [source matrix](#6-source-matrix) says so.

## 1. Principles

- **Raw evidence vs derived views.** Raw evidence comes in two kinds, and the difference matters for what history can be recovered:
  - **Immutable evidence** is written once and never updated: `workflow_events` rows (ordered by `rowid`), `usage_events` rows, and the NDJSON logs at `worker_sessions.log_path`. Boundaries taken from these are stable.
  - **Mutable source records** are updated in place as state advances: `human_actions` (`resolved_at`, status), `queue_entries` (`state`, and `wait_reason`/`wait_reason_at`, which are overwritten and cleared on admit/remove), and `worker_sessions` (`heartbeat_at`, `completed_at`, process columns). They hold only their *latest* state, so a value read from them is a snapshot: history that was overwritten is not recoverable from them, and a boundary taken from one is a proxy unless the [source matrix](#6-source-matrix) says otherwise.

  A derived view (phase durations, silence, failure classification, percentiles) is computed from raw evidence of either kind, may be recomputed at any time, and never rewrites it. Analysis backfills and migrations do not invent timestamps, and do not mutate or rewrite either kind of evidence; they only produce derived rows/views.
- **Intervals are half-open `[start, end)` UTC ranges**, in milliseconds since epoch. `end` is exclusive: adjacent intervals `[a, b)` and `[b, c)` do not overlap and their durations sum to `c - a`. A zero-length interval `[t, t)` is empty and contributes 0. An interval whose `end` is not yet known is **open**; a live view may close it at `now`, and must mark it `quality: inferred` with reason `open_interval`. A finished-issue view never closes an open interval at `now`.
- **Timestamps are ISO-8601 UTC strings** in storage (`ts`, `started_at`, …); parse to epoch ms before any arithmetic. A negative duration (`end < start`, e.g. clock jump) is `unavailable` with reason `negative_duration`, never clamped to 0.
- **Ordering.** Timestamps have millisecond resolution and collide. Events with equal `ts` are ordered by durable insertion cursor — SQLite `rowid` of `workflow_events` (the same cursor `guidance` windows and `latest-failure` already use) — never by timestamp alone, and never by `id` (a random uuid). Cross-table ordering falls back to `ts`, then to a documented per-table tie-break; where two different tables must be ordered at the same millisecond and no shared cursor exists, the order is `unavailable` reason `unordered_tie`, not guessed.

## 2. Top-level wall-clock phases

Exclusive phases partition an issue's wall-clock attempt time. Each phase names a start event and an end event. Event names in `queue.*` and `agent.*` are the contract names; where the event does not exist yet the [source matrix](#6-source-matrix) says so.

| Phase | Start (inclusive) | End (exclusive) | Notes |
|-------|-------------------|-----------------|-------|
| `queue_wait` | `queue.enqueued` | `queue.admitted` or `queue.removed` | Whichever terminal event occurs first. Removal ends the wait but is not admission. |
| `coordinator_setup` | `worker.started` | `agent.started` | Checkout/worktree preparation, Deck connection, brief preparation, and other pre-spawn coordinator work. `worker.started` is recorded *before* worktree setup. |
| `agent_process` | `agent.started` | `agent.completed` | The spawned CLI process lifetime. **Not** `worker_sessions.started_at`, which is written by the coordinator around session bookkeeping and does not identify the moment the CLI spawned. |
| `coordinator_validation_publish` | `agent.completed` | `worker.completed` or `worker.failed` | Post-agent validation, commit salvage, push, PR open/verify. |
| `human_wait` | union of open human-action intervals | — | **Overlapping dimension.** Reported separately; never added to the exclusive phase total. |

The exclusive total for one attempt is `queue_wait + coordinator_setup + agent_process + coordinator_validation_publish`. Phases of one attempt are contiguous only if their boundary events exist; a missing boundary makes the adjacent phases `unavailable` (see [§8](#8-backfill-and-missing-data)), not zero.

### Nested drill-down intervals

These are sub-intervals of a parent phase. They explain the parent; they never increase it and never appear in the exclusive total.

- **`admission_dependency_wait`** — a categorized sub-interval of `queue_wait`, derived from queue wait-reason history (one interval per contiguous run of the same reason category, clipped to the `queue_wait` parent). Categories come from the wait reason recorded at admission time (slot busy, dependency not ready, runtime usage cap, Deck outage, …).
- **`runtime_health_preflight`** — the admission/Deck-health sub-interval of `queue_wait` supported by both queue-reason and Deck-connect evidence. If only one of the two exists, the interval is `inferred`; if neither, `unavailable`.
- **`unexplained_silence`** — a nested interval inside `agent_process` during which no new structured activity was observed for at least the configured observation threshold (see [§5](#5-silence-taxonomy)). It is a drill-down of `agent_process` and is **never** a top-level additive phase.

## 3. Overlap and aggregation

1. **Preserve every raw interval.** Overlapping, duplicated, or retried evidence is stored and shown as recorded.
2. **Issue wall-clock chart: union by phase, then sum.** For each phase, union that phase's intervals across all attempts/sessions of the issue, then sum the union lengths. Concurrent or retried evidence is therefore not double-counted within a phase.
3. **Nested intervals are drill-down only.** `admission_dependency_wait`, `runtime_health_preflight`, and `unexplained_silence` never increase the parent duration and are unioned within their own category.
4. **Human wait is its own union metric.** It is the length of the union of `[requested_at, resolved_at)` over human actions (open action: `resolved_at` = none → open interval). It may overlap queue wait or agent processing and is reported alongside, not inside, the exclusive total.
5. **Resource consumption vs elapsed time.** Attempt/session runtime **may be summed** as resource consumption (`Σ` over attempts, overlapping or not). **Issue elapsed time** is workflow start to workflow completion (or now while active) — never the sum of attempts.
6. **Percentiles.** P50/P95 use the **nearest-rank** method over comparable, non-null observations: sort ascending, `rank = ceil(p/100 · n)`, value = `sorted[rank-1]` (`n = 0` → no value). Every percentile is returned with its sample count `n`. Observations are comparable only within the same phase, same role, and same quality tier policy (see [§4](#4-evidence-quality)); do not mix `exact` and `inferred` observations unless the view says so.
7. **Same-millisecond events** are ordered by `rowid` cursor ([§1](#1-principles)).

## 4. Evidence quality

Every derived metric carries:

```
quality: "exact" | "inferred" | "unavailable"
reasons: string[]   // zero or more reason codes
```

Quality is defined for two kinds of metric.

**Interval metrics** (durations between two boundaries):

- `exact` — both boundaries come from recorded events of the kinds named in [§2](#2-top-level-wall-clock-phases).
- `inferred` — both boundaries are defensible but at least one is a proxy (e.g. `usage_events.ts` standing in for `agent.completed` as an `upper_bound`, or `now` closing an open interval). A boundary that cannot be expressed as UTC epoch ms (such as the opaque `process_started_at` string) is not a proxy at all. Always carries at least one reason code, e.g. `proxy_boundary`, `open_interval`, `backfill`, `upper_bound`, `includes_spawn_slot_wait`, `includes_post_exit_work`.
- `unavailable` — a required boundary is missing, contradictory, or only available from a source that cannot defensibly stand in for it. Carries reason codes such as `missing_queue_terminal`, `missing_activity_history`, `missing_log`, `negative_duration`, `unordered_tie`, `no_defensible_boundary`.

**Value metrics** (tokens, cost, and other numbers read directly from a record, not derived from two boundaries):

- `exact` — the value was recorded by the provider/runner for that observation (e.g. `usage_events.cost_usd` non-null from provider evidence).
- `inferred` — the value was computed from other recorded values by a documented rule (never a price guess; see below). Carries a reason code.
- `unavailable` — the value is null/absent for that observation. Carries e.g. `missing_provider_metadata`.

**Aggregates over many observations** (totals, and percentiles per [§3](#3-overlap-and-aggregation)). Quality is determined **only by the known inputs that were included**, and completeness is reported separately as counts, never folded into the quality label:

- Sum/percentile over the known observations takes the **weakest quality among those known observations** (`exact` if all included are `exact`, `inferred` if any is `inferred`), with their reason codes unioned. Unknown (`unavailable`) observations are excluded and do not downgrade it.
- Every aggregate also carries `known` and `total` sample counts. When `known < total`, it adds the reason code `partial_sample`. `partial_sample` is a completeness flag, not a quality tier: `$4.20 over 3 of 5` is `exact` with `partial_sample` if the three known costs are `exact`.
- `known = 0` → the aggregate is `unavailable` (never `0`), reason `missing_provider_metadata` (or the reason of the missing inputs).
- Consumers must not present a `partial_sample` aggregate as a complete total or compare it against a complete one without showing `known / total`.

Rules for missing data:

- **Never coerce missing cost, tokens, or duration to zero** for a comparison, ranking, or percentile. A missing value is absent from the sample, not `0`.
- **Totals are over known values only**, displayed together with `known / total` sample counts (e.g. `$4.20 over 3 of 5 sessions`).
- **Cursor cost remains `unavailable`** unless the provider supplied cost evidence. There is no price inference from tokens, model, or duration.

## 5. Silence taxonomy

Silence is observational. The closed set of silence causes is:

| Code | Meaning |
|------|---------|
| `model_provider_wait` | Last structured activity indicates the agent was waiting on the model provider. |
| `tool_or_subprocess_in_flight` | A tool call or subprocess was started and had not returned (e.g. a long test run). |
| `host_suspended` | The host slept/suspended over the interval (wall clock jumped vs monotonic evidence). |
| `no_structured_output` | The runtime emits no structured stream for this phase, so activity cannot be observed. |
| `unknown` | None of the above is supported by evidence. |

Use only these codes. "**Silent**" means *no new structured activity for the configured observation threshold*; it **never** means idle, stuck, or dead — a tool may be doing real work.

> **Silence must not drive control-plane behavior.** It is observational only and must not affect retry, termination, scheduling, leases, heartbeats, admission, or recovery decisions. No code path in the coordinator may branch on a silence classification. Existing liveness (process pid checks, lease expiry) remains the only input to those decisions.

## 6. Source matrix

State as of this contract. "Derivable today" means computable from existing rows without a schema or emission change.

| Metric | Source of truth (target) | Today | Status |
|--------|--------------------------|-------|--------|
| `queue_wait` start | `queue.enqueued` = `queue_entries.enqueued_at` | Column exists | Derivable today (start only) |
| `queue_wait` end | `queue.admitted` / `queue.removed` | `queue_entries.state` flips, but **no terminal timestamp** is stored and `wait_reason`/`wait_reason_at` are cleared on admit/remove | **Needs new event/schema** — `unavailable` for history |
| `admission_dependency_wait` | wait-reason history | Only the *latest* `wait_reason` + `wait_reason_at`; overwritten, no history | **Needs new event/schema** |
| `runtime_health_preflight` | queue-reason + Deck-connect evidence | Latest wait reason only; no Deck-connect timing event | **Needs new event/schema** |
| `coordinator_setup` start | `worker.started` | `workflow_events` type `worker.started`, recorded before worktree setup | Derivable today |
| `coordinator_setup` end / `agent_process` start | `agent.started` | Not emitted, and **no defensible proxy exists today**. `worker_sessions.process_started_at` is an opaque, timezone-free `ps -o lstart=` string that `readProcessStartTime` deliberately never parses (its locale/timezone cannot be assumed), so it cannot be converted to a UTC epoch-ms boundary and is **process-identity evidence only**. `usage_events.ts − usage_events.duration_ms` is not a proxy either: its start is the coordinator clock just before `deps.spawn`, which precedes `acquireSpawnSlot()` and so includes spawn-slot waiting ([§6.1](#61-usage-event-timing)). `worker_sessions.started_at` is coordinator session bookkeeping, also not a proxy | **Needs new event** (a real UTC spawn timestamp recorded once the child exists). Today `unavailable`, reason `no_defensible_boundary`, for `agent.started`, `coordinator_setup`, and `agent_process` |
| `agent_process` end / `coordinator_validation_publish` start | `agent.completed` | Not emitted. Possible proxy: `usage_events.ts` as an **upper bound** only — it is stamped after the child exits *and* after post-exit coordinator work (developer: worktree-clean check, `git rev-parse`, verification-receipt mining; both roles: usage extraction from the log), so the true CLI exit precedes it by an unrecorded amount ([§6.1](#61-usage-event-timing)). **`worker_sessions.completed_at` alone is `unavailable` for this boundary**: it is written only after the effect returns and outcome routing has run (`worker.completed`/`worker.failed` emitted), so it includes validation, salvage, push, and PR work and can fall after the terminal event | **Needs new event** (`usage_events.ts` → `inferred` boundary, reasons `proxy_boundary`, `upper_bound`, `includes_post_exit_work`; only `completed_at` → `unavailable`, reason `no_defensible_boundary`). Because `agent.started` is unavailable today, `agent_process` itself stays `unavailable` even when this end proxy exists; only `coordinator_validation_publish` can use it, as `inferred` |
| `coordinator_validation_publish` end | `worker.completed` / `worker.failed` | `workflow_events` | Derivable today |
| `human_wait` | `human_actions.requested_at` / `resolved_at` | Columns exist; `human_action.requested` / `.resolved` events | Derivable today (`exact`) |
| Issue elapsed | `workflow_instances.started_at` → `completed_at` | Columns exist | Derivable today |
| Spawn envelope (coordinator-measured) | `usage_events.duration_ms` | Column exists; nullable, one row per spawn. Measures `[usage_events.ts − duration_ms, usage_events.ts)` — **not** the CLI lifetime and not agent-process resource time ([§6.1](#61-usage-event-timing)) | Derivable today, as `spawn_envelope` only (`inferred`, reasons `includes_spawn_slot_wait`, `includes_post_exit_work`; null → `unavailable`) |
| Attempt runtime (resource) | CLI lifetime = `agent.completed − agent.started` | Neither boundary is defensible today: `agent.started` has no proxy (`process_started_at` is not UTC-parseable), and `agent.completed` has only an upper bound. `duration_ms` (spawn envelope) and `worker_sessions.started_at → completed_at` (session bookkeeping including coordinator work) are **not** CLI runtime | **Needs new event** (`agent.started` + `agent.completed`). Today `unavailable`, reason `no_defensible_boundary`; excluded from resource sums and counted in `known / total` |
| Tokens / cost | `usage_events.tokens_in/out/cost_usd` | Nullable columns; provider dependent | Derivable where recorded; Cursor cost `unavailable` |
| `unexplained_silence` | Structured activity timestamps in the runner stream | NDJSON log exists at `log_path`, but no activity-timestamp history is persisted in a queryable form | **Needs new event/schema** |
| Failure classification | `worker.failed` payload, `error_json`, `exit_code`, runner stderr, `failure-reason` | Free-text reason + runtime auth classification only | **Needs new event/schema** for structured code/domain; partial inference possible |
| Event ordering | `workflow_events` rowid | Available | Derivable today |

### 6.1 Usage-event timing

`usage_events` rows (developer and reviewer effects) are written once per spawn, and `duration_ms` is measured by the coordinator, not by the CLI. What it actually spans:

1. **Start** — `Date.now()` immediately *before* `deps.spawn(...)`. Production `spawnCli` then awaits `acquireSpawnSlot()`, which blocks while `MAX_CONCURRENT_RUNS` children are already running, *before* creating the child. Slot wait is admission-like queueing, not agent work, and is included in `duration_ms`.
2. **Middle** — the CLI child's lifetime, including its timeout/abort kill escalation.
3. **End** — `Date.now()` after `deps.spawn` resolves, after (developer only) `persistVerificationReceiptIfAny` (git status/rev-parse, log parsing, artifact write) and after `extractSpawnUsage` (log parsing) — all coordinator work following the child's exit. `usage_events.ts` is stamped at the same point.

Consequences for this contract:

- `duration_ms` is an **upper bound** on CLI lifetime with two unrecorded, unbounded inflations (slot wait at the front, post-exit work at the back). It is `inferred` at best and is never `exact`.
- It is reported only as `spawn_envelope`, a coordinator-measured span that must not be labeled, summed, or compared as CLI runtime or agent-process resource time. CLI runtime is `unavailable`, not `duration_ms`.
- There is **no tighter bound today**. `worker_sessions.process_started_at` cannot tighten it: it is an opaque `ps lstart` string, never parsed because its locale/timezone cannot be assumed, so it yields no UTC epoch-ms and `usage_events.ts − process_started_at` is not computable. It stays process-identity evidence (pid-reuse checks) and is never an interval boundary.
- Percentiles and totals over `spawn_envelope` values are comparable only among observations with the same reason set ([§3](#3-overlap-and-aggregation) item 6); they are never mixed with `exact` CLI runtime from a future `agent.started`/`agent.completed` event pair.
- A future emitter must record `agent.started` when the child exists (after the slot is acquired) and `agent.completed` at child exit, before any receipt mining, usage extraction, or validation; only then is CLI runtime `exact`.

## 7. Failure taxonomy

### Codes

`authentication_configuration`, `provider_capacity_rate_limit`, `agent_cli_crash`, `tool_test_timeout`, `coordinator_crash`, `validation_failure`, `publish_git_failure`, `agent_deck_unavailable`, `host_sleep_liveness`, `unknown`.

### Classification record

Each classification carries:

```
code:        one of the codes above
domain:      "task" | "infrastructure" | "unknown"
primary:     boolean
evidence:    raw reason / evidence references (event ids, session id, log path + offsets)
confidence:  "high" | "medium" | "low"
```

### Rules

- **Primary vs consequence.** The first chronological actionable cause is `primary: true`; every later failure in the same attempt chain is a consequence (`primary: false`). Chronology uses the ordering rule in [§1](#1-principles). Exactly one primary per failed attempt.
- **Domain.**
  - `task` — validation / test-assertion failures: the work was wrong.
  - `infrastructure` — transport, auth, provider, coordinator, Deck, and publish failures: the work may have been fine.
  - `unknown` — ambiguous evidence.
- **Ambiguous timeouts remain `unknown`.** A timeout is `tool_test_timeout` (domain `task`) only when evidence shows a tool/test was in flight; a timeout with no such evidence stays `unknown` (domain `unknown`). Do not guess.
- Suggested default domain per code: `validation_failure` → `task`; `tool_test_timeout` → `task` when a tool/test was in flight; `authentication_configuration`, `provider_capacity_rate_limit`, `agent_cli_crash`, `coordinator_crash`, `publish_git_failure`, `agent_deck_unavailable`, `host_sleep_liveness` → `infrastructure`; `unknown` → `unknown`. Evidence may override with lower confidence.
- Classification is a derived view; the raw reason text stays as recorded and is referenced, not replaced.

## 8. Backfill and missing data

- Rows written before instrumentation are derived from **existing timestamps/events only when both boundaries are defensible**, and are labeled `quality: inferred` (reason `backfill`).
- **`unavailable`** results, per observation, for: missing queue terminal timestamps, missing activity history, missing provider metadata, absent logs, and a boundary whose only source is one that cannot defensibly stand in for it (e.g. `worker_sessions.completed_at` alone for `agent.completed`, or `usage_events.duration_ms` alone as CLI runtime, see [§6](#6-source-matrix) and [§6.1](#61-usage-event-timing)). Aggregates over such observations follow [§4](#4-evidence-quality): the unavailable ones are excluded and counted in `known / total`, and an aggregate with no known observations is itself `unavailable`.
- Migrations **do not invent timestamps** and **do not rewrite evidence**, whether immutable (`workflow_events`, `usage_events`, logs) or mutable source records (`queue_entries`, `human_actions`, `worker_sessions`) — overwritten history, such as cleared queue wait reasons, stays lost. Backfill produces derived rows/views only.
- A backfilled metric never upgrades to `exact`; only newly recorded events can be `exact`.

## 9. Examples

Times are `HH:MM:SS.mmm` UTC on one day; intervals half-open.

### 9.1 Overlapping human actions

Actions A `[10:00:00, 10:10:00)` and B `[10:05:00, 10:20:00)`; issue elapsed `[10:00:00, 10:30:00)`.
`human_wait` = union `[10:00:00, 10:20:00)` = **20 min** (not 25). It overlaps agent processing and is reported beside the exclusive phases. If B were still open, the live view closes it at `now`, `quality: inferred`, reason `open_interval`.

### 9.2 Overlapping / retried attempts

Attempt 1 `agent_process` `[10:00, 10:20)` (crashed); reclaim starts attempt 2 `[10:15, 10:40)` (overlaps because the lease-expired process was still running).
- Phase chart: union `[10:00, 10:40)` = **40 min** of `agent_process`.
- Resource consumption: 20 + 25 = **45 min** of attempt runtime (when both attempts have `agent.started`/`agent.completed`; from `usage_events.duration_ms` alone it would be a `spawn_envelope` sum, not CLI runtime — [§6.1](#61-usage-event-timing)).
- Issue elapsed: workflow start to completion, e.g. `[09:50, 10:45)` = 55 min — not 45.

### 9.3 Same-millisecond events

`agent.completed` and `worker.failed` both carry `ts = 10:40:00.123`. Order by `workflow_events` rowid: whichever row was inserted first is first. `coordinator_validation_publish` = `[agent.completed, worker.failed)` = 0 ms when they are adjacent — a valid empty interval. If the two events come from tables without a shared cursor, the order is `unavailable` (`unordered_tie`).

### 9.4 Host sleep

Structured activity last seen at 10:00:00; next at 10:45:00; the host suspended `[10:02, 10:44)` (wall-clock jump against monotonic evidence). With a 5-minute threshold, `unexplained_silence` inside `agent_process` is `[10:05, 10:45)` classified `host_suspended`; if suspend evidence is absent it is `unknown`, never `model_provider_wait` by guess. Nothing about this silence changes retry, lease, or termination. If the process was then presumed dead, the failure is `host_sleep_liveness` (`infrastructure`) only when suspend evidence supports it.

### 9.5 Unknown failure

`worker.failed` after a 60-minute timeout; no tool in flight is recorded, no stderr matches any auth/provider marker, exit code absent. Classification: `code: unknown`, `domain: unknown`, `primary: true`, `confidence: low`, evidence = the `worker.failed` event id and session log path. It is **not** promoted to `tool_test_timeout`.

### 9.6 Incomplete provider metadata

Five developer sessions; `usage_events` cost known for 3 (`$1.10`, `$0.90`, `$2.20`), tokens known for 4, and 2 Cursor sessions with no cost evidence.
- Cost total: **$4.20 over 3 of 5 sessions** (`known = 3`, `total = 5`), `quality: exact` (all three known values are provider-recorded), reason `partial_sample`. Not `$4.20 / 5`, and not `$0` for the missing two, which are individually `unavailable` (`missing_provider_metadata`) and simply excluded.
- Token total: `known = 4`, `total = 5`, same rule.
- Cost P50 over the 3 known values `[0.90, 1.10, 2.20]`: `rank = ceil(0.5·3) = 2` → `$1.10`, `n = 3`.
- Cursor cost per session: `unavailable`. No price is inferred from tokens.

## 10. Non-goals

Production schema changes, new API endpoints or UI, and a general distributed tracing platform are out of scope for this contract; they belong to the implementation tickets under NOT-161.

See also: [DATA_MODEL.md](DATA_MODEL.md), [PRD_ISSUE_COORDINATION.md](PRD_ISSUE_COORDINATION.md).
