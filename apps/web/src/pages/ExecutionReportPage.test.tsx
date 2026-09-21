// NOT-175: page-level tests for the Execution report — loading, error,
// empty, partial, pagination, unknown-failure, sparse, coverage, responsive,
// and keyboard-affordance states. ReportContent is pure (no hooks/fetch), so
// renderToStaticMarkup under MemoryRouter pins the markup without a browser,
// following the ExecutionAnalysisSection.test.tsx pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ReportContent } from "./ExecutionReportPage.js";
import { fixtureCohort, fixtureReport, unavailableSums } from "../lib/executionReport.fixture.js";

function render(props: Parameters<typeof ReportContent>[0]): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ReportContent, props)
    )
  );
}

const noop = () => {};

test("loading state announces itself and shows no report", () => {
  const html = render({ loading: true, error: null, report: null, onRetry: noop, onPage: noop });
  assert.ok(html.includes('role="status"'), "role=status for screen readers");
  assert.ok(html.includes("Loading execution report"));
  assert.ok(!html.includes("Issue success"));
});

test("API errors render an alert with a working Retry button", () => {
  const html = render({ loading: false, error: "boom", report: null, onRetry: noop, onPage: noop });
  assert.ok(html.includes('role="alert"'), "role=alert for screen readers");
  assert.ok(html.includes("boom"));
  assert.ok(html.includes("<button"), "retry is a real button, not a div");
  assert.ok(html.includes("Retry"));
  assert.ok(!html.includes("Loading execution report"));
});

test("empty cohorts explain themselves without devtools", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({
      summary: { ...fixtureReport().summary, issues: 0, closedIssues: 0 },
      issues: [],
      failures: [],
      pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
    }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes("No issues match these filters"));
});

test("partial metadata is visible with reasons", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(html.includes("Partial metadata"));
  assert.ok(html.includes("partial_sample"));
});

test("pagination renders labelled nav only across pages", () => {
  const multi = render({
    loading: false,
    error: null,
    report: fixtureReport({ pagination: { page: 1, limit: 25, total: 60, totalPages: 3 } }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(multi.includes('aria-label="Report pages"'));
  assert.ok(multi.includes("Page 1 of 3"));
  assert.ok(multi.includes("Previous") && multi.includes("Next"));
  assert.ok(multi.includes("<button"), "pagination controls are keyboard-focusable buttons");
  const single = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(!single.includes('aria-label="Report pages"'));
});

test("failures read as plain language with the raw code preserved", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(html.includes("Why attempts failed"), "operator heading, not statistical wording");
  assert.ok(!html.includes("Primary failure distribution"), "internal wording retired");
  assert.ok(html.includes("counted once using its primary"), "counting rule explained");
  assert.ok(html.includes("may later have recovered"), "recovery explained");
  assert.ok(html.includes("Cause not recorded"), "unknown bucket renamed for operators");
  assert.ok(html.includes("Needs more evidence"), "unknown bucket explains itself");
  assert.ok(html.includes('title="unknown"'), "underlying unknown code preserved in markup");
  assert.ok(html.includes('href="/issues/issue-b"'), "failure rows deep-link to issue detail");
  assert.ok(html.includes("1 of 2 issues with a failed attempt"), "share names its denominator");
});

test("comparison rows expose retry, duration coverage, and failed waste", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  for (const header of ["Retry rate", "Duration", "Failed cost", "Failed tokens", "Failed runtime"]) {
    assert.ok(html.includes(header), `column: ${header}`);
  }
  assert.ok(html.includes("$1.50"), "per-cohort failed cost renders");
  assert.ok(html.includes("&gt;100&lt;/span&gt;") || html.includes(">100</span>"), "per-cohort failed token value renders");
  assert.ok(html.includes(">in</span>") && html.includes(">out</span>"), "in/out stay separate labels");
});

test("missing failed waste reads Unavailable, never zero", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({ byRole: [], byRuntime: [fixtureCohort({ key: "cursor_local", ...unavailableSums() })], byModel: [] }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes("Unavailable"));
  assert.ok(!html.includes("$0.00"));
});

test("sparse cohorts are flagged, not hidden", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({ byRole: [], byRuntime: [fixtureCohort({ attempts: 2 })], byModel: [] }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes("sparse"));
});

