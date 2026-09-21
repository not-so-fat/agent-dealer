// NOT-175: view-model tests for the Execution report page — coverage/missing
// values, sparse samples, the unknown failure bucket, pagination text, and
// filter form round-trips. Pure logic (no React/DOM); run via tsc + node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CohortRow, FailureDistributionEntry } from "@agent-dealer/shared";
import {
  dateInputToIso,
  filtersToForm,
  formToFilters,
  isoToDateInput,
  issueDetailHref,
  orderFailureDisplay,
  paginationText,
  successText,
  toCohortDisplay,
} from "./executionReport.js";

function cohort(over: Partial<CohortRow>): CohortRow {
  return {
    key: "claude_code",
    issues: 2,
    attempts: 3,
    issueSuccess: 0.5,
    issueSuccessDenominator: 2,
    attemptSuccess: 0.5,
    attemptSuccessDenominator: 2,
    sessionWallMs: { p50: 1000, p95: 2000, n: 2, quality: "inferred", reasons: [] },
    spawnEnvelopeMs: { p50: 1100, p95: 2100, n: 2, quality: "inferred", reasons: [] },
    retryRate: 0.5,
    tokensIn: { sum: 110, known: 2, total: 3, quality: "exact", reasons: ["partial_sample"] },
    tokensOut: { sum: 55, known: 2, total: 3, quality: "exact", reasons: ["partial_sample"] },
    costUsd: { sum: null, known: 0, total: 3, quality: "unavailable", reasons: ["missing_provider_metadata"] },
    durationMs: { sum: 65000, known: 2, total: 3, quality: "inferred", reasons: ["partial_sample"] },
    ...over,
  };
}

test("missing cost reads Unavailable while partial tokens show N/M known", () => {
  const row = toCohortDisplay(cohort({}));
  assert.equal(row.costText, "Unavailable");
  assert.equal(row.costIncomplete, true);
  assert.equal(row.tokensInText, "110 (2/3 known)");
  assert.equal(row.durationText, "1m 5s (2/3 known)");
});

test("full coverage shows the bare sum and sparse flags small cohorts", () => {
  const row = toCohortDisplay(
    cohort({
      attempts: 30,
      costUsd: { sum: 4.2, known: 3, total: 3, quality: "exact", reasons: [] },
    })
  );
  assert.equal(row.costText, "$4.20");
  assert.equal(row.sparse, false);
  const sparse = toCohortDisplay(cohort({ attempts: 2 }));
  assert.equal(sparse.sparse, true);
  assert.ok(sparse.wallText.includes("n=2 (sparse)"));
});

test("success text keeps denominators separate and names the missing one", () => {
  assert.equal(successText(0.5, 2, "closed").text, "50.0% (1/2 closed)");
  assert.equal(successText(null, 0, "closed").text, "Unavailable");
  assert.equal(successText(null, 0, "terminal attempts").title, "No terminal attempts in this cohort");
});

test("unknown failures stay a visible bucket with issue links", () => {
  const entries: FailureDistributionEntry[] = [
    { code: "validation_failure", domain: "task", count: 5, share: 5 / 6, issueIds: ["a"], issueTotal: 5 },
    { code: "unknown", domain: "unknown", count: 1, share: 1 / 6, issueIds: ["u1", "u2"], issueTotal: 12 },
  ];
  const shown = orderFailureDisplay(entries);
  assert.equal(shown.length, 2);
  const unknown = shown.find((e) => e.code === "unknown")!;
  assert.equal(unknown.isUnknown, true);
  assert.equal(unknown.hiddenIssueCount, 10);
  assert.deepEqual(unknown.issueIds, ["u1", "u2"]);
  assert.equal(issueDetailHref("u1"), "/issues/u1");
});

test("pagination text and empty states read without devtools", () => {
  assert.equal(paginationText({ page: 2, limit: 25, total: 60, totalPages: 3 }), "Showing 26–50 of 60 issues · page 2 of 3");
  assert.equal(paginationText({ page: 1, limit: 25, total: 0, totalPages: 0 }), "No issues match these filters");
});

test("filter form round-trips through date inputs", () => {
  assert.equal(dateInputToIso("2026-09-01", false), "2026-09-01T00:00:00.000Z");
  assert.equal(dateInputToIso("2026-09-01", true), "2026-09-01T23:59:59.999Z");
  assert.equal(dateInputToIso("", false), undefined);
  assert.equal(isoToDateInput("2026-09-01T00:00:00.000Z"), "2026-09-01");
  const form = filtersToForm({ from: "2026-09-01T00:00:00.000Z", repo: "github.com/acme/app" });
  assert.equal(form.fromDate, "2026-09-01");
  assert.equal(form.repo, "github.com/acme/app");
  const back = formToFilters({ ...form, toDate: "", role: "", runtime: "", model: "", status: "" });
  assert.equal(back.from, "2026-09-01T00:00:00.000Z");
  assert.equal(back.to, undefined);
  assert.equal(back.role, undefined);
});
