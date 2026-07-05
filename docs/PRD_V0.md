---
status: v0 draft
# Playbooks below = this document's authoring activity only (not agent-dealer product defaults)
authoring_playbooks: pb_ai_codegen_prd, pb_product_principle
related:
  - Task Planner — Architecture.md (Obsidian)
  - agent_deck/docs/MVP.md
---

# agent-dealer v0 — Product Requirements Document

**One-liner:** agent-dealer is the **human control plane for agent execution** — feed tasks from ticket systems, approve plans, queue agent runs, gate risky actions, and store the full audit trail; agents execute, humans set goals and approve outcomes.

**Status:** v0 draft · **Doc role:** Product / scope spec (PRD) · **Last aligned:** 2026-07-04  
**Codegen load path:** `docs/PRD_V0.md`  
**Architecture reference:** [Task Planner — Architecture.md](file:///Users/not_so_fat/workspace/Obsidian/lexicon-personal/Ideas/personal/Task%20Planner%20%E2%80%94%20Architecture.md)  
**Sibling product:** Agent Deck MVP (`agent_deck/docs/MVP.md` — separate repo)

> **Doc authoring note:** This file was structured using Agent Deck playbooks `pb_ai_codegen_prd` + `pb_product_principle` — that pairing applies to **writing this PRD**, not to agent-dealer runtime. The product does not ship or require specific decks or playbooks; users connect their own via Agent Deck at kick time (§10).

**Core principle:** Automation value > TAT. Optimize for overnight/unattended throughput with human gates, not sub-minute latency.

**Audience:** Developers **and** business / knowledge workers — anyone who delegates repeatable work to agents while keeping approval and audit control.

---

## 1. Product overview

### Problem

Knowledge workers and developers want agents to execute as many tasks as possible — overnight ticket queues, Slack triage, email drafts, research summaries, presentations, doc generation, and code — while humans focus on setting goals, approving plans, monitoring progress, and signing off results. Today this requires juggling ticket systems, inboxes, IDE agents, orchestrators, and scattered logs. None of the existing orchestrators combine:

1. **Human-approved plans** before execution
2. **Full audit treasure** (task → plan → trace → feedback → knowledge delta)
3. **Optional Agent Deck** integration (decks, playbooks, MCP proxy for Slack, Linear, etc.)
4. **Configurable approval gates** for risky actions (merge, send message, send email, ticket status)

**Example task categories (non-exhaustive):**

| Category | Examples |
|----------|----------|
| **Code** | Linear issue → branch → PR |
| **Communication** | Draft/respond Slack thread; triage inbox |
| **Email** | Draft reply, summarize thread, schedule follow-up |
| **Research** | Competitive scan, source summary, brief |
| **Content** | Presentation outline, doc draft, slide notes |

Agent Deck solves **what the agent knows** (decks, vault, playbooks). agent-dealer solves **what runs next, when, with what human gates, and what we learned**.

### Product split

| Layer | Question it answers | Owner |
|-------|---------------------|-------|
| **Context / knowledge** | What should this agent know and have access to right now? | **Agent Deck** — decks, vault, playbooks, `bind_workspace` |
| **Execution / planning** | What runs next, when, with what dependencies and retries? | **agent-dealer** — queue, state machine, human gates |
| **Audit / learning** | What was requested, approved, executed, feedback, knowledge delta? | **agent-dealer DB + dashboard** (treasure) |

**Do not** merge agent-dealer into Agent Deck. **Do not** adopt fully-autonomous orchestrators wholesale — they optimize ship-without-human; we optimize controlled knowledge improvement over time.

### Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  agent-dealer                                                │
│  queue · human plan approval · audit DB · dashboard          │
└───────────────────────────┬─────────────────────────────────┘
                            │ spawns one run per task
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENT RUNTIME                                               │
│  Work: Claude Code headless / Agent SDK                      │
│  Personal: Cursor SDK local                                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP (optional)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENT DECK (context hub — optional)                         │
│  bind_workspace · deck MCPs · vault · playbooks              │
└─────────────────────────────────────────────────────────────┘
```

**Thin handoff contract:**

```text
dealer.start(runId, repo?, artifactWorkspace?, deckId?, playbookId?)
  → agent session with optional agent-deck MCP
  → artifacts: PR / doc / draft message / research brief + ticket comment
  → optional: update_playbook from run feedback
  → dealer.markReview(runId)
  → human approves → dealer.markDone(runId)
```

### Success criteria (v0)

| # | Criterion | Target |
|---|-----------|--------|
| SC-1 | Linear issue → enqueue → human approves plan → agent run completes → human approves result | P1 ship |
| SC-2 | Full artifact chain stored and reviewable in dashboard | P1 ship |
| SC-3 | Queue shows running + queued tasks with agent, deck, runtime | P1 ship |
| SC-4 | Works without Agent Deck (degraded: no playbook/deck MCP) | P1 ship |
| SC-5 | Configurable approval gates for merge / message / email / ticket status | P2 ship |
| SC-6 | Non-code task (e.g. research draft, Slack reply) completes full plan → execute → review cycle | P2 ship |

### Non-goals (v0)

- Auto-merge / auto-ship pipelines (zero-human ship)
- Cloud Cursor runs with local Agent Deck
- Multi-user / team permissions
- Merging agent-dealer into the Agent Deck repo
- Replacing Linear or any ticket system UI
- Running or bundling third-party CLIs (wrap via runner adapters only)

---

## 2. Target users & roles

| Persona | Goal | v0 surface |
|---------|------|------------|
| **Developer (work)** | Queue Linear tickets overnight via Claude Code + Agent Deck | Feed + execution + review |
| **Developer (personal)** | Same flow via Cursor SDK local | Same dashboard |
| **Business / ops user** | Delegate Slack, email, research, presentations with send-gates | Same dashboard; task category templates |
| **Knowledge worker** | Batch research and content tasks without opening an IDE | Manual feed + plan approval + review |
| **Human operator** | Approve plans, monitor queue, approve/retry results | Four dashboard CTAs (see §9) |
| **Future: team lead** | Audit run history, tune approval templates | Run detail timeline (read-only in v0) |

**Task category** (`code` | `communication` | `email` | `research` | `content` | `other`) is stored on each run. It drives default approval gates — not deck or playbook selection (user picks those per run).

**Voice:** Cold-reader. Distinguish **agent-dealer run** (queue item with state machine) from **Agent Deck bound deck** (MCP session scope for one agent turn/session). Avoid assuming every task has a git repo; non-code tasks use an **artifact workspace** (local folder for outputs).

---

## 3. User stories (testable)

Stories are grouped by the four primary dashboard CTAs.

### A. New task feed

#### US-1 — Poll Linear and enqueue

**As a** human operator (developer or business user) **I want** agent-dealer to poll Linear for eligible issues **so that** new work enters the queue without manual copy-paste.

**Acceptance:**

- [ ] Planner polls Linear API directly (not via Agent Deck MCP)
- [ ] Configurable filter: project, state(s), assignee, label
- [ ] New eligible issue creates a `run` in `queued` or `plan_pending` status
- [ ] Original issue snapshot stored as `task_snapshot` artifact
- [ ] Duplicate enqueue for same `external_id` + unchanged issue revision is idempotent

*v0 · P1*

#### US-2 — Manually add task

**As a** human operator **I want** to create a task in the dashboard **so that** I can queue work not tracked in Linear (including non-code tasks).

**Acceptance:**

- [ ] Form fields: title, description, task category, acceptance criteria (markdown)
- [ ] **Repo path** OR **artifact workspace** (required for code vs non-code tasks respectively)
- [ ] Source recorded as `manual`; no `external_id` required
- [ ] Task enters `plan_pending` or `queued` per user choice
- [ ] Category presets default approval gates (e.g. `communication` → gate send_message; `research` → no send gate)

*v0 · P1*

#### US-3 — Initiate plan mode

**As a** human operator **I want** an agent to draft an execution plan before I approve **so that** I review approach before spend.

**Acceptance:**

- [ ] "Draft plan" action spawns **plan runner** (see §6 Plan runner) — short agent turn, not full execution
- [ ] Output stored as `draft_plan` artifact (markdown)
- [ ] Run transitions to `plan_pending`
- [ ] Human can skip plan draft and write plan manually

*v0 · P1 · Default: agent-draft → human edit (see §13)*

---

### B. Plan approval

#### US-4 — Review and edit plan

**As a** human operator **I want** to review and modify the draft plan in the dashboard **so that** the approved artifact matches my intent.

**Acceptance:**

- [ ] Markdown editor for plan body
- [ ] Save creates `approved_plan` artifact; prior draft retained
- [ ] Optional diff view: draft vs approved
- [ ] Acceptance criteria visible alongside plan

*v0 · P1*

#### US-5 — Kick execution

**As a** human operator **I want** to approve the plan and start agent execution **so that** the task enters the run queue.

**Acceptance:**

- [ ] Select runtime: `claude_code` | `cursor_local`
- [ ] User selects **deck** and optional **playbook** from their Agent Deck install (`get_decks` / `GET /api/decks` — agent-dealer does not hardcode or recommend specific ids)
- [ ] Warn if selected deck has missing OAuth/MCP deps for task category (e.g. Slack disconnected for `communication`)
- [ ] Optional: approval gate template (merge, message, email, ticket status, publish_external)
- [ ] Run transitions `plan_approved` → `running` when slot available
- [ ] Per-run payload passed to runner (see §6)

*v0 · P1*

#### US-6 — Reject plan

**As a** human operator **I want** to reject a plan **so that** I can re-draft or cancel without executing.

**Acceptance:**

- [ ] Reject → `plan_pending` (re-draft) or `cancelled`
- [ ] Rejection reason stored as `feedback` artifact

*v0 · P1*

---

### C. Review execution

#### US-7 — Live queue visibility

**As a** human operator **I want** to see what is running and what is next **so that** I can monitor overnight automation.

**Acceptance:**

- [ ] Dashboard shows: N running, M queued, next up (title + source + runtime)
- [ ] Per running task: agent runtime, deck name (if bound), issue link, started-at
- [ ] Real-time or near-real-time updates (SSE or WebSocket; poll fallback acceptable in P1)

*v0 · P1*

#### US-8 — Per-task progress

**As a** human operator **I want** per-task progress during execution **so that** I can detect stalls and estimate cost.

**Acceptance:**

- [ ] Turn count, elapsed time, token/cost estimate (when stream provides it)
- [ ] Stall detection: no progress beyond configurable threshold → flag in UI
- [ ] Link to live log tail (NDJSON or text stream)

*v0 · P1 · Stall detection P2*

---

### D. Review results

#### US-9 — Inspect run artifacts

**As a** human operator **I want** to inspect the full result of a run **so that** I can decide approve vs retry.

**Acceptance:**

- [ ] Run detail timeline shows: task snapshot, plans, transcript, deliverables (PR, diff, email_draft, slack_draft, document, research_brief)
- [ ] Acceptance criteria checklist (human marks pass/fail per criterion)
- [ ] Cost summary (tokens, USD if available)

*v0 · P1*

#### US-10 — Approve or retry

**As a** human operator **I want** to approve a completed run or retry with feedback **so that** no task closes without my sign-off.

**Acceptance:**

- [ ] Approve → `done`; optional sync comment to Linear/Lific
- [ ] Retry → new run linked to parent (`lineage_id`); feedback artifact required
- [ ] No run reaches `done` without explicit human approval (SC-1)

*v0 · P1*

#### US-11 — Playbook reflect (optional)

**As a** human operator **I want** to trigger a playbook update from run feedback **so that** Agent Deck knowledge improves.

**Acceptance:**

- [ ] Post-approve action: "Update playbook" (requires `deckId` + `playbookId`)
- [ ] Reflect turn uses agent-deck MCP → `update_playbook`
- [ ] `playbook_patch` artifact links to change + rationale
- [ ] Skipped when Agent Deck not configured

*v0 · P3*

---

## 4. Task sources (feeds)

### v0 ship

| Source | Mechanism | Notes |
|--------|-----------|-------|
| **Linear** | Direct API poll from planner | Filter by project/state/assignee; planner does **not** use Agent Deck for queue |
| **Built-in manual** | Dashboard create form | No external tracker; source = `manual` |

### Second lightweight tracker — recommendation

v0 ships Linear + manual only. v0.1 adds a second adapter. Evaluation:

| Option | Fit | Recommendation |
|--------|-----|----------------|
| **[Lific](https://github.com/VoidNullable/lific)** | Single Rust binary, embedded SQLite, MCP-native (~2.5k token schema), web UI, human-readable IDs (`APP-42`), REST API | **Recommended v0.1 adapter #2** — aligns with Agent Deck MCP pattern; local-first; good for personal projects |
| **[Docket](https://github.com/ALT-F4-LLC/docket)** | Repo-local `.docket/issues.db`, CLI + `--json`, DAG planning (`docket next`, `docket plan`) | Strong alternate if tasks are repo-scoped and live in git worktrees |
| **GitHub Issues** | Familiar; GitHub MCP on user-configured decks | Heavier than needed unless work is already GH-centric |
| **Plane** | Linear-like, self-hosted | Too heavy for "lightweight complement" to Linear |

**PRD decision:**

- **v0:** Linear + built-in manual
- **v0.1:** Lific adapter (REST or MCP poll)
- **Fallback:** Docket if dogfooding shows repo-local model wins

### Tracker adapter interface (implementation note)

```typescript
interface TrackerAdapter {
  pollEligible(): Promise<ExternalTask[]>;
  getTask(id: string): Promise<ExternalTask>;
  comment?(id: string, body: string): Promise<void>;
  updateStatus?(id: string, status: string): Promise<void>; // gated
}
```

Planner owns tracker credentials (env / local config). Agent Deck MCP is **not** used for queue management.

---

## 5. State machine & data model

### Run status flow

```text
queued → plan_pending → plan_approved → running → review → done
                                              ↘ failed
         plan_pending → cancelled
         any → cancelled (human)
```

| Status | Meaning |
|--------|---------|
| `queued` | Enqueued; plan not started |
| `plan_pending` | Awaiting human plan approval |
| `plan_approved` | Plan signed off; waiting for execution slot |
| `running` | Agent session active |
| `review` | Agent finished; awaiting human result approval |
| `done` | Human approved |
| `failed` | Unrecoverable error or rejected gate |
| `cancelled` | Human cancelled |

### Event-sourced SQLite schema (core asset)

```sql
-- runs
id, source, external_id, task_category, repo?, artifact_workspace?,
deck_id?, playbook_id?, runtime, status, lineage_id?, created_at, updated_at

-- artifacts
id, run_id, kind, content_json, blob_path?, author, created_at

-- events (append-only)
id, run_id, type, payload_json, ts

-- approval_gates
id, run_id, action_type, status, resolved_by?, resolved_at?
```

### Artifact kinds

| Kind | Purpose |
|------|---------|
| `task_snapshot` | Original task at enqueue |
| `draft_plan` | Agent-drafted plan |
| `approved_plan` | Human-signed plan |
| `acceptance_criteria` | Testable done definition |
| `transcript` | Full agent trace (tool calls, messages) |
| `diff` | Git diff summary |
| `pr` | PR URL + metadata |
| `email_draft` | Draft email body + metadata (send gated) |
| `slack_draft` | Draft Slack message (send gated) |
| `document` | Presentation, doc, or file output path |
| `research_brief` | Research summary markdown |
| `deliverable` | Generic output file reference |
| `feedback` | Human review / retry notes |
| `playbook_patch` | Link to Agent Deck playbook update |

### Agent Deck today (not agent-dealer)

| Feature | Scope |
|---------|-------|
| `exec_runs` | CLI `agent-deck exec` audit only |
| Playbooks | Knowledge cards, not run history |
| — | No queue, approval gate, transcript store |

---

## 6. Execution model

### Two clocks

| Clock | Owner | Example |
|-------|-------|---------|
| **Queue clock** | agent-dealer | Poll Linear every 30s; next task starts when a slot is free (up to `maxConcurrentRuns`) |
| **Task clock** | Agent runtime | One session: many turns, 1–3 hours, optional `--resume` |

Agent Deck = **task clock only** (one bound session per run).

### Runtime matrix

| Runtime | Work (Claude) | Personal (Cursor) | Agent Deck? | Notes |
|---------|---------------|-------------------|-------------|-------|
| **Claude Code `claude -p`** | ✓ Primary | — | **Yes — HTTP MCP** | `--mcp-config` with `http://127.0.0.1:11112/mcp`; same Agent Deck endpoint as Cursor |
| **Claude Agent SDK** | ✓ Primary | — | Yes | `mcpServers` HTTP transport → `11112` |
| **Cursor SDK local** | — | ✓ Primary | Yes | Inline MCP → `http://127.0.0.1:11112/mcp` |
| **Cursor SDK cloud** | — | Fallback | **No** | VM can't reach local hub / Keychain |
| **Cursor Linear delegate** | — | Easy | **No** | Cloud agent; no local Agent Deck |

**v0 default:** local runners only. Cloud documented as non-goal until Agent Deck remote story exists.

**Practical split:** work = Claude Code; personal = Cursor SDK **local**. Both reach Agent Deck on the **same HTTP MCP port** when using CLI/npx (`agent-deck start` → `:11112`; dev monorepo → `:3001`).

### Claude Code + Agent Deck HTTP MCP

Yes — `claude -p` connects to `localhost:11112` the same way as Cursor, via **HTTP MCP transport** in the MCP config (not stdio-only). Agent Deck documents this in [SETUP.md](../agent_deck/docs/SETUP.md):

```json
{
  "mcpServers": {
    "agent-deck": {
      "type": "http",
      "url": "http://127.0.0.1:11112/mcp"
    }
  }
}
```

Register once:

```bash
claude mcp add --scope user --transport http agent-deck http://127.0.0.1:11112/mcp
```

Requirements:

- `agent-deck start` running (backend + MCP on `:11112`)
- Pass `--mcp-config` to `claude -p` (or use `~/.claude.json` with the entry above)
- Use `--bare` only with explicit `--mcp-config` (skips auto-discovery)
- Allow tools: `mcp__agent-deck__*` in `--allowedTools`

Dev monorepo: substitute `http://127.0.0.1:3001/mcp` when using `npm run dev:all`.

### MCP: who connects to what

```text
agent-dealer                     TASK AGENT (per run)
────────                         ────────────────────
Linear API (direct)              agent-deck MCP  ← optional
  poll, status                     ├─ bind_workspace / get_playbook
                                   ├─ update_playbook (post-run)
                                   └─ proxied deck MCPs (Linear, Slack, …)
GitHub API (optional)            repo tools (Read / Edit / Bash)
```

### Per-run payload

```yaml
runId: uuid
taskCategory: code | communication | email | research | content | other
deckId: optional-uuid
playbookId: optional-uuid
workspaceRoot: /path/to/worktree        # code tasks
artifactWorkspace: /path/to/outputs     # non-code tasks (optional if workspaceRoot set)
runtime: claude_code | cursor_local
issue:
  id: LIN-123
  title: string
  description: string
  url: string
approvedPlan: |
  # human-approved markdown
acceptanceCriteria: |
  - [ ] criterion 1
approvalGates:
  merge_pr: require_approval
  send_message: require_approval      # Slack, chat
  send_email: require_approval
  update_ticket_status: require_approval
  publish_external: require_approval  # presentation share, public doc
budget:
  maxTurns: 30
  maxBudgetUsd: 5.00
```

### Agent Deck wiring per run (optional)

| Option | Mechanism |
|--------|-----------|
| **HTTP MCP** | `http://127.0.0.1:11112/mcp` — backend must run |
| **stdio MCP** | `agent-deck mcp` subprocess |
| **Env defaults** | `AGENT_DECK_DECK_ID` + `AGENT_DECK_WORKSPACE` |
| **Prompt contract** | `bind_workspace({ deckId, workspaceRoot })` → `get_playbook` |

Health check before spawn: ping Agent Deck MCP; warn in dashboard if down. Run proceeds in degraded mode without deck.

### Claude headless example

```bash
# Requires agent-deck start and claude mcp add (HTTP → :11112)
claude -p "Work LIN-123. bind_workspace deckId=… Use playbook pb_…" \
  --mcp-config ~/.claude.json \
  --allowedTools "Read,Edit,Bash(...),mcp__agent-deck__*,mcp__slack__*" \
  --max-turns 30 \
  --max-budget-usd 5.00
```

Example `~/.claude.json` fragment:

```json
{
  "mcpServers": {
    "agent-deck": {
      "type": "http",
      "url": "http://127.0.0.1:11112/mcp"
    }
  }
}
```

### Runner adapter interface

```typescript
interface RunnerAdapter {
  spawn(run: RunPayload): Promise<RunHandle>;
  stream(handle: RunHandle): AsyncIterable<RunEvent>;
  cancel(handle: RunHandle): Promise<void>;
}
```

Implementations: `ClaudeRunner`, `CursorLocalRunner`.

### Plan runner (US-3)

Lightweight agent turn for drafting plans only — not full task execution.

| Field | Default |
|-------|---------|
| Runtime | Same as execution (`claude_code` or `cursor_local`) |
| `maxTurns` | **5** |
| `maxBudgetUsd` | **0.50** |
| Tools | Read, search, optional deck MCP for context — **no** Write/Bash/gated send tools |
| Output | `draft_plan` artifact → run status `plan_pending` |

Optional: user may pass `playbookId` from their deck to shape plan structure (e.g. a team's implementation playbook).

### Parallelism & cost

**Design priority:** automation throughput with guardrails, not minimum TAT.

| Knob | v0 default | Rationale |
|------|------------|-----------|
| `maxConcurrentRuns` | **2** | Matches real usage: multiple agent tabs/sessions in parallel (e.g. Claude Code tab + Cursor tab). Dogfood and tune. |
| `maxConcurrentPerRuntime` | 2 | Allow 2 Claude or 2 Cursor runs if machine allows; cap combined |
| `pollIntervalMs` | 30000 | Queue clock; not latency-critical |
| `maxTurns` per run | 30 | Configurable per task |
| `maxBudgetUsd` per run | 5.00 | Hard stop via CLI flags |
| `dailyBudgetUsd` | optional, unset | When set, pause queue on exceed |
| Conservative mode | user sets 1 | Fallback when RAM/API limits bite |

**Why default 2 (not 1):** Operator experience is already multi-tab — running two agent sessions concurrently is common. agent-dealer should orchestrate that deliberately (separate worktrees / artifact folders, per-run budgets, visible slot labels) instead of fighting ad-hoc parallelism outside the queue.

**Multi-tab validation (P1 dogfooding):**

- [ ] Two runs on same machine without worktree collision (code) or output dir collision (non-code)
- [ ] Dashboard shows **Slot 1 / Slot 2** with runtime + deck per slot
- [ ] Combined RAM/CPU acceptable on target machine; stall detection fires independently per slot
- [ ] If unstable, user drops to `maxConcurrentRuns: 1` in settings (one-line config)

**Stall detection** (borrow from Autoship/Maestro):

- Process-level: no stdout/stderr beyond N minutes
- Orchestrator-level: run in `running` beyond max duration without progress event
- Action: flag in dashboard; optional auto-pause queue

**Rate limits:**

- Default 2 concurrent; document Linear API and Slack MCP rate limits in config
- Back off poll on 429
- Optional: `maxConcurrentPerDeck` to avoid OAuth/token contention on same MCP service

### Unattended overnight checklist

- Machine on (local agents)
- `agent-deck start` running (if using deck)
- Claude / Cursor auth valid
- Pre-set permissions (`--allowedTools`, permission mode)
- Git worktree per code ticket OR isolated artifact workspace per non-code task
- Queue budget configured; `maxConcurrentRuns` set (default **2**)

---

## 7. Human approval gates

### Task-level gate

No run reaches `done` without explicit human approval in dashboard (US-10). Agent finishing moves run to `review`, not `done`.

### Action-level gates (configurable per task or template)

| Action | Default | Gate behavior |
|--------|---------|---------------|
| Merge PR | Require approval | Agent pauses → dashboard notification → approve/reject → resume or fail to `review` |
| Send Slack / chat message | Require approval | Same |
| Send email | Require approval | Same |
| Change ticket status | Require approval | Same |
| Publish / share externally | Require approval | Presentations, docs shared outside draft workspace |
| Create document / local draft only | No gate | Agent proceeds |
| Push branch / open PR | No gate (review at task level) | PR link captured in artifacts |

### Gate flow

```text
agent requests gated action (tool call matching gate type)
  → runner intercepts; does NOT forward tool to host yet
  → approval_gates row: status = pending; artifact preview stored
  → run.status stays running; dashboard notification
  → human approve → runner injects resume (--resume or continuation prompt) with approval token
  → human reject → run → review with feedback artifact
```

**v0 mechanism:** Runner watches NDJSON/tool stream from Claude/Cursor SDK. On gated tool match, pause subprocess, persist gate state, wait for dashboard API `POST /gates/:id/approve`. No native host pause required.

### Email & messaging (business tasks)

v0 has **no email MCP** on typical decks. Email tasks are **draft-only**:

- Agent writes `email_draft` artifact in artifact workspace
- `send_email` gate blocks any actual send tool until human approves in dashboard
- v0.1 open question: email MCP on user's execution deck (Gmail/Outlook)

Slack uses deck MCP when connected; same draft → gate → send pattern.

---

## 8. Audit treasure (moat)

### What to store

| Artifact | Purpose |
|----------|---------|
| **Original task** | Ticket snapshot at enqueue |
| **Human-approved plan** | Signed-off plan before agent runs |
| **Acceptance criteria** | Done definition |
| **Execution trace** | Transcript, tool calls, tokens, cost, git/PR |
| **Final feedback** | Review, merge decision, lessons |
| **Playbook delta** | Link to `update_playbook` change + rationale |

### Existing orchestrators — coverage gap

| Capability | Botfarm | Autoship | Composio AO | Cursor native | **agent-dealer** |
|------------|---------|----------|-------------|---------------|------------------|
| Task queue + state DB | ✓ | ✓ | ✓ | Linear status | ✓ |
| Original task snapshot | ✓ | ✓ | ✓ | issue text | ✓ |
| **Human-approved plan** | ✗ | ✗ | escalation only | comments | ✓ |
| Stage logs / transcripts | ✓ | ✓ | ✓ | cursor.com | ✓ |
| Final feedback | review in DB | review agent | reactions | Linear comments | ✓ |
| **Playbook / knowledge loop** | ✗ | ✗ | ✗ | ✗ | ✓ (optional) |
| **deckId / Agent Deck** | ✗ | ✗ | ✗ | ✗ | ✓ (optional) |

**None cover the full treasure model.** agent-dealer's moat is the audit DB + dashboard, not the poll loop.

### UI pattern: vertical timeline

Run detail uses a **vertical timeline** (not playing cards):

- Each artifact = timeline node, expandable to full content
- Plan nodes show draft → approved diff
- Execution node streams or links to transcript
- Feedback nodes chain on retry (lineage)

Borrow timeline/history UX from Composio AO human escalation; avoid autonomous-only log dumps.

### ThreadKeeper — insights (do not follow wholesale)

[ThreadKeeper](https://github.com/po4erk91/thread-keeper) is a cross-session memory and audit system for multi-CLI agent work. agent-dealer is **not** a ThreadKeeper clone — different job (queue + human gates vs autonomous skill library). Useful patterns to **borrow**:

| ThreadKeeper idea | agent-dealer adaptation |
|-------------------|-------------------------|
| **Thread lifecycle** (`open_thread` → notes → `close_thread`) | Run lifecycle maps cleanly: enqueue → plan → execute → review; timeline nodes = phases |
| **`agent_status()` loop health snapshot** | Dashboard header: per-slot runner health, backlog count, last event, child process status |
| **Tiered evidence** (hypothesis → observed → validated) | Optional metadata on artifacts; human approval promotes plan/result to "validated" |
| **Append-only event log** | Already core (`events` table); ThreadKeeper validates this approach |
| **Resources vs tools** (host-attached read-only context) | Run detail drawer auto-attaches task snapshot + approved plan; agent doesn't fetch audit |
| **Background review loops** | **Reject for v0** — playbook reflect is human-triggered, not autonomous daemon |

**Do not adopt from ThreadKeeper:**

- Autonomous skill extraction daemons without human gate
- Cross-CLI skill mirroring as primary product
- Replacing agent-dealer queue with thread-open prose conventions

Reference: [ThreadKeeper ARCHITECTURE.md](https://github.com/po4erk91/thread-keeper/blob/main/docs/ARCHITECTURE.md)

---

## 9. Dashboard UX

### Visual language

Match Agent Deck palette; **no card grid** (cards belong to Agent Deck's deck builder).

| Token | Value | Use |
|-------|-------|-----|
| Background gradient | `#1a1a2e → #16213e → #0f3460` | Page background |
| Accent teal | `#92E4DD` | Labels, active states, links |
| Gold CTA | `#C4B643` / `#D4C760` | Primary buttons |
| Base dark | `#0F0F0C` | Panels, inputs |

### Typography

Use **Monaco** as the primary monospace face where it aids scanning — transcripts, logs, plan markdown source, artifact JSON, acceptance criteria.

```css
/* Prose / UI labels — system sans */
font-family: ui-sans-serif, system-ui, sans-serif;

/* Code, plans, transcripts, diffs */
font-family: Monaco, "SF Mono", "Cascadia Code", "Segoe UI Mono", monospace;
```

**Monaco Editor** (`@monaco-editor/react`) for:

- Plan approval editor (markdown)
- Transcript / log viewer (read-only, syntax-highlighted when JSON or diff)
- Acceptance criteria checklist side panel

Body copy and column headers stay sans-serif for readability; monospace is for **agent output and editable plans** — not the whole UI.

Typography and non-monospace component primitives should align with Agent Deck (Tailwind, similar button/input styles) for a sibling-product feel.

### Layout: pipeline board + run drawer

Four columns map to primary CTAs:

```text
┌──────────┬───────────────┬─────────────┬────────────────┐
│  Feed    │ Plan approval │ In progress │ Review results │
│          │               │             │                │
│  new +   │  plan_pending │  running    │  review        │
│  queued  │               │  slot 1–2   │                │
└──────────┴───────────────┴─────────────┴────────────────┘
                              │
                    click run → right drawer
                              │
                    timeline + artifacts + actions
```

**Global header:**

- Queue summary: N running, M queued, next up title
- Cost today (USD estimate)
- Agent Deck connection status (optional): connected / offline / not configured

**Feed column actions:**

- Configure Linear poll
- Add manual task
- Draft plan (plan mode)

**Plan approval column actions:**

- Edit plan markdown
- Approve & kick (runtime + deck picker)
- Reject

**In progress column:**

- Live status per slot (Slot 1 / Slot 2 when `maxConcurrentRuns: 2`)
- Runtime, deck, task category badge per slot
- Cancel run
- View log tail (Monaco read-only viewer)

**Review results column:**

- Approve done
- Retry with feedback
- Update playbook (if deck configured)

### Real-time updates

- **P1:** SSE or WebSocket for queue snapshot (borrow Cognit-flow / Symphony pattern)
- **Fallback:** 5s poll acceptable for v0 dogfooding

---

## 10. Agent Deck integration (optional)

agent-dealer does **not** ship decks, playbooks, or MCP credentials. When Agent Deck is available, the user connects **their own** deck and optional playbook per run. agent-dealer passes through `deckId` / `playbookId` and records what was used in the audit trail — it never curates or recommends a fixed set.

| Mode | Behavior |
|------|----------|
| **With deck** | User picks deck + optional playbook at kick (US-5); runner prompt includes `bind_workspace`; post-run optional `update_playbook` |
| **Without deck** | Runner uses repo tools only; no MCP proxy; all audit still in agent-dealer |

**Deck picker (US-5):** List decks from Agent Deck (`get_decks` MCP or `GET /api/decks`). Show deck name, MCP/credential/playbook counts, and connection health. Playbook dropdown scoped to playbooks on the selected deck (or full collection — implementation choice). **No default deck** in agent-dealer config beyond optional last-used preference.

agent-dealer **never** stores MCP secrets or OAuth tokens — that remains Agent Deck's vault.

### Division of responsibility

| Concern | agent-dealer | Agent Deck |
|---------|--------------|------------|
| Queue order | yes | no |
| Human plan approval | yes | no |
| Transcript / audit DB | yes | no |
| Deck scope | passes `deckId` | `bind_workspace` |
| Procedures | passes `playbookId` | `get_playbook` |
| Secrets / OAuth MCPs | no | yes |
| Improve knowledge | decides when | `update_playbook` |

### Post-run playbook loop (planner-orchestrated)

```text
task finishes → store transcript + diff + feedback
             → optional reflect turn with agent-deck → update_playbook
```

Agent Deck stores **knowledge**; agent-dealer decides **when** and **from what feedback**.

---

## 11. Competitive research

What to borrow vs reject from similar products.

| Product | Steal | Reject |
|---------|-------|--------|
| [Autoship](https://github.com/qiuyanxin/autoship) | Lean poll loop, worktree isolation, stall detection, NDJSON stream capture | Zero-human auto-merge |
| [Symphony](https://github.com/llj0824/symphony) | Priority dispatch, reconciliation loop, live dashboard SSE | Fully autonomous terminal states |
| [Maestro](https://github.com/neilzhangpro/Maestro) | Multi-backend adapter, concurrency knobs | Docker-only assumption for v0 |
| [Cognit-flow](https://github.com/gxPan1006/cognit-flow) | SSE dashboard without heavy frontend | — |
| [Composio AO](https://github.com/ComposioHQ/agent-orchestrator) | Human escalation for merge | Parallel agents without approval |
| [Botfarm](https://github.com/AlexDobrushskiy/botfarm) | SQLite event model, stage_runs | Autonomous ship assumptions |
| Cursor Linear delegate | Easy delegation | No local Agent Deck, no plan gate, no treasure |
| [AgentOS](https://github.com/zzhiyuann/agentos) | Linear as control plane, adapter abstraction | Fully autonomous agent team |
| [ThreadKeeper](https://github.com/po4erk91/thread-keeper) | Thread lifecycle, `agent_status` health snapshot, append-only events, tiered evidence | Autonomous skill loops; cross-CLI memory as primary product |

**Differentiator:** Human-approved plan + full treasure + optional Agent Deck knowledge loop. Optimizes **controlled improvement over time**, not **ship without human**.

References:

- [Botfarm](https://github.com/AlexDobrushskiy/botfarm) — `tasks`, `stage_runs`, `task_events`, SQLite
- [Autoship](https://github.com/qiuyanxin/autoship) — lean Linear→PR, HTTP `/api/v1/state`
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — parallel agents, dashboard :3000, human escalation for merge
- [Cursor Linear integration](https://cursor.com/docs/integrations/linear) — cloud delegate, no local Agent Deck

---

## 12. MVP phasing

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **P0** | Manual script: 3 Linear IDs from file → loop `claude -p` with Agent Deck MCP → log to `.temporal/logs/` | 3 tickets run unattended with logs |
| **P1** | Linear poll + SQLite + plan approval gate + minimal dashboard (4 columns) | SC-1 through SC-4 |
| **P2** | Cursor local runner, worktree or artifact workspace isolation, action approval gates, artifact timeline | SC-5, SC-6 |
| **P3** | Lific adapter, parallelism tuning (2→3 if stable), playbook reflect loop | US-11 |

### Build vs borrow (layers)

| Layer | Recommendation |
|-------|----------------|
| Queue + spawn loop | Borrow patterns (Autoship lean / Botfarm SQLite) — days |
| **Audit DB + dashboard** | **Build** — moat |
| Agent runners | Thin `ClaudeRunner`, `CursorLocalRunner` — days each |
| Agent Deck wiring | Config + prompt — hours |
| Auto-merge / review pipeline | Defer; borrow from Botfarm/AO if needed later |

---

## 13. Open questions

| Question | v0 recommendation | Decide by |
|----------|-------------------|-----------|
| Plan author: human-only vs agent-draft → human edit? | **Agent-draft default** | P1 dogfooding |
| Playbook update: automatic reflect vs human-triggered only? | **Human-triggered** (US-11 button) | P3 |
| Single deployment for work + personal vs two instances? | **Single planner, runtime picker per run** | P2 |
| Cursor personal: one machine overnight vs cloud fallback? | **Local only in v0** | P2 |
| Exact parallelism after dogfooding? | **Start at 2**; allow 1 (conservative) or 3 (overnight) in settings | 2 weeks post-P1 |
| Lific vs Docket for v0.1? | **Lific first** | P3 planning |
| Email tasks in v0? | **Draft-only** in artifact workspace; no send without gate | P2 |
| Email MCP for v0.1? | TBD — Gmail/Outlook on execution deck | P3 planning |

---

## 14. Out of scope (v0)

- Auto-merge / auto-ship pipelines
- Cloud Cursor runs with Agent Deck
- Multi-user / team permissions / RBAC
- Merging agent-dealer into Agent Deck repo
- Workflow manifest runner (deferred in Agent Deck MVP too)
- Plane / Jira / GitHub Issues adapters (beyond research notes)
- Mobile dashboard

---

## 15. How to use this PRD

**Engineers:** Start at §12 MVP phasing (P0 script). Implement queue + SQLite before dashboard polish.

**AI codegen agents:** Load this file from `docs/PRD_V0.md`. Follow user stories (§3) and state machine (§5). Defer JSON Schema contracts until `packages/shared` exists — v0 PRD is prose-first for this greenfield repo.

**agent-dealer runs:** Do not assume any specific `deckId` or `playbookId`. Read user's selection from kick payload (US-5) or run record.

---

## Appendix D — Authoring this document (not product scope)

This PRD was drafted in Cursor using Agent Deck playbooks for **document generation only**:

| Playbook | Role in authoring |
|----------|-------------------|
| `pb_product_principle` | Voice, scope discipline, sourcing |
| `pb_ai_codegen_prd` | PRD section structure and checklist |

That pairing is **not** part of agent-dealer product requirements. Users of agent-dealer bring their own decks and playbooks.

---

## Appendix A — Glossary

| Term | Meaning |
|------|---------|
| **Run** | One agent-dealer queue item with full state machine lifecycle |
| **Task category** | `code` \| `communication` \| `email` \| `research` \| `content` \| `other` — drives default gates |
| **Artifact workspace** | Local folder for non-code task outputs (drafts, slides, research notes) |
| **Treasure** | Complete audit artifact chain for a run |
| **Plan mode** | Agent drafts execution plan before human approval |
| **Gate** | Human approval required before agent proceeds (task-level or action-level) |
| **Runner** | Adapter that spawns Claude Code or Cursor SDK for one run |
| **Bound deck** | Agent Deck session scope via `bind_workspace` — not agent-dealer concept |

---

## Appendix B — Related documents

- [Task Planner — Architecture.md](file:///Users/not_so_fat/workspace/Obsidian/lexicon-personal/Ideas/personal/Task%20Planner%20%E2%80%94%20Architecture.md) — architecture discussion source
- [Agent Deck MVP](https://github.com/not-so-fat/agent_deck/blob/main/docs/MVP.md) — sibling product scope (separate repo)
- [Agent Deck Playbooks vs Skills](https://github.com/not-so-fat/agent_deck/blob/main/docs/PLAYBOOKS_AND_SKILLS.md) — `update_playbook` after runs
- [ThreadKeeper](https://github.com/po4erk91/thread-keeper) — audit/thread lifecycle reference (not product template)

## Appendix C — Source notes

| Source | Captured as |
|--------|-------------|
| Obsidian Task Planner — Architecture.md | Product split, event-sourced DB, handoff contract |
| User discussion 2026-07-04 | Business users, concurrency 2, ThreadKeeper, Monaco |
| Authoring playbooks (doc only) | `pb_ai_codegen_prd`, `pb_product_principle` — not product defaults |
| Autoship, Symphony, Maestro, ThreadKeeper | §11 competitive borrow/reject |
| Agent Deck SETUP.md | Claude HTTP MCP `:11112` |
