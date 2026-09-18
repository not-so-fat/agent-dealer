import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-actions-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("./issues.js");
const { createRun } = await import("./runs.js");
const {
  createHumanAction,
  resolveHumanAction,
  listOpenHumanActions,
  listHumanActionsForIssue,
  findOpenHumanActionByRequestId,
} = await import("./human-actions.js");

before(() => {
  migrate();
});

function seedIssue(title: string): string {
  return createIssue({
    title,
    repo: "/repo",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

test("creates an open action and lists it globally and per-issue", () => {
  const issueId = seedIssue("Action issue 1");
  const action = createHumanAction({
    issueId,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  assert.equal(action.status, "open");
  assert.ok(listOpenHumanActions().some((a) => a.id === action.id));
  assert.deepStrictEqual(listHumanActionsForIssue(issueId).map((a) => a.id), [action.id]);
});

test("resolves an action and removes it from the open queue", () => {
  const issueId = seedIssue("Action issue 2");
  const action = createHumanAction({
    issueId,
    actionType: "final_review",
    reason: "Reviewer approved",
    question: "Accept?",
    responseOptions: ["complete", "repair", "close"],
  });
  const resolved = resolveHumanAction(action.id, "yusuke", { choice: "complete" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "yusuke");
  assert.equal(
    listOpenHumanActions().some((a) => a.id === action.id),
    false
  );
});

test("createHumanAction persists Deck's requestId and defaults to null when none is supplied (NOT-93)", () => {
  const issueId = seedIssue("Action issue 3");
  const withRequestId = createHumanAction({
    issueId,
    actionType: "deck_interaction_required",
    reason: "Control-plane decision required",
    question: "Resolve it in Agent Deck, then resume?",
    responseOptions: [{ choice: "resume", label: "Resume" }],
    requestId: "req_abc123",
  });
  assert.equal(withRequestId.requestId, "req_abc123");

  const withoutRequestId = createHumanAction({
    issueId,
    actionType: "policy_escalation",
    reason: "infra hiccup",
    question: "Resume?",
    responseOptions: [{ choice: "resume", label: "Resume" }],
  });
  assert.equal(withoutRequestId.requestId, null);
});

test("findOpenHumanActionByRequestId dedupes a repeated Deck signal to the one open action it already raised", () => {
  const issueId = seedIssue("Action issue 4");
  const action = createHumanAction({
    issueId,
    actionType: "deck_interaction_required",
    reason: "Control-plane decision required",
    question: "Resolve it in Agent Deck, then resume?",
    responseOptions: [{ choice: "resume", label: "Resume" }],
    requestId: "req_dup1",
  });

  // A repeat of the same request id on the same issue/action type finds the existing
  // open action instead of nothing (the caller uses this to skip creating a duplicate).
  const found = findOpenHumanActionByRequestId(issueId, "deck_interaction_required", "req_dup1");
  assert.equal(found?.id, action.id);

  // A different request id, action type, or issue never matches.
  assert.equal(findOpenHumanActionByRequestId(issueId, "deck_interaction_required", "req_other"), null);
  assert.equal(findOpenHumanActionByRequestId(issueId, "policy_escalation", "req_dup1"), null);
  assert.equal(findOpenHumanActionByRequestId(seedIssue("Action issue 5"), "deck_interaction_required", "req_dup1"), null);

  // Once resolved, it's no longer open — a later repeat of the same request id (a
  // genuinely new attempt reusing an old id would be a Deck bug, not Dealer's to guard)
  // must not resurrect or match the resolved row.
  resolveHumanAction(action.id, "yusuke", { choice: "resume" });
  assert.equal(findOpenHumanActionByRequestId(issueId, "deck_interaction_required", "req_dup1"), null);
});

test("the open list includes run-scoped actions that have no issue", () => {
  // NOT-71 acceptance: deleting the standalone Human actions page was only safe because the
  // Issues home lists *every* open action. A run-scoped action (outbound-draft delivery
  // parking, NOT-95) has no issue to open, so if it were missing from this list it would be
  // unreachable in the UI entirely — the gap the ticket called out by name.
  const run = createRun({
    title: "outbound draft",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    repo: "/repo",
    taskCategory: "other",
    status: "plan_pending",
  });
  const action = createHumanAction({
    runId: run.id,
    actionType: "outbound_delivery_interaction_required",
    reason: "Delivery needs a human",
    question: "Send the draft?",
    responseOptions: ["complete", "close"],
  });
  assert.equal(action.issueId, null);

  const listed = listOpenHumanActions().find((a) => a.id === action.id);
  assert.ok(listed, "run-scoped action must appear in the global open list");
  // ...and it must carry the choices the home screen resolves it with, since there is no
  // issue page to fall back to.
  assert.ok((listed.responseOptionsJson ?? "").includes("complete"));
});
