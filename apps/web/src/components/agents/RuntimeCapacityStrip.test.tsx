// NOT-245: Runtime capacity strip states — known, multi-window, stale,
// unsupported — plus the narrow-layout wrapping contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;

const { renderToStaticMarkup } = await import("react-dom/server");
const { RuntimeCapacityStripView } = await import("./RuntimeCapacityStrip.js");
import type { RuntimeCapacityResponse } from "@agent-dealer/shared";

// Untagged by default: only windows carrying the server-tagged `criticalRole`
// (or Cursor's `billing_cycle`) are selected for display — see selectStripRows.
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
    criticalRole: null,
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
        window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 50, criticalRole: "five_hour" }),
        window({ windowKey: "weekly", displayLabel: "1W", remainingPercent: 65, criticalRole: "weekly" }),
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

test("deduped codex pair renders one 5H chip and one weekly chip, no aggregate aliases", () => {
  // NOT-263: after the server-side collapse, the mirrored logical pair
  // arrives once (detailed identity only) and the strip renders it once.
  // NOT-266: selection is by the server tag — the detailed pair is the
  // tagged critical pair.
  const deduped = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [
          window({ windowKey: "codex_limit_main_primary", displayLabel: "5H", durationMinutes: 300, remainingPercent: 30, criticalRole: "five_hour" }),
          window({ windowKey: "codex_limit_main_secondary", displayLabel: "1W", durationMinutes: 10080, remainingPercent: 95, criticalRole: "weekly" }),
        ],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const dedupedHtml = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: deduped }));
  assert.match(dedupedHtml, /capacity-window-codex_limit_main_primary/);
  assert.match(dedupedHtml, /capacity-window-codex_limit_main_secondary/);
  assert.ok(!dedupedHtml.includes("codex_rate_limit_"), "no aggregate alias chips");
  const fiveHourChips = (dedupedHtml.match(/>5H</g) ?? []).length;
  assert.equal(fiveHourChips, 1);
});

test("remaining under 10% renders critical (red, bold)", () => {
  const critical = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 9, criticalRole: "five_hour" })],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: critical }));
  assert.match(html, /data-severity="critical"/);
  assert.match(html, /font-bold/);
  assert.match(html, /text-red-400/);
});

test("remaining under 30% renders warning (yellow)", () => {
  const warning = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 29, criticalRole: "five_hour" })],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: warning }));
  assert.match(html, /data-severity="warning"/);
  assert.match(html, /text-yellow-400/);
  assert.ok(!html.includes("text-red-400"));
});

test("remaining at or above 30% renders normal severity, no red or yellow", () => {
  const normal = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 30, criticalRole: "five_hour" })],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: normal }));
  assert.match(html, /data-severity="normal"/);
  assert.ok(!html.includes("text-red-400"));
  assert.ok(!html.includes("text-yellow-400"));
});

test("severity is decided from the raw value, not the rounded display value", () => {
  // 9.6% rounds to a displayed 10% but is still under the 10% critical
  // threshold; 29.6% rounds to a displayed 30% but is still under 30%.
  const data = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [
          window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 9.6, criticalRole: "five_hour" }),
          window({ windowKey: "weekly", displayLabel: "1W", remainingPercent: 29.6, criticalRole: "weekly" }),
        ],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data }));
  assert.match(html, /capacity-window-five_hour"[^]*?data-severity="critical"/, "9.6% stays critical despite rounding to 10%");
  assert.match(html, /capacity-window-weekly"[^]*?data-severity="warning"/, "29.6% stays warning despite rounding to 30%");
  assert.match(html, />10%</);
  assert.match(html, />30%</);
});

test("NOT-266: untagged buckets sharing a duration never render — only the tagged pair does", () => {
  // Two same-duration buckets with no tag are diagnostics, not the
  // account-wide pair: neither renders, and both public halves read N/A.
  const shared = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [
          window({ windowKey: "codex_limit_main_primary", displayLabel: "5H", durationMinutes: 300, remainingPercent: 30 }),
          window({ windowKey: "codex_limit_extra_primary", displayLabel: "5H", durationMinutes: 300, remainingPercent: 10 }),
        ],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const sharedHtml = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: shared }));
  assert.ok(!sharedHtml.includes("codex_limit_main_primary"), "untagged bucket never renders");
  assert.ok(!sharedHtml.includes("codex_limit_extra_primary"), "untagged bucket never renders");
  assert.ok(!/30%/.test(sharedHtml), "untagged numbers never present as current");
  assert.ok(!/10%/.test(sharedHtml), "untagged numbers never present as current");
  assert.match(sharedHtml, /N\/A/);
});

