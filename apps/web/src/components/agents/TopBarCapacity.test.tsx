// NOT-264: top-bar dual-window (5H/1W) capacity summary — both labeled values
// render independently in deterministic 5H-then-1W order, either window at 0%
// marks the runtime block exhausted while both values stay visible, and a
// partially unknown pair shows the known value plus a labeled N/A (never the
// known number as a complete status). Loading, fetch-unavailable,
// stale/unknown, and narrow-viewport grouping contracts from NOT-262 hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;

register("../../test-helpers/asset-stub-hooks.mjs", import.meta.url);

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router-dom");
const { TopBarCapacityView, summarizeCapacity } = await import("./TopBarCapacity.js");
const { ShellHeader } = await import("../../App.js");
// NOTE: from src/components/agents/ this resolves to src/App.js — the shell
// header that owns the top bar.
import type { RuntimeCapacityResponse } from "@agent-dealer/shared";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

// criticalRole defaults to the account-wide 5H role: this is what the server
// now tags, never re-derived here from windowKey/label/duration. Any window
// meant to be a non-critical extra must override it to null explicitly.
function window(over: Record<string, unknown> = {}) {
  return {
    windowKey: "five_hour",
    providerBucket: "all_models",
    durationMinutes: 300,
    displayLabel: "5H",
    usedValue: 35,
    usedUnit: "percent",
    remainingPercent: 65,
    resetAt: iso(NOW + 3600_000),
    observedAt: iso(NOW - 60_000),
    freshUntil: iso(NOW + 600_000),
    expiresAt: iso(NOW + 3600_000),
    source: "supported_protocol",
    unavailableReason: null,
    criticalRole: "five_hour",
    ...over,
  };
}

function weekly(over: Record<string, unknown> = {}) {
  return window({
    windowKey: "weekly",
    providerBucket: "all_models",
    durationMinutes: 10080,
    displayLabel: "1W",
    usedValue: 60,
    usedUnit: "percent",
    remainingPercent: 40,
    resetAt: iso(NOW + 7 * 24 * 3600_000),
    expiresAt: iso(NOW + 7 * 24 * 3600_000),
    criticalRole: "weekly",
    ...over,
  });
}

function dataWith(over: Record<string, unknown> = {}) {
  return {
    generatedAt: iso(NOW),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [window({ remainingPercent: 80 }), weekly()],
      },
      {
        runtime: "cursor_local",
        unavailableReason: "unsupported",
        windows: [],
      },
    ],
    ...over,
  } as unknown as RuntimeCapacityResponse;
}

function render(state: Record<string, unknown>, nowMs = NOW) {
  return renderToStaticMarkup(
    React.createElement(TopBarCapacityView, { state, nowMs } as never)
  );
}

test("dual-window: runtime with 5H 80% and 1W 40% shows both labeled values, 5H first", () => {
  const html = render({ status: "ready", data: dataWith() });
  assert.match(html, /data-testid="topbar-capacity"/);
  assert.match(html, /data-status="ready"/);
  assert.match(html, /Capacity/);
  assert.match(html, /Claude/);
  // Both readings stay independent — the pair is not collapsed to the 40% minimum.
  assert.match(html, /5H/);
  assert.match(html, /80%/);
  assert.match(html, /1W/);
  assert.match(html, /40%/);
  // Deterministic 5H-above-1W row order in the visible markup (data-window
  // rows only — the tooltip title follows API order by design).
  assert.ok(
    html.indexOf('data-window="5H"') < html.indexOf('data-window="1W"'),
    "5H renders above 1W"
  );
  const summaries = summarizeCapacity(dataWith(), NOW);
  const claude = summaries.find((s) => s.runtime === "Claude");
  assert.ok(claude, "claude summary exists");
  assert.deepEqual(
    claude.windows.filter((w) => w.kind === "known").map((w) => w.label),
    ["5H", "1W"]
  );
  assert.equal(claude.windows[0].kind === "known" && claude.windows[0].remaining, 80);
  assert.equal(claude.windows[1].kind === "known" && claude.windows[1].remaining, 40);
  assert.equal(claude.exhausted, false);
  // Detail keeps both sides of each number so a reader can check it.
  assert.match(claude.detail, /5H: 80% available/);
  assert.match(claude.detail, /1W: 40% available/);
});

