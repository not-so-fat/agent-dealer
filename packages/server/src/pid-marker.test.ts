// packages/server/src/pid-marker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claimPidMarker, releasePidMarker, readPidMarkerOwner } from "./pid-marker.js";

function tempMarkerPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-pid-marker-")), "marker.json");
}

/** A genuinely alive, same-user child pid — safe to signal, unlike e.g. pid 1 (which is
 * alive but throws EPERM rather than ESRCH for an unprivileged process.kill probe). */
function spawnLiveChild(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

test("claimPidMarker claims an absent marker", () => {
  const filePath = tempMarkerPath();
  assert.equal(claimPidMarker(filePath), true);
  const owner = readPidMarkerOwner(filePath);
  assert.equal(owner?.pid, process.pid);
  assert.equal(owner?.alive, true);
});

test("claimPidMarker stores extra fields alongside pid/startedAt", () => {
  const filePath = tempMarkerPath();
  claimPidMarker(filePath, { role: "migration", port: 1234 });
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(raw.role, "migration");
  assert.equal(raw.port, 1234);
  assert.equal(typeof raw.startedAt, "string");
});

test("claimPidMarker refuses a marker owned by a different, live pid — and does not touch it", () => {
  const filePath = tempMarkerPath();
  const other = spawnLiveChild();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ pid: other.pid, startedAt: "x" }));
    assert.equal(claimPidMarker(filePath), false);
    const owner = readPidMarkerOwner(filePath);
    assert.equal(owner?.pid, other.pid);
    assert.equal(owner?.alive, true);
  } finally {
    other.kill();
  }
});

test("claimPidMarker reclaims a stale marker (dead pid)", () => {
  const filePath = tempMarkerPath();
  fs.writeFileSync(filePath, JSON.stringify({ pid: 999999, startedAt: "x" }));
  assert.equal(claimPidMarker(filePath), true);
  assert.equal(readPidMarkerOwner(filePath)?.pid, process.pid);
});

test("claimPidMarker reclaims unreadable/corrupt content", () => {
  const filePath = tempMarkerPath();
  fs.writeFileSync(filePath, "not json");
  assert.equal(claimPidMarker(filePath), true);
  assert.equal(readPidMarkerOwner(filePath)?.pid, process.pid);
});

test("releasePidMarker removes a marker this process owns", () => {
  const filePath = tempMarkerPath();
  claimPidMarker(filePath);
  releasePidMarker(filePath);
  assert.equal(fs.existsSync(filePath), false);
});

test("releasePidMarker never removes a marker owned by a different pid", () => {
  const filePath = tempMarkerPath();
  const other = spawnLiveChild();
  try {
    fs.writeFileSync(filePath, JSON.stringify({ pid: other.pid, startedAt: "x" }));
    releasePidMarker(filePath);
    assert.ok(fs.existsSync(filePath));
    assert.equal(readPidMarkerOwner(filePath)?.pid, other.pid);
  } finally {
    other.kill();
  }
});

test("releasePidMarker on an absent file is a no-op", () => {
  const filePath = tempMarkerPath();
  assert.doesNotThrow(() => releasePidMarker(filePath));
});

test("readPidMarkerOwner distinguishes absent from stale", () => {
  const filePath = tempMarkerPath();
  assert.equal(readPidMarkerOwner(filePath), null);
  fs.writeFileSync(filePath, JSON.stringify({ pid: 999999, startedAt: "x" }));
  const owner = readPidMarkerOwner(filePath);
  assert.equal(owner?.pid, 999999);
  assert.equal(owner?.alive, false);
});
