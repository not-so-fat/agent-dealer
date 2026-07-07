# Plan Questions & Self-Triage Auto-Approve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/PRD_PLAN_QUESTIONS.md` — plan-phase triage contract (F1), auto-approve gate (F2), structured-answer flow (F3), dashboard question cards + badges (F4), and `Skill` in spawned-run allowlists (F5).

**Architecture:** The headless plan call ends with a fenced JSON triage block (verdict + questions). The server parses it into a `plan_triage` artifact; a pure gate function decides auto-approve / await-answers / await-review. A new `POST /api/runs/:id/plan/answers` route approves + dispatches on all-structured answers, or schedules a session-resumed plan revision on free-form answers. The dashboard renders question cards from snapshot data.

**Tech Stack:** TypeScript ESM monorepo, zod, fastify, better-sqlite3, React + Tailwind (apps/web), `node:test` via `tsx --test` (new — repo has no unit-test runner yet).

## Global Constraints

- No new run statuses; only existing `plan_pending → plan_approved` transitions (`VALID_TRANSITIONS` in `packages/shared/src/index.ts:407`).
- Contract failure must degrade to today's behavior: unparseable triage ⇒ `needs_review`, no questions, manual review (PRD §6).
- zod schemas in `packages/shared/src` are the runtime source of truth; keep them equivalent to PRD §7 JSON Schemas.
- ESM everywhere: relative imports use the `.js` suffix even in `.ts` files (repo convention).
- `@agent-dealer/shared` resolves to its `dist/` build — run `npm run build -w @agent-dealer/shared` before server code/tests can see new shared exports.
- Code style: 2-space indent, double quotes, no semicolonless lines — match surrounding files.
- Commit after every task (no YubiKey needed in this repo). End commit messages with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- In tests: set `AGENT_DEALER_HOME` to a fresh temp dir **before** importing any server module (the sqlite singleton binds on first `getDb()`), and set `MAX_CONCURRENT_RUNS=0` so `forceDispatch()` never spawns a real agent.

---

### Task 1: Shared triage schemas + gate decision + test runner

**Files:**
- Create: `packages/shared/src/plan-triage.ts`
- Create: `packages/shared/src/plan-triage.test.ts`
- Modify: `packages/shared/src/index.ts` (ArtifactKind at line 33, re-export at line 8)
- Modify: `package.json` (root — add `test:unit` script)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2–8): `PlanQuestion`, `PlanQuestionOption`, `PlanTriageBlock`, `PlanTriageContent`, `PlanAnswer`, `PlanAnswersInput`, `PlanAnswersContent`, `PlanGateDecision`, `MAX_QUESTION_ROUNDS`, `planGateDecision(input: { triage; priorQuestionRounds: number }): PlanGateDecision`; ArtifactKind values `"plan_triage"`, `"plan_answers"`.

- [ ] **Step 1: Add the `test:unit` script to root `package.json`**

In the `scripts` block, after `"flow:verify"`:

```json
    "test:unit": "npm run build -w @agent-dealer/shared && tsx --test $(find packages -name '*.test.ts' -not -path '*/node_modules/*' -not -path '*/dist/*')",
```

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/plan-triage.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PlanTriageBlock,
  PlanAnswersInput,
  planGateDecision,
} from "./plan-triage.js";

const QUESTION = {
  id: "q1",
  question: "Reuse parent budget?",
  options: [
    { label: "Reuse parent", description: "Same caps as parent run" },
    { label: "Fresh default", description: "Reset to defaults" },
  ],
};

test("PlanTriageBlock accepts needs_review with questions", () => {
  const parsed = PlanTriageBlock.parse({
    verdict: "needs_review",
    rationale: "Budget handling is ambiguous",
    questions: [QUESTION],
  });
  assert.equal(parsed.questions.length, 1);
});

test("PlanTriageBlock rejects trivial verdict carrying questions", () => {
  assert.throws(() =>
    PlanTriageBlock.parse({
      verdict: "trivial",
      rationale: "simple",
      questions: [QUESTION],
    })
  );
});

test("PlanTriageBlock defaults questions to empty array", () => {
  const parsed = PlanTriageBlock.parse({ verdict: "trivial", rationale: "one-file doc edit" });
  assert.deepEqual(parsed.questions, []);
});

test("PlanAnswersInput rejects an answer with both selectedLabel and freeText", () => {
  assert.throws(() =>
    PlanAnswersInput.parse({
      answers: [{ questionId: "q1", selectedLabel: "A", freeText: "also this" }],
    })
  );
});

test("PlanAnswersInput rejects an answer with neither field", () => {
  assert.throws(() => PlanAnswersInput.parse({ answers: [{ questionId: "q1" }] }));
});

const cleanTrivial = { verdict: "trivial" as const, questions: [], consumed: false, parseFallback: false };

test("gate: trivial clean triage auto-approves", () => {
  assert.equal(planGateDecision({ triage: cleanTrivial, priorQuestionRounds: 0 }), "auto_approve");
});

test("gate: parseFallback never auto-approves", () => {
  assert.equal(
    planGateDecision({ triage: { ...cleanTrivial, parseFallback: true }, priorQuestionRounds: 0 }),
    "await_review"
  );
});

test("gate: consumed triage never auto-approves", () => {
  assert.equal(
    planGateDecision({ triage: { ...cleanTrivial, consumed: true }, priorQuestionRounds: 0 }),
    "await_review"
  );
});

test("gate: questions present awaits answers", () => {
  assert.equal(
    planGateDecision({
      triage: { verdict: "needs_review", questions: [QUESTION], consumed: false, parseFallback: false },
      priorQuestionRounds: 0,
    }),
    "await_answers"
  );
});

test("gate: after 2 question rounds, questions go to manual review", () => {
  assert.equal(
    planGateDecision({
      triage: { verdict: "needs_review", questions: [QUESTION], consumed: false, parseFallback: false },
      priorQuestionRounds: 2,
    }),
    "await_review"
  );
});

