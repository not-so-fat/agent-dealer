// packages/server/src/coordinator/verification-receipt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractVerificationReceiptFromLog,
  formatVerificationReceiptSection,
  parseVerificationReceipt,
  receiptForCurrentHead,
} from "./verification-receipt.js";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function writeLog(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-receipt-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return logPath;
}

test("extracts a Claude Bash green suite and pins it to headShaHint", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "npm run test:unit" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: false,
            content: "711/711 tests passed\n",
          },
        ],
      },
    },
  ]);
  const receipt = extractVerificationReceiptFromLog(logPath, { headShaHint: SHA, now: () => "2026-09-17T00:00:00.000Z" });
  assert.ok(receipt);
  assert.equal(receipt!.headSha, SHA);
  assert.equal(receipt!.commands.length, 1);
  assert.equal(receipt!.commands[0]!.outcome, "passed");
  assert.equal(receipt!.commands[0]!.detail, "711/711");
  assert.match(receipt!.commands[0]!.command, /npm run test:unit/);
});

test("extracts Cursor shellToolCall completed with exitCode 0", () => {
  const logPath = writeLog([
    {
      type: "tool_call",
      subtype: "completed",
      tool_call: {
        shellToolCall: {
          args: { command: "npm run typecheck" },
          result: { exitCode: 0, stdout: "ok\n" },
        },
      },
    },
  ]);
  const receipt = extractVerificationReceiptFromLog(logPath, { headShaHint: SHA });
  assert.ok(receipt);
  assert.equal(receipt!.commands[0]!.outcome, "passed");
  assert.match(receipt!.commands[0]!.command, /typecheck/);
});

test("a commit after a green suite invalidates the receipt", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: "git commit -m 'wip'" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t2", is_error: false, content: "[main abc] wip" }],
      },
    },
  ]);
  assert.equal(extractVerificationReceiptFromLog(logPath, { headShaHint: SHA }), null);
});

test("observed rev-parse SHA that disagrees with tip drops the receipt", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t0", name: "Bash", input: { command: "git rev-parse HEAD" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t0", is_error: false, content: `${SHA}\n` }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }],
      },
    },
  ]);
  assert.equal(extractVerificationReceiptFromLog(logPath, { headShaHint: SHA2 }), null);
});

test("failed-only suites are not persisted as skip evidence", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "failed" }],
      },
    },
  ]);
  assert.equal(extractVerificationReceiptFromLog(logPath, { headShaHint: SHA }), null);
});

test("receiptForCurrentHead drops when HEAD moved", () => {
  const receipt = parseVerificationReceipt({
    headSha: SHA,
    commands: [{ command: "npm test", outcome: "passed" }],
    recordedAt: "2026-09-17T00:00:00.000Z",
  });
  assert.ok(receipt);
  assert.equal(receiptForCurrentHead(receipt, SHA), receipt);
  assert.equal(receiptForCurrentHead(receipt, SHA2), null);
});

test("formatVerificationReceiptSection names the tip and keeps skip optional", () => {
  const section = formatVerificationReceiptSection({
    headSha: SHA,
    commands: [{ command: "npm run test:unit", outcome: "passed", detail: "711/711" }],
    recordedAt: "2026-09-17T00:00:00.000Z",
  }).join("\n");
  assert.match(section, /Prior verification receipt/);
  assert.match(section, /aaaaaaaa/);
  assert.match(section, /npm run test:unit.*passed \(711\/711\)/);
  assert.match(section, /HEAD is unchanged/);
  assert.match(section, /evidence, not an instruction to skip/i);
  assert.match(section, /Do not re-run an unchanged green suite by default/);
});
