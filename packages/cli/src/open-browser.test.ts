import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  formatBrowserOpenFailure,
  openUrlInSystemBrowser,
  resolveBrowserOpenCommand,
  type BrowserSpawnFn,
} from "./open-browser.js";

class FakeChild extends EventEmitter {
  unrefCalled = false;
  unref(): void {
    this.unrefCalled = true;
  }
}

function spawnStub(child: FakeChild, onSpawn?: (command: string, args: string[]) => void): BrowserSpawnFn {
  return (command, args) => {
    onSpawn?.(command, args);
    return child;
  };
}

test("opener command per platform is unchanged (open / start / xdg-open)", () => {
  assert.equal(resolveBrowserOpenCommand("darwin"), "open");
  assert.equal(resolveBrowserOpenCommand("win32"), "start");
  assert.equal(resolveBrowserOpenCommand("linux"), "xdg-open");
});

test("spawn failure (ENOENT) surfaces as a failure result, not silent success", async () => {
  const child = new FakeChild();
  const seen: { command?: string; args?: string[] } = {};
  const pending = openUrlInSystemBrowser("http://127.0.0.1:9999", {
    platform: "linux",
    spawnFn: spawnStub(child, (command, args) => {
      seen.command = command;
      seen.args = args;
    }),
  });
  const failure = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
  child.emit("error", failure);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.command, "xdg-open");
  assert.equal(result.url, "http://127.0.0.1:9999");
  assert.equal(seen.command, "xdg-open");
  assert.deepEqual(seen.args, ["http://127.0.0.1:9999"]);
  if (result.ok) assert.fail("expected a failure result");
  assert.equal(result.error, failure);
});

test("synchronous spawn throw surfaces as a failure result", async () => {
  const thrown = new Error("spawn open ENOENT");
  const result = await openUrlInSystemBrowser("http://127.0.0.1:9999", {
    platform: "darwin",
    spawnFn: () => {
      throw thrown;
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected a failure result");
  assert.equal(result.command, "open");
  assert.equal(result.error, thrown);
});

test("clean spawn resolves ok without claiming a confirmed window", async () => {
  const child = new FakeChild();
  const pending = openUrlInSystemBrowser("http://127.0.0.1:9999", { spawnFn: spawnStub(child) });
  child.emit("spawn");
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(child.unrefCalled, true);
});

test("failure message names the opener, the error, and the manual-URL fallback", () => {
  const message = formatBrowserOpenFailure({
    ok: false,
    command: "xdg-open",
    url: "http://127.0.0.1:9999",
    error: new Error("spawn xdg-open ENOENT"),
  });
  assert.match(message, /xdg-open/);
  assert.match(message, /spawn xdg-open ENOENT/);
  assert.match(message, /http:\/\/127\.0\.0\.1:9999/);
  assert.match(message, /[Mm]anually/);
  assert.doesNotMatch(message, /opened/i);
});
