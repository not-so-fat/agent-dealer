import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEvent, WorkflowEventType, WorkflowInstance } from "./workflow.js";

test("WorkflowInstance schema parses a running instance", () => {
  const instance: WorkflowInstance = {
    id: "55555555-5555-5555-5555-555555555555",
    issueId: "11111111-1111-1111-1111-111111111111",
    workflowVersion: "dev_reviewer_v1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    outcome: null,
  };
  assert.deepStrictEqual(WorkflowInstance.parse(instance), instance);
});

test("WorkflowEventType accepts every PRD §9.2 event type", () => {
  const types = [
    "issue.created",
    "workflow.started",
    "worker.started",
    "worker.completed",
    "worker.failed",
    "worktree.ready",
    "deck.connected",
    "brief.resolved",
    "branch.pushed",
    "checks.started",
    "pull_request.opened",
    "pull_request.updated",
    "checks.completed",
    "review.submitted",
    "repair.started",
    "guidance.added",
    "human_action.requested",
    "human_action.resolved",
    "final_review.requested",
    "issue.completed",
    "issue.closed",
    "queue.enqueued",
    "queue.wait_reason_changed",
    "queue.admitted",
    "queue.removed",
    "checkpoint.observed",
    "retry.reused",
  ];
  for (const t of types) {
    assert.equal(WorkflowEventType.parse(t), t);
  }
});

test("WorkflowEvent allows a nullable workflow_instance_id for pre-workflow guidance", () => {
  const event: WorkflowEvent = {
    id: "66666666-6666-6666-6666-666666666666",
    issueId: "11111111-1111-1111-1111-111111111111",
    workflowInstanceId: null,
    workerSessionId: null,
    type: "guidance.added",
    actorType: "human",
    actorRef: "yusuke",
    stage: "ready",
    round: null,
    payloadJson: JSON.stringify({ markdown: "please prioritize the login bug" }),
    artifactRef: null,
    idempotencyKey: null,
    causationEventId: null,
    ts: new Date().toISOString(),
  };
  assert.deepStrictEqual(WorkflowEvent.parse(event), event);
});
