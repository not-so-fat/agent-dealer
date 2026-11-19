// NOT-258: the Issues screen keeps the page-level <h2>Issues</h2> beside the
// New-issue button; the redundant list <h3>Issues</h3> above the paginated
// list is removed while the range/page counts stay right-aligned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import type { AdmissionStatus } from "@agent-dealer/shared";
import AdmissionQueueHeader from "../components/issues/AdmissionQueueHeader.js";
import { ISSUES_POLL_INTERVAL_MS, startPolling } from "../lib/polling.js";
import { fetchQueueStatus } from "../api.js";

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "IssuesListPage.tsx"), "utf8");
const headerSource = readFileSync(
  join(dir, "..", "components", "issues", "AdmissionQueueHeader.tsx"),
  "utf8"
);
const appSource = readFileSync(join(dir, "..", "App.tsx"), "utf8");
const apiSource = readFileSync(join(dir, "..", "api.ts"), "utf8");

// NOT-643 behavioral helpers: feed the extracted Admission header controlled
// admission payloads and read the rendered selector back out.
function admissionStatus(overrides: Partial<AdmissionStatus> = {}): AdmissionStatus {
  return {
    active: 0,
    waiting: 0,
    limit: 1,
    maxActiveIssues: 1,
    ceiling: 5,
    options: [1, 2, 3, 4, 5],
    overCap: false,
    ...overrides,
  };
}

function renderHeader(admission: AdmissionStatus | null, queueLength: number): string {
  return renderToStaticMarkup(
    React.createElement(AdmissionQueueHeader, {
      admission,
      queueLength,
      limitBusy: false,
      onLimitChange: () => {},
    })
  );
}

/** Every rendered option value, in order. */
function optionValues(html: string): string[] {
  return [...html.matchAll(/<option[^>]*value="(\d+)"[^>]*>/g)].map((m) => m[1]);
}

/** The rendered selected option, or null when no selector rendered. */
function selectedOption(html: string): string | null {
  const m = html.match(/<option[^>]*\bselected\b[^>]*>([^<]*)</);
  return m ? m[1] : null;
}

test("primary Issues label remains in the navigation/header", () => {
  assert.ok(appSource.includes('to="/issues"'), "nav still routes to /issues");
  assert.ok(/>\s*Issues(\s|<)/.test(appSource), "nav still labels the destination Issues");
});

test("page-level h2 Issues is rendered beside New issue", () => {
  assert.ok(
    /<h2 className="font-ui-display text-lg font-semibold text-white\/90">Issues<\/h2>/.test(pageSource),
    "page-level <h2>Issues</h2> exists",
  );
  const bar = pageSource.match(/<div className="([^"]*)">\s*<h2[\s\S]*?<\/h2>\s*<button[\s\S]*?>\s*New issue/s);
  assert.ok(bar, "h2 and New issue button sit together in the top action row");
});

test("redundant list h3 Issues above the paginated list is not rendered", () => {
  assert.ok(!/<h3[^>]*>\s*Issues\s*<\/h3>/.test(pageSource), "no list <h3>Issues</h3>");
});

test("action row uses justify-between with no empty label slot", () => {
  assert.ok(pageSource.includes("New issue"), "New issue button retained");
  const bar = pageSource.match(/<div className="([^"]*)">\s*<h2[\s\S]*?<\/h2>\s*<button[\s\S]*?>\s*New issue/s);
  assert.ok(bar, "New issue button sits in the top action row");
  assert.ok(bar[1].includes("justify-between"), `action row spreads title and button (got: ${bar[1]})`);
  assert.ok(bar[1].includes("mb-4"), "row keeps its bottom spacing so the list starts in place");
});

// NOT-260: the repository-mapping editor lives inside New issue — a small
// accessible gear beside the Repository control, no Configuration page.
test("gear beside Repository opens the inline mapping editor", () => {
  assert.ok(
    pageSource.includes('aria-label="Configure repository mappings"'),
    "gear has an accessible label"
  );
  assert.ok(
    pageSource.includes('title="Configure repository mappings"'),
    "gear has a title"
  );
  assert.ok(pageSource.includes("RepositoryMappingsEditor"), "inline editor rendered");
  assert.ok(pageSource.includes("mappingsOpen"), "gear toggles the editor");
  // Compact 16–20px visual size; inline SVG, no new icon dependency.
  assert.ok(/<svg width="18" height="18"/.test(pageSource), "compact inline gear icon");
});

