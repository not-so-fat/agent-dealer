// packages/server/src/coordinator/session-activity.test.ts
//
// NOT-170: stream-shape fixtures — Claude, Cursor, and Codex distinct shapes plus
// incomplete/malformed lines. Claude tool_result (type 'user') must normalize to
// tool_completed so flights close; Codex item.updated must not open a flight.
import { test } from "node:test";
import assert from "node:assert/strict";

const { normalizeStreamEvent, scanNewActivityLines } = await import("./session-activity.js");

test("Claude assistant tool_use normalizes to tool_started with call id", () => {
  const out = normalizeStreamEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }] },
  });
  assert.deepEqual(out, [{ kind: "tool_started", state: "started", callId: "tu_1" }]);
});

test("Claude parallel tool_use blocks yield one start each", () => {
  const out = normalizeStreamEvent({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu_1", name: "Read" },
        { type: "tool_use", id: "tu_2", name: "Bash" },
      ],
    },
  });
  assert.deepEqual(out, [
    { kind: "tool_started", state: "started", callId: "tu_1" },
    { kind: "tool_started", state: "started", callId: "tu_2" },
  ]);
});

test("Claude user/tool_result normalizes to tool_completed closing the flight", () => {
  const out = normalizeStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
  });
  assert.deepEqual(out, [{ kind: "tool_completed", state: "completed", callId: "tu_1" }]);
});

test("Claude assistant text normalizes to assistant_output; init/thinking persist nothing", () => {
  assert.deepEqual(normalizeStreamEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "Working on it" }] },
  }), [{ kind: "assistant_output", state: "observed", callId: null }]);
  assert.equal(normalizeStreamEvent({ type: "system", subtype: "init" }), null);
  assert.equal(normalizeStreamEvent({ type: "thinking", text: "hmm" }), null);
  assert.equal(normalizeStreamEvent({ type: "result", result: "done" }), null);
});

test("Cursor started/completed tool_call shapes pair by call id", () => {
  const started = normalizeStreamEvent({
    type: "tool_call",
    subtype: "started",
    call_id: "c1",
    tool_call: { shellToolCall: { args: { command: "npm test" } } },
  });
  assert.deepEqual(started, [{ kind: "tool_started", state: "started", callId: "c1" }]);
  const completed = normalizeStreamEvent({
    type: "tool_call",
    subtype: "completed",
    call_id: "c1",
    tool_call: { shellToolCall: { args: { command: "npm test" }, result: { exitCode: 0 } } },
  });
  assert.deepEqual(completed, [{ kind: "tool_completed", state: "completed", callId: "c1" }]);
});

test("Cursor readToolCall without subtype is a start", () => {
  const out = normalizeStreamEvent({
    type: "tool_call",
    tool_call: { readToolCall: { args: { path: "/tmp/a.ts" } } },
  });
  assert.equal(out?.[0]?.kind, "tool_started");
});

test("Codex command_execution start/completion pair; item.updated opens nothing", () => {
  const started = normalizeStreamEvent({
    type: "item.started",
    item: { type: "command_execution", id: "x1", command: "pytest" },
  });
  assert.deepEqual(started, [{ kind: "tool_started", state: "started", callId: "x1" }]);
  assert.equal(
    normalizeStreamEvent({ type: "item.updated", item: { type: "command_execution", id: "x1" } }),
    null
  );
  const completed = normalizeStreamEvent({
    type: "item.completed",
    item: { type: "command_execution", id: "x1" },
  });
  assert.deepEqual(completed, [{ kind: "tool_completed", state: "completed", callId: "x1" }]);
});

test("Codex agent_message is assistant output; reasoning persists nothing", () => {
  assert.deepEqual(
    normalizeStreamEvent({ type: "item.completed", item: { type: "agent_message", text: "hello there" } }),
    [{ kind: "assistant_output", state: "observed", callId: null }]
  );
  assert.equal(normalizeStreamEvent({ type: "item.completed", item: { type: "reasoning", text: "plan" } }), null);
});

test("provider wait/retry evidence normalizes across runtimes", () => {
  assert.deepEqual(normalizeStreamEvent({ type: "rate_limit_event", rate_limit_info: {} }), [
    { kind: "provider_wait", state: "observed", callId: null },
  ]);
  assert.deepEqual(normalizeStreamEvent({ type: "system", subtype: "api_retry", error: "retry" }), [
    { kind: "provider_wait", state: "observed", callId: null },
  ]);
  assert.deepEqual(
    normalizeStreamEvent({ type: "turn.failed", error: { message: "server overloaded, retrying 429" } }),
    [{ kind: "provider_wait", state: "observed", callId: null }]
  );
  // A failed turn without retry evidence is structured but not provider wait.
  assert.deepEqual(
    normalizeStreamEvent({ type: "turn.failed", error: { message: "bad tool args" } }),
    [{ kind: "unknown_activity", state: "observed", callId: null }]
  );
});

