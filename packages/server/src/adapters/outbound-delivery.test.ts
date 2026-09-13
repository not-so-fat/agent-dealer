// packages/server/src/adapters/outbound-delivery.test.ts
//
// Regression coverage for NOT-91's review fix: deliverOutboundDraft must classify a failure
// by whether the request may already have reached Deck's call_service_tool (ambiguous, never
// auto-retried) versus one that never got there at all (an ordinary infra failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverOutboundDraft, OutboundDeliveryTransportError } from "./outbound-delivery.js";

const AUTHORITY = { authorityId: "authz_test", authoritySecret: "authzs_test" };
const TOOL_CALL = { serviceName: "slack", toolName: "chat_postMessage", arguments: {} };

test("a pre-dispatch transport failure (never reached Deck) is an ordinary infra failure", async () => {
  const result = await deliverOutboundDraft(AUTHORITY, TOOL_CALL, {
    callTool: async () => {
      throw new OutboundDeliveryTransportError("connect ECONNREFUSED", false);
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "infra_failure");
});

test("a post-dispatch transport failure (e.g. ECONNRESET after callTool started) is ambiguous, never auto-retried", async () => {
  const result = await deliverOutboundDraft(AUTHORITY, TOOL_CALL, {
    callTool: async () => {
      throw new OutboundDeliveryTransportError("read ECONNRESET", true);
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "ambiguous");
});

test("the race timeout is ambiguous", async () => {
  const result = await deliverOutboundDraft(AUTHORITY, TOOL_CALL, {
    callTool: async () => {
      throw new OutboundDeliveryTransportError("Outbound deliver timed out after 60000ms", true);
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "ambiguous");
});

test("a plain Error from a legacy callTool seam falls back to the timeout-text heuristic", async () => {
  const timedOut = await deliverOutboundDraft(AUTHORITY, TOOL_CALL, {
    callTool: async () => {
      throw new Error("Outbound deliver timed out after 60000ms");
    },
  });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.kind, "ambiguous");

  const other = await deliverOutboundDraft(AUTHORITY, TOOL_CALL, {
    callTool: async () => {
      throw new Error("some other failure");
    },
  });
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.kind, "infra_failure");
});
