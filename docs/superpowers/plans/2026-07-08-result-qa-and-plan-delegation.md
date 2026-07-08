# Result Q&A Thread & Explicit Plan Delegation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer ask the agent questions about a finished result without paying for a re-execution, and turn "approve a plan that still has open questions" into an explicit, auditable delegation instead of silent information loss.

**Architecture:** A new `qa` run phase reuses the existing `claude -p` runner with `--resume <execute sessionId>` and a read-only tool allowlist, so the agent answers from the working memory of the run that produced the result. Each exchange is an append-only `result_qa` artifact (latest artifact per `exchangeId` wins). Answered exchanges are injected into the retry execution prompt automatically. Separately, approving a plan while triage questions are still open persists a `plan_answers` record with the new `delegated` outcome, and the execution prompt renders those questions under `## Unanswered plan questions`.

**Tech Stack:** TypeScript monorepo (npm workspaces), zod (`packages/shared`), Fastify + better-sqlite3 (`packages/server`), React + Tailwind (`apps/web`), `node:test` via `tsx --test`.

**Source spec:** `docs/superpowers/specs/2026-07-07-result-qa-and-plan-delegation-design.md`

## Global Constraints

- Zod schemas in `packages/shared/src` are the single runtime source of truth. Every new schema gets a matching `export type` via `z.infer`.
- No new run statuses. Q&A never changes `run.status`; a failed Q&A never fails the run.
- Artifacts are append-only. Never mutate a `result_qa` row — append a new artifact with the same `exchangeId`. (`updateArtifactContent` exists but is reserved for `plan_triage.consumed`.)
- QA phase budget is fixed at `{ maxTurns: 6, maxBudgetUsd: 0.25 }` — not user-configurable in v1.
- QA tool allowlist is read-only: `Read,Glob,Grep,Skill`. No `Write`, `Edit`, or `Bash`. `--disallowedTools mcp__agent-deck__call_service_tool` still applies.
- Q&A requires the `claude_code` runtime (only runtime with `--resume`). Other runtimes get HTTP 409.
- Run tests with `npm run test:unit` from the repo root (builds `@agent-dealer/shared` first, then `tsx --test`). A single file: `npm run build -w @agent-dealer/shared && npx tsx --test <path>`.
- Do NOT commit per task. Per user's global instruction, defer to a single commit at the end (Task 11). Each task's "Commit" step is therefore replaced by "Stage".
- Deviation from spec, deliberate: the spec's testing section says flow-verify gates run "runner mocked at the boundary". `scripts/flow-verify.ts` is actually an API-contract smoke against a live server. So runner-level behavior is covered by `node:test` unit tests with an injected runner (the `submitPlanAnswers(..., { onRedraft })` pattern), and flow-verify only gains HTTP contract gates.

---

## File Structure

**Create:**
- `packages/shared/src/result-qa.ts` — `ResultQaContent`, `ResultQaInput`, `QA_PHASE_BUDGET`, `latestQaExchanges()`
- `packages/shared/src/result-qa.test.ts` — schema + dedupe tests
- `packages/server/src/repository/result-qa.ts` — read helpers over the artifacts table
- `packages/server/src/runners/qa.ts` — `runQa()` runner wrapper + NDJSON parse
- `packages/server/src/queue/result-qa.ts` — `askResultQuestion()` orchestration
- `packages/server/src/queue/result-qa.test.ts` — orchestration tests with injected runner
- `packages/server/src/queue/plan-delegation.ts` — `recordPlanDelegation()`
- `packages/server/src/queue/plan-delegation.test.ts`
- `packages/server/src/usage-summary.test.ts` — Q&A usage line label
- `apps/web/src/components/drawer/ResultQaThread.tsx` — the thread UI

**Modify:**
- `packages/shared/src/index.ts` — `ArtifactKind` += `result_qa`; `RunPhase` += `qa`; `PlanAnswersContent.outcome` += `delegated`; re-export `./result-qa.js`
- `packages/server/src/usage-summary.ts` — label + budget guard for the `qa` phase
- `packages/server/src/runners/persist.ts` — budget guard for the `qa` phase
- `packages/server/src/runners/claude-args.ts` — `qa` mode, read-only allowlist
- `packages/server/src/runners/claude.ts` — `qa` mode, fixed QA budget
- `packages/server/src/runners/claude.test.ts` — QA allowlist assertions
- `packages/server/src/runners/run-context.ts` — `reviewQaPairs()`
- `packages/server/src/runners/prompts.ts` — `buildQaPrompt()`, `## Review Q&A`, `## Unanswered plan questions`
- `packages/server/src/runners/prompts.test.ts` — prompt assertions
- `packages/server/src/routes/index.ts` — `POST /api/runs/:id/qa`; delegation on the plan-approve path
- `apps/web/src/api.ts` — `askResultQuestion()`, `ResultQaContent` re-export
- `apps/web/src/components/drawer/ResultReviewPanel.tsx` — mount thread, poll while pending
- `apps/web/src/components/drawer/DoneReviewPanel.tsx` — mount thread, poll while pending
- `apps/web/src/components/drawer/PlanReviewPanel.tsx` — relabel approve when questions are open
- `scripts/flow-verify.ts` — QA contract gates
- `CHANGELOG.md`

---

### Task 1: Shared contracts for `result_qa`

**Files:**
- Create: `packages/shared/src/result-qa.ts`
- Create: `packages/shared/src/result-qa.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `ResultQaContent` (type + schema), `ResultQaStatus`, `ResultQaInput`, `QA_PHASE_BUDGET: { maxTurns: number; maxBudgetUsd: number }`, `latestQaExchanges(contents: ResultQaContent[]): ResultQaContent[]`. Adds `"result_qa"` to `ArtifactKind` and `"qa"` to `RunPhase`. Adds `"delegated"` to `PlanAnswersContent.outcome`.

Note on the spec: the spec's `result_qa` shape omits an `error` field. We add `error?: string` because a `failed` status with no reason is useless to the UI. Everything else matches the spec exactly.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/result-qa.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultQaContent, ResultQaInput, QA_PHASE_BUDGET, latestQaExchanges } from "./result-qa.js";

const base = {
  exchangeId: "x1",
  question: "Why did you pick SQLite?",
  status: "pending" as const,
  sessionResumed: true,
  askedAt: "2026-07-08T00:00:00.000Z",
};

test("pending exchange parses without an answer", () => {
  const parsed = ResultQaContent.parse(base);
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.answer, undefined);
});

test("answered exchange keeps answer and answeredAt", () => {
  const parsed = ResultQaContent.parse({
    ...base,
    status: "answered",
    answer: "Because the run is single-process.",
    answeredAt: "2026-07-08T00:01:00.000Z",
  });
  assert.equal(parsed.answer, "Because the run is single-process.");
});

test("failed exchange carries an error", () => {
  const parsed = ResultQaContent.parse({ ...base, status: "failed", error: "exit 1" });
  assert.equal(parsed.error, "exit 1");
});

test("empty question is rejected", () => {
  assert.throws(() => ResultQaInput.parse({ question: "" }));
});

test("question over 2000 chars is rejected", () => {
  assert.throws(() => ResultQaInput.parse({ question: "x".repeat(2001) }));
});

test("QA budget is the fixed v1 cap", () => {
  assert.deepEqual(QA_PHASE_BUDGET, { maxTurns: 6, maxBudgetUsd: 0.25 });
});

test("latestQaExchanges keeps the newest artifact per exchangeId, ordered by askedAt", () => {
  const pending = ResultQaContent.parse({ ...base, exchangeId: "x2", askedAt: "2026-07-08T00:05:00.000Z" });
  const first = ResultQaContent.parse(base);
  const firstAnswered = ResultQaContent.parse({
    ...base,
    status: "answered",
    answer: "A",
    answeredAt: "2026-07-08T00:02:00.000Z",
  });
  // artifacts arrive oldest-first; the second x1 supersedes the first
  const out = latestQaExchanges([first, firstAnswered, pending]);
  assert.equal(out.length, 2);
  assert.equal(out[0].exchangeId, "x1");
  assert.equal(out[0].status, "answered");
  assert.equal(out[1].exchangeId, "x2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/shared/src/result-qa.test.ts`
