// packages/server/src/coordinator/session-progress.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-progress-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { startWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
const {
  deriveActivityFromLog,
  deriveLiveProgressFromLog,
  emitSessionMilestone,
  firstCommitFromHead,
  shortWorktreePath,
  startActivitySampler,
  taskBriefIsComplete,
  workerSessionPayload} = await import("./session-progress.js");

function writeLog(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-progress-log-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return logPath;
}

before(() => migrate());

test("shortWorktreePath keeps the last two segments", () => {
  assert.equal(shortWorktreePath("/Users/me/.agent-dealer/worktrees/abc-developer"), "worktrees/abc-developer");
  assert.equal(shortWorktreePath(null), null);
});

test("taskBriefIsComplete requires both description and acceptance criteria", () => {
  assert.equal(taskBriefIsComplete({ description: "do it", acceptanceCriteria: "done" }), true);
  assert.equal(taskBriefIsComplete({ description: "do it", acceptanceCriteria: "  " }), false);
  assert.equal(taskBriefIsComplete({ description: "", acceptanceCriteria: "done" }), false);
});

test("workerSessionPayload includes runtime/model/session id", () => {
  assert.deepEqual(
    workerSessionPayload({
      runtime: "cursor_local",
      model: "composer",
      sessionId: "11111111-1111-1111-1111-111111111111",
      worktreePath: "/tmp/wt/issue-1"}),
    {
      runtime: "cursor_local",
      model: "composer",
      sessionId: "11111111-1111-1111-1111-111111111111",
      worktreePath: "wt/issue-1"}
  );
});

test("deriveActivityFromLog maps recent tool names to operator labels", () => {
  const logPath = writeLog([
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Shell" }] } },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Shell", input: { command: "npm test" } }] }},
  ]);
  // Last event is a Shell tool with npm test → concrete test progress
  assert.match(deriveActivityFromLog(logPath)!, /Running tests:/i);
});

test("deriveLiveProgressFromLog returns null for missing or empty logs", () => {
  assert.equal(deriveLiveProgressFromLog("/no/such/session.ndjson"), null);
  assert.equal(deriveLiveProgressFromLog(writeLog([{ type: "system", subtype: "init" }])), null);
});

test("deriveLiveProgressFromLog surfaces Cursor nested tool_call with file path", () => {
  const logPath = writeLog([
    {
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      tool_call: { readToolCall: { args: { path: "apps/web/src/pages/IssueDetailPage.tsx" } } }},
  ]);
  assert.equal(deriveLiveProgressFromLog(logPath), "Reading IssueDetailPage.tsx");
});

test("deriveLiveProgressFromLog surfaces Cursor shell / test commands", () => {
  const logPath = writeLog([
    {
      type: "tool_call",
      subtype: "started",
      call_id: "c2",
      tool_call: {
        shellToolCall: {
          args: { command: "npm test -- packages/server/src/coordinator/failure-reason.test.ts" }}}},
  ]);
  const progress = deriveLiveProgressFromLog(logPath);
  assert.ok(progress);
  assert.match(progress!, /Running tests:/i);
  assert.match(progress!, /failure-reason/);
});

test("deriveLiveProgressFromLog prefers recent tool over tiny assistant token fragments", () => {
  const logPath = writeLog([
    {
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      tool_call: { grepToolCall: { args: { pattern: "liveProgress" } } }},
    { type: "assistant", message: { content: [{ type: "text", text: "I'll" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: " fix" }] } },
  ]);
  assert.equal(deriveLiveProgressFromLog(logPath), "Searching: liveProgress");
});

test("deriveLiveProgressFromLog coalesces a meaningful assistant sentence", () => {
  const logPath = writeLog([
    { type: "assistant", message: { content: [{ type: "text", text: "Addressing Lens FIX findings" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: " and rechecking the flaky test." }] } },
  ]);
  assert.equal(
    deriveLiveProgressFromLog(logPath),
    "Addressing Lens FIX findings and rechecking the flaky test."
  );
});

test("deriveLiveProgressFromLog truncates long progress to one readable line", () => {
  const long =
    "Implementing the live progress strip by parsing the session NDJSON tail for assistant " +
    "sentences and tool arguments so operators can see concrete work without opening the log file.";
  const logPath = writeLog([
    { type: "assistant", message: { content: [{ type: "text", text: long }] } },
  ]);
  const progress = deriveLiveProgressFromLog(logPath);
  assert.ok(progress);
  assert.ok(progress!.length <= 120, `expected <=120 chars, got ${progress!.length}`);
  assert.ok(!progress!.includes("\n"));
  assert.match(progress!, /\u2026$|…$/);
});

test("deriveLiveProgressFromLog surfaces Cursor editToolCall path", () => {
  const logPath = writeLog([
    {
      type: "tool_call",
      subtype: "started",
      tool_call: {
        editToolCall: { args: { path: "apps/web/src/pages/IssueDetailPage.tsx", streamContent: "…" } }}},
  ]);
  assert.equal(deriveLiveProgressFromLog(logPath), "Editing IssueDetailPage.tsx");
});

