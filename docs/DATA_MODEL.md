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

### Linear sync (debug)

| Kind | `content_json` |
|------|----------------|
| `linear_sync` | `{ event, ok, at, state?, error? }` |

Non-blocking write-back attempts at plan approved / review / done. See `docs/LINEAR_INTEGRATION.md`.

## Phase flow

```
Intake (Feed): user picks agent + task → POST /api/runs
  → schedulePlanDraft (automatic, async)
Plan review: agent draft_plan appears → human edits / approves
  → plan_approved → dispatcher executes
Review → done
```

Human does **not** initiate planning — agent drafts on intake. `POST …/draft-plan` is **re-draft only**.

Two separate CLI processes (plan + execute). Context carryover via `approved_plan` + `task_snapshot` + optional `feedback` in prompt. Optional future: `--resume` using `agent_session.sessionId`.

## Runs table (intake linkage)

| Column | Role |
|--------|------|
| `source` | `manual` \| `linear` |
| `external_id` | Linear issue UUID (when `source=linear`) |
| `external_label` | Human id e.g. `ENG-123` — UI + prompts |
| `repo` | Snapshot at create: `task.repo ?? agent.workspace_root` |

## intake_settings table

Key/value JSON for Inbox config (not secrets). Keys: `linear.stateFilter`, `linear.teamId`, `linear.assigneeMe`, `linear.defaultAgentId`, `linear.syncEnabled`, `linear.routingRules`. `LINEAR_API_KEY` stays env-only.

## Agents table

| Column | Role |
|--------|------|
| `workspace_root` | CLI cwd default; required before kick (see `docs/AGENT_PROFILES.md`) |
| `runtime`, `deck_id`, `playbook_id` | Execution profile |

`runs.repo` is a **snapshot** at create time: `task.repo ?? agent.workspace_root`. Not re-read from agent on each phase.

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

See also: `docs/AGENT_PROFILES.md`, `docs/LINEAR_INTEGRATION.md`.
