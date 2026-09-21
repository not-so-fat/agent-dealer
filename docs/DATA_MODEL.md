# agent-dealer data model — run artifacts

How plan, reasoning, results, and deliverables are stored per run.

## Storage pattern

Each run has many **artifacts** (`artifacts` table):

| Column | Role |
|--------|------|
| `kind` | Typed category (see below) |
| `content_json` | Structured payload for UI + queries |
| `blob_path` | Optional filesystem path to full NDJSON log |
| `author` | `human` \| `agent` \| `system` |

No schema migration needed for new kinds — extend `ArtifactKind` in `packages/shared`.

## Artifact kinds (v0)

### Task intake

| Kind | `content_json` | Notes |
|------|----------------|-------|
| `task_snapshot` | `{ id, title, description, agent? }` | Created with run |
| `acceptance_criteria` | `{ markdown }` | Optional human criteria |

### Plan phase

| Kind | `content_json` | `blob_path` |
|------|----------------|-------------|
| `draft_plan` | `{ markdown, sessionId? }` | Plan NDJSON log |
| `approved_plan` | `{ markdown }` | — |

### Agent execution (per phase: `plan` \| `execute`)

| Kind | `content_json` | `blob_path` |
|------|----------------|-------------|
| `stream_trace` | `{ phase, runtime, entries[] }` | Full NDJSON |
| `usage` | `{ phase, runtime, totalCostUsd?, inputTokens?, … }` | — |
| `agent_session` | `{ phase, runtime, sessionId }` | — |
| `execution_result` | `{ phase, exitCode, resultText?, isError? }` | — |
| `transcript` | `{ phase, exitCode, excerpt, resultText? }` | Full NDJSON (legacy compat) |

**`stream_trace.entries[]`:**

```typescript
{ type: "system" | "thinking" | "assistant" | "tool" | "rate_limit" | "result", text: string, toolName?: string }
```

Compact timeline for UI — full detail remains in NDJSON at `blob_path`.

### Deliverables

| Kind | `content_json` | When |
|------|----------------|------|
| `document` | `{ path, title, markdown }` | Content/research tasks — agent writes `~/.agent-dealer/.temporal/output/{runId}.md`; server captures into SQLite |
| `deliverable` | (future) | Generic wrapper |
| `diff`, `pr`, … | (future) | Code tasks |

### Human loop

| Kind | `content_json` |
|------|----------------|
| `feedback` | `{ markdown }` or `{ error, exitCode? }` |

Injected into execute prompt via `buildExecutionPrompt()`. Copied to retry runs.

| `playbook_patch` | `{ playbookId, previousBody, proposedBody, rationale, status, trigger }` — post-run reflect proposal |
| `reflect_status` | `{ status: pending \| completed \| failed \| skipped, trigger, error? }` |

### Linear sync (debug)

| Kind | `content_json` |
|------|----------------|
| `linear_sync` | `{ event, ok, at, state?, error? }` — events: `planning_started`, `plan_approved`, `review`, `retry`, `done` |

Non-blocking write-back attempts at plan approved / review / done. See `docs/LINEAR_INTEGRATION.md`.

## Phase flow

```
Intake (Feed): user picks agent + task → POST /api/runs
  → schedulePlanDraft (automatic, async)
Plan review: agent draft_plan appears → human edits / approves
  → plan_approved → dispatcher executes
Review → done

Retry from review/failed: `POST …/retry` creates a new `plan_approved` run (copies `approved_plan`, same `lineage_id` / `external_id`) and **cancels** the superseded run so it leaves Operations. Dispatcher picks up execution immediately.
```

Human does **not** initiate planning — agent drafts on intake. `POST …/draft-plan` is **re-draft only**.

Two separate CLI processes (plan + execute). Context carryover via `approved_plan` + `task_snapshot` + optional `feedback` in prompt. Optional future: `--resume` using `agent_session.sessionId`.

## Runs table (intake linkage)