test("Muse side-effect intent and tool.result pair by call id", () => {
  const started = normalizeStreamEvent({
    payload_type: "task.lifecycle.side_effect_intent",
    event: { operation: "tool:Bash", idempotency_key: "tool:call-9", task_id: "t1" },
  });
  assert.deepEqual(started, [{ kind: "tool_started", state: "started", callId: "call-9" }]);
  const completed = normalizeStreamEvent({
    payload_type: "tool.result",
    call_id: "call-9",
    correlation_facts: { outcome: "success" },
  });
  assert.deepEqual(completed, [{ kind: "tool_completed", state: "completed", callId: "call-9" }]);
});

test("unknown typed events fall back to unknown_activity; typeless junk is dropped", () => {
  assert.deepEqual(normalizeStreamEvent({ type: "fancy_future_event", foo: 1 }), [
    { kind: "unknown_activity", state: "observed", callId: null },
  ]);
  assert.equal(normalizeStreamEvent({ foo: 1 }), null);
  assert.equal(normalizeStreamEvent(null as unknown as Record<string, unknown>), null);
});

test("scanner skips malformed/incomplete lines and tracks cursor + offsets", () => {
  const good1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
  const good2 = JSON.stringify({ type: "system", subtype: "api_retry", error: "retry" });
  const raw = `${good1}\nnot json at all\n\n{"truncated": \n${good2}\n`;
  const { scanned, nextOffset, nextCursor } = scanNewActivityLines(raw);
  assert.equal(scanned.length, 2);
  assert.equal(scanned[0]!.cursor, 0);
  assert.equal(scanned[0]!.normalized.kind, "assistant_output");
  assert.equal(scanned[1]!.cursor, 4);
  assert.equal(scanned[1]!.normalized.kind, "provider_wait");
  assert.equal(nextCursor, 5);
  assert.equal(nextOffset, raw.length);
  // Offsets round-trip: slicing at the first end offset resumes exactly after line 0.
  const resume = scanNewActivityLines(raw, { fromOffset: scanned[0]!.endOffset, baseCursor: 1 });
  assert.equal(resume.scanned.length, 1);
  assert.equal(resume.scanned[0]!.normalized.kind, "provider_wait");
});

test("scanner holds back a trailing partial line until its newline arrives", () => {
  const good = JSON.stringify({ type: "system", subtype: "api_retry", error: "retry" });
  const partial = scanNewActivityLines(`${good}`);
  assert.equal(partial.scanned.length, 0);
  assert.equal(partial.nextOffset, 0);
  const complete = scanNewActivityLines(`${good}\n`);
  assert.equal(complete.scanned.length, 1);
});

test("scanner gives parallel entries on one line distinct seqs sharing the offset", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu_1", name: "Read" },
        { type: "tool_use", id: "tu_2", name: "Bash" },
      ],
    },
  });
  const { scanned, nextOffset } = scanNewActivityLines(`${line}\n`);
  assert.equal(scanned.length, 2);
  assert.equal(scanned[0]!.offset, 0);
  assert.equal(scanned[0]!.endOffset, scanned[1]!.endOffset);
  assert.deepEqual(scanned.map((s) => s.seq), [0, 1]);
  assert.deepEqual(scanned.map((s) => s.normalized.callId), ["tu_1", "tu_2"]);
  assert.equal(nextOffset, Buffer.byteLength(line, "utf8") + 1);
});

test("scanner tracks byte (not character) offsets through multibyte lines", () => {
  const multi = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "日本語テスト 🎉 working through the plan" }] },
  });
  const tool = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_9", name: "Bash" }] },
  });
  const raw = `${multi}\n${tool}\n`;
  const { scanned, nextOffset } = scanNewActivityLines(raw);
  assert.equal(scanned.length, 2);
  const firstLineBytes = Buffer.byteLength(multi, "utf8") + 1;
  assert.equal(scanned[0]!.offset, 0);
  assert.equal(scanned[0]!.endOffset, firstLineBytes);
  // A character-based offset would be smaller: the byte offset must exceed it.
  assert.ok(firstLineBytes > multi.length + 1);
  assert.equal(scanned[1]!.offset, firstLineBytes);
  assert.equal(nextOffset, Buffer.byteLength(raw, "utf8"));
  // Resuming from the byte offset lands exactly on the second line.
  const resume = scanNewActivityLines(raw, { fromOffset: firstLineBytes, baseCursor: 1 });
  assert.equal(resume.scanned.length, 1);
  assert.equal(resume.scanned[0]!.normalized.callId, "tu_9");
});
