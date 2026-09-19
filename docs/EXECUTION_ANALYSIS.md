---
status: contract
linear: NOT-167
epic: NOT-161
---

# Execution analysis contract

The single authoritative definition of how agent-dealer measures where execution time goes, why attempts fail, and how much retry work is wasted (epic NOT-161). Every implementation ticket under that epic — telemetry events, projections, API, UI, backfill — uses the phase boundaries, overlap rules, vocabularies, aggregation semantics, and missing-data behavior below. Other docs link here; they do not restate it.

This document is a contract, not an implementation. Nothing here is emitted today unless the [source matrix](#6-source-matrix) says so.

## 1. Principles

- **Raw evidence vs derived views.** Raw evidence is append-only: `workflow_events`, `human_actions`, `queue_entries`, `worker_sessions`, `usage_events`, and the NDJSON logs at `worker_sessions.log_path`. A derived view (phase durations, silence, failure classification, percentiles) is computed from raw evidence, may be recomputed at any time, and never rewrites it. Migrations and backfills do not invent timestamps or mutate evidence rows.
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

- `exact` — both boundaries come from recorded events of the kinds named in [§2](#2-top-level-wall-clock-phases).
- `inferred` — derived from existing timestamps/events where both boundaries are defensible but at least one is a proxy (e.g. `worker_sessions.started_at` standing in for `agent.started`, or `now` closing an open interval). Always carries at least one reason code, e.g. `proxy_boundary`, `open_interval`, `backfill`.
- `unavailable` — a required boundary or input is missing or contradictory. Carries reason codes such as `missing_queue_terminal`, `missing_activity_history`, `missing_provider_metadata`, `missing_log`, `negative_duration`, `unordered_tie`.

Rules for missing data:

- **Never coerce missing cost, tokens, or duration to zero** for a comparison, ranking, or percentile. A missing value is absent from the sample, not `0`.
- **Totals are over known values only**, displayed together with `known / total` sample counts (e.g. `$4.20 over 3 of 5 sessions`). A total with `known = 0` is `unavailable`, not `$0`.
- **Cursor cost remains `unavailable`** unless the provider supplied cost evidence. There is no price inference from tokens, model, or duration.
- A metric aggregating mixed-quality inputs takes the **weakest** input quality, and unions their reason codes.

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
| `coordinator_setup` end / `agent_process` start | `agent.started` | Not emitted; `worker_sessions.started_at` and `process_started_at` are proxies | **Needs new event** (proxy → `inferred`) |
| `agent_process` end | `agent.completed` | Not emitted; `worker_sessions.completed_at` / `usage_events.duration_ms` are proxies | **Needs new event** (proxy → `inferred`) |
| `coordinator_validation_publish` end | `worker.completed` / `worker.failed` | `workflow_events` | Derivable today |
| `human_wait` | `human_actions.requested_at` / `resolved_at` | Columns exist; `human_action.requested` / `.resolved` events | Derivable today (`exact`) |
| Issue elapsed | `workflow_instances.started_at` → `completed_at` | Columns exist | Derivable today |
| Attempt runtime (resource) | `worker_sessions` `started_at`/`completed_at`, `usage_events.duration_ms` | Columns exist; nullable | Derivable today (`inferred`; nulls → `unavailable`) |
| Tokens / cost | `usage_events.tokens_in/out/cost_usd` | Nullable columns; provider dependent | Derivable where recorded; Cursor cost `unavailable` |
| `unexplained_silence` | Structured activity timestamps in the runner stream | NDJSON log exists at `log_path`, but no activity-timestamp history is persisted in a queryable form | **Needs new event/schema** |
| Failure classification | `worker.failed` payload, `error_json`, `exit_code`, runner stderr, `failure-reason` | Free-text reason + runtime auth classification only | **Needs new event/schema** for structured code/domain; partial inference possible |
| Event ordering | `workflow_events` rowid | Available | Derivable today |

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
- **`unavailable`** results for: missing queue terminal timestamps, missing activity history, missing provider metadata, absent logs.
- Migrations **do not invent timestamps** and **do not rewrite append-only evidence**. Backfill produces derived rows/views only.
- A backfilled metric never upgrades to `exact`; only newly recorded events can be `exact`.

## 9. Examples

Times are `HH:MM:SS.mmm` UTC on one day; intervals half-open.

### 9.1 Overlapping human actions

Actions A `[10:00:00, 10:10:00)` and B `[10:05:00, 10:20:00)`; issue elapsed `[10:00:00, 10:30:00)`.
`human_wait` = union `[10:00:00, 10:20:00)` = **20 min** (not 25). It overlaps agent processing and is reported beside the exclusive phases. If B were still open, the live view closes it at `now`, `quality: inferred`, reason `open_interval`.

### 9.2 Overlapping / retried attempts

Attempt 1 `agent_process` `[10:00, 10:20)` (crashed); reclaim starts attempt 2 `[10:15, 10:40)` (overlaps because the lease-expired process was still running).
- Phase chart: union `[10:00, 10:40)` = **40 min** of `agent_process`.
- Resource consumption: 20 + 25 = **45 min** of attempt runtime.
- Issue elapsed: workflow start to completion, e.g. `[09:50, 10:45)` = 55 min — not 45.

### 9.3 Same-millisecond events

`agent.completed` and `worker.failed` both carry `ts = 10:40:00.123`. Order by `workflow_events` rowid: whichever row was inserted first is first. `coordinator_validation_publish` = `[agent.completed, worker.failed)` = 0 ms when they are adjacent — a valid empty interval. If the two events come from tables without a shared cursor, the order is `unavailable` (`unordered_tie`).

### 9.4 Host sleep

Structured activity last seen at 10:00:00; next at 10:45:00; the host suspended `[10:02, 10:44)` (wall-clock jump against monotonic evidence). With a 5-minute threshold, `unexplained_silence` inside `agent_process` is `[10:05, 10:45)` classified `host_suspended`; if suspend evidence is absent it is `unknown`, never `model_provider_wait` by guess. Nothing about this silence changes retry, lease, or termination. If the process was then presumed dead, the failure is `host_sleep_liveness` (`infrastructure`) only when suspend evidence supports it.

### 9.5 Unknown failure

`worker.failed` after a 60-minute timeout; no tool in flight is recorded, no stderr matches any auth/provider marker, exit code absent. Classification: `code: unknown`, `domain: unknown`, `primary: true`, `confidence: low`, evidence = the `worker.failed` event id and session log path. It is **not** promoted to `tool_test_timeout`.

### 9.6 Incomplete provider metadata

Five developer sessions; `usage_events` cost known for 3 (`$1.10`, `$0.90`, `$2.20`), tokens known for 4, and 2 Cursor sessions with no cost evidence.
- Cost total: **$4.20 over 3 of 5 sessions**, `quality: inferred`, reason `missing_provider_metadata` (partial). Not `$4.20 / 5`, and not `$0` for the missing two.
- Cost P50 over the 3 known values `[0.90, 1.10, 2.20]`: `rank = ceil(0.5·3) = 2` → `$1.10`, `n = 3`.
- Cursor cost per session: `unavailable`. No price is inferred from tokens.

## 10. Non-goals

Production schema changes, new API endpoints or UI, and a general distributed tracing platform are out of scope for this contract; they belong to the implementation tickets under NOT-161.

See also: [DATA_MODEL.md](DATA_MODEL.md), [PRD_ISSUE_COORDINATION.md](PRD_ISSUE_COORDINATION.md).
