import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutboundToolCall } from "@agent-dealer/shared";
import type { MintAuthorityInput, MintAuthorityResult } from "../adapters/execution-authority.js";
import type { DeliverOutboundResult, DeliveryAuthority } from "../adapters/outbound-delivery.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-send-gate-"));
process.env.MAX_CONCURRENT_RUNS = "0";

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID } = await import("@agent-dealer/shared");
const { updateAgent } = await import("../repository/agents.js");
const {
  addArtifact,
  createRun,
  getLatestArtifact,
  getRun,
  transitionRun,
  updateRunFields,
} = await import("../repository/runs.js");
const { approveRunWithDeliver, resolveOutboundDeliveryAction } = await import("./approve-deliver.js");
const { rejectPendingOutboundDrafts, pendingSendCount, incrementOutboundDeliveryAttempt } = await import(
  "../repository/outbound-drafts.js"
);
const { findOpenHumanActionForRun, listHumanActionsForRun, getHumanAction } = await import("../repository/human-actions.js");
const { getSnapshot } = await import("./dispatcher.js");

const DECK = "6e825b59-13de-4ddd-ab7e-55ab5a1c279a";

const TOOL_CALL: OutboundToolCall = {
  serviceName: "34eb6c24-f151-4da2-8db8-d6996aa296be",
  toolName: "chat_postMessage",
  arguments: { channel: "C1", text: "Hello gate test" },
};

const DRAFT_CONTENT = {
  draft: {
    actionType: "slack_message" as const,
    summary: { target: "#test", body: "Hello gate test" },
    toolCall: TOOL_CALL,
  },
  status: "pending" as const,
};

before(() => {
  migrate();
  updateAgent(BUILTIN_AGENT_CLAUDE_ID, { workspaceRoot: process.env.AGENT_DEALER_HOME! });
});

