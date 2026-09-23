// NOT-258: the Issues screen showed "Issues" twice (nav + content <h2>).
// The nav label stays; the redundant content page heading goes; the action
// row keeps the New-issue button right-aligned with no leftover gap; list
// controls, counts, and routing stay unchanged.
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

test("redundant content page heading is not rendered", () => {
  assert.ok(!/<h2[^>]*>\s*Issues\s*<\/h2>/.test(pageSource), "no content <h2>Issues</h2>");
  assert.ok(!/<h1[^>]*>\s*Issues\s*<\/h1>/.test(pageSource), "no content <h1>Issues</h1>");
});

test("action row keeps the New-issue button right-aligned with no leftover gap", () => {
  assert.ok(pageSource.includes("New issue"), "New issue button retained");
  const bar = pageSource.match(/<div className="([^"]*)">\s*(?:<h2[\s\S]*?<\/h2>\s*)?<button[\s\S]*?>\s*New issue/s);
  assert.ok(bar, "New issue button sits in the top action row");
  assert.ok(bar[1].includes("justify-end"), `action row right-aligns the button (got: ${bar[1]})`);
  assert.ok(!bar[1].includes("justify-between"), "no empty slot left where the heading was");
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
  // The list section header with its range/count text is list chrome, not the
  // removed page heading — it stays with the paginated list.
  assert.ok(/<h3[^>]*>\s*Issues\s*<\/h3>/.test(pageSource), "list section header retained");
});
