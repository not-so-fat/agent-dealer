// NOT-228: view-model tests for the Issues list filter bar + pagination —
// URL serialization round-trips, page-1 canonicalization, draft isolation in
// Previous/Next, range text, and the filter-specific empty state. Pure logic
// (no React/DOM); run with `npx tsx --test apps/web/src/lib/issuesList.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_ISSUES_FORM,
  formToIssuesFilters,
  hasActiveIssuesFilters,
  issuesPageText,
  issuesRangeText,
  searchToIssuesFilters,
  searchToIssuesForm,
  serializeIssuesQuery,
  setIssuesPageQuery,
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
