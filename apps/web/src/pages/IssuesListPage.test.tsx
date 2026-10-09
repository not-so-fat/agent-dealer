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
const apiSource = readFileSync(join(dir, "..", "api.ts"), "utf8");

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
    "Admission queue",
    "NeedsAttentionPanel",
  ]) {
    assert.ok(pageSource.includes(token), `list control kept: ${token}`);
  }
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
    !pageSource.includes("max one per repository"),
    "no max-one-per-repository copy remains"
  );
  assert.ok(
    pageSource.includes("How many issues may execute in parallel"),
    "capacity tooltip still explains the limit"
  );
});

// NOT-378: the Admission queue dropdown stays compact and in place, renders its
// options from AdmissionStatus.options (1–5 from the server), and saves through
// PUT /api/queue/settings — no new settings page, no per-repository control.
test("admission limit dropdown renders server options and saves through the settings route", () => {
  assert.ok(
    pageSource.includes("admission.options.map((o) => ("),
    "dropdown options render from AdmissionStatus.options"
  );
  assert.ok(
    pageSource.includes("admission.options.includes(admission.maxActiveIssues)"),
    "dropdown value binds to the persisted setting"
  );
  assert.ok(
    pageSource.includes("onChange={(e) => void changeLimit(Number(e.target.value))}"),
    "changing the dropdown calls the limit saver"
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

test("cap tooltip compares the ceiling against the shared hard maximum", async () => {
  const { MAX_ACTIVE_ISSUES_HARD_MAX } = await import("@agent-dealer/shared");
  assert.equal(MAX_ACTIVE_ISSUES_HARD_MAX, 5, "shared hard maximum is 5");
  assert.ok(
    pageSource.includes("admission.ceiling < MAX_ACTIVE_ISSUES_HARD_MAX"),
    "capped tooltip shows whenever the ceiling is below the hard maximum"
  );
  assert.ok(
    !pageSource.includes("admission.ceiling < 2"),
    "no stale ceiling-of-2 comparison remains"
  );
  assert.ok(
    !pageSource.includes("ConfigurationPage"),
    "still no separate settings page for the limit"
  );
});
