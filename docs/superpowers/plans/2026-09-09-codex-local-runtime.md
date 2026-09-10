# Codex Local Runtime (`codex_local`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `codex_local` runtime so agent-dealer can plan, execute, QA, cancel, and resume via local `codex exec --json`, selectable anywhere Claude Code / Cursor are today.

**Architecture:** Procedural third fork beside Cursor: extend the `Runtime` enum, add `runCodex` + Codex JSONL→persist normalizer, wire health/models/UI/seed agent. Keep `persistRunOutput` unchanged by normalizing events before persist.

**Tech Stack:** TypeScript monorepo, Zod (`packages/shared`), Fastify server (`packages/server`), React web (`apps/web`), `node:test` via `tsx --test`, local Codex CLI (`codex exec`).

**Source spec:** `docs/superpowers/specs/2026-09-09-codex-local-runtime-design.md` · Linear NOT-49

## Global Constraints

- Never pass `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, or `--dangerously-bypass-hook-trust` from managed runners.
- Plan/QA sandbox = `read-only`; execute sandbox = `workspace-write`.
- Normalize Codex JSONL to Claude-compatible session/result shapes before `persistRunOutput`.
- Reflect stays Claude-only (skip Codex like Cursor).
- Do not implement NOT-48 developer–reviewer orchestration or the shared review verdict schema in this plan.
- Tests: `npm run build -w @agent-dealer/shared && npx tsx --test <path>`; full unit: `npm run test:unit`.
- Do not commit unless the user asks.

---

## File Structure

**Create:**
- `packages/server/src/runners/codex-args.ts` — argv builder + sandbox policy
- `packages/server/src/runners/codex-args.test.ts`
- `packages/server/src/runners/codex-jsonl.ts` — parse/normalize Codex JSONL
- `packages/server/src/runners/codex-jsonl.test.ts`
- `packages/server/src/runners/codex.ts` — `runCodex` (uses shared `spawnCli` export or duplicate thin wrapper — prefer exporting `spawnCli`/`logPathFor`/`timeoutMsForMode` from `claude.ts` only if clean; otherwise keep spawn private and call from same file patterns)
- `scripts/poc/codex-exec-probe.ts` — optional manual smoke

**Modify:**
- `packages/shared/src/runtime.ts` — add `codex_local`
- `packages/shared/src/agents.ts` — `BUILTIN_AGENT_CODEX_ID`, optional `CODEX_DEFAULT_MODEL`
- `packages/server/src/cli-env.ts` — `resolveCodexBin`, `codexBinExists`
- `packages/server/src/cli-env.test.ts`
- `packages/server/src/runners/claude.ts` — `runAgent` branch; export helpers if needed; `runCodex` import
- `packages/server/src/runners/stream-json.ts` — optionally accept already-normalized events only (prefer no change if normalizer emits `system.session_id`)
- `packages/server/src/runners/models.ts` — Codex model list / fallback
- `packages/server/src/adapters/agent-health.ts` — Codex CLI + auth + deck messaging
- `packages/server/src/db/index.ts` — seed Codex builtin agent
- `packages/server/src/queue/dispatcher.ts` — widen `runtimeFor` type
- `packages/server/src/queue/result-qa.ts` / `runners/qa.ts` — add `codex_local` to `QA_RUNTIMES`
- `packages/server/src/repository/runs.ts` — default model handling if any Cursor special-case
- `apps/web/src/AgentConfigFields.tsx` — option
- `apps/web/src/lib/display.ts`, `components/agents/AgentIcon.tsx`, `AgentConnectionsBar.tsx` — label/logo/status
- `apps/web/src/components/intake/ManualTaskForm.tsx` — default model if needed
- `docs/PRD_V0.md` or `docs/AGENT_PROFILES.md` — one-line runtime note if those docs list runtimes

---

### Task 1: Shared `Runtime` + builtin agent constants

**Files:**
- Modify: `packages/shared/src/runtime.ts`
- Modify: `packages/shared/src/agents.ts`
- Modify: `packages/server/src/db/index.ts`

**Interfaces:**
- Produces: `Runtime` includes `"codex_local"`; `BUILTIN_AGENT_CODEX_ID = "00000000-0000-4000-a000-000000000003"`

- [ ] **Step 1: Extend enum and constants**

```ts
// runtime.ts
export const Runtime = z.enum(["claude_code", "cursor_local", "codex_local"]);

