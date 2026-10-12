# Botmancers requirements inventory (dealer side, NOT-399)

Inventory of what agent-dealer already provides against what the Botmancers app
would need from a work queue, a status listener, and a runner that is not a
laptop. Companion to NOT-397 (Botmancers side).

## Provenance

NOT-397's `docs/runner-boundary-requirements.md` did not exist in any reachable
checkout when this inventory was written (2026-10-11; the NOT-397 branch
worktree was clean at its base commit with no requirements file, and the remote
was unreachable from this session), so each row below is traced to the
committed Botmancers requirement sources that do exist, at botmancers commit
`9a8612e`:

- `docs/product-requirements.md` — R1–R9, safety/operational requirements,
  acceptance scenarios A–E (cited as PR:R7, PR:A2, …).
- `docs/claude-via-deck.md` — Claude-via-deck runbook: hand-assembled launch,
  log-tail session-id capture, manual resume, wanted completion signal
  (cited as CVD).
- Working-copy contracts (untracked in the local botmancers checkout):
  `docs/runtime-contract-v0.md` (cited as RC) and
  `docs/control-plane-contract-v0.md` (cited as CC), plus
  `docs/implementation-plan.md` (cited as IP).

Row count: 21 (Q1–Q7 queue, S1–S6 status listener, R1–R8 non-laptop runner).
When NOT-397 lands, diff its requirement list against the IDs below; any
NOT-397 requirement with no matching row is a gap in this inventory, not a
verified dealer capability.

Evidence cells cite agent-dealer repo paths or `NOT-` ids; `none` marks an
absence. All `yes`/`partial` values were verified against the cited code, not
memory.

## Queue

| Requirement (Botmancers source) | agent-dealer capability | Exists now | Evidence | Gap |
|---|---|---|---|---|
| Q1 — Idempotent task creation: repeat returns the same task, same-key/different-payload is rejected (PR safety; CC request envelope) | Re-import of a live Linear ticket never duplicates: idempotent re-enqueue (`already_queued`) or 409 naming the holder; work items carry idempotency keys | partial | `packages/server/src/routes/issues.ts`, `packages/server/src/repository/work-items.ts` | Keys are server-derived, not caller-supplied, so same-key/different-payload conflict semantics are not exposed. |
| Q2 — Queued work is visible: caller can tell queued vs running vs blocked vs failed vs complete (PR:R7; PR:A2) | `GET /api/queue` (1-based positions + wait reasons), `GET /api/queue/status` (N active · M waiting · limit), issue detail with status and queue entry | yes | `packages/server/src/routes/queue.ts`, `packages/server/src/coordinator/admission.ts` | Read model is dealer-dashboard shaped, not a typed external caller contract. |
| Q3 — Bounded concurrency with admission gating (PR:R6 grant; PR safety) | Global fixed limit N (persisted operator setting 1–5), slot-gated level-triggered admission, per-runtime hard caps, lowering never preempts | partial | `packages/server/src/repository/admission-settings.ts`, NOT-378, NOT-371 | Concurrency is global plus per-runtime caps, with no per-bot/per-grant concurrency. |
| Q4 — Explicit attempt lifecycle applied only from authenticated evidence (PR safety state tables) | Issue/workflow states with legal transitions, append-only workflow-event timeline, structured effect completions | yes | `packages/shared/src/workflow.ts`, `packages/server/src/repository/workflow-events.ts` | Lifecycle is dealer-internal; there is no external authenticated-observation API. |
| Q5 — Safeguards: bounded depth/rounds, time or spend limits, no silent duplicate dispatch (PR safety; RC gates 1–2) | Bounded review rounds (`attempts_exhausted`), attempt wall-clock + idle-watchdog kills, usage-cap deferral, idempotent dispatch keys, per-phase turn budgets | partial | `packages/server/src/coordinator/routing.ts`, `packages/server/src/runners/spawn-cli.ts` | Fixed developer→reviewer topology has no delegation chains, so depth bounds and loop detection do not apply. |
| Q6 — Working single-task cancel: request → confirmed stop (PR safety; RC cancel semantics) | `POST /api/issues/:id/abort` kills the worker process and resolves open human actions; idempotent close | yes | `packages/server/src/coordinator/commands.ts` | Cancellation kills a local process only, with no remote-cancel propagation. |
| Q7 — Retry creates a new explicitly linked attempt, never reuses a terminal attempt id (PR safety; RC gate 10) | Retries and repair rounds create new work items with distinct idempotency keys (`:retry-of:` lineage in key) | partial | `packages/server/src/coordinator/commands.ts` | Retry lineage lives in key strings and rounds, not a first-class `retry_of` attempt record. |

## Status listener

