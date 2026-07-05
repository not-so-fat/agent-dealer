# Integration PoC findings

Prerequisite validation before building Intake, Cursor runner, or richer Operations UX.

**Last validated:** 2026-07-04 (Claude + Cursor live; Linear API OK)

## Summary

| System | Status | Auth | Cost pool |
|--------|--------|------|-----------|
| **Linear API** | OK | `LINEAR_API_KEY` in `.env` | Linear billing (separate) |
| **Agent Deck** | OK | local HTTP / MCP | N/A |
| **Cursor CLI** | **OK** | `cursor agent login` + `--trust` for subprocess | Cursor Pro usage pools |
| **Claude CLI** | **OK** | `claude login` (Pro) — **no API key needed** | Pro plan usage limits |

---

## Cost & billing (Pro plans)

### Cursor Pro — how agent-dealer runs are charged

Cursor Pro is **not unlimited for all agent usage**. Billing uses **two pools** (individual plans):

| Pool | What draws from it | agent-dealer impact |
|------|-------------------|----------------------|
| **Auto + Composer** | `model: Auto`, Composer 1.5 | PoC plan phase used **Auto** — likely this pool |
| **API** | Manually selected frontier models (Claude Sonnet, GPT-5, etc.) | ~**$20/month included**, then on-demand if enabled |

**Practical notes:**