Expected: FAIL — `Cannot find module './result-qa.js'`

- [ ] **Step 3: Write the schema module**

Create `packages/shared/src/result-qa.ts`:

```ts
import { z } from "zod";

export const ResultQaStatus = z.enum(["pending", "answered", "failed"]);
export type ResultQaStatus = z.infer<typeof ResultQaStatus>;

/** result_qa artifact contentJson. Append-only: latest artifact per exchangeId wins. */
export const ResultQaContent = z.object({
  exchangeId: z.string().min(1),
  question: z.string().min(1).max(2000),
  answer: z.string().optional(),
  status: ResultQaStatus,
  /** false when the execute session was gone and the answer came from artifacts. */
  sessionResumed: z.boolean(),
  askedAt: z.string(),
  answeredAt: z.string().optional(),
  error: z.string().optional(),
});
export type ResultQaContent = z.infer<typeof ResultQaContent>;

/** POST /api/runs/:id/qa body. */
export const ResultQaInput = z.object({
  question: z.string().min(1).max(2000),
});
export type ResultQaInput = z.infer<typeof ResultQaInput>;

/** Fixed v1 cap — answering is cheaper than planning (half the plan-draft cap). */
export const QA_PHASE_BUDGET = { maxTurns: 6, maxBudgetUsd: 0.25 } as const;

/** Collapse append-only exchanges: last artifact per exchangeId, ordered by askedAt. */
export function latestQaExchanges(contents: ResultQaContent[]): ResultQaContent[] {
  const byId = new Map<string, ResultQaContent>();
  for (const c of contents) byId.set(c.exchangeId, c);
  return [...byId.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}
```

- [ ] **Step 4: Extend the shared index**

In `packages/shared/src/index.ts`, add the re-export next to the other `export *` lines (after `export * from "./outbound-draft.js";`):

```ts
export * from "./result-qa.js";
```

In the same file, add `"result_qa"` to the `ArtifactKind` enum, immediately after `"send_receipt"`:

```ts
  "linear_sync",
  "send_receipt",
  "result_qa",
]);
```

And extend `RunPhase`:

```ts
export const RunPhase = z.enum(["plan", "execute", "reflect", "qa"]);
```

- [ ] **Step 5: Add the `delegated` outcome**

In `packages/shared/src/plan-triage.ts`, change `PlanAnswersContent`:

```ts
/** plan_answers artifact contentJson (PRD §7.4). `delegated` = human approved past open questions. */
export const PlanAnswersContent = z.object({
  answers: z.array(PlanAnswer),
  outcome: z.enum(["approved", "redraft", "delegated"]),
  answeredAt: z.string(),
});
export type PlanAnswersContent = z.infer<typeof PlanAnswersContent>;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test packages/shared/src/result-qa.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 7: Stage**

```bash
git add packages/shared/src/result-qa.ts packages/shared/src/result-qa.test.ts packages/shared/src/index.ts packages/shared/src/plan-triage.ts
```

---

### Task 2: Absorb the new `qa` phase in usage + persist

Adding `"qa"` to `RunPhase` breaks two call sites that pass a `RunPhase` where a `BudgetPhase` (`"plan" | "execute" | "reflect"`) is expected. Fix both, and give Q&A its own usage label.

**Files:**
- Modify: `packages/server/src/usage-summary.ts`
- Modify: `packages/server/src/runners/persist.ts:95`
- Create: `packages/server/src/usage-summary.test.ts`

**Interfaces:**
- Consumes: `RunPhase` (now includes `"qa"`) from Task 1.
- Produces: usage lines labelled `Q&A`, `Q&A 2`, … for `qa`-phase usage artifacts.

- [ ] **Step 1: Confirm the type breakage**

Run: `npm run build -w @agent-dealer/shared && npm run typecheck -w @agent-dealer/server`
Expected: FAIL — errors in `usage-summary.ts` and `runners/persist.ts`, both saying `"qa"` is not assignable to `BudgetPhase`.

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/usage-summary.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-usage-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("./db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("./repository/agents.js");
const { addArtifact, createRun, getRun } = await import("./repository/runs.js");
const { buildLineageUsageSummary } = await import("./usage-summary.js");

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

test("qa usage artifacts get their own label and do not inflate the execute count", () => {
  const run = createRun({
    title: "Usage test",
    taskCategory: "other",
    status: "review",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "usage", { phase: "execute", runtime: "claude_code", totalCostUsd: 1 }, "agent");
  addArtifact(run.id, "usage", { phase: "qa", runtime: "claude_code", totalCostUsd: 0.1 }, "agent");
  addArtifact(run.id, "usage", { phase: "qa", runtime: "claude_code", totalCostUsd: 0.1 }, "agent");

  const summary = buildLineageUsageSummary(getRun(run.id)!);
  const labels = summary.lines.map((l) => l.label);
  assert.deepEqual(labels, ["execute", "Q&A", "Q&A 2"]);
  assert.equal(Math.round(summary.total.totalCostUsd * 100) / 100, 1.2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/usage-summary.test.ts`
Expected: FAIL — labels come back as `["execute", "execute 2", "execute 3"]`

- [ ] **Step 4: Fix `usage-summary.ts`**

Replace `labelUsage` and the loop body that calls it. The current `labelUsage` signature is `(lineageIdx, phase, planCount, execCount)`; add a `qaCount` parameter and a `qa` branch:

```ts
function labelUsage(
  lineageIdx: number,
  phase: UsageContent["phase"],
  planCount: number,
  execCount: number,
  qaCount: number
): string {
  if (phase === "plan") {
    return planCount > 1 ? `plan ${planCount}` : "plan";
  }
  if (phase === "qa") {
    return qaCount > 1 ? `Q&A ${qaCount}` : "Q&A";
  }
  if (lineageIdx === 0) {
    return execCount > 1 ? `execute ${execCount}` : "execute";
  }
  return lineageIdx === 1 ? "retry" : `retry ${lineageIdx}`;
}
```

Then in `buildLineageUsageSummary`, inside `lineageRuns.forEach((lr, lineageIdx) => {`, add a `qaCount` alongside the other counters and route the `qa` phase away from `resolveBudgetForPhase` (which only knows `BudgetPhase`):

```ts
    let planCount = 0;
    let execCount = 0;
    let qaCount = 0;
    const arts = opts?.artifactsByRunId?.[lr.id] ?? listArtifacts(lr.id);
    for (const art of arts) {
      if (art.kind !== "usage" || !art.contentJson) continue;
      const usage = parseUsage(art.contentJson);
      if (!usage) continue;

      if (usage.phase === "plan") planCount++;
      else if (usage.phase === "qa") qaCount++;
      else execCount++;

      // qa has no configurable budget — its cap is snapshotted on the artifact
      const resolved = usage.phase === "qa" ? null : resolveBudgetForPhase(lr, usage.phase);

      lines.push({
        label: labelUsage(lineageIdx, usage.phase, planCount, execCount, qaCount),
        usage,
        maxTurns: usage.maxTurns ?? resolved?.maxTurns,
        maxBudgetUsd: usage.maxBudgetUsd ?? resolved?.maxBudgetUsd,
      });
    }
```

- [ ] **Step 5: Fix `persist.ts`**

`persistRunOutput` is never called with `phase: "qa"` (Task 5 persists Q&A usage directly), but the type must narrow. In `packages/server/src/runners/persist.ts`, change line 95:

```ts
  const caps = phase === "qa" ? null : resolveBudgetForPhase(run, phase);
```

