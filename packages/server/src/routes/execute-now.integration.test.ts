// packages/server/src/routes/execute-now.integration.test.ts
//
// NOT-217 acceptance: strict direct execution bypasses queue order only. Execute now
// admits an eligible issue immediately (queued or not) and refuses — without any
// enqueue, move, or reorder — on capacity, repository, readiness, blocker, health, or
// runtime-cap failure. Concurrent attempts cannot double-start or exceed capacity.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not217-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { getIssue } = await import("../repository/issues.js");
const { listQueuedEntries, getQueuedEntryForIssue } = await import("../repository/queue-entries.js");
const { listWorkflowInstancesForIssue } = await import("../repository/workflow-events.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { recordRuntimeAvailability } = await import("../repository/runtime-availability.js");
const { registerIssueRoutes } = await import("./issues.js");
const { registerQueueRoutes } = await import("./queue.js");
const {
  executeIssueNow,
  queueStatusForIssue,
  setAdmissionHealthCheckerForTests,
  resetCapacityPolicyForTests,
  resetEligibilityRulesForTests,
} = await import("../coordinator/admission.js");
const { setBlockersProviderForTests, resetDependenciesForTests } = await import(
  "../coordinator/dependencies.js"
);

before(() => migrate());

const DEFAULT_BLOCKERS = async (issues: Array<{ externalId: string | null }>) =>
  new Map(issues.map((i) => [i.externalId!, []] as [string, never[]]));

beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM runtime_availability;
    DELETE FROM issues;
  `);
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  setBlockersProviderForTests(DEFAULT_BLOCKERS);
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

const dev = createAgent({
  name: `not217-dev-${Math.random()}`,
  runtime: "claude_code",
  deckId: "00000000-0000-4000-a000-000000002217",
});
const rev = createAgent({
  name: `not217-rev-${Math.random()}`,
  runtime: "codex_local",
  deckId: "00000000-0000-4000-a000-000000002217",
});

type CreateOpts = {
  repo?: string;
  enqueue?: boolean;
  acceptanceCriteria?: string;
  source?: "manual" | "linear";
  externalId?: string;
  developerAgentId?: string;
};

async function createIssueViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  title: string,
  opts: CreateOpts = {}
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: {
      title,
      repo: opts.repo ?? "acme/not217",
      baseBranch: "main",
      developerAgentId: opts.developerAgentId ?? dev.id,
      reviewerAgentId: rev.id,
      ...(opts.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: opts.acceptanceCriteria }
        : { acceptanceCriteria: "It works" }),
      ...(opts.enqueue === false ? { enqueue: false } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.externalId ? { externalId: opts.externalId } : {}),
    },
  });
  assert.equal(res.statusCode, 200, `create ${title}: ${res.body}`);
  return (res.json() as { id: string }).id;
}

function queuedIds(): string[] {
  return listQueuedEntries().map((e) => e.issueId);
}

test("execute now admits an eligible unqueued issue without ever queueing it", async () => {
  const app = await buildApp();
  const id = await createIssueViaApi(app, "Direct", { enqueue: false });
  assert.equal(getQueuedEntryForIssue(id), null);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/execute` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { state: string; workItem: { kind: string } };
  assert.equal(body.state, "admitted");
  assert.equal(body.workItem.kind, "developer");
  assert.equal(getIssue(id)!.status, "developing");
  assert.equal(getQueuedEntryForIssue(id), null, "success on an unqueued issue writes no queue row");
  assert.deepEqual(queuedIds(), []);
  await app.close();
});

test("execute now admits an already-queued issue through the existing start path", async () => {
  const app = await buildApp();
  const id = await createIssueViaApi(app, "Queued direct");
  assert.equal(queueStatusForIssue(id)?.position, 1);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/execute` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { state: string }).state, "admitted");
  assert.equal(getIssue(id)!.status, "developing");
  assert.equal(
    getQueuedEntryForIssue(id),
    null,
    "the queued entry becomes admitted, not removed or left behind"
  );
  await app.close();
});

test("execute now refuses at full capacity and touches neither queue order nor unqueued state", async () => {
  const app = await buildApp();
  // Default persisted limit is 1: one admitted issue fills the system.
  const filler = await createIssueViaApi(app, "Filler", { repo: "acme/filler" });
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${filler}/execute` })).statusCode, 200);

  const q1 = await createIssueViaApi(app, "Q1", { repo: "acme/q1" });
  const q2 = await createIssueViaApi(app, "Q2", { repo: "acme/q2" });
  const draft = await createIssueViaApi(app, "Draft", { repo: "acme/draft", enqueue: false });
  assert.deepEqual(queuedIds(), [q1, q2]);

  // Queued refusal: same position, same order, no workflow, no work items.
  const refused = await app.inject({ method: "POST", url: `/api/issues/${q2}/execute` });
  assert.equal(refused.statusCode, 409, refused.body);
  const qBody = refused.json() as {
    state: string;
    reason: string;
    queued: boolean;
    position: number | null;
  };
  assert.equal(qBody.state, "refused");
  assert.match(qBody.reason, /slot/);
  assert.equal(qBody.queued, true);
  assert.equal(qBody.position, 2);
  assert.deepEqual(queuedIds(), [q1, q2], "a refused execute never reorders");
  assert.equal(queueStatusForIssue(q2)?.position, 2);
  assert.equal(listWorkflowInstancesForIssue(q2).length, 0);
  assert.equal(listWorkItemsForIssue(q2).length, 0);

  // Unqueued refusal: still unqueued, still no workflow.
  const draftRefused = await app.inject({ method: "POST", url: `/api/issues/${draft}/execute` });
  assert.equal(draftRefused.statusCode, 409, draftRefused.body);
  const dBody = draftRefused.json() as { state: string; queued: boolean; position: number | null };
  assert.equal(dBody.state, "refused");
  assert.equal(dBody.queued, false);
  assert.equal(dBody.position, null);
  assert.equal(getQueuedEntryForIssue(draft), null);
  assert.equal(listWorkflowInstancesForIssue(draft).length, 0);
  assert.deepEqual(queuedIds(), [q1, q2]);
  await app.close();
});

