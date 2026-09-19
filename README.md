# agent-dealer

**Queue the issue. Check back when it needs you.**

agent-dealer is an issue queue and execution control plane for coding agents: you file an issue against a repository, it is admitted from a queue, a developer agent implements it in its own git worktree and opens a pull request, a reviewer agent reviews the diff, and the loop repeats until the work merges or something genuinely needs a human. Every session, finding, cost, and decision lands on one durable issue record in SQLite. Pair it with [Agent Deck](https://github.com/not-so-fat/agent_deck) and every session starts with the right tools, keys, and playbooks.

<!-- DEMO VIDEO — drop the 2-min demo here.
     On github.com, drag the .mp4 into the README editor to get a user-attachments URL,
     then paste it on its own line. GIF fallback:
<img src="docs/assets/demo.gif" alt="Queue an issue, check back when it needs you" width="80%" />
-->

## Why

Your calendar is full; your backlog does not care. Small, well-specified issues — a bug fix, a flaky test, a missing guard — are worth doing and never worth *watching* get done. Running them through agents used to mean ten terminal tabs, hand-copied context, and permission prompts landing exactly when you were not there.

**File it, do not babysit it.** An issue carries what the work needs: repository and base branch, problem statement, acceptance criteria, a developer agent and a reviewer agent. New issues join the admission queue and start when a slot frees, one at a time, so five issues filed between meetings do not fight over your machine.

**Agents hand off through artifacts, not chat.** The developer works in an isolated worktree, commits, pushes a branch, and opens a draft PR. The reviewer gets read-only tools and the diff, and returns a verdict with concrete findings. Repair rounds go back to the developer automatically. Nothing about that loop needs you.

**You are asked only for real decisions.** Missing acceptance criteria, a policy escalation, an exhausted retry budget, a final review when auto-merge is off — these become human actions, surfaced at the top of the Issues home with the exact choices the server will accept.

**The record outlives the agents.** Worker sessions are temporary; the issue is not. Status, live progress, timeline, evidence, findings, usage, and every human decision stay queryable in SQLite you can grep next week.

## What makes it different

- **One durable issue, many temporary workers** — agent sessions are implementation details of the issue, not identities to babysit.
- **A real developer→reviewer loop** — the reviewer is spawned read-only and its verdict drives repair rounds; approval either auto-merges or parks for your final review.
- **Sequential admission** — a queue with visible position and wait reason, not N agents racing on one laptop.
- **Human attention as a queue item** — every open blocker appears on the Issues home with the server's own response options; resolving one resumes the workflow.
- **Audit treasure** — issue → sessions → PR → reviews → findings → your decisions, queryable in SQLite. "Who approved this and why" has a literal answer.

## How it works

1. **File** — new issue from Linear (lookup or inbox) or by hand: repo, base branch, acceptance criteria, developer + reviewer agents, auto-merge on/off
2. **Admission** — the issue queues; the coordinator admits the head entry when a slot is free and shows the wait reason when it cannot
3. **Develop** — a worker session runs the coding CLI in a dedicated worktree, pushes a branch, and opens a draft PR
4. **Review** — a read-only reviewer session assesses the diff against the acceptance criteria and returns findings; changes route back to the developer
5. **Finish** — approve → auto-merge, or park a final-review human action for you; blockers become human actions on the Issues home

Works without Agent Deck too (no deck = degraded mode; playbooks optional).

## Quick start

Prerequisites: Node.js 20+ · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH) · [GitHub CLI](https://cli.github.com) (`gh`, authenticated — the developer session opens the PR) · [Agent Deck](https://github.com/not-so-fat/agent_deck) optional · `LINEAR_API_KEY` optional (manual issues work without it)

**Recommended (managed install — auto-updates, keeps existing `~/.agent-dealer` data):**

```bash
curl -fsSL https://raw.githubusercontent.com/not-so-fat/agent-dealer/main/scripts/install.sh | bash
# or: npx agent-dealer@latest install
export PATH="$HOME/.local/bin:$PATH"
agent-dealer setup
agent-dealer start --daemon --open
```

Compat: `npm install -g agent-dealer` still works; `agent-dealer install` switches only the CLI binary (no data migration).

Open **http://localhost:2222** — dashboard and API on one port. Day to day: `agent-dealer start --daemon` / `agent-dealer stop` · `agent-dealer status` if something fails. Use plain `agent-dealer start` only when you want a foreground process in an open terminal (logs go to stdout).

Run `agent-dealer doctor` to verify Node, Claude CLI, GitHub CLI auth, Cursor auth (when installed), bundle, and port before first start.

## Troubleshooting

Host and runtime recovery (Cursor macOS keychain, etc.): [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

**Linear (optional):** edit `~/.agent-dealer/.env` — set `LINEAR_API_KEY` and `LINEAR_TEAM_ID`. See [LINEAR_INTEGRATION.md](docs/LINEAR_INTEGRATION.md) for candidate lookup, write-back sync, and REST automation.

## Trust & execution scope

When an issue is admitted, agent-dealer spawns the agent profile's coding CLI (`claude -p`, `cursor-agent`, or `codex exec`) in a **git worktree created off the issue's base branch** — never directly in your checkout. Role decides what the session may do:

| Role | Tools (hard availability list) | Scope |
|------|-------------------------------|-------|
| **Developer** | Read, Write, Edit, Glob, Grep, Bash, Skill + Agent Deck MCP (bind workspace, playbook/deck, list tools) | Its own worktree; commits, pushes its branch, opens/updates the draft PR |
| **Reviewer** | Read, Glob, Grep, Skill + Agent Deck MCP (read-only) | Cannot write files, run shell, push, or publish — asserted on the generated argv before every real spawn |
| **Reflect** (post-run playbook learning) | Read, Glob, Grep, Skill + Agent Deck MCP (read-only) | Proposes a playbook patch to Agent Deck; never applies one |

`mcp__agent-deck__call_service_tool` — the outbound write tool — is denied unless the profile's permission policy grants outbound mutation, and can never be granted to a reviewer. An agent profile may only *tighten* its role's ceiling, never loosen it.

Per-attempt Agent Deck MCP configuration is minted per session and scrubbed afterwards, so a spawned worker's only route to your deck is that short-lived, scoped server. Session logs go to `~/.agent-dealer/.temporal/logs/`; the issue record, evidence, and usage stay in SQLite.

**You gate what matters:** acceptance criteria before a workflow starts, a final review before done when auto-merge is off, and every human action the workflow raises.

---

## Development

### Run from git

```bash
mkdir -p ~/.agent-dealer-dev
cp scripts/templates/dev.env.example ~/.agent-dealer-dev/.env
# Edit ~/.agent-dealer-dev/.env — add LINEAR_API_KEY, etc.
npm install
npm run build -w @agent-dealer/shared   # server resolves @agent-dealer/shared/dist
npm run db:migrate
npm run dev
```

Open **http://localhost:3222** (dev dashboard). API: **http://127.0.0.1:3221**

Production (git): see [docs/PROD_SETUP.md](docs/PROD_SETUP.md) — API **2221**, dashboard **2222** when running split; npm CLI bundles both on **2222**.

**Spec:** [docs/PRD_ISSUE_COORDINATION.md](docs/PRD_ISSUE_COORDINATION.md) (current) · [docs/PRD_V0.md](docs/PRD_V0.md) (historical — the plan/execute product removed in NOT-71) · **Direction (cross-product):** [agent_deck/docs/DIRECTION.md](https://github.com/not-so-fat/agent_deck/blob/main/docs/DIRECTION.md)

**Execution analysis contract:** [docs/EXECUTION_ANALYSIS.md](docs/EXECUTION_ANALYSIS.md) defines phase boundaries, failure vocabulary, and evidence-quality rules for execution-time metrics.

**Agent-operated CLI:** see [docs/AGENT_OPERATED_DEV_REVIEW.md](docs/AGENT_OPERATED_DEV_REVIEW.md) for the exact minimal commands to drive one Dev-review issue end to end without the dashboard.

### P0 proof script

Batch-run Linear issue IDs via Claude without the dashboard:

```bash
# Edit scripts/fixtures/issue-ids.example.txt (or your own file)
export DECK_ID=optional-uuid
export PLAYBOOK_ID=optional-id
npm run p0 -- scripts/fixtures/issue-ids.example.txt
```

Logs: `.temporal/logs/<issue>-<timestamp>.ndjson` (gitignored runtime output)

### Ports

| Service | Dev | Prod |
|---------|-----|------|
| agent-dealer API | 3221 | 2221 |
| agent-dealer dashboard | 3222 | 2222 |
| Agent Deck MCP | 1110 | 1110 |
| Agent Deck UI | 1111 | 1111 |

### Data

| Mode | SQLite path |
|------|-------------|
| Development | `~/.agent-dealer-dev/dealer.db` |
| Production | `~/.agent-dealer/dealer.db` |

Override with `AGENT_DEALER_HOME` in the env file for that mode.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev API + dashboard (`AGENT_DEALER_ENV=development`) |
| `npm run start` | Prod API only (`AGENT_DEALER_ENV=production`) |
| `npm run db:migrate` | Apply schema to dev DB |
| `npm run db:migrate:prod` | Apply schema to prod DB |
| `npm run p0` | P0 Linear batch — `scripts/p0-linear-batch.ts` |
| `npm run test:unit` | Full unit + integration test suite |
| `npm run typecheck` | Typecheck shared, server, and web |
| `npm run poc:integration` | Linear / Agent Deck / Claude PoCs — `scripts/poc/` |
| `npm run build:release` | Release build + UI bundle |
| `npm run install:smoke` | Fresh npm pack install test |
| `npm run build` | Build all packages |

### Environment

- **Dev:** [`scripts/templates/dev.env.example`](scripts/templates/dev.env.example) → `~/.agent-dealer-dev/.env`
- **Prod:** [`scripts/templates/prod.env.example`](scripts/templates/prod.env.example) → `~/.agent-dealer/.env`
