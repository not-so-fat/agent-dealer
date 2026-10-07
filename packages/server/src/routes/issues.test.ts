// packages/server/src/routes/issues.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

function tmpTraceFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-trace-"));
  const file = path.join(dir, "session.ndjson");
  fs.writeFileSync(file, content);
  return file;
}

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-routes-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CODEX_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { transitionIssue, listIssuesByExternalId, getIssue } = await import("../repository/issues.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { claimWorkItem, cancelWorkItem } = await import("../repository/work-items.js");
const { randomUUID } = await import("node:crypto");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { applyCompletion, resolveHumanActionAndAdvance, getTaskSnapshot, startWorkflow } = await import("../coordinator/commands.js");
const { ReviewerResult } = await import("../coordinator/reviewer-result.js");
const { getQueuedEntryForIssue, listQueuedEntries } = await import("../repository/queue-entries.js");
const { admitNext, setAdmissionHealthCheckerForTests, queueStatusForIssue } = await import(
  "../coordinator/admission.js"
);
const { listWorkflowInstancesForIssue } = await import("../repository/workflow-events.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { createWorkerSession, listWorkerSessionsForIssue, startSession } = await import("../repository/worker-sessions.js");
const { createAgent } = await import("../repository/agents.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");

before(() => {
  migrate();
  // Admission runs a real CLI/deck/gh health probe per agent — these route tests assert
  // routing and response shape, not agent health.
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
});

after(() => setAdmissionHealthCheckerForTests(null));

// Start is admission-gated (NOT-118) and capacity is sequential, so a `developing` issue
// left behind by an earlier test would queue every later start instead of admitting it.
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
    payload: { title: "Fix login bug", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID }});
  assert.equal(createRes.statusCode, 200);
  const created = createRes.json() as { id: string; status: string };
  assert.equal(created.status, "ready");
  // NOT-118: create enqueues for admission instead of starting.
  assert.equal(getQueuedEntryForIssue(created.id)?.state, "queued");

  const listRes = await app.inject({ method: "GET", url: "/api/issues" });
  const list = listRes.json() as Array<{ id: string }>;
  assert.ok(list.some((i) => i.id === created.id));
  await app.close();
});

test("POST /api/issues rejects a local filesystem path as repo (NOT-149)", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: {
      title: "Local path",
      repo: "/repo",
      baseBranch: "main",
      developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
      reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("NOT-118: POST /api/issues with enqueue:false creates a draft that is not queued", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Draft only",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
        enqueue: false}})
  ).json() as { id: string; status: string };
  assert.equal(created.status, "ready");
  assert.equal(getQueuedEntryForIssue(created.id), null);
  assert.equal(listQueuedEntries().length, 0);
  await app.close();
});

test("POST /api/issues matches a live (source, externalId) instead of duplicating it, and reports the queue it did not change", async () => {
  const app = await buildApp();
  const payload = { title: "Linear task", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, source: "linear", externalId: "LIN-1" };
  const first = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string; created: boolean; queue: string };
  assert.equal(first.created, true);
  assert.equal(first.queue, "enqueued");
  const entryBefore = getQueuedEntryForIssue(first.id)!;

  const secondRes = await app.inject({ method: "POST", url: "/api/issues", payload });
  assert.equal(secondRes.statusCode, 200);
  const second = secondRes.json() as { id: string; created: boolean; queue: string };
  assert.equal(second.id, first.id);
  // NOT-141: the caller can tell nothing new was created — and, because the issue was
  // already waiting, that this request did not queue anything either.
  assert.equal(second.created, false);
  assert.equal(second.queue, "already_queued");
  assert.deepEqual(getQueuedEntryForIssue(first.id), entryBefore, "the queue entry is untouched");
  assert.equal(listIssuesByExternalId("linear", "LIN-1").length, 1);
  await app.close();
});

test("NOT-141: re-importing a ticket whose only issue is terminal creates a new, queued issue", async () => {
  const app = await buildApp();
  const payload = { title: "Second pass", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, source: "linear", externalId: "LIN-CLOSED" };
  const first = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string };
  transitionIssue(first.id, "closed");

  const secondRes = await app.inject({ method: "POST", url: "/api/issues", payload });
  assert.equal(secondRes.statusCode, 200);
  const second = secondRes.json() as { id: string; status: string; created: boolean; queue: string; priorPasses: number };
  assert.notEqual(second.id, first.id, "a terminal row must not block a second pass");
  assert.equal(second.created, true);
  assert.equal(second.queue, "enqueued");
  assert.equal(second.priorPasses, 1, "the caller is told this is a second pass, not a first import");
  assert.equal(second.status, "ready");
  assert.equal(getQueuedEntryForIssue(second.id)?.state, "queued");
  // Both rows keep the same external id — (source, external_id) stays non-unique.
  const rows = listIssuesByExternalId("linear", "LIN-CLOSED");
  assert.deepEqual(rows.map((i) => i.status).sort(), ["closed", "ready"]);
  await app.close();
});

test("NOT-141: re-importing a ticket that is mid-flight answers 409 with the issue that holds it", async () => {
  const app = await buildApp();
  const payload = { title: "In flight", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, source: "linear", externalId: "LIN-LIVE" };
  const first = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string };
  transitionIssue(first.id, "developing");
  const queuedBefore = listQueuedEntries().map((e) => e.issueId);

  const conflict = await app.inject({ method: "POST", url: "/api/issues", payload });
  assert.equal(conflict.statusCode, 409);
  const body = conflict.json() as { error: string; existingIssueId: string; existingIssueStatus: string };
  assert.equal(body.existingIssueId, first.id);
  assert.equal(body.existingIssueStatus, "developing");
  assert.match(body.error, /already tracking/);
  // Still one row, and the queue is exactly as it was — no entry invented for a second pass.
  assert.equal(listIssuesByExternalId("linear", "LIN-LIVE").length, 1);
  assert.deepEqual(listQueuedEntries().map((e) => e.issueId), queuedBefore);
  await app.close();
});

test("GET /api/issues/:id returns header, timeline, actions, findings, usage, readiness, metrics", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Detail issue", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    issue: { id: string };
    timeline: unknown[];
    humanActions: unknown[];
    findings: unknown[];
    usageSummary: unknown;
    readiness: { ok: boolean; missing: string[] };
    humanWaitMs: number;
    interventionCount: number;
    latestWorkflowInstance: unknown;
  };
  assert.equal(body.issue.id, created.id);
  assert.ok(Array.isArray(body.timeline));
  assert.ok(Array.isArray(body.humanActions));
  assert.ok(Array.isArray(body.findings));
  assert.ok(body.usageSummary);
  // No acceptanceCriteria was given at create time — not startable yet.
  assert.equal(body.readiness.ok, false);
  assert.ok(body.readiness.missing.includes("acceptance criteria"));
  assert.equal(body.humanWaitMs, 0);
  assert.equal(body.interventionCount, 0);
  assert.equal(body.latestWorkflowInstance, null);
  await app.close();
});