test("narrow widths scroll instead of clipping: responsive primitives present", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(html.includes("overflow-x-auto"), "wide tables scroll horizontally");
  assert.ok(html.includes("grid-cols-1"), "cards stack to one column at narrow widths");
  assert.ok(html.includes("flex-wrap"), "headers and issue rows wrap");
  assert.ok(html.includes("min-w-40"), "issue titles keep a readable minimum");
});

test("interactive elements use keyboard-accessible semantics", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({ pagination: { page: 2, limit: 25, total: 60, totalPages: 3 } }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes("<button"), "pagination uses real buttons");
  assert.ok(html.includes("<a "), "issues and failures link with real anchors");
  assert.ok(html.includes("focus-visible:"), "issue links show a focus ring");
  const err = render({ loading: false, error: "x", report: null, onRetry: noop, onPage: noop });
  assert.ok(err.includes('type="button"'), "retry button is keyboard-operable");
});

test("cohort rows link to filtered report views when a link builder is given", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport(),
    onRetry: noop,
    onPage: noop,
    cohortLink: (dimension, key) => `/reports/execution?${dimension}=${key}`,
  });
  assert.ok(
    html.includes('href="/reports/execution?runtime=claude_code"') ||
      html.includes('href="/reports/execution?runtime=cursor_local"'),
    "runtime cohort rows deep-link to a filtered report"
  );
  assert.ok(html.includes('title="Filter the report to runtime'), "links name their target");
});

test("phase section describes the shared read-model derivation", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(html.includes("execution-analysis read model"));
  assert.ok(!html.includes("no defensible evidence today"));
});

// NOT-229: metric hierarchy — chrome on the shared display token, values on Monaco.
test("report chrome uses font-ui-display while values stay Monaco", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(html.includes("font-ui-display"), "labels, headings, headers, and notes opt into the token");
  assert.ok(html.includes("Why attempts failed"), "section heading renders");
  assert.ok(html.includes("font-mono"), "metric values and identifiers stay Monaco");
  assert.ok(!html.includes("Avenir"), "no hard-coded face at call sites");
  assert.ok(!html.includes("Optima"), "no hard-coded face at call sites");
});

test("percentiles label P50/P95 separately with sample size as supporting text", () => {
  const html = render({ loading: false, error: null, report: fixtureReport(), onRetry: noop, onPage: noop });
  assert.ok(html.includes(">P50</span>"), "P50 label distinct from its value");
  assert.ok(html.includes(">P95</span>"), "P95 label distinct from its value");
  assert.ok(html.includes("n=2 (sparse)"), "sample size/sparse stays visible as a note");
  assert.ok(html.includes("Sample size 2"), "sample note explains itself to assistive tech via title");
});

test("missing percentiles render one Unavailable state with no P50/P95 numbers", () => {
  const noEvidence: { p50: null; p95: null; n: number; quality: "unavailable"; reasons: string[] } = {
    p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["no_observations"],
  };
  const base = fixtureReport();
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({
      summary: {
        ...base.summary,
        sessionWallMs: { ...noEvidence },
        spawnEnvelopeMs: { ...base.summary.spawnEnvelopeMs },
        checkpointMs: { ...base.summary.checkpointMs },
      },
      byRole: [],
      byRuntime: [],
      byModel: [],
    }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes("No attempts in this dimension"), "empty cohorts still explain themselves");
  assert.ok(html.includes(">Unavailable</span>"), "missing percentiles read Unavailable");
});

test("large token totals render compact with the exact count accessible", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({
      byRole: [],
      byRuntime: [
        fixtureCohort({
          key: "claude_code",
          tokensIn: { sum: 1_234_567, known: 3, total: 3, quality: "exact", reasons: [] },
        }),
      ],
      byModel: [],
    }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes(">1.2M</span>"), "visible token total is compact");
  assert.ok(html.includes('title="1,234,567"'), "exact comma-formatted value in title text");
  assert.ok(html.includes('aria-label="1,234,567"'), "exact value available to assistive technology");
});

test("partial coverage keeps the known value primary with a separate note", () => {
  const html = render({
    loading: false,
    error: null,
    report: fixtureReport({
      byRole: [],
      byRuntime: [
        fixtureCohort({
          key: "claude_code",
          tokensIn: { sum: 110, known: 2, total: 3, quality: "exact", reasons: ["partial_sample"] },
        }),
      ],
      byModel: [],
    }),
    onRetry: noop,
    onPage: noop,
  });
  assert.ok(html.includes(">110</span>"), "known aggregate is the primary value");
  assert.ok(html.includes(">2/3 known</span>"), "coverage denominator is a separate note");
});
