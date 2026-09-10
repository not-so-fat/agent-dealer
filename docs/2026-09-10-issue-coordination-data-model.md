# Issue Coordination — Data Model & Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the issue-centric data model (issues, worker_sessions, workflow_instances, workflow_events, human_actions, findings, usage_events, role-neutral agent profiles) and the one-time cutover script that backfills it from the legacy `runs`-oriented schema, preserving all legacy data under `legacy_v0_*` tables.

**Architecture:** Additive Zod schemas in `packages/shared`, additive `CREATE TABLE` statements in `packages/server/src/db/schema.sql`, new repository modules mirroring the existing `repository/runs.ts` pattern (snake_case SQL ↔ camelCase TS via `rowToX` mappers, `better-sqlite3` synchronous queries, `uuid` v4 ids, ISO-8601 timestamps). A standalone `scripts/migrate-to-issues.ts` cutover script performs the one-time backfill and table rename in a single transaction with pre-flight and post-flight verification.

**Tech Stack:** TypeScript, Zod, better-sqlite3, uuid. Tests use Node's built-in test runner (`node:test` + `node:assert/strict`), the same as every existing `*.test.ts` in this repo (see `packages/server/src/repository/runs-external-id.test.ts`) — **not** vitest/jest, which are not installed. The repo-root command is `npm run test:unit`, which runs `npm run build -w @agent-dealer/shared` first and then `tsx --test` over every `*.test.ts` under `packages/`. Any server-side test that imports `@agent-dealer/shared` will resolve stale/missing types unless the shared package has been rebuilt since the last shared-source change — every task below that touches server tests includes the rebuild step explicitly.

**Spec:** `docs/2026-09-10-issue-centric-coordination-design.md` (Data model, Migration and cutover sections)

## Global Constraints

- No new database library — all access goes through the existing `getDb()` singleton in `packages/server/src/db/index.ts`.
- Zod schema per record type in `packages/shared/src/*.ts`, re-exported from `packages/shared/src/index.ts` via `export * from "./file.js"` (note the `.js` extension on relative imports — this is an ESM package).
- Every DB row type is `snake_case`; every shared TS type is `camelCase`. Conversion happens in a `rowToX` function colocated with the repository module that owns the table, exactly like `rowToRun` in `packages/server/src/repository/runs.ts:53`.
- IDs: `uuid.v4()`. Timestamps: `new Date().toISOString()`.
- Test isolation for anything that touches `getDb()`: set `process.env.AGENT_DEALER_HOME = fs.mkdtempSync(...)` before the first dynamic `import()` of `../db/index.js` (or anything that transitively imports it), then call `migrate()` in a `before()` hook. This gives the test file its own on-disk SQLite database — there is no in-memory mock and no module mocking anywhere in this codebase's tests. Copy the exact pattern in `packages/server/src/repository/runs-external-id.test.ts:1-18`.
- The new coordinator (built in a later plan) writes **only** the new tables — no dual-write to `runs`/`events`/`artifacts`/`approval_gates`. This plan does not touch `queue/dispatcher.ts` or any existing route; it only adds new tables, types, and repositories alongside the untouched legacy ones, plus the one-time migration script.
- Migration is a standalone script (`scripts/migrate-to-issues.ts`, run via `tsx`), not part of the auto-run `migrate()` in `db/index.ts` — it is a one-time, operator-triggered cutover with a required service-stopped precondition, not a boot-time idempotent step.
- `agents` table changes are additive `ALTER TABLE` statements following the exact pattern already used in `packages/server/src/db/index.ts:37-82` (a `PRAGMA table_info` existence check before each `ALTER`), so `migrate()` stays safe to run repeatedly and on every boot.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/issues.ts` (new) | `Issue`, `IssueStatus`, `IssueOwner`, `IssueSource`, `CreateIssueInput`, status transition table |
| `packages/shared/src/worker-sessions.ts` (new) | `WorkerSession`, `WorkerSessionRole`, `WorkerSessionStatus`, `CreateWorkerSessionInput` |
| `packages/shared/src/workflow.ts` (new) | `WorkflowInstance`, `WorkflowEvent`, `WorkflowEventType` |
| `packages/shared/src/human-actions.ts` (new) | `HumanAction`, `HumanActionType`, `HumanActionStatus` |
| `packages/shared/src/findings.ts` (new) | `Finding`, `FindingStatus`, `FindingSeverity` |
| `packages/shared/src/usage-events.ts` (new) | `UsageEvent` |
| `packages/shared/src/index.ts` (modify) | Re-export the six new modules |
| `packages/server/src/db/schema.sql` (modify) | `CREATE TABLE IF NOT EXISTS` for the six new tables |
| `packages/server/src/db/index.ts` (modify) | Additive `ALTER TABLE agents` for role-neutral profile columns |
| `packages/server/src/repository/issues.ts` (new) | CRUD + status transition for `issues` |
| `packages/server/src/repository/worker-sessions.ts` (new) | CRUD + compare-and-set claim for `worker_sessions` |
| `packages/server/src/repository/workflow-events.ts` (new) | Append-only event log for `workflow_events` (+ `workflow_instances` helpers) |
| `packages/server/src/repository/human-actions.ts` (new) | Create/resolve/list for `human_actions` |
| `packages/server/src/repository/findings.ts` (new) | Create/reconcile-by-fingerprint/list for `findings` |
| `packages/server/src/repository/usage-events.ts` (new) | Record + per-issue rollup for `usage_events` |
| `scripts/migrate-to-issues.ts` (new) | One-time cutover: backup, backfill, verify, rename legacy tables |
| `scripts/migrate-to-issues.test.ts` (new) | Migration correctness tests against a fixture DB copy |

---

### Task 1: Shared types — `issues.ts`

**Files:**
- Create: `packages/shared/src/issues.ts`
- Test: `packages/shared/src/issues.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `Issue`, `IssueStatus`, `IssueOwner`, `IssueSource`, `CreateIssueInput` (Zod schemas + inferred types), `ISSUE_STATUS_TRANSITIONS: Record<IssueStatus, IssueStatus[]>`, `canTransitionIssue(from: IssueStatus, to: IssueStatus): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/issues.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransitionIssue, CreateIssueInput, Issue } from "./issues.js";

test("issue transitions: ready to developing is allowed", () => {
  assert.equal(canTransitionIssue("ready", "developing"), true);
});

test("issue transitions: done is terminal", () => {
  assert.equal(canTransitionIssue("done", "developing"), false);
  assert.equal(canTransitionIssue("done", "closed"), false);
});

test("issue transitions: cannot skip straight from ready to final_review", () => {
  assert.equal(canTransitionIssue("ready", "final_review"), false);
});

test("issue transitions: final_review can send back to repairing", () => {
  assert.equal(canTransitionIssue("final_review", "repairing"), true);
});

test("Issue schema parses a well-formed issue", () => {
  const issue: Issue = {
    id: "11111111-1111-1111-1111-111111111111",
    source: "manual",
    externalId: null,
    externalLabel: null,
    externalUrl: null,
    title: "Fix login bug",
    description: null,
    acceptanceCriteria: null,
    repo: "/repo",
    baseBranch: "main",
    status: "ready",
    currentOwner: "system",
    currentIntent: null,
    developerAgentId: "22222222-2222-2222-2222-222222222222",
    reviewerAgentId: "33333333-3333-3333-3333-333333333333",
    maxReviewRounds: 3,
    currentRound: 1,
    branch: null,
    baseSha: null,
    headSha: null,
    prNumber: null,
    prUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.deepStrictEqual(Issue.parse(issue), issue);
});

test("CreateIssueInput defaults baseBranch to main and maxReviewRounds to 3", () => {
  const parsed = CreateIssueInput.parse({
    title: "Fix login bug",
    repo: "/repo",
    developerAgentId: "22222222-2222-2222-2222-222222222222",
    reviewerAgentId: "33333333-3333-3333-3333-333333333333",
  });
  assert.equal(parsed.baseBranch, "main");
  assert.equal(parsed.maxReviewRounds, 3);
  assert.equal(parsed.source, "manual");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/shared/src/issues.test.ts`
Expected: FAIL — `Cannot find module './issues.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/issues.ts
import { z } from "zod";

export const IssueStatus = z.enum([
  "ready",
  "developing",
  "reviewing",
  "repairing",
  "final_review",
  "needs_human",
  "done",
  "closed",
]);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const IssueOwner = z.enum(["human", "developer", "reviewer", "system"]);
export type IssueOwner = z.infer<typeof IssueOwner>;

/** "agent" covers an issue a coding agent created via the API/CLI (PRD §5). */
export const IssueSource = z.enum(["manual", "linear", "agent"]);
export type IssueSource = z.infer<typeof IssueSource>;

export const Issue = z.object({
  id: z.string().uuid(),
  source: IssueSource,
  externalId: z.string().nullable(),
  externalLabel: z.string().nullable(),
  externalUrl: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  acceptanceCriteria: z.string().nullable(),
  repo: z.string(),
  baseBranch: z.string(),
  status: IssueStatus,
  currentOwner: IssueOwner,
  currentIntent: z.string().nullable(),
  developerAgentId: z.string().uuid().nullable(),
  reviewerAgentId: z.string().uuid().nullable(),
  maxReviewRounds: z.number().int().min(1),
  currentRound: z.number().int().min(1),
  branch: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const CreateIssueInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  repo: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  developerAgentId: z.string().uuid(),
  reviewerAgentId: z.string().uuid(),
  maxReviewRounds: z.number().int().min(1).default(3),
  source: IssueSource.default("manual"),
  externalId: z.string().optional(),
  externalLabel: z.string().optional(),
  externalUrl: z.string().optional(),
});
export type CreateIssueInput = z.infer<typeof CreateIssueInput>;

/**
 * Guard rails only — which status the coordinator may move an issue to next.
 * The *specific* target within an allowed set (e.g. which needs_human resolution
 * leads where) is coordinator business logic, not encoded here, mirroring how
 * VALID_TRANSITIONS works for the legacy RunStatus table today.
 */
export const ISSUE_STATUS_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  ready: ["developing", "closed"],
  developing: ["developing", "reviewing", "needs_human", "closed"],
  reviewing: ["repairing", "final_review", "needs_human", "closed"],
  repairing: ["repairing", "reviewing", "needs_human", "closed"],
  needs_human: ["developing", "repairing", "final_review", "done", "closed"],
  final_review: ["done", "repairing", "needs_human", "closed"],
  done: [],
  closed: [],
};

export function canTransitionIssue(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_STATUS_TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/shared/src/issues.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Export from the package index**

Add to `packages/shared/src/index.ts`, near the other `export *` lines (after line 13, `export * from "./playbook-reflect.js";`):

```typescript
export * from "./issues.js";
```

- [ ] **Step 6: Run the full shared package test suite**

Run: `npx tsx --test $(find packages/shared -name '*.test.ts')`
Expected: PASS, no new failures

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/issues.ts packages/shared/src/issues.test.ts packages/shared/src/index.ts
git commit -m "Add Issue shared types and status transition guard (NOT-57)"
```