test("PATCH /api/issues/:id updates editable fields and satisfies the readiness gate", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Underspecified", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { acceptanceCriteria: "It compiles and tests pass" }});
  assert.equal(patchRes.statusCode, 200);
  const patched = patchRes.json() as { acceptanceCriteria: string | null };
  assert.equal(patched.acceptanceCriteria, "It compiles and tests pass");

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    readiness: { ok: boolean };
  };
  assert.equal(detail.readiness.ok, true);
  await app.close();
});

test("PATCH /api/issues/:id rejects an edit while a workflow is active", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Active workflow",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "Ready to go"}})
  ).json() as { id: string };
  const startRes = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(startRes.statusCode, 200);

  const patchRes = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload: { title: "Renamed" } });
  assert.equal(patchRes.statusCode, 409);
  await app.close();
});

test("PATCH /api/issues/:id rejects an edit to a terminal (done) issue even though it has no active workflow", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Completed issue",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "Ready to go"}})
  ).json() as { id: string };
  // Drive it to a terminal status directly — a `done` issue has no active workflow
  // instance either, which is exactly the gap: "no active instance" alone must not be
  // read as "editable."
  transitionIssue(created.id, "developing");
  transitionIssue(created.id, "reviewing");
  transitionIssue(created.id, "final_review");
  transitionIssue(created.id, "done");

  const patchRes = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload: { title: "Renamed" } });
  assert.equal(patchRes.statusCode, 409);
  await app.close();
});

test("NOT-185: PATCH /api/issues/:id succeeds while parked at attempts_exhausted, and retry re-freezes the snapshot", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Parked",
        description: "old",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        maxReviewRounds: 1,
        acceptanceCriteria: "Old criteria"}})
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` })).statusCode, 200);

  const complete = async (outcome: Parameters<typeof applyCompletion>[2]) => {
    const item = claimWorkItem("route-test", { leaseMs: 60_000 })!;
    await applyCompletion(item.id, item.leaseToken!, outcome);
  };
  const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload });

  // Developer work item pending → still 409.
  assert.equal((await patch({ title: "Nope" })).statusCode, 409);

  await complete({ kind: "clean_handoff", branch: "b", headSha: "abc", baseSha: "base", prNumber: 1, prUrl: "https://gh/pr/1" });
  // Reviewer work item pending → still 409.
  assert.equal((await patch({ title: "Nope" })).statusCode, 409);
  await complete({
    kind: "verdict",
    result: ReviewerResult.parse({
      verdict: "changes_requested",
      baseSha: "b",
      headSha: "h",
      acceptanceCriteriaAssessment: "ok",
      evidenceAssessment: "ok",
      findings: [],
      risks: []})});

  // Non-task, non-agent fields stay frozen at the park — notably the review budget
  // (a non-goal). Agent profiles are swappable at the park (NOT-358, covered below),
  // so they are no longer in this blocked list.
  for (const payload of [
    { maxReviewRounds: 5 },
    { maxInfraAttempts: 3 },
    { repo: "acme/other" },
    { baseBranch: "develop" },
    { autoMerge: true },
    { title: "Mixed", maxReviewRounds: 5 },
  ]) {
    assert.equal((await patch(payload)).statusCode, 409, JSON.stringify(payload));
  }
  const untouched = getIssue(created.id)!;
  assert.equal(untouched.maxReviewRounds, 1);
  assert.equal(untouched.title, "Parked");

  const parked = await patch({ description: "new", acceptanceCriteria: "New criteria" });
  assert.equal(parked.statusCode, 200);
  assert.equal((parked.json() as { acceptanceCriteria: string }).acceptanceCriteria, "New criteria");

  const action = listHumanActionsForIssue(created.id).find((a) => a.actionType === "attempts_exhausted")!;
  assert.equal(resolveHumanActionAndAdvance(action.id, "yusuke", "retry").ok, true);
  const frozen = getTaskSnapshot(getIssue(created.id)!);
  assert.equal(frozen.acceptanceCriteria, "New criteria");
  assert.equal(frozen.description, "new");

  // The retry round is queued → running again → 409 again.
  assert.equal((await patch({ title: "Nope" })).statusCode, 409);
  await app.close();
});

test("POST /api/issues/:id/start with acceptance criteria starts the workflow", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Startable",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works"}})
  ).json() as { id: string };

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { state: string; instance: { id: string }; workItem: { id: string; kind: string } };
  assert.equal(body.state, "admitted");
  assert.ok(body.instance.id);
  assert.equal(body.workItem.kind, "developer");

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    issue: { status: string };
  };
  assert.equal(detail.issue.status, "developing");
  await app.close();
});

test("NOT-118: POST /api/issues/:id/start without acceptance criteria queues it with a wait reason, no product_scope_decision", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Underspecified start", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { state: string; position: number; waitReason: string | null };
  assert.equal(body.state, "queued");
  assert.equal(body.position, 1);
  assert.match(body.waitReason ?? "", /acceptance criteria/i);

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    issue: { status: string };
    humanActions: Array<{ actionType: string }>;
    queued: boolean;
    queueEntry: { position: number; waitReason: string | null } | null;
  };
  assert.equal(detail.issue.status, "ready");
  assert.equal(detail.humanActions.length, 0);
  assert.equal(detail.queued, true);
  assert.equal(detail.queueEntry?.position, 1);
  assert.match(detail.queueEntry?.waitReason ?? "", /acceptance criteria/i);
  await app.close();
});

test("POST /api/issues/:id/start 404s for an unknown id", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/api/issues/does-not-exist/start" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /api/issues/:id 404s for an unknown id", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/issues/does-not-exist" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /api/issues/:id/artifacts/:artifactId/trace serves the artifact's raw log file", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Traceable", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const logPath = tmpTraceFile('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
  const artifact = createIssueArtifact({ issueId: created.id, kind: "developer_transcript", author: "system", blobPath: logPath });

  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}/artifacts/${artifact.id}/trace` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { content: string; path: string; kind: string };
  assert.match(body.content, /hello/);
  assert.equal(body.path, logPath);
  assert.equal(body.kind, "developer_transcript");
  await app.close();
});

test("GET /api/issues/:id/artifacts/:artifactId/trace ignores a non-numeric max instead of returning the whole file", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Huge trace", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  // Reproduces the exact repro from review: a file well over the 200,000-char hard cap.
  const logPath = tmpTraceFile("x".repeat(250_001));
  const artifact = createIssueArtifact({ issueId: created.id, kind: "developer_transcript", author: "system", blobPath: logPath });

  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}/artifacts/${artifact.id}/trace?max=not-a-number` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { content: string };
  // Falls back to the default (50,000), not NaN-collapsing to the entire 250,001-char file.
  assert.equal(body.content.length, 50_000);
  await app.close();
});

test("GET /api/issues/:id/artifacts/:artifactId/trace clamps a negative max to the default and an oversized max to the hard cap", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Bounds", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const logPath = tmpTraceFile("y".repeat(250_001));
  const artifact = createIssueArtifact({ issueId: created.id, kind: "developer_transcript", author: "system", blobPath: logPath });

  const negative = await app.inject({ method: "GET", url: `/api/issues/${created.id}/artifacts/${artifact.id}/trace?max=-5` });
  assert.equal((negative.json() as { content: string }).content.length, 50_000);

  const oversized = await app.inject({ method: "GET", url: `/api/issues/${created.id}/artifacts/${artifact.id}/trace?max=999999999` });
  assert.equal((oversized.json() as { content: string }).content.length, 200_000);
  await app.close();
});

test("GET /api/issues/:id/artifacts/:artifactId/trace returns the actual tail, not zeroed/garbage bytes, for a large file", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Tail correctness", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const logPath = tmpTraceFile(`${"z".repeat(300_000)}END-OF-TRACE`);
  const artifact = createIssueArtifact({ issueId: created.id, kind: "developer_transcript", author: "system", blobPath: logPath });

  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}/artifacts/${artifact.id}/trace?max=100` });
  const body = res.json() as { content: string };
  assert.equal(body.content, `${"z".repeat(88)}END-OF-TRACE`);
  await app.close();
});

