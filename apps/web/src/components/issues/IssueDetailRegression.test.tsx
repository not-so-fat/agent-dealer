// NOT-174 regression: the existing Issue Detail strips (live/failure vocabulary,
// timeline labels, status badges) keep working alongside Execution analysis.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowEvent } from "@agent-dealer/shared";
import IssueTimeline from "./IssueTimeline.js";
import IssueStatusBadge from "./IssueStatusBadge.js";

function event(extra: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: "evt-1",
    issueId: "issue-1",
    workflowInstanceId: null,
    type: "worker.failed",
    actorType: "developer",
    actorRef: "agent-1",
    round: 1,
    workerSessionId: null,
    stage: "developing",
    idempotencyKey: null,
    causationEventId: null,
    ts: "2026-09-20T10:00:00.000Z",
    payloadJson: null,
    artifactRef: null,
    ...extra,
  };
}

test("empty timeline keeps its empty state", () => {
  const html = renderToStaticMarkup(<IssueTimeline events={[]} />);
  assert.match(html, /No activity yet/);
});

test("worker failed/started events keep role-aware labels", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({ id: "a", type: "worker.failed", round: 2 }),
        event({ id: "b", type: "worker.started", actorType: "reviewer", round: 1 }),
        event({ id: "c", type: "workflow.started", actorType: "system", actorRef: null }),
      ]}
    />
  );
  assert.match(html, /Developer failed \(round 2\)/);
  assert.match(html, /Reviewer started \(round 1\)/);
  assert.match(html, /Workflow started/);
});

test("deck-unavailable deferral still reads as waiting, not a worker problem", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({
          id: "d",
          type: "worker.deferred",
          payloadJson: JSON.stringify({ outcome: "deck_unavailable" }),
        }),
      ]}
    />
  );
  assert.match(html, /Waiting for Agent Deck/);
});

test("review verdicts keep their handoff rendering", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({
          id: "r",
          type: "review.submitted",
          actorType: "reviewer",
          payloadJson: JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "major" }] }),
        }),
      ]}
    />
  );
  assert.match(html, /changes requested/);
  assert.match(html, /1 finding/);
});

test("status badges keep every status label", () => {
  const cases = [
    ["ready", "Ready"],
    ["developing", "Developing"],
    ["reviewing", "Reviewing"],
    ["repairing", "Repairing"],
    ["final_review", "Final review"],
    ["needs_human", "Needs human"],
    ["done", "Done"],
    ["closed", "Closed"],
  ] as const;
  for (const [status, label] of cases) {
    const html = renderToStaticMarkup(<IssueStatusBadge status={status} />);
    assert.match(html, new RegExp(label), `badge for ${status}`);
  }
});
