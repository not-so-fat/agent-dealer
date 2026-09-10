import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHumanActionOutcome } from "./human-resolution.js";

test("final_review complete marks the issue done and triggers reflect", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "complete" });
  assert.equal(result.issueStatus, "done");
  assert.equal(result.workflowOutcome, "done");
  assert.equal(result.triggerReflect, true);
});

test("final_review repair sends the issue back for another round without reflect", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "repair" });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
  assert.equal(result.triggerReflect, undefined);
});

test("final_review close closes the workflow without accepting the work", () => {
  const result = resolveHumanActionOutcome({ actionType: "final_review", choice: "close" });
  assert.equal(result.issueStatus, "closed");
  assert.equal(result.workflowOutcome, "closed");
  assert.equal(result.triggerReflect, undefined);
});

test("attempts_exhausted retry starts a new round (v1: equivalent to another repair round)", () => {
  const result = resolveHumanActionOutcome({ actionType: "attempts_exhausted", choice: "retry" });
  assert.equal(result.issueStatus, "repairing");
  assert.equal(result.startNewRound, true);
});

test("attempts_exhausted close ends the issue", () => {
  const result = resolveHumanActionOutcome({ actionType: "attempts_exhausted", choice: "close" });
  assert.equal(result.issueStatus, "closed");
});

test("policy_escalation resume continues development", () => {
  const result = resolveHumanActionOutcome({ actionType: "policy_escalation", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
  assert.equal(result.startNewRound, true);
});

test("product_scope_decision resume continues development from the pre-start gate", () => {
  const result = resolveHumanActionOutcome({ actionType: "product_scope_decision", choice: "resume" });
  assert.equal(result.issueStatus, "developing");
});
