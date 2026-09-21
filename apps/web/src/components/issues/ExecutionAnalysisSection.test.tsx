// NOT-174: Execution analysis section — complete, partial, unknown, host-sleep,
// failed-retry, and mobile-narrow fixtures plus copy/quality rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AttemptAnalysis,
  CoveredTotal,
  IssueExecutionAnalysis,
  NestedInterval,
  PhaseInterval,
  UnionedPhaseDuration,
} from "@agent-dealer/shared";
import ExecutionAnalysisSection, { ExecutionAnalysisView } from "./ExecutionAnalysisSection.js";

function phase(
  phaseName: PhaseInterval["phase"],
  durationMs: number | null,
  quality: PhaseInterval["quality"] = "exact",
  reasons: string[] = [],
): PhaseInterval {
  return {
    phase: phaseName,
    startMs: durationMs == null ? null : 1_700_000_000_000,
    endMs: durationMs == null ? null : 1_700_000_000_000 + durationMs,
    durationMs,
    quality,
    reasons,
    sessionId: "session-1",
    startCursor: 1,
    endCursor: 2,
  };
}

function unioned(
  phaseName: UnionedPhaseDuration["phase"],
  durationMs: number | null,
  extra: Partial<UnionedPhaseDuration> = {},
): UnionedPhaseDuration {
  return {
    phase: phaseName,
    durationMs,
    quality: durationMs == null ? "unavailable" : "exact",
    reasons: durationMs == null ? ["missing_provider_metadata"] : [],
    rawCount: 1,
    known: durationMs == null ? 0 : 1,
    total: 1,
    ...extra,
  };
}

function covered(value: number | null, known: number, total: number): CoveredTotal {
  return value == null
    ? { value: null, quality: "unavailable", reasons: ["missing_provider_metadata"], known, total }
    : {
        value,
        quality: known < total ? "inferred" : "exact",
        reasons: known < total ? ["partial_sample"] : [],
        known,
        total,
      };
}

function attempt(extra: Partial<AttemptAnalysis> = {}): AttemptAnalysis {
  return {
    sessionId: "session-1",
    role: "developer",
    runtime: "claude",
    model: "opus-4",
    status: "done",
    round: 1,
    publishOnly: false,
    setup: phase("coordinator_setup", 12_000),
    agentProcess: phase("agent_process", 600_000),
    validationPublish: phase("coordinator_validation_publish", 45_000),
    spawnEnvelopeMs: 615_000,
    spawnEnvelopeQuality: "exact",
    spawnEnvelopeReasons: [],
    failureCauses: [],
    silence: [],
    silenceQuality: "exact",
    silenceReasons: [],
    tokensIn: 12_000,
    tokensOut: 4_000,
    costUsd: 1.23,
    usageDurationMs: 600_000,
    usageQuality: "exact",
    usageReasons: [],
    ...extra,
  };
}

/** Successful one-attempt issue with full evidence. */
function completeFixture(): IssueExecutionAnalysis {
  return {
    issueId: "issue-1",
    elapsed: phase("agent_process", 720_000),
    rawIntervals: [phase("agent_process", 600_000)],
    unionedDurations: [
      unioned("queue_wait", 30_000),
      unioned("coordinator_setup", 12_000),
      unioned("agent_process", 600_000),
      unioned("coordinator_validation_publish", 45_000),
    ],
    exclusiveTotalMs: 687_000,
    exclusiveTotalQuality: "exact",
    exclusiveTotalReasons: [],
    nested: [],
    attempts: [
      attempt({
        silence: [
          {
            kind: "unexplained_silence",
            startMs: 1_700_000_100_000,
            endMs: 1_700_000_160_000,
            durationMs: 60_000,
            quality: "inferred",
            reasons: ["sampler_observed_time"],
            category: "tool_or_subprocess_in_flight",
            sessionId: "session-1",
          },
        ],
        silenceQuality: "inferred",
        silenceReasons: ["sampler_observed_time"],
      }),
    ],
    primaryFailure: null,
    // Server-real values: null primaryFailure always yields unavailable /
    // missing_classification, even on a clean success.
    primaryFailureQuality: "unavailable",
    primaryFailureReasons: ["missing_classification"],
    consequenceCauses: [],
    waste: {
      failedAttempts: 0,
      publishOnlyAttempts: 0,
      runtimeMs: covered(null, 0, 0),
      tokensIn: covered(null, 0, 0),
      tokensOut: covered(null, 0, 0),
      costUsd: covered(null, 0, 0),
    },
    firstCheckpoint: {
      kind: "commit",
      observedSha: "abcdef1234567890abcdef1234567890abcdef12",
      msSinceWorkflowStart: 300_000,
      quality: "exact",
      reasons: [],
    },
    retry: {
      attempts: 1,
      retries: 0,
      cold: 0,
      reused: 0,
      unknown: 0,
      publishOnly: 0,
      reuseRate: null,
      quality: "unavailable",
      reasons: ["missing_provider_metadata"],
    },
    reviewer: { rounds: 0, verdicts: 0, changeRequests: 0, changeRequestRate: null, quality: "exact", reasons: [] },
    humanWaitMs: 0,
    humanWaitQuality: "exact",
    humanWaitReasons: [],
    interventionCount: 0,
    coverage: { duration: covered(600_000, 1, 1), tokens: covered(16_000, 1, 1), cost: covered(1.23, 1, 1) },
  };
}