function seedReviewRun(withDraft = true) {
  const run = createRun({
    title: "Send gate test",
    taskCategory: "communication",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  updateRunFields(run.id, { deck_id: DECK });
  transitionRun(run.id, "plan_approved");
  transitionRun(run.id, "running");
  transitionRun(run.id, "review");
  if (withDraft) {
    addArtifact(run.id, "slack_draft", DRAFT_CONTENT, "agent");
  }
  return getRun(run.id)!;
}

const AUTHORITY: DeliveryAuthority = { authorityId: "authz_1", authoritySecret: "authzs_secret_1" };

function mintOk(authority: DeliveryAuthority = AUTHORITY) {
  return async (input: MintAuthorityInput): Promise<MintAuthorityResult> => ({
    ok: true,
    authority: {
      authorityId: authority.authorityId,
      authoritySecret: authority.authoritySecret,
      deckId: input.deckId,
      audience: "dealer-worker",
      allowedServices: (input.toolScopeHint ?? []).map((t) => t.serviceId),
      allowedTools: input.toolScopeHint ?? [],
      expiresAt: "2026-01-01T00:30:00Z",
    },
  });
}

async function noopRevoke(): Promise<void> {}

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

test("approve mints authority scoped to the draft's exact serviceId/toolName, delivers, and revokes", async () => {
  const run = seedReviewRun(true);
  let captured: OutboundToolCall | null = null;
  let revoked: string | null = null;
  const res = await approveRunWithDeliver(run.id, {
    mint: async (input) => {
      assert.deepEqual(input.toolScopeHint, [{ serviceId: TOOL_CALL.serviceName, toolName: TOOL_CALL.toolName }]);
      return mintOk()(input);
    },
    revoke: async (authorityId) => {
      revoked = authorityId;
    },
    deliver: async (authority, toolCall): Promise<DeliverOutboundResult> => {
      assert.deepEqual(authority, AUTHORITY);
      captured = toolCall;
      return { ok: true, toolResult: { ok: true }, permalink: "https://slack.example/msg/1" };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
  assert.deepEqual(captured, TOOL_CALL);
  assert.equal(revoked, AUTHORITY.authorityId);
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
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async (_authority, toolCall) => {
      captured = toolCall;
      return { ok: true, toolResult: { ok: true } };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(captured, {
    ...TOOL_CALL,
    arguments: { ...TOOL_CALL.arguments, text: "Human tweak before send" },
  });
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /Human tweak before send/);
});

test("deliver infra failure keeps run in review with pending draft, revokes authority, no park", async () => {
  const run = seedReviewRun(true);
  let revoked: string | null = null;
  const res = await approveRunWithDeliver(run.id, {
    mint: mintOk(),
    revoke: async (authorityId) => {
      revoked = authorityId;
    },
    deliver: async (): Promise<DeliverOutboundResult> => ({ ok: false, kind: "infra_failure", reason: "deck down" }),
  });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, 502);
  assert.equal(!res.ok && res.errorCode, "DELIVERY_FAILED");
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  assert.equal(revoked, AUTHORITY.authorityId);
  assert.equal(findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required"), null);
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"pending"/);
});

test("off-scope/provider denial surfaces as an ordinary delivery failure, not parked", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async (): Promise<DeliverOutboundResult> => ({
      ok: false,
      kind: "infra_failure",
      reason: "RESOURCE_OUT_OF_SCOPE: tool not in authority's allowed set",
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required"), null);
  assert.ok(!getLatestArtifact(run.id, "send_receipt"));
});

test("mint returning INTERACTION_REQUIRED parks the run: draft pending, run in review, one open action", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    mint: async (): Promise<MintAuthorityResult> => ({
      ok: false,
      code: "INTERACTION_REQUIRED",
      message: "Deck requires re-authorization for this deck.",
      requestId: "req_mint_1",
    }),
    revoke: noopRevoke,
    deliver: async () => {
      throw new Error("must not be called — mint already failed");
    },
  });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.errorCode, "INTERACTION_REQUIRED");
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  const action = findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required");
  assert.ok(action);
  assert.equal(action!.runId, run.id);
  assert.equal(action!.requestId, "req_mint_1");
  assert.deepEqual(JSON.parse(action!.responseOptionsJson!), [
    { choice: "retry_send", label: "Retry send" },
    { choice: "reject", label: "Reject draft" },
  ]);
});

test("deliver returning INTERACTION_REQUIRED (mint succeeded) also parks the run", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async (): Promise<DeliverOutboundResult> => ({
      ok: false,
      kind: "interaction_required",
      reason: "Deck requires re-authorization mid-call.",
      requestId: "req_deliver_1",
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.errorCode, "INTERACTION_REQUIRED");
  assert.equal(getRun(run.id)!.status, "review");
  const action = findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required");
  assert.ok(action);
  assert.equal(action!.requestId, "req_deliver_1");
});

test("a repeated INTERACTION_REQUIRED signal for the same requestId dedupes to one action", async () => {
  const run = seedReviewRun(true);
  const deps = {
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async (): Promise<DeliverOutboundResult> => ({
      ok: false,
      kind: "interaction_required" as const,
      reason: "Deck requires re-authorization.",
      requestId: "req_dup_1",
    }),
  };
  await approveRunWithDeliver(run.id, deps);
  await approveRunWithDeliver(run.id, deps);
  const actions = listHumanActionsForRun(run.id).filter((a) => a.actionType === "outbound_delivery_interaction_required");
  assert.equal(actions.length, 1);
});

/** Drives a real INTERACTION_REQUIRED park (through approveRunWithDeliver, not a
 * hand-crafted human action) so the retry test below can compare the retry's
 * idempotencyKey against the original attempt's. */
async function seedParkedRunViaInteractionRequired(): Promise<{ run: Awaited<ReturnType<typeof seedReviewRun>>; actionId: string; firstIdempotencyKey: string }> {
  const run = seedReviewRun(true);
  let firstIdempotencyKey = "";
  await approveRunWithDeliver(run.id, {
    mint: async (input) => {
      firstIdempotencyKey = input.idempotencyKey;
      return { ok: false, code: "INTERACTION_REQUIRED", message: "Deck requires re-authorization.", requestId: "req_seed_park" };
    },
    revoke: noopRevoke,
    deliver: async () => {
      throw new Error("must not be called — mint already failed");
    },
  });
  const action = findOpenHumanActionForRun(run.id, "outbound_delivery_interaction_required");
  assert.ok(action, "expected the original attempt to have parked the run");
  return { run, actionId: action!.id, firstIdempotencyKey };
}

test("resolveOutboundDeliveryAction:retry_send mints a distinct idempotencyKey than the original parked attempt", async () => {
  const { run, actionId, firstIdempotencyKey } = await seedParkedRunViaInteractionRequired();
  let secondIdempotencyKey = "";
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "retry_send", {
    mint: async (input) => {
      secondIdempotencyKey = input.idempotencyKey;
      return mintOk()(input);
    },
    revoke: noopRevoke,
    deliver: async () => ({ ok: true, toolResult: { ok: true } }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
  assert.notEqual(secondIdempotencyKey, firstIdempotencyKey);
  assert.equal(getRun(run.id)!.status, "done");
  const resolved = getHumanAction(actionId)!;
  assert.equal(resolved.status, "resolved");
  // Resolved with the real operator identity/choice (threaded through as actionResolution),
  // not the generic "system"/"resolved_via_approve" marker a plain Ops re-approve gets.
  assert.equal(resolved.resolvedBy, "yusuke");
  assert.deepEqual(JSON.parse(resolved.resolutionJson!), { choice: "retry_send" });
});

test("a plain re-approve (not via retry_send) closes an open delivery park too, with a generic system resolution", async () => {
  const { run, actionId } = await seedParkedRunViaInteractionRequired();
  // Simulates an operator fixing the Deck-side control-plane issue out of band and just
  // re-approving from Ops, never touching the Human Actions queue item directly.
  const res = await approveRunWithDeliver(run.id, {
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async () => ({ ok: true, toolResult: { ok: true } }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
  assert.equal(getRun(run.id)!.status, "done");
  const resolved = getHumanAction(actionId)!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "system");
  assert.deepEqual(JSON.parse(resolved.resolutionJson!), { choice: "resolved_via_approve" });
});

test("resolveOutboundDeliveryAction:retry_send that fails leaves the action open, not resolved", async () => {
  const { run, actionId } = await seedParkedRunViaInteractionRequired();
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "retry_send", {
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async () => ({ ok: false, kind: "infra_failure", reason: "deck down again" }),
  });
  assert.equal(res.ok, false);
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  // Left open on purpose — a failed retry must not drop the operator's queue item with no
  // way back to the still-blocked run (no per-run detail page on the legacy Run model).
  assert.equal(getHumanAction(actionId)!.status, "open");
});

test("resolveOutboundDeliveryAction:retry_send that hits INTERACTION_REQUIRED again reuses the same open action, no duplicate", async () => {
  const { run, actionId } = await seedParkedRunViaInteractionRequired();
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "retry_send", {
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async () => ({ ok: false, kind: "interaction_required", reason: "still blocked", requestId: "req_different" }),
  });
  assert.equal(res.ok, false);
  assert.equal(getHumanAction(actionId)!.status, "open");
  const actions = listHumanActionsForRun(run.id).filter((a) => a.actionType === "outbound_delivery_interaction_required");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, actionId);
});

test("resolveOutboundDeliveryAction:reject makes no mint/deliver call, draft ends rejected, run ends done", async () => {
  const { run, actionId } = await seedParkedRunViaInteractionRequired();
  let called = false;
  const res = await resolveOutboundDeliveryAction(actionId, "yusuke", "reject", {
    mint: async () => {
      called = true;
      throw new Error("must not be called");
    },
    revoke: noopRevoke,
    deliver: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
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
    mint: mintOk(),
    revoke: noopRevoke,
    deliver: async () => {
      deliverCalls++;
      return { ok: true, toolResult: { ok: true } };
    },
  });
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

test("snapshot exposes pendingSendCounts", () => {
  const snap = getSnapshot();
  assert.equal(typeof snap.pendingSendCounts, "object");
});

test("incrementOutboundDeliveryAttempt counts up from 1 for a real draft", () => {
  const run = seedReviewRun(true);
  const draftArt = getLatestArtifact(run.id, "slack_draft")!;
  assert.equal(incrementOutboundDeliveryAttempt(draftArt.id), 1);
  assert.equal(incrementOutboundDeliveryAttempt(draftArt.id), 2);
});

test("incrementOutboundDeliveryAttempt returns null for a nonexistent artifact — approveRunWithDeliver fails closed on this, never defaults to attempt 1", () => {
  assert.equal(incrementOutboundDeliveryAttempt("00000000-0000-0000-0000-000000000000"), null);
});