test("GET /api/issues/:id/artifacts/:artifactId/trace 404s for an artifact with no raw trace", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "No trace", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const artifact = createIssueArtifact({ issueId: created.id, kind: "implementation_conclusion", author: "agent", content: { text: "done" } });

  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}/artifacts/${artifact.id}/trace` });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /api/issues/:id/artifacts/:artifactId/trace 404s when the artifact belongs to a different issue", async () => {
  const app = await buildApp();
  const issueA = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "A", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const issueB = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "B", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const logPath = tmpTraceFile("secret");
  const artifact = createIssueArtifact({ issueId: issueA.id, kind: "developer_transcript", author: "system", blobPath: logPath });

  const res = await app.inject({ method: "GET", url: `/api/issues/${issueB.id}/artifacts/${artifact.id}/trace` });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST /api/issues/:id/guidance appends a guidance.added event", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Guide me", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/guidance`, payload: { markdown: "please prioritize this" } });
  assert.equal(res.statusCode, 200);
  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as { timeline: Array<{ type: string }> };
  assert.ok(detail.timeline.some((e) => e.type === "guidance.added"));
  await app.close();
});

test("POST /api/issues/:id/abort 404s for an unknown issue", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/api/issues/does-not-exist/abort" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST /api/issues/:id/abort closes a fresh issue and is idempotent on repeat", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Abort me", repo: "acme/app", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };

  const first = await app.inject({ method: "POST", url: `/api/issues/${created.id}/abort`, payload: { resolvedBy: "yusuke" } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { issueStatus: "closed", alreadyClosed: false });

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    issue: { status: string };
    timeline: Array<{ type: string }>;
  };
  assert.equal(detail.issue.status, "closed");
  assert.equal(detail.timeline.filter((e) => e.type === "issue.closed").length, 1);

  const second = await app.inject({ method: "POST", url: `/api/issues/${created.id}/abort` });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), { issueStatus: "closed", alreadyClosed: true });
  const detailAfter = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    timeline: Array<{ type: string }>;
  };
  assert.equal(detailAfter.timeline.filter((e) => e.type === "issue.closed").length, 1, "a repeated abort must not append another event");
  await app.close();
});

test("GET /api/issues/:id surfaces latestSessionFailure from worker.failed reason (NOT-113)", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Failure strip",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID}})
  ).json() as { id: string };

  const { startWorkflowInstance, appendWorkflowEvent } = await import("../repository/workflow-events.js");
  const { createWorkerSession, startSession, completeSession } = await import("../repository/worker-sessions.js");
  const instance = startWorkflowInstance(created.id, "dev_reviewer_v1");
  const session = createWorkerSession({
    issueId: created.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "cursor_local"});
  startSession(session.id);
  completeSession(session.id, {
    status: "failed",
    errorJson: JSON.stringify({ reason: "recovered — worker process presumed dead" }),
    logPath: "/tmp/dealer-session.log"});
  appendWorkflowEvent({
    issueId: created.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.failed",
    actorType: "developer",
    stage: "developing",
    round: 1,
    payload: {
      runtime: "cursor_local",
      model: null,
      sessionId: session.id,
      outcome: "session_failed",
      reason: "recovered — worker process presumed dead"}});

  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    latestSessionFailure: {
      reason: string;
      logPath: string | null;
      infraAttempts: number;
      maxInfraAttempts: number;
    } | null;
  };
  assert.ok(body.latestSessionFailure);
  assert.match(body.latestSessionFailure!.reason, /presumed dead/);
  assert.equal(body.latestSessionFailure!.logPath, "/tmp/dealer-session.log");
  assert.equal(typeof body.latestSessionFailure!.infraAttempts, "number");

  // A later worker.completed supersedes the failure strip (stale-failure-strip).
  appendWorkflowEvent({
    issueId: created.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.completed",
    actorType: "developer",
    stage: "reviewing",
    round: 1,
    payload: { outcome: "clean_handoff" }});
  const afterOk = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(afterOk.statusCode, 200);
  assert.equal((afterOk.json() as { latestSessionFailure: unknown }).latestSessionFailure, null);

  await app.close();
});

test("NOT-148: GET /api/issues/:id surfaces branchTipStatus with restart risk after empty-tip infra failure", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Restart risk strip",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID}})
  ).json() as { id: string };

  const { incrementIssueInfraAttempts } = await import("../repository/issues.js");
  transitionIssue(created.id, "developing");
  incrementIssueInfraAttempts(created.id);

  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    branchTipStatus: {
      tipLabel: string;
      commitsAhead: number | null;
      restartRisk: boolean;
      branch: string;
      worktree: { path: string; dirty: boolean; preserved: boolean } | null;
    } | null;
  };
  assert.ok(body.branchTipStatus);
  // No managed clone for the synthetic repo → unknown tip (not a false "no tip yet").
  assert.equal(body.branchTipStatus!.tipLabel, "unknown");
  assert.equal(body.branchTipStatus!.commitsAhead, null);
  assert.equal(body.branchTipStatus!.restartRisk, true);
  assert.equal(body.branchTipStatus!.worktree, null);
  assert.match(body.branchTipStatus!.branch, new RegExp(`issue-${created.id}`));

  // A fresh ready issue omits the tip strip payload.
  const readyCreated = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Idle tip omit",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID}})
  ).json() as { id: string };
  const idle = await app.inject({ method: "GET", url: `/api/issues/${readyCreated.id}` });
  assert.equal((idle.json() as { branchTipStatus: unknown }).branchTipStatus, null);

  await app.close();
});

// NOT-228: helpers + focused tests for Issues list filtering/pagination. Every
// test wipes `issues` in beforeEach, so the `R228` title marker scopes each
// cohort without cross-test interference.
const R228_PAYLOAD = {
  repo: "acme/app",
  baseBranch: "main",
  developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
  reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
};

async function r228Seed(app: Awaited<ReturnType<typeof buildApp>>, title: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { ...R228_PAYLOAD, ...extra, title },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as { id: string };
}

