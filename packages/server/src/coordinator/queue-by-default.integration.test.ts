// packages/server/src/coordinator/queue-by-default.integration.test.ts
//
// NOT-118 acceptance: every issue enters execution through admission. Create enqueues,
// Start moves to the front (never bypasses), a busy system leaves the rest visibly queued
// with a reason, missing acceptance criteria is a wait reason rather than a human action,
// and a human-action resume stays ungated.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not118-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { getIssue, updateIssue, transitionIssue } = await import("../repository/issues.js");
const { createHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { getActiveWorkflowInstance, completeWorkflowInstance } = await import(
  "../repository/workflow-events.js"
);
const { listQueuedEntries, getQueuedEntryForIssue, dequeueIssue } = await import(
  "../repository/queue-entries.js"
);
const { registerIssueRoutes } = await import("../routes/issues.js");
const { registerQueueRoutes } = await import("../routes/queue.js");
const { resolveHumanActionAndAdvance } = await import("./commands.js");
const {
  admitNext,
  setAdmissionHealthCheckerForTests,
  resetCapacityPolicyForTests,
  resetEligibilityRulesForTests,
} = await import("./admission.js");
const { setBlockersProviderForTests, resetDependenciesForTests } = await import(
  "./dependencies.js"
);

before(() => migrate());

beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
  // Admission otherwise probes the real Claude/Cursor/gh CLIs per queued entry.
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  // NOT-104 is fail-closed, so a Linear-sourced issue with no reachable Linear parks. These
  // cases are about queue-by-default, not dependencies — declare "no blockers" for all.
  setBlockersProviderForTests(async (issues) => new Map(issues.map((i) => [i.externalId!, []])));
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
});

