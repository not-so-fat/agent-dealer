# Agent profiles — operating configuration and temporal scratch

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
  execution/         ← managed clones + worktrees (NOT-149; override with AGENT_DEALER_EXECUTION_ROOT)
    repos/github.com/<owner>/<repo>
    worktrees/github.com/<owner>/<repo>/<sessionId>-{developer|reviewer}
  .temporal/
    output/          ← runtime capture scratch
    logs/            ← runner NDJSON logs
```

Issue-coordinator role worktrees are generated under the managed execution root (NOT-149). Deck authority is launch-selected from the profile's fixed Deck header — workers do not need a repository-local `.agent-deck/use.json`. `bind_workspace` still receives the generated worktree cwd as session context.

## Agent fields

| Field | Required | Role |
|-------|----------|------|
| `runtime` | Yes | `claude_code`, `cursor_local`, or `codex_local` |
| `deckId` | Yes (before kick) | Exactly one Agent Deck — workers never start without one |
| `name` | Yes | Display label |
| `defaultModel` / `defaultEffort` / `defaultBudget` | No | Session defaults (snapshotted) |
| `permissionPolicy` | No | Tighten-only capability overrides |

**Not agent concepts (NOT-149):** workspace root, selected playbooks, or free-form external-memory refs. Playbooks are chosen dynamically inside the pinned Deck. The GitHub repository lives on the **Issue**, not the Agent.

Built-in Claude, Cursor, and Codex agents ship with **no default Deck**. Configure a Deck on the Agents page before kicking tasks.

## Issue repository

At Issues create, the operator supplies a **GitHub repository URL** or `owner/repo` shorthand. Dealer stores the canonical identity `github.com/<owner>/<repo>`, clones/fetches under the execution root, and starts new workflows from the freshly fetched remote default branch. That resolved base is written back onto `issues.base_branch` (and the frozen task snapshot) so prompts, PR identity checks, and the Issues UI stay aligned. The create form's Base branch field is a seed/fallback for display and legacy local-path issues — managed clones overwrite it from `origin/HEAD` at first checkout.

Legacy issue rows that still hold a local filesystem path remain recoverable when that path still exists — Dealer will not guess a remote when `origin` cannot be resolved.

## Profile snapshot

When a worker session is created, the profile is frozen into `worker_sessions.profile_snapshot_json` without workspace, playbook lists, or external-memory refs. A later agent edit does not change in-flight sessions.

## CLI cwd vs temporal paths

| Concern | Path |
|---------|------|
| CLI `cwd` | Managed worktree under `execution/worktrees/...` (persisted on `worker_sessions.worktree_path`) |
| Document scratch | `~/.agent-dealer/.temporal/output/{runId}.md` |
| Runner logs | `~/.agent-dealer/.temporal/logs/` |

## Permissions (headless automation)

Permissions are explicit tools and paths — not category presets like "Artifact writer".

**Claude plan phase** (read-only): `Read`, `Glob`, `Grep`, Agent Deck MCP tools.

**Claude execute phase**: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, Agent Deck MCP tools, plus `--add-dir` for the temporal output directory.

**Cursor**: `--trust` (already applied).

**Codex plan / QA**: `codex exec --sandbox read-only` (never `danger-full-access` in managed flows).

**Codex execute**: `codex exec --sandbox workspace-write`; Agent Deck via Codex marketplace plugin when a deck is bound.

## Health checks

| Code | When |
|------|------|
| `deck_missing` | No `deckId` configured |
| `cli_missing` | Claude / Cursor / Codex CLI not installed |
| `runtime_auth` | Cursor or Codex not logged in / missing auth |
| `cursor_keychain` | Cursor macOS keychain stuck (`errSecDuplicateItem`) — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#cursor-macos-keychain-auth) |
| `deck_offline` | Agent has deck but Agent Deck API unreachable |
| `deck_unauthorized` | Bound deck not available from Agent Deck |

## P2 (documented, not yet implemented)

See prior notes on deliverable templates and vault placement.