test("New issue uses the shared RepositoryPicker for the Repository field", () => {
  assert.ok(
    pageSource.includes("RepositoryPicker"),
    "repository entry goes through the shared picker"
  );
  assert.ok(
    pageSource.includes("<RepositoryPicker value={repo} onChange={setRepo}"),
    "picker is bound to the New issue repository value"
  );
  assert.ok(
    pageSource.includes("RepositoryMappingsEditor"),
    "mapping rows reuse the same picker component"
  );
});

test("toggling or saving the editor never clears the in-progress form", () => {
  // The gear toggle flips only its own boolean — no form setter runs.
  const toggle = pageSource.match(/onClick=\{\(\) => setMappingsOpen\(\(v\) => !v\)\}/);
  assert.ok(toggle, "toggle touches only editor visibility");
  const editorSource = readFileSync(
    join(dir, "..", "components", "issues", "RepositoryMappingsEditor.tsx"),
    "utf8"
  );
  assert.ok(!editorSource.includes("setRepo"), "editor cannot write the parent repository");
  assert.ok(!editorSource.includes("setTitle"), "editor cannot write the parent title");
});

// NOT-361: Linear intake filters gear beside the open-inbox picker (see
// IssuesListPageLinearFilters.test.tsx for the fuller regression suite).
test("gear beside open-inbox picker opens the inline Linear filters editor", () => {
  assert.ok(
    pageSource.includes('aria-label="Configure Linear intake filters"'),
    "Linear filters gear labeled"
  );
  assert.ok(pageSource.includes("LinearIntakeFiltersEditor"), "inline Linear filters editor");
  assert.ok(!pageSource.includes("ConfigurationPage"), "still no Configuration page");
});

test("no Configuration page, route, or top-level navigation item is introduced", () => {
  assert.ok(!pageSource.includes("ConfigurationPage"), "no configuration page import");
  assert.ok(!/path="\/configuration"/.test(appSource), "no /configuration route");
  assert.ok(!/to="\/configuration"/.test(appSource), "no navigation link to configuration");
  assert.ok(!/>Configuration(\s|<)/.test(appSource), "no Configuration nav label");
  assert.ok(
    !/NavLink[^>]*>[^<]*Configuration/.test(appSource),
    "no configuration nav entry"
  );
});

test("routing, counts, list controls, and list behavior are unchanged", () => {
  assert.ok(appSource.includes('path="/issues"'), "Issues route unchanged");
  for (const token of [
    "fetchIssuesPage",
    "issuesRangeText",
    "issuesPageText",
    'aria-label="Issues filters"',
    'aria-label="Issues pages"',
    "NeedsAttentionPanel",
  ]) {
    assert.ok(pageSource.includes(token), `list control kept: ${token}`);
  }
  // NOT-643: the Admission queue bar lives in the shared header unit now.
  assert.ok(pageSource.includes("<AdmissionQueueHeader"), "page renders the shared admission header");
  assert.ok(headerSource.includes("Admission queue"), "shared header keeps the Admission queue label");
  // The range/page count stays above the issue rows, right-aligned.
  assert.ok(pageSource.includes("issuesRangeText(issuePage)"), "range text retained");
  assert.ok(pageSource.includes("issuesPageText(issuePage)"), "page text retained");
  // NOT-385: the header row now carries the sort + order controls on the
  // left; the counts stay right-aligned via justify-between, and the row
  // wraps on narrow viewports instead of overflowing.
  const headerRow = pageSource.match(
    /<div className="([^"]*)">\s*<IssuesSortControls[\s\S]*?issuesRangeText\(issuePage\)/
  );
  assert.ok(headerRow, "sort controls sit in the header row above the issue rows");
  assert.ok(headerRow[1].includes("justify-between"), `counts stay right-aligned (got: ${headerRow[1]})`);
  assert.ok(headerRow[1].includes("flex-wrap"), `narrow viewports wrap (got: ${headerRow[1]})`);
});