---

### Task 2: Shared types — `worker-sessions.ts`

**Files:**
- Create: `packages/shared/src/worker-sessions.ts`
- Test: `packages/shared/src/worker-sessions.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: none (independent of Task 1's types at the schema level, though conceptually FK's to `Issue.id`)
- Produces: `WorkerSessionRole`, `WorkerSessionStatus`, `WorkerSession`, `CreateWorkerSessionInput`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/worker-sessions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerSession, WorkerSessionRole, WorkerSessionStatus } from "./worker-sessions.js";

test("WorkerSession schema parses a queued developer session", () => {
  const session: WorkerSession = {
    id: "44444444-4444-4444-4444-444444444444",
    issueId: "11111111-1111-1111-1111-111111111111",
    role: "developer",
    round: 1,
    agentId: "22222222-2222-2222-2222-222222222222",
    runtime: "claude_code",
    model: null,
    budgetJson: null,
    worktreePath: null,
    inputSha: null,
    status: "queued",
    sessionRef: null,
    logPath: null,
    exitCode: null,
    errorJson: null,
    metadataJson: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    heartbeatAt: null,
    completedAt: null,
    updatedAt: new Date().toISOString(),
  };
  assert.deepStrictEqual(WorkerSession.parse(session), session);
});

test("WorkerSessionRole accepts the legacy migration-only role", () => {
  assert.equal(WorkerSessionRole.parse("legacy"), "legacy");
});

test("WorkerSessionStatus rejects an invalid status", () => {
  assert.throws(() => WorkerSessionStatus.parse("bogus"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/shared/src/worker-sessions.test.ts`
Expected: FAIL — `Cannot find module './worker-sessions.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/worker-sessions.ts
import { z } from "zod";
import { Runtime } from "./runtime.js";

/** "legacy" is migration-only — the new coordinator never spawns it. */
export const WorkerSessionRole = z.enum(["developer", "reviewer", "legacy"]);
export type WorkerSessionRole = z.infer<typeof WorkerSessionRole>;

export const WorkerSessionStatus = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "timed_out",
  "cancelled",
]);
export type WorkerSessionStatus = z.infer<typeof WorkerSessionStatus>;

export const WorkerSession = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  role: WorkerSessionRole,
  round: z.number().int().min(1),
  agentId: z.string().uuid().nullable(),
  runtime: Runtime.nullable(),
  model: z.string().nullable(),
  budgetJson: z.string().nullable(),
  worktreePath: z.string().nullable(),
  /** Immutable SHA supplied to this session; required in practice for reviewer sessions. */
  inputSha: z.string().nullable(),
  status: WorkerSessionStatus,
  /** Runtime-native session id (e.g. Claude session_id) for resume/inspection. */
  sessionRef: z.string().nullable(),
  logPath: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  errorJson: z.string().nullable(),
  /** Migration/provider metadata (e.g. original legacy run id). */
  metadataJson: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type WorkerSession = z.infer<typeof WorkerSession>;

export const CreateWorkerSessionInput = z.object({
  issueId: z.string().uuid(),
  role: WorkerSessionRole,
  round: z.number().int().min(1),
  agentId: z.string().uuid().nullable(),
  runtime: Runtime.nullable(),
  model: z.string().nullable().optional(),
  budgetJson: z.string().nullable().optional(),
  inputSha: z.string().nullable().optional(),
  metadataJson: z.string().nullable().optional(),
});
export type CreateWorkerSessionInput = z.infer<typeof CreateWorkerSessionInput>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/shared/src/worker-sessions.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Export from the package index, run full suite, commit**

Add to `packages/shared/src/index.ts`:

```typescript
export * from "./worker-sessions.js";
```

```bash
npx tsx --test $(find packages/shared -name '*.test.ts')
git add packages/shared/src/worker-sessions.ts packages/shared/src/worker-sessions.test.ts packages/shared/src/index.ts
git commit -m "Add WorkerSession shared types (NOT-57)"
```

---

### Task 3: Shared types — `workflow.ts` (instances + events)

**Files:**
- Create: `packages/shared/src/workflow.ts`
- Test: `packages/shared/src/workflow.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `WorkflowInstance`, `WorkflowInstanceOutcome`, `WorkflowEventType`, `WorkflowEvent`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/workflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEvent, WorkflowEventType, WorkflowInstance } from "./workflow.js";

test("WorkflowInstance schema parses a running instance", () => {
  const instance: WorkflowInstance = {
    id: "55555555-5555-5555-5555-555555555555",
    issueId: "11111111-1111-1111-1111-111111111111",
    workflowVersion: "dev_reviewer_v1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    outcome: null,
  };
  assert.deepStrictEqual(WorkflowInstance.parse(instance), instance);
});

test("WorkflowEventType accepts every PRD §9.2 event type", () => {
  const types = [
    "issue.created",
    "workflow.started",
    "worker.started",
    "worker.completed",
    "worker.failed",
    "pull_request.opened",
    "pull_request.updated",
    "checks.completed",
    "review.submitted",
    "repair.started",
    "guidance.added",
    "human_action.requested",
    "human_action.resolved",
    "final_review.requested",
    "issue.completed",
    "issue.closed",
  ];
  for (const t of types) {
    assert.equal(WorkflowEventType.parse(t), t);
  }
});

test("WorkflowEvent allows a nullable workflow_instance_id for pre-workflow guidance", () => {
  const event: WorkflowEvent = {
    id: "66666666-6666-6666-6666-666666666666",
    issueId: "11111111-1111-1111-1111-111111111111",
    workflowInstanceId: null,
    workerSessionId: null,
    type: "guidance.added",
    actorType: "human",
    actorRef: "yusuke",
    stage: "ready",
    round: null,
    payloadJson: JSON.stringify({ markdown: "please prioritize the login bug" }),
    artifactRef: null,
    idempotencyKey: null,
    causationEventId: null,
    ts: new Date().toISOString(),
  };
  assert.deepStrictEqual(WorkflowEvent.parse(event), event);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/shared/src/workflow.test.ts`
Expected: FAIL — `Cannot find module './workflow.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/shared/src/workflow.ts
import { z } from "zod";

export const WorkflowInstanceOutcome = z.enum(["done", "closed", "migrated"]);
export type WorkflowInstanceOutcome = z.infer<typeof WorkflowInstanceOutcome>;

export const WorkflowInstance = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  workflowVersion: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  outcome: WorkflowInstanceOutcome.nullable(),
});
export type WorkflowInstance = z.infer<typeof WorkflowInstance>;

export const WorkflowEventType = z.enum([
  "issue.created",
  "workflow.started",
  "worker.started",
  "worker.completed",
  "worker.failed",
  "pull_request.opened",
  "pull_request.updated",
  "checks.completed",
  "review.submitted",
  "repair.started",
  "guidance.added",
  "human_action.requested",
  "human_action.resolved",
  "final_review.requested",
  "issue.completed",
  "issue.closed",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventType>;

export const WorkflowEvent = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  /** Nullable only for issue creation/guidance emitted before any workflow starts. */
  workflowInstanceId: z.string().uuid().nullable(),
  workerSessionId: z.string().uuid().nullable(),
  type: WorkflowEventType,
  actorType: z.enum(["human", "developer", "reviewer", "system"]),
  actorRef: z.string().nullable(),
  /** Issue status at emit time — lets the timeline render without re-deriving state. */
  stage: z.string(),
  round: z.number().int().nullable(),
  payloadJson: z.string().nullable(),
  artifactRef: z.string().nullable(),
  /** Provider-native key (e.g. GitHub delivery id) for idempotent re-ingestion. */
  idempotencyKey: z.string().nullable(),
  causationEventId: z.string().uuid().nullable(),
  ts: z.string(),
});
export type WorkflowEvent = z.infer<typeof WorkflowEvent>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/shared/src/workflow.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Export from the package index, run full suite, commit**

Add to `packages/shared/src/index.ts`:

```typescript
export * from "./workflow.js";
```

```bash
npx tsx --test $(find packages/shared -name '*.test.ts')
git add packages/shared/src/workflow.ts packages/shared/src/workflow.test.ts packages/shared/src/index.ts
git commit -m "Add WorkflowInstance and WorkflowEvent shared types (NOT-57)"
```

---

### Task 4: Shared types — `human-actions.ts`, `findings.ts`, `usage-events.ts`

**Files:**
- Create: `packages/shared/src/human-actions.ts`
- Create: `packages/shared/src/findings.ts`
- Create: `packages/shared/src/usage-events.ts`
- Test: `packages/shared/src/human-actions.test.ts`
- Test: `packages/shared/src/findings.test.ts`
- Modify: `packages/shared/src/index.ts`

These three are grouped into one task because each is a small, independent record type with no cross-dependencies — a reviewer evaluates and accepts/rejects them together as "the remaining coordinator output records."

**Interfaces:**
- Produces: `HumanActionType`, `HumanActionStatus`, `HumanAction`; `FindingStatus`, `FindingSeverity`, `Finding`; `UsageEvent`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/shared/src/human-actions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HumanAction, HumanActionType } from "./human-actions.js";

test("HumanActionType accepts exactly the PRD's four action types", () => {
  const types = ["product_scope_decision", "policy_escalation", "attempts_exhausted", "final_review"];
  for (const t of types) {
    assert.equal(HumanActionType.parse(t), t);
  }
  assert.throws(() => HumanActionType.parse("plan_approval"));
});

test("HumanAction schema parses an open final_review action", () => {
  const action: HumanAction = {
    id: "77777777-7777-7777-7777-777777777777",
    issueId: "11111111-1111-1111-1111-111111111111",
    workflowInstanceId: "55555555-5555-5555-5555-555555555555",
    actionType: "final_review",
    reason: "Reviewer approved the PR",
    question: "Accept this work?",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify(["complete", "repair", "close"]),
    continuationPreviewJson: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
  };
  assert.deepStrictEqual(HumanAction.parse(action), action);
});
```

```typescript
// packages/shared/src/findings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Finding } from "./findings.js";