| Column | Role |
|--------|------|
| `source` | `manual` \| `linear` |
| `external_id` | Linear issue UUID (when `source=linear`) |
| `external_label` | Human id e.g. `ENG-123` — UI + prompts |
| `repo` | Snapshot at create from the task/issue input (agent workspace is no longer used) |

## intake_settings table

Key/value JSON for Inbox config (not secrets). Keys: `linear.stateFilter`, `linear.teamId`, `linear.assigneeMe`, `linear.defaultAgentId`, `linear.syncEnabled`, `linear.routingRules`. `LINEAR_API_KEY` stays env-only.

## Agents table

| Column | Role |
|--------|------|
| `deck_id` | Required Agent Deck for execution (NOT-149) |
| `runtime`, `default_model`, `default_effort`, `default_budget_json` | Operating profile |
| `workspace_root`, `playbook_id`, `playbook_ids_json`, `external_memory_refs_json` | Dead legacy storage only — not shown in UI, not copied into new snapshots, not inspected by health |

## Issues table

| Column | Role |
|--------|------|
| `repo` | Portable GitHub identity `github.com/owner/repo` for new issues; legacy rows may still hold a local path until migrated |
| `base_branch` | Seed at create; for managed GitHub clones, overwritten from the remote default at first checkout so it matches PR/worktree base |

Worker session checkouts are under `$AGENT_DEALER_HOME/execution/` (or `AGENT_DEALER_EXECUTION_ROOT`); the concrete path is persisted on `worker_sessions.worktree_path`.

## Content task convention

For `taskCategory: content` or `research`, execute prompt includes:

```
Write deliverable to: ~/.agent-dealer/.temporal/output/{runId}.md
```

After execute, server reads that file and stores `document` artifact. The file is temporal scratch; treasure is the artifact row.

## Query helpers (UI)

- Latest artifact by kind: `latestArtifact(artifacts, kind)`
- Latest by phase: `latestByPhase(artifacts, kind, "plan" | "execute")`
- Raw log: `GET /api/runs/:id/log-tail?kind=stream_trace`

## Execution analysis

Phase boundaries, overlap/aggregation rules, evidence quality, silence and failure vocabularies, and the source matrix for execution-time metrics are defined in [EXECUTION_ANALYSIS.md](EXECUTION_ANALYSIS.md). That contract is authoritative; this document does not restate it.

### `session_activity_events` (NOT-170)

Append-only structured activity evidence backing observational silence analysis. One row
per new structured stream event observed by the live activity sampler — never one row
per sampler tick. Columns: `issue_id`, `worker_session_id`, `observed_at` (sampler read
time), `source_cursor` / `source_offset` (log line index / exclusive end byte offset),
`activity_kind` (`assistant_output` \| `provider_wait` \| `tool_started` \|
`tool_completed` \| `unknown_activity`), `state` (`started` \| `completed` \|
`observed`), `call_id` (pairs starts with completions across runtimes), `summary`
(the existing ≤120-char operator line), `raw_evidence` (a `<log_path>#offset=<n>`
pointer, never payload).

- Index: `(worker_session_id, observed_at)`; idempotency:
  `UNIQUE(worker_session_id, source_offset)` — sampler re-reads and restarts resume
  from `MAX(source_offset)` and re-inserts are no-ops.
- Retention/size: rows are small by construction (no transcript bodies, file contents,
  or tool arguments are copied into SQLite); volume is roughly one row per tool call /
  assistant turn / retry signal. Retention follows the session log. Rows are
  observational only and are never inputs to admission, leases, recovery, routing,
  retry, termination, or scheduling.
- Timing caveat: `observed_at` is approximate (shared per tick; backlog stamped at
  restart time), so silence derived from these rows is always quality `inferred`
  (reason `sampler_observed_time`), even inside `exact` agent-process bounds. Read
  model: `getSessionSilenceIntervals()` in
  `packages/server/src/repository/session-activity.ts` (silence categories per
  [EXECUTION_ANALYSIS.md](EXECUTION_ANALYSIS.md) §5).

See also: `docs/AGENT_PROFILES.md`, `docs/LINEAR_INTEGRATION.md`.
