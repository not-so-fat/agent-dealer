import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-qa-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, getRun, transitionRun, updateRunFields } =
  await import("../repository/runs.js");
const { listQaExchanges, hasPendingQaExchange } = await import("../repository/result-qa.js");
const { askResultQuestion } = await import("./result-qa.js");

const USAGE = { phase: "qa" as const, runtime: "claude_code" as const, totalCostUsd: 0.02 };

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedReviewRun(opts?: { session?: string }) {
  const run = createRun({
    title: "QA test",
    taskCategory: "other",
    status: "plan_approved",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  if (opts?.session) {
    addArtifact(run.id, "agent_session", { phase: "execute", runtime: "claude_code", sessionId: opts.session }, "agent");
  }
  transitionRun(run.id, "running");
  transitionRun(run.id, "review");
  return getRun(run.id)!;
}

/** Resolves the async answer job before asserting. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

test("asking persists a pending exchange, then an answered one with the same exchangeId", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  let sawSession: string | null = "unset";
  const res = askResultQuestion(run.id, "Why SQLite?", {
    runner: async (_run, _q, resumeSessionId) => {
      sawSession = resumeSessionId;
      return { ok: true, answer: "Single-process.", usage: USAGE };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.ok && res.exchange.status, "pending");
  assert.equal(listQaExchanges(run.id)[0].status, "pending");

  await settle();

  assert.equal(sawSession, "sess-exec");
  const thread = listQaExchanges(run.id);
  assert.equal(thread.length, 1, "append-only exchanges collapse by exchangeId");
  assert.equal(thread[0].status, "answered");
  assert.equal(thread[0].answer, "Single-process.");
  assert.equal(thread[0].sessionResumed, true);
  assert.ok(thread[0].answeredAt);
  assert.equal(getLatestArtifact(run.id, "usage")!.contentJson!.includes('"phase":"qa"'), true);
});

test("missing execute session answers ungrounded and flags sessionResumed false", async () => {
  const run = seedReviewRun();
  askResultQuestion(run.id, "What did you check?", {
    runner: async () => ({ ok: true, answer: "The tests.", usage: USAGE }),
  });
  await settle();
  const thread = listQaExchanges(run.id);
  assert.equal(thread[0].sessionResumed, false);
  assert.equal(thread[0].status, "answered");
});

test("runner failure records a failed exchange and never changes run status", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "Why?", {
    runner: async () => ({ ok: false, answer: "", error: "qa exited 1", usage: USAGE }),
  });
  await settle();
  const thread = listQaExchanges(run.id);
  assert.equal(thread[0].status, "failed");
  assert.equal(thread[0].error, "qa exited 1");
  assert.equal(getRun(run.id)!.status, "review");
});

test("runner throwing records a failed exchange", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "Why?", {
    runner: async () => { throw new Error("spawn ENOENT"); },
  });
  await settle();
  assert.match(listQaExchanges(run.id)[0].error!, /spawn ENOENT/);
});

test("a second question while one is pending returns 409", () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "First?", { runner: () => new Promise(() => {}) });
  const second = askResultQuestion(run.id, "Second?", { runner: async () => ({ ok: true, answer: "x", usage: USAGE }) });
  assert.equal(!second.ok && second.code, 409);
});

test("asking a done run is allowed", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  transitionRun(run.id, "done");
  const res = askResultQuestion(run.id, "Post-hoc?", {
    runner: async () => ({ ok: true, answer: "Sure.", usage: USAGE }),
  });
  assert.equal(res.ok, true);
  await settle();
  assert.equal(listQaExchanges(run.id)[0].status, "answered");
});

test("asking a running run returns 409", () => {
  const run = createRun({
    title: "Still running",
    taskCategory: "other",
    status: "plan_approved",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  transitionRun(run.id, "running");
  const res = askResultQuestion(run.id, "Why?", { runner: async () => ({ ok: true, answer: "x", usage: USAGE }) });
  assert.equal(!res.ok && res.code, 409);
});

test("whitespace-only question is rejected before spending anything", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  let runnerCalled = false;
  const res = askResultQuestion(run.id, "   ", {
    runner: async () => { runnerCalled = true; return { ok: true, answer: "x", usage: USAGE }; },
  });
  assert.equal(!res.ok && res.code, 400);
  await settle();
  assert.equal(runnerCalled, false, "no paid agent call");
  assert.equal(listQaExchanges(run.id).length, 0, "no artifact persisted");
  assert.equal(hasPendingQaExchange(run.id), false, "pending lock not corrupted");
});

test("a persisted exchange always round-trips through the content schema", async () => {
  const run = seedReviewRun({ session: "sess-exec" });
  askResultQuestion(run.id, "  Why SQLite?  ", {
    runner: async () => ({ ok: true, answer: "Single-process.", usage: USAGE }),
  });
  await settle();
  const thread = listQaExchanges(run.id);
  assert.equal(thread.length, 1, "exchange is visible, i.e. it parsed");
  assert.equal(thread[0].question, "Why SQLite?", "stored trimmed");
});

test("unknown run returns 404", () => {
  const res = askResultQuestion("00000000-0000-4000-a000-0000000000ff", "Why?");
  assert.equal(!res.ok && res.code, 404);
});

test("cursor runtime is allowed", () => {
  const run = seedReviewRun({ session: "sess-exec" });
  updateRunFields(run.id, { runtime: "cursor_local" });
  const res = askResultQuestion(run.id, "Why?", { runner: async () => ({ ok: true, answer: "x", usage: USAGE }) });
  assert.equal(res.ok, true);
});