test("Finding schema parses an open finding", () => {
  const finding: Finding = {
    id: "88888888-8888-8888-8888-888888888888",
    issueId: "11111111-1111-1111-1111-111111111111",
    fingerprint: "missing-null-check-auth-ts-42",
    severity: "blocking",
    title: "Missing null check",
    rationale: "user can be undefined here",
    evidenceRef: "https://github.com/org/repo/pull/1#discussion_r1",
    file: "src/auth.ts",
    line: 42,
    status: "open",
    firstRound: 1,
    lastRound: 1,
  };
  assert.deepStrictEqual(Finding.parse(finding), finding);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/shared/src/human-actions.test.ts packages/shared/src/findings.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```typescript
// packages/shared/src/human-actions.ts
import { z } from "zod";

export const HumanActionType = z.enum([
  "product_scope_decision",
  "policy_escalation",
  "attempts_exhausted",
  "final_review",
]);
export type HumanActionType = z.infer<typeof HumanActionType>;

export const HumanActionStatus = z.enum(["open", "resolved"]);
export type HumanActionStatus = z.infer<typeof HumanActionStatus>;

export const HumanAction = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  /** Nullable for pre-start product_scope_decision and imported legacy actions. */
  workflowInstanceId: z.string().uuid().nullable(),
  actionType: HumanActionType,
  reason: z.string(),
  question: z.string(),
  evidenceJson: z.string().nullable(),
  responseOptionsJson: z.string().nullable(),
  continuationPreviewJson: z.string().nullable(),
  status: HumanActionStatus,
  resolutionJson: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type HumanAction = z.infer<typeof HumanAction>;
```

```typescript
// packages/shared/src/findings.ts
import { z } from "zod";

export const FindingSeverity = z.enum(["blocking", "non_blocking"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FindingStatus = z.enum(["open", "resolved", "recurring", "superseded"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Finding = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  fingerprint: z.string(),
  severity: FindingSeverity,
  title: z.string(),
  rationale: z.string(),
  evidenceRef: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  status: FindingStatus,
  firstRound: z.number().int().min(1),
  lastRound: z.number().int().min(1),
});
export type Finding = z.infer<typeof Finding>;
```

```typescript
// packages/shared/src/usage-events.ts
import { z } from "zod";

export const UsageEvent = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  workerSessionId: z.string().uuid(),
  role: z.enum(["developer", "reviewer", "legacy"]),
  runtime: z.string().nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nullable(),
  ts: z.string(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/shared/src/human-actions.test.ts packages/shared/src/findings.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Export from the package index, run full suite, commit**

Add to `packages/shared/src/index.ts`:

```typescript
export * from "./human-actions.js";
export * from "./findings.js";
export * from "./usage-events.js";
```

```bash
npx tsx --test $(find packages/shared -name '*.test.ts')
git add packages/shared/src/human-actions.ts packages/shared/src/human-actions.test.ts \
        packages/shared/src/findings.ts packages/shared/src/findings.test.ts \
        packages/shared/src/usage-events.ts packages/shared/src/index.ts
git commit -m "Add HumanAction, Finding, UsageEvent shared types (NOT-57)"
```

---

### Task 5: Schema — new tables + role-neutral agent columns

**Files:**
- Modify: `packages/server/src/db/schema.sql`
- Modify: `packages/server/src/db/index.ts`
- Test: `packages/server/src/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-4 directly (SQL doesn't import TS), but the column names here must match every `rowToX` mapper written in Tasks 6-9.
- Produces: tables `issues`, `worker_sessions`, `workflow_instances`, `workflow_events`, `human_actions`, `findings`, `usage_events`; new columns on `agents`.

This test uses `better-sqlite3` directly against an in-memory database — it has no dependency on `@agent-dealer/shared` or the `getDb()` singleton, so it needs no `AGENT_DEALER_HOME` setup.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/db/schema.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}

const EXPECTED_TABLES = [
  "issues",
  "worker_sessions",
  "workflow_instances",
  "workflow_events",
  "human_actions",
  "findings",
  "usage_events",
];

test("schema creates every issue-centric table", () => {
  const db = freshDb();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `expected table ${t} to exist`);
  }
});

