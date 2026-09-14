// packages/server/src/coordinator/usage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractResultTranscript, extractSpawnUsage } from "./usage.js";

function writeLog(lines: unknown[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-usage-")), "session.ndjson");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

test("extractSpawnUsage reads claude-shaped stream-json usage/cost", () => {
  const logPath = writeLog([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "result", total_cost_usd: 0.0421, usage: { input_tokens: 1000, output_tokens: 200 } },
  ]);
  const usage = extractSpawnUsage(logPath, "claude_code");
  assert.equal(usage.tokensIn, 1000);
  assert.equal(usage.tokensOut, 200);
  assert.equal(usage.costUsd, 0.0421);
});

test("extractSpawnUsage reads codex-shaped jsonl usage (no cost field)", () => {
  const logPath = writeLog([
    { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 } },
  ]);
  const usage = extractSpawnUsage(logPath, "codex_local");
  assert.equal(usage.tokensIn, 500);
  assert.equal(usage.tokensOut, 50);
  assert.equal(usage.costUsd, null);
});

test("extractSpawnUsage returns nulls for a missing log file", () => {
  const usage = extractSpawnUsage("/does/not/exist.ndjson", "claude_code");
  assert.deepEqual(usage, { tokensIn: null, tokensOut: null, costUsd: null });
});

test("extractSpawnUsage returns nulls when no result event is present", () => {
  const logPath = writeLog([{ type: "assistant", message: { content: [] } }]);
  const usage = extractSpawnUsage(logPath, "claude_code");
  assert.deepEqual(usage, { tokensIn: null, tokensOut: null, costUsd: null });
});

// Regression for the bug this extractor was added to fix: with `--stream-partial-output`
// (cursor), the same growing answer streams as repeated partial fragments before its
// final, complete form — a truncated fence can appear in the raw stream well before the
// finished one. Parsing the raw stdout directly (the old behavior) risks matching that
// earlier, incomplete fragment; extracting the final `type: "result"` event's text first
// sidesteps that regardless of what came before it in the stream.
test("extractResultTranscript returns the final result text, not an earlier partial fragment", () => {
  const logPath = writeLog([
    { type: "system", subtype: "init" },
    // An earlier partial-output chunk containing what looks like an (incomplete) fence.
    { type: "assistant", message: { content: [{ type: "text", text: '```json\n{"verdict": "appro' }] } },
    { type: "result", result: '```json\n{"verdict":"approved"}\n```' },
  ]);
  const text = extractResultTranscript(logPath, "cursor_local", "fallback");
  assert.equal(text, '```json\n{"verdict":"approved"}\n```');
});

test("extractResultTranscript reads codex-shaped jsonl via the normalized result event", () => {
  const logPath = writeLog([
    { type: "item.completed", item: { type: "agent_message", text: '```json\n{"verdict":"approved"}\n```' } },
  ]);
  const text = extractResultTranscript(logPath, "codex_local", "fallback");
  assert.equal(text, '```json\n{"verdict":"approved"}\n```');
});

test("extractResultTranscript falls back to the raw transcript when nothing parses", () => {
  assert.equal(extractResultTranscript("/does/not/exist.ndjson", "claude_code", "raw fallback text"), "raw fallback text");
  const logPath = writeLog([{ type: "assistant", message: { content: [] } }]);
  assert.equal(extractResultTranscript(logPath, "claude_code", "raw fallback text"), "raw fallback text");
});
