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
const { createWorkerSession } = await import("../repository/worker-sessions.js");
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

function addSession(issueId: string, role: "developer" | "reviewer", round: number) {
  return createWorkerSession({ issueId, role, round, agentId: BUILTIN_AGENT_CLAUDE_ID, runtime: "claude_code" });
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