interface R228Page {
  issues: Array<{ id: string; title: string; status: string; hasOpenHumanAction: boolean }>;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

async function r228Get(app: Awaited<ReturnType<typeof buildApp>>, qs: string) {
  const res = await app.inject({ method: "GET", url: `/api/issues${qs}` });
  assert.equal(res.statusCode, 200);
  return res.json() as R228Page;
}

test("NOT-228: omitting page/limit keeps the legacy unpaginated array (CLI contract)", async () => {
  const app = await buildApp();
  const created = await r228Seed(app, "R228 legacy contract");
  for (const url of ["/api/issues", "/api/issues?status=ready", "/api/issues?q=R228&repo=github.com%2Facme%2Fapp"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200);
    const body = res.json() as unknown;
    assert.ok(Array.isArray(body), `${url} still answers an array`);
    assert.ok((body as Array<{ id: string }>).some((i) => i.id === created.id));
  }
  await app.close();
});

test("NOT-217: PATCH agent assignments on a queued issue preserves position, refreshes the wait reason, and records issue.reassigned", async () => {
  const app = await buildApp();
  try {
    // Only the builtin Claude developer is unhealthy — everything else admits.
    setAdmissionHealthCheckerForTests(async (agent, role) =>
      role === "developer" && agent.id === BUILTIN_AGENT_CLAUDE_ID
        ? { ok: false, reason: `developer unhealthy: ${agent.name} — CLI missing` }
        : { ok: true }
    );
    const mk = async (title: string): Promise<string> =>
      (
        (
          await app.inject({
            method: "POST",
            url: "/api/issues",
            payload: {
              title,
              repo: "acme/app",
              baseBranch: "main",
              developerAgentId: BUILTIN_AGENT_CURSOR_ID,
              reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
              acceptanceCriteria: "It works",
            },
          })
        ).json() as { id: string }
      ).id;
    const a = await mk("Queued A");
    const b = await mk("Queued B");
    assert.equal(queueStatusForIssue(a)?.position, 1);
    assert.equal(queueStatusForIssue(b)?.position, 2);

    // Switch A onto the capped/unhealthy developer: same position, new wait reason, audit.
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/issues/${a}`,
      payload: { developerAgentId: BUILTIN_AGENT_CLAUDE_ID },
    });
    assert.equal(bad.statusCode, 200);
    assert.equal((bad.json() as { developerAgentId: string }).developerAgentId, BUILTIN_AGENT_CLAUDE_ID);
    assert.deepEqual(
      listQueuedEntries().map((e) => e.issueId),
      [a, b],
      "reassignment must not reorder the queue"
    );
    assert.equal(queueStatusForIssue(a)?.position, 1);
    assert.match(queueStatusForIssue(a)?.waitReason ?? "", /developer unhealthy/);

    const events = listWorkflowEventsForIssue(a).filter((e) => e.type === "issue.reassigned");
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0]!.payloadJson!), {
      fromRepo: "github.com/acme/app",
      toRepo: "github.com/acme/app",
      fromDeveloperAgentId: BUILTIN_AGENT_CURSOR_ID,
      toDeveloperAgentId: BUILTIN_AGENT_CLAUDE_ID,
      fromReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
      toReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    });

    // Switch back to the healthy developer: position unchanged, wait reason clears.
    const good = await app.inject({
      method: "PATCH",
      url: `/api/issues/${a}`,
      payload: { developerAgentId: BUILTIN_AGENT_CURSOR_ID },
    });
    assert.equal(good.statusCode, 200);
    assert.deepEqual(
      listQueuedEntries().map((e) => e.issueId),
      [a, b]
    );
    assert.equal(queueStatusForIssue(a)?.position, 1);
    assert.equal(queueStatusForIssue(a)?.waitReason, null);
    assert.equal(
      listWorkflowEventsForIssue(a).filter((e) => e.type === "issue.reassigned").length,
      2,
      "each assignment change is its own audit event"
    );
  } finally {
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  }
  await app.close();
});

test("NOT-228: page/limit paginate with a default of 25 and totals for the full cohort", async () => {
  const app = await buildApp();
  for (let n = 0; n < 30; n++) await r228Seed(app, `R228 pageable ${n}`);
  const q = encodeURIComponent("R228 pageable");
  const first = await r228Get(app, `?q=${q}&limit=25`);
  assert.equal(first.issues.length, 25);
  assert.equal(first.page, 1);
  assert.equal(first.limit, 25);
  assert.equal(first.total, 30);
  assert.equal(first.totalPages, 2);
  const second = await r228Get(app, `?q=${q}&limit=25&page=2`);
  assert.equal(second.issues.length, 5);
  assert.equal(second.total, 30);
  assert.deepEqual(
    new Set([...first.issues, ...second.issues].map((i) => i.id)).size,
    30,
    "pages neither duplicate nor skip rows"
  );
  // `page` alone still paginates (default limit); `limit` alone starts at page 1.
  const defaulted = await r228Get(app, `?q=${q}&page=2`);
  assert.equal(defaulted.limit, 25);
  assert.equal(defaulted.issues.length, 5);
  await app.close();
});

test("NOT-228: search, status, repo, and attention filters apply before pagination", async () => {
  const app = await buildApp();
  const repo = "github.com/r228/filtered";
  const keep = await r228Seed(app, "R228 filter keep me", { repo });
  const moved = await r228Seed(app, "R228 filter moved on", { repo });
  await r228Seed(app, "R228 filter other repo", { repo: "github.com/r228/elsewhere" });
  transitionIssue(moved.id, "developing");
  createHumanAction({
    issueId: moved.id,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete"],
  });
  const q = encodeURIComponent("R228 filter");
  const byStatus = await r228Get(app, `?q=${q}&status=developing&page=1&limit=10`);
  assert.equal(byStatus.total, 1);
  assert.deepEqual(byStatus.issues.map((i) => i.id), [moved.id]);
  const byRepo = await r228Get(app, `?q=${q}&repo=${encodeURIComponent(repo)}&page=1&limit=10`);
  assert.equal(byRepo.total, 2);
  const attention = await r228Get(app, `?q=${q}&needsAttention=1&page=1&limit=10`);
  assert.equal(attention.total, 1);
  assert.deepEqual(attention.issues.map((i) => i.id), [moved.id]);
  assert.equal(attention.issues[0]!.hasOpenHumanAction, true);
  // Search matches the external label, not just the title: no "R228 filter"
  // title contains "not-228", so only the labeled row matches.
  const labeled = await r228Seed(app, "R228 filter label-only title", {
    source: "linear",
    externalId: "R228-LBL-1",
    externalLabel: "NOT-228",
  });
  const byLabel = await r228Get(app, `?q=${encodeURIComponent("not-228")}&page=1&limit=10`);
  assert.equal(byLabel.total, 1);
  assert.deepEqual(byLabel.issues.map((i) => i.id), [labeled.id]);
  void keep;
  await app.close();
});

test("NOT-228: limit clamps to 100 and out-of-range pages keep totals", async () => {
  const app = await buildApp();
  await r228Seed(app, "R228 bounds one");
  const capped = await r228Get(app, `?q=${encodeURIComponent("R228 bounds")}&page=1&limit=500`);
  assert.equal(capped.limit, 100);
  assert.equal(capped.total, 1);
  const pastEnd = await r228Get(app, `?q=${encodeURIComponent("R228 bounds")}&page=9&limit=10`);
  assert.deepEqual(pastEnd.issues, []);
  assert.equal(pastEnd.total, 1);
  assert.equal(pastEnd.page, 9);
  await app.close();
});

test("NOT-217: PATCH reviewer-only edit records before/after reviewers without touching the developer", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Reviewer swap",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CURSOR_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };

  const res = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { reviewerAgentId: BUILTIN_AGENT_CLAUDE_ID },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { developerAgentId: string; reviewerAgentId: string };
  assert.equal(body.developerAgentId, BUILTIN_AGENT_CURSOR_ID);
  assert.equal(body.reviewerAgentId, BUILTIN_AGENT_CLAUDE_ID);

  const events = listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned");
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.payloadJson!), {
    fromRepo: "github.com/acme/app",
    toRepo: "github.com/acme/app",
    fromDeveloperAgentId: BUILTIN_AGENT_CURSOR_ID,
    toDeveloperAgentId: BUILTIN_AGENT_CURSOR_ID,
    fromReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    toReviewerAgentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  // No-op rewrites (same assignment) emit no audit event.
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload: { reviewerAgentId: BUILTIN_AGENT_CLAUDE_ID } })).statusCode,
    200
  );
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    1
  );
  await app.close();
});

test("NOT-217: PATCH title-only edit on a queued issue emits no reassignment event", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Title tweak",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CURSOR_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };

  const res = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { title: "Title tweaked" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    0
  );
  await app.close();
});

test("NOT-217: PATCH that races admission answers 409 and never mutates the frozen workflow snapshot", async () => {
  const app = await buildApp();
  const healthyDev = createAgent({
    name: `not217-dev-${Math.random()}`,
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000002217",
  });
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Raced edit",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CURSOR_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  // The editor is open; another request admits the issue first.
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` })).statusCode, 200);
  assert.equal(getQueuedEntryForIssue(created.id), null);

  // Save now conflicts instead of displaying stale success.
  const save = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { developerAgentId: healthyDev.id, reviewerAgentId: healthyDev.id },
  });
  assert.equal(save.statusCode, 409);
  // Admitted issues read as their live status; parked-needs_human ones name the workflow.
  // Either way the save conflicts instead of displaying stale success.
  assert.match(String((save.json() as { error: string }).error), /developing|active workflow/);

  const issue = getIssue(created.id)!;
  assert.equal(issue.developerAgentId, BUILTIN_AGENT_CURSOR_ID, "frozen assignment untouched");
  assert.equal(issue.reviewerAgentId, BUILTIN_AGENT_CURSOR_ID, "frozen assignment untouched");
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    0,
    "a conflicted edit leaves no audit event"
  );
  await app.close();
});