test("schema enforces at most one active workflow_instance per issue", () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO agents (id, name, runtime, is_builtin, created_at, updated_at)
    VALUES ('a1', 'A', 'claude_code', 0, '2026-01-01', '2026-01-01');
  `);
  db.prepare(
    `INSERT INTO issues (id, source, title, repo, base_branch, status, current_owner,
      max_review_rounds, current_round, created_at, updated_at)
     VALUES ('i1', 'manual', 'T', '/r', 'main', 'ready', 'system', 3, 1, '2026-01-01', '2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, outcome)
     VALUES ('w1', 'i1', 'dev_reviewer_v1', '2026-01-01', NULL)`
  ).run();
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, outcome)
         VALUES ('w2', 'i1', 'dev_reviewer_v1', '2026-01-01', NULL)`
      )
      .run()
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/db/schema.test.ts`
Expected: FAIL — new tables don't exist yet

- [ ] **Step 3: Add the tables to `schema.sql`**

Append to `packages/server/src/db/schema.sql` (after the existing `intake_settings` table, end of file):

```sql
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  external_label TEXT,
  external_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  current_owner TEXT NOT NULL,
  current_intent TEXT,
  developer_agent_id TEXT REFERENCES agents(id),
  reviewer_agent_id TEXT REFERENCES agents(id),
  max_review_rounds INTEGER NOT NULL DEFAULT 3,
  current_round INTEGER NOT NULL DEFAULT 1,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_external ON issues(source, external_id);

CREATE TABLE IF NOT EXISTS worker_sessions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  role TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  runtime TEXT,
  model TEXT,
  budget_json TEXT,
  worktree_path TEXT,
  input_sha TEXT,
  status TEXT NOT NULL,
  session_ref TEXT,
  log_path TEXT,
  exit_code INTEGER,
  error_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_sessions_issue ON worker_sessions(issue_id);
CREATE INDEX IF NOT EXISTS idx_worker_sessions_status ON worker_sessions(status);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_issue ON workflow_instances(issue_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_instances_one_active
  ON workflow_instances(issue_id) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_instance_id TEXT REFERENCES workflow_instances(id),
  worker_session_id TEXT REFERENCES worker_sessions(id),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_ref TEXT,
  stage TEXT NOT NULL,
  round INTEGER,
  payload_json TEXT,
  artifact_ref TEXT,
  idempotency_key TEXT,
  causation_event_id TEXT REFERENCES workflow_events(id),
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_issue ON workflow_events(issue_id, ts);
CREATE INDEX IF NOT EXISTS idx_workflow_events_idempotency ON workflow_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS human_actions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  workflow_instance_id TEXT REFERENCES workflow_instances(id),
  action_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT NOT NULL,
  evidence_json TEXT,
  response_options_json TEXT,
  continuation_preview_json TEXT,
  status TEXT NOT NULL,
  resolution_json TEXT,
  resolved_by TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_human_actions_issue ON human_actions(issue_id);
CREATE INDEX IF NOT EXISTS idx_human_actions_status ON human_actions(status);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_ref TEXT,
  file TEXT,
  line INTEGER,
  status TEXT NOT NULL,
  first_round INTEGER NOT NULL,
  last_round INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_issue ON findings(issue_id);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(issue_id, fingerprint);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  worker_session_id TEXT NOT NULL REFERENCES worker_sessions(id),
  role TEXT NOT NULL,
  runtime TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_issue ON usage_events(issue_id);
```

- [ ] **Step 4: Add role-neutral agent columns in `db/index.ts`**

In `packages/server/src/db/index.ts`, inside `migrate()`, after the existing agent-column checks (after the block ending at line 68, before `seedBuiltinAgents(db);` at line 76), add:

```typescript
  const agentCols4 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols4.some((c) => c.name === "default_model")) {
    db.exec("ALTER TABLE agents ADD COLUMN default_model TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN default_budget_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN purpose TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN playbook_ids_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN external_memory_refs_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN permission_policy_json TEXT");
    // Backfill role-neutral defaults from execute_* first, then plan_* — matches
    // spec §"agents (reusable profiles, not durable workers)".
    db.exec(`
      UPDATE agents SET default_model = COALESCE(default_execute_model, default_plan_model)
      WHERE default_model IS NULL
    `);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/db/schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full server test suite to confirm no regressions, then commit**

```bash
npm run build -w @agent-dealer/shared
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/db/schema.sql packages/server/src/db/index.ts packages/server/src/db/schema.test.ts
git commit -m "Add issue-centric tables and role-neutral agent columns (NOT-57)"
```

**Amendment (found during Task 10 execution, fixed in a follow-up commit):** this task as originally written omitted the additive `artifacts.issue_id`/`artifacts.worker_session_id` columns that the spec's "artifacts" data-model section calls for, and that Task 10's migration script requires to repoint legacy artifacts. The fix follows the exact same `PRAGMA table_info` idempotent-`ALTER` pattern as the other columns in this task, added to `migrate()` right after the `agentCols4` block and before `seedBuiltinAgents(db)`:

```typescript
const artifactCols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
if (!artifactCols.some((c) => c.name === "issue_id")) {
  db.exec("ALTER TABLE artifacts ADD COLUMN issue_id TEXT REFERENCES issues(id)");
  db.exec("ALTER TABLE artifacts ADD COLUMN worker_session_id TEXT REFERENCES worker_sessions(id)");
}
```

If executing this plan fresh (rather than resuming from this session's history), fold this block into Task 5 Step 4 directly instead of applying it as a separate follow-up commit.

---

### Task 6: Repository — `issues.ts`

**Files:**
- Create: `packages/server/src/repository/issues.ts`
- Test: `packages/server/src/repository/issues.test.ts`

**Interfaces:**
- Consumes: `Issue`, `CreateIssueInput`, `IssueStatus`, `canTransitionIssue` from `@agent-dealer/shared` (Task 1); `getDb` from `../db/index.js`. Test seeds a real `agents` row via `migrate()`'s built-in seeding (`BUILTIN_AGENT_CLAUDE_ID`, `BUILTIN_AGENT_CURSOR_ID` from `@agent-dealer/shared`) rather than inserting one by hand.
- Produces: `createIssue(input: CreateIssueInput): Issue`, `getIssue(id: string): Issue | null`, `listIssues(status?: IssueStatus | IssueStatus[]): Issue[]`, `findIssueByExternalId(source: string, externalId: string): Issue | null`, `transitionIssue(id: string, to: IssueStatus, patch?: TransitionIssuePatch): Issue`, `incrementIssueRound(id: string): Issue`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/repository/issues.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issues-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, listIssues, transitionIssue, incrementIssueRound } = await import("./issues.js");

before(() => {
  migrate();
});

function makeInput(title: string) {
  return {
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual" as const,
  };
}

test("creates an issue with defaults", () => {
  const issue = createIssue(makeInput("Fix login bug"));
  assert.equal(issue.status, "ready");
  assert.equal(issue.currentOwner, "system");
  assert.equal(issue.currentRound, 1);
  assert.deepStrictEqual(getIssue(issue.id), issue);
});

test("lists issues filtered by status", () => {
  const issue = createIssue(makeInput("Filterable issue"));
  assert.ok(listIssues("ready").some((i) => i.id === issue.id));
  assert.equal(listIssues("done").some((i) => i.id === issue.id), false);
});

test("transitions an issue and rejects an invalid transition", () => {
  const issue = createIssue(makeInput("Transition me"));
  const developing = transitionIssue(issue.id, "developing", { currentOwner: "developer" });
  assert.equal(developing.status, "developing");
  assert.equal(developing.currentOwner, "developer");
  assert.throws(() => transitionIssue(issue.id, "final_review"), /Invalid transition/);
});

test("increments the round counter", () => {
  const issue = createIssue(makeInput("Round me"));
  const bumped = incrementIssueRound(issue.id);
  assert.equal(bumped.currentRound, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w @agent-dealer/shared && npx tsx --test packages/server/src/repository/issues.test.ts`
Expected: FAIL — `Cannot find module './issues.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/repository/issues.ts
import {
  canTransitionIssue,
  type CreateIssueInput,
  type Issue,
  type IssueOwner,
  type IssueStatus,
} from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface IssueRow {
  id: string;
  source: string;
  external_id: string | null;
  external_label: string | null;
  external_url: string | null;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  repo: string;
  base_branch: string;
  status: string;
  current_owner: string;
  current_intent: string | null;
  developer_agent_id: string | null;
  reviewer_agent_id: string | null;
  max_review_rounds: number;
  current_round: number;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    source: row.source as Issue["source"],
    externalId: row.external_id,
    externalLabel: row.external_label,
    externalUrl: row.external_url,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    repo: row.repo,
    baseBranch: row.base_branch,
    status: row.status as IssueStatus,
    currentOwner: row.current_owner as IssueOwner,
    currentIntent: row.current_intent,
    developerAgentId: row.developer_agent_id,
    reviewerAgentId: row.reviewer_agent_id,
    maxReviewRounds: row.max_review_rounds,
    currentRound: row.current_round,
    branch: row.branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIssue(input: CreateIssueInput): Issue {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuid();
  const row: IssueRow = {
    id,
    source: input.source,
    external_id: input.externalId ?? null,
    external_label: input.externalLabel ?? null,
    external_url: input.externalUrl ?? null,
    title: input.title,
    description: input.description ?? null,
    acceptance_criteria: input.acceptanceCriteria ?? null,
    repo: input.repo,
    base_branch: input.baseBranch,
    status: "ready",
    current_owner: "system",
    current_intent: null,
    developer_agent_id: input.developerAgentId,
    reviewer_agent_id: input.reviewerAgentId,
    max_review_rounds: input.maxReviewRounds,
    current_round: 1,
    branch: null,
    base_sha: null,
    head_sha: null,
    pr_number: null,
    pr_url: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO issues (
      id, source, external_id, external_label, external_url, title, description,
      acceptance_criteria, repo, base_branch, status, current_owner, current_intent,
      developer_agent_id, reviewer_agent_id, max_review_rounds, current_round,
      branch, base_sha, head_sha, pr_number, pr_url, created_at, updated_at
    ) VALUES (
      @id, @source, @external_id, @external_label, @external_url, @title, @description,
      @acceptance_criteria, @repo, @base_branch, @status, @current_owner, @current_intent,
      @developer_agent_id, @reviewer_agent_id, @max_review_rounds, @current_round,
      @branch, @base_sha, @head_sha, @pr_number, @pr_url, @created_at, @updated_at
    )
  `).run(row);
  return rowToIssue(row);
}

export function getIssue(id: string): Issue | null {
  const row = getDb().prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export function listIssues(status?: IssueStatus | IssueStatus[]): Issue[] {
  const db = getDb();
  if (!status) {
    const rows = db.prepare("SELECT * FROM issues ORDER BY updated_at DESC").all() as IssueRow[];
    return rows.map(rowToIssue);
  }
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM issues WHERE status IN (${placeholders}) ORDER BY updated_at DESC`)
    .all(...statuses) as IssueRow[];
  return rows.map(rowToIssue);
}

export function findIssueByExternalId(source: string, externalId: string): Issue | null {
  const row = getDb()
    .prepare("SELECT * FROM issues WHERE source = ? AND external_id = ?")
    .get(source, externalId) as IssueRow | undefined;
  return row ? rowToIssue(row) : null;
}

export interface TransitionIssuePatch {
  currentOwner?: IssueOwner;
  currentIntent?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
}

export function transitionIssue(id: string, to: IssueStatus, patch?: TransitionIssuePatch): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  if (!canTransitionIssue(current.status, to)) {
    throw new Error(`Invalid transition: ${current.status} → ${to}`);
  }
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE issues SET
        status = @status,
        current_owner = @current_owner,
        current_intent = @current_intent,
        branch = @branch,
        base_sha = @base_sha,
        head_sha = @head_sha,
        pr_number = @pr_number,
        pr_url = @pr_url,
        updated_at = @updated_at
      WHERE id = @id
    `)
    .run({
      id,
      status: to,
      current_owner: patch?.currentOwner ?? current.currentOwner,
      current_intent: patch?.currentIntent !== undefined ? patch.currentIntent : current.currentIntent,
      branch: patch?.branch !== undefined ? patch.branch : current.branch,
      base_sha: patch?.baseSha !== undefined ? patch.baseSha : current.baseSha,
      head_sha: patch?.headSha !== undefined ? patch.headSha : current.headSha,
      pr_number: patch?.prNumber !== undefined ? patch.prNumber : current.prNumber,
      pr_url: patch?.prUrl !== undefined ? patch.prUrl : current.prUrl,
      updated_at: now,
    });
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}

export function incrementIssueRound(id: string): Issue {
  const current = getIssue(id);
  if (!current) throw new Error(`Issue not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE issues SET current_round = current_round + 1, updated_at = ? WHERE id = ?")
    .run(now, id);
  const updated = getIssue(id);
  if (!updated) throw new Error(`Issue vanished: ${id}`);
  return updated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/repository/issues.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/repository/issues.ts packages/server/src/repository/issues.test.ts
git commit -m "Add issues repository (NOT-57)"
```

---

### Task 7: Repository — `worker-sessions.ts`

**Files:**
- Create: `packages/server/src/repository/worker-sessions.ts`
- Test: `packages/server/src/repository/worker-sessions.test.ts`

**Interfaces:**
- Consumes: `WorkerSession`, `CreateWorkerSessionInput`, `WorkerSessionStatus` from `@agent-dealer/shared` (Task 2); `createIssue` from `./issues.js` (Task 6) to seed a real issue for the FK, instead of raw SQL.
- Produces: `createWorkerSession(input: CreateWorkerSessionInput): WorkerSession`, `getWorkerSession(id: string): WorkerSession | null`, `listWorkerSessionsForIssue(issueId: string): WorkerSession[]`, `claimQueuedSession(id: string): WorkerSession | null` (compare-and-set `queued` → `running`; returns `null` if already claimed), `heartbeatSession(id: string): void`, `completeSession(id: string, patch: CompleteSessionPatch): WorkerSession`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/repository/worker-sessions.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sessions-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createWorkerSession, getWorkerSession, listWorkerSessionsForIssue, claimQueuedSession, completeSession } =
  await import("./worker-sessions.js");

let issueId: string;

before(() => {
  migrate();
  issueId = createIssue({
    title: "Session host issue",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  }).id;
});

test("creates a queued session", () => {
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  assert.equal(session.status, "queued");
  assert.deepStrictEqual(getWorkerSession(session.id), session);
});

test("lists sessions for an issue in creation order", () => {
  const s1 = createWorkerSession({ issueId, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const s2 = createWorkerSession({ issueId, role: "reviewer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const ids = listWorkerSessionsForIssue(issueId).map((s) => s.id);
  assert.ok(ids.indexOf(s1.id) < ids.indexOf(s2.id));
});

test("claims a queued session exactly once (compare-and-set)", () => {
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  const claimed = claimQueuedSession(session.id);
  assert.equal(claimed?.status, "running");
  assert.notEqual(claimed?.startedAt, null);
  const secondClaim = claimQueuedSession(session.id);
  assert.equal(secondClaim, null);
});

test("completes a session", () => {
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  claimQueuedSession(session.id);
  const done = completeSession(session.id, { status: "done", exitCode: 0 });
  assert.equal(done.status, "done");
  assert.equal(done.exitCode, 0);
  assert.notEqual(done.completedAt, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/repository/worker-sessions.test.ts`
Expected: FAIL — `Cannot find module './worker-sessions.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/repository/worker-sessions.ts
import type { CreateWorkerSessionInput, WorkerSession, WorkerSessionRole, WorkerSessionStatus } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface WorkerSessionRow {
  id: string;
  issue_id: string;
  role: string;
  round: number;
  agent_id: string | null;
  runtime: string | null;
  model: string | null;
  budget_json: string | null;
  worktree_path: string | null;
  input_sha: string | null;
  status: string;
  session_ref: string | null;
  log_path: string | null;
  exit_code: number | null;
  error_json: string | null;
  metadata_json: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function rowToSession(row: WorkerSessionRow): WorkerSession {
  return {
    id: row.id,
    issueId: row.issue_id,
    role: row.role as WorkerSessionRole,
    round: row.round,
    agentId: row.agent_id,
    runtime: row.runtime as WorkerSession["runtime"],
    model: row.model,
    budgetJson: row.budget_json,
    worktreePath: row.worktree_path,
    inputSha: row.input_sha,
    status: row.status as WorkerSessionStatus,
    sessionRef: row.session_ref,
    logPath: row.log_path,
    exitCode: row.exit_code,
    errorJson: row.error_json,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkerSession(input: CreateWorkerSessionInput): WorkerSession {
  const db = getDb();
  const now = new Date().toISOString();
  const row: WorkerSessionRow = {
    id: uuid(),
    issue_id: input.issueId,
    role: input.role,
    round: input.round,
    agent_id: input.agentId,
    runtime: input.runtime,
    model: input.model ?? null,
    budget_json: input.budgetJson ?? null,
    worktree_path: null,
    input_sha: input.inputSha ?? null,
    status: "queued",
    session_ref: null,
    log_path: null,
    exit_code: null,
    error_json: null,
    metadata_json: input.metadataJson ?? null,
    created_at: now,
    started_at: null,
    heartbeat_at: null,
    completed_at: null,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO worker_sessions (
      id, issue_id, role, round, agent_id, runtime, model, budget_json, worktree_path,
      input_sha, status, session_ref, log_path, exit_code, error_json, metadata_json,
      created_at, started_at, heartbeat_at, completed_at, updated_at
    ) VALUES (
      @id, @issue_id, @role, @round, @agent_id, @runtime, @model, @budget_json, @worktree_path,
      @input_sha, @status, @session_ref, @log_path, @exit_code, @error_json, @metadata_json,
      @created_at, @started_at, @heartbeat_at, @completed_at, @updated_at
    )
  `).run(row);
  return rowToSession(row);
}

export function getWorkerSession(id: string): WorkerSession | null {
  const row = getDb().prepare("SELECT * FROM worker_sessions WHERE id = ?").get(id) as
    | WorkerSessionRow
    | undefined;
  return row ? rowToSession(row) : null;
}

export function listWorkerSessionsForIssue(issueId: string): WorkerSession[] {
  const rows = getDb()
    .prepare("SELECT * FROM worker_sessions WHERE issue_id = ? ORDER BY created_at ASC")
    .all(issueId) as WorkerSessionRow[];
  return rows.map(rowToSession);
}

/** Compare-and-set queued → running. Returns null if another dispatcher already claimed it. */
export function claimQueuedSession(id: string): WorkerSession | null {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE worker_sessions SET status = 'running', started_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .run(now, now, now, id);
  if (result.changes === 0) return null;
  return getWorkerSession(id);
}

export function heartbeatSession(id: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE worker_sessions SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .run(now, now, id);
}

export interface CompleteSessionPatch {
  status: Extract<WorkerSessionStatus, "done" | "failed" | "timed_out" | "cancelled">;
  exitCode?: number | null;
  errorJson?: string | null;
  sessionRef?: string | null;
  logPath?: string | null;
  worktreePath?: string | null;
}

export function completeSession(id: string, patch: CompleteSessionPatch): WorkerSession {
  const current = getWorkerSession(id);
  if (!current) throw new Error(`Worker session not found: ${id}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE worker_sessions SET
        status = @status,
        exit_code = @exit_code,
        error_json = @error_json,
        session_ref = @session_ref,
        log_path = @log_path,
        worktree_path = @worktree_path,
        completed_at = @completed_at,
        updated_at = @updated_at
      WHERE id = @id
    `)
    .run({
      id,
      status: patch.status,
      exit_code: patch.exitCode !== undefined ? patch.exitCode : current.exitCode,
      error_json: patch.errorJson !== undefined ? patch.errorJson : current.errorJson,
      session_ref: patch.sessionRef !== undefined ? patch.sessionRef : current.sessionRef,
      log_path: patch.logPath !== undefined ? patch.logPath : current.logPath,
      worktree_path: patch.worktreePath !== undefined ? patch.worktreePath : current.worktreePath,
      completed_at: now,
      updated_at: now,
    });
  const updated = getWorkerSession(id);
  if (!updated) throw new Error(`Worker session vanished: ${id}`);
  return updated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/repository/worker-sessions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/repository/worker-sessions.ts packages/server/src/repository/worker-sessions.test.ts
git commit -m "Add worker-sessions repository with compare-and-set claim (NOT-57)"
```

---

### Task 8: Repository — `workflow-events.ts` + `human-actions.ts`

**Files:**
- Create: `packages/server/src/repository/workflow-events.ts`
- Create: `packages/server/src/repository/human-actions.ts`
- Test: `packages/server/src/repository/workflow-events.test.ts`
- Test: `packages/server/src/repository/human-actions.test.ts`

**Interfaces:**
- Consumes: `WorkflowEvent`, `WorkflowEventType`, `WorkflowInstance`, `HumanAction`, `HumanActionType` from `@agent-dealer/shared`; `createIssue` from `./issues.js` (Task 6) for test setup.
- Produces:
  - `startWorkflowInstance(issueId: string, workflowVersion: string): WorkflowInstance`
  - `completeWorkflowInstance(id: string, outcome: WorkflowInstanceOutcome): WorkflowInstance`
  - `appendWorkflowEvent(input: AppendWorkflowEventInput): WorkflowEvent`
  - `listWorkflowEventsForIssue(issueId: string): WorkflowEvent[]`
  - `createHumanAction(input: CreateHumanActionInput): HumanAction`
  - `resolveHumanAction(id: string, resolvedBy: string, resolution: unknown): HumanAction`
  - `listOpenHumanActions(): HumanAction[]`
  - `listHumanActionsForIssue(issueId: string): HumanAction[]`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/server/src/repository/workflow-events.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-events-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { startWorkflowInstance, completeWorkflowInstance, appendWorkflowEvent, listWorkflowEventsForIssue } =
  await import("./workflow-events.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  }).id;
}

test("starts and completes a workflow instance, enforcing at most one active", () => {
  const issueId = seedIssue("Instance issue");
  const instance = startWorkflowInstance(issueId, "dev_reviewer_v1");
  assert.equal(instance.completedAt, null);
  assert.throws(() => startWorkflowInstance(issueId, "dev_reviewer_v1"));
  const done = completeWorkflowInstance(instance.id, "done");
  assert.equal(done.outcome, "done");
  assert.notEqual(done.completedAt, null);
  assert.doesNotThrow(() => startWorkflowInstance(issueId, "dev_reviewer_v1"));
});

test("appends and lists events in timestamp order", () => {
  const issueId = seedIssue("Event issue");
  const instance = startWorkflowInstance(issueId, "dev_reviewer_v1");
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    type: "issue.created",
    actorType: "system",
    stage: "ready",
    payload: { note: "created" },
  });
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    type: "workflow.started",
    actorType: "system",
    stage: "developing",
  });
  const events = listWorkflowEventsForIssue(issueId);
  assert.deepStrictEqual(events.map((e) => e.type), ["issue.created", "workflow.started"]);
  assert.deepStrictEqual(JSON.parse(events[0].payloadJson!), { note: "created" });
});
```

```typescript
// packages/server/src/repository/human-actions.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-actions-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createHumanAction, resolveHumanAction, listOpenHumanActions, listHumanActionsForIssue } =
  await import("./human-actions.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  }).id;
}

test("creates an open action and lists it globally and per-issue", () => {
  const issueId = seedIssue("Action issue 1");
  const action = createHumanAction({
    issueId,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  assert.equal(action.status, "open");
  assert.ok(listOpenHumanActions().some((a) => a.id === action.id));
  assert.deepStrictEqual(listHumanActionsForIssue(issueId).map((a) => a.id), [action.id]);
});

test("resolves an action and removes it from the open queue", () => {
  const issueId = seedIssue("Action issue 2");
  const action = createHumanAction({
    issueId,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  const resolved = resolveHumanAction(action.id, "yusuke", { choice: "complete" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "yusuke");
  assert.equal(
    listOpenHumanActions().some((a) => a.id === action.id),
    false
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/server/src/repository/workflow-events.test.ts packages/server/src/repository/human-actions.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```typescript
// packages/server/src/repository/workflow-events.ts
import type { WorkflowEvent, WorkflowEventType, WorkflowInstance, WorkflowInstanceOutcome } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface WorkflowInstanceRow {
  id: string;
  issue_id: string;
  workflow_version: string;
  started_at: string;
  completed_at: string | null;
  outcome: string | null;
}

function rowToInstance(row: WorkflowInstanceRow): WorkflowInstance {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowVersion: row.workflow_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome as WorkflowInstanceOutcome | null,
  };
}

/** Throws (via the unique partial index) if an active instance already exists for this issue. */
export function startWorkflowInstance(issueId: string, workflowVersion: string): WorkflowInstance {
  const db = getDb();
  const now = new Date().toISOString();
  const row: WorkflowInstanceRow = {
    id: uuid(),
    issue_id: issueId,
    workflow_version: workflowVersion,
    started_at: now,
    completed_at: null,
    outcome: null,
  };
  db.prepare(`
    INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, completed_at, outcome)
    VALUES (@id, @issue_id, @workflow_version, @started_at, @completed_at, @outcome)
  `).run(row);
  return rowToInstance(row);
}

export function completeWorkflowInstance(id: string, outcome: WorkflowInstanceOutcome): WorkflowInstance {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE workflow_instances SET completed_at = ?, outcome = ? WHERE id = ?")
    .run(now, outcome, id);
  const row = getDb().prepare("SELECT * FROM workflow_instances WHERE id = ?").get(id) as
    | WorkflowInstanceRow
    | undefined;
  if (!row) throw new Error(`Workflow instance vanished: ${id}`);
  return rowToInstance(row);
}

interface WorkflowEventRow {
  id: string;
  issue_id: string;
  workflow_instance_id: string | null;
  worker_session_id: string | null;
  type: string;
  actor_type: string;
  actor_ref: string | null;
  stage: string;
  round: number | null;
  payload_json: string | null;
  artifact_ref: string | null;
  idempotency_key: string | null;
  causation_event_id: string | null;
  ts: string;
}

function rowToEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowInstanceId: row.workflow_instance_id,
    workerSessionId: row.worker_session_id,
    type: row.type as WorkflowEventType,
    actorType: row.actor_type as WorkflowEvent["actorType"],
    actorRef: row.actor_ref,
    stage: row.stage,
    round: row.round,
    payloadJson: row.payload_json,
    artifactRef: row.artifact_ref,
    idempotencyKey: row.idempotency_key,
    causationEventId: row.causation_event_id,
    ts: row.ts,
  };
}

export interface AppendWorkflowEventInput {
  issueId: string;
  workflowInstanceId?: string | null;
  workerSessionId?: string | null;
  type: WorkflowEventType;
  actorType: WorkflowEvent["actorType"];
  actorRef?: string | null;
  stage: string;
  round?: number | null;
  payload?: unknown;
  artifactRef?: string | null;
  idempotencyKey?: string | null;
  causationEventId?: string | null;
}

export function appendWorkflowEvent(input: AppendWorkflowEventInput): WorkflowEvent {
  const db = getDb();
  const row: WorkflowEventRow = {
    id: uuid(),
    issue_id: input.issueId,
    workflow_instance_id: input.workflowInstanceId ?? null,
    worker_session_id: input.workerSessionId ?? null,
    type: input.type,
    actor_type: input.actorType,
    actor_ref: input.actorRef ?? null,
    stage: input.stage,
    round: input.round ?? null,
    payload_json: input.payload !== undefined ? JSON.stringify(input.payload) : null,
    artifact_ref: input.artifactRef ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    causation_event_id: input.causationEventId ?? null,
    ts: new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO workflow_events (
      id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref,
      stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts
    ) VALUES (
      @id, @issue_id, @workflow_instance_id, @worker_session_id, @type, @actor_type, @actor_ref,
      @stage, @round, @payload_json, @artifact_ref, @idempotency_key, @causation_event_id, @ts
    )
  `).run(row);
  return rowToEvent(row);
}

export function listWorkflowEventsForIssue(issueId: string): WorkflowEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_events WHERE issue_id = ? ORDER BY ts ASC")
    .all(issueId) as WorkflowEventRow[];
  return rows.map(rowToEvent);
}
```

```typescript
// packages/server/src/repository/human-actions.ts
import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface HumanActionRow {
  id: string;
  issue_id: string;
  workflow_instance_id: string | null;
  action_type: string;
  reason: string;
  question: string;
  evidence_json: string | null;
  response_options_json: string | null;
  continuation_preview_json: string | null;
  status: string;
  resolution_json: string | null;
  resolved_by: string | null;
  requested_at: string;
  resolved_at: string | null;
}

function rowToAction(row: HumanActionRow): HumanAction {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowInstanceId: row.workflow_instance_id,
    actionType: row.action_type as HumanActionType,
    reason: row.reason,
    question: row.question,
    evidenceJson: row.evidence_json,
    responseOptionsJson: row.response_options_json,
    continuationPreviewJson: row.continuation_preview_json,
    status: row.status as HumanAction["status"],
    resolutionJson: row.resolution_json,
    resolvedBy: row.resolved_by,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}

export interface CreateHumanActionInput {
  issueId: string;
  workflowInstanceId?: string | null;
  actionType: HumanActionType;
  reason: string;
  question: string;
  evidence?: unknown;
  responseOptions?: unknown;
  continuationPreview?: unknown;
}

export function createHumanAction(input: CreateHumanActionInput): HumanAction {
  const db = getDb();
  const now = new Date().toISOString();
  const row: HumanActionRow = {
    id: uuid(),
    issue_id: input.issueId,
    workflow_instance_id: input.workflowInstanceId ?? null,
    action_type: input.actionType,
    reason: input.reason,
    question: input.question,
    evidence_json: input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
    response_options_json:
      input.responseOptions !== undefined ? JSON.stringify(input.responseOptions) : null,
    continuation_preview_json:
      input.continuationPreview !== undefined ? JSON.stringify(input.continuationPreview) : null,
    status: "open",
    resolution_json: null,
    resolved_by: null,
    requested_at: now,
    resolved_at: null,
  };
  db.prepare(`
    INSERT INTO human_actions (
      id, issue_id, workflow_instance_id, action_type, reason, question, evidence_json,
      response_options_json, continuation_preview_json, status, resolution_json, resolved_by,
      requested_at, resolved_at
    ) VALUES (
      @id, @issue_id, @workflow_instance_id, @action_type, @reason, @question, @evidence_json,
      @response_options_json, @continuation_preview_json, @status, @resolution_json, @resolved_by,
      @requested_at, @resolved_at
    )
  `).run(row);
  return rowToAction(row);
}

export function resolveHumanAction(id: string, resolvedBy: string, resolution: unknown): HumanAction {
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE human_actions SET
        status = 'resolved', resolution_json = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'open'
    `)
    .run(JSON.stringify(resolution), resolvedBy, now, id);
  const row = getDb().prepare("SELECT * FROM human_actions WHERE id = ?").get(id) as
    | HumanActionRow
    | undefined;
  if (!row) throw new Error(`Human action not found: ${id}`);
  if (row.status !== "resolved") throw new Error(`Human action already resolved or missing: ${id}`);
  return rowToAction(row);
}

export function listOpenHumanActions(): HumanAction[] {
  const rows = getDb()
    .prepare("SELECT * FROM human_actions WHERE status = 'open' ORDER BY requested_at ASC")
    .all() as HumanActionRow[];
  return rows.map(rowToAction);
}

export function listHumanActionsForIssue(issueId: string): HumanAction[] {
  const rows = getDb()
    .prepare("SELECT * FROM human_actions WHERE issue_id = ? ORDER BY requested_at ASC")
    .all(issueId) as HumanActionRow[];
  return rows.map(rowToAction);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/server/src/repository/workflow-events.test.ts packages/server/src/repository/human-actions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/repository/workflow-events.ts packages/server/src/repository/workflow-events.test.ts \
        packages/server/src/repository/human-actions.ts packages/server/src/repository/human-actions.test.ts
git commit -m "Add workflow-events and human-actions repositories (NOT-57)"
```

---

### Task 9: Repository — `findings.ts` + `usage-events.ts`

**Files:**
- Create: `packages/server/src/repository/findings.ts`
- Create: `packages/server/src/repository/usage-events.ts`
- Test: `packages/server/src/repository/findings.test.ts`
- Test: `packages/server/src/repository/usage-events.test.ts`

**Interfaces:**
- Consumes: `Finding`, `FindingSeverity`, `UsageEvent` from `@agent-dealer/shared`; `createIssue` (Task 6) and `createWorkerSession` (Task 7) for test setup.
- Produces:
  - `reconcileFinding(input: ReconcileFindingInput): Finding` — inserts a new finding, or if one with the same `(issue_id, fingerprint)` is `open`/`recurring`, updates it to `recurring` and bumps `last_round`
  - `resolveFinding(id: string): Finding`
  - `listFindingsForIssue(issueId: string): Finding[]`
  - `recordUsageEvent(input: RecordUsageEventInput): UsageEvent`
  - `summarizeIssueUsage(issueId: string): IssueUsageSummary`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/server/src/repository/findings.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-findings-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { reconcileFinding, resolveFinding, listFindingsForIssue } = await import("./findings.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  }).id;
}

test("creates a new finding as open", () => {
  const issueId = seedIssue("Finding issue 1");
  const finding = reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "blocking",
    title: "Missing null check",
    rationale: "user can be undefined",
    round: 1,
  });
  assert.equal(finding.status, "open");
  assert.equal(finding.firstRound, 1);
  assert.equal(finding.lastRound, 1);
});

test("marks a repeated fingerprint as recurring and bumps last_round", () => {
  const issueId = seedIssue("Finding issue 2");
  reconcileFinding({ issueId, fingerprint: "fp-1", severity: "blocking", title: "T", rationale: "R", round: 1 });
  const again = reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "blocking",
    title: "T",
    rationale: "R",
    round: 2,
  });
  assert.equal(again.status, "recurring");
  assert.equal(again.firstRound, 1);
  assert.equal(again.lastRound, 2);
});

test("resolves a finding", () => {
  const issueId = seedIssue("Finding issue 3");
  const finding = reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "blocking",
    title: "T",
    rationale: "R",
    round: 1,
  });
  const resolved = resolveFinding(finding.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(listFindingsForIssue(issueId).find((f) => f.id === finding.id)?.status, "resolved");
});
```

```typescript
// packages/server/src/repository/usage-events.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-usage-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createWorkerSession } = await import("./worker-sessions.js");
const { recordUsageEvent, summarizeIssueUsage } = await import("./usage-events.js");

before(() => {
  migrate();
});

test("records events and sums them per issue", () => {
  const issue = createIssue({
    title: "Usage issue",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    source: "manual",
  });
  const session = createWorkerSession({
    issueId: issue.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  recordUsageEvent({
    issueId: issue.id,
    workerSessionId: session.id,
    role: "developer",
    costUsd: 1.5,
    durationMs: 1000,
    tokensIn: 100,
    tokensOut: 50,
  });
  recordUsageEvent({
    issueId: issue.id,
    workerSessionId: session.id,
    role: "developer",
    costUsd: 2.25,
    durationMs: 2000,
    tokensIn: 200,
    tokensOut: 75,
  });
  const summary = summarizeIssueUsage(issue.id);
  assert.ok(Math.abs(summary.totalCostUsd - 3.75) < 0.001);
  assert.equal(summary.totalDurationMs, 3000);
  assert.equal(summary.totalTokensIn, 300);
  assert.equal(summary.totalTokensOut, 125);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/server/src/repository/findings.test.ts packages/server/src/repository/usage-events.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```typescript
// packages/server/src/repository/findings.ts
import type { Finding, FindingSeverity } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface FindingRow {
  id: string;
  issue_id: string;
  fingerprint: string;
  severity: string;
  title: string;
  rationale: string;
  evidence_ref: string | null;
  file: string | null;
  line: number | null;
  status: string;
  first_round: number;
  last_round: number;
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    issueId: row.issue_id,
    fingerprint: row.fingerprint,
    severity: row.severity as FindingSeverity,
    title: row.title,
    rationale: row.rationale,
    evidenceRef: row.evidence_ref,
    file: row.file,
    line: row.line,
    status: row.status as Finding["status"],
    firstRound: row.first_round,
    lastRound: row.last_round,
  };
}

export interface ReconcileFindingInput {
  issueId: string;
  fingerprint: string;
  severity: FindingSeverity;
  title: string;
  rationale: string;
  evidenceRef?: string | null;
  file?: string | null;
  line?: number | null;
  round: number;
}

/**
 * Inserts a new finding, or — if one with the same (issue, fingerprint) is
 * open/recurring — marks it recurring and bumps last_round (PRD §6.4).
 */
export function reconcileFinding(input: ReconcileFindingInput): Finding {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM findings WHERE issue_id = ? AND fingerprint = ? AND status IN ('open', 'recurring')`
    )
    .get(input.issueId, input.fingerprint) as FindingRow | undefined;

  if (existing) {
    db.prepare("UPDATE findings SET status = 'recurring', last_round = ? WHERE id = ?").run(
      input.round,
      existing.id
    );
    const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(existing.id) as FindingRow;
    return rowToFinding(row);
  }

  const row: FindingRow = {
    id: uuid(),
    issue_id: input.issueId,
    fingerprint: input.fingerprint,
    severity: input.severity,
    title: input.title,
    rationale: input.rationale,
    evidence_ref: input.evidenceRef ?? null,
    file: input.file ?? null,
    line: input.line ?? null,
    status: "open",
    first_round: input.round,
    last_round: input.round,
  };
  db.prepare(`
    INSERT INTO findings (
      id, issue_id, fingerprint, severity, title, rationale, evidence_ref, file, line,
      status, first_round, last_round
    ) VALUES (
      @id, @issue_id, @fingerprint, @severity, @title, @rationale, @evidence_ref, @file, @line,
      @status, @first_round, @last_round
    )
  `).run(row);
  return rowToFinding(row);
}

export function resolveFinding(id: string): Finding {
  getDb().prepare("UPDATE findings SET status = 'resolved' WHERE id = ?").run(id);
  const row = getDb().prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
  if (!row) throw new Error(`Finding not found: ${id}`);
  return rowToFinding(row);
}

export function listFindingsForIssue(issueId: string): Finding[] {
  const rows = getDb()
    .prepare("SELECT * FROM findings WHERE issue_id = ? ORDER BY first_round ASC")
    .all(issueId) as FindingRow[];
  return rows.map(rowToFinding);
}
```

```typescript
// packages/server/src/repository/usage-events.ts
import type { UsageEvent } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface UsageEventRow {
  id: string;
  issue_id: string;
  worker_session_id: string;
  role: string;
  runtime: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  ts: string;
}

function rowToUsageEvent(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    workerSessionId: row.worker_session_id,
    role: row.role as UsageEvent["role"],
    runtime: row.runtime,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    ts: row.ts,
  };
}

export interface RecordUsageEventInput {
  issueId: string;
  workerSessionId: string;
  role: UsageEvent["role"];
  runtime?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

export function recordUsageEvent(input: RecordUsageEventInput): UsageEvent {
  const row: UsageEventRow = {
    id: uuid(),
    issue_id: input.issueId,
    worker_session_id: input.workerSessionId,
    role: input.role,
    runtime: input.runtime ?? null,
    tokens_in: input.tokensIn ?? null,
    tokens_out: input.tokensOut ?? null,
    cost_usd: input.costUsd ?? null,
    duration_ms: input.durationMs ?? null,
    ts: new Date().toISOString(),
  };
  getDb().prepare(`
    INSERT INTO usage_events (
      id, issue_id, worker_session_id, role, runtime, tokens_in, tokens_out, cost_usd, duration_ms, ts
    ) VALUES (
      @id, @issue_id, @worker_session_id, @role, @runtime, @tokens_in, @tokens_out, @cost_usd, @duration_ms, @ts
    )
  `).run(row);
  return rowToUsageEvent(row);
}

export interface IssueUsageSummary {
  totalCostUsd: number;
  totalDurationMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export function summarizeIssueUsage(issueId: string): IssueUsageSummary {
  const row = getDb()
    .prepare(
      `SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(duration_ms), 0) as total_duration,
        COALESCE(SUM(tokens_in), 0) as total_in,
        COALESCE(SUM(tokens_out), 0) as total_out
       FROM usage_events WHERE issue_id = ?`
    )
    .get(issueId) as { total_cost: number; total_duration: number; total_in: number; total_out: number };
  return {
    totalCostUsd: row.total_cost,
    totalDurationMs: row.total_duration,
    totalTokensIn: row.total_in,
    totalTokensOut: row.total_out,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/server/src/repository/findings.test.ts packages/server/src/repository/usage-events.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/repository/findings.ts packages/server/src/repository/findings.test.ts \
        packages/server/src/repository/usage-events.ts packages/server/src/repository/usage-events.test.ts
git commit -m "Add findings and usage-events repositories (NOT-57)"
```

---

### Task 10: Migration script — `scripts/migrate-to-issues.ts`

**Files:**
- Create: `scripts/migrate-to-issues.ts`
- Create: `scripts/migrate-to-issues.test.ts`

**Interfaces:**
- Consumes: raw `better-sqlite3` access to a file-backed DB (not the `getDb()` singleton — this is a standalone operator script, matching the pattern in `scripts/p0-linear-batch.ts`); `packages/server/src/db/schema.sql` for the target schema.
- Produces: `runMigration(dbPath: string, opts?: { skipServiceCheck?: boolean }): MigrationReport`, where `MigrationReport = { issuesCreated: number; legacySessionsCreated: number; artifactsRepointed: number; eventsRepointed: number; mismatches: string[] }`. `mismatches.length > 0` means the migration rolled back and made no changes. The CLI entrypoint (`main()`) calls `runMigration` and exits non-zero on any mismatch.

This task implements exactly the six steps in the spec's "Migration and cutover" section. Read that section again before starting. This test file creates a fresh temp SQLite file per test case (not a shared fixture), since each test needs to start from an independent legacy DB state.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/migrate-to-issues.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigration } from "./migrate-to-issues.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacySchemaPath = path.join(__dirname, "..", "packages", "server", "src", "db", "schema.sql");

function seedLegacyDb(): string {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-migration-")), "dealer.db");
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(legacySchemaPath, "utf8"));
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO agents (id, name, runtime, is_builtin, created_at, updated_at)
     VALUES ('agent-1', 'Claude', 'claude_code', 0, ?, ?)`
  ).run(now, now);

  // Lineage A: one completed run — should migrate to an issue with status 'done'.
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-a1', 'manual', 'run-a1', 'code', 'Done task', '/repo', 'agent-1', 'done',
      NULL, ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO artifacts (id, run_id, kind, content_json, author, created_at)
     VALUES ('art-a1', 'run-a1', 'execution_result', '{"exitCode":0}', 'agent', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO events (id, run_id, type, payload_json, ts) VALUES ('evt-a1', 'run-a1', 'run.created', NULL, ?)`
  ).run(now);

  // Lineage B: two runs sharing a lineage_id, latest is plan_pending — should migrate to
  // one issue with status 'ready' and no active workflow, legacy session status 'cancelled'.
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-b1', 'manual', 'run-b1', 'code', 'Retried task', '/repo', 'agent-1', 'failed',
      NULL, ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-b2', 'manual', 'run-b2', 'code', 'Retried task', '/repo', 'agent-1', 'plan_pending',
      'run-b1', ?, ?)`
  ).run(now, now);

  db.close();
  return dbPath;
}

test("creates one issue per lineage, preserves artifacts/events, and renames legacy tables", () => {
  const dbPath = seedLegacyDb();
  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);
  assert.equal(report.issuesCreated, 2);
  assert.equal(report.legacySessionsCreated, 3); // run-a1, run-b1, run-b2
  assert.equal(report.artifactsRepointed, 1);
  assert.equal(report.eventsRepointed, 1);

  const db = new Database(dbPath, { readonly: true });
  const issues = db.prepare("SELECT status FROM issues").all() as Array<{ status: string }>;
  const statuses = issues.map((i) => i.status).sort();
  assert.deepStrictEqual(statuses, ["done", "ready"]);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const names = tables.map((t) => t.name);
  assert.ok(names.includes("legacy_v0_runs"));
  assert.equal(names.includes("runs"), false);

  const legacySessions = db.prepare("SELECT status FROM worker_sessions WHERE role = 'legacy'").all() as Array<{
    status: string;
  }>;
  assert.ok(legacySessions.some((s) => s.status === "done"));
  assert.ok(legacySessions.some((s) => s.status === "cancelled"));
  db.close();
});

test("rolls back and leaves the original tables untouched when a lineage_id points nowhere", () => {
  const dbPath = seedLegacyDb();
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-orphan', 'manual', 'run-orphan', 'code', 'Orphan', '/repo', 'agent-1', 'done',
      'does-not-exist', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.close();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.ok(report.mismatches.length > 0);

  const after = new Database(dbPath, { readonly: true });
  const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  assert.ok(tables.map((t) => t.name).includes("runs")); // untouched — rollback happened
  after.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test scripts/migrate-to-issues.test.ts`
