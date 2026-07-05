# Agent profiles — workspace, treasure, and temporal scratch

How agent-dealer binds execution context to saved agents and separates durable artifacts from disposable filesystem scratch.

## Treasure vs temporal

**Treasure** lives in SQLite (`artifacts` table). This is the source of truth for UI and review:

| Kind | Role |
|------|------|
| `draft_plan` / `approved_plan` | Plan markdown |
| `document` | Content/research deliverable (markdown copied from scratch file) |
| `stream_trace` / `transcript` | Execution timeline |
| `execution_result` | Exit code, result text, blockers |

**Temporal** is disposable scratch under `~/.agent-dealer/.temporal/` (or `$AGENT_DEALER_HOME/.temporal/`):

| Path | Role |
|------|------|
| `output/{runId}.md` | Agent writes deliverable here during execute; server reads and stores `document` artifact |
| `logs/{runId}-{phase}-{timestamp}.ndjson` | Full CLI stream-json log (`blob_path` on artifacts) |

Deleting `~/.agent-dealer/.temporal/` is safe — treasure remains in the database. Re-running may recreate scratch files but review data is already persisted.

**Repo `.temporal/`** (gitignored in project repos) is for dev scripts and PoCs only — not used at runtime.

```
~/.agent-dealer/
  dealer.db          ← treasure (SQLite)
  .temporal/
    output/          ← runtime capture scratch
    logs/            ← runner NDJSON logs
```

## Agent fields

| Field | Required | Role |
|-------|----------|------|
| `workspaceRoot` | Yes (before kick) | CLI working directory — git repo for dev, vault folder for notes |
| `runtime` | Yes | `claude_code` or `cursor_local` |
| `deckId` / `playbookId` | No | Agent Deck binding |
| `name` | Yes | Display label |

Built-in Claude and Cursor agents ship with **no default workspace**. Configure workspace on the Agents page before kicking tasks.

## Task override

At Inbox, optional `repo` on a manual task overrides the agent's `workspaceRoot` for that run only. Linear promote uses agent workspace (no per-issue override).

## Resolution at kick

When a run is created:

```
runs.repo = task.repo ?? agent.workspaceRoot
```

The value is **snapshotted** on the run row — later agent edits do not change in-flight runs. Retry runs copy the parent `repo`.

If neither task nor agent provides a workspace, run creation fails with a clear error.

## CLI cwd vs temporal paths

| Concern | Path |
|---------|------|
| CLI `cwd` | `runs.repo` (agent workspace or task override) |
| Document scratch | `~/.agent-dealer/.temporal/output/{runId}.md` |
| Runner logs | `~/.agent-dealer/.temporal/logs/` |

The agent executes in the workspace; deliverable capture uses the centralized temporal dir (not repo-relative `.temporal/`).

## Permissions (headless automation)

Permissions are explicit tools and paths — not category presets like "Artifact writer".

**Claude plan phase** (read-only): `Read`, `Glob`, `Grep`, Agent Deck MCP tools.

**Claude execute phase**: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, Agent Deck MCP tools, plus `--add-dir` for the temporal output directory.

**Cursor**: `--trust` (already applied).

## User stories

### Dev agent (code tasks)

- **Workspace:** `/Users/me/projects/my-app` (git repo)
- **Runtime:** Claude Code with optional Agent Deck deck
- **Kick:** Linear issue or manual task → agent runs in repo cwd, edits source files there
- **Review:** Plan + diff-style results in Operations; treasure in SQLite

### Notes agent (content in vault)

- **Workspace:** `/Users/me/Obsidian/Main` (vault root)
- **Runtime:** Claude or Cursor
- **Kick:** Manual content task; agent reads context from vault
- **Deliverable:** Scratch written to `~/.agent-dealer/.temporal/output/{runId}.md`, captured as `document` artifact; final vault placement is P2 (`deliverable_template`)

### One-off path override

- **Agent workspace:** default dev repo
- **Task repo:** `/tmp/experiment` for a single kick
- **Result:** `runs.repo` = `/tmp/experiment`; agent cwd follows override

## Health checks

| Code | When |
|------|------|
| `workspace_missing` | No `workspaceRoot` configured, or path not found on disk |
| `cli_missing` | Claude/Cursor CLI not installed |
| `runtime_auth` | Cursor not logged in |
| `deck_offline` | Agent has deck but Agent Deck API unreachable |

## P2 (documented, not yet implemented)

- `write_roots_json` — additional explicit write paths for headless mode
- `deliverable_template` — e.g. `{vault}/{title}.md` for Obsidian
- Budget defaults on agent profile

See also: [DATA_MODEL.md](./DATA_MODEL.md) for artifact shapes. For Linear intake and agent routing on promote, see [LINEAR_INTEGRATION.md](./LINEAR_INTEGRATION.md).