function sentinelWindow(over: Record<string, unknown> = {}) {
  return window({
    windowKey: "codex_account_rate_limits",
    providerBucket: "account",
    durationMinutes: null,
    displayLabel: "account_rate_limits",
    usedValue: null,
    usedUnit: null,
    remainingPercent: null,
    resetAt: null,
    source: "unavailable",
    unavailableReason: "missing",
    ...over,
  });
}

test("NOT-266: Codex failure sentinel alone reads 5H N/A + 1W N/A, never account_rate_limits", () => {
  const sentinelData = {
    generatedAt: new Date().toISOString(),
    runtimes: [{ runtime: "codex_local", unavailableReason: "missing", windows: [sentinelWindow()] }],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: sentinelData }));
  assert.match(html, /Codex/);
  assert.match(html, /N\/A/);
  assert.ok(!html.includes("account_rate_limits"), "sentinel label never renders");
  assert.ok(!html.includes("codex_account_rate_limits"), "sentinel key never renders");
});

test("NOT-266: Muse failure sentinel alone reads 5H N/A + 1W N/A, never account_usage", () => {
  const sentinelData = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "muse_code",
        unavailableReason: "missing",
        windows: [sentinelWindow({ windowKey: "muse_account_usage", displayLabel: "account_usage" })],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: sentinelData }));
  assert.match(html, /Muse Code/);
  assert.match(html, /N\/A/);
  assert.ok(!html.includes("account_usage"), "sentinel label never renders");
  assert.ok(!html.includes("muse_account_usage"), "sentinel key never renders");
});

test("NOT-266: Cursor billing_cycle renders exactly one 1M chip", () => {
  const cursorData = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "cursor_local",
        unavailableReason: null,
        windows: [
          window({
            windowKey: "billing_cycle",
            providerBucket: "individual",
            durationMinutes: null,
            displayLabel: "billing cycle",
            remainingPercent: 65,
            source: "experimental_api",
          }),
        ],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: cursorData }));
  assert.match(html, /capacity-window-billing_cycle/);
  assert.equal((html.match(/>1M</g) ?? []).length, 1, "exactly one 1M chip");
  assert.match(html, /65%/);
  assert.ok(!html.includes("billing_cycle\" data-reason"), "known chip carries no N/A reason");
  assert.match(html, /current billing cycle/, "tooltip names the billing-cycle source");
  assert.match(html, /resets/, "tooltip keeps the reset");
});

test("NOT-266: model-specific extras never render alongside the tagged pair", () => {
  const extras = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [
          window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 80, criticalRole: "five_hour" }),
          window({ windowKey: "weekly", displayLabel: "1W", remainingPercent: 40, criticalRole: "weekly" }),
          window({ windowKey: "seven_day_sonnet", providerBucket: "seven_day_sonnet", remainingPercent: 12 }),
          window({ windowKey: "seven_day_opus", providerBucket: "seven_day_opus", remainingPercent: 0 }),
        ],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const html = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: extras }));
  assert.equal((html.match(/>5H</g) ?? []).length, 1, "one 5H chip");
  assert.equal((html.match(/>1W</g) ?? []).length, 1, "one 1W chip");
  assert.ok(!html.includes("seven_day_sonnet"), "extra key never renders");
  assert.ok(!html.includes("seven_day_opus"), "extra key never renders");
  assert.ok(!/>0%/.test(html), "hidden extra zero never renders");
  assert.match(html, /80%/);
  assert.match(html, /40%/);
});

test("NOT-266: each runtime label stays grouped with its own values on narrow widths", () => {
  assert.match(html, /whitespace-nowrap/, "labels and chips never split");
  assert.match(html, /capacity-entry-claude_code/);
  assert.match(html, /capacity-entry-cursor_local-na/);
});
