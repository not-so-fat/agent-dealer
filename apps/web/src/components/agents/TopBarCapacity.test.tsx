// NOT-262: top-bar agent-capacity summary — populated, loading, and
// unavailable states, plus the stale/unknown contract (no numeric value
// presented as current) and the narrow-viewport wrapping contract.
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
    ...over,
  };
}

function dataWith(over: Record<string, unknown> = {}) {
  return {
    generatedAt: iso(NOW),
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [window()],
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

test("populated: shows current remaining percent per runtime without another panel", () => {
  const html = renderToStaticMarkup(
    React.createElement(TopBarCapacityView, {
      state: { status: "ready", data: dataWith() },
      nowMs: NOW,
    })
  );
  assert.match(html, /data-testid="topbar-capacity"/);
  assert.match(html, /data-status="ready"/);
  assert.match(html, /Capacity/);
  assert.match(html, /Claude/);
  assert.match(html, /65%/);
  assert.match(html, /Cursor/);
  assert.match(html, /N\/A/);
});

test("populated: reflects available versus occupied from the shared source", () => {
  const summaries = summarizeCapacity(dataWith(), NOW);
  const claude = summaries.find((s) => s.runtime === "Claude");
  assert.ok(claude && claude.kind === "known", "claude entry is known");
  assert.equal(claude.kind === "known" && claude.remaining, 65);
  // Detail keeps both sides of the number so a reader can check it.
  assert.match(claude.detail, /65% available/);
  assert.match(claude.detail, /35% used/);
  // Most-constrained known window wins when a runtime reports several.
  const multi = dataWith({
    runtimes: [
      {
        runtime: "claude_code",
        unavailableReason: null,
        windows: [
          window({ windowKey: "five_hour", displayLabel: "5H", remainingPercent: 80 }),
          window({ windowKey: "weekly", displayLabel: "1W", remainingPercent: 40 }),
        ],
      },
    ],
  });
  const min = summarizeCapacity(multi, NOW);
  assert.equal(min[0].kind === "known" && min[0].remaining, 40);
});

test("loading: distinguishable and presents no numeric value as current", () => {
  const html = renderToStaticMarkup(
    React.createElement(TopBarCapacityView, { state: { status: "loading" } })
  );
  assert.match(html, /data-status="loading"/);
  assert.match(html, /loading…/);
  assert.ok(!/%/.test(html), "loading state shows no percent");
  assert.ok(!/N\/A/.test(html), "loading is distinct from unknown N/A");
});

test("unavailable: distinguishable and presents no numeric value as current", () => {
  const html = renderToStaticMarkup(
    React.createElement(TopBarCapacityView, { state: { status: "unavailable" } })
  );
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
            remainingPercent: 65,
            unavailableReason: "stale",
            source: "unavailable",
            freshUntil: iso(NOW - 60_000),
          }),
        ],
      },
    ],
  });
  const summaries = summarizeCapacity(stale, NOW);
  assert.equal(summaries[0].kind, "unknown");
  const html = renderToStaticMarkup(
    React.createElement(TopBarCapacityView, { state: { status: "ready", data: stale }, nowMs: NOW })
  );
  assert.match(html, /data-status="unknown"/);
  assert.match(html, /N\/A/);
  assert.ok(!/65%/.test(html), "stale remaining is not presented as current");
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
  assert.equal(summarizeCapacity(expired, NOW)[0].kind, "unknown");
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
  assert.match(html, /65%/);
  assert.ok(html.includes('href="/agents"'), "Agents link retained beside capacity");
});

test("summary stays aligned and usable across widths: wraps, chips stay whole", () => {
  const html = renderToStaticMarkup(
    React.createElement(TopBarCapacityView, {
      state: { status: "ready", data: dataWith() },
      nowMs: NOW,
    })
  );
  assert.match(html, /flex-wrap/, "summary wraps on narrow widths");
  assert.match(html, /whitespace-nowrap/, "per-runtime chips never split");
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
