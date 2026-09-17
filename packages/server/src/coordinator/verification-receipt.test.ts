// packages/server/src/coordinator/verification-receipt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractVerificationReceiptFromLog,
  formatVerificationReceiptSection,
  isVerificationCommand,
  parseVerificationReceipt,
  receiptForCurrentHead,
  receiptSupersededByFailedChecks,
  shouldCarryVerificationReceipt,
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

test("git -c user.* commit after a green suite invalidates the receipt", () => {
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
            input: {
              command: "git -c user.email=agent@test -c user.name=Agent commit -q -m 'wip'",
            },
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

test("git-yubikey-commit after a green suite invalidates the receipt", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run test:unit" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "# pass 10\n" }],
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
            input: { command: "git-yubikey-commit -F /tmp/msg.txt" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t2", is_error: false, content: "[main abc] signed" }],
      },
    },
  ]);
  assert.equal(extractVerificationReceiptFromLog(logPath, { headShaHint: SHA }), null);
});

test("batched parallel tool_use records every verification command and invalidates on batched commit", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run typecheck" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm run test:unit" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" },
          { type: "tool_result", tool_use_id: "t2", is_error: false, content: "# pass 836\n# fail 0\n" },
        ],
      },
    },
  ]);
  const receipt = extractVerificationReceiptFromLog(logPath, { headShaHint: SHA });
  assert.ok(receipt);
  assert.equal(receipt!.commands.length, 2);
  assert.ok(receipt!.commands.some((c) => /typecheck/.test(c.command)));
  assert.ok(receipt!.commands.some((c) => /test:unit/.test(c.command) && c.detail === "836 passed"));

  const withCommit = writeLog([
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run test:unit" } },
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: "git -C . commit -m 'wip'" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" },
          { type: "tool_result", tool_use_id: "t2", is_error: false, content: "[main abc] wip" },
        ],
      },
    },
  ]);
  assert.equal(extractVerificationReceiptFromLog(withCommit, { headShaHint: SHA }), null);
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

test("exploration commands that merely mention a script name are not verification", () => {
  assert.equal(isVerificationCommand("rg -n typecheck package.json"), false);
  assert.equal(isVerificationCommand("grep -r test:unit ."), false);
  assert.equal(isVerificationCommand("cat scripts/test:ci.sh"), false);
  assert.equal(isVerificationCommand("npm run test:unit"), true);
  assert.equal(isVerificationCommand("cd packages/server && npm run typecheck"), true);

  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "rg -n typecheck package.json" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }],
      },
    },
  ]);
  assert.equal(extractVerificationReceiptFromLog(logPath, { headShaHint: SHA }), null);
});

test("detailFromOutput prefers runner-shaped counts over bare n/m", () => {
  const logPath = writeLog([
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run test:unit" } }],
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
            content: "coverage 9/15\n# pass 836\n# fail 0\n",
          },
        ],
      },
    },
  ]);
  const receipt = extractVerificationReceiptFromLog(logPath, { headShaHint: SHA });
  assert.ok(receipt);
  assert.equal(receipt!.commands[0]!.detail, "836 passed");
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

test("shouldCarryVerificationReceipt excludes checks_failed retries", () => {
  assert.equal(shouldCarryVerificationReceipt("Developer session failed or crashed."), true);
  assert.equal(shouldCarryVerificationReceipt("Developer session timed out."), true);
  assert.equal(shouldCarryVerificationReceipt("Developer's PR checks failed."), false);
  assert.equal(shouldCarryVerificationReceipt(undefined), false);
});

test("receiptSupersededByFailedChecks matches CI failure at the same tip SHA", () => {
  const receipt = parseVerificationReceipt({
    headSha: SHA,
    commands: [{ command: "npm test", outcome: "passed" }],
    recordedAt: "2026-09-17T00:00:00.000Z",
  })!;
  assert.equal(
    receiptSupersededByFailedChecks(receipt, { snapshot: "failure", headSha: SHA }),
    true
  );
  assert.equal(
    receiptSupersededByFailedChecks(receipt, { snapshot: "failure", headSha: SHA2 }),
    false
  );
  assert.equal(
    receiptSupersededByFailedChecks(receipt, { snapshot: "success", headSha: SHA }),
    false
  );
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

test("formatVerificationReceiptSection scopes skip guidance when outcomes are mixed", () => {
  const section = formatVerificationReceiptSection({
    headSha: SHA,
    commands: [
      { command: "npm run typecheck", outcome: "passed" },
      { command: "npm run test:unit", outcome: "failed" },
    ],
    recordedAt: "2026-09-17T00:00:00.000Z",
  }).join("\n");
  assert.doesNotMatch(section, /Do not re-run an unchanged green suite by default/);
  assert.match(section, /Treat only commands marked passed as already green/);
});