// agents.ts
export const BUILTIN_AGENT_CODEX_ID = "00000000-0000-4000-a000-000000000003";
```

- [ ] **Step 2: Seed builtin agent**

In `seedBuiltinAgents`, `INSERT OR IGNORE` Codex with runtime `codex_local`.

- [ ] **Step 3: Build shared package**

Run: `npm run build -w @agent-dealer/shared`  
Expected: success

---

### Task 2: Resolve Codex binary

**Files:**
- Modify: `packages/server/src/cli-env.ts`
- Modify: `packages/server/src/cli-env.test.ts`

**Interfaces:**
- Produces: `resolveCodexBin(): string`, `codexBinExists(): boolean`  
- Env override: `CODEX_CLI` (mirror `CLAUDE_CLI` / `CURSOR_CLI`)

- [ ] **Step 1: Failing tests** for env override and PATH fallback (`codex`)

- [ ] **Step 2: Implement** `resolveCodexBin` / `codexBinExists`

- [ ] **Step 3: Run** `npx tsx --test packages/server/src/cli-env.test.ts` → PASS

---

### Task 3: Codex argv builder (sandboxes, resume, forbid danger)

**Files:**
- Create: `packages/server/src/runners/codex-args.ts`
- Create: `packages/server/src/runners/codex-args.test.ts`

**Interfaces:**
- Produces:

```ts
export type CodexPhaseMode = "plan" | "execute" | "qa";
export function codexSandboxForMode(mode: CodexPhaseMode): "read-only" | "workspace-write";
export function buildCodexExecArgs(opts: {
  mode: CodexPhaseMode;
  workspaceRoot: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
  addDirs?: string[];
}): string[];
```

Arg shape:
- Fresh: `["exec", "--json", "-C", workspace, "-s", sandbox, ...optional, prompt]`
- Resume: `["exec", "--json", "-C", workspace, "-s", sandbox, ...optional, "resume", sessionId, prompt]`

- [ ] **Step 1: Write tests** asserting plan→`read-only`, execute→`workspace-write`, resume order, `--output-schema` / `-o` when set, and that joined argv never contains `danger-full-access` or `dangerously-bypass`

- [ ] **Step 2: Implement** `buildCodexExecArgs`

- [ ] **Step 3: Run tests** → PASS

---

### Task 4: Codex JSONL normalizer

**Files:**
- Create: `packages/server/src/runners/codex-jsonl.ts`
- Create: `packages/server/src/runners/codex-jsonl.test.ts`

**Interfaces:**
- Produces:

```ts
export function parseCodexJsonl(raw: string): Record<string, unknown>[];
export function normalizeCodexEvents(events: Record<string, unknown>[]): Record<string, unknown>[];
export function extractCodexThreadId(events: Record<string, unknown>[]): string | undefined;
export function extractCodexResultText(events: Record<string, unknown>[]): string | undefined;
```

Normalization rules (minimum):
1. On `thread.started` with `thread_id`, emit `{ type: "system", session_id: thread_id }`
2. On completed `agent_message` items, emit assistant/result-compatible text frames; ensure a final `{ type: "result", result: text }`
3. On `turn.failed` / `error`, emit `{ type: "result", is_error: true, result: message }`
4. On `turn.completed` with `usage`, attach usage onto the result or a dedicated usage-bearing event `extractUsage` already understands — if current `extractUsage` only reads Claude shapes, extend `extractUsage` **or** emit a compatible usage field on `result`

- [ ] **Step 1: Fixture tests** with sample JSONL from docs (`thread.started`, `item.completed` agent_message, `turn.completed` usage, `turn.failed`)

- [ ] **Step 2: Implement normalizer**

- [ ] **Step 3: Assert** `extractSessionId(normalizeCodexEvents(...))` works if events are fed through existing extractor — either by emitting `system.session_id` or by teaching `extractSessionId` to read `thread.started` (prefer emit)

---

### Task 5: `runCodex` + wire `runAgent`

**Files:**
- Create: `packages/server/src/runners/codex.ts`
- Modify: `packages/server/src/runners/claude.ts` (`runAgent`)
- Modify: `packages/server/src/queue/dispatcher.ts` (types)
- Modify: `packages/server/src/runners/qa.ts` and/or `queue/result-qa.ts` (`QA_RUNTIMES`)

**Interfaces:**
- Produces: `runCodex(run, mode, model?, opts?) => Promise<RunnerResult>`  
- `runAgent`: if `runtime === "codex_local"` → `runCodex`  
- QA allowlist includes `codex_local`

Implementation notes:
- Reuse `spawnCli` from `spawn-cli.ts` (shared with Claude/Cursor).
- Write raw Codex JSONL stdout to the log path.
- **Normalize only at read/persist:** `persistRunOutput` and `runQa` call `normalizeCodexEvents(parseCodexJsonl(raw))` when `runtime === "codex_local"` (see Task 6). Do not add a separate dispatcher `loadEventsForPersist` helper unless persist is split later.

- [ ] **Step 1: Export spawn helpers; implement `runCodex`**

- [ ] **Step 2: Wire `runAgent` + QA allowlist + dispatcher types**

- [ ] **Step 3: Unit-test argv path via `buildCodexExecArgs` already covered; add a thin test that `runAgent` selects Codex when runtime set (mock if spawn is hard — at minimum typecheck + QA allowlist test update like `result-qa.test.ts`)**

---

### Task 6: Persist path uses normalizer for Codex

**Files:**
- Modify: `packages/server/src/runners/persist.ts` and/or dispatcher call sites that `parseNdjsonFile`

**Interfaces:**
- When `run.runtime === "codex_local"`, events = `normalizeCodexEvents(parseCodexJsonl(raw))` before extractors.

- [ ] **Step 1: Find all persist entry points** (`persistRunOutput`, QA persist)

- [ ] **Step 2: Branch on runtime; add test with fixture log → session id + result text extracted**

---

### Task 7: Health + models

**Files:**
- Modify: `packages/server/src/adapters/agent-health.ts`
- Modify: `packages/server/src/runners/models.ts`

**Interfaces:**
- Health: missing bin → `cli_missing`; auth failure strings → `runtime_auth`; deck-bound Codex: online check + message pointing at Codex Agent Deck plugin (not `use --client codex`)
- Models: fallback list (at least empty-with-fallback or pinned ids discovered via `codex` help/models if available); `source: "fallback"` acceptable for v1

- [ ] **Step 1: Implement health branch for `codex_local`**

- [ ] **Step 2: Implement `listRuntimeModels` / fetch branch**

- [ ] **Step 3: Smoke** `GET` models path compiles; unit test fallback non-empty or explicitly empty-allowed

---

### Task 8: UI selection surfaces

**Files:**
- Modify: `apps/web/src/AgentConfigFields.tsx`
- Modify: `apps/web/src/lib/display.ts` (if runtime labels live there)
- Modify: `apps/web/src/components/agents/AgentIcon.tsx`
- Modify: `apps/web/src/components/agents/AgentConnectionsBar.tsx`
- Modify: `apps/web/src/components/intake/ManualTaskForm.tsx` as needed

- [ ] **Step 1: Add `<option value="codex_local">Codex local (codex exec)</option>`**

- [ ] **Step 2: Logo/label/connections status for Codex (simple monogram OK if no asset)**

- [ ] **Step 3: Typecheck web** `npm run build -w @agent-dealer/web` or project’s usual web check

---

### Task 9: Docs + optional PoC probe

**Files:**
- Modify: runtime docs that list Claude/Cursor (`docs/AGENT_PROFILES.md` and/or `docs/PRD_V0.md` — only if they enumerate runtimes)
- Create: `scripts/poc/codex-exec-probe.ts` (manual; documents expected argv)

- [ ] **Step 1: Doc one-liner**

- [ ] **Step 2: PoC script that prints argv and optionally runs `codex exec --json` ephemeral prompt if `RUN_POC=1`

---

### Task 10: Verification

- [ ] **Step 1:** `npm run test:unit` (or targeted runner tests) — all pass

- [ ] **Step 2:** `npm run build` workspaces that typecheck shared+server+web

- [ ] **Step 3:** Manual: Agents UI shows Codex; health shows CLI version or actionable error when missing

- [ ] **Step 4:** If Codex authed on machine: one plan-mode dry run against a throwaway workspace (optional evidence under `.temporal/logs/`)

---

## Spec coverage checklist

| NOT-49 / design requirement | Task |
|----------------------------|------|
| `codex_local` selectable | 1, 8 |
| Resolve CLI + health errors | 2, 7 |
| `codex exec --json --cd` | 3, 5 |
| Sandbox by phase; no danger | 3 |
| JSONL → run/transcript model | 4, 6 |
| Session from `thread.started`; resume | 4, 5 |
| `--output-schema` support | 3 (plumb); reviewer schema → NOT-48 |
| Cancel/timeout via process registry | 5 (reuse `spawnCli` / `killRunProcess`) |
| Tests: args / JSONL / session / resume | 3, 4 |
| Tests: structured-output path flag | 3 (`--output-schema` in argv); schema body validation → NOT-48 |
| Tests: non-zero / failed turn mapping | 4 (`turn.failed` → `is_error`) |
| Tests: cancellation | existing process-registry + shared `spawnCli` timeout path |
| Agent Deck binding clarity | 7 (plugin path; no `use --client codex`) |
| Lens preserved as product gate | unchanged (orchestration NOT-48) |

## Self-review notes

- No TBD placeholders in tasks.
- Resume argv order matches local `codex exec --help` (`resume` subcommand under `exec`).
- Send-gate parity explicitly deferred (design § caps/send-gate).
