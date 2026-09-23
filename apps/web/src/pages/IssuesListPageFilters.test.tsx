// NOT-261: issue filters sit behind a compact show/hide control and are
// collapsed on initial load, with the issue list left as the primary content.
// The filter form keeps its exact Apply/Reset/URL behavior; an active filter
// shows a compact "Filtered" indication on the collapsed control. The page
// fetches in effects (which never run under renderToStaticMarkup), so these
// tests pin the initial markup under MemoryRouter plus the source wiring for
// expand/collapse, following the App.shell.test.tsx pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time.
(globalThis as { React?: unknown }).React ??= React;

register("../test-helpers/asset-stub-hooks.mjs", import.meta.url);

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router-dom");
const { default: IssuesListPage } = await import("./IssuesListPage.js");

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "IssuesListPage.tsx"), "utf8");

function renderAt(entry: string): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      React.createElement(IssuesListPage, {
        agents: [],
        humanActions: [],
        onHumanActionsChanged: () => {},
      })
    )
  );
}

test("filters are collapsed on initial load; the issue list stays primary", () => {
  const html = renderAt("/issues");
  assert.ok(html.includes("Show filters"), "collapsed toggle offers to show filters");
  assert.ok(html.includes('aria-expanded="false"'), "toggle reports the collapsed state");
  assert.ok(
    !html.includes('aria-label="Issues filters"'),
    "filter form is not rendered until expanded"
  );
  assert.ok(
    !html.includes("Title or label (e.g. NOT-175)"),
    "no filter inputs compete with the list on load"
  );
  assert.ok(html.includes("Loading…"), "list region still renders as the primary content");
});

test("a URL-persisted filter stays collapsed but shows a filtered indication", () => {
  const html = renderAt("/issues?q=NOT-175");
  assert.ok(html.includes('aria-expanded="false"'), "shared filtered URL still loads collapsed");
  assert.ok(
    !html.includes('aria-label="Issues filters"'),
    "filter form stays hidden even with an active filter"
  );
  assert.ok(
    html.includes('data-testid="filters-active-indicator"'),
    "collapsed control carries the active-filter indicator"
  );
  assert.ok(html.includes("Filtered"), "indicator reads as filtered, not as a count");
});

test("no indication when no filter is active", () => {
  const html = renderAt("/issues");
  assert.ok(
    !html.includes('data-testid="filters-active-indicator"'),
    "unfiltered list shows no filtered badge"
  );
});

test("toggle expands to the full filter form and collapses it again", () => {
  assert.ok(
    pageSource.includes("const [filtersOpen, setFiltersOpen] = useState(false)"),
    "filters start collapsed"
  );
  assert.ok(
    pageSource.includes('aria-controls="issues-filter-form"'),
    "toggle targets the filter form"
  );
  assert.ok(
    pageSource.includes("onClick={() => setFiltersOpen((v) => !v)}"),
    "toggle flips open/closed"
  );
  assert.ok(
    pageSource.includes("{filtersOpen ? \"Hide filters\" : \"Show filters\"}"),
    "toggle label tracks the open state"
  );
  assert.ok(
    pageSource.includes("{filtersOpen && ("),
    "filter form renders only when expanded"
  );
});

test("expand/apply/clear flow keeps every existing filter and its URL behavior", () => {
  for (const token of [
    'aria-label="Issues filters"',
    "value={filters.q}",
    "value={filters.status}",
    "value={filters.repo}",
    "checked={filters.needsAttention}",
    "ISSUE_STATUS_OPTIONS",
    ">Apply</button>",
    "Reset",
    "Reset filters",
    "onClick={resetFilters}",
    "serializeIssuesQuery(formToIssuesFilters(next))",
    "setSearchParams({})",
    "setIssuesPageQuery",
  ]) {
    assert.ok(pageSource.includes(token), `filter behavior kept: ${token}`);
  }
  assert.ok(
    pageSource.includes("const filtersActive = hasActiveIssuesFilters(applied)"),
    "indicator derives from the applied URL filters, so refresh/shared URLs agree"
  );
});
