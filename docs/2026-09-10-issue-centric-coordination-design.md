# Design: issue-centric coordination (developer–reviewer) (NOT-57)

**Status:** draft for implementation
**Ticket:** [NOT-57](https://linear.app/not-so-fat/issue/NOT-57) — Design issue-centric coordination UI
**PRD:** `docs/PRD_ISSUE_COORDINATION.md`
**Date:** 2026-09-10

> ## Scope revision — 2026-09-10
>
> This document was written to cover the full P0 slice (data model + coordinator + UI) in
> one change. That was split. **PR #3 / [NOT-58](https://linear.app/not-so-fat/issue/NOT-58)
> delivers the foundation only: the issue-centric data model, repositories, a read-model
> API/CLI, and a read-only management shell — with no autonomous agent execution.**
>
> The sections below describing runtime behaviour are the durable design for the child
> tickets and are **not implemented in PR #3**:
>
> | Design section | Lands in |
> |---|---|
> | Coordinator → Session lifecycle, Durable dispatch and recovery | [NOT-59](https://linear.app/not-so-fat/issue/NOT-59) kernel, [NOT-63](https://linear.app/not-so-fat/issue/NOT-63) repair/recovery |
> | Coordinator → Worktree lifecycle, Role permissions / profile snapshot / Agent Deck bind | [NOT-60](https://linear.app/not-so-fat/issue/NOT-60) |
> | Coordinator → developer session, handoff verification, evidence capture | [NOT-61](https://linear.app/not-so-fat/issue/NOT-61) |
> | Coordinator → reviewer session, exact-SHA verification, `github.ts` publication | [NOT-62](https://linear.app/not-so-fat/issue/NOT-62) |
> | Guidance semantics injection, human-action resolution, reflect trigger | [NOT-64](https://linear.app/not-so-fat/issue/NOT-64) |
> | Frontend intent-forecast rail, cost/timing/readiness, completed-execution UI | [NOT-65](https://linear.app/not-so-fat/issue/NOT-65) |
> | Migration and cutover | [NOT-66](https://linear.app/not-so-fat/issue/NOT-66) |
>
> In PR #3, `worker_sessions` / `workflow_instances` / `findings` / `usage_events` exist as
> schema + repositories with no runtime writer yet; `POST /api/issues/:id/start`, human-action
> resolution, the background coordinator loop, the `git`/`gh` adapters, and the migration
> script are **not present** and land with their child tickets, branched from `main` after
> this foundation merges.
>
> ### Accepted architecture for the child tickets (PR #3 review, load-bearing)
>
> The recurring bugs in the original one-PR implementation shared one cause: a single
> `session-lifecycle.ts` combining the state machine, persistence, process execution,
> Git/worktree management, GitHub verification, and recovery, so every external failure
> could leave DB state stranded mid-step. The child tickets adopt this narrower structure:
>
> 1. **One hardcoded, versioned `dev_reviewer_v1` state machine.** No generic workflow
>    editor / configurable graph topology. `workflow_instances.workflow_version` is only a
>    version tag; transition legality stays a pure function.
> 2. **Each coordinator command is a short DB transaction** recording the state transition,
>    the workflow event, and the next durable work item together.
> 3. **External effects run through a leased worker** (heartbeat + idempotency); its
>    structured completion is applied in a second transaction. SQLite plus a durable
>    work-item / outbox table is sufficient — no event sourcing, queue broker, or agent
>    identity system.
> 4. **Immutable execution-profile snapshot** (runtime/model/budget/permissions/deck/
>    playbooks/memory refs) stored on each `worker_session`. When the snapshot has a
>    `deckId`, the worker must `bind_workspace` to its session cwd first (equip). For
>    `claude_code` / `codex_local` the coordinator also mints execution authority and
>    verifies with `get_bound_deck` before spawn; `cursor_local` skips mint and uses
>    ambient MCP + that bind-first prompt. The `worker_sessions.profile_snapshot_json`
>    column is added by NOT-60 with the code that writes it, not pre-added here.
> 5. **PR + exact head/base SHA + structured result/artifact refs are the inter-agent
>    protocol.** Agents are temporary workers; the issue owns history.
> 6. **Human actions are typed pending commands** carrying their workflow instance, allowed
>    responses, evidence, and continuation preview — the `human_actions` schema already
>    matches this.
>
> Landing order: kernel (NOT-59) → execution environment (NOT-60) → developer→PR handoff
> (NOT-61) → reviewer→decision handoff (NOT-62) → repair/failure policy (NOT-63) →
> human-action contract (NOT-64) → evidence/measurement + product surfaces (NOT-65) →
> legacy cutover (NOT-66). Each child ticket carries one end-to-end acceptance test at its
> boundary and branches from the latest `main`.

## Problem

`docs/PRD_ISSUE_COORDINATION.md` reframes agent-dealer around a durable **issue** that runs one hardcoded developer–reviewer workflow, instead of today's single-agent plan→execute→review `runs` model. NOT-57's title says "UI," but the PRD's dev/reviewer separation only means anything if two different coding-agent sessions actually run — so this ticket covers the full P0 slice: data model, coordinator, and UI. No supported compatibility contract exists for the current run-shaped routes; the cutover can replace them after preserving their data.

## Scope decisions made during brainstorming

- **Replace at runtime, preserve during migration.** The new coordinator writes only the issue-centric tables; there is no runtime dual-write. Migration creates and backfills the new tables from legacy run lineages, verifies preservation, then keeps the old tables under `legacy_v0_*` names for one release rather than destructively reshaping them in place. `approval_gates` is retained with the legacy tables but has no new runtime writer.
- **Plan/review (today's default) is retired as the default mode.** All issues run the developer–reviewer workflow from PRD §6.2. Plan-approval-before-execution is gone; humans engage only at the four PRD action types.
- **Real coordinator, not just UI.** Separate developer and reviewer worker sessions/worktrees, SHA-bound handoffs via `gh` CLI verification — the developer/reviewer separation is core to the product (PRD §6.2); confirmed explicitly during scoping as not deferrable to a later ticket.
- **Human-action resolve is functional**, reusing the same underlying resolution path as today.
- **Intake folds into the Issues list** (a "New issue" / "Import from Linear" action) rather than keeping its own nav slot.
- **Coding-agent access is P0.** A thin CLI adapter calls the same HTTP API as the UI. A dedicated MCP adapter may follow later, but programmatic create/read/start/guidance/action resolution is not deferred.

## Data model

### `issues` (replaces `runs`)

| Column | Notes |
|---|---|
| `id`, `source`, `external_id`, `external_label`, `external_url` | Linear link and idempotency key; `external_url` is stored rather than reconstructed from provider-specific rules |
| `title`, `description`, `acceptance_criteria`, `repo`, `base_branch` | `base_branch` is new — needed to create the issue branch |
| `status` | new enum: `ready`, `developing`, `reviewing`, `repairing`, `final_review`, `needs_human`, `done`, `closed` (PRD §7.2) |
| `current_owner` | `human`\|`developer`\|`reviewer`\|`system` |
| `current_intent` | short text, e.g. "Developer updating PR #142" |
| `developer_agent_id`, `reviewer_agent_id` | FK to `agents` — the *selected profile* for each role, replaces single `agent_id`. `worker_sessions.agent_id` records which profile actually ran a given session (normally the same, but decoupled so a profile change mid-issue doesn't rewrite history). |
| `max_review_rounds` | default 3; also bounds failed developer handoff attempts so unattended execution cannot retry forever |
| `current_round` | starts at 1; advances whenever the coordinator starts another developer attempt, whether or not the prior attempt reached review |
| `branch`, `base_sha`, `head_sha`, `pr_number`, `pr_url` | handoff ground truth, verified by the coordinator from Git/GitHub rather than agent self-report |
| `created_at`, `updated_at` | unchanged |

`status`, `current_owner`, and `current_intent` are denormalized projections updated in the same transaction as the causal `workflow_event`; events remain the audit source of truth.

Columns dropped from `runs` that no longer belong at issue level: `plan_model`/`execute_model` (session-level now), `approval_gates_json` (superseded by `human_actions`).

### `agents` (reusable profiles, not durable workers)

Retain the existing profile identity, workspace, runtime, Agent Deck, and built-in fields. Replace the plan/execute-specific defaults with role-neutral `default_model` and `default_budget_json`, and add `purpose`, `playbook_ids_json`, `external_memory_refs_json`, and `permission_policy_json`. Existing profiles backfill role-neutral defaults from `default_execute_*` first and `default_plan_*` second; the old columns remain legacy-readable for the same one-release window as the run tables.

> **Not in PR #3.** These role-neutral profile columns land in [NOT-60](https://linear.app/not-so-fat/issue/NOT-60) alongside the `CreateAgentInput`/`UpdateAgentInput` fields, repository INSERT/UPDATE, agent-form UI, and the resolve/snapshot code that consumes them — so the foundation carries no read-only-always-null profile fields.

Each `worker_session` snapshots the resolved runtime/model/budget and effective permissions so later profile edits do not rewrite history. Conclusions, transcripts, findings, and usage remain owned by the issue/session; completing work never writes learned identity or conversation memory back into the profile.

### `worker_sessions` (replaces `runs`' execution-record half)

One row per actual agent process. A repaired issue has 4+ rows (dev r1, reviewer r1, dev r2, reviewer r2, …).

| Column | Notes |
|---|---|
| `id`, `issue_id` | |
| `role` | `developer`\|`reviewer`\|`legacy` (`legacy` is migration-only and never spawned by the new coordinator) |
| `round` | matches `issues.current_round` at spawn time |
| `agent_id`, `runtime`, `model`, `budget_json` | moved from `runs` |
| `worktree_path`, `input_sha` | actual checkout path and immutable SHA supplied to the session (`input_sha` is required for reviewer sessions) |
| `status` | `queued`\|`running`\|`done`\|`failed`\|`timed_out`\|`cancelled` |
| `session_ref`, `log_path`, `exit_code`, `error_json`, `metadata_json` | runtime-native session id, raw evidence pointer, terminal evidence, and migration/provider metadata |
| `created_at`, `started_at`, `heartbeat_at`, `completed_at`, `updated_at` | durable lifecycle and recovery signals |

### `workflow_instances` (new)

One row per execution of one immutable workflow version (PRD §9.1). This ticket has exactly one runnable workflow (`dev_reviewer_v1`), but an issue can accumulate completed instances over time (including imported `legacy_v0` history); the partial index below still permits only one active instance.

| Column | Notes |
|---|---|
| `id`, `issue_id` | |
| `workflow_version` | hardcoded string, e.g. `dev_reviewer_v1` |
| `started_at`, `completed_at` | |
| `outcome` | `done`\|`closed`\|`migrated`\|null while running; `migrated` is used only for the completed legacy audit instance described below |

A partial unique index on `issue_id WHERE completed_at IS NULL` enforces at most one active workflow instance per issue. Starting a workflow and creating its first queued session happen in one transaction.

### `workflow_events` (replaces `events`)

`id`, `issue_id`, `workflow_instance_id` (nullable only for issue creation/guidance outside an execution), `worker_session_id` (nullable), `type`, `actor_type`, `actor_ref`, `stage` (issue status at emit time), `round`, `payload_json`, `artifact_ref`, `idempotency_key` (provider-native key when available, e.g. a GitHub delivery id — nullable), `causation_event_id`, `ts`. Covers every field PRD §9.2 requires per event while allowing issue-level conversation before a workflow starts.

`type` is normalized to the PRD §9.2 vocabulary: `issue.created`, `workflow.started`, `worker.started`, `worker.completed`, `worker.failed`, `pull_request.opened`, `pull_request.updated`, `checks.completed`, `review.submitted`, `repair.started`, `guidance.added`, `human_action.requested`, `human_action.resolved`, `final_review.requested`, `issue.completed`, `issue.closed`. `guidance.added` supplies the human-message rows required by the issue timeline; its payload stores markdown and author metadata.

### `human_actions` (new)

`id`, `issue_id`, `workflow_instance_id` (nullable for pre-start product decisions and imported legacy actions), `action_type` (`product_scope_decision`\|`policy_escalation`\|`attempts_exhausted`\|`final_review` — exactly the PRD's four), `reason`, `question`, `evidence_json`, `response_options_json`, `continuation_preview_json`, `status` (`open`\|`resolved`), `resolution_json`, `resolved_by`, `requested_at`, `resolved_at`.

Resolution is validated against the action type's stored response options, then the action resolution and next workflow transition are committed atomically. This may reuse today's result-review transition primitives, but not its run-shaped route or payload.

### `findings` (new)

`id`, `issue_id`, `fingerprint`, `severity`, `title`, `rationale`, `evidence_ref`, `file`, `line`, `status` (`open`\|`resolved`\|`recurring`\|`superseded`), `first_round`, `last_round`.

### `artifacts`

`run_id` → `issue_id` (required) + `worker_session_id` (nullable — null for issue-level artifacts like the task snapshot and final packet).

### `usage_events` (new)

Duration/token/cost evidence by role and runtime (PRD §9.1, required for §10's per-issue rollups). Replaces today's `artifacts.kind='usage'` + `lineage_id` aggregation (`buildLineageUsageSummary`), which has no equivalent under the round-based model — there is no `lineage_id` chain anymore, just `worker_sessions` per issue.

| Column | Notes |
|---|---|
| `id`, `issue_id`, `worker_session_id` | |
| `role`, `runtime` | denormalized from the session for cheap per-issue rollup queries |
| `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms` | |
| `ts` | |

Per-issue session duration and cost are computed from `usage_events`. Total issue duration is wall-clock time from workflow start to completion (or now while active), not a sum of possibly overlapping sessions. Stage duration is reconstructed from transition-event timestamps; review-round count is the number of non-stale reviewer verdicts; and “final review without intervention” is false when any non-final human action was requested. Human wait is the union of intervals in which at least one human action was open, avoiding double-counting overlapping actions. No separate rollup table is needed for v1.

## Coordinator

State machine per issue, implemented as a new `packages/server/src/coordinator/` module (parallel to today's `queue/dispatcher.ts`, not a rewrite of it). Reuse is narrower than it looks at first glance: the low-level `spawnCli` (process spawn/timeout/kill, `runners/spawn-cli.ts`) is generic and reusable as-is, but `runClaude`/`runCursor`/`runCodex` in `runners/claude.ts` are hardcoded to the `Run` shape and a closed `plan|execute|reflect|qa` mode union — they do not accept a `developer|reviewer` mode. This design requires new per-runtime spawn wrappers (one pair per runtime × role, or a refactored mode union covering both) as real implementation work, not a drop-in reuse. The dispatcher's run-status branching is not reused at all.

### Session lifecycle

1. **Prepare task snapshot** — validate title/problem statement, acceptance criteria or a policy-accepted task snapshot, repository, both role profiles, and branch/PR permission. If required product intent cannot be normalized without guessing, create `product_scope_decision` instead of spawning. Otherwise freeze title/description/acceptance criteria/source links/repo/base branch/workflow version and store the immutable issue-level snapshot.
2. **Developer session**
   - Create a read-write worktree on the issue branch at `<issue.repo>/.agent-dealer-worktrees/<sessionId>-developer` (not under `$AGENT_DEALER_HOME`), so an `agent-deck use` grant on that repo covers the cwd.
   - If the profile has a `deckId`, the worker prompt's first instruction is to equip the agent: `bind_workspace({ deckId, workspaceRoot: worktree_path })`. Without that call the session is not the configured agent. Deck/Linear failure must not be narrated as missing acceptance criteria when Task/AC are already in the prompt.
   - For `claude_code` / `codex_local`, the coordinator also mints a short-lived execution authority and verifies with `get_bound_deck` before spawn (isolated MCP transport). `cursor_local` skips mint and relies on ambient MCP + the bind-first prompt.
   - Spawn the developer to implement, run tests/Lens, push with `git`, open/update a draft PR with `gh pr create`, and end with a short structured **implementation conclusion** (what changed, why, deviations from acceptance criteria, known follow-ups — distinct from the PR description) per PRD §6.2 step 3 / open decision #4. Store that conclusion as a worker-session artifact and thread it into the next review round and final review packet; producing it every developer session is required even though the exact minimal fields remain open decision #4.
3. **Verify handoff** — after the session ends, the coordinator runs `gh pr view --json baseRefName,headRefName,headRefOid,number,url`, resolves `base_sha` with `git merge-base` against the fetched base ref, and checks `git status --porcelain` in the developer worktree. These values are the ground truth for the branch, SHAs, and PR identity—not the agent's text claim. It emits `pull_request.opened`/`updated` only for a clean handoff. If the developer session failed/timed out or no PR exists, the attempt consumes the current round but no reviewer verdict is counted; the coordinator starts the next developer round when the configured limit remains, otherwise it creates `attempts_exhausted`. A dirty worktree is preserved and creates `policy_escalation`, as does a failure identified as infrastructure or policy-related; neither consumes a review round.
4. **Reviewer session**
   - Create a **separate** detached-HEAD worktree at the verified head SHA under `<issue.repo>/.agent-dealer-worktrees/<sessionId>-reviewer`.
   - Same deck equip rule as the developer when the reviewer profile has a `deckId` (worker `bind_workspace` first; mint/`get_bound_deck` only for `claude_code` / `codex_local`).
   - The reviewer receives read-only repository tools and examines the immutable snapshot, base/head SHAs, diff, acceptance criteria, test/Lens evidence, implementation conclusion, and prior findings. It returns a schema-validated result containing the PRD §6.4 fields: `verdict`, base and head SHA, acceptance-criteria assessment, test/Lens assessment, blocking findings, non-blocking observations, and risks/uncertainties. The reviewer cannot change files, push, alter workflow state, or publish to GitHub.
5. **Publish and verify review** — after the reviewer returns, the coordinator re-reads `headRefOid`, `number`, and `url`. If the head differs from `input_sha`, it stores the stale output as evidence and starts a fresh reviewer session at the new head without consuming a review round. If unchanged, the coordinator renders the validated result to a temporary body file and publishes it through `packages/server/src/adapters/github.ts`, records the returned external reference, and emits `review.submitted`. If GitHub rejects `APPROVE` or `REQUEST_CHANGES` because the configured identity authored the PR, the adapter publishes the same normalized result as a comment review; the validated internal verdict remains the workflow authority. Publication or reviewer infrastructure failure routes to `policy_escalation` rather than being confused with a code finding.
6. **Route outcome**:
   - `approved` → create `final_review` human action.
   - `changes_requested`, rounds remain → increment round, start a new developer session (step 2) with the findings as context.
   - `changes_requested`, limit reached → create `attempts_exhausted` human action.
   - `escalated` → create `policy_escalation` (or `product_scope_decision`, if the reviewer's structured output names a missing product decision) human action. **v1 escalation rule** (PRD open decision #2): trust the reviewer's own `escalated` verdict — no separate deterministic detector.
7. **Final human review** — human resolves `final_review` as complete / another repair round / close. No merge is ever performed by agent-dealer. Resolving it as complete triggers `runReflect` once for the workflow instance, using the developer's deck/playbook and the final implementation conclusion + review history as input — the closest analog to today's "approve" trigger. Automatic per-round repairs, `attempts_exhausted`, and `policy_escalation` outcomes do not trigger reflect; there is no automatic-retry-shaped trigger left once plan/review is retired.

### Role permissions and GitHub access

- **Developer:** read/write its worktree, run configured validation, push its issue branch, and create/update the draft PR. It cannot resolve human actions, edit the workflow graph, or merge.
- **Reviewer:** read-only repository and evidence access. It produces a structured review result but has no GitHub-write or workflow-transition tools.
- **Coordinator:** owns state transitions, re-validates PR identity/SHA, and is the only component that publishes the review result or requests human action. It never merges.

No new SDK dependency (no Octokit). Developer sessions and the coordinator use ambient `gh auth` already configured on the host. A thin `packages/server/src/adapters/github.ts` wrapper owns both verification reads and coordinator review publication. Review bodies are passed with `--body-file`, not shell interpolation. This keeps agent output out of command construction and gives all GitHub effects a single auditable boundary.

### Worktree lifecycle and concurrency

- Role worktrees live under **`<issue.repo>/.agent-dealer-worktrees/`** (gitignored), not under `$AGENT_DEALER_HOME/worktrees`. That keeps the worker cwd inside the operator's typical `agent-deck use` grant so `bind_workspace` to the session path can succeed.
- A developer worktree is removed only after its handoff is verified and `git status --porcelain` is clean; a dirty handoff is preserved and blocks review through `policy_escalation`. A reviewer worktree is removed after its evidence is stored and its checkout is clean. Worktrees are not normally kept across rounds.
- When a profile carries a `deckId`, the worker must **`bind_workspace` that deck to its session cwd first** before other Deck/Linear use — that equip step is what makes the session the agent the operator defined. There is no "already scoped / do not bind" worker-facing shortcut. Deck/scope failure must not be treated as missing acceptance criteria when Task/AC are already in the prompt. (Coordinator mint/`get_bound_deck` for `claude_code` / `codex_local` is transport isolation, not a substitute for that worker equip instruction.)
- `git worktree add`/`remove` for one repo is serialized behind a per-repo lock (extending the existing global spawn-slot pattern in `process-registry.ts` with a repo-keyed mutex), so two sessions on the same repo never race the same `.git` metadata.
- Crash recovery inspects a leftover worktree before acting. A missing path can be pruned and a clean reviewer checkout can be removed. A dirty or unpushed developer worktree is preserved and surfaced as a `policy_escalation` with its path and recovery commands. The coordinator never force-removes potentially valuable work.

### Durable dispatch and recovery

- A dispatcher claims a queued `worker_session` with a compare-and-set update (`queued` → `running`) before spawning, so concurrent dispatchers cannot run it twice.
- On startup, the coordinator reconciles `running` sessions whose heartbeat is stale or whose process is absent. It records terminal evidence and routes through the same failure policy as an observed process exit; it does not merely rewrite the issue status.
- Each completed worker result is committed transactionally with its causal `workflow_event`, issue projection update, and exactly one next effect: another queued session, a human action, or workflow completion.
- Provider references and transition-specific idempotency keys prevent duplicate PR/review events and duplicate next sessions when a callback, poll, or restart is retried.

### Guidance semantics

Guidance is appended immediately as an immutable `guidance.added` event, but v1 does not inject text into an already-running one-shot CLI process. The coordinator includes all guidance added since the previous session snapshot in the next developer/reviewer input and the UI labels it “applies to next worker” while a session is active. Guidance never mutates the frozen acceptance criteria, limits, or workflow topology; if following it would require such a change, the worker returns an escalation and the coordinator creates `product_scope_decision`.

## API

New `packages/server/src/routes/issues.ts`:

- `GET /api/issues` — list (id, title, status, current_owner, current_intent, updated_at, human-action marker)
- `GET /api/issues/:id` — header + timeline (`workflow_events` joined with artifact references) + computed intent forecast + linked human actions + findings + usage summary
- `GET /api/issues/:id/evidence` — paginated worker sessions, artifacts, usage events, and raw transcript/provider references for the evidence disclosure and programmatic inspection
- `POST /api/issues` — create/import (manual or Linear), idempotent on `(source, external_id)`
- `POST /api/issues/:id/start` — start the issue's one workflow; idempotently returns its active instance when already running and rejects a terminal issue unless an explicit restart policy is added later
- `POST /api/issues/:id/guidance` — append human guidance to the timeline (PRD §7.4 composer)
- `GET /api/human-actions` — global queue (open actions across issues)
- `POST /api/human-actions/:id/resolve` — typed resolution

Existing `/api/agents` routes are extended additively for the role-neutral profile fields above; they do not expose session history as agent memory. All mutating routes accept an idempotency key; server validation and the coordinator, not the caller, determine allowed transitions.

## Coding-agent CLI

P0 ships a thin `agent-dealer` CLI over the HTTP API so Codex, Claude Code, Cursor, and shell automation receive the same state and controls as the UI:

- `agent-dealer issue create|import|show|start|guide`
- `agent-dealer action list|resolve`

Commands print structured JSON by default, accept idempotency keys for mutations, and contain no workflow logic. `issue show --include evidence` follows the paginated evidence endpoint. A dedicated MCP adapter can later wrap the same API without changing coordinator semantics.

## Frontend

Nav becomes **Issues / Human actions / Agents** (Operations/Intake/Done removed).

- `IssuesListPage` — PRD §7.2 row shape; "New issue" action (manual or Linear import) replaces the standalone Intake page.
- `IssueDetailPage` — header (§7.3), timeline (§7.4) with composer, right-rail intent forecast (§7.5) driven by real coordinator state (current round, next allowed transition), evidence/trace expansion behind a disclosure rather than shown by default.
- `HumanActionsPage` — global queue (§7.6) with functional resolve, reusing existing resolve UI patterns from the current review drawer.
- `AgentsPage` — kept largely as-is; profile creation form aligned to §7.7's compact-field list only if trivial (not a required rewrite for this ticket).

## Migration and cutover

Migration is an explicit cutover, not an in-place reinterpretation of `runs` and not a permanent dual-write:

1. Stop the service and copy the SQLite database file as a rollback backup. The migration refuses to run while a registered process is active.
2. In one transaction, add/backfill the role-neutral agent-profile columns, create the issue-centric tables, and backfill them. Group legacy runs by `COALESCE(lineage_id, id)` so one historical issue lineage becomes one issue; do **not** create one issue per run.
3. Create one completed `workflow_instance.workflow_version='legacy_v0'` with `outcome='migrated'` per lineage and a migration-only `worker_sessions.role='legacy'` row for every legacy run. Preserve the original run status/lineage identifiers in `metadata_json`. Legacy session status follows the same bucket each lineage lands in under step 4, so a `ready` issue with no active workflow never carries a legacy session marked `done`: `done`/`review` (an agent produced output) → session `done`; `failed` → session `failed`; `cancelled`, `queued`, `plan_pending`, `plan_approved`, and `running` (nothing survives as a completed attempt under the new model) → session `cancelled`. Repoint copied artifacts and events to the grouped issue, completed legacy instance, and corresponding legacy session, preserving their original timestamps and payloads.
4. Map each lineage from its latest run: `done` → `done`; `cancelled` → `closed`; `review` → `final_review` plus an open `final_review` action; `failed` → `needs_human` plus an open `attempts_exhausted` action; `queued`, `plan_pending`, `plan_approved`, and `running` → `ready` with no active workflow. The required service stop prevents an active child process from being orphaned by the final mapping.
5. Verify one new issue per distinct lineage key, one legacy worker session per old run, preservation of every artifact/event, valid foreign keys, and expected status/action counts. Any mismatch rolls back.
6. Rename the old tables to `legacy_v0_*`, commit, and restart with only the new runtime writers enabled. Keep the backup and legacy tables for one release; removal is a separate migration after production verification.

The migration creates no synthetic **active** `workflow_instance` for historical work: `legacy_v0` exists only to retain the event audit contract. A user may explicitly start a migrated `ready` issue under `dev_reviewer_v1`; terminal and human-review histories remain inspectable without pretending they ran the new workflow. Imported open actions are resolved as legacy terminal decisions or followed by an explicit new workflow start—they never reactivate `legacy_v0`.

## Testing

- Coordinator state machine: unit tests per transition, using fake GitHub/Git wrappers so no network/real GitHub calls are needed. Covers both the PRD's four review outcomes (approved / changes_requested+rounds-left / changes_requested+limit / escalated) and the failure-mode routing this design adds: developer session failed/timed-out or no PR found → consumes the round without counting a reviewer verdict, then retries or exhausts; dirty handoff or dirty/unpushed developer worktree after a crash → preserved and escalated, never reviewed or force-removed; reviewer session failed/timed-out, deck binding failed, review publication failed, or worktree checkout failed → `policy_escalation`; stale review (head changed mid-review) → evidence retained and retried without consuming a round; same-identity GitHub review restriction → comment-review fallback.
- Coordinator recovery: compare-and-set claims, stale-heartbeat reconciliation, idempotent repeated callbacks/restarts, and transactional creation of exactly one next session/action.
- Role enforcement: reviewer wrappers expose read-only repository tools and no GitHub-write transition; when a profile has a `deckId`, workers are instructed to `bind_workspace` to their session cwd first, and `claude_code` / `codex_local` additionally mint/verify authority before spawn (`cursor_local` uses ambient MCP + that prompt).
- Migration: script tested against a copy of the current dev DB, asserting one issue per distinct lineage, one legacy session per old run, full artifact/event preservation, foreign-key integrity, and the documented status/action mapping.
- API and CLI: existing route-test patterns extended to `/api/issues`, evidence pagination, and `/api/human-actions`; CLI contract tests assert commands are thin HTTP clients and receive the same validation/errors as UI requests. Guidance tests prove active-session messages are labeled/deferred to the next worker and cannot change frozen fields.
- UI: no new automated UI tests required beyond what exists; manual walkthrough of the five-second-state test (PRD §12) before PR.

## Out of scope for this ticket

- Workflow templates / visual workflow builder.
- More than one active workflow per issue, or multiple repos/PRs per issue.
- Agent-profile form redesign beyond trivial label changes.
- Dedicated MCP adapter for the new issue API. The thin CLI required by PRD §8 scenario B ships in this ticket; later adapters must remain clients of the same API rather than implement a second workflow engine.
- Linear status/comment sync-back (today's `syncLinearForRun`). Imported issues stay a one-way import from Linear for this ticket; sync-back on issue transitions is a follow-up, notwithstanding PRD §2.1's framing of Linear as a synchronization target.

## Open questions carried from the PRD (§15), not blocking this ticket

1. Issue pause: persistent workflow state vs. operator control interrupting only the active session — deferred, not needed for the first coordinator pass.
2. Final human rejection: consumes a review round or needs an explicit limit override — deferred; v1 treats a rejection as equivalent to "another repair round" if rounds remain, else `attempts_exhausted`.
3. Raw evidence retention policy — deferred; v1 retains everything indefinitely.
4. Exact structured shape of the developer's implementation conclusion (PRD open decision #4) — this design fixes the *mechanism* (produced every developer session, see Coordinator step 2), but the precise minimal field set is deferred to implementation.
5. Intent forecast depth (PRD open decision #5): one next action vs. the next two conditional actions — deferred; v1's `IssueDetailPage` intent-forecast rail (§7.5) shows only the single next allowed transition. Showing two conditional actions is a frontend-only change to make later if the single-action forecast proves insufficient in practice.