test("deterministic order: reversed API window order still renders 5H then 1W", () => {
  const reversed = dataWith({
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [weekly(), window({ remainingPercent: 80 })],
      },
    ],
  });
  const summaries = summarizeCapacity(reversed, NOW);
  assert.deepEqual(
    summaries[0].windows.map((w) => w.label),
    ["5H", "1W"]
  );
  const html = render({ status: "ready", data: reversed });
  assert.ok(
    html.indexOf('data-window="5H"') < html.indexOf('data-window="1W"'),
    "5H renders above 1W either way"
  );
  assert.match(html, /80%/);
  assert.match(html, /40%/);
});

test("exhausted: either 5H 0% or 1W 0% marks the block exhausted, both values stay visible", () => {
  for (const pair of [
    [window({ remainingPercent: 0 }), weekly()],
    [window({ remainingPercent: 80 }), weekly({ remainingPercent: 0 })],
  ]) {
    const data = dataWith({
      runtimes: [{ runtime: "claude_code", unavailableReason: null, windows: pair }],
    });
    const [summary] = summarizeCapacity(data, NOW);
    assert.equal(summary.exhausted, true, "either known window at 0% exhausts the runtime");
    const html = render({ status: "ready", data });
    assert.match(html, /data-exhausted="true"/);
    assert.match(html, /0%/);
    // The reason stays visible: both labeled values render, not just the zero.
    assert.match(html, /5H/);
    assert.match(html, /1W/);
    assert.match(html, /80%|40%/, "non-limiting window still shown");
    assert.match(html, /exhausted/, "tooltip/accessibility text names the exhausted state");
  }
});

test("partial unknown: one current value plus a stale/expired/missing/unparsable window shows value + labeled N/A", () => {
  const variants: Array<{ name: string; windows: unknown[]; hidden: string }> = [
    {
      name: "stale",
      windows: [
        window({ remainingPercent: 80 }),
        weekly({ remainingPercent: 40, unavailableReason: "stale", source: "unavailable" }),
      ],
      hidden: "40%",
    },
    {
      name: "expired",
      windows: [window({ remainingPercent: 80 }), weekly({ resetAt: iso(NOW - 1000) })],
      hidden: "40%",
    },
    {
      name: "missing",
      windows: [window({ remainingPercent: 80 })],
      hidden: "",
    },
    {
      name: "unparsable",
      windows: [
        window({ remainingPercent: 80 }),
        weekly({ remainingPercent: null, unavailableReason: "unparsable" }),
      ],
      hidden: "",
    },
  ];
  for (const v of variants) {
    const data = dataWith({
      runtimes: [{ runtime: "claude_code", unavailableReason: null, windows: v.windows }],
    });
    const [summary] = summarizeCapacity(data, NOW);
    assert.equal(summary.windows.length, 2, `${v.name}: pair keeps two rows`);
    assert.equal(summary.windows[0].kind, "known", `${v.name}: 5H stays known`);
    assert.equal(summary.windows[1].kind, "unknown", `${v.name}: 1W reads N/A`);
    const html = render({ status: "ready", data });
    // The known value never stands alone as a complete runtime status.
    assert.match(html, /5H/, `${v.name}: 5H label shown`);
    assert.match(html, /80%/, `${v.name}: current value shown`);
    assert.match(html, /1W/, `${v.name}: 1W label shown beside it`);
    assert.match(html, /N\/A/, `${v.name}: unknown half reads N/A`);
    if (v.hidden) {
      assert.ok(!html.includes(v.hidden), `${v.name}: stale number not presented as current`);
    }
    assert.equal(summary.exhausted, false, `${v.name}: partial unknown is not exhausted`);
  }
});

test("non-critical windows keep their own labels; providers without the pair stay truthful", () => {
  // A 6H provider window is not relabeled as 5H or 1W.
  const other = dataWith({
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [window({ windowKey: "six_hour", durationMinutes: 360, displayLabel: "6H", criticalRole: null })],
      },
    ],
  });
  const [codex] = summarizeCapacity(other, NOW);
  assert.deepEqual(codex.windows.map((w) => w.label), ["6H"]);
  const otherHtml = render({ status: "ready", data: other });
  assert.match(otherHtml, /6H/);
  assert.ok(!/data-window="5H"/.test(otherHtml), "no phantom 5H row synthesized");
  assert.ok(!/data-window="1W"/.test(otherHtml), "no phantom 1W row synthesized");
  // A provider with no windows at all renders a single truthful N/A.
  const empty = dataWith({
    runtimes: [{ runtime: "cursor_local", unavailableReason: "unsupported", windows: [] }],
  });
  const [cursor] = summarizeCapacity(empty, NOW);
  assert.deepEqual(cursor.windows, []);
  assert.equal(cursor.exhausted, false);
  const emptyHtml = render({ status: "ready", data: empty });
  assert.match(emptyHtml, /Cursor/);
  assert.match(emptyHtml, /N\/A/);
});

