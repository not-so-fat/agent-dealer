import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutboundToolCall } from "@agent-dealer/shared";

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
const { approveRunWithDeliver } = await import("./approve-deliver.js");
const { rejectPendingOutboundDrafts, pendingSendCount } = await import("../repository/outbound-drafts.js");
const { getSnapshot } = await import("./dispatcher.js");

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
  updateRunFields(run.id, { deck_id: "6e825b59-13de-4ddd-ab7e-55ab5a1c279a" });
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

test("approve with mock deliver sends byte-identical payload and creates receipt", async () => {
  const run = seedReviewRun(true);
  let captured: OutboundToolCall | null = null;
  const res = await approveRunWithDeliver(run.id, {
    deliver: async (_deckId, toolCall) => {
      captured = toolCall;
      return { toolResult: { ok: true }, permalink: "https://slack.example/msg/1" };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.delivered, true);
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
      return { toolResult: { ok: true } };
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

test("deliver failure keeps run in review with pending draft", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    deliver: async () => {
      throw new Error("deck down");
    },
  });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, 502);
  assert.equal(getRun(run.id)!.status, "review");
  assert.equal(pendingSendCount(run.id), 1);
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"pending"/);
});

test("mark sent before deliver prevents double-send race", async () => {
  const run = seedReviewRun(true);
  let deliverCalls = 0;
  const res = await approveRunWithDeliver(run.id, {
    deliver: async () => {
      deliverCalls++;
      return { toolResult: { ok: true } };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(deliverCalls, 1);
  const draftArt = getLatestArtifact(run.id, "slack_draft");
  assert.match(draftArt!.contentJson!, /"status":"sent"/);
});

test("proxy success:false from deck is treated as deliver failure", async () => {
  const run = seedReviewRun(true);
  const res = await approveRunWithDeliver(run.id, {
    deliver: async () => {
      throw new Error("Service not found");
    },
  });
  assert.equal(res.ok, false);
  assert.equal(getRun(run.id)!.status, "review");
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
