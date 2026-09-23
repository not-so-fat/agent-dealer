// NOT-258: the Issues screen keeps the page-level <h2>Issues</h2> beside the
// New-issue button; the redundant list <h3>Issues</h3> above the paginated
// list is removed while the range/page counts stay right-aligned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(dir, "IssuesListPage.tsx"), "utf8");
const appSource = readFileSync(join(dir, "..", "App.tsx"), "utf8");

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

test("routing, counts, list controls, and list behavior are unchanged", () => {
  assert.ok(appSource.includes('path="/issues"'), "Issues route unchanged");
  for (const token of [
    "fetchIssuesPage",
    "issuesRangeText",
    "issuesPageText",
    'aria-label="Issues filters"',
    'aria-label="Issues pages"',
    "Admission queue",
    "NeedsAttentionPanel",
  ]) {
    assert.ok(pageSource.includes(token), `list control kept: ${token}`);
  }
  // The range/page count stays above the issue rows, right-aligned.
  assert.ok(pageSource.includes("issuesRangeText(issuePage)"), "range text retained");
  assert.ok(pageSource.includes("issuesPageText(issuePage)"), "page text retained");
  assert.ok(/flex justify-end/.test(pageSource), "count row right-aligns without an empty label slot");
});
