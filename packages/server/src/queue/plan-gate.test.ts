import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-gate-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const { addArtifact, createRun, getLatestArtifact, getRun } = await import("../repository/runs.js");
const { applyPlanGate, getSnapshot } = await import("./dispatcher.js");

const QUESTIONS = [
  { id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] },
];

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedRun(triage: Record<string, unknown>) {
  const run = createRun({
    title: "Gate test",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  addArtifact(run.id, "draft_plan", { markdown: "# Plan" }, "agent");
  addArtifact(run.id, "plan_triage", triage, "agent");
  return getRun(run.id)!;
}

test("trivial triage auto-approves: system approved_plan + plan_approved status", () => {
  const run = seedRun({ verdict: "trivial", rationale: "tiny", questions: [], parseFallback: false, consumed: false });
  assert.equal(applyPlanGate(run), "auto_approve");
  assert.equal(getRun(run.id)!.status, "plan_approved");
  const approved = getLatestArtifact(run.id, "approved_plan");
  assert.equal(approved!.author, "system");
  assert.match(approved!.contentJson!, /tiny/);
});

test("questions await answers and leave status untouched", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r", questions: QUESTIONS, parseFallback: false, consumed: false });
  assert.equal(applyPlanGate(run), "await_answers");
  assert.equal(getRun(run.id)!.status, "plan_pending");
});

test("third question round goes to manual review", () => {
  const run = seedRun({ verdict: "needs_review", rationale: "r1", questions: QUESTIONS, parseFallback: false, consumed: false });
  addArtifact(run.id, "plan_triage", { verdict: "needs_review", rationale: "r2", questions: QUESTIONS, parseFallback: false, consumed: false }, "agent");
  addArtifact(run.id, "plan_triage", { verdict: "needs_review", rationale: "r3", questions: QUESTIONS, parseFallback: false, consumed: false }, "agent");
  assert.equal(applyPlanGate(getRun(run.id)!), "await_review");
});

test("snapshot exposes awaitingAnswerRuns, openQuestionCounts, autoApprovedRunIds", () => {
  const snap = getSnapshot();
  assert.equal(Array.isArray(snap.awaitingAnswerRuns), true);
  assert.equal(typeof snap.openQuestionCounts, "object");
  assert.equal(Array.isArray(snap.autoApprovedRunIds), true);
});
