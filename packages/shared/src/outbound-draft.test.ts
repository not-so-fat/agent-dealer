import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OutboundDraftBlock,
  outboundDraftKind,
  outboundMessageMatchesSummary,
  SendReceiptContent,
} from "./outbound-draft.js";

const VALID_DRAFT = {
  actionType: "slack_message" as const,
  summary: { target: "#test-channel", body: "Hello from agent-dealer" },
  toolCall: {
    serviceName: "34eb6c24-f151-4da2-8db8-d6996aa296be",
    toolName: "chat_postMessage",
    arguments: { channel: "C123", text: "Hello from agent-dealer" },
  },
};

test("OutboundDraftBlock parses valid slack draft", () => {
  const parsed = OutboundDraftBlock.parse(VALID_DRAFT);
  assert.equal(parsed.actionType, "slack_message");
});

test("outboundDraftKind maps action types", () => {
  assert.equal(outboundDraftKind("slack_message"), "slack_draft");
  assert.equal(outboundDraftKind("email"), "email_draft");
});

test("outboundMessageMatchesSummary matches text field", () => {
  assert.equal(
    outboundMessageMatchesSummary(VALID_DRAFT.toolCall, VALID_DRAFT.summary.body),
    true
  );
});

test("outboundMessageMatchesSummary detects mismatch", () => {
  assert.equal(
    outboundMessageMatchesSummary(VALID_DRAFT.toolCall, "different body"),
    false
  );
});

test("SendReceiptContent requires draftArtifactId and toolResult", () => {
  const receipt = SendReceiptContent.parse({
    draftArtifactId: "00000000-0000-4000-a000-000000000001",
    sentAt: new Date().toISOString(),
    toolResult: { ok: true },
  });
  assert.equal(receipt.toolResult.ok, true);
});