/** Failed first attempt, retry reused the worktree and published. */
function failedRetryFixture(): IssueExecutionAnalysis {
  const base = completeFixture();
  return {
    ...base,
    attempts: [
      attempt({
        sessionId: "session-1",
        status: "failed",
        failureCauses: [
          {
            code: "tool_test_timeout",
            domain: "task",
            primary: true,
            confidence: "high",
            evidenceSource: "session_error",
            occurredAt: "2026-09-20T10:00:00.000Z",
            eventCursor: 7,
            rawReason: "npm test timed out after 300s",
            sessionId: "session-1",
            logPath: "/logs/session-1.log",
            eventId: null,
            eventType: "worker.failed",
            quality: "exact",
          },
          {
            code: "unknown",
            domain: "unknown",
            primary: false,
            confidence: "low",
            evidenceSource: "recovery",
            occurredAt: null,
            eventCursor: 9,
            rawReason: "retry scheduled after failure",
            sessionId: "session-1",
            logPath: null,
            eventId: null,
            eventType: null,
            quality: "inferred",
          },
        ],
      }),
      attempt({ sessionId: "session-2", status: "done", publishOnly: false, round: 2, reuseKinds: ["worktree", "commit"] }),
    ],
    primaryFailure: {
      code: "tool_test_timeout",
      domain: "task",
      primary: true,
      confidence: "high",
      evidenceSource: "session_error",
      occurredAt: "2026-09-20T10:00:00.000Z",
      eventCursor: 7,
      rawReason: "npm test timed out after 300s",
      sessionId: "session-1",
      logPath: "/logs/session-1.log",
      eventId: null,
      eventType: "worker.failed",
      quality: "exact",
    },
    primaryFailureQuality: "exact",
    primaryFailureReasons: [],
    consequenceCauses: [
      {
        code: "unknown",
        domain: "unknown",
        primary: false,
        confidence: "low",
        evidenceSource: "recovery",
        occurredAt: null,
        eventCursor: 9,
        rawReason: "retry scheduled after failure",
        sessionId: "session-1",
        logPath: null,
        eventId: null,
        eventType: null,
        quality: "inferred",
      },
    ],
    waste: {
      failedAttempts: 1,
      publishOnlyAttempts: 0,
      runtimeMs: covered(600_000, 1, 1),
      tokensIn: covered(12_000, 1, 1),
      tokensOut: covered(4_000, 1, 1),
      costUsd: covered(1.23, 1, 1),
    },
    retry: {
      attempts: 2,
      retries: 1,
      cold: 0,
      reused: 1,
      unknown: 0,
      publishOnly: 0,
      reuseRate: 1,
      preservedKinds: ["worktree", "commit"],
      quality: "exact",
      reasons: [],
    },
  };
}

function silenceInterval(category: NestedInterval["category"], durationMs: number | null): NestedInterval {
  return {
    kind: "unexplained_silence",
    startMs: durationMs == null ? null : 1_700_000_100_000,
    endMs: durationMs == null ? null : 1_700_000_100_000 + durationMs,
    durationMs,
    quality: durationMs == null ? "unavailable" : "inferred",
    reasons: durationMs == null ? ["missing_provider_metadata"] : ["sampler_observed_time"],
    category,
    sessionId: "session-1",
  };
}