test("execute now refuses on an unmet Linear blocker without queue movement", async () => {
  const app = await buildApp();
  try {
    setBlockersProviderForTests(async (issues) => {
      const map = new Map<string, Array<{ id: string; identifier: string; stateName: string; stateType: string }>>();
      for (const i of issues) {
        map.set(i.externalId!, [
          { id: "", identifier: "NOT-999", stateName: "In Progress", stateType: "started" },
        ]);
      }
      return map;
    });
    const first = await createIssueViaApi(app, "First", {
      source: "linear",
      externalId: "NOT-217-A",
    });
    const blocked = await createIssueViaApi(app, "Blocked", {
      source: "linear",
      externalId: "NOT-217-B",
    });
    assert.deepEqual(queuedIds(), [first, blocked]);

    const res = await app.inject({ method: "POST", url: `/api/issues/${blocked}/execute` });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { state: string; reason: string; queued: boolean; position: number | null };
    assert.equal(body.state, "refused");
    assert.match(body.reason, /waiting on NOT-999/);
    assert.equal(body.queued, true);
    assert.equal(body.position, 2);
    assert.deepEqual(queuedIds(), [first, blocked]);
    assert.equal(listWorkflowInstancesForIssue(blocked).length, 0);
  } finally {
    setBlockersProviderForTests(DEFAULT_BLOCKERS);
  }
  await app.close();
});