test("critical pair is exactly what the server tags: model-specific extras never fold into 5H/1W or exhaust the runtime", () => {
  // NOT-264 repair (P1, two review rounds): the client no longer re-derives
  // identity from window key, label, or duration — it trusts `criticalRole`
  // exactly as the adapter set it. Same duration/label as the real pair,
  // but untagged (criticalRole: null): never promoted, never exhausts.
  const claudeWindows = [
    window({ windowKey: "claude_unified_five_hour", providerBucket: "five_hour", remainingPercent: 80 }),
    weekly({ windowKey: "claude_unified_seven_day", providerBucket: "seven_day", remainingPercent: 40 }),
    weekly({
      windowKey: "claude_unified_seven_day_sonnet",
      providerBucket: "seven_day_sonnet",
      remainingPercent: 0,
      criticalRole: null,
    }),
    weekly({
      windowKey: "claude_unified_seven_day_opus",
      providerBucket: "seven_day_opus",
      remainingPercent: 12,
      criticalRole: null,
    }),
  ];
  const claudeData = dataWith({
    runtimes: [{ runtime: "claude_code", unavailableReason: null, windows: claudeWindows }],
  });
  const [claude] = summarizeCapacity(claudeData, NOW);
  assert.equal(claude.windows[0].label, "5H");
  assert.equal(claude.windows[0].kind === "known" && claude.windows[0].remaining, 80);
  assert.equal(claude.windows[1].label, "1W");
  assert.equal(
    claude.windows[1].kind === "known" && claude.windows[1].remaining,
    40,
    "the untagged 0% extra must not fold into the tagged critical 1W row"
  );
  assert.equal(claude.windows.length, 4, "extras render as distinct rows");
  assert.equal(
    claude.exhausted,
    false,
    "an untagged bucket at 0% is not account exhaustion while the tagged weekly window has capacity"
  );
  assert.deepEqual(
    new Set(claude.windows.map((w) => w.key)).size,
    claude.windows.length,
    "row keys are unique"
  );
  const claudeHtml = render({ status: "ready", data: claudeData });
  assert.ok(!/data-exhausted="true"/.test(claudeHtml), "no exhausted treatment from untagged extras");
  assert.match(claudeHtml, /0%/, "extra-bucket zero stays visible in its own row");
  assert.match(claudeHtml, /80%/);
  assert.match(claudeHtml, /40%/);

  // Two windows sharing everything (key prefix, label, duration) except the
  // tag — only the tagged one is critical, regardless of naming ("main" vs
  // "extra" has no special meaning to the client anymore).
  const codexWindows = [
    window({ windowKey: "codex_limit_extra_primary", providerBucket: "extra/primary", remainingPercent: 0, criticalRole: null }),
    window({ windowKey: "codex_limit_main_primary", providerBucket: "main/primary", remainingPercent: 70 }),
    weekly({ windowKey: "codex_limit_main_secondary", providerBucket: "main/secondary", remainingPercent: 55 }),
  ];
  const codexData = dataWith({
    runtimes: [{ runtime: "codex_local", unavailableReason: null, windows: codexWindows }],
  });
  const [codex] = summarizeCapacity(codexData, NOW);
  assert.equal(codex.windows[0].kind === "known" && codex.windows[0].remaining, 70, "the tagged pair wins, not the untagged one that happens to sort first");
  assert.equal(codex.windows[1].kind === "known" && codex.windows[1].remaining, 55);
  assert.equal(codex.exhausted, false, "the untagged extra's 0% does not exhaust the runtime");
  const codexHtml = render({ status: "ready", data: codexData });
  assert.ok(!/data-exhausted="true"/.test(codexHtml));
  assert.match(codexHtml, /70%/);
  assert.match(codexHtml, /55%/);
  assert.match(codexHtml, /0%/, "the untagged extra still renders in its own row");
});