- [ ] **Step 6: Run test + typecheck to verify they pass**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/usage-summary.test.ts && npm run typecheck -w @agent-dealer/server`
Expected: PASS — 1 test; typecheck exits 0

- [ ] **Step 7: Stage**

```bash
git add packages/server/src/usage-summary.ts packages/server/src/usage-summary.test.ts packages/server/src/runners/persist.ts
```

---

### Task 3: Read-only QA tool allowlist

**Files:**
- Modify: `packages/server/src/runners/claude-args.ts`
- Modify: `packages/server/src/runners/claude.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildClaudePhaseArgs(run, mode)` now accepts `mode: "execute" | "plan" | "reflect" | "qa"`. For `"qa"` the `--allowedTools` value is exactly `Read,Glob,Grep,Skill`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/runners/claude.test.ts`:

```ts
test("qa allowlist is read-only", () => {
  const args = buildClaudePhaseArgs(runWithCategory("code"), "qa");
  const i = args.indexOf("--allowedTools");
  assert.equal(args[i + 1], "Read,Glob,Grep,Skill");
});

test("qa forbids mutation tools even for code tasks", () => {
  const args = buildClaudePhaseArgs(runWithCategory("code"), "qa");
  const i = args.indexOf("--allowedTools");
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.doesNotMatch(args[i + 1], new RegExp(`\\b${tool}\\b`), tool);
  }
  assert.equal(hasDisallowSend(args), true);
});

test("qa does not add the deliverable output dir", () => {
  const args = buildClaudePhaseArgs(runWithCategory("content"), "qa");
  assert.equal(args.includes("--add-dir"), false);
});
```

Also widen the existing "all phases deny call_service_tool" test to cover `qa`:

```ts
test("all phases deny call_service_tool", () => {
  for (const mode of ["plan", "execute", "reflect", "qa"] as const) {
    const args = buildClaudePhaseArgs(runWithCategory("code"), mode);
    assert.equal(hasDisallowSend(args), true, mode);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/claude.test.ts`
Expected: FAIL — TypeScript rejects `"qa"` as a `mode` argument

- [ ] **Step 3: Implement**

In `packages/server/src/runners/claude-args.ts`, add the constant next to `PLAN_REFLECT_TOOLS` and branch on the new mode:

```ts
const PLAN_REFLECT_TOOLS = `Read,Glob,Grep,Skill,${DECK_READ_TOOLS}`;

/** Q&A about a finished result — read-only, no deck writes, no workspace mutation. */
const QA_TOOLS = "Read,Glob,Grep,Skill";
```

```ts
/** Build claude -p CLI args for a phase (excluding prompt, model, resume, mcp-config, budget). */
export function buildClaudePhaseArgs(
  run: Run,
  mode: "execute" | "plan" | "reflect" | "qa"
): string[] {
  const args: string[] = ["--output-format", "stream-json", "--verbose"];

  if (mode === "qa") {
    args.push("--allowedTools", QA_TOOLS);
  } else if (mode === "plan" || mode === "reflect") {
    args.push("--allowedTools", PLAN_REFLECT_TOOLS);
  } else {
    args.push("--add-dir", getTemporalOutputDir());
    args.push("--allowedTools", executeToolsForCategory(run.taskCategory));
  }

  args.push("--disallowedTools", DENY_SEND_TOOL);
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/claude.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Stage**

```bash
git add packages/server/src/runners/claude-args.ts packages/server/src/runners/claude.test.ts
```

---

### Task 4: QA prompt builder

Two shapes: **grounded** (the execute session resumed — the agent already remembers everything) and **ungrounded** (session gone — rebuild context from artifacts).

**Files:**
- Modify: `packages/server/src/runners/prompts.ts`
- Modify: `packages/server/src/runners/prompts.test.ts`

**Interfaces:**
- Consumes: `getLatestArtifact` from `../repository/runs.js` (already imported in `prompts.ts`).
- Produces: `buildQaPrompt(run: Run, question: string, opts: { grounded: boolean }): string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/runners/prompts.test.ts` (and add `buildQaPrompt` to the existing `await import("./prompts.js")` destructure on line 14):

```ts
test("grounded qa prompt asks the question without re-stating artifacts", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan\n1. Use SQLite" }, "human");
  const prompt = buildQaPrompt(run, "Why SQLite?", { grounded: true });
  assert.match(prompt, /Why SQLite\?/);
  assert.match(prompt, /Do NOT modify anything/i);
  assert.doesNotMatch(prompt, /## Approved plan/);
});