test("deriveLiveProgressFromLog surfaces Cursor globPattern", () => {
  const logPath = writeLog([
    {
      type: "tool_call",
      subtype: "started",
      tool_call: { globToolCall: { args: { globPattern: "apps/web/src/pages/*.tsx" } } }},
  ]);
  assert.equal(deriveLiveProgressFromLog(logPath), "Finding files: apps/web/src/pages/*.tsx");
});

test("deriveLiveProgressFromLog reads the committed Cursor fixture", async () => {
  const { fileURLToPath } = await import("node:url");
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../runners/fixtures/cursor-success-with-infra-attempt-limit-text.ndjson"
  );
  const progress = deriveLiveProgressFromLog(fixture);
  // Fixture ends with result; last concrete signal is the read tool or the assistant sentence.
  assert.ok(progress);
  assert.match(progress!, /routing\.ts|infra-attempt|Looking at routing/i);
});

test("emitSessionMilestone appends a role-attributed event and refreshes currentIntent", () => {
  const issue = createIssue({
    title: "Progress",
    description: "Ship visibility",
    acceptanceCriteria: "Operators see last progress",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    source: "manual"});
  const instance = startWorkflowInstance(issue.id, "dev_reviewer_v1");
  transitionIssue(issue.id, "developing", {
    currentOwner: "developer",
    currentIntent: "Developer implementing round 1"});
  const session = createWorkerSession({
    issueId: issue.id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "cursor_local"});
  startSession(session.id);

  emitSessionMilestone({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    role: "developer",
    stage: "developing",
    round: 1,
    type: "worktree.ready",
    intent: "Developer · worktree ready (round 1)",
    payload: { worktreePath: "wt/x" }});

  const events = listWorkflowEventsForIssue(issue.id);
  const milestone = events.find((e) => e.type === "worktree.ready");
  assert.ok(milestone);
  assert.equal(milestone!.actorType, "developer");
  assert.equal(getIssue(issue.id)!.currentIntent, "Developer · worktree ready (round 1)");
});

test("firstCommitFromHead fires only on a first HEAD difference from the input SHA", () => {
  const sha = "a".repeat(40);
  assert.equal(firstCommitFromHead(sha, "b".repeat(40), false), sha);
  assert.equal(firstCommitFromHead(sha, sha, false), null, "unchanged HEAD is not a commit");
  assert.equal(firstCommitFromHead(sha, null, false), null, "no input SHA to diff against");
  assert.equal(firstCommitFromHead(null, "b".repeat(40), false), null, "unresolvable HEAD");
  assert.equal(firstCommitFromHead(sha, "b".repeat(40), true), null, "already recorded fires once");
});

test("NOT-172: the sampler records the first commit once across ticks (read-only check)", async () => {
  const seen: Array<{ observedSha: string; observedAt: string }> = [];
  let head = "b".repeat(40);
  let reads = 0;
  const sampler = startActivitySampler({
    issueId: "11111111-1111-1111-1111-111111111111",
    role: "developer",
    round: 1,
    logPath: path.join(os.tmpdir(), "dealer-progress-no-such-log.ndjson"),
    intervalMs: 15,
    headCheck: {
      inputSha: "b".repeat(40),
      readHead: async () => {
        reads++;
        return head;
      },
      onCommit: (evidence) => {
        seen.push(evidence);
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(seen.length, 0, "unchanged HEAD records nothing");
    head = "a".repeat(40);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(seen.length, 1, "first difference records once across ticks");
    assert.equal(seen[0]!.observedSha, "a".repeat(40));
    assert.ok(Date.parse(seen[0]!.observedAt) > 0, "observation timestamp is a real time");
    head = "c".repeat(40);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(seen.length, 1, "later commits do not re-fire");
    assert.ok(reads >= 3, "the read-only check keeps sampling");
  } finally {
    sampler.stop();
  }
});

test("NOT-172: the sampler head check never fires without an input SHA and survives read failures", async () => {
  const seen: Array<{ observedSha: string; observedAt: string }> = [];
  let calls = 0;
  const sampler = startActivitySampler({
    issueId: "11111111-1111-1111-1111-111111111111",
    role: "developer",
    round: 1,
    logPath: path.join(os.tmpdir(), "dealer-progress-no-such-log.ndjson"),
    intervalMs: 15,
    headCheck: {
      inputSha: null,
      readHead: async () => {
        calls++;
        if (calls === 1) throw new Error("git unavailable");
        return "a".repeat(40);
      },
      onCommit: (evidence) => {
        seen.push(evidence);
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(seen.length, 0, "no input SHA means no diff is defensible");
    assert.ok(calls >= 2, "a failed read retries on the next tick without throwing");
  } finally {
    sampler.stop();
  }
});