after(() => {
  setAdmissionHealthCheckerForTests(null);
  resetDependenciesForTests();
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  await registerQueueRoutes(app);
  return app;
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not118-repo-"));
const dev = createAgent({ name: `not118-dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: repo });
const rev = createAgent({ name: `not118-rev-${Math.random()}`, runtime: "claude_code", workspaceRoot: repo });

type CreateOverrides = { acceptanceCriteria?: string | null; enqueue?: boolean };

async function createIssueViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  title: string,
  overrides: CreateOverrides = {}
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: {
      title,
      repo,
      baseBranch: "main",
      developerAgentId: dev.id,
      reviewerAgentId: rev.id,
      ...(overrides.acceptanceCriteria === null ? {} : { acceptanceCriteria: overrides.acceptanceCriteria ?? "It works" }),
      ...(overrides.enqueue === undefined ? {} : { enqueue: overrides.enqueue }),
    },
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { id: string }).id;
}

type StartBody =
  | { state: "admitted"; instance: { id: string }; workItem: { id: string; kind: string } }
  | { state: "queued"; position: number; waitReason: string | null };

async function startViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  issueId: string
): Promise<StartBody> {
  const res = await app.inject({ method: "POST", url: `/api/issues/${issueId}/start` });
  assert.equal(res.statusCode, 200, `start failed: ${res.body}`);
  return res.json() as StartBody;
}

test("create enqueues instead of starting; enqueue:false leaves an unqueued draft", async () => {
  const app = await buildApp();
  const queued = await createIssueViaApi(app, "Queued by default");
  const draft = await createIssueViaApi(app, "Draft", { enqueue: false });

  assert.equal(getIssue(queued)!.status, "ready");
  assert.equal(getActiveWorkflowInstance(queued), null, "create must never start a workflow");
  assert.equal(getQueuedEntryForIssue(queued)?.state, "queued");
  assert.equal(getQueuedEntryForIssue(draft), null);
  assert.deepEqual(listQueuedEntries().map((e) => e.issueId), [queued]);
  await app.close();
});

test("with one issue active, three more creates stay queued with positions and a visible slot reason", async () => {
  const app = await buildApp();
  const running = await createIssueViaApi(app, "Running one");
  const started = await startViaApi(app, running);
  assert.equal(started.state, "admitted");

  const rest: string[] = [];
  for (const title of ["Second", "Third", "Fourth"]) {
    rest.push(await createIssueViaApi(app, title));
  }
  // A coordinator tick with capacity full must not admit any of them.
  assert.equal(await admitNext(), null);

  const queue = (await app.inject({ method: "GET", url: "/api/queue" })).json() as Array<{
    issueId: string;
    position: number;
    waitReason: string | null;
  }>;
  assert.deepEqual(queue.map((e) => e.issueId), rest);
  assert.deepEqual(queue.map((e) => e.position), [1, 2, 3]);
  for (const entry of queue) {
    assert.match(entry.waitReason ?? "", /waiting for slot — running: Running one/);
  }

  const statuses = [running, ...rest].map((id) => getIssue(id)!.status);
  assert.equal(statuses.filter((s) => s === "developing" || s === "reviewing" || s === "repairing").length, 1);
  assert.deepEqual(statuses.slice(1), ["ready", "ready", "ready"]);
  await app.close();
});

test("start on a queued issue moves it to position 1 and admits it when a slot is free", async () => {
  const app = await buildApp();
  const first = await createIssueViaApi(app, "First in line");
  const second = await createIssueViaApi(app, "Second in line");
  const third = await createIssueViaApi(app, "Third in line");
  assert.deepEqual(listQueuedEntries().map((e) => e.issueId), [first, second, third]);

  const started = await startViaApi(app, third);
  assert.equal(started.state, "admitted");
  assert.equal(getIssue(third)!.status, "developing");
  assert.equal(getQueuedEntryForIssue(third), null);
  // The others keep their relative order behind the one that was pulled forward.
  assert.deepEqual(listQueuedEntries().map((e) => e.issueId), [first, second]);
  await app.close();
});

test("start while busy waits at the top and is the next one admitted — no bypass", async () => {
  const app = await buildApp();
  const running = await createIssueViaApi(app, "Occupying issue");
  assert.equal((await startViaApi(app, running)).state, "admitted");

  const waiting = await createIssueViaApi(app, "Waiting issue");
  const queuedAhead = await createIssueViaApi(app, "Already ahead");
  // `queuedAhead` was created after `waiting`, so move it up first — Start must then put
  // `waiting` back in front of it.
  const aheadStart = await startViaApi(app, queuedAhead);
  assert.equal(aheadStart.state, "queued");

  const result = await startViaApi(app, waiting);
  assert.equal(result.state, "queued");
  if (result.state === "queued") {
    assert.equal(result.position, 1);
    assert.match(result.waitReason ?? "", /waiting for slot — running: Occupying issue/);
  }
  // No bypass: the busy system started nothing new.
  assert.equal(getIssue(waiting)!.status, "ready");
  assert.equal(getActiveWorkflowInstance(waiting), null);
  assert.deepEqual(listQueuedEntries().map((e) => e.issueId), [waiting, queuedAhead]);

  // Slot frees → the next tick admits the issue that was moved to the top.
  getDb().prepare("UPDATE issues SET status = 'closed' WHERE id = ?").run(running);
  getDb()
    .prepare("UPDATE workflow_instances SET completed_at = ? WHERE issue_id = ? AND completed_at IS NULL")
    .run(new Date().toISOString(), running);
  const admitted = await admitNext();
  assert.equal(admitted?.issueId, waiting);
  assert.equal(getIssue(waiting)!.status, "developing");
  await app.close();
});

test("start with missing acceptance criteria yields a wait reason, never a product_scope_decision", async () => {
  const app = await buildApp();
  const issueId = await createIssueViaApi(app, "No criteria", { acceptanceCriteria: null });

  const result = await startViaApi(app, issueId);
  assert.equal(result.state, "queued");
  if (result.state === "queued") assert.match(result.waitReason ?? "", /acceptance criteria/i);
  assert.equal(listHumanActionsForIssue(issueId).length, 0);
  assert.equal(getActiveWorkflowInstance(issueId), null);

  // Editing the acceptance criteria unblocks it on the next tick — no second Start needed.
  updateIssue(issueId, { acceptanceCriteria: "Now testable" });
  const admitted = await admitNext();
  assert.equal(admitted?.issueId, issueId);
  assert.equal(getIssue(issueId)!.status, "developing");
  await app.close();
});

test("human-action resume stays ungated — it may exceed capacity", async () => {
  const app = await buildApp();
  const running = await createIssueViaApi(app, "Occupying issue");
  assert.equal((await startViaApi(app, running)).state, "admitted");

  // An issue parked on a scope gate resumes through the human action, not admission.
  const parked = await createIssueViaApi(app, "Parked on a gate", { acceptanceCriteria: null });
  const action = createHumanAction({
    issueId: parked,
    actionType: "product_scope_decision",
    reason: "no acceptance criteria",
    question: "Add acceptance criteria",
    responseOptions: [{ choice: "resume", label: "Added — start" }],
  });
  updateIssue(parked, { acceptanceCriteria: "Now testable" });

  const resolved = resolveHumanActionAndAdvance(action.id, "tester", "resume");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(parked)!.status, "developing", "resume must not be blocked by a full queue");
  assert.equal(getIssue(running)!.status, "developing");
  assert.equal(getQueuedEntryForIssue(parked), null, "the resumed issue leaves the queue");
  await app.close();
});

test("re-queueing a dequeued issue works, and start 409s once a workflow is active", async () => {
  const app = await buildApp();
  const issueId = await createIssueViaApi(app, "Re-enqueue me");
  dequeueIssue(issueId);
  assert.equal(getQueuedEntryForIssue(issueId), null);

  const readd = await app.inject({ method: "POST", url: "/api/queue", payload: { issueId } });
  assert.equal(readd.statusCode, 200);
  assert.equal((await startViaApi(app, issueId)).state, "admitted");

  const again = await app.inject({ method: "POST", url: `/api/issues/${issueId}/start` });
  assert.equal(again.statusCode, 409);
  await app.close();
});

test("re-importing a migrated final_review issue conflicts; a still-startable one re-enqueues", async () => {
  const app = await buildApp();
  const payload = {
    title: "Kicked twice from Linear",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    acceptanceCriteria: "It works",
    source: "linear",
    externalId: "LIN-FR-1",
  };
  const first = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as {
    id: string;
  };

  // The shape a migrated issue has: a *completed* instance, parked on final_review awaiting
  // a human's merge call — nonterminal, and with no active workflow to block on.
  const started = await startViaApi(app, first.id);
  assert.equal(started.state, "admitted");
  if (started.state === "admitted") completeWorkflowInstance(started.instance.id, "migrated");
  transitionIssue(first.id, "reviewing");
  transitionIssue(first.id, "final_review");
  assert.equal(getActiveWorkflowInstance(first.id), null);

  // Re-import must not duplicate the row, and must not queue an entry admission would reject
  // forever with `status final_review — not startable`. NOT-141: it says so with a 409 naming
  // the issue rather than a 200 the caller cannot tell from a fresh import.
  const second = await app.inject({ method: "POST", url: "/api/issues", payload });
  assert.equal(second.statusCode, 409);
  assert.equal((second.json() as { existingIssueId: string }).existingIssueId, first.id);
  assert.equal(getQueuedEntryForIssue(first.id), null, "final_review is not startable");
  assert.deepEqual(listQueuedEntries().map((e) => e.issueId), []);

  // The other side of the same predicate: a dequeued but still-`ready` import re-enqueues.
  const readyPayload = { ...payload, title: "Still ready", externalId: "LIN-FR-2" };
  const ready = (
    await app.inject({ method: "POST", url: "/api/issues", payload: readyPayload })
  ).json() as { id: string };
  dequeueIssue(ready.id);
  assert.equal(getQueuedEntryForIssue(ready.id), null);
  const reimport = await app.inject({ method: "POST", url: "/api/issues", payload: readyPayload });
  assert.equal(reimport.statusCode, 200);
  const reimported = reimport.json() as { id: string; created: boolean; queue: string };
  assert.equal(reimported.id, ready.id);
  assert.equal(reimported.created, false);
  // This one really did queue something — the entry was gone before the request.
  assert.equal(reimported.queue, "enqueued");
  assert.equal(getQueuedEntryForIssue(ready.id)?.state, "queued");
  await app.close();
});

test("no route starts a workflow outside admission (the one exception is human-action resume)", async () => {
  const routesDir = new URL("../routes/", import.meta.url);
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const file of files) {
    const source = fs.readFileSync(new URL(file, routesDir), "utf8");
    assert.ok(
      !/startWorkflowCore\s*\(/.test(source),
      `${file} must not call startWorkflowCore — routes start issues through startIssueViaQueue`
    );
    assert.ok(
      !/\bstartWorkflow\s*\(/.test(source),
      `${file} must not call startWorkflow — routes start issues through startIssueViaQueue`
    );
  }
});

test("migrating an existing database does not enqueue or start pre-existing ready issues", async () => {
  const app = await buildApp();
  const issueId = await createIssueViaApi(app, "Pre-existing", { enqueue: false });
  assert.equal(getIssue(issueId)!.status, "ready");

  // Redeploy = re-run migrate() against the same database.
  migrate();

  assert.equal(listQueuedEntries().length, 0);
  assert.equal(getIssue(issueId)!.status, "ready");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  await app.close();
});
