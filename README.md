# agent-dealer

**Queue it between meetings. Review it over coffee.**

agent-dealer is a human control plane for agent execution: a task queue where you approve the **plan** before anything runs, hard **turn/dollar caps** that halt instead of overrun, a **gate on every outbound send**, and an audit trail of all of it. Pair it with [Agent Deck](https://github.com/not-so-fat/agent_deck) and every run starts with the right tools, keys, and playbooks — and teaches the playbook something for the next run.

<!-- DEMO VIDEO — drop the 2-min demo here.
     On github.com, drag the .mp4 into the README editor to get a user-attachments URL,
     then paste it on its own line. GIF fallback:
<img src="docs/assets/demo.gif" alt="Queue five tasks between meetings, review them when you're back" width="80%" />
-->

## Why

Your calendar is full; your task list doesn't care. Tasks pile up from everywhere — a bug fix, a Slack thread that needs a real answer, a follow-up email from this morning's meeting, a docs pass — worth doing, never worth *watching* get done. Running them through agents used to mean ten terminal tabs and whatever context you could hold between meetings, with permission prompts landing exactly when you weren't there.

**Queue it in the gap.** Five minutes between meetings: you open the feed — a bug pulled from Linear, the rest typed in from wherever they came: Slack, a meeting, your inbox. Each task is bound to a deck, so the agent already has the right MCP tools, the credentials, and the playbook for that kind of work — "run the full suite, never touch migrations" for the bug; "draft the reply, never send it yourself" for the Slack thread.

**Approve the plan, not every keystroke.** For each task the agent drafts a plan. You skim all five in one pass and approve — one cheap, high-leverage gate before the next meeting starts, not per-action nagging mid-run. Plans the agent triages as trivial auto-approve; if something is genuinely ambiguous, the plan comes back with structured questions instead of a guess.

**Runs halt, they don't overrun.** Set optional per-task turn and dollar caps at plan approval (or on an agent profile). A run that hits its cap stops with its partial trace and waits for you. Leave caps blank and Claude uses its own runtime limits.

**Nothing leaves without you.** When a task wants to post to Slack, send an email, or update a ticket, the exact outbound payload is held for your approval. You read the literal message, fix the one wrong line, approve *that* send — or reject it, and it never existed.

**Review it when you're back.** After the meeting — before bed, or over coffee tomorrow; the queue doesn't care when you return. Three tasks done with results ready for review, one halted at its cap, one flagged for feedback. You approve two, send one back with a one-line correction, raise the cap on the halted one and retry. Every plan, trace, payload, and decision is already stored in SQLite you can grep next week — and after review, a reflect step proposes what the playbook should learn from your feedback.

## What makes it different

- **Plan approval before execution** — one gate up front instead of permission prompts mid-run. Gates are few and heavy on purpose.
- **A separate gate on the send** — outbound Slack/email/ticket payloads are held verbatim for your approve/edit/reject. Competitors gate the PR or a workflow node; nothing here leaves without you seeing exactly what leaves.
- **Caps that halt** — optional per-task turn and dollar ceilings enforced via Claude Code flags when you set them.
- **Audit treasure** — task → plan → trace → proposed payloads → your decisions, queryable in SQLite. "Who approved this and why" has a literal answer.
- **Playbooks that learn** — post-review reflection files playbook improvement proposals back to your [Agent Deck](https://github.com/not-so-fat/agent_deck), so the Nth similar task is cheaper than the first.

## How it works

1. **Feed** — pick a runtime (+ optional deck/playbook) → add tasks, from Linear or by hand
2. **Plan approval** — agent drafts a plan (or answer its structured questions) → **Approve plan**; trivial plans auto-approve
3. **Execution** — headless run; halts at any cap you set instead of overrunning
4. **Review** — approve done, or retry with feedback; outbound sends are approved separately, payload-by-payload
5. **Reflect** — after your review, the agent proposes playbook updates to Agent Deck's proposal queue

Works without Agent Deck too (no deck = degraded mode; playbooks optional).

## Quick start

Prerequisites: Node.js 20+ · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH) · [Agent Deck](https://github.com/not-so-fat/agent_deck) optional · `LINEAR_API_KEY` optional (manual tasks work without it)

```bash
npm install -g agent-dealer
agent-dealer setup
agent-dealer start --daemon --open
```

Open **http://localhost:2222** — dashboard and API on one port. Day to day: `agent-dealer start --daemon` / `agent-dealer stop` · `agent-dealer status` if something fails. Use plain `agent-dealer start` only when you want a foreground process in an open terminal (logs go to stdout).

Run `agent-dealer doctor` to verify Node, Claude CLI, bundle, and port before first start.

**Linear (optional):** edit `~/.agent-dealer/.env` — set `LINEAR_API_KEY` and `LINEAR_TEAM_ID`. See [LINEAR_INTEGRATION.md](docs/LINEAR_INTEGRATION.md) for Inbox config, write-back sync, and REST automation.

## Trust & execution scope

When you **approve execution**, agent-dealer spawns **Claude Code** (`claude -p`) in the task's bound **workspace directory**. During a run the agent may use:

| Phase | Tools (allowlisted) | Budget caps |
|-------|---------------------|-------------|
| **Plan** | Read, Glob, Grep, Skill + Agent Deck MCP (playbook/deck, list tools) | Optional — set per run or agent |
| **Execute** | Read, Write, Edit, Glob, Grep, Skill + Agent Deck MCP (playbook/deck, list tools); **Bash** only for code/research/content tasks | Optional — set per run or agent |
| **Reflect** (post-review) | Read, Glob, Grep, Skill + Agent Deck MCP | Optional — set per run |

`call_service_tool` is **denied** in every agent phase — outbound Slack/email sends only after you **Approve & send** in result review; the server delivers the stored payload verbatim via Agent Deck MCP.

When set, caps are enforced via Claude Code flags (`--max-turns`, `--max-budget-usd`). Leave turns or USD blank for no cap on that dimension. Deliverable scratch files go under `~/.agent-dealer/.temporal/output/`; audit artifacts stay in SQLite.

**You gate every run:** plan approval before execution, result review before done. Nothing executes without your explicit approve (or retry with feedback).

---

## Development

### Run from git

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

**Spec:** [docs/PRD_V0.md](docs/PRD_V0.md) · **Direction (cross-product):** [agent_deck/docs/DIRECTION.md](https://github.com/not-so-fat/agent_deck/blob/main/docs/DIRECTION.md)

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
| `npm run flow:verify` | API lifecycle gates — `scripts/flow-verify.ts` (server must be running) |
| `npm run flow:doc` | End-to-end API smoke with agent execution |
| `npm run poc:integration` | Linear / Agent Deck / Claude PoCs — `scripts/poc/` |
| `npm run build:release` | Release build + UI bundle |
| `npm run install:smoke` | Fresh npm pack install test |
| `npm run build` | Build all packages |

### Environment

- **Dev:** [`scripts/templates/dev.env.example`](scripts/templates/dev.env.example) → `~/.agent-dealer-dev/.env`
- **Prod:** [`scripts/templates/prod.env.example`](scripts/templates/prod.env.example) → `~/.agent-dealer/.env`