test("ungrounded qa prompt rebuilds context from artifacts", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan\n1. Use SQLite" }, "human");
  addArtifact(run.id, "execution_result", { phase: "execute", exitCode: 0, resultText: "Wrote the doc", isError: false }, "agent");
  addArtifact(run.id, "document", { path: "/tmp/x.md", title: "x", markdown: "# Deliverable body" }, "agent");
  const prompt = buildQaPrompt(run, "Why SQLite?", { grounded: false });
  assert.match(prompt, /## Approved plan/);
  assert.match(prompt, /## Execution outcome/);
  assert.match(prompt, /## Deliverable/);
  assert.match(prompt, /# Deliverable body/);
  assert.match(prompt, /Why SQLite\?/);
});

test("qa prompt never asks for a json block or an outbound draft", () => {
  const run = makeRun();
  const prompt = buildQaPrompt(run, "What did you check?", { grounded: true });
  assert.doesNotMatch(prompt, /Outbound actions/);
  assert.doesNotMatch(prompt, /"verdict"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: FAIL — `buildQaPrompt is not a function`

- [ ] **Step 3: Implement**

Add to `packages/server/src/runners/prompts.ts` (after `buildReflectPrompt`). It reuses the module-private `artifactMarkdown(kind, runId)` helper already defined at line 40:

```ts
export function buildQaPrompt(
  run: Run,
  question: string,
  opts: { grounded: boolean }
): string {
  const parts = [
    `The human reviewing your finished work has a question about it.`,
    ``,
    `IMPORTANT:`,
    `- Answer the question. Do NOT modify anything — no files, no edits, no commands, no sends.`,
    `- You may read files to check your own work.`,
    `- Answer concisely in markdown. No preamble, no restating the question.`,
    `- If you do not know, say so plainly rather than guessing.`,
    ``,
  ];

  if (opts.grounded) {
    parts.push(`## Task`, taskText(run), ``);
  } else {
    parts.push(
      `Your original session is gone, so the relevant context is reproduced below.`,
      ``,
      `## Task`,
      taskText(run),
      ``
    );
    const plan = artifactMarkdown("approved_plan", run.id);
    if (plan) parts.push(`## Approved plan`, plan, ``);
    const result = artifactMarkdown("execution_result", run.id);
    if (result) parts.push(`## Execution outcome`, result, ``);
    const doc = artifactMarkdown("document", run.id);
    if (doc) parts.push(`## Deliverable`, doc, ``);
  }

  parts.push(`## Question`, question);
  return parts.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Stage**

```bash
git add packages/server/src/runners/prompts.ts packages/server/src/runners/prompts.test.ts
```

---

### Task 5: QA repository reads + runner

**Files:**
- Create: `packages/server/src/repository/result-qa.ts`
- Create: `packages/server/src/runners/qa.ts`
- Modify: `packages/server/src/runners/claude.ts`

**Interfaces:**
- Consumes: `ResultQaContent`, `latestQaExchanges`, `QA_PHASE_BUDGET` (Task 1); `buildQaPrompt` (Task 4); `buildClaudePhaseArgs(run, "qa")` (Task 3).
- Produces:
  - `listQaExchanges(runId: string): ResultQaContent[]` — collapsed, oldest-first
  - `hasPendingQaExchange(runId: string): boolean`
  - `latestExecuteSessionId(runId: string): string | null`
  - `runQa(run: Run, question: string, resumeSessionId: string | null): Promise<QaRunResult>` where
    `type QaRunResult = { ok: boolean; answer: string; error?: string; usage: UsageContent }`
  - `runClaude(run, mode, model?, opts?)` accepts `mode: "execute" | "plan" | "reflect" | "qa"`.

- [ ] **Step 1: Write the repository reads**

Create `packages/server/src/repository/result-qa.ts`:

```ts
import type { ResultQaContent } from "@agent-dealer/shared";
import { ResultQaContent as ResultQaContentSchema, latestQaExchanges } from "@agent-dealer/shared";
import { listArtifacts } from "./runs.js";

/** Collapsed Q&A thread for a run — latest artifact per exchangeId, oldest ask first. */
export function listQaExchanges(runId: string): ResultQaContent[] {
  const parsed: ResultQaContent[] = [];
  for (const art of listArtifacts(runId)) {
    if (art.kind !== "result_qa" || !art.contentJson) continue;
    try {
      parsed.push(ResultQaContentSchema.parse(JSON.parse(art.contentJson)));
    } catch {
      // skip malformed
    }
  }
  return latestQaExchanges(parsed);
}

export function hasPendingQaExchange(runId: string): boolean {
  return listQaExchanges(runId).some((e) => e.status === "pending");
}

/** Session id of the most recent execute phase — what a Q&A resumes into. */
export function latestExecuteSessionId(runId: string): string | null {
  const sessions = listArtifacts(runId).filter((a) => a.kind === "agent_session");
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (!sessions[i].contentJson) continue;
    try {
      const parsed = JSON.parse(sessions[i].contentJson!) as { phase?: string; sessionId?: string };
      if (parsed.phase === "execute" && parsed.sessionId) return parsed.sessionId;
    } catch {
      // skip
    }
  }
  return null;
}
```

`listArtifacts` returns rows `ORDER BY created_at ASC`, so `latestQaExchanges`'s "last one wins" map is correct without extra sorting.

- [ ] **Step 2: Teach `runClaude` about the `qa` mode**

In `packages/server/src/runners/claude.ts`:

Widen the import and the two mode unions. Add `QA_PHASE_BUDGET` to the shared import on line 10:

```ts
import { budgetCliArgs, QA_PHASE_BUDGET } from "@agent-dealer/shared";
```

Change `logPathFor`:

```ts
function logPathFor(run: Run, mode: "plan" | "execute" | "reflect" | "qa"): string {
  const logDir = getTemporalLogsDir();
  return path.join(logDir, `${run.id}-${mode}-${Date.now()}.ndjson`);
}
```

Change `runClaude`'s signature and its budget/prompt/logPath resolution:

```ts
export async function runClaude(
  run: Run,
  mode: "execute" | "plan" | "reflect" | "qa" = "execute",
  model?: string,
  opts?: { promptOverride?: string; resumeSessionId?: string }
): Promise<RunnerResult> {
  const mcpConfig =
    process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");
  if (!fs.existsSync(mcpConfig)) {
    throw new Error(`MCP config not found: ${mcpConfig}. Set CLAUDE_MCP_CONFIG.`);
  }

  if (mode === "qa" && !opts?.promptOverride) {
    throw new Error("qa mode requires a promptOverride");
  }

  const phaseBudget = mode === "qa" ? { ...QA_PHASE_BUDGET } : resolveBudgetForPhase(run, mode);

  const resumeSessionId =
    opts?.resumeSessionId ??
    (mode === "execute" && humanFeedbackText(run) ? lineageParentExecuteSessionId(run) : null);

  const prompt =
    opts?.promptOverride ??
    (mode === "plan"
      ? buildPlanPrompt(run)
      : mode === "reflect"
        ? buildReflectPrompt(run, { trigger: "retry" })
        : resumeSessionId
          ? buildExecutionContinuationPrompt(run)
          : buildExecutionPrompt(run));
  const logPath = logPathFor(run, mode);
```

The rest of the function body is unchanged. Note this also removes the now-redundant `mode === "reflect" ? "reflect" : mode` ternary that used to be inside `logPathFor(...)`.

- [ ] **Step 3: Write the QA runner**

Create `packages/server/src/runners/qa.ts`:

```ts
import type { Run, UsageContent } from "@agent-dealer/shared";
import { runClaude } from "./claude.js";
import { buildQaPrompt } from "./prompts.js";
import { extractResultIsError, extractResultText, extractUsage, parseNdjson } from "./stream-json.js";
import { QA_PHASE_BUDGET } from "@agent-dealer/shared";

export interface QaRunResult {
  ok: boolean;
  answer: string;
  error?: string;
  usage: UsageContent;
}

/** One read-only Q&A turn against a finished run. Resumes the execute session when we still have it. */
export async function runQa(
  run: Run,
  question: string,
  resumeSessionId: string | null
): Promise<QaRunResult> {
  const result = await runClaude(run, "qa", run.executeModel ?? undefined, {
    promptOverride: buildQaPrompt(run, question, { grounded: Boolean(resumeSessionId) }),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });

  const events = parseNdjson(result.transcript);
  const usage = extractUsage(events, "qa", "claude_code");
  usage.maxTurns = QA_PHASE_BUDGET.maxTurns;
  usage.maxBudgetUsd = QA_PHASE_BUDGET.maxBudgetUsd;

  const answer = extractResultText(events)?.trim() ?? "";
  const failed = result.exitCode !== 0 || extractResultIsError(events) || !answer;

  return {
    ok: !failed,
    answer,
    error: failed ? `qa exited ${result.exitCode}${answer ? "" : " with no answer"}` : undefined,
    usage,
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run build -w @agent-dealer/shared && npm run typecheck -w @agent-dealer/server`
Expected: exit 0

- [ ] **Step 5: Stage**

```bash
git add packages/server/src/repository/result-qa.ts packages/server/src/runners/qa.ts packages/server/src/runners/claude.ts
```

---

### Task 6: `askResultQuestion` orchestration

Persist the pending exchange synchronously (so the HTTP response and the next poll both see it), then run the agent fire-and-forget and append the completed exchange.

**Files:**
- Create: `packages/server/src/queue/result-qa.ts`
- Create: `packages/server/src/queue/result-qa.test.ts`

**Interfaces:**
- Consumes: `listQaExchanges`, `hasPendingQaExchange`, `latestExecuteSessionId` (Task 5); `runQa` (Task 5); `addArtifact`, `getRun` from `../repository/runs.js`.
- Produces:

```ts
export type QaRunner = (run: Run, question: string, resumeSessionId: string | null) => Promise<QaRunResult>;
export type AskQuestionResult =
  | { ok: true; exchange: ResultQaContent }
  | { ok: false; code: 404 | 409; error: string };
export function askResultQuestion(
  runId: string,
  question: string,
  opts?: { runner?: QaRunner }
): AskQuestionResult;
```

The `opts.runner` injection point mirrors `submitPlanAnswers(..., { onRedraft })` and is what the tests drive.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/queue/result-qa.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-qa-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, getRun, transitionRun, updateRunFields } =
  await import("../repository/runs.js");
const { listQaExchanges } = await import("../repository/result-qa.js");
const { askResultQuestion } = await import("./result-qa.js");

const USAGE = { phase: "qa" as const, runtime: "claude_code" as const, totalCostUsd: 0.02 };

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedReviewRun(opts?: { session?: string }) {
  const run = createRun({
    title: "QA test",
    taskCategory: "other",
    status: "running",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  if (opts?.session) {
    addArtifact(run.id, "agent_session", { phase: "execute", runtime: "claude_code", sessionId: opts.session }, "agent");
  }
  transitionRun(run.id, "review");
  return getRun(run.id)!;
}

/** Resolves the async answer job before asserting. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

test("asking persists a pending exchange, then an answered one with the same exchangeId", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  let sawSession: string | null = "unset";
  const res = askResultQuestion(run.id, "Why SQLite?", {
    runner: async (_run, _q, resumeSessionId) => {
      sawSession = resumeSessionId;
      return { ok: true, answer: "Single-process.", usage: USAGE };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.ok && res.exchange.status, "pending");
  assert.equal(listQaExchanges(run.id)[0].status, "pending");

  await settle();

  assert.equal(sawSession, "sess-exec");
  const thread = listQaExchanges(run.id);
  assert.equal(thread.length, 1, "append-only exchanges collapse by exchangeId");
  assert.equal(thread[0].status, "answered");
  assert.equal(thread[0].answer, "Single-process.");
  assert.equal(thread[0].sessionResumed, true);
  assert.ok(thread[0].answeredAt);
  assert.equal(getLatestArtifact(run.id, "usage")!.contentJson!.includes('"phase":"qa"'), true);
});

test("missing execute session answers ungrounded and flags sessionResumed false", async () => {
  const run = seedReviewRun();
  askResultQuestion(run.id, "What did you check?", {
    runner: async () => ({ ok: true, answer: "The tests.", usage: USAGE }),
  });
  await settle();
  const thread = listQaExchanges(run.id);
  assert.equal(thread[0].sessionResumed, false);
  assert.equal(thread[0].status, "answered");
});

test("runner failure records a failed exchange and never changes run status", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "Why?", {
    runner: async () => ({ ok: false, answer: "", error: "qa exited 1", usage: USAGE }),
  });
  await settle();
  const thread = listQaExchanges(run.id);
  assert.equal(thread[0].status, "failed");
  assert.equal(thread[0].error, "qa exited 1");
  assert.equal(getRun(run.id)!.status, "review");
});

test("runner throwing records a failed exchange", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "Why?", {
    runner: async () => { throw new Error("spawn ENOENT"); },
  });
  await settle();
  assert.match(listQaExchanges(run.id)[0].error!, /spawn ENOENT/);
});

test("a second question while one is pending returns 409", () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "First?", { runner: () => new Promise(() => {}) });
  const second = askResultQuestion(run.id, "Second?", { runner: async () => ({ ok: true, answer: "x", usage: USAGE }) });
  assert.equal(!second.ok && second.code, 409);
});

test("asking a done run is allowed", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  transitionRun(run.id, "done");
  const res = askResultQuestion(run.id, "Post-hoc?", {
    runner: async () => ({ ok: true, answer: "Sure.", usage: USAGE }),
  });
  assert.equal(res.ok, true);
  await settle();
  assert.equal(listQaExchanges(run.id)[0].status, "answered");
});

test("asking a running run returns 409", () => {
  const run = createRun({
    title: "Still running",
    taskCategory: "other",
    status: "running",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  const res = askResultQuestion(run.id, "Why?", { runner: async () => ({ ok: true, answer: "x", usage: USAGE }) });
  assert.equal(!res.ok && res.code, 409);
});

test("unknown run returns 404", () => {
  const res = askResultQuestion("00000000-0000-4000-a000-0000000000ff", "Why?");
  assert.equal(!res.ok && res.code, 404);
});

test("non-claude runtime returns 409", () => {
  const run = seedReviewRun({ session: "sess-exec" });
  updateRunFields(run.id, { runtime: "cursor_local" });
  const res = askResultQuestion(run.id, "Why?", { runner: async () => ({ ok: true, answer: "x", usage: USAGE }) });
  assert.equal(!res.ok && res.code, 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/queue/result-qa.test.ts`
Expected: FAIL — `Cannot find module './result-qa.js'`

- [ ] **Step 3: Implement**

Create `packages/server/src/queue/result-qa.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Run, ResultQaContent } from "@agent-dealer/shared";
import { addArtifact, getRun } from "../repository/runs.js";
import { hasPendingQaExchange, latestExecuteSessionId } from "../repository/result-qa.js";
import { runQa, type QaRunResult } from "../runners/qa.js";

export type QaRunner = (
  run: Run,
  question: string,
  resumeSessionId: string | null
) => Promise<QaRunResult>;

export type AskQuestionResult =
  | { ok: true; exchange: ResultQaContent }
  | { ok: false; code: 404 | 409; error: string };

const ASKABLE_STATUSES = new Set(["review", "done"]);

/** Ask the run's agent about its finished result. Read-only; never changes run status. */
export function askResultQuestion(
  runId: string,
  question: string,
  opts?: { runner?: QaRunner }
): AskQuestionResult {
  const run = getRun(runId);
  if (!run) return { ok: false, code: 404, error: "Not found" };
  if (!ASKABLE_STATUSES.has(run.status)) {
    return { ok: false, code: 409, error: `Can only ask about a finished result — run is ${run.status}` };
  }
  if ((run.runtime ?? "claude_code") !== "claude_code") {
    return { ok: false, code: 409, error: "Q&A requires the claude_code runtime" };
  }
  if (hasPendingQaExchange(runId)) {
    return { ok: false, code: 409, error: "A question is already being answered" };
  }

  const resumeSessionId = latestExecuteSessionId(runId);
  const exchange: ResultQaContent = {
    exchangeId: randomUUID(),
    question,
    status: "pending",
    sessionResumed: Boolean(resumeSessionId),
    askedAt: new Date().toISOString(),
  };
  addArtifact(runId, "result_qa", exchange, "human");

  void answerExchange(run, exchange, resumeSessionId, opts?.runner ?? runQa);
  return { ok: true, exchange };
}

async function answerExchange(
  run: Run,
  exchange: ResultQaContent,
  resumeSessionId: string | null,
  runner: QaRunner
): Promise<void> {
  let result: QaRunResult;
  try {
    result = await runner(run, exchange.question, resumeSessionId);
  } catch (e) {
    appendExchange(run.id, { ...exchange, status: "failed", error: String(e) });
    return;
  }

  addArtifact(run.id, "usage", result.usage, "agent");

  if (!result.ok) {
    appendExchange(run.id, { ...exchange, status: "failed", error: result.error ?? "Q&A failed" });
    return;
  }
  appendExchange(run.id, {
    ...exchange,
    status: "answered",
    answer: result.answer,
    answeredAt: new Date().toISOString(),
  });
}

function appendExchange(runId: string, exchange: ResultQaContent): void {
  addArtifact(runId, "result_qa", exchange, "agent");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/queue/result-qa.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Stage**

```bash
git add packages/server/src/queue/result-qa.ts packages/server/src/queue/result-qa.test.ts
```

---

### Task 7: Retry carries the Q&A discussion

A retry creates a **new run** whose lineage parent holds the `result_qa` artifacts. So the section must be read from the parent, not from `run.id`.

**Files:**
- Modify: `packages/server/src/runners/run-context.ts`
- Modify: `packages/server/src/runners/prompts.ts`
- Modify: `packages/server/src/runners/prompts.test.ts`

**Interfaces:**
- Consumes: `listQaExchanges` (Task 5), `getLineageParentRun` (already imported in `run-context.ts`).
- Produces: `reviewQaPairs(run: Run): Array<{ question: string; answer: string }>` — answered exchanges from this run and its lineage parent, oldest first.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/runners/prompts.test.ts`:

```ts
test("execution prompt renders answered review Q&A from the lineage parent", () => {
  const parent = makeRun();
  addArtifact(parent.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(parent.id, "result_qa", {
    exchangeId: "x1",
    question: "Did you run the tests?",
    answer: "Yes, all 12 pass.",
    status: "answered",
    sessionResumed: true,
    askedAt: "2026-07-08T00:00:00.000Z",
    answeredAt: "2026-07-08T00:01:00.000Z",
  }, "agent");
  addArtifact(parent.id, "result_qa", {
    exchangeId: "x2",
    question: "Pending one",
    status: "pending",
    sessionResumed: true,
    askedAt: "2026-07-08T00:02:00.000Z",
  }, "human");

  const retry = createRun({
    title: "Prompt test task",
    taskCategory: "other",
    status: "plan_approved",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  }, { lineageId: parent.lineageId ?? parent.id });
  addArtifact(retry.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(retry.id, "feedback", { markdown: "Tighten the summary" }, "human");

  const prompt = buildExecutionPrompt(retry);
  assert.match(prompt, /## Review Q&A/);
  assert.match(prompt, /Did you run the tests\?/);
  assert.match(prompt, /Yes, all 12 pass\./);
  assert.doesNotMatch(prompt, /Pending one/);
});

test("execution prompt omits the Q&A section when there are no answered exchanges", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  assert.doesNotMatch(buildExecutionPrompt(run), /## Review Q&A/);
});
```

Before writing this, confirm how `createRun` accepts a lineage id — read `packages/server/src/repository/runs.ts:82` (`createRun(input, opts?)`) and the retry route at `packages/server/src/routes/index.ts:506` to copy the exact option name it passes. Use that same shape here; `{ lineageId: ... }` above is a placeholder for whatever the real option is.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: FAIL — no `## Review Q&A` in the prompt

- [ ] **Step 3: Add `reviewQaPairs` to `run-context.ts`**

Add the import at the top of `packages/server/src/runners/run-context.ts`:

```ts
import { listQaExchanges } from "../repository/result-qa.js";
```

And the exported helper:

```ts
export interface ReviewQaPair {
  question: string;
  answer: string;
}

/** Answered result Q&A from this run and its lineage parent — a retry inherits the discussion. */
export function reviewQaPairs(run: Run): ReviewQaPair[] {
  const parent = getLineageParentRun(run);
  const runIds = parent ? [parent.id, run.id] : [run.id];
  const pairs: ReviewQaPair[] = [];
  for (const id of runIds) {
    for (const e of listQaExchanges(id)) {
      if (e.status === "answered" && e.answer) {
        pairs.push({ question: e.question, answer: e.answer });
      }
    }
  }
  return pairs;
}
```

- [ ] **Step 4: Render the section in both execution prompts**

In `packages/server/src/runners/prompts.ts`, extend the `run-context.js` import to include `reviewQaPairs`, then add:

```ts
function reviewQaSections(run: Run): string[] {
  const pairs = reviewQaPairs(run);
  if (pairs.length === 0) return [];
  const lines = pairs.flatMap((p) => [`Q: ${p.question}`, `A: ${p.answer}`, ``]);
  return [`## Review Q&A`, `The human asked about the prior result. Honor these answers.`, ...lines];
}
```

Call it in `buildExecutionPrompt`, right after the existing `parts.push(...planAnswersSections(run));`:

```ts
  parts.push(...planAnswersSections(run));
  parts.push(...reviewQaSections(run));
```

And in `buildExecutionContinuationPrompt`, right before the `if (run.deckId) {` block:

```ts
  parts.push(...reviewQaSections(run));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 6: Stage**

```bash
git add packages/server/src/runners/run-context.ts packages/server/src/runners/prompts.ts packages/server/src/runners/prompts.test.ts
```

---

### Task 8: Explicit plan delegation

**Files:**
- Create: `packages/server/src/queue/plan-delegation.ts`
- Create: `packages/server/src/queue/plan-delegation.test.ts`
- Modify: `packages/server/src/runners/prompts.ts`
- Modify: `packages/server/src/runners/prompts.test.ts`
- Modify: `packages/server/src/routes/index.ts:388`

**Interfaces:**
- Consumes: `PlanTriageContent`, `PlanAnswersContent` (with `delegated`, Task 1).
- Produces: `recordPlanDelegation(runId: string): boolean` — returns `true` if a `plan_answers` `delegated` artifact was written. Called *before* `markPlanTriageConsumed` on the approve path.

"Unanswered" means: latest `plan_triage` exists, is not `consumed`, has `questions.length > 0`, and there is no `plan_answers` artifact newer than it.

- [ ] **Step 1: Write the failing test for `recordPlanDelegation`**

Create `packages/server/src/queue/plan-delegation.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-delegate-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, markPlanTriageConsumed } =
  await import("../repository/runs.js");
const { recordPlanDelegation } = await import("./plan-delegation.js");

const QUESTIONS = [{ id: "q1", question: "Which backend?", options: [{ label: "SQLite" }, { label: "Postgres" }] }];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedRun(triage?: Record<string, unknown>) {
  const run = createRun({
    title: "Delegate test",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  if (triage) addArtifact(run.id, "plan_triage", triage, "agent");
  return run;
}

test("open questions produce a delegated plan_answers record", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  assert.equal(recordPlanDelegation(run.id), true);
  const art = getLatestArtifact(run.id, "plan_answers")!;
  const content = JSON.parse(art.contentJson!) as { outcome: string; answers: unknown[] };
  assert.equal(content.outcome, "delegated");
  assert.deepEqual(content.answers, []);
  assert.equal(art.author, "human");
});

test("no triage means nothing to delegate", () => {
  const run = seedRun();
  assert.equal(recordPlanDelegation(run.id), false);
  assert.equal(getLatestArtifact(run.id, "plan_answers"), null);
});

test("triage without questions means nothing to delegate", () => {
  const run = seedRun({ verdict: "trivial", rationale: "r", questions: [], parseFallback: false, consumed: false });
  assert.equal(recordPlanDelegation(run.id), false);
});

test("consumed triage means nothing to delegate", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  markPlanTriageConsumed(run.id);
  assert.equal(recordPlanDelegation(run.id), false);
});

test("already-answered questions are not delegated", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  addArtifact(run.id, "plan_answers", {
    answers: [{ questionId: "q1", selectedLabel: "SQLite" }],
    outcome: "approved",
    answeredAt: new Date().toISOString(),
  }, "human");
  assert.equal(recordPlanDelegation(run.id), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/queue/plan-delegation.test.ts`
Expected: FAIL — `Cannot find module './plan-delegation.js'`

- [ ] **Step 3: Implement `recordPlanDelegation`**

Create `packages/server/src/queue/plan-delegation.ts`:

```ts
import type { PlanTriageContent } from "@agent-dealer/shared";
import { addArtifact, getLatestArtifact } from "../repository/runs.js";

/**
 * Human approved a plan whose triage questions are still open.
 * Record the delegation so the executor sees the questions it must decide itself.
 * Call BEFORE markPlanTriageConsumed — a consumed triage has nothing to delegate.
 */
export function recordPlanDelegation(runId: string): boolean {
  const triageArt = getLatestArtifact(runId, "plan_triage");
  if (!triageArt?.contentJson) return false;

  let triage: PlanTriageContent;
  try {
    triage = JSON.parse(triageArt.contentJson) as PlanTriageContent;
  } catch {
    return false;
  }
  if (triage.consumed || triage.questions.length === 0) return false;

  const answers = getLatestArtifact(runId, "plan_answers");
  if (answers && answers.createdAt > triageArt.createdAt) return false;

  addArtifact(runId, "plan_answers", { answers: [], outcome: "delegated", answeredAt: new Date().toISOString() }, "human");
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/queue/plan-delegation.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Write the failing prompt test**

Append to `packages/server/src/runners/prompts.test.ts`:

```ts
test("delegated plan answers surface the unanswered questions to the executor", () => {
  const run = makeRun();
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  addArtifact(run.id, "plan_triage", {
    verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: true,
  }, "agent");
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(run.id, "plan_answers", { answers: [], outcome: "delegated", answeredAt: new Date().toISOString() }, "human");

  const prompt = buildExecutionPrompt(run);
  assert.match(prompt, /## Unanswered plan questions/);
  assert.match(prompt, /Which storage backend\?/);
  assert.match(prompt, /SQLite/);
  assert.match(prompt, /best judgment/i);
  assert.doesNotMatch(prompt, /## Human answers to plan questions/);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: FAIL — no `## Unanswered plan questions`

- [ ] **Step 7: Render the delegation section**

In `packages/server/src/runners/prompts.ts`, add next to `planAnswersSections`:

```ts
function planDelegationSections(run: Run): string[] {
  const ansArt = getLatestArtifact(run.id, "plan_answers");
  if (!ansArt?.contentJson) return [];
  try {
    const ans = JSON.parse(ansArt.contentJson) as PlanAnswersContent;
    if (ans.outcome !== "delegated") return [];
    const triArt = getLatestArtifact(run.id, "plan_triage");
    const questions: PlanQuestion[] = triArt?.contentJson
      ? (JSON.parse(triArt.contentJson) as PlanTriageContent).questions
      : [];
    if (questions.length === 0) return [];
    const lines = questions.map((q) => {
      const options = q.options.map((o) => o.label).join(" | ");
      return `- ${q.question} (options: ${options})`;
    });
    return [
      "## Unanswered plan questions",
      "The reviewer chose to proceed without answering these. Use your best judgment.",
      ...lines,
      "",
    ];
  } catch {
    return [];
  }
}
```

`planAnswersSections` already returns `[]` for any outcome other than `"approved"`, so the two sections never both fire. Call the new one in `buildExecutionPrompt` right after the other two:

```ts
  parts.push(...planAnswersSections(run));
  parts.push(...planDelegationSections(run));
  parts.push(...reviewQaSections(run));
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 9: Wire the approve route**

In `packages/server/src/routes/index.ts`, add the import:

```ts
import { recordPlanDelegation } from "../queue/plan-delegation.js";
```

In the `app.patch("/api/runs/:id/plan", ...)` handler, inside `if (input.approve) {`, replace the bare `markPlanTriageConsumed(id);` on line 388 with:

```ts
      recordPlanDelegation(id);
      markPlanTriageConsumed(id);
```

Order matters: `recordPlanDelegation` short-circuits on a consumed triage.

- [ ] **Step 10: Typecheck**

Run: `npm run build -w @agent-dealer/shared && npm run typecheck -w @agent-dealer/server`
Expected: exit 0

- [ ] **Step 11: Stage**

```bash
git add packages/server/src/queue/plan-delegation.ts packages/server/src/queue/plan-delegation.test.ts packages/server/src/runners/prompts.ts packages/server/src/runners/prompts.test.ts packages/server/src/routes/index.ts
```

---

### Task 9: `POST /api/runs/:id/qa` route

**Files:**
- Modify: `packages/server/src/routes/index.ts`

**Interfaces:**
- Consumes: `askResultQuestion` (Task 6), `listQaExchanges` (Task 5), `ResultQaInput` (Task 1).
- Produces: `POST /api/runs/:id/qa` → `202 { exchange: ResultQaContent }` on success; `400` on a bad body; `404`/`409` per `askResultQuestion`. The Q&A thread is read via the existing `GET /api/runs/:id`, which already returns all artifacts — the web client filters `kind === "result_qa"` itself, so no response change there.

- [ ] **Step 1: Add the route**

In `packages/server/src/routes/index.ts`, add `ResultQaInput` to the `@agent-dealer/shared` import block, and:

```ts
import { askResultQuestion } from "../queue/result-qa.js";
```

Place the handler immediately after the `app.post("/api/runs/:id/plan/answers", ...)` handler (which ends at line 422):

```ts
  app.post("/api/runs/:id/qa", async (req, reply) => {
    const { id } = req.params as { id: string };
    let input;
    try {
      input = ResultQaInput.parse(req.body);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
    const result = askResultQuestion(id, input.question.trim());
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return reply.status(202).send({ exchange: result.exchange });
  });
```

- [ ] **Step 2: Typecheck**

Run: `npm run build -w @agent-dealer/shared && npm run typecheck -w @agent-dealer/server`
Expected: exit 0

- [ ] **Step 3: Add flow-verify contract gates**

In `scripts/flow-verify.ts`, insert after the existing "Plan answers gate (no open questions)" block (line 117):

```ts
  const qaTooEarly = await req("POST", `/api/runs/${run.id}/qa`, { question: "Why?" });
  assert(qaTooEarly.status === 409, "qa before review returns 409");
  ok("Result Q&A gate (run not finished)");

  const qaEmpty = await req("POST", `/api/runs/${run.id}/qa`, { question: "" });
  assert(qaEmpty.status === 400, "empty question rejected");
  ok("Result Q&A input validation");

  const qaMissing = await req("POST", "/api/runs/00000000-0000-4000-a000-0000000000ff/qa", { question: "Why?" });
  assert(qaMissing.status === 404, "qa on unknown run returns 404");
  ok("Result Q&A 404 on unknown run");
```

Note: the empty-question case is caught by `ResultQaInput` (`min(1)`) before the status check, so it returns 400 even though the run is not in `review`.

- [ ] **Step 4: Verify against a live server**

Run: `npm run dev` in one terminal, then `npm run flow:verify` in another.
Expected: the three new `✓ Result Q&A …` lines appear and the script exits 0.

- [ ] **Step 5: Stage**

```bash
git add packages/server/src/routes/index.ts scripts/flow-verify.ts
```

---

### Task 10: Web — Q&A thread and the delegation relabel

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/drawer/ResultQaThread.tsx`
- Modify: `apps/web/src/components/drawer/ResultReviewPanel.tsx`
- Modify: `apps/web/src/components/drawer/DoneReviewPanel.tsx`
- Modify: `apps/web/src/components/drawer/PlanReviewPanel.tsx`

**Interfaces:**
- Consumes: `ResultQaContent`, `latestQaExchanges` (Task 1); `POST /api/runs/:id/qa` (Task 9).
- Produces:
  - `askResultQuestion(runId: string, question: string): Promise<{ exchange: ResultQaContent }>` in `api.ts`
  - `qaExchanges(artifacts: Artifact[]): ResultQaContent[]` exported from `ResultQaThread.tsx`
  - `<ResultQaThread exchanges busy onAsk />` where `onAsk: (question: string) => Promise<void>`

- [ ] **Step 1: Add the API client function**

In `apps/web/src/api.ts`, add `ResultQaContent` to the `@agent-dealer/shared` type import list, then add after `approveRun`:

```ts
export async function askResultQuestion(
  id: string,
  question: string
): Promise<{ exchange: ResultQaContent }> {
  const res = await fetch(`${API}/api/runs/${id}/qa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}
```

Add `ResultQaContent` to the `export type { ... }` re-export list at the bottom of the file (line 423).

- [ ] **Step 2: Write the thread component**

Create `apps/web/src/components/drawer/ResultQaThread.tsx`:

```tsx
import { useState } from "react";
import type { Artifact, ResultQaContent } from "@agent-dealer/shared";
import { latestQaExchanges } from "@agent-dealer/shared";
import MarkdownBody from "../ui/MarkdownBody";

type Props = {
  exchanges: ResultQaContent[];
  busy: boolean;
  onAsk: (question: string) => Promise<void>;
};

/** Ask the run's agent about its own result. Read-only for the agent; feeds retry automatically. */
export default function ResultQaThread({ exchanges, busy, onAsk }: Props) {
  const [question, setQuestion] = useState("");
  const pending = exchanges.some((e) => e.status === "pending");
  const canAsk = !busy && !pending && question.trim().length > 0;

  return (
    <section className="space-y-2">
      <div className="heading-section">Ask the agent</div>

      {exchanges.map((e) => (
        <div key={e.exchangeId} className="space-y-1 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-sm text-white/85">{e.question}</p>
          {e.status === "pending" && (
            <p className="text-sm text-[#92E4DD] animate-pulse">Agent is answering…</p>
          )}
          {e.status === "failed" && (
            <p className="text-sm text-red-400/90">Could not answer{e.error ? ` — ${e.error}` : ""}. Ask again.</p>
          )}
          {e.status === "answered" && e.answer && (
            <>
              <div className="markdown-body-panel markdown-body-panel--short">
                <MarkdownBody source={e.answer} />
              </div>
              {!e.sessionResumed && (
                <p className="text-xs text-white/30">Answered from artifacts — the original session had expired.</p>
              )}
            </>
          )}
        </div>
      ))}

      <textarea
        className="field-mono min-h-[72px] resize-y leading-relaxed"
        placeholder="Why did you choose this approach? Did you check X?"
        value={question}
        disabled={busy || pending}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <button
        type="button"
        disabled={!canAsk}
        onClick={async () => {
          const q = question.trim();
          setQuestion("");
          await onAsk(q);
        }}
        className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
      >
        {pending ? "Answering…" : "Ask"}
      </button>
    </section>
  );
}

export function qaExchanges(artifacts: Artifact[]): ResultQaContent[] {
  const parsed: ResultQaContent[] = [];
  for (const a of artifacts) {
    if (a.kind !== "result_qa" || !a.contentJson) continue;
    try {
      parsed.push(JSON.parse(a.contentJson) as ResultQaContent);
    } catch {
      // skip
    }
  }
  return latestQaExchanges(parsed);
}
```

`artifacts` from `fetchRunDetail` come back `ORDER BY created_at ASC`, which is what `latestQaExchanges` needs.

- [ ] **Step 3: Mount in `ResultReviewPanel`**

In `apps/web/src/components/drawer/ResultReviewPanel.tsx`:

Add imports:

```tsx
import { askResultQuestion } from "../../api";
import ResultQaThread, { qaExchanges } from "./ResultQaThread";
```

(`askResultQuestion` goes into the existing `from "../../api"` import block.)

Derive the thread next to the other artifact derivations (after `const pendingOutbound = ...`):

```tsx
  const exchanges = qaExchanges(artifacts);
  const qaPending = exchanges.some((e) => e.status === "pending");
```

Generalize the existing reflect-only poll (lines 84-90) so a pending Q&A also polls:

```tsx
  const shouldPoll = reflectPending || qaPending;

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      load().catch(console.error);
    }, 3000);
    return () => clearInterval(timer);
  }, [shouldPoll, load]);
```

Render the thread immediately above the `Your Decision` section (i.e. before `<section className="space-y-4 border-t border-white/10 pt-3">`):

```tsx
      <ResultQaThread
        exchanges={exchanges}
        busy={busy}
        onAsk={(question) => act(() => askResultQuestion(run.id, question))}
      />
```

And add the retry hint. Inside the retry block, immediately after the `<label htmlFor={`retry-${run.id}`} …>` element:

```tsx
          {exchanges.some((e) => e.status === "answered") && (
            <p className="text-xs text-white/40">This discussion is included automatically if you retry.</p>
          )}
```

- [ ] **Step 4: Mount in `DoneReviewPanel`**

In `apps/web/src/components/drawer/DoneReviewPanel.tsx`, add the same two imports, derive `exchanges`/`qaPending` next to the other derivations, and add a poll (this panel has none today) after the existing `useEffect(() => { load()… }, [load])`:

```tsx
  useEffect(() => {
    if (!qaPending) return;
    const timer = setInterval(() => {
      load().catch(console.error);
    }, 3000);
    return () => clearInterval(timer);
  }, [qaPending, load]);
```

Render the thread directly below the `Document` section (after the `{document && (…)}` block), so it sits with the deliverable:

```tsx
      <ResultQaThread
        exchanges={exchanges}
        busy={busy}
        onAsk={(question) => act(() => askResultQuestion(run.id, question))}
      />
```

`DoneReviewPanel` already has `busy` and `act` — currently only used by `PlaybookLearningPanel`.

- [ ] **Step 5: Relabel plan approve when questions are open**

In `apps/web/src/components/drawer/PlanReviewPanel.tsx`, the divider (line 275) and the approve button label (line 296) are both static. Make them reflect delegation:

```tsx
          {openQuestions.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-white/30 uppercase tracking-wide">
              <span className="h-px flex-1 bg-white/10" />
              or skip the questions
              <span className="h-px flex-1 bg-white/10" />
            </div>
          )}
```

and

```tsx
            className="btn-gold px-5 py-2 disabled:opacity-40 w-full sm:w-auto"
          >
            {openQuestions.length > 0 ? "Proceed — agent decides →" : "Approve & next →"}
          </button>
          {openQuestions.length > 0 && (
            <p className="text-xs text-white/40">
              The unanswered questions are passed to the agent, which decides them itself.
            </p>
          )}
```

- [ ] **Step 6: Typecheck the web app**

Run: `npm run build -w @agent-dealer/shared && npm run build -w @agent-dealer/web`
Expected: exit 0

- [ ] **Step 7: Drive it in the real app**

Run: `npm run dev`, open the dashboard, open a run in `review`, ask a question, watch the pending card resolve to an answer. Then approve a plan that has open questions and confirm the button reads "Proceed — agent decides →".

If no `review` run exists, create one with `npm run flow:doc` (see `package.json`).

- [ ] **Step 8: Stage**

```bash
git add apps/web/src/api.ts apps/web/src/components/drawer/ResultQaThread.tsx apps/web/src/components/drawer/ResultReviewPanel.tsx apps/web/src/components/drawer/DoneReviewPanel.tsx apps/web/src/components/drawer/PlanReviewPanel.tsx
```

---

### Task 11: Full verification, docs, single commit

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS — all files, including the four new test files (`result-qa.test.ts` ×2, `plan-delegation.test.ts`, `usage-summary.test.ts`).

- [ ] **Step 2: Typecheck every workspace**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 3: Run the flow gates**

Run: `npm run dev` in one terminal, `npm run flow:verify` in another.
Expected: exit 0, including the three new Result Q&A lines.

- [ ] **Step 4: Update the changelog**

In `CHANGELOG.md`, add under the unreleased/next section:

```markdown
### Added
- **Result Q&A** — ask the agent questions about a finished result from the review or done drawer. Each question resumes the execute session with a read-only tool allowlist (fixed $0.25 cap) instead of re-running execution; answered exchanges are injected into the retry prompt automatically. Falls back to an artifact-grounded answer when the session has expired.

### Changed
- **Approving a plan with open questions is now an explicit delegation.** The button reads "Proceed — agent decides", the server records a `plan_answers` artifact with outcome `delegated`, and the execution prompt lists the unanswered questions under `## Unanswered plan questions`. Previously the questions were silently dropped.
```

- [ ] **Step 5: Commit everything**

Per the user's global instruction, this is the single commit for the plan. `agent-dealer` needs no YubiKey, so commit directly.

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat: result Q&A thread and explicit plan delegation

Ask the run's agent about its finished result without re-executing: a new
read-only `qa` phase resumes the execute session (fixed $0.25 cap), persists
each exchange as an append-only result_qa artifact, and injects answered
exchanges into the retry prompt.

Approving a plan that still has open triage questions now records a
`delegated` plan_answers artifact and passes the questions to the executor
instead of silently dropping them.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Confirm the tree is clean**

Run: `git status --short`
Expected: only the pre-existing unrelated modifications from before this plan started, if any.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 `result_qa` artifact + zod | 1 |
| §1 `plan_answers` `delegated` | 1 |
| §2 `POST /api/runs/:id/qa` + status table | 9 (contract), 6 (409/404 logic) |
| §2 QA runner: resume, prompt, read-only allowlist, model/budget, fallback, failure, usage | 3, 4, 5, 6 |
| §3 retry carries `## Review Q&A` | 7 |
| §4 `ResultQaThread` in both panels, polling, retry hint, `sessionResumed:false` note | 10 |
| §5 delegation: route-enforced, prompt section, button relabel | 8 (server), 10 (UI) |
| Testing: zod, prompt sections, route cases, two flow gates | 1, 4, 7, 8; 6 (route logic); 9 (flow) |

Two deliberate deviations, both stated inline: `result_qa` gains an `error?: string` field (Task 1), and runner-level flow gates are `node:test` with an injected runner rather than a mocked flow-verify (Global Constraints).

The spec's "QA on `failed` runs" is out of scope, and Task 6's `ASKABLE_STATUSES` correctly excludes it.

**Type consistency:** `ResultQaContent`, `latestQaExchanges`, `QA_PHASE_BUDGET`, `QaRunResult`, `QaRunner`, `askResultQuestion`, `recordPlanDelegation`, `reviewQaPairs`, `listQaExchanges`, `hasPendingQaExchange`, `latestExecuteSessionId`, `buildQaPrompt`, `qaExchanges` are each defined in exactly one task and used with the same name and signature downstream.

**One thing the implementer must verify rather than assume:** Task 7 Step 1 constructs a lineage child run. The exact `createRun(input, opts)` option name for lineage is not restated here — read `packages/server/src/repository/runs.ts:82` and the retry route at `routes/index.ts:506` and copy what the real code passes.