test("NOT-240: PATCH repository plus agents on an unqueued ready issue succeeds, stays unqueued, and audits before/after", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Unqueued reconfig",
        repo: "acme/old-repo",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CURSOR_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
        enqueue: false,
      },
    })
  ).json() as { id: string };
  assert.equal(getQueuedEntryForIssue(created.id), null);

  const res = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: {
      repo: "https://github.com/acme/new-repo.git",
      developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
      reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { repo: string; developerAgentId: string; reviewerAgentId: string };
  assert.equal(body.repo, "github.com/acme/new-repo", "repo is normalized like issue creation");
  assert.equal(body.developerAgentId, BUILTIN_AGENT_CLAUDE_ID);
  assert.equal(body.reviewerAgentId, BUILTIN_AGENT_CURSOR_ID);
  assert.equal(getQueuedEntryForIssue(created.id), null, "an unqueued save stays unqueued");

  const events = listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned");
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.payloadJson!), {
    fromRepo: "github.com/acme/old-repo",
    toRepo: "github.com/acme/new-repo",
    fromDeveloperAgentId: BUILTIN_AGENT_CURSOR_ID,
    toDeveloperAgentId: BUILTIN_AGENT_CLAUDE_ID,
    fromReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    toReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
  });
  await app.close();
});

test("NOT-371: PATCH repository onto an active sibling's repo keeps position with no repository wait reason", async () => {
  const { setMaxActiveIssues } = await import("../repository/admission-settings.js");
  const app = await buildApp();
  try {
    // Two global slots: one admitted issue never blocks on capacity, so the free
    // slot proves repository identity alone never gates the queued sibling.
    setMaxActiveIssues(2);
    const mk = (title: string, repo: string) =>
      app.inject({
        method: "POST",
        url: "/api/issues",
        payload: {
          title,
          repo,
          baseBranch: "main",
          developerAgentId: BUILTIN_AGENT_CURSOR_ID,
          reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
          acceptanceCriteria: "It works",
        },
      });
    const holderId = ((await mk("Repo holder", "acme/hot-repo")).json() as { id: string }).id;
    assert.equal((await app.inject({ method: "POST", url: `/api/issues/${holderId}/execute` })).statusCode, 200);
    const queuedId = ((await mk("Queued mover", "acme/cold-repo")).json() as { id: string }).id;
    assert.equal(queueStatusForIssue(queuedId)?.position, 1);
    assert.equal(queueStatusForIssue(queuedId)?.waitReason, null);

    // Move onto the active sibling's repository: same position, still "next up" —
    // no repository-slot wait reason is ever synthesized.
    const clash = await app.inject({
      method: "PATCH",
      url: `/api/issues/${queuedId}`,
      payload: { repo: "acme/hot-repo" },
    });
    assert.equal(clash.statusCode, 200, clash.body);
    assert.equal((clash.json() as { repo: string }).repo, "github.com/acme/hot-repo");
    assert.equal(queueStatusForIssue(queuedId)?.position, 1, "a repository change must not reorder");
    assert.equal(queueStatusForIssue(queuedId)?.waitReason, null);

    // Move off to another repository: identical read state, position kept.
    const free = await app.inject({
      method: "PATCH",
      url: `/api/issues/${queuedId}`,
      payload: { repo: "acme/free-repo" },
    });
    assert.equal(free.statusCode, 200, free.body);
    assert.equal(queueStatusForIssue(queuedId)?.position, 1);
    assert.equal(queueStatusForIssue(queuedId)?.waitReason, null);

    const events = listWorkflowEventsForIssue(queuedId).filter((e) => e.type === "issue.reassigned");
    assert.equal(events.length, 2, "each repository change is its own audit event");
    assert.deepEqual(JSON.parse(events[0]!.payloadJson!), {
      fromRepo: "github.com/acme/cold-repo",
      toRepo: "github.com/acme/hot-repo",
      fromDeveloperAgentId: BUILTIN_AGENT_CURSOR_ID,
      toDeveloperAgentId: BUILTIN_AGENT_CURSOR_ID,
      fromReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
      toReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    });
  } finally {
    setMaxActiveIssues(1);
  }
  await app.close();
});

test("NOT-240: PATCH rejects an invalid repository and leaves the row and audit untouched", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Repo validation",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CURSOR_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
        enqueue: false,
      },
    })
  ).json() as { id: string };

  const bad = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { repo: "/tmp/local-path" },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(getIssue(created.id)!.repo, "github.com/acme/app");
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    0
  );

  // A same-value repository rewrite is a no-op: 200 with no audit event.
  const same = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { repo: "acme/app" },
  });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    0
  );
  await app.close();
});

