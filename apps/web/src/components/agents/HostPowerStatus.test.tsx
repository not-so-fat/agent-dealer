// NOT-369: hold line + single dismissible sleep-timer notice in the health area.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostPowerStatusView, type HostPowerStatus } from "./HostPowerStatusView.js";

(globalThis as { React?: unknown }).React ??= React;

const base: HostPowerStatus = {
  platform: "darwin",
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
