# Issue Coordination — API & CLI Implementation Plan

**Goal:** Expose the issue-centric data model and coordinator (Plans 1–2) over HTTP, and ship the thin `agent-dealer issue|action` CLI subcommands that give coding agents the same state and controls as the UI, per PRD §8.

**Depends on:** Plan 1 (data model) and Plan 2 (coordinator) — both complete.

**Spec:** `docs/2026-09-10-issue-centric-coordination-design.md` (API, Coding-agent CLI sections)

**Tech Stack:** Same as Plans 1–2 — `node:test`/`node:assert/strict` via `npx tsx --test`. Route tests use Fastify's built-in `app.inject()` (no supertest/extra dependency needed — `fastify` is already a dependency and `inject()` ships with it).

## Global Constraints

- No new routing framework — routes register on the existing `FastifyInstance` the same way `packages/server/src/routes/index.ts` already does (`app.get<{Params}>(...)`, `reply.status(404).send({error: "..."})`).
- Idempotency is scoped to what the PRD's P0 capability list actually requires, not a generic idempotency-key subsystem: `POST /api/issues` is idempotent on `(source, externalId)` (returns the existing issue instead of creating a duplicate), and `POST /api/issues/:id/start` is idempotent by returning the existing active `workflow_instance` instead of erroring if one is already running — matching the spec's "idempotently returns its active instance when already running." A generic per-request idempotency-key ledger is out of scope for this plan; flagged in the self-review, not silently dropped.
- The CLI additions live in the **existing** `packages/cli` package (the `agent-dealer` binary already ships `setup`/`start`/`stop`/`status`/`doctor`/`install`/`upgrade`) as two new top-level commands, `issue` and `action`, following the exact same hand-rolled arg-parsing style already used in `packages/cli/src/index.ts` — no new CLI framework.
- The CLI talks to the server exclusively over HTTP (`fetch` against `http://127.0.0.1:<port>`, resolved the same way `status.ts` already resolves it) — it contains no workflow logic of its own, matching the spec's "CLI adapters must remain clients of the same API."

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/repository/artifacts-for-issue.ts` (new) | `listArtifactsForIssue`, paginated |
| `packages/server/src/repository/usage-events.ts` (modify) | Add `listUsageEventsForIssue` alongside the existing `summarizeIssueUsage` |
| `packages/server/src/coordinator/intent-forecast.ts` (new) | Pure function: issue status → `{ now, next, then? }` display strings for §7.5's rail |
| `packages/server/src/coordinator/human-resolution.ts` (new) | Pure function: `(actionType, resolution)` → what happens next to the issue |
| `packages/server/src/routes/issues.ts` (new) | `GET/POST /api/issues`, `GET /api/issues/:id`, `GET /api/issues/:id/evidence`, `POST /api/issues/:id/start`, `POST /api/issues/:id/guidance` |
| `packages/server/src/routes/human-actions.ts` (new) | `GET /api/human-actions`, `POST /api/human-actions/:id/resolve` |
| `packages/server/src/index.ts` (modify) | Register the two new route modules alongside `registerRoutes` |
| `packages/cli/src/issue.ts` (new) | `agent-dealer issue create|import|show|start|guide` |
| `packages/cli/src/action.ts` (new) | `agent-dealer action list|resolve` |
| `packages/cli/src/index.ts` (modify) | Wire the two new top-level commands into `runCli` |

---

### Task 1: Evidence repository additions + intent forecast

**Files:**
- Create: `packages/server/src/repository/artifacts-for-issue.ts`
- Modify: `packages/server/src/repository/usage-events.ts`
- Create: `packages/server/src/coordinator/intent-forecast.ts`
- Test: `packages/server/src/repository/artifacts-for-issue.test.ts`
- Test: `packages/server/src/coordinator/intent-forecast.test.ts`

**Interfaces:**
- Produces: `listArtifactsForIssue(issueId: string, opts?: { limit?: number; before?: string }): Artifact[]` (paginated by `created_at`, newest first, `before` is an ISO timestamp cursor); `listUsageEventsForIssue(issueId: string): UsageEvent[]`; `computeIntentForecast(issue: Issue): { now: string; next: string }`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/server/src/repository/artifacts-for-issue.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-artifacts-issue-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { listArtifactsForIssue } = await import("./artifacts-for-issue.js");
const { recordUsageEvent } = await import("./usage-events.js");
const { createWorkerSession } = await import("./worker-sessions.js");

before(() => {
  migrate();
});

test("lists artifacts for an issue newest first, respects limit", () => {
  const issue = createIssue({ title: "T", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, source: "manual" });
  const db = getDb();
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO artifacts (id, issue_id, run_id, kind, content_json, author, created_at) VALUES (?, ?, NULL, 'task_snapshot', '{}', 'system', ?)`
    ).run(`art-${i}`, issue.id, new Date(now + i * 1000).toISOString());
  }
  const all = listArtifactsForIssue(issue.id);
  assert.equal(all.length, 3);
  assert.equal(all[0].id, "art-2"); // newest first

  const limited = listArtifactsForIssue(issue.id, { limit: 2 });
  assert.equal(limited.length, 2);
});