// NOT-371: independent same-repository issues execute concurrently up to the global
// limit — the capacity control must not promise "max one per repository".
test("capacity control no longer promises max one per repository", () => {
  assert.ok(
    !pageSource.includes("max one per repository") &&
      !headerSource.includes("max one per repository"),
    "no max-one-per-repository copy remains"
  );
  assert.ok(
    headerSource.includes("How many issues may execute in parallel"),
    "capacity tooltip still explains the limit"
  );
});

// NOT-378: the Admission queue dropdown stays compact and in place, renders its
// options from AdmissionStatus.options (1–5 from the server), and saves through
// PUT /api/queue/settings — no new settings page, no per-repository control.
test("admission limit dropdown renders server options and saves through the settings route", () => {
  assert.ok(
    headerSource.includes("admission.options.map((o) => ("),
    "dropdown options render from AdmissionStatus.options"
  );
  assert.ok(
    headerSource.includes("admission.options.includes(admission.maxActiveIssues)"),
    "dropdown value binds to the persisted setting"
  );
  assert.ok(
    headerSource.includes("onChange={(e) => onLimitChange(Number(e.target.value))}"),
    "changing the dropdown calls the limit saver"
  );
  assert.ok(
    pageSource.includes("onLimitChange={(value) => void changeLimit(value)}"),
    "the page wires the header selector to the limit saver"
  );
  assert.ok(
    pageSource.includes("await updateAdmissionSettings(value)"),
    "the saver persists through updateAdmissionSettings"
  );
  assert.ok(
    apiSource.includes("/api/queue/settings") && apiSource.includes('method: "PUT"'),
    "updateAdmissionSettings saves through PUT /api/queue/settings"
  );
});

// NOT-385: the sort select plus its one adjacent order control — both read the
// applied URL, write back through the view-model (filters survive, page
// resets), and list fetching follows the same applied filters.
test("sort controls read the URL and toggle through the direction view-model", () => {
  for (const token of [
    "IssuesSortControls",
    "issuesSortFromSearch(search)",
    "issuesDirectionFromSearch(search)",
    "onSortChange={changeSort}",
    "onToggleDirection={toggleDirection}",
    "toggleIssuesDirectionQuery(search)",
    "setIssuesSortQuery(search, sort)",
    "refreshIssues(appliedRef.current)",
  ]) {
    assert.ok(pageSource.includes(token), `sort wiring kept: ${token}`);
  }
});

// NOT-643: the fresh Issues page lost its admission status load when NOT-228
// replaced refresh() with inline fetches (mount and 5s poll fetch issues and
// queue rows but never fetchQueueStatus), and NOT-287 gated the Admission
// queue panel on queue.length > 0 — so an empty queue renders no header and
// no limit control at all. The page now renders the shared AdmissionQueueHeader
// unconditionally and refreshes one live loader through startPolling; the two
// wiring tests below pin those seams, and the behavioral tests after them
// execute the units — effects never run under renderToStaticMarkup, so a
// full-page mount cannot observe the selector here and the header renders in
// its place with controlled admission payloads.
test("NOT-643 page renders the shared admission header with live queue and admission props", () => {
  assert.ok(
    !pageSource.includes('data-testid="admission-idle-status"'),
    "no separate idle-line branch — the header serves both queue states"
  );
  assert.ok(
    !pageSource.includes("{queue.length > 0 ? ("),
    "the Admission queue header is not gated on waiting entries"
  );
  assert.ok(pageSource.includes("<AdmissionQueueHeader"), "page renders the shared header");
  for (const token of [
    "admission={admission}",
    "queueLength={queue.length}",
    "limitBusy={limitBusy}",
    "onLimitChange={(value) => void changeLimit(value)}",
  ]) {
    assert.ok(pageSource.includes(token), `header wiring kept: ${token}`);
  }
  assert.ok(
    pageSource.includes("{queue.length > 0 && ("),
    "only the queue rows stay conditional on waiting entries"
  );
});