test("gate: needs_review with no questions goes to manual review", () => {
  assert.equal(
    planGateDecision({
      triage: { verdict: "needs_review", questions: [], consumed: false, parseFallback: false },
      priorQuestionRounds: 0,
    }),
    "await_review"
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test packages/shared/src/plan-triage.test.ts`
Expected: FAIL — `Cannot find module './plan-triage.js'`

- [ ] **Step 4: Write the implementation**

Create `packages/shared/src/plan-triage.ts`:

```ts
import { z } from "zod";

export const PlanQuestionOption = z.object({
  label: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
});
export type PlanQuestionOption = z.infer<typeof PlanQuestionOption>;

export const PlanQuestion = z.object({
  id: z.string().regex(/^q\d+$/),
  question: z.string().min(1).max(300),
  options: z.array(PlanQuestionOption).min(2).max(4),
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

export const PlanTriageVerdict = z.enum(["trivial", "needs_review"]);
export type PlanTriageVerdict = z.infer<typeof PlanTriageVerdict>;

/** Agent output contract — final fenced json block of a plan reply (PRD §7.1). */
export const PlanTriageBlock = z
  .object({
    verdict: PlanTriageVerdict,
    rationale: z.string().min(1).max(300),
    questions: z.array(PlanQuestion).max(3).default([]),
  })
  .refine((t) => t.verdict !== "trivial" || t.questions.length === 0, {
    message: "trivial verdict cannot carry questions",
  });
export type PlanTriageBlock = z.infer<typeof PlanTriageBlock>;

/** plan_triage artifact contentJson (PRD §7.3). */
export const PlanTriageContent = z.object({
  verdict: PlanTriageVerdict,
  rationale: z.string(),
  questions: z.array(PlanQuestion),
  sessionId: z.string().optional(),
  parseFallback: z.boolean(),
  consumed: z.boolean().default(false),
});
export type PlanTriageContent = z.infer<typeof PlanTriageContent>;

export const PlanAnswer = z
  .object({
    questionId: z.string(),
    selectedLabel: z.string().max(60).optional(),
    freeText: z.string().min(1).max(2000).optional(),
  })
  .refine((a) => (a.selectedLabel ? !a.freeText : Boolean(a.freeText)), {
    message: "Provide exactly one of selectedLabel or freeText",
  });
export type PlanAnswer = z.infer<typeof PlanAnswer>;

/** POST /api/runs/:id/plan/answers body (PRD §7.2). */
export const PlanAnswersInput = z.object({
  answers: z.array(PlanAnswer).min(1),
});
export type PlanAnswersInput = z.infer<typeof PlanAnswersInput>;

/** plan_answers artifact contentJson (PRD §7.4). */
export const PlanAnswersContent = z.object({
  answers: z.array(PlanAnswer),
  outcome: z.enum(["approved", "redraft"]),
  answeredAt: z.string(),
});
export type PlanAnswersContent = z.infer<typeof PlanAnswersContent>;

export type PlanGateDecision = "auto_approve" | "await_answers" | "await_review";

/** After this many question rounds, drafts always go to manual review (PRD F3.5). */
export const MAX_QUESTION_ROUNDS = 2;

export function planGateDecision(input: {
  triage: Pick<PlanTriageContent, "verdict" | "questions" | "consumed" | "parseFallback">;
  /** Count of PRIOR plan_triage artifacts on this run that carried questions. */
  priorQuestionRounds: number;
}): PlanGateDecision {
  const { triage, priorQuestionRounds } = input;
  if (triage.consumed) return "await_review";
  if (triage.questions.length > 0) {
    return priorQuestionRounds >= MAX_QUESTION_ROUNDS ? "await_review" : "await_answers";
  }
  if (triage.verdict === "trivial" && !triage.parseFallback) return "auto_approve";
  return "await_review";
}
```

- [ ] **Step 5: Wire into the shared index**

In `packages/shared/src/index.ts`: add after line 9 (`export * from "./execution.js";`):

```ts
export * from "./plan-triage.js";
```

In the `ArtifactKind` enum (line 33), add two entries after `"approved_plan"`:

```ts
  "plan_triage",
  "plan_answers",
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx tsx --test packages/shared/src/plan-triage.test.ts && npm run build -w @agent-dealer/shared && npm run typecheck`
Expected: all tests PASS, build + typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/plan-triage.ts packages/shared/src/plan-triage.test.ts packages/shared/src/index.ts package.json
git commit -m "feat(shared): plan triage schemas, gate decision, unit-test runner (F1/F2 contracts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Triage block parser (`extractPlanTriage`)

**Files:**
- Modify: `packages/server/src/runners/stream-json.ts`
- Create: `packages/server/src/runners/stream-json.test.ts`

**Interfaces:**
- Consumes: `PlanTriageBlock`, `PlanQuestion` from `@agent-dealer/shared` (Task 1).
- Produces (used by Task 3): `extractPlanTriage(planMarkdown: string): PlanTriageExtraction` where `PlanTriageExtraction = { markdown: string; verdict: "trivial" | "needs_review"; rationale: string; questions: PlanQuestion[]; parseFallback: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/runners/stream-json.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlanTriage } from "./stream-json.js";

const PLAN = "# Plan\n1. Do the thing\n2. Verify";

const VALID_BLOCK = [
  "```json",
  JSON.stringify({
    verdict: "needs_review",
    rationale: "Two viable approaches",
    questions: [
      {
        id: "q1",
        question: "Which approach?",
        options: [{ label: "A" }, { label: "B", description: "slower but safer" }],
      },
    ],
  }),
  "```",
].join("\n");

test("parses trailing triage block and strips it from the markdown", () => {
  const r = extractPlanTriage(`${PLAN}\n\n${VALID_BLOCK}`);
  assert.equal(r.parseFallback, false);
  assert.equal(r.verdict, "needs_review");
  assert.equal(r.questions.length, 1);
  assert.equal(r.markdown, PLAN);
});

test("trivial block with no questions parses", () => {
  const block = '```json\n{"verdict":"trivial","rationale":"one-line change"}\n```';
  const r = extractPlanTriage(`${PLAN}\n\n${block}`);
  assert.equal(r.verdict, "trivial");
  assert.equal(r.parseFallback, false);
  assert.deepEqual(r.questions, []);
});

test("missing block falls back to needs_review with full markdown kept", () => {
  const r = extractPlanTriage(PLAN);
  assert.equal(r.parseFallback, true);
  assert.equal(r.verdict, "needs_review");
  assert.equal(r.markdown, PLAN);
});

test("malformed JSON falls back", () => {
  const r = extractPlanTriage(`${PLAN}\n\n\`\`\`json\n{not json}\n\`\`\``);
  assert.equal(r.parseFallback, true);
  assert.equal(r.markdown.includes("# Plan"), true);
});

test("last json block wins; earlier json-in-prose is ignored", () => {
  const early = '```json\n{"some":"config"}\n```';
  const r = extractPlanTriage(`${PLAN}\n\n${early}\n\nMore prose\n\n${VALID_BLOCK}`);
  assert.equal(r.parseFallback, false);
  assert.equal(r.markdown.includes('{"some":"config"}'), true);
  assert.equal(r.markdown.includes('"verdict"'), false);
});

test("valid json block that is not a triage shape falls back", () => {
  const r = extractPlanTriage(`${PLAN}\n\n\`\`\`json\n{"foo":"bar"}\n\`\`\``);
  assert.equal(r.parseFallback, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/runners/stream-json.test.ts`
Expected: FAIL — `extractPlanTriage` is not exported.

- [ ] **Step 3: Implement in `stream-json.ts`**

Change the import at line 2 and append the new function at the end of `packages/server/src/runners/stream-json.ts`:

```ts
import { PlanTriageBlock } from "@agent-dealer/shared";
import type { PlanQuestion, RunPhase, Runtime, StreamTraceEntry, UsageContent } from "@agent-dealer/shared";
```

```ts
export interface PlanTriageExtraction {
  markdown: string;
  verdict: "trivial" | "needs_review";
  rationale: string;
  questions: PlanQuestion[];
  parseFallback: boolean;
}

const TRIAGE_FALLBACK = {
  verdict: "needs_review" as const,
  rationale: "Agent did not return a valid triage block",
  questions: [] as PlanQuestion[],
  parseFallback: true,
};

/** Parse the trailing fenced json triage block from plan markdown (PRD F1.2). */
export function extractPlanTriage(planMarkdown: string): PlanTriageExtraction {
  const blocks = [...planMarkdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = blocks[blocks.length - 1];
  if (!last) return { markdown: planMarkdown.trim(), ...TRIAGE_FALLBACK };
  try {
    const parsed = PlanTriageBlock.parse(JSON.parse(last[1]));
    const markdown = (
      planMarkdown.slice(0, last.index) + planMarkdown.slice(last.index! + last[0].length)
    ).trim();
    return {
      markdown,
      verdict: parsed.verdict,
      rationale: parsed.rationale,
      questions: parsed.questions,
      parseFallback: false,
    };
  } catch {
    return { markdown: planMarkdown.trim(), ...TRIAGE_FALLBACK };
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test packages/server/src/runners/stream-json.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runners/stream-json.ts packages/server/src/runners/stream-json.test.ts
git commit -m "feat(server): extractPlanTriage parser with status-quo fallback (F1.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Prompt contract, revise prompt, answers section

**Files:**
- Modify: `packages/server/src/runners/prompts.ts`
- Create: `packages/server/src/runners/prompts.test.ts`

**Interfaces:**
- Consumes: `PlanAnswer`, `PlanAnswersContent`, `PlanQuestion`, `PlanTriageContent` from shared; `getLatestArtifact` (already imported).
- Produces (used by Task 5): `buildPlanRevisePrompt(run: Run, questions: PlanQuestion[], answers: PlanAnswer[]): string`. Also: `buildPlanPrompt` now emits the triage contract; `buildExecutionPrompt` renders `## Human answers to plan questions`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/runners/prompts.test.ts` (temp DB; each test file runs in its own process under `tsx --test`):

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-prompts-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun } = await import("../repository/runs.js");
const { buildExecutionPrompt, buildPlanPrompt, buildPlanRevisePrompt } = await import("./prompts.js");

const QUESTIONS = [
  {
    id: "q1",
    question: "Which storage backend?",
    options: [{ label: "SQLite" }, { label: "Postgres" }],
  },
];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function makeRun() {
  return createRun({
    title: "Prompt test task",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
}

test("plan prompt includes the triage contract", () => {
  const prompt = buildPlanPrompt(makeRun());
  assert.match(prompt, /"verdict"/);
  assert.match(prompt, /needs_review/);
  assert.match(prompt, /at most 3 questions/i);
});

test("execution prompt renders human answers as Q→A pairs", () => {
  const run = makeRun();
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  addArtifact(
    run.id,
    "plan_triage",
    { verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false },
    "agent"
  );
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  addArtifact(
    run.id,
    "plan_answers",
    {
      answers: [{ questionId: "q1", selectedLabel: "SQLite" }],
      outcome: "approved",
      answeredAt: new Date().toISOString(),
    },
    "human"
  );
  const prompt = buildExecutionPrompt(run);
  assert.match(prompt, /## Human answers to plan questions/);
  assert.match(prompt, /Which storage backend\?.*SQLite/s);
});

test("execution prompt omits answers section when none exist", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan" }, "human");
  assert.doesNotMatch(buildExecutionPrompt(run), /Human answers to plan questions/);
});

test("revise prompt pairs each answer with its question and re-states the contract", () => {
  const run = makeRun();
  const prompt = buildPlanRevisePrompt(run, QUESTIONS, [{ questionId: "q1", freeText: "Use flat files instead" }]);
  assert.match(prompt, /Which storage backend\?/);
  assert.match(prompt, /Use flat files instead/);
  assert.match(prompt, /"verdict"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: FAIL — `buildPlanRevisePrompt` not exported (and contract assertions fail).

- [ ] **Step 3: Implement in `prompts.ts`**

Add to imports at the top:

```ts
import type { ArtifactKind, PlanAnswer, PlanAnswersContent, PlanQuestion, PlanTriageContent, Run } from "@agent-dealer/shared";
```

Add these functions above `buildPlanPrompt`:

```ts
function planTriageContractSection(): string {
  return [
    "## Required final JSON block",
    "After the plan markdown, end your reply with exactly one fenced ```json block shaped like:",
    '{"verdict":"trivial"|"needs_review","rationale":"one sentence","questions":[{"id":"q1","question":"...","options":[{"label":"...","description":"..."}]}]}',
    "Rules:",
    '- "trivial" means this plan is safe to execute without human review; it requires an empty questions array. When in doubt, use "needs_review".',
    "- Ask at most 3 questions, and only when the answer changes how you would execute. Never ask permission to proceed.",
    "- Each question needs 2-4 concrete options; give each option a short description.",
  ].join("\n");
}

function planAnswersSections(run: Run): string[] {
  const ansArt = getLatestArtifact(run.id, "plan_answers");
  if (!ansArt?.contentJson) return [];
  try {
    const ans = JSON.parse(ansArt.contentJson) as PlanAnswersContent;
    if (ans.outcome !== "approved" || ans.answers.length === 0) return [];
    const triArt = getLatestArtifact(run.id, "plan_triage");
    const questions: PlanQuestion[] = triArt?.contentJson
      ? (JSON.parse(triArt.contentJson) as PlanTriageContent).questions
      : [];
    const lines = ans.answers.map((a) => {
      const q = questions.find((x) => x.id === a.questionId);
      return `- ${q?.question ?? a.questionId}: **${a.selectedLabel ?? a.freeText ?? ""}**`;
    });
    return ["## Human answers to plan questions", ...lines, ""];
  } catch {
    return [];
  }
}

export function buildPlanRevisePrompt(
  run: Run,
  questions: PlanQuestion[],
  answers: PlanAnswer[]
): string {
  const qa = answers.map((a) => {
    const q = questions.find((x) => x.id === a.questionId);
    return `- Q: ${q?.question ?? a.questionId}\n  A: ${a.selectedLabel ?? a.freeText ?? ""}`;
  });
  return [
    "The human answered your plan questions. Revise the plan accordingly — do not execute anything.",
    "",
    "## Task",
    taskText(run),
    "",
    "## Answers",
    ...qa,
    "",
    planTriageContractSection(),
  ].join("\n");
}
```

In `buildPlanPrompt` (line 213), replace:

```ts
  parts.push(`Output a step-by-step plan with risks. End with the plan markdown only.`);
```

with:

```ts
  parts.push(`Output a step-by-step plan with risks.`, ``, planTriageContractSection());
```

In `buildExecutionPrompt`, after the `if (ctx) { ... } else { ... }` block that pushes plan/feedback (line 97-107), insert:

```ts
  parts.push(...planAnswersSections(run));
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test packages/server/src/runners/prompts.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/runners/prompts.ts packages/server/src/runners/prompts.test.ts
git commit -m "feat(server): triage contract in plan prompt, answers in execution prompt, revise prompt (F1.1/F3.3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Persist `plan_triage` + auto-approve gate in dispatcher

**Files:**
- Modify: `packages/server/src/runners/persist.ts` (plan branch, line 118-121)
- Modify: `packages/server/src/queue/dispatcher.ts` (`draftPlan`, new `applyPlanGate`)
- Create: `packages/server/src/queue/plan-gate.test.ts`

**Interfaces:**
- Consumes: `extractPlanTriage` (Task 2), `planGateDecision`/`PlanTriageContent`/`PlanContent` (Task 1).
- Produces (used by Task 5 + tests): `persistRunOutput` return gains `planTriage?: PlanTriageExtraction`; dispatcher exports `applyPlanGate(run: Run): PlanGateDecision`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/queue/plan-gate.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-gate-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, getRun } = await import("../repository/runs.js");
const { applyPlanGate, getSnapshot } = await import("./dispatcher.js");

const QUESTIONS = [
  { id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] },
];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedRun(triage: Record<string, unknown>) {
  const run = createRun({
    title: "Gate test",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  addArtifact(run.id, "plan_triage", triage, "agent");
  return getRun(run.id)!;
}

test("trivial triage auto-approves: system approved_plan + plan_approved status", () => {
  const run = seedRun({ verdict: "trivial", rationale: "tiny", questions: [], parseFallback: false, consumed: false });
  assert.equal(applyPlanGate(run), "auto_approve");
  assert.equal(getRun(run.id)!.status, "plan_approved");
  const approved = getLatestArtifact(run.id, "approved_plan");
  assert.equal(approved!.author, "system");
  assert.match(approved!.contentJson!, /tiny/);
});

test("questions await answers and leave status untouched", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  assert.equal(applyPlanGate(run), "await_answers");
  assert.equal(getRun(run.id)!.status, "plan_pending");
});

test("third question round goes to manual review", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r1", questions: QUESTIONS, parseFallback: false, consumed: false });
  addArtifact(run.id, "plan_triage", { verdict: "needs_review", rationale: "r2", questions: QUESTIONS, parseFallback: false, consumed: false }, "agent");
  addArtifact(run.id, "plan_triage", { verdict: "needs_review", rationale: "r3", questions: QUESTIONS, parseFallback: false, consumed: false }, "agent");
  assert.equal(applyPlanGate(getRun(run.id)!), "await_review");
});

test("snapshot exposes awaitingAnswerRuns, openQuestionCounts, autoApprovedRunIds", () => {
  const snap = getSnapshot();
  assert.equal(Array.isArray(snap.awaitingAnswerRuns), true);
  assert.equal(typeof snap.openQuestionCounts, "object");
  assert.equal(Array.isArray(snap.autoApprovedRunIds), true);
});
```

(The snapshot-field assertions will pass only after Task 6; mark this file's last test with `test.skip` for now — Task 6 Step 1 un-skips it.)

Use `test.skip("snapshot exposes ...", ...)` in this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/queue/plan-gate.test.ts`
Expected: FAIL — `applyPlanGate` is not exported from `./dispatcher.js`.

- [ ] **Step 3: Extend `persistRunOutput` (persist.ts)**

Add to the imports from `./stream-json.js`: `extractPlanTriage` and `type PlanTriageExtraction`.

Extend the return type (line 68-74):

```ts
export function persistRunOutput(input: PersistRunOutputInput): {
  planMarkdown?: string;
  planTriage?: PlanTriageExtraction;
  resultText?: string;
  sessionId?: string;
  blocked?: boolean;
  blockerSummary?: string;
} {
```

Replace the plan branch (line 118-121):

```ts
  if (phase === "plan") {
    const rawPlan = extractPlanMarkdown(events);
    const planTriage = extractPlanTriage(rawPlan);
    return {
      planMarkdown: planTriage.markdown,
      planTriage,
      resultText,
      sessionId,
      blocked: blocker.detected,
      blockerSummary: blocker.summary,
    };
  }
```

- [ ] **Step 4: Add the gate to `dispatcher.ts`**

Extend imports:

```ts
import { addArtifact, countByStatus, getLatestArtifact, getRun, listArtifacts, listRuns, transitionRun } from "../repository/runs.js";
import { planGateDecision } from "@agent-dealer/shared";
import type { AgentWithHealth, PlanContent, PlanGateDecision, PlanTriageContent } from "@agent-dealer/shared";
```

Add above `draftPlan`:

```ts
function priorQuestionRounds(runId: string, currentTriageArtifactId: string): number {
  return listArtifacts(runId).filter((a) => {
    if (a.kind !== "plan_triage" || a.id === currentTriageArtifactId || !a.contentJson) return false;
    try {
      const c = JSON.parse(a.contentJson) as { questions?: unknown[] };
      return (c.questions?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }).length;
}

/** Self-triage gate after a plan draft persists (PRD F2). Exported for tests. */
export function applyPlanGate(run: Run): PlanGateDecision {
  const art = getLatestArtifact(run.id, "plan_triage");
  if (!art?.contentJson) return "await_review";
  let triage: PlanTriageContent;
  try {
    triage = JSON.parse(art.contentJson) as PlanTriageContent;
  } catch {
    return "await_review";
  }
  const decision = planGateDecision({
    triage,
    priorQuestionRounds: priorQuestionRounds(run.id, art.id),
  });
  if (decision !== "auto_approve") return decision;

  const fresh = getRun(run.id);
  if (!fresh || fresh.status !== "plan_pending") return "await_review";
  const draft = getLatestArtifact(run.id, "draft_plan");
  if (!draft?.contentJson) return "await_review";

  const plan = JSON.parse(draft.contentJson) as PlanContent;
  addArtifact(run.id, "approved_plan", { ...plan, autoApproved: true, rationale: triage.rationale }, "system");
  transitionRun(run.id, "plan_approved");
  void forceDispatch();
  return "auto_approve";
}
```

In `draftPlan`, replace the `if (persisted.planMarkdown)` block (line 274-281):

```ts
    if (persisted.planMarkdown) {
      addArtifact(
        updated.id,
        "draft_plan",
        { markdown: persisted.planMarkdown, sessionId: persisted.sessionId },
        "agent",
        result.logPath
      );
      const triage = persisted.planTriage;
      if (triage) {
        addArtifact(
          updated.id,
          "plan_triage",
          {
            verdict: triage.verdict,
            rationale: triage.rationale,
            questions: triage.questions,
            sessionId: persisted.sessionId,
            parseFallback: triage.parseFallback,
            consumed: false,
          },
          "agent"
        );
        applyPlanGate(getRun(run.id)!);
      }
    } else if (!opts?.replace) {
```

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `npx tsx --test packages/server/src/queue/plan-gate.test.ts && npm run typecheck`
Expected: 3 tests PASS, 1 skipped; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/runners/persist.ts packages/server/src/queue/dispatcher.ts packages/server/src/queue/plan-gate.test.ts
git commit -m "feat(server): persist plan_triage and auto-approve trivial plans (F1.3/F2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Answer flow — `submitPlanAnswers`, revise-resume plumbing, route

**Files:**
- Modify: `packages/server/src/queue/dispatcher.ts` (`submitPlanAnswers`, `scheduleRevisePlan`, `draftPlan` revise opts)
- Modify: `packages/server/src/runners/claude.ts` (`runClaude`/`runAgent` opts)
- Modify: `packages/server/src/runners/reflect.ts:48` (call-site signature)
- Modify: `packages/server/src/repository/runs.ts` (`markPlanTriageConsumed`)
- Modify: `packages/server/src/routes/index.ts` (POST answers route; consumed on human draft save)
- Create: `packages/server/src/queue/answers.test.ts`

**Interfaces:**
- Consumes: `buildPlanRevisePrompt` (Task 3), `applyPlanGate` (Task 4), shared schemas (Task 1).
- Produces (used by Task 8 web + Task 9 flow-verify):
  - `submitPlanAnswers(runId: string, input: PlanAnswersInput, opts?: { onRedraft?: (run: Run, triage: PlanTriageContent, answers: PlanAnswer[]) => void }): SubmitAnswersResult` where `SubmitAnswersResult = { ok: true; outcome: "approved" | "redraft"; run: Run } | { ok: false; code: 400 | 404 | 409; error: string }`
  - `POST /api/runs/:id/plan/answers` → 200 `{ run, outcome }`, 400/404/409 `{ error }`
  - `markPlanTriageConsumed(runId: string): void` (repository)
  - `runClaude(run, mode, model?, opts?: { promptOverride?: string; resumeSessionId?: string })`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/queue/answers.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-answers-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, getRun, markPlanTriageConsumed } =
  await import("../repository/runs.js");
const { submitPlanAnswers } = await import("./dispatcher.js");

const QUESTIONS = [
  { id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] },
  { id: "q2", question: "Ship docs too?", options: [{ label: "Yes" }, { label: "No" }] },
];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedQuestionRun() {
  const run = createRun({
    title: "Answers test",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "draft_plan", { markdown: "# Plan", sessionId: "sess-1" }, "agent");
  addArtifact(
    run.id,
    "plan_triage",
    { verdict: "needs_review", rationale: "r", questions: QUESTIONS, sessionId: "sess-1", parseFallback: false, consumed: false },
    "agent"
  );
  return getRun(run.id)!;
}

test("all-structured answers approve and mark plan_answers approved", () => {
  const run = seedQuestionRun();
  const res = submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "A" },
      { questionId: "q2", selectedLabel: "No" },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.outcome, "approved");
  assert.equal(getRun(run.id)!.status, "plan_approved");
  const ans = getLatestArtifact(run.id, "plan_answers");
  assert.match(ans!.contentJson!, /"outcome":"approved"/);
  assert.equal(getLatestArtifact(run.id, "approved_plan")!.author, "human");
});

test("free-form answer schedules a redraft instead of approving", () => {
  const run = seedQuestionRun();
  let redrafted = false;
  const res = submitPlanAnswers(
    run.id,
    {
      answers: [
        { questionId: "q1", freeText: "Do it a third way" },
        { questionId: "q2", selectedLabel: "Yes" },
      ],
    },
    { onRedraft: () => { redrafted = true; } }
  );
  assert.equal(res.ok && res.outcome, "redraft");
  assert.equal(redrafted, true);
  assert.equal(getRun(run.id)!.status, "plan_pending");
});

test("answers must cover every open question exactly once", () => {
  const run = seedQuestionRun();
  const res = submitPlanAnswers(run.id, { answers: [{ questionId: "q1", selectedLabel: "A" }] });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, 400);
});

test("double submit returns 409", () => {
  const run = seedQuestionRun();
  submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "A" },
      { questionId: "q2", selectedLabel: "Yes" },
    ],
  });
  const again = submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "B" },
      { questionId: "q2", selectedLabel: "No" },
    ],
  });
  assert.equal(!again.ok && again.code, 409);
});

