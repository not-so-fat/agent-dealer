// packages/server/src/coordinator/guidance.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-guidance-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { guidanceForNextSession } = await import("./guidance.js");

before(() => {
  migrate();
});

function seedIssue(): string {
  return createIssue({
    title: "Guidance host issue",
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

/** Mirrors worker-loop.ts's real transaction: create → startSession → the `worker.started`
 * event, all before the effect handler (and this module) ever runs — so every session a
 * test creates has the same rowid-cursor anchor `guidanceForNextSession` relies on. */
function addSession(issueId: string, role: "developer" | "reviewer", round: number) {
  const session = createWorkerSession({ issueId, role, round, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
  startSession(session.id);
  appendWorkflowEvent({ issueId, workerSessionId: session.id, type: "worker.started", actorType: "system", stage: "developing", round });
  return session;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("first session picks up all guidance added before it, since there is no prior session", async () => {
  const issueId = seedIssue();
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "ready", payload: { markdown: "Pre-start note" } });
  await sleep(5);
  const round1Dev = addSession(issueId, "developer", 1);

  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Dev.id), ["Pre-start note"]);
});

test("a later round only sees guidance added since the immediately preceding session", async () => {
  // Each guidanceForNextSession call happens at the point it actually would in production
  // — right before that session's own prompt is built, before any *later* guidance exists
  // — not retroactively after the whole issue history has played out.
  const issueId = seedIssue();
  const round1Dev = addSession(issueId, "developer", 1);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Dev.id), []);

  await sleep(5);
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing", payload: { markdown: "During round 1" } });
  await sleep(5);
  const round1Reviewer = addSession(issueId, "reviewer", 1);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Reviewer.id), ["During round 1"]);

  await sleep(5);
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "reviewing", payload: { markdown: "During review" } });
  await sleep(5);
  const round2Dev = addSession(issueId, "developer", 2);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round2Dev.id), ["During review"]);
});

test("guidance added while a session is running is deferred to the next session, not lost", async () => {
  const issueId = seedIssue();
  const round1Dev = addSession(issueId, "developer", 1);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Dev.id), []);

  await sleep(5);
  // Simulates guidance posted mid-session — it must not appear for round1Dev (already
  // spawned) and must appear for whatever session is enqueued next.
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing", payload: { markdown: "Mid-session note" } });
  await sleep(5);
  const round1Reviewer = addSession(issueId, "reviewer", 1);

  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Reviewer.id), ["Mid-session note"]);
});

// PR #11 review round 1: worker-loop.ts marks a session "running" (startSession) BEFORE
// its worktree setup and deck bind, both of which take real wall-clock time before
// guidanceForNextSession is actually called to build the prompt. Guidance posted in that
// gap must still be deferred to the *next* session, not swept into this one just because
// the call happened a few seconds late.
test("guidance posted after the session starts running (but before its prompt is actually built) is deferred to the next session", async () => {
  const issueId = seedIssue();
  const round1Dev = addSession(issueId, "developer", 1); // create + startSession + worker.started, atomically
  // Simulates guidance posted during worktree setup / deck bind, i.e. after the session
  // already started but before this function is actually invoked for it.
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing", payload: { markdown: "Posted during worktree setup" } });

  // Called "late", as if setup took a few seconds — must not see guidance posted after
  // this session's own worker.started event.
  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Dev.id), []);

  const round1Reviewer = addSession(issueId, "reviewer", 1);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Reviewer.id), ["Posted during worktree setup"]);
});

// PR #11 review round 2: `ts` only has millisecond precision, so a `ts <=` boundary can
// wrongly include (or a `ts <` boundary wrongly exclude) a guidance event that lands in
// the exact same millisecond as the session's own snapshot event. No sleeps here at all —
// everything happens back-to-back so it's likely to collide on `ts` — proving the rowid
// cursor is what actually decides the boundary, not wall-clock time.
test("a millisecond-colliding guidance event is still correctly bucketed by insertion order, not timestamp", () => {
  const issueId = seedIssue();
  const round1Dev = addSession(issueId, "developer", 1);
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing", payload: { markdown: "Right after round1Dev started" } });
  const round1Reviewer = addSession(issueId, "reviewer", 1);
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "reviewing", payload: { markdown: "Right after round1Reviewer started" } });
  const round2Dev = addSession(issueId, "developer", 2);

  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Dev.id), []);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round1Reviewer.id), ["Right after round1Dev started"]);
  assert.deepStrictEqual(guidanceForNextSession(issueId, round2Dev.id), ["Right after round1Reviewer started"]);
});