test("execute now refuses when the same repository already has an active issue", async () => {
  const app = await buildApp();
  const { setMaxActiveIssues } = await import("../repository/admission-settings.js");
  try {
    // Persisted NOT-215 limit 2: global capacity stays free so the per-repository
    // exclusion is the reason under test.
    setMaxActiveIssues(2);
    const active = await createIssueViaApi(app, "Active", { repo: "acme/same-repo" });
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${active}/execute` })).statusCode, 200);

    const clash = await createIssueViaApi(app, "Clash", { repo: "acme/same-repo", enqueue: false });
    const res = await app.inject({ method: "POST", url: `/api/issues/${clash}/execute` });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json() as { state: string; reason: string; queued: boolean };
    assert.equal(body.state, "refused");
    assert.match(body.reason, /repository slot/);
    assert.equal(body.queued, false);
    assert.equal(getQueuedEntryForIssue(clash), null, "a refused execute never enqueues");
    assert.equal(listWorkflowInstancesForIssue(clash).length, 0);

    // A different repository still admits under the same free global slot.
    const other = await createIssueViaApi(app, "Other repo", { repo: "acme/other-repo", enqueue: false });
    const otherRes = await app.inject({ method: "POST", url: `/api/issues/${other}/execute` });
    assert.equal(otherRes.statusCode, 200, otherRes.body);
  } finally {
    setMaxActiveIssues(1);
  }
  await app.close();
});

test("execute now refuses on unhealthy developer, capped runtime, and missing readiness", async () => {
  const app = await buildApp();
  try {
    // Unhealthy developer.
    setAdmissionHealthCheckerForTests(async (agent, role) =>
      role === "developer" && agent.id === dev.id
        ? { ok: false, reason: `developer unhealthy: ${agent.name} — CLI missing` }
        : { ok: true }
    );
    const sick = await createIssueViaApi(app, "Sick dev", { enqueue: false });
    const sickRes = await app.inject({ method: "POST", url: `/api/issues/${sick}/execute` });
    assert.equal(sickRes.statusCode, 409, sickRes.body);
    assert.match(String((sickRes.json() as { reason: string }).reason), /developer unhealthy/);
    assert.equal(getQueuedEntryForIssue(sick), null);
    assert.equal(listWorkflowInstancesForIssue(sick).length, 0);
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));

    // Capped runtime (durable usage-cap observation, same rule ordinary admission reads).
    recordRuntimeAvailability({
      runtime: "claude_code",
      unavailableUntil: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "usage cap observed in test",
    });
    const capped = await createIssueViaApi(app, "Capped runtime", { enqueue: false });
    const cappedRes = await app.inject({ method: "POST", url: `/api/issues/${capped}/execute` });
    assert.equal(cappedRes.statusCode, 409, cappedRes.body);
    assert.match(String((cappedRes.json() as { reason: string }).reason), /runtime capped/);
    assert.equal(getQueuedEntryForIssue(capped), null);
    assert.equal(listWorkflowInstancesForIssue(capped).length, 0);
    getDb().exec("DELETE FROM runtime_availability");

    // Missing acceptance criteria — and no pre-start gate opened as a side effect.
    const bare = await createIssueViaApi(app, "Bare", {
      enqueue: false,
      acceptanceCriteria: "",
    });
    const bareRes = await app.inject({ method: "POST", url: `/api/issues/${bare}/execute` });
    assert.equal(bareRes.statusCode, 409, bareRes.body);
    assert.match(String((bareRes.json() as { reason: string }).reason), /acceptance criteria/);
    assert.equal(getQueuedEntryForIssue(bare), null);
    assert.equal(listWorkflowInstancesForIssue(bare).length, 0);
    assert.equal(
      listHumanActionsForIssue(bare).length,
      0,
      "a refused execute never opens a product_scope_decision"
    );
  } finally {
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
    getDb().exec("DELETE FROM runtime_availability");
  }
  await app.close();
});

test("two concurrent execute-now requests admit exactly once and never exceed capacity", async () => {
  const app = await buildApp();
  const id = await createIssueViaApi(app, "Raced", { enqueue: false });

  const [first, second] = await Promise.all([executeIssueNow(id), executeIssueNow(id)]);
  const admitted = [first, second].filter((r) => r.state === "admitted");
  const notAdmitted = [first, second].filter((r) => r.state !== "admitted");
  assert.equal(admitted.length, 1, "exactly one attempt wins");
  assert.equal(notAdmitted.length, 1);
  assert.ok(
    notAdmitted[0]!.state === "refused" || (notAdmitted[0]!.state === "error" && notAdmitted[0].code === 409),
    `loser fails closed, got ${JSON.stringify(notAdmitted[0])}`
  );
  assert.equal(listWorkflowInstancesForIssue(id).length, 1, "no double start");
  assert.equal(
    listWorkItemsForIssue(id).filter((w) => w.kind === "developer").length,
    1,
    "exactly one round-1 developer item"
  );
  assert.equal(getIssue(id)!.status, "developing");
  await app.close();
});

test("run next stays backward compatible: start moves to front and queues with a reason when full", async () => {
  const app = await buildApp();
  const filler = await createIssueViaApi(app, "Filler", { repo: "acme/filler" });
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${filler}/execute` })).statusCode, 200);

  const q1 = await createIssueViaApi(app, "Q1", { repo: "acme/q1" });
  const q2 = await createIssueViaApi(app, "Q2", { repo: "acme/q2" });
  assert.deepEqual(queuedIds(), [q1, q2]);

  // Start (Run next): moves to position 1 and waits with the exact reason.
  const started = await app.inject({ method: "POST", url: `/api/issues/${q2}/start` });
  assert.equal(started.statusCode, 200, started.body);
  const startedBody = started.json() as { state: string; position: number; waitReason: string | null };
  assert.equal(startedBody.state, "queued");
  assert.equal(startedBody.position, 1);
  assert.match(startedBody.waitReason ?? "", /slot/);
  assert.deepEqual(queuedIds(), [q2, q1]);

  // Execute now on the same full system: refuses, and the order it found is the order left.
  const refused = await app.inject({ method: "POST", url: `/api/issues/${q1}/execute` });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal((refused.json() as { state: string }).state, "refused");
  assert.deepEqual(queuedIds(), [q2, q1]);
  await app.close();
});

test("execute now 404s for an unknown issue and 409s for a non-startable one", async () => {
  const app = await buildApp();
  const missing = await app.inject({
    method: "POST",
    url: "/api/issues/00000000-0000-4000-a000-000000009999/execute",
  });
  assert.equal(missing.statusCode, 404);

  const id = await createIssueViaApi(app, "Will close");
  getDb().prepare("UPDATE issues SET status = 'closed' WHERE id = ?").run(id);
  const closed = await app.inject({ method: "POST", url: `/api/issues/${id}/execute` });
  assert.equal(closed.statusCode, 409);
  assert.match(String((closed.json() as { error: string }).error), /not startable/);
  await app.close();
});
