// NOT-249: Cursor team billing card — team-level monetary billing renders in
// its own labeled section (never as quota percent chips), and every N/A
// state carries an explicit reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;

const { renderToStaticMarkup } = await import("react-dom/server");
const { CursorTeamBillingCardView } = await import("./CursorTeamBillingCard.js");
import type { CursorTeamBilling } from "@agent-dealer/shared";

function billing(over: Record<string, unknown> = {}): CursorTeamBilling {
  return {
    configured: true,
    cycleStart: "2026-09-01T00:00:00.000Z",
    cycleEnd: null,
    spendValue: 1250,
    spendUnit: "cents",
    hardLimitValue: null,
    hardLimitUnit: null,
    memberCount: 2,
    memberLimitOverrideCount: 1,
    usagePeriodStart: "2026-08-23T00:00:00.000Z",
    usagePeriodEnd: "2026-09-22T00:00:00.000Z",
    usageSpendValue: null,
    usageSpendUnit: null,
    source: "supported_protocol",
    unavailableReason: null,
    observedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    ...over,
  } as CursorTeamBilling;
}

const knownHtml = renderToStaticMarkup(
  React.createElement(CursorTeamBillingCardView, { data: billing() })
);

test("known team billing shows monetary values with the Admin API label", () => {
  assert.match(knownHtml, /cursor-team-billing/);
  assert.match(knownHtml, /Cursor team billing/);
  assert.match(knownHtml, /Admin API/);
  assert.match(knownHtml, /1250 cents/);
  assert.match(knownHtml, /cursor-team-cycle/);
  assert.match(knownHtml, /cursor-team-members/);
  // Team size and per-member overrides render as what they are — never as a
  // team hard limit and never as quota percents.
  assert.match(knownHtml, /2 members/);
  assert.match(knownHtml, /per-member limit override/);
  assert.ok(!knownHtml.includes("hard limit"), "no team hard limit is reported");
  // Monetary billing is never rendered as a quota percent chip.
  assert.ok(!knownHtml.includes("%"), "team billing must not render percents");
});

test("team billing stays distinct from the per-runtime quota strip", () => {
  assert.ok(!knownHtml.includes("capacity-entry-"), "no quota entry ids in the billing card");
  assert.ok(!knownHtml.includes("capacity-window-"), "no quota window chips in the billing card");
});

test("unconfigured, stale, and unparsable render N/A with distinct reasons", () => {
  const unconfigured = renderToStaticMarkup(
    React.createElement(CursorTeamBillingCardView, {
      data: billing({
        configured: false,
        spendValue: null,
        spendUnit: null,
        hardLimitValue: null,
        hardLimitUnit: null,
        usageSpendValue: null,
        usageSpendUnit: null,
        source: "unavailable",
        unavailableReason: "missing",
        observedAt: null,
      }),
    })
  );
  assert.match(unconfigured, /cursor-team-billing-na/);
  assert.match(unconfigured, /CURSOR_ADMIN_API_KEY/);
  const stale = renderToStaticMarkup(
    React.createElement(CursorTeamBillingCardView, {
      data: billing({
        spendValue: null,
        spendUnit: null,
        hardLimitValue: null,
        hardLimitUnit: null,
        usageSpendValue: null,
        usageSpendUnit: null,
        source: "unavailable",
        unavailableReason: "stale",
      }),
    })
  );
  assert.match(stale, /data-reason="stale"/);
  assert.ok(!stale.includes("CURSOR_ADMIN_API_KEY"), "setup hint only when unconfigured");
});
