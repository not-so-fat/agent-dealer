import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutboundToolCall } from "@agent-dealer/shared";
import type { DeliverOutboundResult } from "../adapters/outbound-delivery.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-send-gate-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const {
  addArtifact,
  createRun,
  getLatestArtifact,
  getRun,
  transitionRun,
  updateRunFields} = await import("../repository/runs.js");
const { approveRunWithDeliver, resolveOutboundDeliveryAction, resolveOpenDeliveryParkForRun } = await import(
  "./approve-deliver.js"
);
const { rejectPendingOutboundDrafts, pendingSendCount, incrementOutboundDeliveryAttempt } = await import(
  "../repository/outbound-drafts.js"
);
const { findOpenHumanActionForRun, listHumanActionsForRun, getHumanAction } = await import("../repository/human-actions.js");

const DECK = "6e825b59-13de-4ddd-ab7e-55ab5a1c279a";

const TOOL_CALL: OutboundToolCall = {
  serviceName: "34eb6c24-f151-4da2-8db8-d6996aa296be",
  toolName: "chat_postMessage",
  arguments: { channel: "C1", text: "Hello gate test" }};

const DRAFT_CONTENT = {
  draft: {
    actionType: "slack_message" as const,
    summary: { target: "#test", body: "Hello gate test" },
    toolCall: TOOL_CALL},
  status: "pending" as const};

before(() => {
  migrate();
});

function seedReviewRun(withDraft = true) {
  const run = createRun({
    title: "Send gate test",
    taskCategory: "communication",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID});
  updateRunFields(run.id, { deck_id: DECK });
  transitionRun(run.id, "plan_approved");
  transitionRun(run.id, "running");
  transitionRun(run.id, "review");
  if (withDraft) {
    addArtifact(run.id, "slack_draft", DRAFT_CONTENT, "agent");
  }
  return getRun(run.id)!;
}

test("pendingSendCount is 1 when draft pending", () => {
  const run = seedReviewRun(true);
  assert.equal(pendingSendCount(run.id), 1);
});

test("approve without draft transitions to done", async () => {
  const run = seedReviewRun(false);
  const res = await approveRunWithDeliver(run.id);
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, false);
  assert.equal(getRun(run.id)!.status, "done");
});

test("approve delivers under the run deckId and records a receipt", async () => {
  const run = seedReviewRun(true);
  let capturedDeck: string | null = null;
  let captured: OutboundToolCall | null = null;
  const res = await approveRunWithDeliver(run.id, {
    deliver: async (deckId, toolCall): Promise<DeliverOutboundResult> => {
      capturedDeck = deckId;
      captured = toolCall;
      return { ok: true, toolResult: { ok: true }, permalink: "https://slack.example/msg/1" };
    }});
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
  assert.equal(capturedDeck, DECK);
  assert.deepEqual(captured, TOOL_CALL);
  assert.equal(getRun(run.id)!.status, "done");
  assert.ok(getLatestArtifact(run.id, "send_receipt"));
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"sent"/);
});

test("approve with human-edited body sends updated payload", async () => {
  const run = seedReviewRun(true);
  let captured: OutboundToolCall | null = null;
  const res = await approveRunWithDeliver(run.id, {
    outboundBody: "Human tweak before send",
    deliver: async (_deckId, toolCall) => {
      captured = toolCall;
      return { ok: true, toolResult: { ok: true } };
    }});
  assert.equal(res.ok, true);
  assert.deepEqual(captured, {
    ...TOOL_CALL,
    arguments: { ...TOOL_CALL.arguments, text: "Human tweak before send" }});
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /Human tweak before send/);
});

test("deliver infra failure keeps run in review with pending draft, no park", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    deliver: async (): Promise<DeliverOutboundResult> => ({ ok: false, kind: "infra_failure", reason: "deck down" })});
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, 502);
  assert.equal(!res.ok && res.errorCode, "DELIVERY_FAILED");
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  assert.equal(findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required"), null);
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"pending"/);
});

test("off-scope/provider denial surfaces as an ordinary delivery failure, not parked", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    deliver: async (): Promise<DeliverOutboundResult> => ({
      ok: false,
      kind: "infra_failure",
      reason: "RESOURCE_OUT_OF_SCOPE: tool not in authority's allowed set"})});
  assert.equal(res.ok, false);
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required"), null);
  assert.ok(!getLatestArtifact(run.id, "send_receipt"));
});

test("deliver returning ambiguous parks the run: draft pending, run in review, one open action", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    deliver: async (): Promise<DeliverOutboundResult> => ({
      ok: false,
      kind: "ambiguous",
      reason: "Outbound deliver timed out after 60000ms — whether the message was actually sent is unknown"})});
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.errorCode, "AMBIGUOUS_RESULT");
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  const action = findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required");
  assert.ok(action);
  assert.equal(action!.runId, run.id);
  assert.deepEqual(JSON.parse(action!.responseOptionsJson!), [
    { choice: "retry_send", label: "Retry send" },
    { choice: "reject", label: "Reject draft" },
  ]);
});