| Requirement (Botmancers source) | agent-dealer capability | Exists now | Evidence | Gap |
|---|---|---|---|---|
| S1 — Status query returns full projection: status, attempts, artifacts, blockers (PR:R7; CC `tasks.get`) | `GET /api/issues/:id`: issue, timeline, findings, usage, live progress, failures, queue state | yes | `packages/server/src/routes/issues.ts` | Poll-only reads with no typed external projection contract. |
| S2 — Ordered, deduplicated, replayable event stream with cursors (CC `tasks.events`; RC observations + reconcile) | Append-only workflow-event timeline per issue, queue history, append-only `session_activity_events` with dedup key | partial | `packages/server/src/repository/workflow-events.ts`, `docs/DATA_MODEL.md` | Poll-based reads only: no cursors, long-poll, or push stream. |
| S3 — Streaming progress observations that never mutate lifecycle state (PR authority; RC `progress`) | Live log-tail progress strip plus an activity sampler that is observational-only by construction | partial | `packages/server/src/coordinator/session-progress.ts`, `docs/DATA_MODEL.md` | Progress is inferred from local logs, not a typed observation channel. |
| S4 — Inspectable results: summary, typed review decision, artifact manifests with content ref or digest (PR:R7; CC `tasks.result`; RC artifact manifest) | Typed reviewer verdicts (`approved`/`changes_requested`/`escalated`), findings, execution artifacts, final review packet, PR linkage | partial | `docs/PRD_ISSUE_COORDINATION.md`, `packages/server/src/coordinator/reviewer-result.ts` | Artifacts lack content digests and there is no canonical artifact-manifest shape. |
| S5 — Stable failure taxonomy: code plus retryable, separate from native detail (RC failure; CC failure envelope) | Failure-cause/reason classification, latest-session-failure read model, typed deferral reasons | partial | `packages/server/src/coordinator/failure-cause.ts` | Vocabulary is dealer-internal, not a stable external code-plus-retryable contract. |
| S6 — Outcomes routed back to the originating conversation with idempotent delivery receipts (CC origin binding; PR:A8) | none — the issue workflow deliberately does not write status back; completion surfaces via the GitHub PR and the dashboard | no | `packages/server/src/adapters/linear-sync.ts` | No return-to-origin routing exists; only a `done` write-back on the run-scoped approval path. |

## Non-laptop runner

| Requirement (Botmancers source) | agent-dealer capability | Exists now | Evidence | Gap |
|---|---|---|---|---|
| R1 — Run on non-local targets: user cloud machine, provider API, persistent service (PR:R4) | none — every worker is a local child process in a worktree under the local execution root | no | `packages/server/src/runners/spawn-cli.ts`, `docs/PROD_SETUP.md` | No remote, cloud, or provider-managed execution target exists. |
| R2 — Server and runtime must not be assumed to share a machine (PR:R4) | none — log-tail reads, pid liveness checks, and worktree paths assume one machine | no | `packages/server/src/coordinator/process-liveness.ts` | Colocation is structural, not just a default. |
| R3 — Authenticated runner holding scoped launch grants; dedupes repeated dispatches (PR:R6; IP Runner; RC idempotency) | Leased work items with fencing tokens and idempotent dispatch keys; deck health and agent profiles gate spawn | partial | `packages/server/src/repository/work-items.ts` | Trust boundary is the local host: no runner authentication or scoped launch grants. |
| R4 — Lease/heartbeat per non-terminal attempt with recovery owner and safe-reconnect proof (PR safety post-gate; RC lease) | Expiring leases with heartbeat refresh, token-fenced reclaim, bounded infra-attempt budget, pid-liveness and clock-jump grace gates, dead-lettering | yes | `packages/server/src/coordinator/recovery.ts` | Recovery owner is coordinator policy, not a named external owner, and it is single-host only. |
| R5 — Capability negotiation: missing capability is `unsupported`, never silently emulated (RC capability negotiation) | none — runtime and role support are hardcoded gates, not negotiated capabilities | no | `packages/server/src/coordinator/admission.ts`, NOT-178 | No adapter capability surface exists. |
| R6 — Session binding: opaque native session id plus continuity mode, reusable by later attempts (PR:R5; RC session binding; CVD resume) | Worker sessions persist `session_ref` and agent session ids per attempt | partial | `packages/server/src/repository/worker-sessions.ts`, `docs/DATA_MODEL.md` | Session refs are recorded but never resumed; repair rounds start fresh processes. |
| R7 — Idle workers: durable state while off, wake on demand without continuous polling, low wake latency (PR:R8; PR:C; CVD completion signal) | none — the server is always-on local and holds the host awake during work instead of waking on demand | no | `packages/server/src/power/host-awake.ts`, NOT-369 | Sleep is prevented (`caffeinate`), not woken through; no wake path exists. |
| R8 — Reconcile: report native status and replay retained observations after a gap; unknown never means completion (RC reconcile) | Restart recovery reclaims expired leases and the sampler resumes from its last offset | partial | `packages/server/src/coordinator/recovery.ts` | No native-status query or observation replay; unknown state reclaims under infra budget. |

## Closing

Per-row dealer-change verdict: Q1 would need caller-supplied idempotency keys;
Q2 would need a typed external read contract; Q3 would need per-grant
concurrency; Q4 would need an external observation API; Q5 would need
delegation-chain bounds; Q6 would need remote-cancel propagation; Q7 would need
first-class retry lineage; S1 would need a typed projection contract; S2 would
need cursors plus long-poll or push; S3 would need a typed observation channel;
S4 would need canonical artifact manifests; S5 would need a stable external
failure contract; S6 would need return-to-origin routing; R1 would need remote
execution targets; R2 would need a split server/runtime transport; R3 would
need runner authentication and scoped grants; R4 would need a named external
recovery owner; R5 would need capability negotiation; R6 would need session
resume; R7 would need on-demand wake; R8 would need a reconcile protocol — and
per the currently agreed plan, no dealer change is needed for any row above and
nothing is built.
