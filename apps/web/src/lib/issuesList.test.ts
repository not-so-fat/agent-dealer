// NOT-228: view-model tests for the Issues list filter bar + pagination —
// URL serialization round-trips, page-1 canonicalization, draft isolation in
// Previous/Next, range text, and the filter-specific empty state. Pure logic
// (no React/DOM); run with `npx tsx --test apps/web/src/lib/issuesList.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyIssuesFormQuery,
  DEFAULT_ISSUES_DIRECTION,
  DEFAULT_ISSUES_SORT,
  EMPTY_ISSUES_FORM,
  formToIssuesFilters,
  hasActiveIssuesFilters,
  issuesDirectionFromSearch,
  issuesPageText,
  issuesRangeText,
  issuesSortFromSearch,
  searchToIssuesFilters,
  searchToIssuesForm,
  serializeIssuesQuery,
  setIssuesPageQuery,
  setIssuesSortQuery,
  toggleIssuesDirectionQuery,
} from "./issuesList.js";

test("empty search maps to the empty form and no fetch filters", () => {
  assert.deepEqual(searchToIssuesForm(""), EMPTY_ISSUES_FORM);
  assert.deepEqual(searchToIssuesFilters(""), {});
  assert.equal(hasActiveIssuesFilters({}), false);
});

test("applied filters round-trip through the URL, page included", () => {
  const filters = {
    q: "NOT-175",
    status: "needs_human",
    repo: "github.com/acme/app",
    needsAttention: true,
    page: 3,
  };
  const qs = serializeIssuesQuery(filters);
  assert.deepEqual(searchToIssuesFilters(qs), filters);
  assert.deepEqual(searchToIssuesForm(qs), {
    q: "NOT-175",
    status: "needs_human",
    repo: "github.com/acme/app",
    needsAttention: true,
  });
});

test("page 1 is canonicalized out of the URL", () => {
  assert.equal(serializeIssuesQuery({ q: "x", page: 1 }), "q=x");
  assert.equal(serializeIssuesQuery({}), "");
  assert.equal(setIssuesPageQuery("q=x&page=3", 1), "q=x");
  assert.equal(setIssuesPageQuery("", 1), "");
});

test("applying the form resets to page 1; drafts never leak into pagination", () => {
  assert.deepEqual(formToIssuesFilters({ ...EMPTY_ISSUES_FORM, q: "  wobble " }), { q: "wobble" });
  assert.deepEqual(formToIssuesFilters(EMPTY_ISSUES_FORM), {});
  const search = "q=applied&status=ready&page=2";
  const next = setIssuesPageQuery(search, 3);
  assert.ok(next.includes("page=3"));
  assert.ok(next.includes("q=applied"));
  assert.ok(next.includes("status=ready"));
  // A draft param absent from the applied URL is never added by Previous/Next.
  assert.ok(!next.includes("repo="));
});

test("range text states the visible window; empty is filter-specific", () => {
  assert.equal(
    issuesRangeText({ page: 1, limit: 25, total: 60, totalPages: 3 }),
    "Showing 1–25 of 60 issues"
  );
  assert.equal(
    issuesRangeText({ page: 3, limit: 25, total: 60, totalPages: 3 }),
    "Showing 51–60 of 60 issues"
  );
  assert.equal(
    issuesRangeText({ page: 1, limit: 25, total: 0, totalPages: 0 }),
    "No issues match these filters"
  );
  assert.equal(issuesPageText({ page: 1, limit: 25, total: 10, totalPages: 1 }), "");
  assert.equal(issuesPageText({ page: 2, limit: 25, total: 60, totalPages: 3 }), "Page 2 of 3");
});

test("invalid pages are dropped; needsAttention accepts 1 and true", () => {
  assert.deepEqual(searchToIssuesFilters("?page=abc").page, undefined);
  assert.deepEqual(searchToIssuesFilters("?page=0").page, undefined);
  assert.equal(searchToIssuesFilters("?needsAttention=1").needsAttention, true);
  assert.equal(searchToIssuesFilters("?needsAttention=true").needsAttention, true);
  assert.equal(searchToIssuesFilters("?needsAttention=0").needsAttention, undefined);
  assert.equal(hasActiveIssuesFilters({ page: 2 }), false);
  assert.equal(hasActiveIssuesFilters({ q: "x" }), true);
});

// NOT-385: Latest defaults to descending `updatedAt` — a URL with Latest
// selected and no direction parameter resolves to newest-first.
test("Latest with no direction resolves to newest-first", () => {
  assert.equal(DEFAULT_ISSUES_SORT, "latest");
  assert.equal(DEFAULT_ISSUES_DIRECTION, "desc");
  assert.deepEqual(searchToIssuesFilters(""), {});
  assert.equal(issuesSortFromSearch(""), "latest");
  assert.equal(issuesDirectionFromSearch(""), "desc");
  assert.deepEqual(searchToIssuesFilters("?sort=latest"), { sort: "latest" });
  assert.equal(issuesSortFromSearch("?sort=latest"), "latest");
  assert.equal(issuesDirectionFromSearch("?sort=latest"), "desc");
});