test("listUsageEventsForIssue returns recorded events", async () => {
  const { listUsageEventsForIssue } = await import("./usage-events.js");
  const issue = createIssue({ title: "U", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, source: "manual" });
  const session = createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  recordUsageEvent({ issueId: issue.id, workerSessionId: session.id, role: "developer", costUsd: 1 });
  const events = listUsageEventsForIssue(issue.id);
  assert.equal(events.length, 1);
});
```

```typescript
// packages/server/src/coordinator/intent-forecast.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIntentForecast } from "./intent-forecast.js";
import type { Issue } from "@agent-dealer/shared";

const BASE: Issue = {
  id: "i1", source: "manual", externalId: null, externalLabel: null, externalUrl: null,
  title: "T", description: null, acceptanceCriteria: null, repo: "/r", baseBranch: "main",
  status: "ready", currentOwner: "system", currentIntent: null,
  developerAgentId: null, reviewerAgentId: null, maxReviewRounds: 3, currentRound: 1,
  branch: null, baseSha: null, headSha: null, prNumber: null, prUrl: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

test("ready issue forecasts starting the developer round", () => {
  const forecast = computeIntentForecast(BASE);
  assert.match(forecast.now, /Ready/i);
  assert.match(forecast.next, /developer/i);
});

test("developing issue forecasts handoff verification", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "developing", currentOwner: "developer" });
  assert.match(forecast.now, /Developer/i);
  assert.match(forecast.next, /verify|handoff|pr/i);
});

test("reviewing issue mentions the round number", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "reviewing", currentOwner: "reviewer", currentRound: 2 });
  assert.match(forecast.now, /Reviewer/i);
  assert.ok(forecast.now.includes("2") || forecast.next.includes("2"));
});

test("needs_human issue forecasts waiting on a decision", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "needs_human", currentOwner: "human" });
  assert.match(forecast.now, /human|action/i);
});

