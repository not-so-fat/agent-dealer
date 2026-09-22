// NOT-175: view-model tests for the Execution report page — coverage/missing
// values, sparse samples, the unknown failure bucket, and filter form
// round-trips. NOT-238 removed list-only pagination state. Pure logic
// (no React/DOM); run via tsc + node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CohortRow, FailureDistributionEntry } from "@agent-dealer/shared";
import {
  cohortHref,
  dateInputToIso,
  filtersToForm,
  formToFilters,
  isoToDateInput,
  issueDetailHref,
  orderFailureDisplay,
  searchToFilters,
  searchToForm,
  successText,
  toCohortDisplay,
  toSuccessDisplay,
  toCoverageDisplay,
  toPercentileDisplay,
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
    failedDurationMs: { sum: 60000, known: 1, total: 1, quality: "inferred", reasons: [] },
    failedTokensIn: { sum: 100, known: 1, total: 1, quality: "exact", reasons: [] },
    failedTokensOut: { sum: 50, known: 1, total: 1, quality: "exact", reasons: [] },
    failedCostUsd: { sum: 1.5, known: 1, total: 1, quality: "exact", reasons: [] },
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
  assert.equal(successText(null, 0, "closed").text, "N/A");
  assert.equal(successText(null, 0, "terminal attempts").title, "No terminal attempts in this cohort");
});

// NOT-244: success as structured parts — percentage separate from evidence,
// N/A when missing.
test("success display splits the percentage from its denominator evidence", () => {
  const shown = toSuccessDisplay(74 / 86, 86, "closed");
  assert.equal(shown.available, true);
  assert.equal(shown.valueText, "86.0%");
  assert.equal(shown.evidenceCounts, "74/86");
  assert.equal(shown.evidenceNoun, "closed");
  assert.ok(shown.title.includes("86 closed"));
  const attempt = toSuccessDisplay(0.5, 4, "terminal");
  assert.equal(attempt.valueText, "50.0%");
  assert.equal(attempt.evidenceCounts, "2/4");
  assert.equal(attempt.evidenceNoun, "terminal");
  const missing = toSuccessDisplay(null, 0, "closed");
  assert.equal(missing.available, false);
  assert.equal(missing.valueText, "N/A");
  assert.equal(missing.evidenceCounts, null);
  assert.equal(missing.evidenceNoun, null);
  const zeroDenominator = toSuccessDisplay(0.5, 0, "closed");
  assert.equal(zeroDenominator.available, false);
  assert.equal(zeroDenominator.valueText, "N/A");
});

