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

test("NOT-366: a recorded Claude refresh failure titles each chip with the reason, never the failure kind", () => {
  const firstFailureAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const unavailable = {
    remainingPercent: null,
    source: "unavailable",
    unavailableReason: "unparsable",
    unavailableDetail: {
      message: "Claude /usage reported no 5H/1W plan limits",
      consecutiveFailures: 3,
      firstFailureAt,
      lastFailureAt: new Date(Date.now() - 60_000).toISOString(),
    },
  };
  const failed = {
    generatedAt: new Date().toISOString(),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: "unparsable",
        windows: [
          window({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, criticalRole: "five_hour", ...unavailable }),
          window({ windowKey: "weekly", displayLabel: "1W", criticalRole: "weekly", ...unavailable }),
        ],
      },
    ],
  } as unknown as RuntimeCapacityResponse;
  const out = renderToStaticMarkup(React.createElement(RuntimeCapacityStripView, { data: failed }));
  const since = new Date(firstFailureAt).toLocaleString();
  const why = `unavailable: Claude /usage reported no 5H/1W plan limits (3 consecutive failed refreshes since ${since})`;
  assert.ok(out.includes(`5H: N/A (${why})`), "5H chip states unavailable and why");
  assert.ok(out.includes(`1W: N/A (${why})`), "1W chip states unavailable and why");
  assert.ok(!out.includes("no_windows"), "internal failure kind never reaches the DOM");
});

// NOT-440: the active hard cap overlays the compact strip.
const { selectStripRows } = await import("./RuntimeCapacityStrip.js");
const CAP_NOW = Date.parse("2026-10-12T18:20:00.000Z");
const CAP_RESET = "2026-10-12T18:59:01.000Z";

function capWindow(over: Record<string, unknown>) {
  return window({
    resetAt: "2026-10-16T02:00:00.000Z",
    observedAt: "2026-10-12T18:03:00.000Z",
    freshUntil: "2026-10-12T19:03:00.000Z",
    expiresAt: "2026-10-12T19:03:00.000Z",
    ...over,
  });
}

function pairEntry(runtime: string, windowRole: string | null, extra: unknown[] = []) {
  return {
    runtime,
    unavailableReason: null,
    windows: [
      capWindow({ windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: 50, resetAt: CAP_RESET, criticalRole: "five_hour" }),
      capWindow({ windowKey: "weekly", displayLabel: "1W", remainingPercent: 52, criticalRole: "weekly" }),
      ...extra,
    ],
    activeCap: { unavailableUntil: CAP_RESET, reason: `${runtime} usage capped`, windowRole },
  };
}

function capData(...runtimes: unknown[]): RuntimeCapacityResponse {
  return { generatedAt: new Date(CAP_NOW).toISOString(), runtimes } as unknown as RuntimeCapacityResponse;
}

test("NOT-440: reproduced Muse cap renders 5H 0% (critical) and 1W 52%", () => {
  const markup = renderToStaticMarkup(
    React.createElement(RuntimeCapacityStripView, { data: capData(pairEntry("muse_code", "five_hour")), nowMs: CAP_NOW })
  );
  const five = markup.match(/data-testid="capacity-window-five_hour"[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
  const week = markup.match(/data-testid="capacity-window-weekly"[\s\S]*?<\/span><\/span>/)?.[0] ?? "";
  assert.match(five, /5H/);
  assert.match(five, /data-severity="critical"[^>]*>0%/);
  assert.match(five, /capped until/);
  assert.match(week, /1W/);
  assert.match(week, /52%/);
  assert.ok(!markup.includes("50%"), "stored 5H value is not presented while capped");
});

test("NOT-440: mapped caps per runtime zero only the mapped compact row; diagnostics never render", () => {
  const diagnostic = capWindow({ windowKey: "muse_account_usage", displayLabel: "muse_account_usage", remainingPercent: 90, criticalRole: null });
  const cursorEntry = {
    runtime: "cursor_local",
    unavailableReason: null,
    windows: [capWindow({ windowKey: "billing_cycle", displayLabel: "September 2026", remainingPercent: 70, resetAt: "2026-11-01T00:00:00.000Z" })],
    activeCap: { unavailableUntil: "2026-11-01T00:00:00.000Z", reason: "cursor capped", windowRole: "billing_cycle" },
  };
  const cases = [
    { entry: pairEntry("claude_code", "five_hour"), expected: [["5H", 0], ["1W", 52]] },
    { entry: pairEntry("codex_local", "weekly"), expected: [["5H", 50], ["1W", 0]] },
    { entry: pairEntry("muse_code", "five_hour", [diagnostic]), expected: [["5H", 0], ["1W", 52]] },
    { entry: cursorEntry, expected: [["1M", 0]] },
  ];
  for (const c of cases) {
    const rows = selectStripRows(c.entry as unknown as RuntimeCapacityResponse["runtimes"][number], CAP_NOW);
    assert.deepEqual(
      rows.map((r) => [r.label, r.kind === "known" ? r.remaining : r.kind]),
      c.expected,
      c.entry.runtime
    );
  }
});

test("NOT-440: an unmapped cap renders an explicit capped state, never positive percentages", () => {
  const cursorEntry = {
    runtime: "cursor_local",
    unavailableReason: null,
    windows: [capWindow({ windowKey: "billing_cycle", displayLabel: "September 2026", remainingPercent: 70 })],
    activeCap: { unavailableUntil: CAP_RESET, reason: "cursor capped", windowRole: null },
  };
  const markup = renderToStaticMarkup(
    React.createElement(RuntimeCapacityStripView, {
      data: capData(pairEntry("muse_code", null), cursorEntry),
      nowMs: CAP_NOW,
    })
  );
  assert.equal((markup.match(/data-testid="capacity-window-capped"/g) ?? []).length, 2);
  assert.match(markup, />capped</);
  assert.ok(!/>\d+%</.test(markup), "no percentage renders while the runtime is capped");
});

test("NOT-440: at and after unavailableUntil the overlay is gone and snapshot rules apply", () => {
  for (const offset of [0, 1]) {
    const nowMs = Date.parse(CAP_RESET) + offset;
    const entry = pairEntry("muse_code", "five_hour");
    // Server-side classification at the boundary: the 5H reset has passed.
    entry.windows[0] = capWindow({
      windowKey: "five_hour", displayLabel: "5H", durationMinutes: 300, remainingPercent: null,
      resetAt: CAP_RESET, criticalRole: "five_hour", unavailableReason: "expired", source: "unavailable",
    });
    const rows = selectStripRows(entry as unknown as RuntimeCapacityResponse["runtimes"][number], nowMs);
    assert.deepEqual(
      rows.map((r) => [r.label, r.kind === "known" ? r.remaining : r.kind]),
      [["5H", "unknown"], ["1W", 52]],
      `offset ${offset}ms`
    );
  }
});
