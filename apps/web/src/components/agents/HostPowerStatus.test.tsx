// NOT-369: hold line + single dismissible sleep-timer notice in the health area.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HostPowerStatusView,
  hostPowerSleepNoticeDismissKey,
  type HostPowerStatus,
} from "./HostPowerStatusView.js";

(globalThis as { React?: unknown }).React ??= React;

const base: HostPowerStatus = {
  platform: "darwin",
  serverInstanceId: "pid-test-aaa",
  holdActive: true,
  holdCount: 1,
  holdStatusLine: "Host awake hold: active (caffeinate -i)",
  sleepTimerNotice: {
    acSleepMinutes: 1,
    message:
      "macOS AC sleep is 1 minute — Dealer holds the machine awake only while work is active. To keep the Mac awake between sessions on AC power, run: sudo pmset -c sleep 0",
    fixCommand: "sudo pmset -c sleep 0",
  },
};

test("status surface shows the hold line and one sleep-timer notice", () => {
  const html = renderToStaticMarkup(React.createElement(HostPowerStatusView, { status: base }));
  assert.match(html, /data-testid="host-power-hold-line"/);
  assert.match(html, /Host awake hold: active \(caffeinate -i\)/);
  assert.match(html, /data-testid="host-power-sleep-notice"/);
  assert.match(html, /sudo pmset -c sleep 0/);
  assert.equal(html.split('data-testid="host-power-sleep-notice"').length - 1, 1);
});

test("idle hold line with no notice renders only the status line", () => {
  const html = renderToStaticMarkup(
    React.createElement(HostPowerStatusView, {
      status: {
        ...base,
        holdActive: false,
        holdCount: 0,
        holdStatusLine: "Host awake hold: idle",
        sleepTimerNotice: null,
      },
    })
  );
  assert.match(html, /Host awake hold: idle/);
  assert.doesNotMatch(html, /host-power-sleep-notice/);
});

test("dismissal key is scoped to serverInstanceId (once per server start)", () => {
  const a = hostPowerSleepNoticeDismissKey("pid-1-abc");
  const b = hostPowerSleepNoticeDismissKey("pid-2-def");
  assert.match(a, /pid-1-abc/);
  assert.match(b, /pid-2-def/);
  assert.notEqual(a, b, "restart must get a distinct dismissal identity");
  // Same message across restarts must not share a key — key is instance id, not message.
  assert.equal(hostPowerSleepNoticeDismissKey("pid-1-abc"), a);
});
