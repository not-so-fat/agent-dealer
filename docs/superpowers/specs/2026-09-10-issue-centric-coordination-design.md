# Design: issue-centric coordination (developer–reviewer) (NOT-57)

**Status:** draft for implementation
**Ticket:** [NOT-57](https://linear.app/not-so-fat/issue/NOT-57) — Design issue-centric coordination UI
**PRD:** `docs/PRD_ISSUE_COORDINATION.md`
**Date:** 2026-09-10

## Problem

`docs/PRD_ISSUE_COORDINATION.md` reframes agent-dealer around a durable **issue** that runs one hardcoded developer–reviewer workflow, instead of today's single-agent plan→execute→review `runs` model. NOT-57's title says "UI," but the PRD's dev/reviewer separation only means anything if two different coding-agent sessions actually run — so this ticket covers the full P0 slice: data model, coordinator, and UI. There is no external consumer of the current `runs` shape, so this replaces it rather than adding parallel tables.

## Scope decisions made during brainstorming

- **Replace, don't dual-write.** `runs`/`events`/`artifacts` are renamed/reshaped in place; `approval_gates` is dropped (dead table — today's gating is implicit in `run.status`, nothing reads/writes that table).
- **Plan/review (today's default) is retired as the default mode.** All issues run the developer–reviewer workflow from PRD §6.2. Plan-approval-before-execution is gone; humans engage only at the four PRD action types.
- **Real coordinator, not just UI.** Separate developer and reviewer worker sessions/worktrees, SHA-bound handoffs via `gh` CLI verification — this is "very basic" to the product per the PRD, not deferrable.
- **Human-action resolve is functional**, reusing the same underlying resolution path as today.
- **Intake folds into the Issues list** (a "New issue" / "Import from Linear" action) rather than keeping its own nav slot.

## Data model

### `issues` (replaces `runs`)

| Column | Notes |
|---|---|
| `id`, `source`, `external_id`, `external_label` | unchanged from `runs` (Linear link, idempotency key) |
| `title`, `description`, `repo`, `base_branch` | `base_branch` is new — needed to create the issue branch |
| `status` | new enum: `ready`, `developing`, `reviewing`, `repairing`, `final_review`, `needs_human`, `done`, `closed` (PRD §7.2) |
| `current_owner` | `human`\|`developer`\|`reviewer`\|`system` |
| `current_intent` | short text, e.g. "Developer updating PR #142" |
| `developer_agent_id`, `reviewer_agent_id` | FK to `agents` — the *selected profile* for each role, replaces single `agent_id`. `worker_sessions.agent_id` records which profile actually ran a given session (normally the same, but decoupled so a profile change mid-issue doesn't rewrite history). |
| `max_review_rounds` | default 3 |
| `current_round` | starts at 1 |
| `head_sha`, `pr_number`, `pr_url` | ground truth, written only from `gh pr view`, never from agent self-report |
| `created_at`, `updated_at` | unchanged |

Columns dropped from `runs` that no longer belong at issue level: `plan_model`/`execute_model` (session-level now), `approval_gates_json` (superseded by `human_actions`).

### `worker_sessions` (replaces `runs`' execution-record half)

One row per actual agent process. A repaired issue has 4+ rows (dev r1, reviewer r1, dev r2, reviewer r2, …).

| Column | Notes |
|---|---|
| `id`, `issue_id` | |
| `role` | `developer`\|`reviewer` |
| `round` | matches `issues.current_round` at spawn time |
| `agent_id`, `runtime`, `model`, `budget_json` | moved from `runs` |
| `worktree_path` | new — `git worktree add` path for this session |
| `status` | `queued`\|`running`\|`done`\|`failed`\|`timed_out` |
| `created_at`, `updated_at` | |

### `workflow_events` (replaces `events`)

`id`, `issue_id`, `worker_session_id` (nullable), `type`, `actor_type`, `actor_ref`, `payload_json`, `artifact_ref`, `causation_event_id`, `ts`.

`type` is normalized to the PRD §9.2 vocabulary: `issue.created`, `workflow.started`, `worker.started`, `worker.completed`, `worker.failed`, `pull_request.opened`, `pull_request.updated`, `checks.completed`, `review.submitted`, `repair.started`, `human_action.requested`, `human_action.resolved`, `final_review.requested`, `issue.completed`, `issue.closed`.

### `human_actions` (new)

`id`, `issue_id`, `action_type` (`product_scope_decision`\|`policy_escalation`\|`attempts_exhausted`\|`final_review` — exactly the PRD's four), `question`, `evidence_json`, `status` (`open`\|`resolved`), `resolution`, `resolved_by`, `requested_at`, `resolved_at`.

Resolving an action reuses the same code path today's result-review approval uses internally; only the shape exposed to the API/UI changes.

### `findings` (new)

`id`, `issue_id`, `fingerprint`, `severity`, `title`, `rationale`, `evidence_ref`, `file`, `line`, `status` (`open`\|`resolved`\|`recurring`\|`superseded`), `first_round`, `last_round`.

### `artifacts`

`run_id` → `issue_id` (required) + `worker_session_id` (nullable — null for issue-level artifacts like the task snapshot and final packet).

## Coordinator

State machine per issue, implemented as a new `packages/server/src/coordinator/` module (parallel to today's `queue/dispatcher.ts`, not a rewrite of it — the dispatcher's process-spawn/timeout/retry plumbing is reused, its run-status branching is not).

### Session lifecycle

1. **Prepare task snapshot** — freeze title/description/acceptance criteria/repo/base branch/workflow version onto the issue at start; store as an issue-level artifact.
2. **Developer session** — `git worktree add` a read-write worktree on the issue branch; spawn the developer agent (reused `spawnCli`/runner plumbing) with a new developer prompt (parallel to today's `buildExecutionPrompt`) instructing it to implement, run tests/Lens, and push + open/update a draft PR via its own `gh pr create`/`gh push` tool calls.
3. **Verify handoff** — after the session ends, the coordinator runs `gh pr view --json headRefOid,number,url` itself. This is the ground truth for `head_sha`/`pr_number`, not the agent's text claim. Emits `pull_request.opened`/`updated`.
4. **Reviewer session** — `git worktree add` a **separate** detached-HEAD worktree at the verified head SHA; spawn the reviewer agent with a new reviewer prompt instructing it to review the diff/evidence/prior findings and submit a real `gh pr review`, ending the review body with one fenced JSON block (verdict + findings) — same "structured output in a JSON fence" contract already used by plan-triage/reflect today.
5. **Verify review** — coordinator runs `gh pr view --json reviews` to read the actual submitted verdict, cross-checked against the parsed JSON fence. If the PR head changed since the reviewer started, the review is stale and cannot advance the issue (PRD §6.3).
6. **Route outcome**:
   - `approved` → create `final_review` human action.
   - `changes_requested`, rounds remain → increment round, start a new developer session (step 2) with the findings as context.
   - `changes_requested`, limit reached → create `attempts_exhausted` human action.
   - `escalated` → create `policy_escalation` (or `product_scope_decision`, if the reviewer's structured output names a missing product decision) human action. **v1 escalation rule** (PRD open decision #2): trust the reviewer's own `escalated` verdict — no separate deterministic detector.
7. **Final human review** — human resolves `final_review` as complete / another repair round / close. No merge is ever performed by agent-dealer.

### GitHub access

No new SDK dependency (no Octokit). Developer/reviewer agents call `gh` themselves inside their sandboxed worktree, using whatever ambient `gh auth` is already configured on the host — same trust model already used for Claude Code/Codex CLI auth. The coordinator's own verification reads (`gh pr view --json ...`, read-only, never a write) shell out to the same `gh` binary via a thin wrapper in `packages/server/src/adapters/github.ts` — a few functions, not a client library.

## API

New `packages/server/src/routes/issues.ts`:

- `GET /issues` — list (id, title, status, current_owner, current_intent, updated_at, human-action marker)
- `GET /issues/:id` — header + timeline (`workflow_events` joined with `artifacts`) + computed intent forecast + linked human actions + findings
- `POST /issues` — create/import (manual or Linear), idempotent on `(source, external_id)`
- `POST /issues/:id/guidance` — append human message to the timeline (PRD §7.4 composer)
- `GET /human-actions` — global queue (open actions across issues)
- `POST /human-actions/:id/resolve` — typed resolution

`/agents` endpoints are unchanged (already close to PRD §7.7's profile shape).

## Frontend

Nav becomes **Issues / Human actions / Agents** (Operations/Intake/Done removed).

- `IssuesListPage` — PRD §7.2 row shape; "New issue" action (manual or Linear import) replaces the standalone Intake page.
- `IssueDetailPage` — header (§7.3), timeline (§7.4) with composer, right-rail intent forecast (§7.5) driven by real coordinator state (current round, next allowed transition), evidence/trace expansion behind a disclosure rather than shown by default.
- `HumanActionsPage` — global queue (§7.6) with functional resolve, reusing existing resolve UI patterns from the current review drawer.
- `AgentsPage` — kept largely as-is; profile creation form aligned to §7.7's compact-field list only if trivial (not a required rewrite for this ticket).

## Testing

- Coordinator state machine: unit tests per transition (approved/changes_requested+rounds-left/changes_requested+limit/escalated), using a fake `gh` wrapper so no network/real GitHub calls are needed.
- Migration: script tested against a copy of the current dev DB, asserting row counts and status-vocabulary mapping match 1:1 before/after.
- API: existing route-test patterns extended to `/issues`, `/human-actions`.
- UI: no new automated UI tests required beyond what exists; manual walkthrough of the five-second-state test (PRD §12) before PR.

## Out of scope for this ticket

- Workflow templates / visual workflow builder.
- More than one active workflow per issue, or multiple repos/PRs per issue.
- Agent-profile form redesign beyond trivial label changes.
- MCP/CLI adapters for the new issue API (PRD §8 scenario B) — UI and coordinator first; adapters are additive later since they must not implement a second workflow engine.

## Open questions carried from the PRD (§15), not blocking this ticket

1. Issue pause: persistent workflow state vs. operator control interrupting only the active session — deferred, not needed for the first coordinator pass.
2. Final human rejection: consumes a review round or needs an explicit limit override — deferred; v1 treats a rejection as equivalent to "another repair round" if rounds remain, else `attempts_exhausted`.
3. Raw evidence retention policy — deferred; v1 retains everything indefinitely.
