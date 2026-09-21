// NOT-175: contract tests for the execution-report shared helpers — filter
// serialization round-trips, conservative-window defaults, nearest-rank
// percentiles with sample counts, and coverage that never coerces missing to 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageCellText,
  coverageSum,
  defaultExecutionReportWindow,
  DEFAULT_EXECUTION_REPORT_WINDOW_DAYS,
  EXECUTION_REPORT_DEFAULT_LIMIT,
  formatRate,
  isSparseSample,
  nearestRankPercentiles,
  parseExecutionReportQuery,
  percentileCellText,
  sampleLabel,
  serializeExecutionReportQuery,
} from "./execution-report.js";

test("defaults use the conservative 30-day window", () => {
  const now = Date.parse("2026-09-21T00:00:00.000Z");
  const win = defaultExecutionReportWindow(now);
  assert.equal(win.to, "2026-09-21T00:00:00.000Z");
  const spanDays = (Date.parse(win.to) - Date.parse(win.from)) / 86_400_000;
  assert.equal(spanDays, DEFAULT_EXECUTION_REPORT_WINDOW_DAYS);
  const parsed = parseExecutionReportQuery("", now);
  assert.equal(parsed.from, win.from);
  assert.equal(parsed.to, win.to);
});

test("filter serialization round-trips and omits empties/defaults", () => {
  const qs = serializeExecutionReportQuery({
    from: "2026-08-01T00:00:00.000Z",
    repo: "github.com/acme/app",
    role: "developer",
    runtime: "claude_code",
    model: "",
    status: "done,closed",
    page: 1,
    limit: EXECUTION_REPORT_DEFAULT_LIMIT,
  });
  assert.ok(!qs.includes("model="));
  assert.ok(!qs.includes("page="));
  assert.ok(!qs.includes("limit="));
  const back = parseExecutionReportQuery(`?${qs}`);
  assert.equal(back.repo, "github.com/acme/app");
  assert.equal(back.role, "developer");
  assert.equal(back.runtime, "claude_code");
  assert.equal(back.model, undefined);
  assert.equal(back.status, "done,closed");
  assert.equal(back.page, undefined);
});

test("page/limit survive the round-trip when non-default", () => {
  const qs = serializeExecutionReportQuery({ page: 3, limit: 50 });
  const back = parseExecutionReportQuery(`?${qs}`);
  assert.equal(back.page, 3);
  assert.equal(back.limit, 50);
});

test("nearest-rank percentiles follow API values exactly and carry n", () => {
  // Contract §9.6: [0.90, 1.10, 2.20] → rank ceil(0.5·3)=2 → 1.10.
  const s = nearestRankPercentiles([0.9, 1.1, 2.2]);
  assert.equal(s.p50, 1.1);
  assert.equal(s.p95, 2.2);
  assert.equal(s.n, 3);
  const empty = nearestRankPercentiles([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.p50, null);
  assert.equal(empty.quality, "unavailable");
});

test("coverage sums exclude missing values and never report zero for unknown", () => {
  const c = coverageSum([1.1, null, 0.9, undefined, 2.2]);
  assert.ok(Math.abs(c.sum! - 4.2) < 1e-9);
  assert.equal(c.known, 3);
  assert.equal(c.total, 5);
  assert.deepEqual(c.reasons, ["partial_sample"]);
  const none = coverageSum([null, null]);
  assert.equal(none.sum, null);
  assert.equal(none.quality, "unavailable");
  assert.deepEqual(none.reasons, ["missing_provider_metadata"]);
  assert.equal(coverageCellText(none, String), "Unavailable");
  assert.equal(coverageCellText(c, (n) => `$${n.toFixed(2)}`), "$4.20 (3/5 known)");
  const full = coverageSum([1, 2]);
  assert.equal(coverageCellText(full, String), "3");
});

test("sparse samples are explicit and percentiles always show n", () => {
  assert.equal(sampleLabel(2), "n=2 (sparse)");
  assert.equal(sampleLabel(30), "n=30");
  assert.ok(isSparseSample(1));
  assert.ok(!isSparseSample(5));
  const cell = percentileCellText({ p50: 1000, p95: 2000, n: 2 }, String);
  assert.ok(cell.includes("n=2 (sparse)"));
  assert.equal(percentileCellText({ p50: null, p95: null, n: 0 }, String), "Unavailable");
});

test("rates render Unavailable instead of zero when there is no denominator", () => {
  assert.equal(formatRate(null), "Unavailable");
  assert.equal(formatRate(0.5), "50.0%");
});