test("no aggregate/detailed re-derivation left client-side: an untagged pair never becomes critical no matter how it's named", () => {
  const data = dataWith({
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [
          window({ windowKey: "codex_limit_main_primary", providerBucket: "main/primary", remainingPercent: 0, criticalRole: null }),
          weekly({ windowKey: "codex_limit_main_secondary", providerBucket: "main/secondary", remainingPercent: 55, criticalRole: null }),
        ],
      },
    ],
  });
  const [summary] = summarizeCapacity(data, NOW);
  assert.equal(summary.windows.length, 2, "both real buckets still render as their own truthful rows");
  assert.ok(summary.windows.every((w) => w.kind === "known"));
  assert.equal(summary.exhausted, false, "an untagged pair is never treated as critical, however it's named");
  const html = render({ status: "ready", data });
  assert.ok(!/data-exhausted="true"/.test(html));
  assert.match(html, /0%/);
  assert.match(html, /55%/);
});

test("Muse: whatever the server tags criticalRole on behaves exactly like any other runtime", () => {
  // The client no longer knows or cares that these came from Muse's
  // rolling_all_models/weekly_all_models keys — only the tag matters.
  const data = dataWith({
    runtimes: [
      {
        runtime: "muse_code",
        unavailableReason: null,
        windows: [
          window({ windowKey: "rolling_all_models", providerBucket: "all_models", remainingPercent: 0 }),
          weekly({ windowKey: "weekly_all_models", providerBucket: "all_models", remainingPercent: 60 }),
        ],
      },
    ],
  });
  const [summary] = summarizeCapacity(data, NOW);
  assert.equal(summary.windows[0].kind === "known" && summary.windows[0].remaining, 0);
  assert.equal(summary.windows[1].kind === "known" && summary.windows[1].remaining, 60);
  assert.equal(summary.exhausted, true, "Muse's 5H at 0% must exhaust the runtime like any other provider");
  const html = render({ status: "ready", data });
  assert.match(html, /data-exhausted="true"/);
});

test("per-row zero highlight is scoped to the critical pair, matching the block-level exhausted decision", () => {
  const data = dataWith({
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [
          window({ remainingPercent: 80 }),
          weekly({ remainingPercent: 40 }),
          window({
            windowKey: "codex_limit_extra_primary",
            providerBucket: "extra/primary",
            durationMinutes: 300,
            displayLabel: "5H",
            remainingPercent: 0,
            criticalRole: null,
          }),
        ],
      },
    ],
  });
  const [summary] = summarizeCapacity(data, NOW);
  const extraRow = summary.windows.find((w) => w.key === "codex_limit_extra_primary");
  assert.ok(extraRow && extraRow.kind === "known" && extraRow.isCritical === false);
  const html = render({ status: "ready", data });
  assert.ok(!/data-exhausted="true"/.test(html), "non-critical zero does not exhaust the block");
  assert.ok(!html.includes("text-red-300"), "non-critical zero is not highlighted red like a critical zero would be");
});

test("exhaustion is decided from the raw value, not the rounded display value", () => {
  const data = dataWith({
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [window({ remainingPercent: 0.4 }), weekly({ remainingPercent: 40 })],
      },
    ],
  });
  const [summary] = summarizeCapacity(data, NOW);
  assert.equal(
    summary.exhausted,
    false,
    "0.4% remaining rounds to a displayed 0% but must not exhaust the runtime"
  );
  const html = render({ status: "ready", data });
  assert.ok(!/data-exhausted="true"/.test(html));
  assert.match(html, /0%/, "the rounded display value is still 0%");
});

test("exhaustion comes from the critical pair only: extra-bucket zeros never mark the block", () => {
  const data = dataWith({
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [
          window({
            windowKey: "codex_limit_main_primary",
            providerBucket: "main/primary",
            durationMinutes: 300,
            displayLabel: "5H",
            remainingPercent: 70,
          }),
          weekly({
            windowKey: "codex_limit_main_secondary",
            providerBucket: "main/secondary",
            remainingPercent: 55,
          }),
          window({
            windowKey: "codex_limit_extra_secondary",
            providerBucket: "extra/secondary",
            durationMinutes: 10080,
            displayLabel: "1W",
            remainingPercent: 0,
            criticalRole: null,
          }),
        ],
      },
    ],
  });
  const [summary] = summarizeCapacity(data, NOW);
  assert.equal(summary.exhausted, false);
  const html = render({ status: "ready", data });
  assert.ok(!/data-exhausted="true"/.test(html));
  assert.match(html, /0%/, "extra zero still shown in its own row");
});

