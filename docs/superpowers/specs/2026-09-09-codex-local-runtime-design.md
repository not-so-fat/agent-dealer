# Design: `codex_local` runtime (NOT-49)

**Status:** draft for implementation
**Ticket:** [NOT-49](https://linear.app/not-so-fat/issue/NOT-49) (child of NOT-48)
**Date:** 2026-09-09

## Problem

agent-dealer can drive Claude Code and Cursor local CLIs. The developer–reviewer loop (NOT-48) also needs a first-class **local Codex CLI** runtime (`codex exec`), with phase sandboxes, JSONL transcripts, session resume, and Agent Deck availability — without Codex Cloud.

## Research summary (facts)

| Source | Finding | Confidence |
|--------|---------|------------|
| Local CLI `codex-cli 0.150.0-alpha.12.2` | `codex exec` supports `--json`, `-C/--cd`, `-s/--sandbox {read-only,workspace-write,danger-full-access}`, `--output-schema`, `-o`, `resume <SESSION_ID>`, `--dangerously-bypass-*` (forbidden in managed flows) | high (ran `--help`) |
| Official non-interactive docs | JSONL events include `thread.started` (`thread_id`), `turn.*`, `item.*`, `error`; default sandbox is read-only; resume via `codex exec resume` | high |
| agent-dealer codebase | No runtime plugin registry — Zod `Runtime` enum + `if (runtime === "cursor_local")` forks sharing `spawnCli` → NDJSON log → `persistRunOutput` | high |
| Persist contract | Expects Claude/Cursor-shaped events (`system.session_id`, `result`, assistant/tool frames) | high |
| Agent Deck × Codex | `agent-deck use` clients are `cursor\|claude\|both` only; this machine already enables Codex marketplace plugin `agent-deck@agent-deck-dev` | high |
| Strategy notes | `docs/CODEX_MARKETPLACE_STRATEGY.md` Option 1 matches this work; caps/send-gate differ from Claude flags | medium (dated 2026-07-18) |

## Approaches

### A — Procedural third fork (recommended)

Mirror Cursor: add `"codex_local"` to `Runtime`, `runCodex` + JSONL normalizer, wire `runAgent` / health / UI / seed agent.

- **+** Matches existing architecture; smallest diff; ships NOT-49 AC without blocking NOT-48
- **−** Another `if` branch; NOT-48 may still want a runner interface later

### B — Extract `AgentRunner` interface now

Introduce `plan` / `execute` / `qa` / `health` / `listModels` adapters and migrate Claude + Cursor while adding Codex.

- **+** Cleaner for NOT-48 multi-role orchestration
- **−** Large refactor unrelated to proving Codex works; high regression risk

### C — Spawn-only PoC without UI/enum

Probe script only.

- **+** Fast learning
- **−** Misses NOT-49 acceptance (selectable everywhere)

**Decision:** Approach A. Defer interface extraction to NOT-48 if sprawl becomes painful.

## Design

### Runtime identity

- Enum value: `codex_local`
- Builtin agent: `BUILTIN_AGENT_CODEX_ID` / name `Codex`
- Default model: omit CLI `--model` when unset (Codex user config default); UI fallback list pinned to common Codex models (e.g. `gpt-5.6-codex` / whatever `codex` reports — verify at implement time)

### Launch contract

```
codex exec --json -C <workspace> -s <sandbox> [-m <model>] [--output-schema <file>] [-o <last-message>] <prompt>
# fix / QA resume:
codex exec --json -C <workspace> -s <sandbox> … resume <sessionId> <prompt>
```

| Phase | Sandbox | Notes |
|-------|---------|--------|
| plan | `read-only` | Same prompts as other runtimes |
| execute | `workspace-write` | Optional `--add-dir` for temporal output if needed |
| qa | `read-only` | Resume execute session when available |
| reflect | **skip** (like Cursor) | Codex Deck plugin exists but reflect path stays Claude-only for now |

**Hard forbid:** `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust` in managed runner args.

### Transcript mapping

Normalize Codex JSONL → existing persist shapes **at the persist/QA read boundary** (keep extractors and `persistRunOutput` field writers stable). Raw stdout stays Codex JSONL on disk; `persistRunOutput` / `runQa` call `normalizeCodexEvents(parseCodexJsonl(raw))` when `runtime === "codex_local"`. Do **not** rewrite the log file to Claude-shaped NDJSON.

| Codex | Normalized |
|-------|------------|
| `thread.started.thread_id` | synthetic `system` + `session_id` |
| `item.*` agent_message / reasoning / command_execution / mcp | `assistant` / `thinking` / `tool_call`-like frames for `stream_trace` |
| last agent message or `-o` file | synthetic `result` string |
| `turn.completed.usage` | usage object (tokens; USD may be absent) |
| `turn.failed` / `error` | `result` with `is_error: true` |

Also persist last-message file when `-o` used.

### `--output-schema`

- Plumb writing a temp schema file + `--output-schema` + optional `-o`
- v1 use: optional structured plan/result when we already have a schema the dispatcher understands
- Shared **reviewer** schema is NOT-48 — do not invent the full review verdict schema here; expose the hook so NOT-48 can pass a schema path

### Resume

- Capture `thread_id` from normalized session (`agent_session` artifact)
- Execute retries with human feedback: auto-resume lineage parent execute session via `codex exec resume <sessionId>` (same rule as Claude: `humanFeedbackText` → `lineageParentExecuteSessionId`); use continuation prompt when resuming
- Explicit `opts.resumeSessionId` (plan revise, QA) still wins
- Reviewer rounds (NOT-48): fresh `exec` at pinned SHA — out of scope for this ticket’s orchestration, but runtime must support non-resume launches

### Health

- Resolve `codex` / `CODEX_CLI`; run `codex --version`
- Auth: detect missing auth via failed version/status or known login strings (mirror Cursor messaging)
- Deck-bound agents: if `deckId` set, verify Agent Deck online; for Codex, check plugin/MCP availability (config/plugin enabled or documented failure) — **not** `agent-deck use --client codex` (does not exist)

### Caps / send-gate / per-phase config (NOT-49 AC interpretation)

NOT-49 asks for model, reasoning effort, timeout, and sandbox policy configurable per phase. v1 mapping (explicit):

| Knob | v1 | Deferred |
|------|----|----------|
| Model | Existing per-phase `planModel` / `executeModel` on run/agent → `-m` | — |
| Sandbox | Fixed by phase: plan/qa `read-only`, execute `workspace-write` | Per-agent override UI |
| Timeout | Existing `*_TIMEOUT_MS` env / `timeoutMsForMode` | Per-phase UI |
| Reasoning effort | Omit (Codex user/config default) | Wire `-c` / profile when product needs it |
| Soft send-gate | No Claude-style `--disallowedTools` on Codex; do **not** block NOT-49 on parity | Optional gate MCP / Codex interception (see `docs/CODEX_MARKETPLACE_STRATEGY.md`) |

### Agent Deck binding (NOT-49 AC interpretation)

Ticket says “workspace Codex MCP configuration.” `agent-deck use` has no `--client codex`. v1: require Agent Deck online when `deckId` is set; Codex reaches Deck via the marketplace plugin (`agent-deck@…` in `~/.codex`). Fail clearly on deck offline. Do not invent workspace `.mcp.json` for Codex until Deck supports a Codex client pin.

### Reviewer structured schema (NOT-49 AC interpretation)

“Reviewer … validated against the shared review schema” is owned by **NOT-48** (parent workflow). NOT-49 plumbs `--output-schema` so NOT-48 can pass a schema path; it does **not** define the review verdict schema.

### Testing

Unit tests (no live spawn in CI) — map to NOT-49 AC test bullets:

| AC test bullet | Coverage |
|----------------|----------|
| Argument construction | `codex-args.test.ts` (sandbox, `--cd`, `--json`, resume, schema/`-o`, no danger) |
| JSONL parsing + session-ID capture | `codex-jsonl.test.ts` (`thread.started` → `system.session_id`) |
| Structured-output validation | Arg plumbing for `--output-schema` in Task 3; fixture asserting schema path is passed. Full schema-validated final JSON against a reviewer schema → **NOT-48** (quote: “shared review schema”) |
| Non-zero exits | Normalizer `turn.failed` / `error` → `result.is_error`; persist already treats `exitCode !== 0` |
| Cancellation | Reuse `spawnCli` timeout → `killRunProcess` (same process-registry path as Claude/Cursor); unit coverage is registry/kill existing tests + argv never blocks cancel |
| Resume | `buildCodexExecArgs` resume argv order; QA/execute pass `resumeSessionId` |

PoC script under `scripts/poc/` optional for manual smoke (like cursor/claude probes).

### UI / API surfaces

Anywhere runtime is chosen or displayed: Agents select, models endpoint, connections bar, icons/labels, QA allowlist, dispatcher typing.

Also document Codex in `docs/AGENT_PROFILES.md` wherever Claude/Cursor permissions, health, or user-story runtime lines appear.

## Out of scope (NOT-48 / later)

- Developer–reviewer parent workflow
- Reviewer result schema + GitHub publish
- Full AgentRunner interface extraction
- Codex Cloud
- `agent-deck use --client codex` (Deck product change)

## Open hypotheses

1. Token usage fields in `turn.completed` are sufficient for the usage artifact; USD may stay null.
2. Marketplace plugin `agent-deck@agent-deck-dev` is enough for deck-required runs without writing workspace `.mcp.json`.
3. Plan triage markdown extraction still works if we put final agent text into synthetic `result` (schema optional for v1 plans).