test("NOT-240: PATCH repository that races admission answers 409 and never mutates the frozen snapshot", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Raced repo edit",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CURSOR_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` })).statusCode, 200);

  const save = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { repo: "acme/other", developerAgentId: BUILTIN_AGENT_CLAUDE_ID },
  });
  assert.equal(save.statusCode, 409);
  assert.match(String((save.json() as { error: string }).error), /developing|active workflow/);

  const issue = getIssue(created.id)!;
  assert.equal(issue.repo, "github.com/acme/app", "frozen repository untouched");
  assert.equal(issue.developerAgentId, BUILTIN_AGENT_CURSOR_ID, "frozen assignment untouched");
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    0,
    "a conflicted edit leaves no audit event"
  );
  await app.close();
});

// ---------------------------------------------------------------------------
// NOT-239: Close issue — retire a `ready` issue that should never run.
// ---------------------------------------------------------------------------

/** A startable `ready` issue through the same HTTP create the UI uses. */
async function createClosableIssue(
  app: Awaited<ReturnType<typeof buildApp>>,
  title: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: {
      title,
      repo: "acme/app",
      baseBranch: "main",
      developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
      reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
      acceptanceCriteria: "It works",
      ...extra,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { id: string }).id;
}

function closeEvents(issueId: string) {
  return listWorkflowEventsForIssue(issueId).filter((e) => e.type === "issue.closed");
}

test("NOT-239: close retires an unqueued ready issue with no execution records", async () => {
  const app = await buildApp();
  const id = await createClosableIssue(app, "Obsolete draft", { enqueue: false });
  const before = getIssue(id)!;

  const res = await app.inject({
    method: "POST",
    url: `/api/issues/${id}/close`,
    payload: { closedBy: "yusuke" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { issueStatus: "closed", alreadyClosed: false });

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    issue: { status: string; branch: string | null; prNumber: number | null };
    timeline: Array<{
      type: string;
      actorType: string;
      actorRef: string | null;
      ts: string;
      payloadJson: string | null;
    }>;
    queued: boolean;
    queueEntry: { position: number; waitReason: string | null } | null;
  };
  assert.equal(detail.issue.status, "closed");
  assert.equal(detail.issue.branch, before.branch, "close creates no branch");
  assert.equal(detail.issue.prNumber, null, "close creates no PR");
  assert.equal(detail.queued, false);
  assert.equal(detail.queueEntry, null);

  // Exactly one durable human-authored close event naming who closed and when.
  const closed = detail.timeline.filter((e) => e.type === "issue.closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.actorType, "human");
  assert.equal(closed[0]!.actorRef, "yusuke");
  assert.ok(closed[0]!.ts, "close event carries its timestamp");
  const payload = JSON.parse(closed[0]!.payloadJson!) as Record<string, unknown>;
  assert.equal(payload.reason, "closed_by_operator");
  assert.equal(payload.closedBy, "yusuke");
  assert.equal(typeof payload.closedAt, "string");
  assert.equal(payload.wasQueued, false);
  assert.equal(payload.resolvedActions, 0);

  // No execution records of any kind.
  assert.equal(listWorkflowInstancesForIssue(id).length, 0);
  assert.equal(listWorkItemsForIssue(id).length, 0);
  assert.equal(listWorkerSessionsForIssue(id).length, 0);
  await app.close();
});

test("NOT-239: close on a queued ready issue atomically removes the entry and advances the next issue", async () => {
  const app = await buildApp();
  const first = await createClosableIssue(app, "First in line");
  const second = await createClosableIssue(app, "Second in line");
  assert.equal(queueStatusForIssue(first)?.position, 1);
  assert.equal(queueStatusForIssue(second)?.position, 2);

  const res = await app.inject({ method: "POST", url: `/api/issues/${first}/close` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { issueStatus: "closed", alreadyClosed: false });

  assert.equal(getIssue(first)!.status, "closed");
  assert.equal(getQueuedEntryForIssue(first), null, "queue entry removed with the close");
  assert.equal(queueStatusForIssue(second)?.position, 1, "next issue advances normally");

  const payload = JSON.parse(closeEvents(first)[0]!.payloadJson!);
  assert.equal(payload.wasQueued, true);
  await app.close();
});

test("NOT-239: close is idempotent — a repeat on closed writes no new event", async () => {
  const app = await buildApp();
  const id = await createClosableIssue(app, "Twice closed", { enqueue: false });

  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${id}/close` })).statusCode, 200);
  const second = await app.inject({ method: "POST", url: `/api/issues/${id}/close` });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), { issueStatus: "closed", alreadyClosed: true });
  assert.equal(closeEvents(id).length, 1, "a repeated close must not append another event");
  await app.close();
});

test("NOT-239: close 404s for an unknown issue", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/api/issues/does-not-exist/close" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("NOT-239: close refuses once execution started — exactly one terminal outcome, Abort stays the stop", async () => {
  const app = await buildApp();
  const id = await createClosableIssue(app, "Already running");
  const started = await app.inject({ method: "POST", url: `/api/issues/${id}/start` });
  assert.equal(started.statusCode, 200);
  assert.equal((started.json() as { state: string }).state, "admitted");

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/close` });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /active workflow|Abort/);

  // Execution won: still developing, one instance, and no close event.
  assert.equal(getIssue(id)!.status, "developing");
  assert.equal(listWorkflowInstancesForIssue(id).length, 1);
  assert.equal(closeEvents(id).length, 0);
  await app.close();
});

test("NOT-239: close needs no readiness — an underspecified ready issue still closes", async () => {
  const app = await buildApp();
  // No acceptance criteria: unstartable, still `ready`, queued with a wait reason.
  const id = await createClosableIssue(app, "Misconfigured", { acceptanceCriteria: undefined });
  const cleared = await app.inject({
    method: "PATCH",
    url: `/api/issues/${id}`,
    payload: { acceptanceCriteria: null },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.ok(getQueuedEntryForIssue(id), "still queued before close");

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/close` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(getIssue(id)!.status, "closed");
  assert.equal(getQueuedEntryForIssue(id), null);
  await app.close();
});

test("NOT-239: a closed issue can never be admitted afterwards", async () => {
  const app = await buildApp();
  const id = await createClosableIssue(app, "Never run");
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${id}/close` })).statusCode, 200);

  const start = await app.inject({ method: "POST", url: `/api/issues/${id}/start` });
  assert.equal(start.statusCode, 409);

  const execute = await app.inject({ method: "POST", url: `/api/issues/${id}/execute` });
  assert.equal(execute.statusCode, 409);

  // (The queue router is not mounted on this issues-only app — enqueue is
  // asserted at the repository level, which is what the route calls.)
  const { enqueueIssue } = await import("../repository/queue-entries.js");
  assert.throws(() => enqueueIssue(id), (err: unknown) => {
    assert.equal((err as { code?: number }).code, 409);
    assert.match(err instanceof Error ? err.message : String(err), /cannot enqueue/);
    return true;
  });

  // A coordinator tick racing the close finds nothing to start.
  assert.equal(await admitNext(), null);
  assert.equal(listWorkflowInstancesForIssue(id).length, 0);
  await app.close();
});

