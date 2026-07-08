import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutboundToolCall } from "@agent-dealer/shared";
import { assertCallServiceToolSuccess, toCallServiceToolPayload } from "./agent-deck.js";

test("toCallServiceToolPayload maps serviceName to serviceId verbatim args", () => {
  const toolCall: OutboundToolCall = {
    serviceName: "34eb6c24-f151-4da2-8db8-d6996aa296be",
    toolName: "chat_postMessage",
    arguments: { channel: "C123", text: "Hello world" },
  };
  const payload = toCallServiceToolPayload(toolCall);
  assert.equal(payload.serviceId, toolCall.serviceName);
  assert.equal(payload.toolName, toolCall.toolName);
  assert.deepEqual(payload.arguments, toolCall.arguments);
});

test("assertCallServiceToolSuccess throws on deck proxy failure JSON", () => {
  assert.throws(
    () =>
      assertCallServiceToolSuccess({
        content: [{ type: "text", text: JSON.stringify({ success: false, error: "Service not found" }) }],
      }),
    /Service not found/
  );
});

test("assertCallServiceToolSuccess throws on nested Slack channel_not_found", () => {
  const receipt = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          content: [{ type: "text", text: "channel_not_found\n\nThe channel could not be found." }],
          isError: true,
        }),
      },
    ],
  };
  assert.throws(() => assertCallServiceToolSuccess(receipt), /channel_not_found/);
});

test("assertCallServiceToolSuccess throws on deck-wrapped Slack JSON (live MCP shape)", () => {
  const receipt = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          content: [
            {
              type: "text",
              text: "channel_not_found\n\nThe channel could not be found. It may not exist, may be in a different workspace than your app is installed on, or your app may lack permission to access it.",
            },
          ],
          isError: true,
        }),
      },
    ],
  };
  assert.throws(() => assertCallServiceToolSuccess(receipt), /channel_not_found/);
});