test("done issue has no next step", () => {
  const forecast = computeIntentForecast({ ...BASE, status: "done" });
  assert.equal(forecast.next, "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/server/src/repository/artifacts-for-issue.test.ts packages/server/src/coordinator/intent-forecast.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```typescript
// packages/server/src/repository/artifacts-for-issue.ts
import type { Artifact, ArtifactKind } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";

interface ArtifactRow {
  id: string;
  issue_id: string | null;
  worker_session_id: string | null;
  kind: string;
  content_json: string | null;
  blob_path: string | null;
  author: string;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): Artifact & { issueId: string | null; workerSessionId: string | null } {
  return {
    id: row.id,
    runId: "", // legacy field, unused for issue-linked artifacts — kept only so the Artifact shape still parses
    issueId: row.issue_id,
    workerSessionId: row.worker_session_id,
    kind: row.kind as ArtifactKind,
    contentJson: row.content_json,
    blobPath: row.blob_path,
    author: row.author as Artifact["author"],
    createdAt: row.created_at,
  };
}

export function listArtifactsForIssue(issueId: string, opts?: { limit?: number; before?: string }) {
  const limit = opts?.limit ?? 50;
  const rows = opts?.before
    ? (getDb()
        .prepare("SELECT * FROM artifacts WHERE issue_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .all(issueId, opts.before, limit) as ArtifactRow[])
    : (getDb()
        .prepare("SELECT * FROM artifacts WHERE issue_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(issueId, limit) as ArtifactRow[]);
  return rows.map(rowToArtifact);
}
```

Append to `packages/server/src/repository/usage-events.ts` (after `summarizeIssueUsage`):

```typescript
export function listUsageEventsForIssue(issueId: string): UsageEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM usage_events WHERE issue_id = ? ORDER BY ts ASC")
    .all(issueId) as UsageEventRow[];
  return rows.map(rowToUsageEvent);
}
```

```typescript
// packages/server/src/coordinator/intent-forecast.ts
import type { Issue, IssueStatus } from "@agent-dealer/shared";

export interface IntentForecast {
  now: string;
  next: string;
}

const FORECASTS: Record<IssueStatus, (issue: Issue) => IntentForecast> = {
  ready: () => ({ now: "Ready to start", next: "Start the developer round" }),
  developing: (i) => ({ now: `Developer implementing round ${i.currentRound}`, next: "Verify the handoff once the session completes" }),
  reviewing: (i) => ({ now: `Reviewer evaluating round ${i.currentRound}`, next: "Route the reviewer's verdict" }),
  repairing: (i) => ({ now: `Developer repairing round ${i.currentRound}`, next: "Verify the handoff once the session completes" }),
  final_review: () => ({ now: "Awaiting final human review", next: "Human resolves: complete, repair, or close" }),
  needs_human: () => ({ now: "Waiting on a human action", next: "Resolve the open action to resume" }),
  done: () => ({ now: "Done", next: "" }),
  closed: () => ({ now: "Closed", next: "" }),
};

export function computeIntentForecast(issue: Issue): IntentForecast {
  return FORECASTS[issue.status](issue);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/server/src/repository/artifacts-for-issue.test.ts packages/server/src/coordinator/intent-forecast.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/repository/artifacts-for-issue.ts packages/server/src/repository/artifacts-for-issue.test.ts \
        packages/server/src/repository/usage-events.ts \
        packages/server/src/coordinator/intent-forecast.ts packages/server/src/coordinator/intent-forecast.test.ts
git commit -m "Add issue-scoped evidence queries and intent-forecast computation (NOT-57)"
```

---

### Task 2: Human-resolution routing

**Files:**
- Create: `packages/server/src/coordinator/human-resolution.ts`
- Test: `packages/server/src/coordinator/human-resolution.test.ts`

Mirrors `routing.ts`'s style (Plan 2 Task 4) but for the human side of PRD §6.3's pass-the-ball table: "Human | Resolved typed action | Continue, repair, complete, or close | Workflow-selected role."

**Interfaces:**
- Produces:
  - `type HumanResolution = { actionType: "final_review"; choice: "complete" | "repair" | "close" } | { actionType: "attempts_exhausted"; choice: "retry" | "close" } | { actionType: "policy_escalation"; choice: "resume" | "close" } | { actionType: "product_scope_decision"; choice: "resume"; note?: string }`
  - `type HumanResolutionResult = { issueStatus: "done" | "repairing" | "closed" | "developing"; workflowOutcome?: "done" | "closed"; startNewRound?: boolean; triggerReflect?: boolean }`
  - `resolveHumanActionOutcome(resolution: HumanResolution): HumanResolutionResult`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/coordinator/human-resolution.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHumanActionOutcome } from "./human-resolution.js";

test("final_review complete marks the issue done and triggers reflect", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "complete" });
  assert.equal(result.issueStatus, "done");
  assert.equal(result.workflowOutcome, "done");
  assert.equal(result.triggerReflect, true);
});

test("final_review repair sends the issue back for another round without reflect", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "repair" });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
  assert.equal(result.triggerReflect, undefined);
});

test("final_review close closes the workflow without accepting the work", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "close" });
  assert.equal(result.issueStatus, "closed");
  assert.equal(result.workflowOutcome, "closed");
  assert.equal(result.triggerReflect, undefined);
});

test("attempts_exhausted retry starts a new round (v1: equivalent to another repair round)", () => {
  const result = resolveHumanActionOutcome({ actionType: "attempts_exhausted", choice: "retry" });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
});

test("attempts_exhausted close ends the issue", () => {
  const result = resolveHumanActionOutcome({ actionType: "attempts_exhausted", choice: "close" });
  assert.equal(result.issueStatus, "closed");
});

test("policy_escalation resume continues development", () => {
  const result = resolveHumanActionOutcome({ actionType: "policy_escalation", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
  assert.equal(result.startNewRound, true);
});

test("product_scope_decision resume continues development from the pre-start gate", () => {
  const result = resolveHumanActionOutcome({ actionType: "product_scope_decision", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/coordinator/human-resolution.test.ts`
Expected: FAIL — `Cannot find module './human-resolution.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/coordinator/human-resolution.ts

export type HumanResolution =
  | { actionType: "final_review"; choice: "complete" | "repair" | "close" }
  | { actionType: "attempts_exhausted"; choice: "retry" | "close" }
  | { actionType: "policy_escalation"; choice: "resume" | "close" }
  | { actionType: "product_scope_decision"; choice: "resume"; note?: string };

export interface HumanResolutionResult {
  issueStatus: "done" | "repairing" | "closed" | "developing";
  workflowOutcome?: "done" | "closed";
  startNewRound?: boolean;
  triggerReflect?: boolean;
}

/**
 * Implements PRD §6.3's human pass-the-ball outcomes: continue, repair, complete, or close.
 * v1 (open decision #2 in the spec) treats every "resume/retry/repair" choice as starting
 * another round rather than distinguishing a true resume from a fresh repair round.
 */
export function resolveHumanActionOutcome(resolution: HumanResolution): HumanResolutionResult {
  switch (resolution.actionType) {
    case "final_review":
      if (resolution.choice === "complete") return { issueStatus: "done", workflowOutcome: "done", triggerReflect: true };
      if (resolution.choice === "repair") return { issueStatus: "repairing", startNewRound: true };
      return { issueStatus: "closed", workflowOutcome: "closed" };
    case "attempts_exhausted":
      return resolution.choice === "retry"
        ? { issueStatus: "repairing", startNewRound: true }
        : { issueStatus: "closed", workflowOutcome: "closed" };
    case "policy_escalation":
      return resolution.choice === "resume"
        ? { issueStatus: "developing", startNewRound: true }
        : { issueStatus: "closed", workflowOutcome: "closed" };
    case "product_scope_decision":
      return { issueStatus: "developing", startNewRound: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/coordinator/human-resolution.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/coordinator/human-resolution.ts packages/server/src/coordinator/human-resolution.test.ts
git commit -m "Add human-action resolution routing (NOT-57)"
```

---

### Task 3: Issue routes

**Files:**
- Create: `packages/server/src/routes/issues.ts`
- Test: `packages/server/src/routes/issues.test.ts`

**Interfaces:**
- Consumes: `createIssue`, `getIssue`, `listIssues`, `findIssueByExternalId`, `transitionIssue` (`../repository/issues.js`); `listWorkerSessionsForIssue` (`../repository/worker-sessions.js`); `listArtifactsForIssue` (`../repository/artifacts-for-issue.js`); `listUsageEventsForIssue`, `summarizeIssueUsage` (`../repository/usage-events.js`); `listWorkflowEventsForIssue`, `appendWorkflowEvent` (`../repository/workflow-events.js`); `listHumanActionsForIssue`, `listOpenHumanActions` (`../repository/human-actions.js`); `listFindingsForIssue` (`../repository/findings.js`); `computeIntentForecast` (`../coordinator/intent-forecast.js`); `startIssueWorkflow` (`../coordinator/session-lifecycle.js`)
- Produces: `export async function registerIssueRoutes(app: FastifyInstance): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/routes/issues.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-routes-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");

before(() => {
  migrate();
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  return app;
}

test("POST /api/issues creates an issue, GET lists it", async () => {
  const app = await buildApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { title: "Fix login bug", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID },
  });
  assert.equal(createRes.statusCode, 200);
  const created = createRes.json() as { id: string; status: string };
  assert.equal(created.status, "ready");

  const listRes = await app.inject({ method: "GET", url: "/api/issues" });
  const list = listRes.json() as Array<{ id: string }>;
  assert.ok(list.some((i) => i.id === created.id));
  await app.close();
});

test("POST /api/issues is idempotent on (source, externalId)", async () => {
  const app = await buildApp();
  const payload = { title: "Linear task", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, source: "linear", externalId: "LIN-1" };
  const first = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string };
  const second = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string };
  assert.equal(first.id, second.id);
  await app.close();
});

test("GET /api/issues/:id returns header, timeline, forecast, actions, findings", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Detail issue", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { issue: { id: string }; timeline: unknown[]; forecast: { now: string }; humanActions: unknown[]; findings: unknown[]; usageSummary: unknown };
  assert.equal(body.issue.id, created.id);
  assert.ok(Array.isArray(body.timeline));
  assert.ok(body.forecast.now.length > 0);
  await app.close();
});

test("GET /api/issues/:id 404s for an unknown id", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/issues/does-not-exist" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST /api/issues/:id/start transitions to developing and is idempotent", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Start me", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const first = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(second.statusCode, 200); // idempotent, not a 409
  await app.close();
});

test("POST /api/issues/:id/guidance appends a guidance.added event", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Guide me", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/guidance`, payload: { markdown: "please prioritize this" } });
  assert.equal(res.statusCode, 200);
  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as { timeline: Array<{ type: string }> };
  assert.ok(detail.timeline.some((e) => e.type === "guidance.added"));
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/routes/issues.test.ts`
Expected: FAIL — `Cannot find module './issues.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/routes/issues.ts
import type { FastifyInstance } from "fastify";
import { CreateIssueInput, IssueStatus } from "@agent-dealer/shared";
import { createIssue, getIssue, listIssues, findIssueByExternalId } from "../repository/issues.js";
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { listArtifactsForIssue } from "../repository/artifacts-for-issue.js";
import { listUsageEventsForIssue, summarizeIssueUsage } from "../repository/usage-events.js";
import { listWorkflowEventsForIssue, appendWorkflowEvent } from "../repository/workflow-events.js";
import { listHumanActionsForIssue, listOpenHumanActions } from "../repository/human-actions.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { computeIntentForecast } from "../coordinator/intent-forecast.js";
import { startIssueWorkflow } from "../coordinator/session-lifecycle.js";

export async function registerIssueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/issues", async (req) => {
    const status = (req.query as { status?: string }).status;
    const issues = status ? listIssues(status.split(",") as IssueStatus[]) : listIssues();
    const openActionIssueIds = new Set(listOpenHumanActions().map((a) => a.issueId));
    return issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      currentOwner: issue.currentOwner,
      currentIntent: issue.currentIntent,
      updatedAt: issue.updatedAt,
      hasOpenHumanAction: openActionIssueIds.has(issue.id),
    }));
  });

  app.get("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    return {
      issue,
      timeline: listWorkflowEventsForIssue(id),
      forecast: computeIntentForecast(issue),
      humanActions: listHumanActionsForIssue(id),
      findings: listFindingsForIssue(id),
      usageSummary: summarizeIssueUsage(id),
    };
  });

  app.get("/api/issues/:id/evidence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const { limit, before } = req.query as { limit?: string; before?: string };
    return {
      workerSessions: listWorkerSessionsForIssue(id),
      artifacts: listArtifactsForIssue(id, { limit: limit ? Number(limit) : undefined, before }),
      usageEvents: listUsageEventsForIssue(id),
    };
  });

  app.post("/api/issues", async (req, reply) => {
    const parsed = CreateIssueInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const input = parsed.data;
    if (input.externalId) {
      const existing = findIssueByExternalId(input.source, input.externalId);
      if (existing) return existing;
    }
    const issue = createIssue(input);
    appendWorkflowEvent({ issueId: issue.id, type: "issue.created", actorType: "human", stage: issue.status });
    return issue;
  });

  app.post("/api/issues/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    if (issue.status !== "ready") {
      // Idempotent: issue already has an active (or terminal) workflow — return current state
      // rather than erroring, matching "idempotently returns its active instance."
      return issue;
    }
    await startIssueWorkflow(id);
    return getIssue(id);
  });

  app.post("/api/issues/:id/guidance", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const { markdown } = req.body as { markdown: string };
    if (!markdown?.trim()) return reply.status(400).send({ error: "markdown is required" });
    const event = appendWorkflowEvent({ issueId: id, type: "guidance.added", actorType: "human", stage: issue.status, payload: { markdown } });
    return event;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/routes/issues.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full server test suite, then commit**

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/routes/issues.ts packages/server/src/routes/issues.test.ts
git commit -m "Add issue routes (list/get/create/start/guidance/evidence) (NOT-57)"
```

---

### Task 4: Human-action routes

**Files:**
- Create: `packages/server/src/routes/human-actions.ts`
- Test: `packages/server/src/routes/human-actions.test.ts`

**Interfaces:**
- Consumes: `listOpenHumanActions`, `resolveHumanAction` (`../repository/human-actions.js`); `resolveHumanActionOutcome` (`../coordinator/human-resolution.js`); `transitionIssue`, `getIssue` (`../repository/issues.js`); `completeWorkflowInstance` (`../repository/workflow-events.js`); `triggerReflectOnComplete` (`../coordinator/reflect-trigger.js`); `createWorkerSession` (`../repository/worker-sessions.js`)
- Produces: `export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/src/routes/human-actions.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-action-routes-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { registerHumanActionRoutes } = await import("./human-actions.js");

before(() => {
  migrate();
});

async function buildApp() {
  const app = Fastify();
  await registerHumanActionRoutes(app);
  return app;
}

function seedIssueAwaitingFinalReview() {
  const issue = createIssue({ title: "Awaiting review", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, source: "manual" });
  transitionIssue(issue.id, "developing");
  transitionIssue(issue.id, "reviewing");
  transitionIssue(issue.id, "final_review", { currentOwner: "human" });
  const action = createHumanAction({ issueId: issue.id, actionType: "final_review", reason: "Reviewer approved", question: "Accept?" });
  return { issue, action };
}

test("GET /api/human-actions lists only open actions", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "GET", url: "/api/human-actions" });
  const list = res.json() as Array<{ id: string; status: string }>;
  assert.ok(list.some((a) => a.id === action.id && a.status === "open"));
  await app.close();
});

