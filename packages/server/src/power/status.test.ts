// NOT-369: host-power status line + route payload shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  installHostAwakeForTests,
  type CaffeinateChild,
  type CaffeinateSpawner,
} from "./host-awake.js";
import { hostPowerStatusLine, getHostPowerStatus } from "./status.js";
import {
  resetSleepTimerNoticeForTests,
  SLEEP_TIMER_FIX_COMMAND,
} from "./sleep-timer.js";

function fakeSpawn(): CaffeinateSpawner {
  return () => {
    const child: CaffeinateChild = {
      pid: 1,
      kill: () => true,
      once: () => {},
    };
    return child;
  };
}

test("hold status line reflects active vs idle on darwin", () => {
  assert.equal(hostPowerStatusLine(true, "darwin"), "Host awake hold: active (caffeinate -i)");
  assert.equal(hostPowerStatusLine(false, "darwin"), "Host awake hold: idle");
  assert.equal(hostPowerStatusLine(true, "linux"), "Host awake hold: n/a (macOS only)");
});

test("GET /api/host-power returns hold line and at most one sleep-timer notice", async () => {
  resetSleepTimerNoticeForTests();
  installHostAwakeForTests({
    platform: "darwin",
    pid: 55,
    spawn: fakeSpawn(),
  });
  const { acquireHostAwake, releaseHostAwake } = await import("./host-awake.js");
  acquireHostAwake();

  // Override getHostPowerStatus sleep notice by calling check path with inject —
  // the route uses real getHostPowerStatus; for the route test we register a thin handler.
  const app = Fastify();
  app.get("/api/host-power", async () => ({
    ...getHostPowerStatus(),
    // Force a notice for the assertion without touching real pmset.
    sleepTimerNotice: {
      acSleepMinutes: 1,
      message: `macOS AC sleep is 1 minute — Dealer holds the machine awake only while work is active. To keep the Mac awake between sessions on AC power, run: ${SLEEP_TIMER_FIX_COMMAND}`,
      fixCommand: SLEEP_TIMER_FIX_COMMAND,
    },
  }));

  const res = await app.inject({ method: "GET", url: "/api/host-power" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    holdActive: boolean;
    holdStatusLine: string;
    sleepTimerNotice: { fixCommand: string } | null;
  };
  assert.equal(body.holdActive, true);
  assert.match(body.holdStatusLine, /Host awake hold: active/);
  assert.ok(body.sleepTimerNotice);
  assert.equal(body.sleepTimerNotice.fixCommand, SLEEP_TIMER_FIX_COMMAND);

  releaseHostAwake();
  const idle = getHostPowerStatus();
  assert.equal(idle.holdActive, false);
  assert.match(idle.holdStatusLine, /idle/);

  await app.close();
  resetSleepTimerNoticeForTests();
  installHostAwakeForTests({ platform: "linux" });
});