test("NOT-239: closed issues leave the default paginated list but stay findable by status filter and direct URL", async () => {
  const app = await buildApp();
  const closedId = await createClosableIssue(app, "Retired work");
  const activeId = await createClosableIssue(app, "Live work");
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${closedId}/close` })).statusCode, 200);

  const def = (await app.inject({ method: "GET", url: "/api/issues?page=1" })).json() as {
    issues: Array<{ id: string }>;
  };
  assert.ok(def.issues.some((i) => i.id === activeId), "active issue stays in the default view");
  assert.ok(!def.issues.some((i) => i.id === closedId), "closed issue leaves the default view");

  const filtered = (await app.inject({ method: "GET", url: "/api/issues?status=closed&page=1" })).json() as {
    issues: Array<{ id: string }>;
  };
  assert.ok(filtered.issues.some((i) => i.id === closedId), "status filter still finds closed work");

  const direct = await app.inject({ method: "GET", url: `/api/issues/${closedId}` });
  assert.equal(direct.statusCode, 200);
  assert.equal((direct.json() as { issue: { status: string } }).issue.status, "closed");

  // Legacy unpaginated list (CLI contract) is untouched.
  const legacy = (await app.inject({ method: "GET", url: "/api/issues" })).json() as Array<{ id: string }>;
  assert.ok(legacy.some((i) => i.id === closedId));
  await app.close();
});

// NOT-358: parked agent-swap and cap-wait park shared helpers.
async function n358ParkAtAttemptsExhausted(
  app: Awaited<ReturnType<typeof buildApp>>,
  extra: Record<string, unknown> = {}
) {
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Swap me",
        description: "old",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        maxReviewRounds: 1,
        acceptanceCriteria: "Old criteria",
        ...extra,
      },
    })
  ).json() as { id: string };
  // Force-started: an HTTP start would queue behind other in-flight issues in the
  // same test — the PATCH surface under test is identical either way.
  assert.equal(startWorkflow(created.id).ok, true);
  const complete = async (outcome: Parameters<typeof applyCompletion>[2]) => {
    const item = claimWorkItem("route-test", { leaseMs: 60_000 })!;
    await applyCompletion(item.id, item.leaseToken!, outcome);
  };
  await complete({ kind: "clean_handoff", branch: "swap-b", headSha: "abc", baseSha: "base", prNumber: 1, prUrl: "https://gh/pr/1" });
  await complete({
    kind: "verdict",
    result: ReviewerResult.parse({
      verdict: "changes_requested",
      baseSha: "b",
      headSha: "h",
      acceptanceCriteriaAssessment: "ok",
      evidenceAssessment: "ok",
      findings: [],
      risks: [],
    }),
  });
  return created.id;
}

/** The frozen profile snapshot the resumed round carries — what the next session spawns from. */
function n358PendingSnapshot(issueId: string, kind: "developer" | "reviewer") {
  const item = listWorkItemsForIssue(issueId).find((i) => i.status === "pending" && i.kind === kind)!;
  assert.ok(item, `expected a pending ${kind} work item`);
  const payload = JSON.parse(item.payloadJson!) as { profileSnapshot?: string };
  const snapshot = JSON.parse(payload.profileSnapshot!) as { agentId: string; runtime: string; role: string };
  return snapshot;
}

test("NOT-358: PATCH swaps the developer alone at an attempts_exhausted park, and resume freezes the new profile", async () => {
  const app = await buildApp();
  const issueId = await n358ParkAtAttemptsExhausted(app);
  const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/issues/${issueId}`, payload });

  const res = await patch({ developerAgentId: BUILTIN_AGENT_CODEX_ID });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { developerAgentId: string; reviewerAgentId: string; branch: string | null; currentRound: number; maxReviewRounds: number };
  assert.equal(body.developerAgentId, BUILTIN_AGENT_CODEX_ID);
  assert.equal(body.reviewerAgentId, BUILTIN_AGENT_CURSOR_ID, "the other role is untouched");
  assert.equal(body.branch, "swap-b", "the swap keeps the existing branch");
  assert.deepEqual([body.currentRound, body.maxReviewRounds], [1, 1], "rounds are unchanged");

  const events = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "issue.reassigned");
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.payloadJson!), {
    fromRepo: "github.com/acme/app",
    toRepo: "github.com/acme/app",
    fromDeveloperAgentId: BUILTIN_AGENT_CLAUDE_ID,
    toDeveloperAgentId: BUILTIN_AGENT_CODEX_ID,
    fromReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    toReviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
  });

  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "attempts_exhausted")!;
  assert.equal(resolveHumanActionAndAdvance(action.id, "op", "retry").ok, true);
  // The resumed developer round carries the NEW profile — the worker loop builds the
  // spawned session (agent + runtime) from exactly this snapshot.
  const snapshot = n358PendingSnapshot(issueId, "developer");
  assert.equal(snapshot.agentId, BUILTIN_AGENT_CODEX_ID);
  assert.equal(snapshot.runtime, "codex_local");
  assert.equal(snapshot.role, "developer");
  await app.close();
});

test("NOT-358: PATCH swaps the reviewer alone and both roles together at a policy_escalation park", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Capped",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` })).statusCode, 200);
  const item = claimWorkItem("route-test", { leaseMs: 60_000 })!;
  const until = new Date(Date.now() + 300_000).toISOString();
  await applyCompletion(item.id, item.leaseToken!, {
    kind: "usage_capped",
    until,
    reason: "claude_code usage capped — five_hour limit rejected",
  });

  // The detail names the wait — the dashboard parks from this notice.
  const waiting = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    capWait: { kind: string; until: string; reason: string } | null;
  };
  assert.deepEqual(waiting.capWait, {
    kind: "usage_capped",
    until,
    reason: "claude_code usage capped — five_hour limit rejected",
  });

  const parked = await app.inject({ method: "POST", url: `/api/issues/${created.id}/park`, payload: {} });
  assert.equal(parked.statusCode, 200);
  const parkedBody = parked.json() as { id: string; status: string; humanActionId: string };
  assert.equal(parkedBody.status, "needs_human");
  assert.ok(parkedBody.humanActionId);

  const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload });
  const revRes = await patch({ reviewerAgentId: BUILTIN_AGENT_CLAUDE_ID });
  assert.equal(revRes.statusCode, 200);
  assert.equal((revRes.json() as { reviewerAgentId: string }).reviewerAgentId, BUILTIN_AGENT_CLAUDE_ID);

  const bothRes = await patch({ developerAgentId: BUILTIN_AGENT_CODEX_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID });
  assert.equal(bothRes.statusCode, 200);
  const bothBody = bothRes.json() as { developerAgentId: string; reviewerAgentId: string };
  assert.equal(bothBody.developerAgentId, BUILTIN_AGENT_CODEX_ID);
  assert.equal(bothBody.reviewerAgentId, BUILTIN_AGENT_CURSOR_ID);
  assert.equal(
    listWorkflowEventsForIssue(created.id).filter((e) => e.type === "issue.reassigned").length,
    2,
    "one reassigned event per PATCH"
  );

  const action = listHumanActionsForIssue(created.id).find((a) => a.status === "open")!;
  assert.equal(action.actionType, "policy_escalation");
  assert.equal(resolveHumanActionAndAdvance(action.id, "op", "resume").ok, true);
  const snapshot = n358PendingSnapshot(created.id, "developer");
  assert.equal(snapshot.agentId, BUILTIN_AGENT_CODEX_ID);
  assert.equal(snapshot.runtime, "codex_local");
  await app.close();
});

