// NOT-250: Cursor individual billing card — billing-cycle values render in
// their own labeled section with an always-visible Experimental badge, and
// every N/A state carries an explicit reason plus the local setting that
// disables the adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
(globalThis as { React?: unknown }).React ??= React;

const { renderToStaticMarkup } = await import("react-dom/server");
const { CursorIndividualBillingCardView } = await import("./CursorIndividualBillingCard.js");
import type { CursorIndividualBilling } from "@agent-dealer/shared";

function billing(over: Record<string, unknown> = {}): CursorIndividualBilling {
  return {
    enabled: true,
    configured: true,
    cycleLabel: "September 2026",
    cycleStart: "2026-09-01T00:00:00.000Z",
    cycleEnd: "2026-10-01T00:00:00.000Z",
    usageValue: 7.5,
    usageUnit: "USD",
    remainingPercent: 62,
    source: "experimental_api",
    unavailableReason: null,
    observedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    ...over,
  } as CursorIndividualBilling;
}

const knownHtml = renderToStaticMarkup(
  React.createElement(CursorIndividualBillingCardView, { data: billing() })
);

test("known individual billing shows cycle, remaining, and the Experimental badge", () => {
  assert.match(knownHtml, /cursor-individual-billing/);
  assert.match(knownHtml, /Cursor individual billing/);
  assert.match(knownHtml, /cursor-individual-experimental/);
  assert.match(knownHtml, /Experimental/);
  assert.match(knownHtml, /September 2026/);
  assert.match(knownHtml, /62% remaining/);
  assert.match(knownHtml, /cursor-individual-cycle/);
  // Billing-cycle values are never rendered as 5H/1W quota windows.
  assert.ok(!knownHtml.includes("capacity-entry-"), "no quota entry ids in the billing card");
  assert.ok(!knownHtml.includes("capacity-window-"), "no quota window chips in the billing card");
});

test("the card always names the local setting that disables it", () => {
  assert.match(knownHtml, /AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY/);
  assert.match(knownHtml, /disable: unset/);
});

test("disabled, unconfigured, and stale render N/A with distinct reasons", () => {
  const disabled = renderToStaticMarkup(
    React.createElement(CursorIndividualBillingCardView, {
      data: billing({
        enabled: false,
        configured: false,
        cycleLabel: null,
        cycleStart: null,
        cycleEnd: null,
        usageValue: null,
        usageUnit: null,
        remainingPercent: null,
        source: "unavailable",
        unavailableReason: "missing",
        observedAt: null,
      }),
    })
  );
  assert.match(disabled, /cursor-individual-billing-na/);
  assert.match(disabled, /experimental opt-in off/);
  assert.match(disabled, /AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY/);
  assert.match(disabled, /cursor-individual-experimental/);
  const unconfigured = renderToStaticMarkup(
    React.createElement(CursorIndividualBillingCardView, {
      data: billing({
        configured: false,
        cycleLabel: null,
        cycleStart: null,
        cycleEnd: null,
        usageValue: null,
        usageUnit: null,
        remainingPercent: null,
        source: "unavailable",
        unavailableReason: "missing",
        observedAt: null,
      }),
    })
  );
  assert.match(unconfigured, /no usable local Cursor login/);
  const stale = renderToStaticMarkup(
    React.createElement(CursorIndividualBillingCardView, {
      data: billing({
        cycleLabel: null,
        cycleStart: null,
        cycleEnd: null,
        usageValue: null,
        usageUnit: null,
        remainingPercent: null,
        source: "unavailable",
        unavailableReason: "stale",
      }),
    })
  );
  assert.match(stale, /data-reason="stale"/);
});