test("NOT-643 mount and 5s poll run one live loader that requests admission status", () => {
  assert.ok(
    pageSource.includes("startPolling(loadLive, ISSUES_POLL_INTERVAL_MS)"),
    "the poll schedules the shared live loader on the 5s cadence"
  );
  const loader = pageSource.match(/const loadLive = \(\) => \{([\s\S]*?)\n    \};/);
  assert.ok(loader, "one live loader owns mount + poll refresh");
  assert.ok(loader[1].includes("refreshIssues(appliedRef.current)"), "loader refreshes the issue list");
  assert.ok(loader[1].includes("fetchQueue()"), "loader refreshes queue rows");
  assert.ok(loader[1].includes("fetchQueueStatus()"), "loader requests admission status");
  assert.ok(
    loader[1].includes(".then(setAdmission)"),
    "loaded status updates the displayed admission state"
  );
});

test("NOT-643 empty queue renders the labeled selector at the server value with server options", () => {
  const html = renderHeader(
    admissionStatus({ active: 0, waiting: 0, limit: 1, maxActiveIssues: 1 }),
    0
  );
  assert.ok(html.includes("Admission queue"), "header renders with zero waiting entries");
  assert.ok(
    html.includes('aria-label="Active issue limit"'),
    "the limit selector is accessibly labeled"
  );
  assert.deepEqual(
    optionValues(html),
    ["1", "2", "3", "4", "5"],
    "options come from the server payload"
  );
  assert.equal(selectedOption(html), "1", "selector shows the current valid value");
  assert.ok(
    /0 active\s*·\s*0 waiting\s*·\s*limit\s*1/.test(html),
    "status counts render for the empty queue"
  );
  assert.equal(html.match(/<select/g)?.length ?? 0, 1, "exactly one limit selector");
});

test("NOT-643 populated queue renders the same selector with the same server options", () => {
  const html = renderHeader(
    admissionStatus({ active: 1, waiting: 2, limit: 2, maxActiveIssues: 2 }),
    2
  );
  assert.ok(html.includes("Admission queue"), "same header renders with waiting entries");
  assert.ok(
    html.includes('aria-label="Active issue limit"'),
    "the same labeled selector renders for the populated queue"
  );
  assert.deepEqual(
    optionValues(html),
    ["1", "2", "3", "4", "5"],
    "options come from the server payload"
  );
  assert.equal(selectedOption(html), "2", "selector shows the current valid value");
  assert.ok(
    /1 active\s*·\s*2 waiting\s*·\s*limit\s*2/.test(html),
    "status counts render for the populated queue"
  );
  assert.equal(html.match(/<select/g)?.length ?? 0, 1, "exactly one limit selector");
});

test("NOT-643 narrowed server options render verbatim instead of a hardcoded 1–5", () => {
  const html = renderHeader(
    admissionStatus({ limit: 2, maxActiveIssues: 2, ceiling: 2, options: [1, 2] }),
    0
  );
  assert.deepEqual(optionValues(html), ["1", "2"], "a capped ceiling narrows the offered options");
  assert.equal(selectedOption(html), "2", "selector still shows the current valid value");
});

test("NOT-643 empty queue without admission yet shows the loading fallback and no selector", () => {
  const html = renderHeader(null, 0);
  assert.ok(html.includes("Admission queue"), "header shell renders before admission loads");
  assert.ok(
    html.includes("Loading admission status…"),
    "empty queue shows a loading fallback until admission arrives"
  );
  assert.ok(!html.includes("<select"), "no selector before admission loads");
});

test("NOT-643 populated queue without admission yet shows the sequential fallback and no selector", () => {
  const html = renderHeader(null, 3);
  assert.ok(
    /3 waiting\s*·\s*sequential/.test(html),
    "waiting entries fall back to the sequential line until admission arrives"
  );
  assert.ok(!html.includes("<select"), "no selector before admission loads");
});