test("NOT-358: PATCH agent IDs are rejected while running, queued behind work, completed, or with an active session (409), and unknown IDs are 400", async () => {
  const app = await buildApp();
  const mk = async (title: string) =>
    (
      (await app.inject({
        method: "POST",
        url: "/api/issues",
        payload: {
          title,
          repo: "acme/app",
          baseBranch: "main",
          developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
          reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
          acceptanceCriteria: "It works",
        },
      })).json() as { id: string }
    ).id;
  const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/api/issues/${id}`, payload });
  // `claimWorkItem` takes the oldest claimable item across issues — cancel each flow's
  // leftovers so later flows claim their own items.
  const cancelPending = (id: string) => {
    for (const i of listWorkItemsForIssue(id)) {
      if (i.status === "pending" || i.status === "leased") cancelWorkItem(i.id);
    }
  };

  // Running: a pending developer item owns the snapshot.
  const runningId = await mk("Running swap");
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${runningId}/start` })).statusCode, 200);
  assert.equal((await patch(runningId, { developerAgentId: BUILTIN_AGENT_CODEX_ID })).statusCode, 409);
  assert.equal(getIssue(runningId)!.developerAgentId, BUILTIN_AGENT_CLAUDE_ID);
  assert.equal(listWorkflowEventsForIssue(runningId).filter((e) => e.type === "issue.reassigned").length, 0);
  cancelPending(runningId);

  // Queued behind work: parked at policy_escalation but a work item is still pending.
  // Force-started directly: an HTTP start would queue behind the running issue above.
  const queuedId = await mk("Queued swap");
  assert.equal(startWorkflow(queuedId).ok, true);
  transitionIssue(queuedId, "needs_human");
  createHumanAction({
    issueId: queuedId,
    actionType: "policy_escalation",
    reason: "test park",
    question: "Resume?",
  });
  assert.equal((await patch(queuedId, { reviewerAgentId: BUILTIN_AGENT_CLAUDE_ID })).statusCode, 409);
  assert.equal(getIssue(queuedId)!.reviewerAgentId, BUILTIN_AGENT_CURSOR_ID);
  cancelPending(queuedId);

  // Completed: history is immutable.
  const doneId = await mk("Done swap");
  transitionIssue(doneId, "developing");
  transitionIssue(doneId, "reviewing");
  transitionIssue(doneId, "final_review");
  transitionIssue(doneId, "done");
  assert.equal((await patch(doneId, { developerAgentId: BUILTIN_AGENT_CODEX_ID })).statusCode, 409);

  // Active session: parked with nothing pending/leased, but a worker still runs.
  const sessionId = await mk("Session swap");
  assert.equal(startWorkflow(sessionId).ok, true);
  const pending = claimWorkItem("route-test", { leaseMs: 60_000 })!;
  assert.equal(pending.issueId, sessionId);
  cancelWorkItem(pending.id);
  transitionIssue(sessionId, "needs_human");
  createHumanAction({
    issueId: sessionId,
    actionType: "policy_escalation",
    reason: "test park",
    question: "Resume?",
  });
  const worker = createWorkerSession({
    issueId: sessionId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  startSession(worker.id);
  const sessionRes = await patch(sessionId, { developerAgentId: BUILTIN_AGENT_CODEX_ID });
  assert.equal(sessionRes.statusCode, 409);
  assert.match((sessionRes.json() as { error: string }).error, /running session/);
  assert.equal(getIssue(sessionId)!.developerAgentId, BUILTIN_AGENT_CLAUDE_ID);

  // Unknown agent profiles are 400 and change nothing — at both park flavors.
  const parkedId = await n358ParkAtAttemptsExhausted(app);
  const unknownId = randomUUID();
  assert.equal((await patch(parkedId, { developerAgentId: unknownId })).statusCode, 400);
  assert.equal((await patch(parkedId, { reviewerAgentId: unknownId })).statusCode, 400);
  assert.equal(getIssue(parkedId)!.developerAgentId, BUILTIN_AGENT_CLAUDE_ID);
  assert.equal(getIssue(parkedId)!.reviewerAgentId, BUILTIN_AGENT_CURSOR_ID);

  // Locked fields stay locked at a policy_escalation park too.
  assert.equal((await patch(queuedId, { maxReviewRounds: 5 })).statusCode, 409);
  await app.close();
});

test("NOT-358: POST /api/issues/:id/park parks cap and outage waits, and rejects anything else", async () => {
  const app = await buildApp();
  assert.equal((await app.inject({ method: "POST", url: "/api/issues/does-not-exist/park", payload: {} })).statusCode, 404);

  // No active workflow: nothing to park.
  const ready = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Never started",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${ready.id}/park`, payload: {} })).statusCode, 409);

  // A plain pending item is not a cap wait.
  const plain = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Plain pending",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${plain.id}/start` })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${plain.id}/park`, payload: {} })).statusCode, 409);
  // Cancel the plain pending item — `claimWorkItem` takes the oldest claimable item
  // across issues, so later flows must not see it.
  for (const i of listWorkItemsForIssue(plain.id)) {
    if (i.status === "pending" || i.status === "leased") cancelWorkItem(i.id);
  }

  // A deck-outage wait parks the same way a usage-cap wait does.
  const outage = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Outage wait",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  // Force-started: the plain issue above still holds the admission slot.
  assert.equal(startWorkflow(outage.id).ok, true);
  const outageItem = claimWorkItem("route-test", { leaseMs: 60_000 })!;
  assert.equal(outageItem.issueId, outage.id);
  await applyCompletion(outageItem.id, outageItem.leaseToken!, {
    kind: "deck_unavailable",
    reason: "Agent Deck unreachable — connection refused",
  });
  const outagePark = await app.inject({ method: "POST", url: `/api/issues/${outage.id}/park`, payload: {} });
  assert.equal(outagePark.statusCode, 200);
  const outageBody = outagePark.json() as { status: string; humanActionId: string };
  assert.equal(outageBody.status, "needs_human");
  const outageAction = listHumanActionsForIssue(outage.id).find((a) => a.id === outageBody.humanActionId)!;
  assert.equal(outageAction.actionType, "policy_escalation");
  assert.match(outageAction.reason, /Agent Deck outage/);

  // A running session blocks the park even when a cap wait is pending.
  const live = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Live session",
        repo: "acme/app",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };
  assert.equal(startWorkflow(live.id).ok, true);
  const liveItem = claimWorkItem("route-test", { leaseMs: 60_000 })!;
  assert.equal(liveItem.issueId, live.id);
  await applyCompletion(liveItem.id, liveItem.leaseToken!, {
    kind: "usage_capped",
    until: new Date(Date.now() + 300_000).toISOString(),
    reason: "claude_code usage capped — test",
  });
  const liveSession = createWorkerSession({
    issueId: live.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  startSession(liveSession.id);
  const livePark = await app.inject({ method: "POST", url: `/api/issues/${live.id}/park`, payload: {} });
  assert.equal(livePark.statusCode, 409);
  assert.equal(getIssue(live.id)!.status, "developing");
  assert.ok(
    listWorkItemsForIssue(live.id).some((i) => i.status === "pending"),
    "the rejected park cancels nothing"
  );
  await app.close();
});