test("run without open questions returns 409", () => {
  const run = createRun({
    title: "No questions",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  const res = submitPlanAnswers(run.id, { answers: [{ questionId: "q1", selectedLabel: "A" }] });
  assert.equal(!res.ok && res.code, 409);
});

test("consumed triage rejects answers", () => {
  const run = seedQuestionRun();
  markPlanTriageConsumed(run.id);
  const res = submitPlanAnswers(run.id, {
    answers: [
      { questionId: "q1", selectedLabel: "A" },
      { questionId: "q2", selectedLabel: "Yes" },
    ],
  });
  assert.equal(!res.ok && res.code, 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/queue/answers.test.ts`
Expected: FAIL — `markPlanTriageConsumed` / `submitPlanAnswers` not exported.

- [ ] **Step 3: Add `markPlanTriageConsumed` to `repository/runs.ts`**

Append after `getLatestArtifact` (line 522):

```ts
/** Latest plan_triage stops auto-approving / accepting answers once a human takes over the plan. */
export function markPlanTriageConsumed(runId: string): void {
  const art = getLatestArtifact(runId, "plan_triage");
  if (!art?.contentJson) return;
  try {
    const content = JSON.parse(art.contentJson) as Record<string, unknown>;
    if (content.consumed === true) return;
    updateArtifactContent(art.id, { ...content, consumed: true });
  } catch {
    /* leave malformed triage untouched */
  }
}
```

- [ ] **Step 4: Thread revise opts through the runner (`claude.ts`)**

Change `runClaude`'s signature (line 42-47) and the two lines that use it:

```ts
export async function runClaude(
  run: Run,
  mode: "execute" | "plan" | "reflect" = "execute",
  model?: string,
  opts?: { promptOverride?: string; resumeSessionId?: string }
): Promise<RunnerResult> {
```

```ts
  const resumeSessionId =
    opts?.resumeSessionId ??
    (mode === "execute" && humanFeedbackText(run) ? lineageParentExecuteSessionId(run) : null);

  const prompt =
    opts?.promptOverride ??
    (mode === "plan"
```

Change `runAgent` (line 131-139):

```ts
export async function runAgent(
  run: Run,
  mode: "execute" | "plan" = "execute",
  revise?: { resumeSessionId?: string; prompt: string }
): Promise<RunnerResult> {
  const fresh = getRun(run.id) ?? run;
  const model = resolveModelForPhase(fresh, mode);
  if (fresh.runtime === "cursor_local") return runCursor(fresh, mode, model);
  return runClaude(fresh, mode, model, revise ? { promptOverride: revise.prompt, resumeSessionId: revise.resumeSessionId } : undefined);
}
```

Update `packages/server/src/runners/reflect.ts:48`:

```ts
    const result = await runClaude(run, "reflect", undefined, { promptOverride: buildReflectPrompt(run, opts) });
```

- [ ] **Step 5: Add `submitPlanAnswers` + revise scheduling to `dispatcher.ts`**

Extend imports: add `markPlanTriageConsumed` is NOT needed here; add to shared imports `PlanAnswer`, `PlanAnswersInput` types and `buildPlanRevisePrompt` from `../runners/prompts.js`.

Extend `draftPlan` opts (line 239) and the runner call (line 257):

```ts
export async function draftPlan(
  run: Run,
  opts?: { replace?: boolean; revise?: { resumeSessionId?: string; prompt: string } }
): Promise<Run> {
```

```ts
    const result = await runAgent(updated, "plan", opts?.revise);
```

Append after `applyPlanGate`:

```ts
export type SubmitAnswersResult =
  | { ok: true; outcome: "approved" | "redraft"; run: Run }
  | { ok: false; code: 400 | 404 | 409; error: string };

/** Answer open plan questions (PRD F3). Structured answers approve + dispatch; free-form revises the plan. */
export function submitPlanAnswers(
  runId: string,
  input: PlanAnswersInput,
  opts?: { onRedraft?: (run: Run, triage: PlanTriageContent, answers: PlanAnswer[]) => void }
): SubmitAnswersResult {
  const run = getRun(runId);
  if (!run) return { ok: false, code: 404, error: "Not found" };
  if (run.status !== "plan_pending") {
    return { ok: false, code: 409, error: `No open questions — run is ${run.status}` };
  }

  const triageArt = getLatestArtifact(runId, "plan_triage");
  if (!triageArt?.contentJson) return { ok: false, code: 409, error: "No open questions" };
  let triage: PlanTriageContent;
  try {
    triage = JSON.parse(triageArt.contentJson) as PlanTriageContent;
  } catch {
    return { ok: false, code: 409, error: "No open questions" };
  }
  if (triage.consumed || triage.questions.length === 0) {
    return { ok: false, code: 409, error: "No open questions" };
  }
  const priorAnswers = getLatestArtifact(runId, "plan_answers");
  if (priorAnswers && priorAnswers.createdAt > triageArt.createdAt) {
    return { ok: false, code: 409, error: "Questions already answered" };
  }

  const expected = triage.questions.map((q) => q.id).sort().join(",");
  const got = input.answers.map((a) => a.questionId).sort().join(",");
  if (expected !== got) {
    return { ok: false, code: 400, error: "Answers must cover every open question exactly once" };
  }

  const freeForm = input.answers.some((a) => a.freeText);
  const outcome = freeForm ? ("redraft" as const) : ("approved" as const);
  addArtifact(
    runId,
    "plan_answers",
    { answers: input.answers, outcome, answeredAt: new Date().toISOString() },
    "human"
  );

  if (!freeForm) {
    const draft = getLatestArtifact(runId, "draft_plan");
    const plan = draft?.contentJson ? (JSON.parse(draft.contentJson) as PlanContent) : { markdown: "" };
    addArtifact(runId, "approved_plan", plan, "human");
    transitionRun(runId, "plan_approved");
    void forceDispatch();
    return { ok: true, outcome, run: getRun(runId)! };
  }

  (opts?.onRedraft ?? scheduleRevisePlan)(getRun(runId)!, triage, input.answers);
  return { ok: true, outcome, run: getRun(runId)! };
}

function scheduleRevisePlan(run: Run, triage: PlanTriageContent, answers: PlanAnswer[]): void {
  if (activePlanDrafts.has(run.id)) return;
  activePlanDrafts.add(run.id);
  void draftPlan(run, {
    replace: true,
    revise: {
      resumeSessionId: triage.sessionId,
      prompt: buildPlanRevisePrompt(run, triage.questions, answers),
    },
  })
    .catch((e) => console.error("[plan-revise]", run.id, e))
    .finally(() => {
      activePlanDrafts.delete(run.id);
      notify().catch(console.error);
    });
}
```

Note: `needsPlanDraft` (line 54-60) returns false when a `draft_plan` exists, so the background `dispatchPlanDrafts` loop will not race `scheduleRevisePlan`.

- [ ] **Step 6: Add the route + consumed hook (`routes/index.ts`)**

Add `PlanAnswersInput` to the shared imports (line 3-18), `markPlanTriageConsumed` to the repository imports (line 20-34), and `submitPlanAnswers` to the dispatcher imports (line 43-51).

Insert after the `PATCH /api/runs/:id/plan` handler:

```ts
  app.post("/api/runs/:id/plan/answers", async (req, reply) => {
    const { id } = req.params as { id: string };
    let input;
    try {
      input = PlanAnswersInput.parse(req.body);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
    const result = submitPlanAnswers(id, input);
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { run: result.run, outcome: result.outcome };
  });
```

In the `PATCH /api/runs/:id/plan` handler, right after `addArtifact(id, kind, { markdown: input.planMarkdown }, "human");` (line 353), add:

```ts
    if (!input.approve) {
      markPlanTriageConsumed(id);
    }
```

- [ ] **Step 7: Run tests + typecheck to verify pass**

Run: `npx tsx --test packages/server/src/queue/answers.test.ts && npm run typecheck`
Expected: 6 tests PASS; typecheck clean (reflect.ts call-site updated).

- [ ] **Step 8: Run the full unit suite**

Run: `npm run test:unit`
Expected: all files PASS (1 skipped snapshot test).

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/queue/dispatcher.ts packages/server/src/queue/answers.test.ts packages/server/src/runners/claude.ts packages/server/src/runners/reflect.ts packages/server/src/repository/runs.ts packages/server/src/routes/index.ts
git commit -m "feat(server): plan answers flow — approve fast path, session-resumed revise, POST route (F3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Snapshot fields for the UI

**Files:**
- Modify: `packages/shared/src/index.ts` (QueueSnapshot, line 389-405)
- Modify: `packages/server/src/queue/dispatcher.ts` (`QueueSnapshotInternal`, `getSnapshot`)
- Modify: `packages/server/src/queue/plan-gate.test.ts` (un-skip snapshot test)

**Interfaces:**
- Consumes: artifacts written by Tasks 4–5.
- Produces (used by Tasks 8–9): `QueueSnapshot` gains `awaitingAnswerRuns: Run[]`, `openQuestionCounts: Record<string, number>`, `autoApprovedRunIds: string[]`.

- [ ] **Step 1: Un-skip the snapshot test in `plan-gate.test.ts`**

Change `test.skip("snapshot exposes ...` back to `test("snapshot exposes ...`.

Run: `npx tsx --test packages/server/src/queue/plan-gate.test.ts`
Expected: FAIL — snapshot has no `awaitingAnswerRuns`.

- [ ] **Step 2: Extend the shared `QueueSnapshot` schema**

In `packages/shared/src/index.ts`, inside `QueueSnapshot` (line 389), after `awaitingPlanReview: z.array(Run),`:

```ts
  awaitingAnswerRuns: z.array(Run),
  openQuestionCounts: z.record(z.string(), z.number()),
  autoApprovedRunIds: z.array(z.string()),
```

- [ ] **Step 3: Compute the fields in `dispatcher.ts`**

Add to `QueueSnapshotInternal` (line 22-37):

```ts
  awaitingAnswerRuns: Run[];
  openQuestionCounts: Record<string, number>;
  autoApprovedRunIds: string[];
```

Add above `getSnapshot`:

```ts
/** Open (unanswered, unconsumed) question count for a plan_pending run. */
function openQuestionCount(runId: string): number {
  const tri = getLatestArtifact(runId, "plan_triage");
  if (!tri?.contentJson) return 0;
  try {
    const c = JSON.parse(tri.contentJson) as { questions?: unknown[]; consumed?: boolean };
    if (c.consumed || !c.questions?.length) return 0;
    const ans = getLatestArtifact(runId, "plan_answers");
    if (ans && ans.createdAt > tri.createdAt) return 0;
    return c.questions.length;
  } catch {
    return 0;
  }
}
```

In `getSnapshot` (line 81), after `awaitingPlanReview` is computed:

```ts
  const openQuestionCounts: Record<string, number> = {};
  for (const run of awaitingPlanReview) {
    const n = openQuestionCount(run.id);
    if (n > 0) openQuestionCounts[run.id] = n;
  }
  const awaitingAnswerRuns = awaitingPlanReview.filter((r) => openQuestionCounts[r.id]);
  const autoApprovedRunIds = [...waitingExecution, ...runningRuns]
    .filter((r) => getLatestArtifact(r.id, "approved_plan")?.author === "system")
    .map((r) => r.id);
```

and add the three fields to the returned object:

```ts
    awaitingAnswerRuns,
    openQuestionCounts,
    autoApprovedRunIds,
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `npm run test:unit && npm run typecheck`
Expected: all PASS, nothing skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/server/src/queue/dispatcher.ts packages/server/src/queue/plan-gate.test.ts
git commit -m "feat: snapshot exposes open questions and auto-approved runs (F4.4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `Skill` in all spawned-phase allowlists (F5)

**Files:**
- Modify: `packages/server/src/runners/claude.ts:83-100`

**Interfaces:**
- Consumes/Produces: CLI args only; no code interface changes.

- [ ] **Step 1: Add `Skill` to the three allowlists**

Plan (line 85-86) and reflect (line 90-91) become:

```ts
      "Read,Glob,Grep,Skill,mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace"
```

Execute (line 98) becomes:

```ts
      "Read,Write,Edit,Glob,Grep,Bash,Skill,mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace"
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/runners/claude.ts
git commit -m "feat(server): allowlist Skill tool in plan/execute/reflect phases (F5.1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Dashboard — question card, lane highlight, auto-approved badge

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/drawer/PlanQuestionsCard.tsx`
- Modify: `apps/web/src/components/drawer/PlanReviewPanel.tsx`
- Modify: `apps/web/src/components/RunCard.tsx`
- Modify: `apps/web/src/components/ops/PlanApprovalColumn.tsx`
- Modify: `apps/web/src/components/ops/PipelineTicketsPanel.tsx`
- Modify: `apps/web/src/pages/OperationsPage.tsx`
- Modify: `apps/web/src/components/drawer/ExecutionPanel.tsx`

**Interfaces:**
- Consumes: `POST /api/runs/:id/plan/answers` (Task 5); snapshot fields (Task 6); `PlanQuestion`, `PlanTriageContent` types (Task 1).
- Produces: UI only. Verification is `npm run typecheck` + manual smoke (no web test infra exists).

- [ ] **Step 1: API client (`api.ts`)**

Append:

```ts
export async function submitPlanAnswers(
  id: string,
  answers: Array<{ questionId: string; selectedLabel?: string; freeText?: string }>
): Promise<{ run: Run; outcome: "approved" | "redraft" }> {
  const res = await fetch(`${API}/api/runs/${id}/plan/answers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

- [ ] **Step 2: Question card component**

Create `apps/web/src/components/drawer/PlanQuestionsCard.tsx`:

```tsx
import { useState } from "react";
import type { PlanQuestion } from "@agent-dealer/shared";

type AnswerDraft = { selectedLabel?: string; freeText?: string };

type Props = {
  questions: PlanQuestion[];
  busy: boolean;
  onSubmit: (answers: Array<{ questionId: string; selectedLabel?: string; freeText?: string }>) => void;
};

/** Structured plan questions — option buttons approve fast; free-form triggers a replan. */
export default function PlanQuestionsCard({ questions, busy, onSubmit }: Props) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const allAnswered = questions.every((q) => {
    const d = drafts[q.id];
    return Boolean(d?.selectedLabel || d?.freeText?.trim());
  });
  const hasFreeForm = questions.some((q) => drafts[q.id]?.freeText?.trim());

  return (
    <section className="space-y-3 rounded-xl border border-amber-400/40 bg-amber-400/5 p-3">
      <div className="heading-section text-amber-200">Agent needs your answer</div>
      {questions.map((q) => {
        const d = drafts[q.id] ?? {};
        return (
          <div key={q.id} className="space-y-1.5">
            <p className="text-sm text-white/85">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  disabled={busy}
                  title={o.description}
                  onClick={() => setDrafts((prev) => ({ ...prev, [q.id]: { selectedLabel: o.label } }))}
                  className={`btn-ghost text-xs px-2 py-1 ${
                    d.selectedLabel === o.label ? "ring-1 ring-amber-300 text-amber-200" : ""
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <input
              className="field-mono w-full text-xs"
              placeholder="Other… (free-form answer triggers a replan)"
              value={d.freeText ?? ""}
              disabled={busy}
              onChange={(e) =>
                setDrafts((prev) => ({
                  ...prev,
                  [q.id]: e.target.value ? { freeText: e.target.value } : {},
                }))
              }
            />
          </div>
        );
      })}
      <button
        type="button"
        disabled={busy || !allAnswered}
        className="btn-gold px-4 py-1.5 disabled:opacity-40"
        onClick={() =>
          onSubmit(questions.map((q) => ({ questionId: q.id, ...drafts[q.id] })))
        }
      >
        {hasFreeForm ? "Submit & replan" : "Submit & start execution"}
      </button>
    </section>
  );
}
```

- [ ] **Step 3: Render the card in `PlanReviewPanel.tsx`**

Add imports:

```tsx
import type { PlanTriageContent } from "@agent-dealer/shared";
import { parseArtifact, submitPlanAnswers } from "../../api";
import PlanQuestionsCard from "./PlanQuestionsCard";
```

(merge `parseArtifact`/`submitPlanAnswers` into the existing `../../api` import list).

Below `const planning = agentPlanning || replanning;` (line 63) add:

```tsx
  const triageArt = latestArtifact(artifacts, "plan_triage");
  const answersArt = latestArtifact(artifacts, "plan_answers");
  const triage = triageArt ? parseArtifact<PlanTriageContent>(triageArt) : null;
  const openQuestions =
    run.status === "plan_pending" &&
    triage &&
    !triage.consumed &&
    triage.questions.length > 0 &&
    (!answersArt || answersArt.createdAt <= triageArt!.createdAt)
      ? triage.questions
      : [];
```

In the JSX, immediately after the `Agent` section (line 141) insert:

```tsx
      {openQuestions.length > 0 && !planning && (
        <PlanQuestionsCard
          questions={openQuestions}
          busy={busy}
          onSubmit={(answers) =>
            act(async () => {
              const res = await submitPlanAnswers(run.id, answers);
              if (res.outcome === "approved") {
                onApproved?.();
                onApprovedAndNext?.();
              } else {
                setReplanning(true);
              }
            })
          }
        />
      )}
```

(`setReplanning(true)` reuses the existing 3-second poll to pick up the revised draft.)

- [ ] **Step 4: `RunCard` extra badge slot**

In `RunCard.tsx` add to `RunCardProps`:

```tsx
  /** Extra context badge (open questions, auto-approved) */
  extraBadge?: { label: string; className: string };
```

destructure `extraBadge` in the component signature, and render it in Row 3 right after the `deck` badge (line 109):

```tsx
          {extraBadge && <Badge className={`${extraBadge.className} normal-case`}>{extraBadge.label}</Badge>}
```

- [ ] **Step 5: Lane highlight in `PlanApprovalColumn.tsx`**

```tsx
import type { Run } from "@agent-dealer/shared";
import RunCard from "../RunCard";
import KanbanColumn from "../ui/KanbanColumn";

type Props = {
  runs: Run[];
  openQuestionCounts: Record<string, number>;
  selectedId: string | null;
  onSelect: (run: Run) => void;
};

/** Leftmost Operations column — runs with a plan ready for human review. */
export default function PlanApprovalColumn({ runs, openQuestionCounts, selectedId, onSelect }: Props) {
  const needsAnswer = runs.filter((r) => openQuestionCounts[r.id]).length;
  return (
    <KanbanColumn
      title={needsAnswer > 0 ? `Review Plan · ${needsAnswer} need answers` : "Review Plan"}
      count={runs.length}
      accent="border-t-cyber-violet"
      titleAccent="text-cyber-violet-light"
      isEmpty={runs.length === 0}
      empty={<p className="text-sm text-white/45 py-4 text-center">No plans ready yet</p>}
    >
      {runs.map((run) => {
        const n = openQuestionCounts[run.id];
        return (
          <RunCard
            key={run.id}
            run={run}
            selected={selectedId === run.id}
            onSelect={() => onSelect(run)}
            hideStatusBadge
            extraBadge={
              n
                ? {
                    label: n === 1 ? "1 question" : `${n} questions`,
                    className: "bg-amber-400/15 text-amber-200 border-amber-400/35",
                  }
                : undefined
            }
          />
        );
      })}
    </KanbanColumn>
  );
}
```

- [ ] **Step 6: Auto-approved badge in `PipelineTicketsPanel.tsx`**

Add to `Props`: `autoApprovedRunIds?: string[];` (destructure with default `[]`), and pass to `RunCard` inside the map:

```tsx
              extraBadge={
                autoApprovedRunIds.includes(run.id)
                  ? { label: "Auto-approved", className: "bg-emerald-400/15 text-emerald-200 border-emerald-400/35" }
                  : undefined
              }
```

- [ ] **Step 7: Wire snapshot fields in `OperationsPage.tsx`**

Pass the new props:

```tsx
            <PlanApprovalColumn
              runs={planApproval}
              openQuestionCounts={snapshot?.openQuestionCounts ?? {}}
              selectedId={selectedRunId}
              onSelect={onSelectRun}
            />
```

and on the "In Progress" `PipelineTicketsPanel`:

```tsx
                autoApprovedRunIds={snapshot?.autoApprovedRunIds ?? []}
```

- [ ] **Step 8: Auto-approve rationale in `ExecutionPanel.tsx`**

Add `latestArtifact, parseArtifact` to the `../../api` import. Below the `agent` const add:

```tsx
  const approvedArt = latestArtifact(artifacts, "approved_plan");
  const autoApproved =
    approvedArt?.author === "system" ? parseArtifact<{ rationale?: string }>(approvedArt) : null;
```

In the JSX after the `Agent` section (line 93's section) insert:

```tsx
      {autoApproved && (
        <section className="space-y-1">
          <div className="heading-section text-emerald-200">Auto-approved</div>
          <p className="text-sm text-white/60">
            {autoApproved.rationale ?? "Self-triage marked this plan trivial."}
          </p>
        </section>
      )}
```

- [ ] **Step 9: Typecheck + manual smoke**

Run: `npm run build -w @agent-dealer/shared && npm run typecheck`
Expected: clean.

Then `npm run dev`, create a task, and verify: question card renders when the agent asks (or seed a `plan_triage` artifact via sqlite for a deterministic check), structured answers move the card to the execution lane, auto-approved runs show the badge and rationale.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): plan question cards, needs-answer lane highlight, auto-approved badges (F4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: flow-verify gates, docs, real-call smoke

**Files:**
- Modify: `scripts/flow-verify.ts`
- Modify: `README.md` (workflow + tools table)
- Modify: `CHANGELOG.md` (Unreleased section)

**Interfaces:**
- Consumes: everything above. PRD note: the three PRD §11 behavior gates (trivial auto-approve; structured answers → running; free-form → redraft) live as the Task 4/5 unit-integration tests — flow-verify runs against a live server where plan drafts spawn real agents, so it gets the API-surface gates only.

- [ ] **Step 1: Snapshot + answers gates in `flow-verify.ts`**

Extend the `Snapshot` type (line 25-30):

```ts
type Snapshot = {
  runningRuns: Run[];
  maxConcurrent: number;
  awaitingPlanReview: Run[];
  resultReviewRuns: Run[];
  awaitingAnswerRuns: Run[];
  openQuestionCounts: Record<string, number>;
  autoApprovedRunIds: string[];
};
```

After the existing snapshot assertions (line 61):

```ts
  assert(Array.isArray(snapshot.awaitingAnswerRuns), "snapshot.awaitingAnswerRuns");
  assert(typeof snapshot.openQuestionCounts === "object" && snapshot.openQuestionCounts !== null, "snapshot.openQuestionCounts");
  assert(Array.isArray(snapshot.autoApprovedRunIds), "snapshot.autoApprovedRunIds");
  ok("Snapshot has plan-questions fields");
```

After run creation (line 102, before the deck binding step):

```ts
  const noQuestions = await req("POST", `/api/runs/${run.id}/plan/answers`, {
    answers: [{ questionId: "q1", selectedLabel: "A" }],
  });
  assert(noQuestions.status === 409, "answers without open questions returns 409");
  ok("Plan answers gate (no open questions)");
```

Run: `npm run dev` (in one shell) then `npm run flow:verify`.
Expected: all gates ✓ including the two new ones.

- [ ] **Step 2: README + CHANGELOG**

README "Workflow (SC-1)" step 2 becomes:

```markdown
2. **Plan approval** — Agent draft or manual plan → **Approve plan**. The agent may ask structured questions (answer to start execution); plans self-triaged **trivial** auto-approve.
```

README "Trust & execution scope" table: append `, Skill` to the tools column of all three phase rows.

CHANGELOG under a new `## Unreleased` heading at the top:

```markdown
## Unreleased

- Plan-phase structured questions: agent asks up to 3 option-based questions; answering with options starts execution, free-form answers trigger a session-resumed replan (2-round cap).
- Self-triage auto-approve: plans marked `trivial` (no questions) skip human plan review; result review unchanged. Auto-approved runs are badged with rationale.
- `Skill` tool allowlisted in plan/execute/reflect phases — spawned agents can use installed skills (e.g. superpowers).
- New API: `POST /api/runs/:id/plan/answers`; snapshot gains `awaitingAnswerRuns`, `openQuestionCounts`, `autoApprovedRunIds`.
```

- [ ] **Step 3: Real-call smoke (PRD §11 week-2 exit)**

With the dev server running and `claude` on PATH:

Run: `npm run flow:doc`
Expected: completes; then inspect the newest plan log under `~/.agent-dealer-dev/.temporal/logs/*-plan-*.ndjson` — the result text ends with a valid triage JSON block, and the run detail shows a `plan_triage` artifact with `parseFallback: false`. If the model ignores the contract, tighten the wording in `planTriageContractSection()` and retry once.

- [ ] **Step 4: Full suite + commit**

Run: `npm run test:unit && npm run typecheck && npm run flow:verify`
Expected: all green.

```bash
git add scripts/flow-verify.ts README.md CHANGELOG.md
git commit -m "test+docs: flow gates and docs for plan questions & auto-approve (F2/F3/F4 verification)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

## Self-Review

- **Spec coverage:** F1.1→T3, F1.2→T2, F1.3→T4, F2.1→T1, F2.2→T4, F2.3→T1+T5 (consumed in gate + `markPlanTriageConsumed` hook), F3.1/F3.2→T5, F3.3→T3, F3.4→T5 (revise-resume), F3.5→T1+T4 (round cap), F4.1/F4.2/F4.3→T8, F4.4→T6, F5.1→T7, NFR instrumentation (`parseFallback`, system-author badge)→T4/T6, flow gates→T4/T5 unit-integration + T9 API gates (deviation from PRD §13 noted in T9 rationale: flow-verify hits a live server that spawns real agents).
- **Type consistency:** `PlanTriageContent`/`PlanAnswersInput`/`planGateDecision` names match across T1 (definition), T4/T5 (server usage), T8 (web usage); `submitPlanAnswers` exists twice deliberately — dispatcher service (T5) and web fetch client (T8), different packages.
- **Placeholders:** none — every code step shows the code; the only judgment call left to the implementer is JSX insertion points, which are given by line anchors.