test("NOT-643 refreshed admission changes the displayed value and status", () => {
  const before = renderHeader(admissionStatus({ limit: 1, maxActiveIssues: 1 }), 0);
  const after = renderHeader(
    admissionStatus({ active: 1, waiting: 1, limit: 2, maxActiveIssues: 2 }),
    0
  );
  assert.equal(selectedOption(before), "1", "mount value displays first");
  assert.equal(selectedOption(after), "2", "refreshed value displays after");
  assert.ok(
    /1 active\s*·\s*1 waiting\s*·\s*limit\s*2/.test(after),
    "refreshed status counts display after"
  );
});

test("NOT-643 a 5s poll tick re-requests admission status and the header shows the new value", async () => {
  assert.equal(ISSUES_POLL_INTERVAL_MS, 5000, "the live cadence stays five seconds");
  // Controlled /api/queue/status responses: the mount sees limit 1, the tick
  // sees limit 2 — the header must display each in turn, for both queue states.
  const payloads = [
    admissionStatus({ active: 0, waiting: 0, limit: 1, maxActiveIssues: 1 }),
    admissionStatus({ active: 1, waiting: 1, limit: 2, maxActiveIssues: 2 }),
  ];
  const requested: string[] = [];
  const cleared: unknown[] = [];
  const ticks: Array<() => void> = [];
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  try {
    globalThis.fetch = (async (input: string) => {
      requested.push(String(input));
      const next = payloads.shift() ?? admissionStatus({});
      return { ok: true, json: async () => next } as Response;
    }) as unknown as typeof fetch;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      assert.equal(ms, ISSUES_POLL_INTERVAL_MS, "the poll schedules on the 5s cadence");
      ticks.push(fn);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((timer: unknown) => {
      cleared.push(timer);
    }) as unknown as typeof clearInterval;
    // The loader shape the page hands to startPolling: fetch, then publish.
    const seen: AdmissionStatus[] = [];
    const load = () => {
      fetchQueueStatus()
        .then((s) => {
          seen.push(s);
        })
        .catch(() => undefined);
    };
    load(); // fresh mount
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(requested.length, 1, "fresh mount requests admission status");
    assert.ok(requested[0].endsWith("/api/queue/status"), "mount requests the status route");
    assert.equal(seen.length, 1, "mount delivers the admission payload");
    assert.equal(
      selectedOption(renderHeader(seen[0], 0)),
      "1",
      "empty queue shows the mounted value"
    );
    const stop = startPolling(load, ISSUES_POLL_INTERVAL_MS);
    assert.equal(ticks.length, 1, "the poll scheduled its tick");
    ticks[0](); // advance the 5s cadence
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(requested.length, 2, "the poll tick re-requests admission status");
    assert.equal(seen.length, 2, "the tick delivers the refreshed payload");
    for (const queueLength of [0, 2]) {
      const html = renderHeader(seen[1], queueLength);
      assert.ok(
        html.includes('aria-label="Active issue limit"'),
        `labeled selector renders with queueLength=${queueLength}`
      );
      assert.equal(
        selectedOption(html),
        "2",
        `refreshed value displays with queueLength=${queueLength}`
      );
    }
    stop();
    assert.equal(cleared.length, 1, "unmount clears the poll");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("cap tooltip compares the ceiling against the shared hard maximum", async () => {
  const { MAX_ACTIVE_ISSUES_HARD_MAX } = await import("@agent-dealer/shared");
  assert.equal(MAX_ACTIVE_ISSUES_HARD_MAX, 5, "shared hard maximum is 5");
  assert.ok(
    headerSource.includes("admission.ceiling < MAX_ACTIVE_ISSUES_HARD_MAX"),
    "capped tooltip shows whenever the ceiling is below the hard maximum"
  );
  assert.ok(
    !pageSource.includes("admission.ceiling < 2") &&
      !headerSource.includes("admission.ceiling < 2"),
    "no stale ceiling-of-2 comparison remains"
  );
  assert.ok(
    !pageSource.includes("ConfigurationPage"),
    "still no separate settings page for the limit"
  );
});
