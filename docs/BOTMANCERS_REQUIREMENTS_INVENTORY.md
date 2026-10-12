# Botmancers requirements inventory (dealer side, NOT-399)

Inventory of what agent-dealer already provides against what the Botmancers app
would need from a work queue, a status listener, and a runner that is not a
laptop. Companion to NOT-397 (Botmancers side).

## Provenance

Each row below traces to one numbered requirement in NOT-397's
`docs/runner-boundary-requirements.md` on botmancers main (commit `0a981f1`,
"NOT-397: add Botmancers-side runner boundary requirements"), a tracked file
with stable requirement ids Q1–Q4 (queue), S1–S3 (status listener), N1–N5
(non-laptop runner) — 12 requirements in total. No untracked working-copy
draft is cited.

Row count: 12 (Q1–Q4 queue, S1–S3 status listener, N1–N5 non-laptop runner),
matching the 12 requirements in NOT-397's
`docs/runner-boundary-requirements.md`.

Evidence cells cite agent-dealer repo paths or `NOT-` ids; `none` marks an
absence. All `partial`/`no` values were verified against the cited code, not
memory. A row is `partial` wherever its own gap shows parts of the requirement
are missing; no row is marked `yes` because every requirement's interface
includes cross-machine or authenticated-caller elements dealer lacks.

## Queue

| Requirement (NOT-397 source) | agent-dealer capability | Exists now | Evidence | Gap |
|---|---|---|---|---|
| Q1 — Accept a delegation request: authenticated caller, one task addressed to a registered target bot; task id or rejection with reason | Linear-issue intake creates one work item per issue with idempotent re-import, under operator trust | partial | `packages/server/src/routes/issues.ts` | Intake is Linear-issue shaped under operator trust, with no authenticated caller identity, target-bot addressing, or grant scope. |
| Q2 — Hold the request while the target is not running: durable and claimable, no silent loss | Waiting work items persist until admission claims them; expired leases are reclaimed through the bounded retry policy instead of being lost | partial | `packages/server/src/repository/work-items.ts`, `packages/server/src/coordinator/admission.ts`, `packages/server/src/coordinator/recovery.ts` | Durability and reclaim are bound to the always-on local server, with no offline-target claim or wake trigger. |
| Q3 — Order queued work per target: deterministic claim order (FIFO baseline with tie-break) visible to claimants | `GET /api/queue` reports 1-based positions with wait reasons over one global queue | partial | `packages/server/src/routes/queue.ts` | Positions reflect one global queue, not deterministic per-target FIFO with a stated tie-break. |
| Q4 — Create idempotently: same key returns the same task id, never duplicates | Idempotent enqueue (`already_queued`) with per-work-item idempotency keys | partial | `packages/server/src/routes/issues.ts`, `packages/server/src/repository/work-items.ts` | Keys are server-derived, so caller-supplied same-key repeat semantics are not exposed. |

## Status listener

| Requirement (NOT-397 source) | agent-dealer capability | Exists now | Evidence | Gap |
|---|---|---|---|---|
| S1 — Report queued, running, blocked, failed, or complete with a reason, plus results when available | `GET /api/issues/:id` returns status, timeline, findings, usage, failures, and queue state | partial | `packages/server/src/routes/issues.ts` | Poll-only dashboard-shaped reads with no authenticated-caller scoping. |
| S2 — Deliver updates by push or poll, with the terminal outcome never silently lost | Append-only workflow-event timeline re-read by polling; terminal outcomes are durable | partial | `packages/server/src/repository/workflow-events.ts`, `docs/DATA_MODEL.md` | No cursors, subscriptions, or push; callers re-read the whole timeline by polling. |
| S3 — Restrict reads to authorized callers; sender gains no target credentials | none — issue reads carry no caller authentication or per-task authorization | no | `packages/server/src/routes/issues.ts` | Reads are open to any dashboard caller, with no grant-based authorization. |

## Non-laptop runner

| Requirement (NOT-397 source) | agent-dealer capability | Exists now | Evidence | Gap |
|---|---|---|---|---|
| N1 — Wake a target that is not running, without continuous idle polling | none — the server is always-on local and holds the host awake during work instead of waking on demand | no | `packages/server/src/power/host-awake.ts`, NOT-369 | Sleep is prevented (`caffeinate`), not woken through; no wake path exists. |
| N2 — Start the target with a resolved launch snapshot: exact config, digest-bound, mismatch rejected | Local worker spawn from configured agent profiles with runtime gates | partial | `packages/server/src/runners/spawn-cli.ts`, `docs/AGENT_PROFILES.md` | No immutable snapshot digest binding or mismatch rejection, and the target is always the local host. |
| N3 — Report observations and results back; control plane alone applies transitions; artifacts addressable with provenance | Typed reviewer verdicts, findings, and execution artifacts flow back to the coordinator and land on the append-only timeline | partial | `packages/server/src/coordinator/reviewer-result.ts`, `packages/server/src/repository/workflow-events.ts` | Single-host result flow with no cross-machine observation channel or artifact digests. |
| N4 — Stop running work on request: cancelled terminal state, runner halted, no late completion | `POST /api/issues/:id/abort` kills the worker process and resolves open human actions; idempotent close | partial | `packages/server/src/coordinator/commands.ts` | Cancellation kills a local process only, with no remote-stop propagation. |
| N5 — Authenticate the runner to the control plane on every call; unknown runners rejected | none — local spawn performs no credential exchange | no | `packages/server/src/runners/spawn-cli.ts` | No runner identity exists to authenticate, so unknown runners cannot be rejected. |

## Closing

Per-row dealer-change verdict: Q1 would need authenticated delegation intake
with target-bot addressing and grant scope; Q2 would need an offline-target
claim and wake trigger; Q3 would need per-target FIFO ordering; Q4 would need
caller-supplied idempotency keys; S1 would need authenticated-caller scoping;
S2 would need cursors plus long-poll or push; S3 would need grant-based read
authorization; N1 would need on-demand wake; N2 would need digest-bound launch
snapshots and remote targets; N3 would need a cross-machine observation channel
with artifact digests; N4 would need remote-stop propagation; N5 would need
runner authentication — and per the currently agreed plan, no dealer change is
needed for any row above and nothing is built.
