// NOT-245: Runtime capacity strip states — known, multi-window, stale,
// unsupported — plus the narrow-layout wrapping contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;

const { renderToStaticMarkup } = await import("react-dom/server");
const { RuntimeCapacityStripView } = await import("./RuntimeCapacityStrip.js");
import type { RuntimeCapacityResponse } from "@agent-dealer/shared";

function window(over: Record<string, unknown> = {}) {
  return {
    windowKey: "weekly",
    providerBucket: "all_models",
    durationMinutes: 10080,
    displayLabel: "1W",
    usedValue: 35,
    usedUnit: "percent",
    remainingPercent: 65,
    resetAt: new Date(Date.now() + 3600_000).toISOString(),
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    freshUntil: new Date(Date.now() + 600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    source: "supported_protocol",
    unavailableReason: null,
    ...over,
  };
}

const data = {
  generatedAt: new Date().toISOString(),
  runtimes: [
    {
      runtime: "claude_code",
      unavailableReason: null,
      windows: [
        window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 50 }),
        window({ windowKey: "weekly", displayLabel: "1W", remainingPercent: 65 }),
      ],
    },
    {
      runtime: "cursor_local",
      unavailableReason: "unsupported",
      windows: [],
    },
    {
      runtime: "codex_local",
      unavailableReason: "stale",
      windows: [window({ windowKey: "weekly", remainingPercent: null, unavailableReason: "stale", source: "unavailable" })],
    },
  ],
} as unknown as RuntimeCapacityResponse;

const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data }));

test("known multi-window entry shows both remaining percents", () => {
  assert.match(html, /capacity-entry-claude_code/);
  assert.match(html, /5H/);
  assert.match(html, /50%/);
  assert.match(html, /65%/);
});

test("unsupported, missing, and stale render N/A with distinct reasons", () => {
  assert.match(html, /capacity-entry-cursor_local-na/);
  assert.match(html, /data-reason="unsupported"/);
  assert.match(html, /data-reason="stale"/);
  assert.ok(!html.includes('data-reason="unsupported" data-reason="stale"'));
});

test("strip wraps instead of growing: flex-wrap root, nowrap chips, one entry per runtime", () => {
  assert.match(html, /flex-wrap/);
  assert.match(html, /whitespace-nowrap/);
  const claudeCount = (html.match(/capacity-entry-claude_code"/g) ?? []).length;
  assert.equal(claudeCount, 1);
});
