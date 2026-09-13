import { test } from "node:test";
import assert from "node:assert/strict";
import { HumanAction, HumanActionType } from "./human-actions.js";

test("HumanActionType accepts exactly the PRD's four action types", () => {
  const types = ["product_scope_decision", "policy_escalation", "attempts_exhausted", "final_review"];
  for (const t of types) {
    assert.equal(HumanActionType.parse(t), t);
  }
  assert.throws(() => HumanActionType.parse("plan_approval"));
});

test("HumanAction schema parses an open final_review action", () => {
  const action: HumanAction = {
    id: "77777777-7777-7777-7777-777777777777",
    issueId: "11111111-1111-1111-1111-111111111111",
    workflowInstanceId: "55555555-5555-5555-5555-555555555555",
    actionType: "final_review",
    reason: "Reviewer approved the PR",
    question: "Accept this work?",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify(["complete", "repair", "close"]),
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
  };
  assert.deepStrictEqual(HumanAction.parse(action), action);
});
