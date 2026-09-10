import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexExecArgs, codexSandboxForMode } from "./codex-args.js";

test("codexSandboxForMode maps plan/qa to read-only and execute to workspace-write", () => {
  assert.equal(codexSandboxForMode("plan"), "read-only");
  assert.equal(codexSandboxForMode("qa"), "read-only");
  assert.equal(codexSandboxForMode("execute"), "workspace-write");
});

test("buildCodexExecArgs includes json, cd, sandbox, and prompt", () => {
  const args = buildCodexExecArgs({
    mode: "plan",
    workspaceRoot: "/tmp/ws",
    prompt: "draft a plan",
  });
  assert.deepEqual(args, [
    "exec",
    "--json",
    "-C",
    "/tmp/ws",
    "-s",
    "read-only",
    "draft a plan",
  ]);
});

test("buildCodexExecArgs resume places subcommand before prompt", () => {
  const args = buildCodexExecArgs({
    mode: "execute",
    workspaceRoot: "/tmp/ws",
    prompt: "fix the findings",
    resumeSessionId: "thread-abc",
    model: "gpt-5.6-sol",
  });
  assert.ok(args.includes("-s") && args[args.indexOf("-s") + 1] === "workspace-write");
  assert.deepEqual(args.slice(-3), ["resume", "thread-abc", "fix the findings"]);
  assert.ok(args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5.6-sol");
});

test("buildCodexExecArgs supports output-schema and -o", () => {
  const args = buildCodexExecArgs({
    mode: "qa",
    workspaceRoot: "/tmp/ws",
    prompt: "answer",
    outputSchemaPath: "/tmp/schema.json",
    outputLastMessagePath: "/tmp/last.json",
    addDirs: ["/tmp/extra"],
  });
  assert.ok(args.includes("--output-schema"));
  assert.equal(args[args.indexOf("--output-schema") + 1], "/tmp/schema.json");
  assert.ok(args.includes("-o"));
  assert.equal(args[args.indexOf("-o") + 1], "/tmp/last.json");
  assert.ok(args.includes("--add-dir"));
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/extra");
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
});

test("buildCodexExecArgs never emits danger flags", () => {
  const args = buildCodexExecArgs({
    mode: "execute",
    workspaceRoot: "/tmp/ws",
    prompt: "go",
  });
  const joined = args.join(" ");
  assert.equal(joined.includes("danger-full-access"), false);
  assert.equal(joined.includes("dangerously-bypass"), false);
});

test("buildCodexExecArgs allows danger-full-access in the prompt text", () => {
  const args = buildCodexExecArgs({
    mode: "plan",
    workspaceRoot: "/tmp/ws",
    prompt: "verify that danger-full-access is never used",
  });
  assert.equal(args.at(-1), "verify that danger-full-access is never used");
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
});
