// packages/server/src/routes/queue-reorder.integration.test.ts
//
// NOT-112 acceptance: operator can reorder queued issues via relative moves; admission
// respects the new order; moving a missing/admitted entry fails clearly without corrupting
// the remaining order.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not112-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { getIssue } = await import("../repository/issues.js");
const { listQueuedEntries, getQueuedEntryForIssue, markQueueEntryAdmitted } = await import(
  "../repository/queue-entries.js"
);
const { registerIssueRoutes } = await import("./issues.js");
const { registerQueueRoutes } = await import("./queue.js");
const {
  admitNext,
  setAdmissionHealthCheckerForTests,
  resetCapacityPolicyForTests,
  resetEligibilityRulesForTests,
} = await import("../coordinator/admission.js");
const { setBlockersProviderForTests, resetDependenciesForTests } = await import(
  "../coordinator/dependencies.js"
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
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
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

const repo = "acme/not112";
const dev = createAgent({
  name: `not112-dev-${Math.random()}`,
  runtime: "claude_code",
  deckId: "00000000-0000-4000-a000-000000000112",
});
const rev = createAgent({
  name: `not112-rev-${Math.random()}`,
  runtime: "claude_code",
  deckId: "00000000-0000-4000-a000-000000000112",
});

async function createIssueViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  title: string
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
      acceptanceCriteria: "It works",
    },
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { id: string }).id;
}

async function moveViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  issueId: string,
  to: "top" | "bottom" | { before: string } | { after: string }
) {
  return app.inject({
    method: "POST",
    url: `/api/queue/${issueId}/move`,
    payload: { to },
  });
}

function queuedIds(): string[] {
  return listQueuedEntries().map((e) => e.issueId);
}

test("POST /api/queue/:id/move supports top, bottom, before, and after", async () => {
  const app = await buildApp();
  const a = await createIssueViaApi(app, "A");
  const b = await createIssueViaApi(app, "B");
  const c = await createIssueViaApi(app, "C");
  assert.deepEqual(queuedIds(), [a, b, c]);

  let res = await moveViaApi(app, c, "top");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().issueId, c);
  assert.equal(res.json().position, 1);
  assert.deepEqual(queuedIds(), [c, a, b]);

  res = await moveViaApi(app, c, "bottom");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queuedIds(), [a, b, c]);

  res = await moveViaApi(app, c, { before: a });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queuedIds(), [c, a, b]);

  res = await moveViaApi(app, c, { after: a });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queuedIds(), [a, c, b]);

  await app.close();
});

test("next admission respects the reordered queue", async () => {
  const app = await buildApp();
  const a = await createIssueViaApi(app, "First");
  const b = await createIssueViaApi(app, "Second");
  const c = await createIssueViaApi(app, "Urgent");
  assert.deepEqual(queuedIds(), [a, b, c]);

  const moved = await moveViaApi(app, c, "top");
  assert.equal(moved.statusCode, 200);
  assert.deepEqual(queuedIds(), [c, a, b]);

  const admitted = await admitNext();
  assert.equal(admitted?.issueId, c);
  assert.equal(getIssue(c)!.status, "developing");
  assert.equal(getQueuedEntryForIssue(c), null);
  assert.deepEqual(queuedIds(), [a, b]);

  await app.close();
});

test("moving a missing or admitted entry returns a clear error and leaves order unchanged", async () => {
  const app = await buildApp();
  const a = await createIssueViaApi(app, "A");
  const b = await createIssueViaApi(app, "B");
  const c = await createIssueViaApi(app, "C");
  assert.deepEqual(queuedIds(), [a, b, c]);

  const missing = await moveViaApi(app, "00000000-0000-4000-a000-000000000099", "top");
  assert.equal(missing.statusCode, 404);
  assert.match(String(missing.json().error ?? ""), /not in the queue|not found/i);
  assert.deepEqual(queuedIds(), [a, b, c]);

  markQueueEntryAdmitted(c);
  assert.equal(getQueuedEntryForIssue(c), null);

  const admittedMove = await moveViaApi(app, c, "top");
  assert.ok(admittedMove.statusCode === 404 || admittedMove.statusCode === 409);
  assert.match(String(admittedMove.json().error ?? ""), /not in the queue|admitted/i);
  assert.deepEqual(queuedIds(), [a, b]);

  const relativeGone = await moveViaApi(app, a, { before: c });
  assert.equal(relativeGone.statusCode, 409);
  assert.match(String(relativeGone.json().error ?? ""), /not in the queue|reference/i);
  assert.deepEqual(queuedIds(), [a, b]);

  await app.close();
});