test("tooltip/accessibility text carries both labels, values, and reset detail", () => {
  const html = render({ status: "ready", data: dataWith() });
  assert.match(html, /5H: 80% available/);
  assert.match(html, /1W: 40% available/);
  assert.match(html, /resets/, "reset detail present where the provider reports it");
});

test("loading: distinguishable and presents no numeric value as current", () => {
  const html = render({ status: "loading" });
  assert.match(html, /data-status="loading"/);
  assert.match(html, /loading…/);
  assert.ok(!/%/.test(html), "loading state shows no percent");
  assert.ok(!/N\/A/.test(html), "loading is distinct from unknown N/A");
});

test("unavailable: distinguishable and presents no numeric value as current", () => {
  const html = render({ status: "unavailable" });
  assert.match(html, /data-status="unavailable"/);
  assert.match(html, /unavailable/);
  assert.ok(!/%/.test(html), "unavailable state shows no percent");
});

test("stale/unknown: N/A with a reason, never a stale number as current", () => {
  const stale = dataWith({
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [
          window({
            remainingPercent: 80,
            unavailableReason: "stale",
            source: "unavailable",
            freshUntil: iso(NOW - 60_000),
          }),
          weekly({
            remainingPercent: 40,
            unavailableReason: "stale",
            source: "unavailable",
            freshUntil: iso(NOW - 60_000),
          }),
        ],
      },
    ],
  });
  const summaries = summarizeCapacity(stale, NOW);
  assert.ok(
    summaries[0].windows.every((w) => w.kind === "unknown"),
    "all-stale pair reads unknown"
  );
  const html = render({ status: "ready", data: stale });
  assert.match(html, /data-status="unknown"/);
  assert.match(html, /N\/A/);
  assert.ok(!/80%/.test(html), "stale remaining is not presented as current");
  assert.ok(!/40%/.test(html), "stale remaining is not presented as current");
  // Past-reset windows read expired, not current, even with a number attached.
  const expired = dataWith({
    runtimes: [
      {
        runtime: "codex_local",
        unavailableReason: null,
        windows: [window({ remainingPercent: 50, resetAt: iso(NOW - 1000) })],
      },
    ],
  });
  assert.ok(
    summarizeCapacity(expired, NOW)[0].windows.every((w) => w.kind === "unknown"),
    "past-reset window reads unknown"
  );
});

test("empty runtimes: no accounts reads N/A, never a number", () => {
  const html = render({ status: "ready", data: dataWith({ runtimes: [] }) });
  assert.match(html, /N\/A/);
  assert.ok(!/%/.test(html), "empty state shows no percent");
});

test("shell header shows capacity inline — no secondary interaction needed", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/issues"] },
      React.createElement(ShellHeader, {
        openHumanActionCount: 0,
        agentCount: 1,
        agentIssueCount: 0,
        capacity: { status: "ready", data: dataWith() },
      })
    )
  );
  assert.ok(html.includes('data-testid="topbar-capacity"'), "capacity renders inside the header");
  assert.match(html, /80%/);
  assert.match(html, /40%/);
  assert.ok(html.includes('href="/agents"'), "Agents link retained beside capacity");
});

test("summary stays aligned and usable across widths: wraps, runtime blocks stay whole", () => {
  const html = render({ status: "ready", data: dataWith() });
  assert.match(html, /flex-wrap/, "summary wraps on narrow widths");
  assert.match(html, /whitespace-nowrap/, "per-runtime blocks never split from their value stack");
  assert.match(html, /flex-col/, "each runtime's 5H/1W rows stack together");
  assert.match(html, /max-w-full/, "summary never overflows the bar");
  const header = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/issues"] },
      React.createElement(ShellHeader, {
        openHumanActionCount: 0,
        agentCount: 0,
        agentIssueCount: 0,
        capacity: { status: "loading" },
      })
    )
  );
  assert.ok(header.includes("flex-wrap"), "header still wraps on narrow widths");
});