test("one-attempt success shows phase breakdown and checkpoint timing", () => {
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={completeFixture()} />);
  assert.match(html, /Phase breakdown/);
  assert.match(html, /Agent process/);
  assert.match(html, /Setup/);
  assert.match(html, /Validation \/ publish/);
  assert.match(html, /Queue \/ admission wait/);
  assert.match(html, /First checkpoint/);
  assert.match(html, /commit/);
  assert.match(html, /5m/); // 300_000 ms after workflow start
  // Server-real values (unavailable / missing_classification) still read as a
  // clean success when no attempt failed.
  assert.match(html, /No failure recorded/);
  assert.doesNotMatch(html, /Unknown — missing_classification/);
  assert.match(html, /No failed attempts/);
  assert.match(html, /No retries/);
  assert.match(html, /developer/);
  assert.match(html, /claude/);
});

test("failed-then-reused retry shows primary failure, waste, and what was preserved", () => {
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={failedRetryFixture()} />);
  assert.match(html, /First failure:/);
  assert.match(html, /tool test timeout/);
  assert.match(html, /npm test timed out/);
  assert.match(html, /Consequence:/);
  // Primary failure is prominent (red-tinted card), consequences are secondary.
  const primaryIdx = html.indexOf("First failure:");
  const consequenceIdx = html.indexOf("Consequence:");
  assert.ok(primaryIdx >= 0 && consequenceIdx > primaryIdx, "consequence renders after the primary failure");
  assert.match(html, /Retry waste/);
  assert.match(html, /Reused 1/);
  assert.match(html, /100% reused/);
  // Exactly what was preserved: per-attempt badges plus the aggregate list.
  assert.match(html, /reused worktree/);
  assert.match(html, /reused commit/);
  assert.match(html, /Preserved: worktree, commit/);
});

test("silence shared by nested and attempt sources renders exactly once", () => {
  // The server mirrors each attempt's silence intervals into `nested`; the
  // view must use a single source so the operator never sees doubled silence.
  const shared: NestedInterval = {
    kind: "unexplained_silence",
    startMs: 1_700_000_100_000,
    endMs: 1_700_000_160_000,
    durationMs: 60_000,
    quality: "inferred",
    reasons: ["sampler_observed_time"],
    category: "tool_or_subprocess_in_flight",
    sessionId: "session-1",
  };
  const base = completeFixture();
  const analysis: IssueExecutionAnalysis = {
    ...base,
    nested: [shared],
    attempts: [
      attempt({ silence: [shared], silenceQuality: "inferred", silenceReasons: ["sampler_observed_time"] }),
    ],
  };
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={analysis} />);
  const occurrences = html.split("tool/subprocess in flight").length - 1;
  assert.equal(occurrences, 1, `expected one silence row, saw ${occurrences}`);
});

test("unknown failure and unknown silence remain explicitly unknown", () => {
  const base = completeFixture();
  const analysis: IssueExecutionAnalysis = {
    ...base,
    primaryFailure: null,
    primaryFailureQuality: "unavailable",
    primaryFailureReasons: ["missing_classification"],
    // Unknown requires a failed attempt with no classified cause — a clean
    // success with the same quality/reasons reads "No failure recorded".
    attempts: [
      attempt({ status: "failed", silence: [], silenceQuality: "unavailable", silenceReasons: ["missing_provider_metadata"] }),
    ],
  };
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={analysis} />);
  assert.match(html, /Unknown/);
  assert.match(html, /missing_classification/);
  assert.doesNotMatch(html, /No failure recorded/);
  assert.match(html, /silence cannot be derived/i);
});

test("silence unknown for one attempt is reported when others have intervals", () => {
  const base = completeFixture();
  const analysis: IssueExecutionAnalysis = {
    ...base,
    attempts: [
      attempt({
        sessionId: "session-1",
        silence: [silenceInterval("tool_or_subprocess_in_flight", 60_000)],
        silenceQuality: "inferred",
        silenceReasons: ["sampler_observed_time"],
      }),
      attempt({
        sessionId: "session-2",
        round: 2,
        silence: [],
        silenceQuality: "unavailable",
        silenceReasons: ["missing_provider_metadata"],
      }),
    ],
  };
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={analysis} />);
  assert.match(html, /tool\/subprocess in flight/);
  assert.match(html, /Silence unknown for attempt session-2/);
  assert.match(html, /missing_provider_metadata/);
});