test("resolving final_review as complete marks the issue done", async () => {
  const app = await buildApp();
  const { issue, action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(res.statusCode, 200);
  assert.equal(getIssue(issue.id)?.status, "done");
  const after = await app.inject({ method: "GET", url: "/api/human-actions" });
  assert.equal((after.json() as unknown[]).some((a: any) => a.id === action.id), false);
  await app.close();
});

test("resolving an already-resolved action returns its resolved state instead of erroring", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  const second = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(second.statusCode, 200);
  const body = second.json() as { status: string };
  assert.equal(body.status, "resolved");
  await app.close();
});

test("resolving final_review as repair sends the issue back to repairing", async () => {
  const app = await buildApp();
  const { issue, action } = seedIssueAwaitingFinalReview();
  await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "repair" } });
  assert.equal(getIssue(issue.id)?.status, "repairing");
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/server/src/routes/human-actions.test.ts`
Expected: FAIL — `Cannot find module './human-actions.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/routes/human-actions.ts
import type { FastifyInstance } from "fastify";
import { listOpenHumanActions, resolveHumanAction, listHumanActionsForIssue } from "../repository/human-actions.js";
import { getIssue, transitionIssue, incrementIssueRound } from "../repository/issues.js";
import { createWorkerSession } from "../repository/worker-sessions.js";
import { completeWorkflowInstance } from "../repository/workflow-events.js";
import { resolveHumanActionOutcome, type HumanResolution } from "../coordinator/human-resolution.js";
import { triggerReflectOnComplete } from "../coordinator/reflect-trigger.js";

