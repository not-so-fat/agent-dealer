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
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { transitionIssue, listIssuesByExternalId, getIssue } = await import("../repository/issues.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { claimWorkItem } = await import("../repository/work-items.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { applyCompletion, resolveHumanActionAndAdvance, getTaskSnapshot } = await import("../coordinator/commands.js");
const { ReviewerResult } = await import("../coordinator/reviewer-result.js");
const { getQueuedEntryForIssue, listQueuedEntries } = await import("../repository/queue-entries.js");
const { setAdmissionHealthCheckerForTests } = await import("../coordinator/admission.js");

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

  // Non-task fields stay frozen at the park — notably the review budget (a non-goal).
  for (const payload of [
    { maxReviewRounds: 5 },
    { maxInfraAttempts: 3 },
    { repo: "acme/other" },
    { baseBranch: "develop" },
    { developerAgentId: BUILTIN_AGENT_CURSOR_ID },
    { reviewerAgentId: BUILTIN_AGENT_CLAUDE_ID },
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
