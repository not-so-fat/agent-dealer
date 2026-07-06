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

Open **http://localhost:2221** — dashboard and API on one port.

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

Production: see [docs/PROD_SETUP.md](docs/PROD_SETUP.md) — config at `~/.agent-dealer/.env`, API **2221**.

## Workflow (SC-1)

1. **Feed** — Pick **runtime** (+ optional deck/playbook) → add task
2. **Plan approval** — Agent draft or manual plan → **Approve plan**
3. **In progress** — **Start execution** (uses agent binding from step 1)
4. **Review** — **Approve done** or **Retry with feedback**

| `npm run flow:verify` | API flow gates (no browser) |
| `npm run poc:integration` | Linear / Agent Deck / Claude PoCs |

Works without Agent Deck (no deck = degraded mode, SC-4). Playbook is optional.

## P0 proof script

Batch-run Linear issue IDs via Claude without the dashboard:

```bash
# Edit .temporal/issue-ids.txt with issue IDs (one per line)
export DECK_ID=optional-uuid
export PLAYBOOK_ID=optional-id
npm run p0 -- .temporal/issue-ids.txt
```

Logs: `.temporal/logs/<issue>-<timestamp>.ndjson`

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
| `npm run p0` | P0 Linear batch script |
| `npm run build` | Build all packages |

## Environment

- **Dev:** [`scripts/templates/dev.env.example`](scripts/templates/dev.env.example) → `~/.agent-dealer-dev/.env`
- **Prod:** [`scripts/templates/prod.env.example`](scripts/templates/prod.env.example) → `~/.agent-dealer/.env`