export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/human-actions", async () => listOpenHumanActions());

  app.post("/api/human-actions/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolvedBy: string; choice: string };

    // Idempotent: an already-resolved action returns its resolved state rather than erroring.
    const existingForIssue = (issueId: string) => listHumanActionsForIssue(issueId).find((a) => a.id === id);

    let action;
    try {
      action = resolveHumanAction(id, body.resolvedBy, { choice: body.choice });
    } catch {
      // Look up whichever issue currently owns this action id to return its resolved record.
      // (Small scan is fine at this scale — see Task 4's amendment note if this needs indexing later.)
      const { listIssues } = await import("../repository/issues.js");
      for (const issue of listIssues()) {
        const found = existingForIssue(issue.id);
        if (found && found.id === id) return found;
      }
      return reply.status(404).send({ error: "Human action not found" });
    }

    const issue = getIssue(action.issueId);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const resolution = { actionType: action.actionType, choice: body.choice } as HumanResolution;
    const outcome = resolveHumanActionOutcome(resolution);

    transitionIssue(issue.id, outcome.issueStatus, { currentOwner: outcome.issueStatus === "developing" || outcome.issueStatus === "repairing" ? "developer" : "system" });

    if (outcome.workflowOutcome) {
      const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
      const events = listWorkflowEventsForIssue(issue.id);
      const instanceId = events.find((e) => e.workflowInstanceId)?.workflowInstanceId;
      if (instanceId) completeWorkflowInstance(instanceId, outcome.workflowOutcome);
    }

    if (outcome.startNewRound) {
      incrementIssueRound(issue.id);
      const next = getIssue(issue.id)!;
      createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: "claude_code" });
    }

    if (outcome.triggerReflect) {
      const { getAgent } = await import("../repository/agents.js");
      const developerAgent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
      await triggerReflectOnComplete(issue.id, developerAgent?.deckId ?? null, developerAgent?.playbookId ?? null);
    }

    return action;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/server/src/routes/human-actions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full server test suite, register both new route modules in the server, then commit**

