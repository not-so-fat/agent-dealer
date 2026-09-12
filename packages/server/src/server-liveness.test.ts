// packages/server/src/server-liveness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** A genuinely alive, same-user child pid — safe to signal, unlike e.g. pid 1 (which is
 * alive but throws EPERM rather than ESRCH for an unprivileged process.kill probe). */
function spawnLiveChild(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

function freshHome(): void {
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-server-liveness-"));
}

const { writeServerPidFile, removeServerPidFile, serverPidFilePath } = await import("./server-liveness.js");

test("writeServerPidFile claims the marker when none exists", () => {
  freshHome();
  const claimed = writeServerPidFile(3221);
  assert.equal(claimed, true);
  const state = JSON.parse(fs.readFileSync(serverPidFilePath(), "utf8"));
  assert.equal(state.pid, process.pid);
  assert.equal(state.port, 3221);
});

test("writeServerPidFile refuses to clobber a marker owned by a different, live pid", () => {
  freshHome();
  const other = spawnLiveChild();
  try {
    const filePath = serverPidFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ pid: other.pid, port: 9999, startedAt: "x" }));
    const claimed = writeServerPidFile(3221);
    assert.equal(claimed, false);
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(state.pid, other.pid, "the other live owner's marker must be untouched");
  } finally {
    other.kill();
  }
});

test("writeServerPidFile reclaims a stale marker (dead pid)", () => {
  freshHome();
  const filePath = serverPidFilePath();
  fs.writeFileSync(filePath, JSON.stringify({ pid: 999999, port: 9999, startedAt: "x" }));
  const claimed = writeServerPidFile(3221);
  assert.equal(claimed, true);
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(state.pid, process.pid);
});

test("writeServerPidFile reclaims an unreadable/corrupt marker", () => {
  freshHome();
  const filePath = serverPidFilePath();
  fs.writeFileSync(filePath, "not json");
  const claimed = writeServerPidFile(3221);
  assert.equal(claimed, true);
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(state.pid, process.pid);
});

test("removeServerPidFile only removes a marker that currently names this process", () => {
  freshHome();
  const other = spawnLiveChild();
  try {
    const filePath = serverPidFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ pid: other.pid, port: 9999, startedAt: "x" }));
    removeServerPidFile(); // this process never owned it — a loser's cleanup, essentially
    assert.ok(fs.existsSync(filePath), "a marker owned by a different pid must survive removeServerPidFile()");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).pid, other.pid);
  } finally {
    other.kill();
  }
});

test("removeServerPidFile removes a marker this process does own", () => {
  freshHome();
  writeServerPidFile(3221);
  removeServerPidFile();
  assert.equal(fs.existsSync(serverPidFilePath()), false);
});

test("removeServerPidFile on an absent file is a no-op", () => {
  freshHome();
  assert.doesNotThrow(() => removeServerPidFile());
});