test("cold and unknown retries get their own badges", () => {
  const base = completeFixture();
  const cold: IssueExecutionAnalysis = {
    ...base,
    attempts: [
      attempt({ sessionId: "session-1", status: "failed" }),
      attempt({ sessionId: "session-2", round: 2, reuseKinds: [] }),
    ],
    retry: { ...base.retry, attempts: 2, retries: 1, cold: 1, reused: 0, unknown: 0, quality: "exact", reasons: [] },
  };
  assert.match(renderToStaticMarkup(<ExecutionAnalysisView analysis={cold} />), /cold retry/);
  assert.match(
    renderToStaticMarkup(<ExecutionAnalysisView analysis={cold} />),
    /No prior work preserved — every retry started cold/,
  );

  const unknown: IssueExecutionAnalysis = {
    ...base,
    attempts: [
      attempt({ sessionId: "session-1", status: "failed" }),
      attempt({ sessionId: "session-2", round: 2 }),
    ],
    retry: { ...base.retry, attempts: 2, retries: 1, cold: 0, reused: 0, unknown: 1, quality: "inferred", reasons: ["partial_sample"] },
  };
  const unknownHtml = renderToStaticMarkup(<ExecutionAnalysisView analysis={unknown} />);
  assert.match(unknownHtml, /reuse unknown/);
  assert.match(unknownHtml, /Preservation unknown for 1 retry/);
});

test("host-suspended silence is distinguishable from tool/provider silence", () => {
  const base = completeFixture();
  const analysis: IssueExecutionAnalysis = {
    ...base,
    attempts: [
      attempt({
        silence: [silenceInterval("host_suspended", 120_000), silenceInterval("tool_or_subprocess_in_flight", 60_000)],
        silenceQuality: "inferred",
        silenceReasons: ["sampler_observed_time", "host_sleep_approximated"],
      }),
    ],
  };
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={analysis} />);
  assert.match(html, /host suspended/);
  assert.match(html, /tool\/subprocess in flight/);
  // Host suspension gets its own highlight; the other silence does not.
  assert.match(html, /border-amber-400\/40/);
  assert.match(html, /Silence is observational/);
});

test("missing cost and incomplete tokens render unavailable with coverage, never zero", () => {
  const base = completeFixture();
  const analysis: IssueExecutionAnalysis = {
    ...base,
    waste: {
      failedAttempts: 1,
      publishOnlyAttempts: 0,
      runtimeMs: covered(600_000, 1, 1),
      tokensIn: covered(12_000, 1, 2),
      tokensOut: covered(null, 0, 1),
      costUsd: covered(null, 0, 1),
    },
  };
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={analysis} />);
  assert.match(html, /Unavailable/);
  assert.match(html, /missing_provider_metadata/);
  assert.match(html, /known 1 of 2/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(html, /[^,\d]0 tokens/);
  assert.doesNotMatch(html, /[^,\d]0 ms/);
});

test("overlapping phases are unioned, never summed into a misleading total", () => {
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={completeFixture()} />);
  assert.match(html, /Exclusive phase total/);
  assert.match(html, /overlaps unioned, not summed/);
  assert.match(html, /never additive/);
});

test("silence copy is observational and never claims idle or hung", () => {
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={completeFixture()} />);
  assert.match(html, /[Ss]ilent/);
  assert.doesNotMatch(html, /idle/i);
  assert.doesNotMatch(html, /hung/i);
});

test("quality tiers are visible as text with tooltip reasons", () => {
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={completeFixture()} />);
  assert.match(html, /exact/);
  assert.match(html, /inferred/);
  assert.match(html, /Evidence quality/);
  assert.match(html, /sampler_observed_time/);
});

test("section wrapper opens in a labelled loading state before fetch resolves", () => {
  // useEffect never runs under static rendering, so the fetch is always pending.
  const html = renderToStaticMarkup(<ExecutionAnalysisSection issueId="issue-1" />);
  assert.match(html, /aria-labelledby="execution-analysis-heading"/);
  assert.match(html, /Execution analysis/);
  assert.match(html, /Loading execution analysis/);
});

test("narrow-screen layout uses wrapping and responsive containers", () => {
  const html = renderToStaticMarkup(<ExecutionAnalysisView analysis={failedRetryFixture()} />);
  assert.match(html, /flex-wrap/);
  assert.match(html, /aria-label/);
});