Modify `packages/server/src/index.ts` — find where `registerRoutes(app)` is called and add the two new registrations alongside it:

```typescript
import { registerIssueRoutes } from "./routes/issues.js";
import { registerHumanActionRoutes } from "./routes/human-actions.js";
// ...
await registerRoutes(app);
await registerIssueRoutes(app);
await registerHumanActionRoutes(app);
```

```bash
npx tsx --test $(find packages/server -name '*.test.ts')
git add packages/server/src/routes/human-actions.ts packages/server/src/routes/human-actions.test.ts packages/server/src/index.ts
git commit -m "Add human-action routes and register issue-centric routes on the server (NOT-57)"
```

---

### Task 5: CLI adapter (`agent-dealer issue` / `agent-dealer action`)

**Files:**
- Create: `packages/cli/src/issue.ts`
- Create: `packages/cli/src/action.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/issue.test.ts`

**Interfaces:**
- Consumes: `readRunState` (`./runtime-state.js`), `resolveBundledListenPort` (`./env.js`) — same port-resolution pattern `status.ts` already uses.
- Produces: `resolveApiBase(): string`; `runIssueCommand(args: string[]): Promise<number>`; `runActionCommand(args: string[]): Promise<number>`

Only `resolveApiBase` and argument parsing are unit tested — the actual `fetch` calls against a running server are integration-level and not exercised here (this package has no existing route/server integration tests either; it's a pure HTTP client).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/src/issue.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueArgs } from "./issue.js";

test("parseIssueArgs: create requires --title and --repo", () => {
  const parsed = parseIssueArgs(["create", "--title", "Fix bug", "--repo", "/repo", "--developer-agent", "a1", "--reviewer-agent", "a2"]);
  assert.equal(parsed.subcommand, "create");
  assert.equal((parsed as { title: string }).title, "Fix bug");
});

test("parseIssueArgs: show requires an id", () => {
  const parsed = parseIssueArgs(["show", "issue-123"]);
  assert.equal(parsed.subcommand, "show");
  assert.equal((parsed as { id: string }).id, "issue-123");
});

test("parseIssueArgs: unknown subcommand throws", () => {
  assert.throws(() => parseIssueArgs(["bogus"]));
});

test("parseIssueArgs: guide requires an id and --message", () => {
  const parsed = parseIssueArgs(["guide", "issue-123", "--message", "prioritize this"]);
  assert.equal(parsed.subcommand, "guide");
  assert.equal((parsed as { id: string; message: string }).message, "prioritize this");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cli/src/issue.test.ts`
Expected: FAIL — `Cannot find module './issue.js'`

- [ ] **Step 3: Write the implementations**

```typescript
// packages/cli/src/issue.ts
import { readRunState } from "./runtime-state.js";
import { resolveBundledListenPort } from "./env.js";

export function resolveApiBase(): string {
  const state = readRunState();
  const port = state?.port ?? resolveBundledListenPort();
  return `http://127.0.0.1:${port}`;
}

export type ParsedIssueArgs =
  | { subcommand: "create"; title: string; repo: string; developerAgentId: string; reviewerAgentId: string; description?: string; acceptanceCriteria?: string; baseBranch?: string }
  | { subcommand: "import"; externalId: string; externalLabel?: string; title: string; repo: string; developerAgentId: string; reviewerAgentId: string }
  | { subcommand: "show"; id: string; includeEvidence: boolean }
  | { subcommand: "start"; id: string }
  | { subcommand: "guide"; id: string; message: string };

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export function parseIssueArgs(args: string[]): ParsedIssueArgs {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "create":
    case "import": {
      const title = flag(rest, "--title");
      const repo = flag(rest, "--repo");
      const developerAgentId = flag(rest, "--developer-agent");
      const reviewerAgentId = flag(rest, "--reviewer-agent");
      if (!title || !repo || !developerAgentId || !reviewerAgentId) {
        throw new Error(`${subcommand} requires --title, --repo, --developer-agent, --reviewer-agent`);
      }
      if (subcommand === "import") {
        const externalId = flag(rest, "--external-id");
        if (!externalId) throw new Error("import requires --external-id");
        return { subcommand: "import", externalId, externalLabel: flag(rest, "--external-label"), title, repo, developerAgentId, reviewerAgentId };
      }
      return { subcommand: "create", title, repo, developerAgentId, reviewerAgentId, description: flag(rest, "--description"), acceptanceCriteria: flag(rest, "--acceptance-criteria"), baseBranch: flag(rest, "--base-branch") };
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("show requires an issue id");
      return { subcommand: "show", id, includeEvidence: rest.includes("--include") && rest[rest.indexOf("--include") + 1] === "evidence" };
    }
    case "start": {
      const id = rest[0];
      if (!id) throw new Error("start requires an issue id");
      return { subcommand: "start", id };
    }
    case "guide": {
      const id = rest[0];
      const message = flag(rest, "--message");
      if (!id || !message) throw new Error("guide requires an issue id and --message");
      return { subcommand: "guide", id, message };
    }
    default:
      throw new Error(`Unknown issue subcommand: ${subcommand}`);
  }
}

async function apiFetch(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: opts?.method ?? "GET",
    headers: opts?.body ? { "content-type": "application/json" } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function runIssueCommand(args: string[]): Promise<number> {
  let parsed: ParsedIssueArgs;
  try {
    parsed = parseIssueArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  try {
    switch (parsed.subcommand) {
      case "create": {
        const result = await apiFetch("/api/issues", { method: "POST", body: { title: parsed.title, repo: parsed.repo, developerAgentId: parsed.developerAgentId, reviewerAgentId: parsed.reviewerAgentId, description: parsed.description, acceptanceCriteria: parsed.acceptanceCriteria, baseBranch: parsed.baseBranch, source: "agent" } });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "import": {
        const result = await apiFetch("/api/issues", { method: "POST", body: { title: parsed.title, repo: parsed.repo, developerAgentId: parsed.developerAgentId, reviewerAgentId: parsed.reviewerAgentId, source: "linear", externalId: parsed.externalId, externalLabel: parsed.externalLabel } });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "show": {
        const result = await apiFetch(`/api/issues/${parsed.id}`);
        if (parsed.includeEvidence) {
          const evidence = await apiFetch(`/api/issues/${parsed.id}/evidence`);
          console.log(JSON.stringify({ ...(result as object), evidence }, null, 2));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        return 0;
      }
      case "start": {
        const result = await apiFetch(`/api/issues/${parsed.id}/start`, { method: "POST" });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "guide": {
        const result = await apiFetch(`/api/issues/${parsed.id}/guidance`, { method: "POST", body: { markdown: parsed.message } });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
```

```typescript
// packages/cli/src/action.ts
import { resolveApiBase } from "./issue.js";

async function apiFetch(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: opts?.method ?? "GET",
    headers: opts?.body ? { "content-type": "application/json" } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function runActionCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === "list") {
      const result = await apiFetch("/api/human-actions");
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (subcommand === "resolve") {
      const id = rest[0];
      const choiceIdx = rest.indexOf("--choice");
      const choice = choiceIdx >= 0 ? rest[choiceIdx + 1] : undefined;
      if (!id || !choice) {
        console.error("resolve requires an action id and --choice");
        return 1;
      }
      const result = await apiFetch(`/api/human-actions/${id}/resolve`, { method: "POST", body: { resolvedBy: "cli", choice } });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.error(`Unknown action subcommand: ${subcommand}`);
    return 1;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
```

Modify `packages/cli/src/index.ts` — add two branches to `runCli` (after the existing `upgrade` branch, before the final `console.error("Unknown command...")`):

```typescript
  if (cmd === "issue") {
    const { runIssueCommand } = await import("./issue.js");
    return runIssueCommand(args.slice(1));
  }

  if (cmd === "action") {
    const { runActionCommand } = await import("./action.js");
    return runActionCommand(args.slice(1));
  }
```

Also add both to `printUsage()`'s help text, right after the `install`/`upgrade` lines:

```
  agent-dealer issue create --title T --repo R --developer-agent ID --reviewer-agent ID [--description D] [--acceptance-criteria A] [--base-branch B]
  agent-dealer issue import --external-id ID --title T --repo R --developer-agent ID --reviewer-agent ID [--external-label L]
  agent-dealer issue show <id> [--include evidence]
  agent-dealer issue start <id>
  agent-dealer issue guide <id> --message M
  agent-dealer action list
  agent-dealer action resolve <id> --choice CHOICE
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cli/src/issue.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full CLI package test suite (if any exist) plus a typecheck, then commit**

```bash
find packages/cli -name '*.test.ts' -not -path '*/dist/*' | xargs npx tsx --test
npm run typecheck -w @agent-dealer/cli 2>/dev/null || npm run build -w @agent-dealer/cli
git add packages/cli/src/issue.ts packages/cli/src/issue.test.ts packages/cli/src/action.ts packages/cli/src/index.ts
git commit -m "Add agent-dealer issue/action CLI subcommands (NOT-57)"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Every route in the spec's API section has a task (issues CRUD/evidence/start/guidance in Task 3, human-actions list/resolve in Task 4). The CLI's five `issue` subcommands and two `action` subcommands (Task 5) match the spec's "Coding-agent CLI" section exactly.
- **Deliberately out of scope, flagged not hidden:** a generic idempotency-key header/ledger (see Global Constraints); the `product_scope_decision` pre-start validation gate from the coordinator spec's step 1 ("If required product intent cannot be normalized without guessing, create product_scope_decision instead of spawning") — `POST /api/issues/:id/start` in this plan always calls `startIssueWorkflow` unconditionally rather than validating first; a dedicated `MCP` adapter (explicitly out of scope per the spec's own "Out of scope" section, the CLI is the P0 adapter).
- **Type consistency check:** `HumanResolution`'s `actionType` values (Task 2) match `HumanActionType` from `@agent-dealer/shared` (Plan 1) exactly. The routes in Task 3/4 call the exact function names/signatures Tasks 1-2 and Plan 1/2 export — cross-checked against each source file, not just the plan's own prose.
