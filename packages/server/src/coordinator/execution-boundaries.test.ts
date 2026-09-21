// packages/server/src/coordinator/execution-boundaries.test.ts
//
// NOT-169: durable setup / agent-process / validation-publish boundaries end to end
// through the real coordinator (worker-loop → effects → routing → recovery).
//
// Covers: developer + reviewer happy paths (one setup, one agent-process, one
// validation interval, all exact non-negative); timeout / non-zero exit / thrown spawn /
// abort / validation failure closing every started boundary; pre-spawn failure leaving
// setup evidence only; publishOnly tagged and agent-free; host.suspended idempotent and
// decision-free; restart + same-millisecond determinism; usage duration never exact.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-bound-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.HEAD_RECONCILE_TIMEOUT_MS = "60";
process.env.HEAD_RECONCILE_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { claimWorkItem, listWorkItemsForIssue, getWorkItem } = await import("../repository/work-items.js");
const {
  getActiveWorkflowInstance,
  listWorkflowEventsForIssue,
  listWorkflowEventsForSessionOrdered,
} = await import("../repository/workflow-events.js");
const { startWorkflow, applyCompletion } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { runReviewerEffect } = await import("./reviewer-effect.js");
const { recoverCoordinator } = await import("./recovery.js");
const { deriveAttemptIntervals } = await import("./execution-intervals.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
const { bindWorkItemSession: bindItem } = await import("../repository/work-items.js");
type SpawnFn = (input: any) => Promise<any>;

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM review_publications; DELETE FROM work_items");
  resetEffectHandlers();
});
after(() => resetEffectHandlers());

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-bound-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-bound-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

const TEST_DECK_ID = "00000000-0000-4000-a000-000000000099";
const okDeckCallTool = async (name: string, _args: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ id: TEST_DECK_ID, name: "test-deck" }) }],
});

