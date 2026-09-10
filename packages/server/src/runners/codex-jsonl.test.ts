import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexResultText,
  extractCodexThreadId,
  normalizeCodexEvents,
  parseCodexJsonl,
} from "./codex-jsonl.js";
import { extractSessionId, extractResultText, extractUsage } from "./stream-json.js";

const SAMPLE = `
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
`.trim();

test("parseCodexJsonl reads JSONL events", () => {
  const events = parseCodexJsonl(SAMPLE);
  assert.equal(events.length, 5);
  assert.equal(extractCodexThreadId(events), "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(extractCodexResultText(events), "Repo contains docs, sdk, and examples directories.");
});

test("normalizeCodexEvents feeds existing extractors", () => {
  const normalized = normalizeCodexEvents(parseCodexJsonl(SAMPLE));
  assert.equal(extractSessionId(normalized), "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(extractResultText(normalized), "Repo contains docs, sdk, and examples directories.");
  const usage = extractUsage(normalized, "plan", "codex_local");
  assert.equal(usage.inputTokens, 24763);
  assert.equal(usage.outputTokens, 122);
  assert.equal(usage.cacheReadTokens, 24448);
});

test("normalizeCodexEvents marks turn.failed as error result", () => {
  const raw = `
{"type":"thread.started","thread_id":"t1"}
{"type":"turn.failed","error":{"message":"sandbox denied"}}
`.trim();
  const normalized = normalizeCodexEvents(parseCodexJsonl(raw));
  const result = normalized.find((e) => e.type === "result");
  assert.equal(result?.is_error, true);
  assert.equal(result?.result, "sandbox denied");
});