test("null retry and share rates read N/A, never 0%", () => {
  const noRetry = toCohortDisplay(cohort({ retryRate: null }));
  assert.equal(noRetry.retryText, "N/A");
  const [noShare] = orderFailureDisplay([
    { code: "validation_failure", domain: "task", count: 5, share: null, issueIds: ["a"], issueTotal: 5 },
  ]);
  assert.equal(noShare!.shareText, "N/A");
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

test("cohort rows render duration coverage, retry, and per-cohort failed waste", () => {
  const row = toCohortDisplay(cohort({}));
  assert.equal(row.durationText, "1m 5s (2/3 known)");
  assert.equal(row.retryText, "50.0%");
  assert.ok(row.retryTitle.includes("issue/role/round"));
  assert.equal(row.failedCostText, "$1.50");
  assert.equal(row.failedTokensText, "100 in · 50 out");
  assert.equal(row.failedDurationText, "1m 0s");
  assert.equal(row.failedIncomplete, false);
  const noFailures = toCohortDisplay(
    cohort({
      failedDurationMs: { sum: null, known: 0, total: 0, quality: "unavailable", reasons: ["no_observations"] },
      failedTokensIn: { sum: null, known: 0, total: 0, quality: "unavailable", reasons: ["no_observations"] },
      failedTokensOut: { sum: null, known: 0, total: 0, quality: "unavailable", reasons: ["no_observations"] },
      failedCostUsd: { sum: null, known: 0, total: 0, quality: "unavailable", reasons: ["no_observations"] },
    })
  );
  assert.equal(noFailures.failedCostText, "Unavailable");
  assert.equal(noFailures.failedTokensText, "Unavailable in · Unavailable out");
  assert.equal(noFailures.failedDurationText, "Unavailable");
});

test("failure share names its denominator", () => {
  const shown = orderFailureDisplay([
    { code: "validation_failure", domain: "task", count: 5, share: 5 / 6, issueIds: ["a"], issueTotal: 5 },
    { code: "unknown", domain: "unknown", count: 1, share: 1 / 6, issueIds: ["u1"], issueTotal: 1 },
  ]);
  assert.equal(shown[0]!.shareTitle, "5 of 6 issues with a failed attempt");
  assert.equal(shown[1]!.shareTitle, "1 of 6 issues with a failed attempt");
  assert.deepEqual(orderFailureDisplay([]), []);
});

test("form state keeps defaults out: only explicit dates appear", () => {
  const blank = searchToForm("");
  assert.equal(blank.fromDate, "");
  assert.equal(blank.toDate, "");
  assert.equal(blank.repo, "");
  const explicit = searchToForm("?from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z&runtime=nope");
  assert.equal(explicit.fromDate, "2026-09-01");
  assert.equal(explicit.toDate, "2026-09-30");
  assert.equal(explicit.runtime, "nope");
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

// NOT-238: list-only page/limit URL state is ignored — Reports no longer
// renders an issue list, so legacy params never reach the request.
test("fetch filters carry only URL params: no client-clock dates, no stale to", () => {
  assert.deepEqual(searchToFilters(""), {});
  assert.deepEqual(searchToFilters("?role=developer&runtime=cursor_local"), {
    role: "developer",
    runtime: "cursor_local",
  });
  const dated = searchToFilters("?from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z&page=2&limit=10");
  assert.equal(dated.from, "2026-09-01T00:00:00.000Z");
  assert.equal(dated.to, "2026-09-30T23:59:59.999Z");
  assert.equal(dated.page, undefined, "legacy page param is not sent");
  assert.equal(dated.limit, undefined, "legacy limit param is not sent");
  assert.deepEqual(searchToFilters("?page=abc&limit=9999"), {});
});

// NOT-229: structured percentile/coverage readouts keep values separate from
// labels and notes, with one Unavailable state and compact tokens.
test("percentile display separates P50/P95 values from sample notes", () => {
  const shown = toPercentileDisplay({ p50: 1000, p95: 2000, n: 2 }, String);
  assert.equal(shown.available, true);
  assert.equal(shown.p50Text, "1000");
  assert.equal(shown.p95Text, "2000");
  assert.equal(shown.sampleText, "n=2 (sparse)");
  assert.equal(shown.sparse, true);
  assert.ok(shown.sampleTitle.includes("Sample size 2"));
  const missing = toPercentileDisplay({ p50: null, p95: null, n: 0 }, String);
  assert.equal(missing.available, false);
  assert.equal(missing.p50Text, null);
  assert.equal(missing.p95Text, null);
});

test("coverage display keeps the known aggregate primary with a separate note", () => {
  const partial = toCoverageDisplay({ sum: 110, known: 2, total: 3 }, String);
  assert.equal(partial.available, true);
  assert.equal(partial.valueText, "110");
  assert.equal(partial.noteText, "2/3 known");
  assert.ok(partial.noteTitle!.includes("never zero"));
  const full = toCoverageDisplay({ sum: 110, known: 3, total: 3 }, String);
  assert.equal(full.noteText, null);
  const missing = toCoverageDisplay({ sum: null, known: 0, total: 3 }, String);
  assert.equal(missing.available, false);
  assert.equal(missing.valueText, "N/A");
});

test("compact token coverage shows a short value with the exact count alongside", () => {
  const tokens = toCoverageDisplay({ sum: 1_234_567, known: 3, total: 3 }, (n) => n.toLocaleString("en-US"), {
    compact: true,
  });
  assert.equal(tokens.valueText, "1.2M");
  assert.equal(tokens.exactText, "1,234,567");
});

test("unknown failures display operator wording while keeping the raw code", () => {
  const shown = orderFailureDisplay([
    { code: "validation_failure", domain: "task", count: 5, share: 5 / 6, issueIds: ["a"], issueTotal: 5 },
    { code: "unknown", domain: "unknown", count: 1, share: 1 / 6, issueIds: ["u1"], issueTotal: 1 },
  ]);
  const unknown = shown.find((e) => e.code === "unknown")!;
  assert.equal(unknown.displayCode, "Cause not recorded");
  assert.equal(unknown.displayNote, "Needs more evidence");
  assert.equal(unknown.code, "unknown", "raw code preserved for ordering/links");
  const named = shown.find((e) => e.code === "validation_failure")!;
  assert.equal(named.displayCode, "validation_failure");
});

test("cohort rows link to the report filtered by that dimension", () => {
  const href = cohortHref("repo=github.com%2Facme%2Fapp&page=3&limit=10", "runtime", "cursor_local");
  assert.ok(href.startsWith("/reports/execution?"));
  assert.ok(href.includes("runtime=cursor_local"));
  assert.ok(href.includes("repo="));
  assert.ok(!href.includes("page="), "drilling in drops legacy list pagination");
  assert.ok(!href.includes("limit="), "drilling in drops legacy list limit");
  const bare = cohortHref("", "model", "unknown");
  assert.equal(bare, "/reports/execution?model=unknown");
});
