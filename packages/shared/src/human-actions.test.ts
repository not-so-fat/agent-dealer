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

test("HumanActionType also accepts the deck/reflection/delivery interaction-required types", () => {
  for (const t of ["deck_interaction_required", "reflection_interaction_required", "outbound_delivery_interaction_required"]) {
    assert.equal(HumanActionType.parse(t), t);
  }
});

test("HumanAction schema parses an open final_review action", () => {
  const action: HumanAction = {
    id: "77777777-7777-7777-7777-777777777777",
    issueId: "11111111-1111-1111-1111-111111111111",
    runId: null,
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

test("HumanAction schema parses a Run-scoped outbound_delivery_interaction_required action", () => {
  const action: HumanAction = {
    id: "77777777-7777-7777-7777-777777777779",
    issueId: null,
    runId: "22222222-2222-2222-2222-222222222222",
    workflowInstanceId: null,
    actionType: "outbound_delivery_interaction_required",
    reason: "Agent Deck requires a control-plane decision before this draft can be delivered.",
    question: "Retry the send or reject the draft?",
    evidenceJson: JSON.stringify({ draftArtifactId: "33333333-3333-3333-3333-333333333333" }),
    responseOptionsJson: JSON.stringify(["retry_send", "reject"]),
    continuationPreviewJson: null,
    requestId: "req_1",
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
  };
  assert.deepStrictEqual(HumanAction.parse(action), action);
});