async function makeIssue(opts: { devDeckId?: string | null } = {}): Promise<string> {
  const dev = createAgent({
    name: `dev-${Math.random()}`,
    runtime: "claude_code",
    deckId: TEST_DECK_ID,
  });
  if (opts.devDeckId === null) {
    // A profile with no Agent Deck: the effect fails before any spawn (deck_failure).
    getDb().prepare("UPDATE agents SET deck_id = NULL WHERE id = ?").run(dev.id);
  }
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", deckId: TEST_DECK_ID });
  return createIssue({
    title: "Add widget",
    description: "Build the widget.",
    acceptanceCriteria: "Widget renders.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

/** Wrap a fake spawn so it reports a real child pid through onSpawn (the agent.started source of truth). */
function withSpawnPid(fn: SpawnFn): SpawnFn {
  return async (input: any) => {
    input.onSpawn?.(process.pid);
    return fn(input);
  };
}

const committingSpawn: SpawnFn = withSpawnPid(async (input: any) => {
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
  return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: "/dev/null", timedOut: false };
});
const crashingSpawn: SpawnFn = withSpawnPid(async () => ({ exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: false }));
const timedOutSpawn: SpawnFn = withSpawnPid(async () => ({ exitCode: 1, transcript: "", logPath: "/dev/null", timedOut: true }));
const throwingSpawn: SpawnFn = withSpawnPid(async () => {
  throw new Error("spawn blew up after fork");
});

function fakeGithub(opts: { checks?: "success" | "failure" } = {}): any {
  const prs = new Map<string, { number: number; url: string; base: string }>();
  const byNumber = new Map<number, string>();
  let nextNumber = 100;
  let publishCalls = 0;
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  return {
    async viewPr({ branch, number, cwd }: any) {
      const b = number != null ? byNumber.get(number) : branch ?? git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      if (!b) return null;
      const pr = prs.get(b);
      if (!pr) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: b, headRefOid: remoteHead(b), isDraft: true };
    },
    async createDraftPr({ base, head }: any) {
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prs.set(head, { number, url, base });
      byNumber.set(number, head);
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return opts.checks ?? "success";
    },
    async publishReview({ event }: any) {
      publishCalls++;
      return { ok: true, event, usedCommentFallback: false };
    },
    publishCallCount: () => publishCalls,
  };
}

function reviewerTranscript(baseSha: string, headSha: string): string {
  const body = {
    verdict: "approved",
    baseSha,
    headSha,
    acceptanceCriteriaAssessment: "Assessed.",
    evidenceAssessment: "Evidence checked.",
    findings: [],
    risks: [],
  };
  return `Preamble.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

function verdictSpawn(): SpawnFn {
  return withSpawnPid(async (input: any) => {
    const baseSha = input.prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
    const headSha = input.prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
    if (!baseSha || !headSha) throw new Error("could not extract SHAs from reviewer prompt");
    return { exitCode: 0, transcript: reviewerTranscript(baseSha, headSha), logPath: "/dev/null", timedOut: false };
  });
}

function sessionEvents(sessionId: string) {
  return listWorkflowEventsForSessionOrdered(sessionId).map((r) => r.event);
}

function typesFor(sessionId: string): string[] {
  return sessionEvents(sessionId).map((e) => e.type);
}

test("developer happy path: one setup, one agent-process, one validation interval, all exact non-negative", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: committingSpawn, github }));
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn(), github }));
  startWorkflow(issueId);
  await runCoordinatorTick({ leaseOwner: "pump-dev" });
  await drainCoordinator();

  assert.equal(getIssue(issueId)!.status, "reviewing");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  const types = typesFor(dev.id);
  assert.equal(types.filter((t) => t === "worker.started").length, 1);
  assert.equal(types.filter((t) => t === "agent.started").length, 1);
  assert.equal(types.filter((t) => t === "agent.completed").length, 1);
  assert.equal(types.filter((t) => t === "worker.completed").length, 1);

  const started = sessionEvents(dev.id).find((e) => e.type === "agent.started")!;
  const startedPayload = JSON.parse(started.payloadJson!);
  assert.equal(startedPayload.sessionId, dev.id);
  assert.equal(startedPayload.role, "developer");
  assert.equal(startedPayload.round, 1);
  assert.ok(typeof startedPayload.pid === "number");

  const completed = sessionEvents(dev.id).find((e) => e.type === "agent.completed")!;
  const completedPayload = JSON.parse(completed.payloadJson!);
  assert.equal(completedPayload.exitCode, 0);
  assert.equal(completedPayload.timedOut, false);
  // Raw outcome only — no failure classification.
  assert.ok(!("code" in completedPayload) && !("domain" in completedPayload));

  const rows = listWorkflowEventsForSessionOrdered(dev.id).map((r) => ({ type: r.event.type, ts: r.event.ts, rowid: r.rowid }));
  const intervals = deriveAttemptIntervals({ events: rows });
  for (const i of [intervals.setup, intervals.agentProcess, intervals.validationPublish]) {
    assert.equal(i.quality, "exact");
    assert.ok(i.durationMs !== null && i.durationMs >= 0);
  }
  // Deterministic across a daemon restart: fresh reads derive identically.
  const again = deriveAttemptIntervals({
    events: listWorkflowEventsForSessionOrdered(dev.id).map((r) => ({ type: r.event.type, ts: r.event.ts, rowid: r.rowid })),
  });
  assert.deepEqual(again, intervals);
});

test("reviewer happy path: one setup, one agent-process, one validation interval, all exact non-negative", async () => {
  const issueId = await makeIssue();
  const github = fakeGithub();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: committingSpawn, github }));
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: verdictSpawn(), github }));
  startWorkflow(issueId);
  await runCoordinatorTick({ leaseOwner: "pump-dev" });
  await drainCoordinator();
  await runCoordinatorTick({ leaseOwner: "pump-rev" });
  await drainCoordinator();

  const rev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "reviewer")!;
  const types = typesFor(rev.id);
  assert.equal(types.filter((t) => t === "agent.started").length, 1);
  assert.equal(types.filter((t) => t === "agent.completed").length, 1);
  assert.ok(types.includes("worker.completed"));
  const rows = listWorkflowEventsForSessionOrdered(rev.id).map((r) => ({ type: r.event.type, ts: r.event.ts, rowid: r.rowid }));
  const intervals = deriveAttemptIntervals({ events: rows });
  for (const i of [intervals.setup, intervals.agentProcess, intervals.validationPublish]) {
    assert.equal(i.quality, "exact");
    assert.ok(i.durationMs !== null && i.durationMs >= 0);
  }
});

test("non-zero exit closes the agent interval and still reaches a worker terminal event", async () => {
  const issueId = await makeIssue();
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: crashingSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await runCoordinatorTick({ leaseOwner: "pump" });
  await drainCoordinator();

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  const types = typesFor(dev.id);
  assert.equal(types.filter((t) => t === "agent.started").length, 1);
  assert.equal(types.filter((t) => t === "agent.completed").length, 1);
  const completedPayload = JSON.parse(sessionEvents(dev.id).find((e) => e.type === "agent.completed")!.payloadJson!);
  assert.equal(completedPayload.exitCode, 1);
  assert.ok(types.includes("worker.failed"));
});

test("timeout and coordinator validation failure close every started boundary", async () => {
  // Timeout.
  const timeoutIssue = await makeIssue();
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: timedOutSpawn, github: fakeGithub() })
  );
  startWorkflow(timeoutIssue);
  await runCoordinatorTick({ leaseOwner: "pump" });
  await drainCoordinator();
  const timed = listWorkerSessionsForIssue(timeoutIssue).find((s) => s.role === "developer")!;
  const timedTypes = typesFor(timed.id);
  assert.equal(timedTypes.filter((t) => t === "agent.completed").length, 1);
  assert.equal(
    JSON.parse(sessionEvents(timed.id).find((e) => e.type === "agent.completed")!.payloadJson!).timedOut,
    true
  );
  assert.ok(timedTypes.includes("worker.failed"));

  // Coordinator validation failure (checks_failed after a clean agent run).
  resetEffectHandlers();
  getDb().exec("DELETE FROM work_items");
  const checksIssue = await makeIssue();
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: committingSpawn, github: fakeGithub({ checks: "failure" }) })
  );
  startWorkflow(checksIssue);
  await runCoordinatorTick({ leaseOwner: "pump" });
  await drainCoordinator();
  const checked = listWorkerSessionsForIssue(checksIssue).find((s) => s.role === "developer")!;
  const checkedTypes = typesFor(checked.id);
  assert.equal(checkedTypes.filter((t) => t === "agent.started").length, 1);
  assert.equal(checkedTypes.filter((t) => t === "agent.completed").length, 1);
  assert.ok(checkedTypes.includes("worker.failed"));
});

test("thrown spawn after process creation closes the agent interval; throw before spawn leaves setup evidence only", async () => {
  // Throw after onSpawn: both boundaries exist, completed carries thrown:true.
  const thrownIssue = await makeIssue();
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: throwingSpawn, github: fakeGithub() })
  );
  startWorkflow(thrownIssue);
  await runCoordinatorTick({ leaseOwner: "pump" });
  await drainCoordinator();
  const thrown = listWorkerSessionsForIssue(thrownIssue).find((s) => s.role === "developer")!;
  const thrownTypes = typesFor(thrown.id);
  assert.equal(thrownTypes.filter((t) => t === "agent.started").length, 1);
  assert.equal(thrownTypes.filter((t) => t === "agent.completed").length, 1);
  assert.equal(
    JSON.parse(sessionEvents(thrown.id).find((e) => e.type === "agent.completed")!.payloadJson!).thrown,
    true
  );
  assert.ok(thrownTypes.includes("worker.failed"));

  // Failure before any spawn (no deck): no fake agent interval at all.
  resetEffectHandlers();
  getDb().exec("DELETE FROM work_items");
  const preIssue = await makeIssue({ devDeckId: null });
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: committingSpawn, github: fakeGithub() })
  );
  startWorkflow(preIssue);
  await runCoordinatorTick({ leaseOwner: "pump" });
  await drainCoordinator();
  const pre = listWorkerSessionsForIssue(preIssue).find((s) => s.role === "developer")!;
  const preTypes = typesFor(pre.id);
  assert.ok(preTypes.includes("worker.started"));
  assert.ok(!preTypes.includes("agent.started") && !preTypes.includes("agent.completed"));
  const rows = listWorkflowEventsForSessionOrdered(pre.id).map((r) => ({ type: r.event.type, ts: r.event.ts, rowid: r.rowid }));
  const intervals = deriveAttemptIntervals({ events: rows });
  assert.equal(intervals.setup.quality, "unavailable");
  assert.equal(intervals.agentProcess.quality, "unavailable");
  assert.equal(intervals.agentProcess.durationMs, null);
});

test("publishOnly recovery is tagged on the worker terminal event and has no agent interval", async () => {
  const issueId = await makeIssue();
  startWorkflow(issueId);
  const instance = getActiveWorkflowInstance(issueId)!;
  const claimed = claimWorkItem("owner", { leaseMs: 60_000 })!;
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  startSession(session.id);
  assert.equal(bindItem(claimed.id, session.id, claimed.leaseToken!), true);
  // Point the item at the no-agent publish path (NOT-129 reclaim shape).
  const payload = { ...(JSON.parse(claimed.payloadJson ?? "{}") as object), publishOnly: true, branch: "issue-x" };
  getDb().prepare("UPDATE work_items SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), claimed.id);

  const result = await applyCompletion(claimed.id, claimed.leaseToken!, {
    kind: "clean_handoff",
    branch: "issue-x",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
  } as any);
  assert.equal(result.applied, true);

  const terminal = listWorkflowEventsForIssue(issueId).find((e) => e.type === "worker.completed")!;
  assert.equal(JSON.parse(terminal.payloadJson!).publishOnly, true);
  assert.deepEqual(typesFor(session.id).filter((t) => t === "agent.started" || t === "agent.completed"), []);
  const rows = listWorkflowEventsForSessionOrdered(session.id).map((r) => ({
    type: r.event.type,
    ts: r.event.ts,
    rowid: r.rowid,
  }));
  const intervals = deriveAttemptIntervals({ events: rows, publishOnly: true });
  assert.equal(intervals.agentProcess.quality, "unavailable");
  assert.ok(intervals.coordinatorWork!.reasons.includes("publish_only"));

  // A normal agent attempt is NOT tagged: publishOnly recoveries stay distinguishable.
  void instance;
  // Drop issue 1's follow-up reviewer item so the next claim takes issue 2's developer.
  getDb().prepare("DELETE FROM work_items WHERE issue_id = ?").run(issueId);
  const issue2 = await makeIssue();
  startWorkflow(issue2);
  const claimed2 = claimWorkItem("owner", { leaseMs: 60_000 })!;
  assert.equal(claimed2.kind, "developer");
  const session2 = createWorkerSession({ issueId: issue2, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  startSession(session2.id);
  assert.equal(bindItem(claimed2.id, session2.id, claimed2.leaseToken!), true);
  await applyCompletion(claimed2.id, claimed2.leaseToken!, {
    kind: "clean_handoff",
    branch: "issue-y",
    headSha: "c".repeat(40),
    baseSha: "d".repeat(40),
    prNumber: 8,
    prUrl: "https://github.com/o/r/pull/8",
  } as any);
  const terminal2 = listWorkflowEventsForIssue(issue2).find((e) => e.type === "worker.completed")!;
  assert.ok(!("publishOnly" in (JSON.parse(terminal2.payloadJson!) as object)));
});

test("host sleep is durable, idempotent across recovery ticks, and changes no decision", async () => {
  const issueId = await makeIssue();
  startWorkflow(issueId);
  const instance = getActiveWorkflowInstance(issueId)!;
  const claimed = claimWorkItem("owner", { leaseMs: 60_000 })!;
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  startSession(session.id);
  assert.equal(bindItem(claimed.id, session.id, claimed.leaseToken!), true);

  const now = Date.now();
  const jump = {
    detectedAt: now - 5_000,
    graceUntil: now + 60_000,
    wallGapMs: 600_000,
    unelapsedMs: 599_000,
    unobservedMs: 597_000,
  };
  // The lease expired before the jump was detected: healthy at suspend, protected now.
  getDb()
    .prepare("UPDATE work_items SET lease_expires_at = ? WHERE id = ?")
    .run(new Date(jump.detectedAt - 500).toISOString(), claimed.id);

  const first = await recoverCoordinator({ now, clockJump: jump });
  assert.deepEqual(first.heldAcrossClockJump, [claimed.id]);
  assert.deepEqual(first.reclaimed, []);
  let suspended = sessionEvents(session.id).filter((e) => e.type === "host.suspended");
  assert.equal(suspended.length, 1);
  assert.equal(JSON.parse(suspended[0]!.payloadJson!).wallGapMs, 600_000);
  // Still leased — the hold did not fail, retry, or reassign anything.
  assert.equal(getWorkItem(claimed.id)!.status, "leased");
  assert.equal(listWorkflowEventsForIssue(issueId).filter((e) => e.type === "worker.failed").length, 0);

  // A second tick with the same jump is a no-op: idempotent, still held.
  const second = await recoverCoordinator({ now: now + 1_000, clockJump: jump });
  assert.deepEqual(second.heldAcrossClockJump, [claimed.id]);
  suspended = sessionEvents(session.id).filter((e) => e.type === "host.suspended");
  assert.equal(suspended.length, 1);
  assert.equal(getWorkItem(claimed.id)!.status, "leased");
  void instance;
});

test("abort closes the agent interval with an aborted marker and no classification", async () => {
  const { emitAgentStarted, emitAgentCompleted } = await import("./agent-boundaries.js");
  const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
  const issueId = await makeIssue();
  startWorkflow(issueId);
  const instance = getActiveWorkflowInstance(issueId)!;
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  startSession(session.id);
  const base = { issueId, workflowInstanceId: instance.id, workerSessionId: session.id } as const;
  appendWorkflowEvent({ ...base, type: "worker.started", actorType: "developer", stage: "developing", round: 1 });
  emitAgentStarted({ ...base, role: "developer", stage: "developing", round: 1, runtime: "claude_code", model: null, pid: 4242 });
  emitAgentCompleted({
    ...base,
    role: "developer",
    stage: "developing",
    round: 1,
    runtime: "claude_code",
    model: null,
    pid: 4242,
    exitCode: null,
    timedOut: false,
    aborted: true,
    thrown: false,
  });
  appendWorkflowEvent({ ...base, type: "worker.failed", actorType: "developer", stage: "developing", round: 1 });
  // Exactly-once: repeats are idempotent no-ops.
  emitAgentStarted({ ...base, role: "developer", stage: "developing", round: 1, runtime: "claude_code", model: null, pid: 4242 });
  emitAgentCompleted({
    ...base,
    role: "developer",
    stage: "developing",
    round: 1,
    runtime: "claude_code",
    model: null,
    pid: 4242,
    exitCode: null,
    timedOut: false,
    aborted: true,
    thrown: false,
  });
  const types = typesFor(session.id);
  assert.equal(types.filter((t) => t === "agent.started").length, 1);
  assert.equal(types.filter((t) => t === "agent.completed").length, 1);
  const payload = JSON.parse(sessionEvents(session.id).find((e) => e.type === "agent.completed")!.payloadJson!);
  assert.equal(payload.aborted, true);
  assert.ok(!("code" in payload) && !("domain" in payload));
  const rows = listWorkflowEventsForSessionOrdered(session.id).map((r) => ({ type: r.event.type, ts: r.event.ts, rowid: r.rowid }));
  const intervals = deriveAttemptIntervals({ events: rows });
  assert.equal(intervals.agentProcess.quality, "exact");
  assert.ok(intervals.agentProcess.durationMs !== null && intervals.agentProcess.durationMs >= 0);
});

test("old sessions: usage duration is inferred agent evidence, never exact boundaries", async () => {
  const { recordUsageEvent } = await import("../repository/usage-events.js");
  const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
  const issueId = await makeIssue();
  startWorkflow(issueId);
  const instance = getActiveWorkflowInstance(issueId)!;
  const session = createWorkerSession({ issueId, role: "developer", round: 1, agentId: null, runtime: "claude_code" });
  startSession(session.id);
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.started",
    actorType: "developer",
    stage: "developing",
    round: 1,
  });
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.failed",
    actorType: "developer",
    stage: "developing",
    round: 1,
    payload: { outcome: "session_failed" },
  });
  const usage = recordUsageEvent({
    issueId,
    workerSessionId: session.id,
    role: "developer",
    runtime: "claude_code",
    durationMs: 999_000,
  });
  const rows = listWorkflowEventsForSessionOrdered(session.id).map((r) => ({
    type: r.event.type,
    ts: r.event.ts,
    rowid: r.rowid,
  }));
  const intervals = deriveAttemptIntervals({ events: rows, usageDurationMs: usage.durationMs });
  assert.equal(intervals.agentProcess.quality, "inferred");
  assert.equal(intervals.agentProcess.durationMs, 999_000);
  assert.equal(intervals.agentProcess.startMs, null);
  // Resource evidence stays separate and is never presented as exact wall clock.
  assert.equal(intervals.spawnEnvelope.quality, "inferred");
  assert.notEqual(intervals.agentProcess.quality, "exact");
});