test("a repeated ambiguous signal dedupes to one action", async () => {
  const run = seedReviewRun(true);
  const deps = {
    deliver: async (): Promise<DeliverOutboundResult> => ({
      ok: false,
      kind: "ambiguous" as const,
      reason: "timeout — whether the message was actually sent is unknown"})};
  await approveRunWithDeliver(run.id, deps);
  await approveRunWithDeliver(run.id, deps);
  const actions = listHumanActionsForRun(run.id).filter((a) => a.actionType === "outbound_delivery_interaction_required");
  assert.equal(actions.length, 1);
});

async function seedParkedRunViaAmbiguous(): Promise<{ run: Awaited<ReturnType<typeof seedReviewRun>>; actionId: string }> {
  const run = seedReviewRun(true);
  await approveRunWithDeliver(run.id, {
    deliver: async () => ({
      ok: false,
      kind: "ambiguous",
      reason: "timeout — whether the message was actually sent is unknown"})});
  const action = findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required");
  assert.ok(action, "expected the original attempt to have parked the run");
  return { run, actionId: action!.id };
}

test("resolveOutboundDeliveryAction:retry_send re-delivers and closes the park on success", async () => {
  const { run, actionId } = await seedParkedRunViaAmbiguous();
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "retry_send", {
    deliver: async () => ({ ok: true, toolResult: { ok: true } })});
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
  assert.equal(getRun(run.id)!.status, "done");
  const resolved = getHumanAction(actionId)!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "yusuke");
  assert.deepEqual(JSON.parse(resolved.resolutionJson!), { choice: "retry_send" });
});

test("a plain re-approve (not via retry_send) closes an open delivery park too, with a generic system resolution", async () => {
  const { run, actionId } = await seedParkedRunViaAmbiguous();
  const res = await approveRunWithDeliver(run.id, {
    deliver: async () => ({ ok: true, toolResult: { ok: true } })});
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
  assert.equal(getRun(run.id)!.status, "done");
  const resolved = getHumanAction(actionId)!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "system");
  assert.deepEqual(JSON.parse(resolved.resolutionJson!), { choice: "resolved_via_approve" });
});

test("resolveOutboundDeliveryAction:retry_send that fails leaves the action open, not resolved", async () => {
  const { run, actionId } = await seedParkedRunViaAmbiguous();
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "retry_send", {
    deliver: async () => ({ ok: false, kind: "infra_failure", reason: "deck down again" })});
  assert.equal(res.ok, false);
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  assert.equal(getHumanAction(actionId)!.status, "open");
});

test("resolveOutboundDeliveryAction:retry_send that hits ambiguous again reuses the same open action, no duplicate", async () => {
  const { run, actionId } = await seedParkedRunViaAmbiguous();
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "retry_send", {
    deliver: async () => ({ ok: false, kind: "ambiguous", reason: "still ambiguous" })});
  assert.equal(res.ok, false);
  assert.equal(getHumanAction(actionId)!.status, "open");
  const actions = listHumanActionsForRun(run.id).filter((a) => a.actionType === "outbound_delivery_interaction_required");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, actionId);
});

test("resolveOutboundDeliveryAction:reject makes no deliver call, draft ends rejected, run ends done", async () => {
  const { run, actionId } = await seedParkedRunViaAmbiguous();
  let called = false;
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "reject", {
    deliver: async () => {
      called = true;
      throw new Error("must not be called");
    }});
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, false);
  assert.equal(called, false);
  assert.equal(pendingSendCount(run.id), 0);
  assert.equal(getRun(run.id)!.status, "done");
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"rejected"/);
});

test("mark sent before deliver prevents double-send race", async () => {
  const run = seedReviewRun(true);
  let deliverCalls = 0;
  const res = await approveRunWithDeliver(run.id, {
    deliver: async () => {
      deliverCalls++;
      return { ok: true, toolResult: { ok: true } };
    }});
  assert.equal(res.ok, true);
  assert.equal(deliverCalls, 1);
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"sent"/);
});

test("retry rejects pending draft", () => {
  const run = seedReviewRun(true);
  rejectPendingOutboundDrafts(run.id);
  assert.equal(pendingSendCount(run.id), 0);
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"rejected"/);
});

test("resolveOpenDeliveryParkForRun closes an open park", async () => {
  const { run, actionId } = await seedParkedRunViaAmbiguous();
  resolveOpenDeliveryParkForRun(run.id, { resolvedBy: "system", choice: "superseded_by_retry" });
  const resolved = getHumanAction(actionId)!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "system");
  assert.deepEqual(JSON.parse(resolved.resolutionJson!), { choice: "superseded_by_retry" });
});

test("resolveOpenDeliveryParkForRun is a no-op when nothing is parked", () => {
  const run = seedReviewRun(true);
  resolveOpenDeliveryParkForRun(run.id, { resolvedBy: "system", choice: "cancelled" });
});

test("incrementOutboundDeliveryAttempt counts up from 1 for a real draft", () => {
  const run = seedReviewRun(true);
  const draftArt = getLatestArtifact(run.id, "slack_draft")!;
  assert.equal(incrementOutboundDeliveryAttempt(draftArt.id), 1);
  assert.equal(incrementOutboundDeliveryAttempt(draftArt.id), 2);
});

test("incrementOutboundDeliveryAttempt returns null for a nonexistent artifact", () => {
  assert.equal(incrementOutboundDeliveryAttempt("00000000-0000-0000-0000-000000000000"), null);
});