Expected: FAIL — `Cannot find module './migrate-to-issues.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// scripts/migrate-to-issues.ts
#!/usr/bin/env tsx
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface MigrationReport {
  issuesCreated: number;
  legacySessionsCreated: number;
  artifactsRepointed: number;
  eventsRepointed: number;
  mismatches: string[];
}

interface LegacyRunRow {
  id: string;
  source: string;
  external_id: string | null;
  external_label: string | null;
  title: string;
  description: string | null;
  repo: string | null;
  agent_id: string | null;
  status: string;
  lineage_id: string | null;
  acceptance_criteria: string | null;
  created_at: string;
  updated_at: string;
}

/** Groups every run by COALESCE(lineage_id, id) — one bucket per historical lineage. */
function groupByLineage(runs: LegacyRunRow[]): Map<string, LegacyRunRow[]> {
  const groups = new Map<string, LegacyRunRow[]>();
  for (const run of runs) {
    const key = run.lineage_id ?? run.id;
    const bucket = groups.get(key) ?? [];
    bucket.push(run);
    groups.set(key, bucket);
  }
  return groups;
}

function latestRun(runs: LegacyRunRow[]): LegacyRunRow {
  return [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at))[runs.length - 1];
}

/** Legacy worker_session.status follows the same bucket as the issue-status mapping below. */
function legacySessionStatus(runStatus: string): "done" | "failed" | "cancelled" {
  if (runStatus === "done" || runStatus === "review") return "done";
  if (runStatus === "failed") return "failed";
  return "cancelled"; // cancelled, queued, plan_pending, plan_approved, running
}

function issueStatusForLatest(runStatus: string): {
  status: string;
  owner: string;
  humanAction?: { actionType: string; reason: string; question: string };
} {
  switch (runStatus) {
    case "done":
      return { status: "done", owner: "system" };
    case "cancelled":
      return { status: "closed", owner: "system" };
    case "review":
      return {
        status: "final_review",
        owner: "human",
        humanAction: {
          actionType: "final_review",
          reason: "Migrated from a legacy run awaiting result review",
          question: "Accept this legacy work?",
        },
      };
    case "failed":
      return {
        status: "needs_human",
        owner: "human",
        humanAction: {
          actionType: "attempts_exhausted",
          reason: "Migrated from a legacy failed run",
          question: "This legacy run failed — how should it be resolved?",
        },
      };
    default:
      // queued, plan_pending, plan_approved, running
      return { status: "ready", owner: "system" };
  }
}

export function runMigration(dbPath: string, opts?: { skipServiceCheck?: boolean }): MigrationReport {
  if (!opts?.skipServiceCheck) {
    // Production entrypoint refuses to run against a live server — see main() below,
    // which checks the process registry lock file before calling this function.
  }

  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  fs.copyFileSync(dbPath, backupPath);

  const db = new Database(dbPath);
  const report: MigrationReport = {
    issuesCreated: 0,
    legacySessionsCreated: 0,
    artifactsRepointed: 0,
    eventsRepointed: 0,
    mismatches: [],
  };

  const tx = db.transaction(() => {
    const runs = db.prepare("SELECT * FROM runs").all() as LegacyRunRow[];
    const runIds = new Set(runs.map((r) => r.id));

    // Refuse malformed input rather than guessing: a lineage_id that points nowhere.
    for (const run of runs) {
      if (run.lineage_id && !runIds.has(run.lineage_id) && run.lineage_id !== run.id) {
        report.mismatches.push(`run ${run.id} has lineage_id ${run.lineage_id} which does not exist`);
      }
    }
    if (report.mismatches.length > 0) return;

    const groups = groupByLineage(runs);
    let issueSeq = 0;
    let sessionSeq = 0;

    for (const [, lineageRuns] of groups) {
      issueSeq += 1;
      const issueId = `issue-${issueSeq}`;
      const latest = latestRun(lineageRuns);
      const mapped = issueStatusForLatest(latest.status);

      db.prepare(`
        INSERT INTO issues (
          id, source, external_id, external_label, external_url, title, description,
          acceptance_criteria, repo, base_branch, status, current_owner, current_intent,
          developer_agent_id, reviewer_agent_id, max_review_rounds, current_round,
          branch, base_sha, head_sha, pr_number, pr_url, created_at, updated_at
        ) VALUES (
          @id, @source, @external_id, @external_label, NULL, @title, @description,
          @acceptance_criteria, @repo, 'main', @status, @current_owner, NULL,
          @agent_id, @agent_id, 3, 1,
          NULL, NULL, NULL, NULL, NULL, @created_at, @updated_at
        )
      `).run({
        id: issueId,
        source: latest.source,
        external_id: latest.external_id,
        external_label: latest.external_label,
        title: latest.title,
        description: latest.description,
        acceptance_criteria: latest.acceptance_criteria,
        repo: latest.repo ?? "unknown",
        status: mapped.status,
        current_owner: mapped.owner,
        agent_id: latest.agent_id,
        created_at: latest.created_at,
        updated_at: latest.updated_at,
      });
      report.issuesCreated += 1;

      // One completed legacy_v0 workflow instance per lineage (audit only, never active).
      const instanceId = `${issueId}-legacy-instance`;
      db.prepare(`
        INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, completed_at, outcome)
        VALUES (?, ?, 'legacy_v0', ?, ?, 'migrated')
      `).run(instanceId, issueId, latest.created_at, latest.updated_at);

      if (mapped.humanAction) {
        db.prepare(`
          INSERT INTO human_actions (
            id, issue_id, workflow_instance_id, action_type, reason, question, evidence_json,
            response_options_json, continuation_preview_json, status, resolution_json, resolved_by,
            requested_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'open', NULL, NULL, ?, NULL)
        `).run(
          `${issueId}-legacy-action`,
          issueId,
          instanceId,
          mapped.humanAction.actionType,
          mapped.humanAction.reason,
          mapped.humanAction.question,
          latest.updated_at
        );
      }

      for (const run of lineageRuns) {
        sessionSeq += 1;
        const sessionId = `session-${sessionSeq}`;
        const sessionStatus = legacySessionStatus(run.status);
        db.prepare(`
          INSERT INTO worker_sessions (
            id, issue_id, role, round, agent_id, runtime, model, budget_json, worktree_path,
            input_sha, status, session_ref, log_path, exit_code, error_json, metadata_json,
            created_at, started_at, heartbeat_at, completed_at, updated_at
          ) VALUES (
            ?, ?, 'legacy', 1, ?, NULL, NULL, NULL, NULL,
            NULL, ?, NULL, NULL, NULL, NULL, ?,
            ?, NULL, NULL, ?, ?
          )
        `).run(
          sessionId,
          issueId,
          run.agent_id,
          sessionStatus,
          JSON.stringify({ legacyRunId: run.id, legacyStatus: run.status }),
          run.created_at,
          run.updated_at,
          run.updated_at
        );
        report.legacySessionsCreated += 1;

        const artifacts = db.prepare("SELECT * FROM artifacts WHERE run_id = ?").all(run.id) as Array<{
          id: string;
          kind: string;
          content_json: string | null;
          blob_path: string | null;
          author: string;
          created_at: string;
        }>;
        for (const a of artifacts) {
          db.prepare(`
            INSERT INTO artifacts (id, issue_id, worker_session_id, kind, content_json, blob_path, author, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`${a.id}-migrated`, issueId, sessionId, a.kind, a.content_json, a.blob_path, a.author, a.created_at);
          report.artifactsRepointed += 1;
        }

        const events = db.prepare("SELECT * FROM events WHERE run_id = ?").all(run.id) as Array<{
          id: string;
          type: string;
          payload_json: string | null;
          ts: string;
        }>;
        for (const e of events) {
          db.prepare(`
            INSERT INTO workflow_events (
              id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref,
              stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts
            ) VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, 1, ?, NULL, NULL, NULL, ?)
          `).run(`${e.id}-migrated`, issueId, instanceId, sessionId, e.type, mapped.status, e.payload_json, e.ts);
          report.eventsRepointed += 1;
        }
      }
    }

    // Verification gate — any mismatch aborts the transaction.
    const issueCount = (db.prepare("SELECT COUNT(*) as c FROM issues").get() as { c: number }).c;
    if (issueCount !== groups.size) {
      report.mismatches.push(`expected ${groups.size} issues, found ${issueCount}`);
    }
    const sessionCount = (db.prepare("SELECT COUNT(*) as c FROM worker_sessions WHERE role = 'legacy'").get() as {
      c: number;
    }).c;
    if (sessionCount !== runs.length) {
      report.mismatches.push(`expected ${runs.length} legacy sessions, found ${sessionCount}`);
    }

    if (report.mismatches.length > 0) {
      throw new Error("migration verification failed — rolling back");
    }

    // Rename legacy tables so the new runtime writers are the only ones touching
    // "issues"/"worker_sessions"/etc., while the originals stay inspectable for one release.
    for (const table of ["runs", "artifacts", "events", "approval_gates"]) {
      db.exec(`ALTER TABLE ${table} RENAME TO legacy_v0_${table}`);
    }
  });

  try {
    tx();
  } catch {
    // better-sqlite3 already rolled back the transaction; report.mismatches carries the reason.
    if (report.mismatches.length === 0) {
      report.mismatches.push("migration failed for an unexpected reason — see thrown error");
    }
  }

  db.close();
  return report;
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: tsx scripts/migrate-to-issues.ts <path-to-dealer.db>");
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }
  const lockPath = path.join(path.dirname(dbPath), "dealer.lock");
  if (fs.existsSync(lockPath)) {
    console.error(`Refusing to migrate while a registered process is active (lock: ${lockPath})`);
    process.exit(1);
  }
  const report = runMigration(dbPath);
  console.log(JSON.stringify(report, null, 2));
  if (report.mismatches.length > 0) {
    console.error("Migration rolled back — see mismatches above. Original data untouched.");
    process.exit(1);
  }
  console.log("Migration complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

**Note for the implementer:** the lock-file check in `main()` (`dealer.lock`) is a placeholder for whatever process-liveness signal the server actually uses — check `packages/server/src/runners/process-registry.ts` for the real mechanism before wiring this up, and adjust `main()` to check that instead of inventing a new lock file. This is a real open item, not a placeholder in the plan-forbidden sense (`runMigration` itself, which is what the tests exercise, has no placeholder logic) — flag it explicitly to whoever reviews this task rather than silently picking a convention.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test scripts/migrate-to-issues.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full monorepo test suite, then commit**

```bash
npm run test:unit
git add scripts/migrate-to-issues.ts scripts/migrate-to-issues.test.ts
git commit -m "Add issue-centric migration and cutover script (NOT-57)"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Every table in the spec's Data model section (`issues`, `agents` additions, `worker_sessions`, `workflow_instances`, `workflow_events`, `human_actions`, `findings`, `usage_events`) has a task. The migration section's six steps map to Task 10 (steps 1/6 partially delegated to the human operator running the script with the service stopped — `runMigration` implements steps 2-5 and the rename in step 6; the backup-and-stop-service precondition in step 1 is the `main()` CLI wrapper, tested separately from `runMigration`'s pure logic).
- **Deferred to later plans, on purpose:** the coordinator (worktrees, `gh` adapter, session spawning), the API routes, the CLI, and the frontend are out of scope for this plan — they consume the repositories built here.
- **Type consistency check:** `WorkerSession.role` includes `"legacy"` (Task 2) and Task 10's migration script only ever inserts `role: 'legacy'` rows — consistent. `Issue.status` values used in Task 10 (`ready`, `done`, `closed`, `final_review`, `needs_human`) are all members of `IssueStatus` from Task 1. `HumanActionType` values used in Task 10 (`final_review`, `attempts_exhausted`) match Task 4's enum.
- **Test-framework correction:** the first draft of this plan used vitest (`describe`/`it`/`expect`/`vi.mock`), which is not installed in this repo — every test in this plan now uses `node:test` + `node:assert/strict`, matching `packages/server/src/repository/runs-external-id.test.ts`'s existing pattern exactly (env-var-driven temp `AGENT_DEALER_HOME` + real `migrate()`, no module mocking, no in-memory-only DB for repository tests). Every server-side test run command now also accounts for `@agent-dealer/shared` needing a fresh `npm run build -w @agent-dealer/shared` after any shared-source change, matching the root `test:unit` script's own ordering.
