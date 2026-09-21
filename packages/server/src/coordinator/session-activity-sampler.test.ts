// packages/server/src/coordinator/session-activity-sampler.test.ts
//
// NOT-170: sampler persistence tests — the extended activity sampler writes one row per
// new structured event on its existing tick (no second loop), repeated identical ticks
// create no duplicates, restart resumes from the durable offset, and stop() flushes
// events written after the last tick.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sampler-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { listSessionActivityEvents } = await import("../repository/session-activity.js");
const { startActivitySampler } = await import("./session-progress.js");

let issueId: string;

before(() => {
  migrate();
  issueId = createIssue({
    title: "Sampler host issue",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
});

function makeLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sampler-log-"));
  return path.join(dir, "session.ndjson");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("sampler persists new structured events and ignores repeat ticks", async () => {
  const logPath = makeLog();
  const sessionId = `sess-${Date.now()}-a`;
  fs.writeFileSync(
    logPath,
    [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Running the test suite now" }] } }),
      "this line is not json",
    ].join("\n") + "\n"
  );
  const sampler = startActivitySampler({ issueId, role: "developer", round: 1, logPath, workerSessionId: sessionId, intervalMs: 30 });
  await sleep(150);
  sampler.stop();
  const rows = listSessionActivityEvents(sessionId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.activityKind), ["tool_started", "assistant_output"]);
  assert.equal(rows[0]!.callId, "tu_1");
  assert.ok(rows[0]!.summary && rows[0]!.summary.length <= 120);
  assert.ok(rows.every((r) => r.rawEvidence?.includes("#offset=")));
});

test("restart resumes from the durable offset without duplicates", async () => {
  const logPath = makeLog();
  const sessionId = `sess-${Date.now()}-b`;
  const line1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash" }] } }) + "\n";
  fs.writeFileSync(logPath, line1);
  const first = startActivitySampler({ issueId, role: "developer", round: 1, logPath, workerSessionId: sessionId, intervalMs: 30 });
  await sleep(120);
  first.stop();
  assert.equal(listSessionActivityEvents(sessionId).length, 1);

  // Restart after a Claude tool_result line was appended: only the completion is new.
  fs.appendFileSync(
    logPath,
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } }) + "\n"
  );
  const second = startActivitySampler({ issueId, role: "developer", round: 1, logPath, workerSessionId: sessionId, intervalMs: 30 });
  await sleep(120);
  second.stop();
  const rows = listSessionActivityEvents(sessionId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.activityKind), ["tool_started", "tool_completed"]);
  assert.equal(rows[1]!.callId, "tu_1");
});

test("stop() flushes events written after the last tick", () => {
  const logPath = makeLog();
  const sessionId = `sess-${Date.now()}-c`;
  fs.writeFileSync(logPath, "");
  // Interval far in the future: no tick fires before stop(); only the final flush runs.
  const sampler = startActivitySampler({ issueId, role: "developer", round: 1, logPath, workerSessionId: sessionId, intervalMs: 60_000 });
  fs.writeFileSync(
    logPath,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_7", name: "Read" }] } }) + "\n"
  );
  sampler.stop();
  const rows = listSessionActivityEvents(sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.activityKind, "tool_started");
});

test("sampler without a session id only refreshes intent and persists nothing", async () => {
  const logPath = makeLog();
  fs.writeFileSync(
    logPath,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }) + "\n"
  );
  const sampler = startActivitySampler({ issueId, role: "developer", round: 1, logPath, intervalMs: 30 });
  await sleep(100);
  sampler.stop();
  // Nothing persisted anywhere for this log: no session rows exist at all.
  assert.equal(listSessionActivityEvents("sess-never-created").length, 0);
});
