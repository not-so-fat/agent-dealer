// NOT-385: API-client tests for the Issues list direction — fetchIssuesPage
// states its own order explicitly, and the order-control toggle transitions
// change exactly the direction (plus the page-1 reset) in the request URL
// while every applied filter survives. fetch is stubbed; no network, no DOM.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchIssuesPage } from "./api.js";
import { searchToIssuesFilters, toggleIssuesDirectionQuery } from "./lib/issuesList.js";

const PAGE_BODY = { issues: [], page: 1, limit: 25, total: 0, totalPages: 0 };

let lastUrl: string | null = null;

function seen(): string {
  assert.ok(lastUrl !== null, "fetch was called");
  return lastUrl;
}

beforeEach(() => {
  lastUrl = null;
  (globalThis as { fetch?: unknown }).fetch = async (url: unknown) => {
    lastUrl = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(PAGE_BODY),
      json: async () => PAGE_BODY,
    };
  };
});

test("the list request states its own order; newest-first is explicit", async () => {
  await fetchIssuesPage({});
  assert.ok(seen().startsWith("/api/issues?"), seen());
  assert.ok(seen().includes("direction=desc"), seen());
  assert.ok(seen().includes("page=1"), seen());
});

test("ascending, filters, and later pages serialize into the request URL", async () => {
  await fetchIssuesPage({
    q: "NOT-175",
    status: "needs_human",
    repo: "github.com/acme/app",
    needsAttention: true,
    page: 3,
    direction: "asc",
  });
  for (const param of [
    "direction=asc",
    "q=NOT-175",
    "status=needs_human",
    `repo=${encodeURIComponent("github.com/acme/app")}`,
    "needsAttention=1",
    "page=3",
  ]) {
    assert.ok(seen().includes(param), `${param} in ${seen()}`);
  }
});

test("toggling newest-first sends direction=asc with the same filters at page 1", async () => {
  const before = "needsAttention=1&page=3&q=NOT-175&sort=latest&status=needs_human";
  const after = toggleIssuesDirectionQuery(before);
  await fetchIssuesPage(searchToIssuesFilters(before));
  const beforeUrl = seen();
  assert.ok(beforeUrl.includes("direction=desc"), beforeUrl);
  assert.ok(beforeUrl.includes("page=3"), beforeUrl);
  await fetchIssuesPage(searchToIssuesFilters(after));
  const afterUrl = seen();
  assert.ok(afterUrl.includes("direction=asc"), afterUrl);
  assert.ok(afterUrl.includes("page=1"), `toggle resets to page 1: ${afterUrl}`);
  for (const param of ["q=NOT-175", "status=needs_human", "needsAttention=1"]) {
    assert.ok(afterUrl.includes(param), `filter survives the toggle: ${param} in ${afterUrl}`);
  }
});

test("toggling oldest-first sends direction=desc back with the same filters at page 1", async () => {
  const before = "direction=asc&page=2&q=NOT-175&sort=latest&status=ready";
  const after = toggleIssuesDirectionQuery(before);
  await fetchIssuesPage(searchToIssuesFilters(before));
  const beforeUrl = seen();
  assert.ok(beforeUrl.includes("direction=asc"), beforeUrl);
  await fetchIssuesPage(searchToIssuesFilters(after));
  const afterUrl = seen();
  assert.ok(afterUrl.includes("direction=desc"), afterUrl);
  assert.ok(afterUrl.includes("page=1"), `toggle resets to page 1: ${afterUrl}`);
  for (const param of ["q=NOT-175", "status=ready"]) {
    assert.ok(afterUrl.includes(param), `filter survives the toggle: ${param} in ${afterUrl}`);
  }
  // The browser URL drops the redundant parameter even though the request states it.
  assert.ok(!after.includes("direction="), after);
});
