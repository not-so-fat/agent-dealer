// packages/server/src/adapters/worktree-deps.test.ts
//
// NOT-315: the pre-spawn dependency step runs `npm ci` exactly once when the
// worktree declares npm dependencies, skips otherwise, and surfaces install
// failures with the stderr tail — all against a fake runner, never a registry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktreeDeps, NPM_CI_ARGS, type WorktreeDepsRunner } from "./worktree-deps.js";

let dirs: string[] = [];

function makeWorktree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-deps-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const PKG = JSON.stringify({ name: "wt", version: "1.0.0" });
const LOCK = JSON.stringify({ name: "wt", lockfileVersion: 3, packages: {} });

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

function recordingRunner(calls: Call[]): WorktreeDepsRunner {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    return { stdout: "", stderr: "" };
  };
}

test("lockfile present and node_modules absent -> install runs once with the expected args and cwd", async () => {
  const dir = makeWorktree({ "package.json": PKG, "package-lock.json": LOCK });
  const calls: Call[] = [];
  const result = await ensureWorktreeDeps(dir, { runner: recordingRunner(calls), timeoutMs: 1234 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "npm");
  assert.deepEqual(calls[0]!.args, [...NPM_CI_ARGS]);
  assert.deepEqual(calls[0]!.args, ["ci", "--prefer-offline", "--no-audit", "--no-fund"]);
  assert.equal(calls[0]!.cwd, dir);
  assert.equal(calls[0]!.timeoutMs, 1234);
  assert.equal(result.ran, true);
  if (result.ran) assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
});

test("node_modules present -> skipped without running anything", async () => {
  const dir = makeWorktree({ "package.json": PKG, "package-lock.json": LOCK });
  fs.mkdirSync(path.join(dir, "node_modules"));
  const calls: Call[] = [];
  const result = await ensureWorktreeDeps(dir, { runner: recordingRunner(calls) });
  assert.equal(calls.length, 0);
  assert.equal(result.ran, false);
  if (!result.ran) assert.match(result.reason, /node_modules/);
  assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
});

test("no lockfile -> skipped without running anything", async () => {
  const dir = makeWorktree({ "package.json": PKG });
  const calls: Call[] = [];
  const result = await ensureWorktreeDeps(dir, { runner: recordingRunner(calls) });
  assert.equal(calls.length, 0);
  assert.equal(result.ran, false);
  if (!result.ran) assert.match(result.reason, /no lockfile/);
});

test("no package.json -> skipped without running anything", async () => {
  const dir = makeWorktree({ "README.md": "hello\n" });
  const calls: Call[] = [];
  const result = await ensureWorktreeDeps(dir, { runner: recordingRunner(calls) });
  assert.equal(calls.length, 0);
  assert.equal(result.ran, false);
});

test("another package manager's lockfile -> skipped without running anything", async () => {
  for (const lock of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
    const dir = makeWorktree({ "package.json": PKG, [lock]: "lock\n" });
    const calls: Call[] = [];
    const result = await ensureWorktreeDeps(dir, { runner: recordingRunner(calls) });
    assert.equal(calls.length, 0, `${lock} must not trigger npm`);
    assert.equal(result.ran, false);
    if (!result.ran) assert.match(result.reason, /non-npm lockfile/);
  }
});

test("a failing install throws with the stderr tail", async () => {
  const dir = makeWorktree({ "package.json": PKG, "package-lock.json": LOCK });
  const failing: WorktreeDepsRunner = async () => {
    const err = new Error("npm ci exited") as Error & { stderr: string };
    err.stderr = "npm error code E500\nnpm error registry exploded on line 42\n";
    throw err;
  };
  await assert.rejects(() => ensureWorktreeDeps(dir, { runner: failing }), (err: Error) => {
    assert.match(err.message, /^dependency install failed: /);
    assert.match(err.message, /registry exploded on line 42/);
    return true;
  });
});

test("a timed-out install throws with the same dependency-install prefix", async () => {
  const dir = makeWorktree({ "package.json": PKG, "package-lock.json": LOCK });
  const timingOut: WorktreeDepsRunner = async () => {
    throw new Error("npm ci timed out after 300000ms — network or registry may be down");
  };
  await assert.rejects(() => ensureWorktreeDeps(dir, { runner: timingOut }), (err: Error) => {
    assert.match(err.message, /^dependency install failed: /);
    assert.match(err.message, /timed out/);
    return true;
  });
});

test("a failing install removes a leftover node_modules so an infra retry reinstalls", async () => {
  // npm ci that dies mid-reify (or is SIGTERM-killed by the execFile timeout)
  // can leave a partial node_modules behind; the retry reuses the leftover
  // worktree, so the husk must be gone or the retry would skip the install.
  const dir = makeWorktree({ "package.json": PKG, "package-lock.json": LOCK });
  const failing: WorktreeDepsRunner = async (_cmd, _args, opts) => {
    fs.mkdirSync(path.join(opts.cwd, "node_modules", "half-written-pkg"), { recursive: true });
    fs.writeFileSync(path.join(opts.cwd, "node_modules", "half-written-pkg", "index.js"), "partial\n");
    const err = new Error("npm ci exited") as Error & { stderr: string };
    err.stderr = "npm error code E500\nnpm error registry exploded on line 42\n";
    throw err;
  };
  await assert.rejects(() => ensureWorktreeDeps(dir, { runner: failing }), (err: Error) => {
    assert.match(err.message, /^dependency install failed: /);
    assert.match(err.message, /registry exploded on line 42/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, "partial node_modules must be removed");
});

test("a killed (timed-out) install names the timeout in the reason", async () => {
  const dir = makeWorktree({ "package.json": PKG, "package-lock.json": LOCK });
  const killed: WorktreeDepsRunner = async () => {
    // Shape of a real execFile timeout: killed by SIGTERM with little stderr.
    const err = new Error("Command failed: npm ci --prefer-offline --no-audit --no-fund") as Error & {
      killed: boolean;
      signal: string;
    };
    err.killed = true;
    err.signal = "SIGTERM";
    throw err;
  };
  await assert.rejects(() => ensureWorktreeDeps(dir, { runner: killed, timeoutMs: 4321 }), (err: Error) => {
    assert.match(err.message, /^dependency install failed: /);
    assert.match(err.message, /timed out after 4321ms/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
});
