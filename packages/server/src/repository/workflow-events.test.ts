import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-events-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { appendWorkflowEvent, listWorkflowEventsForIssue, listGuidanceMarkdownForIssue, eventCursor } =
  await import("./workflow-events.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual"}).id;
}

test("appends and lists events in timestamp order", () => {
  const issueId = seedIssue("Event issue");
  appendWorkflowEvent({
    issueId,
    type: "issue.created",
    actorType: "system",
    stage: "ready",
    payload: { note: "created" }});
  appendWorkflowEvent({
    issueId,
    type: "guidance.added",
    actorType: "human",
    stage: "ready"});
  const events = listWorkflowEventsForIssue(issueId);
  assert.deepStrictEqual(events.map((e) => e.type), ["issue.created", "guidance.added"]);
  assert.deepStrictEqual(JSON.parse(events[0].payloadJson!), { note: "created" });
});

test("a repeated idempotency key does not create a duplicate event", () => {
  const issueId = seedIssue("Idempotent issue");
  const first = appendWorkflowEvent({
    issueId,
    type: "pull_request.updated",
    actorType: "system",
    stage: "developing",
    idempotencyKey: "gh-delivery-abc123"});
  const second = appendWorkflowEvent({
    issueId,
    type: "pull_request.updated",
    actorType: "system",
    stage: "developing",
    idempotencyKey: "gh-delivery-abc123"});
  assert.equal(second.id, first.id);
  assert.equal(listWorkflowEventsForIssue(issueId).length, 1);
});

test("listGuidanceMarkdownForIssue returns only guidance added after the cutoff cursor", () => {
  // No sleeps: the cursor is a rowid, not a timestamp, so it must not depend on wall-clock
  // spacing between events (see eventCursor's doc comment — this is the exact collision a
  // ts-based cutoff got wrong in review).
  const issueId = seedIssue("Guidance issue");
  const before = appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing", payload: { markdown: "Before cutoff" } });
  const cutoff = eventCursor(before.id);
  const after = appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing", payload: { markdown: "After cutoff" } });

  assert.deepStrictEqual(listGuidanceMarkdownForIssue(issueId, cutoff), ["After cutoff"]);
  assert.deepStrictEqual(listGuidanceMarkdownForIssue(issueId, null), ["Before cutoff", "After cutoff"]);
  assert.deepStrictEqual(listGuidanceMarkdownForIssue(issueId, null, cutoff), ["Before cutoff"]);
  assert.deepStrictEqual(listGuidanceMarkdownForIssue(issueId, null, eventCursor(after.id)), ["Before cutoff", "After cutoff"]);
});

test("eventCursor is strictly increasing in insertion order and unknown ids return null", () => {
  const issueId = seedIssue("Cursor issue");
  const first = appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing" });
  const second = appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "developing" });
  assert.ok(eventCursor(first.id)! < eventCursor(second.id)!);
  assert.equal(eventCursor("does-not-exist"), null);
});

test("listGuidanceMarkdownForIssue ignores non-guidance events and malformed payloads", () => {
  const issueId = seedIssue("Guidance malformed issue");
  appendWorkflowEvent({ issueId, type: "issue.created", actorType: "system", stage: "ready" });
  appendWorkflowEvent({ issueId, type: "guidance.added", actorType: "human", stage: "ready" }); // no payload
  assert.deepStrictEqual(listGuidanceMarkdownForIssue(issueId, null), []);
});
