// packages/server/src/pid-marker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimPidMarker, releasePidMarker, readPidMarkerOwner } from "./pid-marker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(__dirname, "pid-marker-claim-child.ts");
const tsxBin = path.join(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx");

/** Resolves once the child has actually exited — killing it alone isn't enough to keep
 * the test process from hanging afterward: an unresolved 'exit' event leaves the child's
 * handle open, and node:test won't let the process exit while one is outstanding. */
function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

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

test(
  "concurrent reclaim of the same stale marker: exactly one real process wins, never a corrupted mix of both",
  { timeout: 20000 },
  () => {
    // Real child processes, not an in-process simulation — a fake interleaving inside one
    // JS event loop can't actually exercise the OS-level race between two independent
    // processes both reading "stale", both deciding to reclaim, and both replacing the
    // marker. Before the reclaim-lock fix, this reliably produced runs where more than one
    // child reported claimed:true for the same marker.
    const filePath = tempMarkerPath();
    fs.writeFileSync(filePath, JSON.stringify({ pid: 999999, startedAt: "x" })); // stale

    const N = 8;
    const children = Array.from({ length: N }, () =>
      spawn(tsxBin, [childScript, filePath], { stdio: ["ignore", "pipe", "inherit"] })
    );

    // The winner(s) stay alive on purpose (see the helper script) — so wait for each
    // child's single result line, not for the process to exit.
    const firstLines = children.map(
      (child) =>
        new Promise<string>((resolve) => {
          let buf = "";
          child.stdout.on("data", (d) => {
            buf += d.toString();
            const nl = buf.indexOf("\n");
            if (nl !== -1) resolve(buf.slice(0, nl));
          });
        })
    );

    return Promise.all(firstLines)
      .then((lines) => {
        const results = lines.map((l) => JSON.parse(l) as { pid: number; claimed: boolean });
        const winners = results.filter((r) => r.claimed);
        assert.equal(winners.length, 1, `expected exactly one winner, got: ${JSON.stringify(results)}`);

        const finalOwner = readPidMarkerOwner(filePath);
        assert.equal(finalOwner?.pid, winners[0].pid, "the file must name the one process that actually won");

        // No leftover reclaim-lock from any of the N attempts.
        assert.equal(fs.existsSync(`${filePath}.reclaim-lock`), false);
      })
      .finally(() => {
        // SIGTERM, not SIGKILL: the tsx launcher forwards SIGTERM to the real node process
        // it forks to actually run the script before exiting; SIGKILL only kills the
        // launcher itself (an unblockable signal it never gets to react to), orphaning
        // that grandchild — which is exactly the live process holding server.pid's
        // real-world equivalent open, so it (and this whole test process) would hang.
        for (const child of children) child.kill("SIGTERM");
        return Promise.all(children.map(waitForExit));
      });
  }
);

test("acquireReclaimLock's own lock never lingers after a normal claim", () => {
  const filePath = tempMarkerPath();
  fs.writeFileSync(filePath, JSON.stringify({ pid: 999999, startedAt: "x" }));
  claimPidMarker(filePath);
  assert.equal(fs.existsSync(`${filePath}.reclaim-lock`), false);
});

test("sanity: the child helper script actually claims when run alone", async () => {
  const filePath = tempMarkerPath();
  const child = spawn(tsxBin, [childScript, filePath], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const parsed = JSON.parse(buf.slice(0, nl));
      assert.equal(parsed.claimed, true);
      assert.equal(readPidMarkerOwner(filePath)?.pid, parsed.pid);
      resolve();
    });
  });
  child.kill("SIGTERM"); // see the concurrent-reclaim test for why SIGTERM, not SIGKILL
  await waitForExit(child);
});
