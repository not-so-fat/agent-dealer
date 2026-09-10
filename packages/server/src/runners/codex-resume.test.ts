import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexExecArgs } from "./codex-args.js";

test("execute resume argv matches Claude-style fix-round handoff", () => {
  const args = buildCodexExecArgs({
    mode: "execute",
    workspaceRoot: "/tmp/ws",
    prompt: "Address the human feedback and continue.",
    resumeSessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.deepEqual(args.slice(-3), [
    "resume",
    "0199a213-81c0-7800-8aa1-bbab2a035a53",
    "Address the human feedback and continue.",
  ]);
});
