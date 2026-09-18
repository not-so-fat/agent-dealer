import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-prompts-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { addArtifact, createRun } = await import("../repository/runs.js");
const { buildReflectPrompt } = await import("./prompts.js");

before(() => {
  migrate();
});

function makeRun() {
  return createRun({
    title: "Prompt test task",
    taskCategory: "other",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID});
}

test("reflect prompt restates the task and the read-only patch contract", () => {
  const prompt = buildReflectPrompt(makeRun(), { trigger: "approve" });
  assert.match(prompt, /Prompt test task/);
  assert.match(prompt, /do NOT call update_playbook or propose_playbook_patch/);
  assert.match(prompt, /"rationale"/);
  assert.match(prompt, /Human approved this run without retry feedback/);
});

test("reflect prompt carries the plan and execution artifacts when they exist", () => {
  const run = makeRun();
  addArtifact(run.id, "approved_plan", { markdown: "# Plan\n1. Use SQLite" }, "human");
  addArtifact(
    run.id,
    "execution_result",
    { phase: "execute", exitCode: 0, resultText: "Wrote the doc", isError: false },
    "agent"
  );

  const prompt = buildReflectPrompt(run, { trigger: "approve" });
  assert.match(prompt, /## Approved plan/);
  assert.match(prompt, /Use SQLite/);
  assert.match(prompt, /## Execution outcome/);
  assert.match(prompt, /Wrote the doc/);
});

test("retry reflect prompt prefers the explicit feedback over the stored artifact", () => {
  const run = makeRun();
  addArtifact(run.id, "feedback", { markdown: "Stored feedback" }, "human");

  const prompt = buildReflectPrompt(run, { trigger: "retry", feedback: "Tighten the summary" });
  assert.match(prompt, /## Human feedback \(highest signal\)/);
  assert.match(prompt, /Tighten the summary/);
  assert.doesNotMatch(prompt, /Stored feedback/);
});

test("retry reflect prompt falls back to the run's own human feedback artifact", () => {
  const run = makeRun();
  addArtifact(run.id, "feedback", { markdown: "Stored feedback" }, "human");

  const prompt = buildReflectPrompt(run, { trigger: "retry" });
  assert.match(prompt, /Stored feedback/);
});
