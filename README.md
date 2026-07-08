# agent-dealer

Human control plane for agent execution — queue, plan approval, agent runs, and audit treasure.

**Spec:** [docs/PRD_V0.md](docs/PRD_V0.md) · **Direction (cross-product):** [agent_deck/docs/DIRECTION.md](https://github.com/not-so-fat/agent_deck/blob/main/docs/DIRECTION.md)

## Prerequisites

- Node.js 20+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH) for execution
- [Agent Deck](https://github.com/not-so-fat/agent_deck) optional — `agent-deck start` for UI at `:1111` and MCP at `:1110`
- `LINEAR_API_KEY` optional — for Linear Inbox; manual tasks work without it

See [docs/LINEAR_INTEGRATION.md](docs/LINEAR_INTEGRATION.md) for Inbox config, write-back sync, and REST automation.

## Quick start (npm)

```bash
npm install -g agent-dealer
agent-dealer setup
agent-dealer start --open
```

Open **http://localhost:2222** — dashboard and API on one port (prod dashboard port).

Run `agent-dealer doctor` to verify Node, Claude CLI, bundle, and port before first start.

**Linear (optional):** edit `~/.agent-dealer/.env` — set `LINEAR_API_KEY` and `LINEAR_TEAM_ID`. See [LINEAR_INTEGRATION.md](docs/LINEAR_INTEGRATION.md).

## Quick start (from git)

```bash
mkdir -p ~/.agent-dealer-dev
cp scripts/templates/dev.env.example ~/.agent-dealer-dev/.env
# Edit ~/.agent-dealer-dev/.env — add LINEAR_API_KEY, etc.
npm install
npm run db:migrate
npm run dev
```

Open **http://localhost:3222** (dev dashboard). API: **http://127.0.0.1:3221**

Production (git): see [docs/PROD_SETUP.md](docs/PROD_SETUP.md) — API **2221**, dashboard **2222** when running split; npm CLI bundles both on **2222**.

## Workflow (SC-1)

1. **Feed** — Pick **runtime** (+ optional deck/playbook) → add task
2. **Plan approval** — Agent draft or manual plan → **Approve plan**. The agent may ask structured questions (answer to start execution); plans self-triaged **trivial** auto-approve.
3. **In progress** — **Start execution** (uses agent binding from step 1)
4. **Review** — **Approve done** or **Retry with feedback**

| `npm run flow:verify` | API flow gates — `scripts/flow-verify.ts` (server must be running) |
| `npm run flow:doc` | End-to-end API smoke with agent execution |
| `npm run poc:integration` | Linear / Agent Deck / Claude PoCs — `scripts/poc/` |
| `npm run install:smoke` | Fresh npm pack install test |
| `npm run build:release` | Production build + bundle dashboard for npm |

Works without Agent Deck (no deck = degraded mode, SC-4). Playbook is optional.

## Trust & execution scope

When you **approve execution**, agent-dealer spawns **Claude Code** (`claude -p`) in the task’s bound **workspace directory**. During a run the agent may use:

| Phase | Tools (allowlisted) | Budget defaults |
|-------|---------------------|-----------------|
| **Plan** | Read, Glob, Grep, Skill + Agent Deck MCP (playbook/deck, list tools) | 5 turns · **$0.50** max |
| **Execute** | Read, Write, Edit, Glob, Grep, Skill + Agent Deck MCP (playbook/deck, list tools); **Bash** only for code/research/content tasks | 30 turns · **$5.00** max |
| **Reflect** (post-review) | Read, Glob, Grep, Skill + Agent Deck MCP | 3 turns · **$0.25** max |

`call_service_tool` is **denied** in every agent phase — outbound Slack/email sends only after you **Approve & send** in result review; the server delivers the stored payload verbatim via Agent Deck MCP.

Caps are enforced via Claude Code flags (`--max-turns`, `--max-budget-usd`). Per-run budgets can be tightened in the run record. Deliverable scratch files go under `~/.agent-dealer/.temporal/output/`; audit artifacts stay in SQLite.

**You gate every run:** plan approval before execution, result review before done. Nothing executes without your explicit approve (or retry with feedback).

## P0 proof script

Batch-run Linear issue IDs via Claude without the dashboard:

```bash
# Edit scripts/fixtures/issue-ids.example.txt (or your own file)
export DECK_ID=optional-uuid
export PLAYBOOK_ID=optional-id
npm run p0 -- scripts/fixtures/issue-ids.example.txt
```

Logs: `.temporal/logs/<issue>-<timestamp>.ndjson` (gitignored runtime output)

## Ports

| Service | Dev | Prod |
|---------|-----|------|
| agent-dealer API | 3221 | 2221 |
| agent-dealer dashboard | 3222 | 2222 |
| Agent Deck MCP | 1110 | 1110 |
| Agent Deck UI | 1111 | 1111 |

## Data

| Mode | SQLite path |
|------|-------------|
| Development | `~/.agent-dealer-dev/dealer.db` |
| Production | `~/.agent-dealer/dealer.db` |

Override with `AGENT_DEALER_HOME` in the env file for that mode.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev API + dashboard (`AGENT_DEALER_ENV=development`) |
| `npm run start` | Prod API only (`AGENT_DEALER_ENV=production`) |
| `npm run db:migrate` | Apply schema to dev DB |
| `npm run db:migrate:prod` | Apply schema to prod DB |
| `npm run p0` | P0 Linear batch — `scripts/p0-linear-batch.ts` |
| `npm run flow:verify` | API lifecycle gates |
| `npm run flow:doc` | Full agent path smoke |
| `npm run poc:integration` | External integration PoCs |
| `npm run build:release` | Release build + UI bundle |
| `npm run install:smoke` | npm install smoke test |
| `npm run build` | Build all packages |

## Environment

- **Dev:** [`scripts/templates/dev.env.example`](scripts/templates/dev.env.example) → `~/.agent-dealer-dev/.env`
- **Prod:** [`scripts/templates/prod.env.example`](scripts/templates/prod.env.example) → `~/.agent-dealer/.env`