// NOT-385: the redundant default is canonicalized out of the shareable URL,
// while an explicit ascending direction survives alongside every filter.
test("default sort/direction canonicalize away; ascending round-trips with every filter", () => {
  assert.equal(serializeIssuesQuery({ sort: "latest", direction: "desc" }), "");
  assert.equal(serializeIssuesQuery({ sort: "latest" }), "");
  assert.equal(serializeIssuesQuery({ direction: "desc" }), "");
  assert.equal(serializeIssuesQuery({}), "");
  const filters = {
    q: "NOT-175",
    status: "needs_human",
    repo: "github.com/acme/app",
    needsAttention: true,
    page: 3,
    sort: "latest" as const,
    direction: "asc" as const,
  };
  const qs = serializeIssuesQuery(filters);
  assert.ok(qs.includes("direction=asc"), qs);
  assert.ok(!qs.includes("sort="), `default sort stays out: ${qs}`);
  const { sort: _dropped, ...canonical } = filters;
  void _dropped;
  assert.deepEqual(searchToIssuesFilters(qs), canonical);
  // Reload / Back-Forward restore the same view from the URL alone.
  assert.equal(issuesDirectionFromSearch(qs), "asc");
  assert.equal(issuesSortFromSearch(qs), "latest");
});

// NOT-385: invalid sort/direction values fall back safely to Latest newest-first.
test("invalid sort and direction values fall back to the default", () => {
  assert.deepEqual(searchToIssuesFilters("?sort=title&direction=sideways"), {});
  assert.equal(issuesSortFromSearch("?sort=title"), "latest");
  assert.equal(issuesDirectionFromSearch("?direction=sideways"), "desc");
  assert.equal(issuesDirectionFromSearch("?direction=DESC"), "desc");
  assert.deepEqual(searchToIssuesFilters("?direction=asc&direction=bogus"), { direction: "asc" });
});

// NOT-385: the order control flips newest-first → oldest-first, keeping Latest
// selected and every filter, while resetting pagination to page 1.
test("toggling newest-first adds direction=asc and keeps Latest plus every filter", () => {
  const before = "direction=desc&needsAttention=1&page=3&q=NOT-175&repo=github.com%2Facme%2Fapp&sort=latest&status=needs_human";
  const after = toggleIssuesDirectionQuery(before);
  assert.ok(after.includes("direction=asc"), after);
  assert.ok(after.includes("sort=latest"), `Latest stays selected: ${after}`);
  for (const kept of ["q=NOT-175", "status=needs_human", "repo=github.com%2Facme%2Fapp", "needsAttention=1"]) {
    assert.ok(after.includes(kept), `filter survives the toggle: ${kept} in ${after}`);
  }
  assert.ok(!after.includes("page="), `pagination resets to page 1: ${after}`);
  assert.equal(issuesDirectionFromSearch(after), "asc");
  assert.deepEqual(searchToIssuesFilters(after).page, undefined);
  // From the bare default URL the toggle adds only the direction.
  assert.equal(toggleIssuesDirectionQuery(""), "direction=asc");
});

// NOT-385: toggling back drops the redundant parameter and restores the
// shortest URL without losing the sort key or any filter.
test("toggling oldest-first restores the canonical newest-first URL", () => {
  const before = "direction=asc&needsAttention=1&page=2&q=NOT-175&sort=latest&status=ready";
  const after = toggleIssuesDirectionQuery(before);
  assert.ok(!after.includes("direction="), `redundant descending stays out: ${after}`);
  assert.ok(after.includes("sort=latest"), `Latest stays selected: ${after}`);
  for (const kept of ["q=NOT-175", "status=ready", "needsAttention=1"]) {
    assert.ok(after.includes(kept), `filter survives the toggle: ${kept} in ${after}`);
  }
  assert.ok(!after.includes("page="), `pagination resets to page 1: ${after}`);
  assert.equal(issuesDirectionFromSearch(after), "desc");
  // A double toggle round-trips to the canonical URL.
  assert.equal(toggleIssuesDirectionQuery(toggleIssuesDirectionQuery("q=x")), "q=x");
});

// NOT-385: applying the draft form keeps the selected direction; Previous/Next
// keep it too, and sorting is never mistaken for filtering.
test("apply and pagination preserve the direction; direction alone is not a filter", () => {
  const applied = applyIssuesFormQuery("direction=asc&page=4", { ...EMPTY_ISSUES_FORM, q: "wobble" });
  assert.ok(applied.includes("direction=asc"), applied);
  assert.ok(applied.includes("q=wobble"), applied);
  assert.ok(!applied.includes("page="), `apply resets to page 1: ${applied}`);
  assert.equal(applyIssuesFormQuery("", EMPTY_ISSUES_FORM), "");
  const next = setIssuesPageQuery("direction=asc&q=x", 2);
  assert.ok(next.includes("direction=asc"), `Previous/Next keep the direction: ${next}`);
  assert.ok(next.includes("page=2"), next);
  assert.equal(setIssuesSortQuery("direction=asc&page=2&q=x", "latest"), "direction=asc&q=x");
  assert.equal(hasActiveIssuesFilters({ sort: "latest", direction: "asc" }), false);
  assert.equal(hasActiveIssuesFilters({ direction: "asc", q: "x" }), true);
});
