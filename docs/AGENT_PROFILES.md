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
| `runtime` | Yes | `claude_code`, `cursor_local`, `codex_local`, or `muse_code` (developer role only; supervised trial — NOT-178/181. Model is pinned to `muse-spark-1.3-contributor`; see [Muse Code developer sessions](#muse-code-developer-sessions-trial)) |
| `deckId` | Yes (before kick) | Exactly one Agent Deck — workers never start without one. A `muse_code` profile still stores one (the form asks), but its worker never uses it |
| `name` | Yes | Display label |
| `defaultModel` / `defaultEffort` / `defaultBudget` | No | Session defaults (snapshotted) |
| `permissionPolicy` | No | Tighten-only capability overrides |

**Not agent concepts (NOT-149):** workspace root, selected playbooks, or free-form external-memory refs. Playbooks are chosen dynamically inside the pinned Deck. The GitHub repository lives on the **Issue**, not the Agent.

Built-in Claude, Cursor, and Codex agents ship with **no default Deck**. Configure a Deck on the Agents page before kicking tasks.

## Muse Code developer sessions (trial)

NOT-181 lets an issue whose **developer** profile is `muse_code` run the ordinary Dev-review workflow: admission → worktree → `muse exec` → coordinator push → draft PR → Codex/Claude review. It is a supervised trial (PoC recommended "retry later", NOT-183); the operator opts in per issue by choosing the Muse developer profile. Dealer does not classify sensitivity — contributor-tier content may be used for product improvement, so pick non-sensitive tickets.

What a Muse session is, and is not:

- **No MCP, no Agent Deck.** The prompt says so; nothing is materialized or verified against a deck, and a deck outage does not park a Muse developer (health skips deck checks for `muse_code`). The reviewer stays on its own profile — Muse cannot be a reviewer.
- **Pinned posture** (`muse-code-args.ts`): explicit model, approvals `never`, sandbox on with network `restricted`, web tools off, foreign personal context off, `--max-model-steps` from the profile's *Max turns* (default 300; the developer wall-clock timeout is the real limit), `MUSE_NO_AUTO_UPDATE=1`.
- **Per-attempt config under the worktree.** Each attempt writes `<worktree>/.dealer-muse/<uuid>/{config,data}` (`0700`, kept out of git through `info/exclude`) holding `settings.json` (workflows, subagents and reminders off, no `mcpServers`) and a symlink to the operator's `auth.json` (never read or copied). `XDG_CONFIG_HOME`/`XDG_DATA_HOME` point there. The directory is removed after every attempt, including failed, timed-out and refused-to-start ones, once the session log has been read.
- **Usage and cost.** Tokens and the server-confirmed model exist only in Muse's on-disk session log; the spawn parses it. `usage_events` records `runtime = muse_code`, the model that actually ran (`usage_events.model`), wall-clock duration and the token counts — **null when Muse did not report them**. Cost is always null (Muse reports none). A run whose confirmed model differs from the pinned one is a failed session.
- **Logs.** The session log (`…-developer-<ts>.ndjson`) holds Claude/Cursor-shaped events derived from Muse's stream, so the usage extraction, result text and auth classifier read it unchanged (the usage cap comes from the parsed failure kind instead). Muse's untouched stdout is archived beside it as `….muse-raw.jsonl`.
- **Failures follow the existing paths.** Auth failure (saved login expired, rejected key, missing credentials) → session failed, bounded infra retry, no review round spent. Usage cap → `usage_capped` deferral and a `muse_code` availability row (no reset time is observable, so the fallback cooldown applies). Wall-clock timeout → the ordinary timeout/infra path.
- **`cron_*` guard.** Muse cannot disable `cron_create`/`cron_list`/`cron_delete` (NOT-177). If a session's tool activity includes any of them the session is failed with reason `muse_cron_used` and the issue escalates to the operator (`policy_escalation`, no retry). The worktree is left as it was for inspection and nothing is pushed. **This detects after the fact; it does not prevent** — a job scheduled by the session could already have fired inside the process before it exited (the job store lives in the per-attempt data dir, which is deleted).

Out of scope: Muse as reviewer, Agent Deck/MCP access (NOT-180), workflows and subagents, cancellation/resume beyond existing behaviour.

### Local smoke (opt-in, paid)

CI never calls Muse: the integration tests use a fake `muse` (`packages/server/src/coordinator/fixtures/fake-muse.mjs`, selected with `MUSE_CLI`). To check the real CLI once by hand, with `muse` installed and logged in:

```bash
npm run build -w @agent-dealer/shared
MUSE_SMOKE=1 npm run smoke:muse
```

It creates a throwaway git repo, runs one real `muse exec` developer session (asks for a one-line `hello.txt` commit), and prints wall time, confirmed model, usage and PASS/FAIL checks (exit 0, pinned model confirmed, no `cron_*`, file committed, worktree clean, per-attempt config removed). It starts a paid session and sends a synthetic prompt to Meta's contributor tier; without `MUSE_SMOKE=1` it refuses to run.

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
| `cli_missing` | Claude / Cursor / Codex / Muse CLI not installed |
| `runtime_auth` | Cursor, Codex or Muse Code not logged in / missing auth (Muse: no `META_API_KEY` and no saved `muse login`; an expired login is only seen at run time) |
| `runtime_unknown` | Muse Code probe failed for a reason no capture explains — reported, not guessed |
| `cursor_keychain` | Cursor macOS keychain stuck (`errSecDuplicateItem`) — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#cursor-macos-keychain-auth) |
| `deck_offline` | Agent has deck but Agent Deck API unreachable |
| `deck_unauthorized` | Bound deck not available from Agent Deck |

## P2 (documented, not yet implemented)

See prior notes on deliverable templates and vault placement.