- `cursor agent -p` subprocesses bill against **your Cursor account**, same as IDE agent chat.
- Stream-json `result.usage` gives token counts (`inputTokens`, `outputTokens`, `cacheReadTokens`) — **no USD field** in CLI output; track in [cursor.com/dashboard](https://cursor.com/dashboard) → Billing.
- **On-demand overage** is optional; disable or set a spend cap if you don't want surprise bills after the included pool.
- **Non-interactive requirement:** pass `--trust` (or `-f`) when agent-dealer spawns `cursor agent` — otherwise workspace-trust prompt blocks headless runs.

**PoC sample (Cursor, minimal):** ~7.7k input + 52 output tokens, 1.6s.

### Claude Pro — how agent-dealer runs are charged

Claude Code has **two auth routes** with different billing:

| Route | How to activate | Billing |
|-------|-----------------|---------|
| **Subscription (recommended for you)** | `claude login` → Pro/Max | Counts against **plan usage limits** (5-hour / weekly caps) |
| **API key** | `ANTHROPIC_API_KEY` env var set | **Pay-as-you-go API rates** — overrides subscription |

**Critical for agent-dealer:** Do **not** put `ANTHROPIC_API_KEY` in `.env` unless you intentionally want API billing. If set, Claude Code **always prefers the API key** over your Pro login, even for `claude -p` subprocesses spawned by the server.

**`claude login` is enough** for agent-dealer on a dev machine:

- Verified: `claude auth status` → `loggedIn: true`, `subscriptionType: pro`, `authMethod: claude.ai`
- Verified: `npx tsx .temporal/scripts/poc/claude-runner-probe.ts` → plan + execute both exit 0
- Init event shows `apiKeySource: "none"` (subscription session, not API key)
- `rate_limit_event` in stream-json tracks plan limits (`rateLimitType: five_hour`, `overageStatus: rejected` when overage disabled)

**Stream-json cost fields (Claude):**

- `result.total_cost_usd` — informational estimate (e.g. plan PoC ≈ **$0.07** for one turn with Sonnet + context)
- `result.usage` — token breakdown including cache read/write
- For subscribers, `/usage` in interactive CLI shows plan bars; subprocess cost still accumulates against limits

**Headless `claude -p`:** Uses the same OAuth session stored locally after `claude login` (typically under `~/.claude/`). The agent-dealer server inherits this when run as **the same OS user** — no API key in env required.

**When you *would* need an API key:**

- CI/CD, headless server **without** interactive login
- Deliberate API billing / team Console budgets
- Remote machine where OAuth session isn't present

**agent-dealer should store per run:** `total_cost_usd`, token usage from `result` event, and `rate_limit_event` status for ops visibility.

---

## Linear (intake candidates)

- `.env`: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_STATE_FILTER="Todo,In Progress,Backlog"`
- GraphQL poll works; **current inbox: 0** (team only has Canceled onboarding issues)
- PoC: `npx tsx .temporal/scripts/poc/linear-inbox.ts`

---

## Cursor agent (`cursor agent -p`)

### Command shape (validated)

```bash
cursor agent -p --trust --output-format stream-json --stream-partial-output "<prompt>"
cursor agent -p --trust --resume <session_id> "<follow-up prompt>"
```

### Auth & subprocess feasibility

| Requirement | Detail |
|-------------|--------|
| Login | `cursor agent login` once per machine (verified: logged in as user email) |
| Headless | **`--trust` required** — without it, stderr shows workspace trust prompt and no stream-json |
| Same user | Server subprocess must run as the user who logged in |
| API key | **Not used** — `apiKeySource: "login"` in init event |

### Stream-json event types (observed)

| type | role |
|------|------|
| `system` (init) | `session_id`, `model`, `cwd`, `apiKeySource` |
| `user` | echoed prompt |
| `thinking` | reasoning deltas (`subtype: delta` / `completed`) — **Cursor-specific** |
| `assistant` | text deltas (many partial events with `--stream-partial-output`) |
| `tool_call` | tool invocations during plan phase |
| `result` | final `result`, `duration_ms`, `usage` (tokens) |

Logs: `.temporal/logs/poc-cursor-*.ndjson`  
Report: `.temporal/logs/poc-cursor-probe-report.json`

### Plan → execute continuity

1. **Prompt carryover (v0 default):** two separate processes; execute prompt includes `## Approved plan` + feedback. Validated → `EXEC_POC_OK`.

2. **Session resume (optional):** `--resume <session_id>` after plan. Validated → `RESUME_POC_OK`, same session.

**Recommendation:** store `cursor_session { sessionId }` on run; try `--resume` on kick, fall back to prompt carryover.

### What to store

| Artifact | Content |
|----------|---------|
| `draft_plan` / `approved_plan` | `{ markdown }` from `result` or assistant text |
| `transcript` | `{ excerpt }` + `blob_path` → full NDJSON |
| `cursor_session` | `{ sessionId }` from init |
| `usage` | token counts from `result.usage` |
| `feedback` | human retry text — inject into execute prompt (**not wired yet**) |

### Thought process / outcomes in UI

- Replay NDJSON: `thinking` → `assistant` stream → `tool_call` timeline
- Outcome: `result.result` + exit code
- Partial streaming: append assistant chunks, don't replace

---

## Claude Code (`claude -p`)

### Command shape (same as server runner)

```bash
claude -p "<prompt>" --mcp-config ~/.claude.json \
  --output-format stream-json --verbose \
  --max-turns N --max-budget-usd N
```

Plan mode adds: `--allowedTools Read,Glob,Grep,...mcp__agent-deck__*`

### Auth & subprocess feasibility

| Requirement | Detail |
|-------------|--------|
| Login | **`claude login` is sufficient** on dev machine — verified after user login |
| No API key | Keep `ANTHROPIC_API_KEY` **unset** in `.env` and shell |
| MCP config | `~/.claude.json` (or `CLAUDE_MCP_CONFIG`) — agent-deck MCP connected in PoC |
| Same user | Server must spawn `claude` as the logged-in OS user |
| Budget cap | `--max-budget-usd` limits a single run; still counts toward plan limits |

### Stream-json event types (observed, live)

| type | role |
|------|------|
| `system` (init) | `session_id`, `tools`, `mcp_servers`, `model`, `apiKeySource` |
| `rate_limit_event` | plan limit status (`five_hour`, overage on/off) |
| `assistant` | `thinking` + `text` blocks, `tool_use` when tools run |
| `result` | `result`, `total_cost_usd`, `usage`, `modelUsage`, `num_turns` |

When auth fails: `authentication_failed`, exit 1, `total_cost_usd: 0`.

### Plan → execute (validated)

Two-process model in `packages/server/src/runners/claude.ts`:

- Plan: read-only tools + deck MCP → markdown plan artifact
- Execute: full tools; prompt = task + `approved_plan` (+ feedback TBD)
- v0 does **not** use `--resume`; context via artifacts

PoC: plan exit 0 (real markdown), execute exit 0 (`EXEC_POC_OK`).

### What to store

| Artifact | Content |
|----------|---------|
| `draft_plan` / `approved_plan` | `{ markdown }` — strip ```markdown fences on save |
| `transcript` | excerpt + NDJSON blob |
| `claude_session` (optional) | `session_id` if we add `--resume` later |
| `usage` | `total_cost_usd`, tokens, `rate_limit_event` snapshot |
| `feedback` | inject on retry (**gap**) |

### Thought process / outcomes in UI

- `assistant` blocks: `thinking` (extended thinking tokens = output cost), `text`, `tool_use`
- No separate “reasoning” field — parse NDJSON
- `total_cost_usd` useful for ops dashboard even on Pro (informational + limit planning)

---

## agent-dealer architecture implications

### Kicking processes

Both runtimes are **local CLI subprocesses** spawned by the server queue:

```
POST /api/runs/:id/kick → dispatcher → spawn(claude|cursor, args)
```

Neither requires an API key in `.env` when the human has done CLI login on that machine. agent-dealer is feasible as a **local control plane** on the developer's workstation.

**Not feasible without extra setup:** unattended server on a machine with no OAuth session (needs API key or headless auth strategy).

### Cost visibility in product

Store from each run's `result` event:

- **Claude:** `total_cost_usd`, input/output/cache tokens, `rate_limit_event`
- **Cursor:** token usage only — link user to Cursor dashboard for dollar tracking

Surface in run drawer: estimated cost, limit warnings, link to `/usage` equivalents.

### Build order

1. ~~Unblock Claude~~ — done via `claude login`
2. **Cursor runner** — mirror `claude.ts`, `--trust`, store `session_id`, optional `--resume`
3. **Inject feedback** into both runners' execute prompts
4. **Persist usage** from stream-json `result` on each run
5. **Intake screen** — Linear inbox → promote (not auto-create)
6. **Transcript viewer** — Cursor `thinking`/`tool_call`, Claude `thinking`/`tool_use`

---

## Commands

```bash
npm run poc:integration          # quick smoke (linear, deck, claude-minimal, cursor --quick)
npm run poc:deep                 # full claude + cursor plan/execute probes
npx tsx .temporal/scripts/poc/claude-runner-probe.ts
npx tsx .temporal/scripts/poc/cursor-agent-probe.ts   # add --quick for smoke only
```

**Pre-flight checks:**

```bash
claude auth status               # loggedIn: true, subscriptionType: pro
cursor agent status              # logged in
# ensure ANTHROPIC_API_KEY is NOT set if using Pro subscription
```
