# agent-dealer

Human control plane for agent execution — queue, plan approval, agent runs, and audit treasure.

**Spec:** [docs/PRD_V0.md](docs/PRD_V0.md)

## Prerequisites

- Node.js 20+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH) for execution
- [Agent Deck](https://github.com/not-so-fat/agent_deck) optional — `agent-deck start` for deck picker + MCP at `:11111` / `:11112`
- `LINEAR_API_KEY` optional — for Linear Inbox; manual tasks work without it

See [docs/LINEAR_INTEGRATION.md](docs/LINEAR_INTEGRATION.md) for Inbox config, write-back sync, and REST automation.

## Quick start

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

Open **http://localhost:5173** (dashboard). API: **http://127.0.0.1:8765**

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

| Service | Port |
|---------|------|
| agent-dealer API | 8765 |
| agent-dealer dashboard | 5173 |
| Agent Deck API | 11111 |
| Agent Deck MCP | 11112 |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | API + dashboard |
| `npm run db:migrate` | Apply SQLite schema |
| `npm run p0` | P0 Linear batch script |
| `npm run build` | Build all packages |

## Data

SQLite: `~/.agent-dealer/dealer.db` (override with `AGENT_DEALER_HOME`)

## Environment

See [.env.example](.env.example).
