// packages/server/src/coordinator/execution-report.ts
//
// NOT-175: fleet-level execution-comparison report behind GET /api/execution-analysis.
//
// Built only from sources the EXECUTION_ANALYSIS.md source matrix (§6) marks
// derivable today:
// - issues / worker_sessions / usage_events / human_actions columns (exact or
//   documented proxies);
// - worker.failed payloads + session errorJson for failure classification
//   (partial inference; ambiguous evidence stays `unknown`);
// - session started_at → completed_at as session wall time (inferred — session
//   bookkeeping, never CLI runtime) and usage duration_ms as spawn_envelope
//   (inferred, includes_spawn_slot_wait + includes_post_exit_work).
// Exclusive phase boundaries (agent.started / agent.completed / queue terminal
// timestamps) have no defensible proxy today, so every phase row is
// `unavailable` with n = 0 — never zero, never a guess.
import {
  coverageSum,
  defaultExecutionReportWindow,
  EXECUTION_REPORT_DEFAULT_LIMIT,
  EXECUTION_REPORT_MAX_LIMIT,
  nearestRankPercentiles,
  type CohortRow,
  type CoverageSum,
  type EvidenceQuality,
  type ExecutionFailureCode,
  type ExecutionFailureDomain,
  type ExecutionReportResponse,
  type FailureDistributionEntry,
  type PercentileStat,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { computeHumanWaitMs } from "./metrics.js";
import { parseErrorJsonReason } from "./failure-reason.js";

export const TERMINAL_SESSION_STATUSES = ["done", "failed", "timed_out", "cancelled"] as const;

const UNAVAILABLE_PHASES: Array<{ phase: string; reasons: string[] }> = [
  { phase: "queue_wait", reasons: ["missing_queue_terminal"] },
  { phase: "coordinator_setup", reasons: ["no_defensible_boundary"] },
  { phase: "agent_process", reasons: ["no_defensible_boundary"] },
  { phase: "coordinator_validation_publish", reasons: ["no_defensible_boundary"] },
];

export interface ExecutionReportFilters {
  from?: string;
  to?: string;
  repo?: string;
  role?: string;
  runtime?: string;
  model?: string;
  status?: string[];
  page?: number;
  limit?: number;
}

interface IssueRow {
  id: string;
  title: string;
  status: string;
  repo: string;
  updated_at: string;
  current_round: number;
}

interface SessionRow {
  id: string;
  issue_id: string;
  role: string;
  runtime: string | null;
  model: string | null;
  status: string;
  round: number;
  input_sha: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
}

interface UsageRow {
  worker_session_id: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Non-negative duration or null (negative ⇒ unavailable, never clamped). */
function durationMs(startIso: string | null, endIso: string | null): number | null {
  const s = toMs(startIso);
  const e = toMs(endIso);
  if (s === null || e === null || e < s) return null;
  return e - s;
}

function unavailableStat(reasons: string[]): PercentileStat {
  return { p50: null, p95: null, n: 0, quality: "unavailable", reasons };
}

function emptyCoverage(total = 0): CoverageSum {
  return {
    sum: null,
    known: 0,
    total,
    quality: "unavailable",
    reasons: total === 0 ? ["no_observations"] : ["missing_provider_metadata"],
  };
}

// --- Failure classification (contract §7; ambiguous evidence stays unknown) ---

const CLASSIFIERS: Array<{ re: RegExp; code: ExecutionFailureCode; domain: ExecutionFailureDomain }> = [
  { re: /auth|unauthori[sz]ed|forbidden|not logged in|api key|keychain|credential|invalid_token|401\b|403\b/i, code: "authentication_configuration", domain: "infrastructure" },
  { re: /agent deck|deck unavailable|deck connection/i, code: "agent_deck_unavailable", domain: "infrastructure" },
  { re: /rate.?limit|429\b|capacity|overloaded|quota|usage cap|too many requests/i, code: "provider_capacity_rate_limit", domain: "infrastructure" },
  { re: /segfault|sigsegv|sigkill|sigabrt|spawn|enoent|econnreset|socket hang up|cli crash|process crashed/i, code: "agent_cli_crash", domain: "infrastructure" },
  { re: /coordinator crash|effect worker|heartbeat lost|lease/i, code: "coordinator_crash", domain: "infrastructure" },
  { re: /validat|assertion|test fail|tests? fail|jest|vitest|pytest|changes_requested|change request|review found/i, code: "validation_failure", domain: "task" },
  { re: /push|publish|pull request|\bpr\b|git fetch|git clone|merge conflict/i, code: "publish_git_failure", domain: "infrastructure" },
  { re: /host sleep|suspend|sleep\/wake|liveness/i, code: "host_sleep_liveness", domain: "infrastructure" },
];

export function classifyFailureReason(reason: string | null | undefined): {
  code: ExecutionFailureCode;
  domain: ExecutionFailureDomain;
  confidence: "high" | "medium" | "low";
} {
  const text = (reason ?? "").trim();
  if (!text) return { code: "unknown", domain: "unknown", confidence: "low" };
  // A bare timeout with no tool/test in flight is unknown by rule — do not guess.
  if (/timed? ?out|deadline/i.test(text) && !/tool|test|jest|vitest|pytest|subprocess|command/i.test(text)) {
    return { code: "unknown", domain: "unknown", confidence: "low" };
  }
  if (/timed? ?out|deadline/i.test(text)) {
    return { code: "tool_test_timeout", domain: "task", confidence: "medium" };
  }
  for (const c of CLASSIFIERS) {
    if (c.re.test(text)) return { code: c.code, domain: c.domain, confidence: "medium" };
  }
  return { code: "unknown", domain: "unknown", confidence: "low" };
}

function parseFailedPayload(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const p = JSON.parse(payloadJson) as { reason?: unknown };
    return typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : null;
  } catch {
    return null;
  }
}

// --- Cohort aggregation ---

interface CohortAcc {
  key: string;
  issueIds: Set<string>;
  closedIssueIds: Set<string>;
  doneIssueIds: Set<string>;
  sessions: SessionRow[];
  usages: UsageRow[];
}

function newAcc(key: string): CohortAcc {
  return { key, issueIds: new Set(), closedIssueIds: new Set(), doneIssueIds: new Set(), sessions: [], usages: [] };
}

function sessionWallValues(sessions: SessionRow[]): Array<number | null> {
  return sessions.map((s) => durationMs(s.started_at, s.completed_at));
}

function checkpointValues(sessions: SessionRow[]): Array<number | null> {
  return sessions.map((s) => durationMs(s.started_at, s.heartbeat_at));
}

function isTerminal(s: SessionRow): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(s.status);
}

/**
 * Per-session values for value-metric coverage: one observation per session —
 * the sum of its known usage rows, or null when the session recorded nothing.
 * The coverage universe is sessions ("$4.20 over 3 of 5 sessions", §9.6), so a
 * session with no usage row counts toward `total`, never as zero.
 */
function perSessionValues(
  sessions: SessionRow[],
  usageBySession: Map<string, UsageRow[]>,
  pick: (u: UsageRow) => number | null | undefined
): Array<number | null> {
  return sessions.map((s) => {
    const known = (usageBySession.get(s.id) ?? [])
      .map(pick)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  });
}

function buildCohortRow(acc: CohortAcc, usageBySession: Map<string, UsageRow[]>): CohortRow {
  const terminal = acc.sessions.filter(isTerminal);
  const done = terminal.filter((s) => s.status === "done").length;
  const closedDen = acc.closedIssueIds.size;
  const issueSuccess = closedDen > 0 ? acc.doneIssueIds.size / closedDen : null;
  const attemptSuccess = terminal.length > 0 ? done / terminal.length : null;
  const distinctIssues = acc.issueIds.size;
  const retryRate = acc.sessions.length > 0 ? (acc.sessions.length - distinctIssues) / acc.sessions.length : null;
  return {
    key: acc.key,
    issues: distinctIssues,
    attempts: acc.sessions.length,
    issueSuccess,
    issueSuccessDenominator: closedDen,
    attemptSuccess,
    attemptSuccessDenominator: terminal.length,
    sessionWallMs: nearestRankPercentiles(sessionWallValues(acc.sessions), "inferred", ["session_bookkeeping_proxy"]),
    spawnEnvelopeMs: nearestRankPercentiles(
      acc.usages.map((u) => u.duration_ms),
      "inferred",
      ["includes_spawn_slot_wait", "includes_post_exit_work"]
    ),
    retryRate,
    tokensIn: coverageSum(perSessionValues(acc.sessions, usageBySession, (u) => u.tokens_in)),
    tokensOut: coverageSum(perSessionValues(acc.sessions, usageBySession, (u) => u.tokens_out)),
    costUsd: coverageSum(perSessionValues(acc.sessions, usageBySession, (u) => u.cost_usd)),
    durationMs: coverageSum(
      perSessionValues(acc.sessions, usageBySession, (u) => u.duration_ms),
      "inferred",
      ["includes_spawn_slot_wait", "includes_post_exit_work"]
    ),
  };
}

function emptyCohortRow(key: string): CohortRow {
  return {
    key,
    issues: 0,
    attempts: 0,
    issueSuccess: null,
    issueSuccessDenominator: 0,
    attemptSuccess: null,
    attemptSuccessDenominator: 0,
    sessionWallMs: unavailableStat(["no_observations"]),
    spawnEnvelopeMs: unavailableStat(["no_observations"]),
    retryRate: null,
    tokensIn: emptyCoverage(),
    tokensOut: emptyCoverage(),
    costUsd: emptyCoverage(),
    durationMs: emptyCoverage(),
  };
}

const QUALITY_EXACT: EvidenceQuality = "exact";

export function buildExecutionReport(filters: ExecutionReportFilters, now: number = Date.now()): ExecutionReportResponse {
  const win = defaultExecutionReportWindow(now);
  const from = filters.from?.trim() || win.from;
  const to = filters.to?.trim() || win.to;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    throw new Error("Invalid date range: `from` and `to` must be ISO-8601 strings with from <= to");
  }
  const page = filters.page && filters.page >= 1 ? Math.floor(filters.page) : 1;
  const limit =
    filters.limit && filters.limit >= 1
      ? Math.min(Math.floor(filters.limit), EXECUTION_REPORT_MAX_LIMIT)
      : EXECUTION_REPORT_DEFAULT_LIMIT;

  const db = getDb();
  const statusSet = new Set((filters.status ?? []).map((s) => s.trim()).filter(Boolean));

  // Issues active in the window: updated inside [from, to]. Repo/status narrow further.
  const issueRows = db
    .prepare(
      `SELECT id, title, status, repo, updated_at, current_round
       FROM issues WHERE updated_at >= ? AND updated_at <= ?
       ORDER BY updated_at DESC`
    )
    .all(from, to) as IssueRow[];
  const issues = issueRows.filter(
    (i) =>
      (!filters.repo?.trim() || i.repo === filters.repo.trim()) &&
      (statusSet.size === 0 || statusSet.has(i.status))
  );
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const issueIds = issues.map((i) => i.id);

  // Sessions of those issues, narrowed by role/runtime/model.
  let sessions: SessionRow[] = [];
  let usages: UsageRow[] = [];
  let failedPayloads: Array<{ issue_id: string; payload_json: string | null; ts: string }> = [];
  let humanActions: Array<{ issue_id: string; requested_at: string; resolved_at: string | null }> = [];
  let findingsCountByIssue = new Map<string, number>();
  if (issueIds.length > 0) {
    const placeholders = issueIds.map(() => "?").join(",");
    const sessionClauses: string[] = [`issue_id IN (${placeholders})`];
    const sessionArgs: unknown[] = [...issueIds];
    if (filters.role?.trim()) {
      sessionClauses.push(`role = ?`);
      sessionArgs.push(filters.role.trim());
    }
    if (filters.runtime?.trim()) {
      sessionClauses.push(`runtime = ?`);
      sessionArgs.push(filters.runtime.trim());
    }
    if (filters.model?.trim()) {
      sessionClauses.push(`model = ?`);
      sessionArgs.push(filters.model.trim());
    }
    sessions = db
      .prepare(`SELECT * FROM worker_sessions WHERE ${sessionClauses.join(" AND ")} ORDER BY created_at ASC`)
      .all(...sessionArgs) as SessionRow[];
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      const up = sessionIds.map(() => "?").join(",");
      usages = db
        .prepare(`SELECT worker_session_id, tokens_in, tokens_out, cost_usd, duration_ms FROM usage_events WHERE worker_session_id IN (${up})`)
        .all(...sessionIds) as UsageRow[];
    }
    const ip = issueIds.map(() => "?").join(",");
    failedPayloads = db
      .prepare(
        `SELECT issue_id, payload_json, ts FROM workflow_events
         WHERE issue_id IN (${ip}) AND type = 'worker.failed' ORDER BY ts ASC`
      )
      .all(...issueIds) as Array<{ issue_id: string; payload_json: string | null; ts: string }>;
    humanActions = db
      .prepare(`SELECT issue_id, requested_at, resolved_at FROM human_actions WHERE issue_id IN (${ip})`)
      .all(...issueIds) as Array<{ issue_id: string; requested_at: string; resolved_at: string | null }>;
    const findingRows = db
      .prepare(`SELECT issue_id, COUNT(*) as n FROM findings WHERE issue_id IN (${ip}) GROUP BY issue_id`)
      .all(...issueIds) as Array<{ issue_id: string; n: number }>;
    findingsCountByIssue = new Map(findingRows.map((r) => [r.issue_id, r.n]));
  }

  const usageBySession = new Map<string, UsageRow[]>();
  for (const u of usages) {
    const list = usageBySession.get(u.worker_session_id) ?? [];
    list.push(u);
    usageBySession.set(u.worker_session_id, list);
  }
  const sessionsByIssue = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = sessionsByIssue.get(s.issue_id) ?? [];
    list.push(s);
    sessionsByIssue.set(s.issue_id, list);
  }

  const terminalSessions = sessions.filter(isTerminal);
  const doneSessions = terminalSessions.filter((s) => s.status === "done").length;
  const closedIssues = issues.filter((i) => i.status === "done" || i.status === "closed");
  const doneIssues = issues.filter((i) => i.status === "done").length;

  // Human wait: union per issue (exact), summed across issues.
  let humanWaitMs = 0;
  const actionsByIssue = new Map<string, Array<{ requestedAt: string; resolvedAt: string | null }>>();
  for (const a of humanActions) {
    const list = actionsByIssue.get(a.issue_id) ?? [];
    list.push({ requestedAt: a.requested_at, resolvedAt: a.resolved_at });
    actionsByIssue.set(a.issue_id, list);
  }
  for (const list of actionsByIssue.values()) {
    humanWaitMs += computeHumanWaitMs(
      list.map((a, idx) => ({
        id: `report-${idx}`,
        issueId: null,
        runId: null,
        workflowInstanceId: null,
        actionType: "policy_escalation",
        reason: "",
        question: "",
        evidenceJson: null,
        responseOptionsJson: null,
        continuationPreviewJson: null,
        requestId: null,
        status: a.resolvedAt ? ("resolved" as const) : ("open" as const),
        resolutionJson: null,
        resolvedBy: null,
        requestedAt: a.requestedAt,
        resolvedAt: a.resolvedAt,
      })),
      now
    );
  }

  // Reviewer rounds: max reviewer round per issue with reviewer sessions.
  let roundsSum = 0;
  let reviewedIssues = 0;
  let changeRequestedIssues = 0;
  for (const issue of issues) {
    const reviewerRounds = (sessionsByIssue.get(issue.id) ?? [])
      .filter((s) => s.role === "reviewer")
      .map((s) => s.round);
    if (reviewerRounds.length === 0) continue;
    reviewedIssues += 1;
    const maxRound = Math.max(...reviewerRounds);
    roundsSum += maxRound;
    if (maxRound > 1 || (findingsCountByIssue.get(issue.id) ?? 0) > 0) changeRequestedIssues += 1;
  }

  // Reuse: reviewer sessions whose input_sha re-verifies an earlier session's sha.
  const reviewerWithSha = sessions.filter((s) => s.role === "reviewer" && s.input_sha);
  let reused = 0;
  for (const issue of issues) {
    const ordered = [...(sessionsByIssue.get(issue.id) ?? [])].sort((a, b) =>
      a.created_at < b.created_at ? -1 : 1
    );
    const seen = new Set<string>();
    for (const s of ordered) {
      if (s.role === "reviewer" && s.input_sha) {
        if (seen.has(s.input_sha)) reused += 1;
      }
      if (s.input_sha) seen.add(s.input_sha);
    }
  }

  // Failed-attempt waste: usage of failed/timed_out/cancelled sessions (known only).
  const failedSessions = sessions.filter(
    (s) => s.status === "failed" || s.status === "timed_out" || s.status === "cancelled"
  );

  // Primary failure per issue: latest worker.failed payload, else latest failed session error.
  const payloadByIssue = new Map<string, string | null>();
  for (const p of failedPayloads) payloadByIssue.set(p.issue_id, p.payload_json);
  const failedByIssue = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    if (s.status === "failed" || s.status === "timed_out" || s.status === "cancelled") {
      const list = failedByIssue.get(s.issue_id) ?? [];
      list.push(s);
      failedByIssue.set(s.issue_id, list);
    }
  }
  const failureCounts = new Map<ExecutionFailureCode, { domain: ExecutionFailureDomain; issueIds: string[] }>();
  const failedIssueIds = new Set<string>([...payloadByIssue.keys(), ...failedByIssue.keys()]);
  for (const issueId of failedIssueIds) {
    const reason =
      parseFailedPayload(payloadByIssue.get(issueId) ?? null) ??
      parseErrorJsonReason(
        [...(failedByIssue.get(issueId) ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]?.error_json ??
          null
      );
    const { code, domain } = classifyFailureReason(reason);
    const entry = failureCounts.get(code) ?? { domain, issueIds: [] };
    entry.issueIds.push(issueId);
    failureCounts.set(code, entry);
  }
  const failedTotal = failedIssueIds.size;
  const failures: FailureDistributionEntry[] = [...failureCounts.entries()]
    .map(([code, v]) => ({
      code,
      domain: v.domain,
      count: v.issueIds.length,
      share: failedTotal > 0 ? v.issueIds.length / failedTotal : null,
      issueIds: v.issueIds.slice(0, 10),
      issueTotal: v.issueIds.length,
    }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));

  // Cohort rows. No cost-based ranking: rows sort by key; incomplete coverage is
  // shown as Unavailable / N/M known, never as zero.
  const byKey = (pick: (s: SessionRow) => string | null): CohortRow[] => {
    const accs = new Map<string, CohortAcc>();
    for (const s of sessions) {
      const key = pick(s) ?? "unknown";
      const acc = accs.get(key) ?? newAcc(key);
      accs.set(key, acc);
      acc.sessions.push(s);
      acc.issueIds.add(s.issue_id);
      const issue = issueById.get(s.issue_id);
      if (issue && (issue.status === "done" || issue.status === "closed")) acc.closedIssueIds.add(s.issue_id);
      if (issue && issue.status === "done") acc.doneIssueIds.add(s.issue_id);
      for (const u of usageBySession.get(s.id) ?? []) acc.usages.push(u);
    }
    return [...accs.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((acc) => buildCohortRow(acc, usageBySession));
  };
  const byRole = byKey((s) => s.role || null);
  const byRuntime = byKey((s) => s.runtime);
  const byModel = byKey((s) => s.model || null);
  const roleKeys = new Set(byRole.map((r) => r.key));
  for (const role of ["developer", "reviewer", "legacy"]) {
    if (!roleKeys.has(role) && (!filters.role?.trim() || filters.role.trim() === role)) {
      byRole.push(emptyCohortRow(role));
    }
  }
  byRole.sort((a, b) => (a.key < b.key ? -1 : 1));

  const partialReasons: string[] = [];
  const usagesWithPartial = [...byRuntime, ...byModel].some(
    (r) => r.costUsd.reasons.includes("partial_sample") || r.tokensIn.reasons.includes("partial_sample")
  );
  if (usagesWithPartial) partialReasons.push("partial_sample: some cost/token aggregates exclude unavailable provider metadata");
  partialReasons.push(
    "phase_unavailable: queue_wait, coordinator_setup, agent_process, and coordinator_validation_publish boundaries are not defensible today (no_defensible_boundary / missing_queue_terminal)"
  );

  const totalPages = Math.max(0, Math.ceil(issues.length / limit));
  const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const pageIssues = issues.slice((safePage - 1) * limit, safePage * limit);
  const distinctSessionIssues = new Set(sessions.map((s) => s.issue_id)).size;

  return {
    window: { from, to },
    filters: {
      repo: filters.repo?.trim() || null,
      role: filters.role?.trim() || null,
      runtime: filters.runtime?.trim() || null,
      model: filters.model?.trim() || null,
      status: [...statusSet],
    },
    summary: {
      issues: issues.length,
      closedIssues: closedIssues.length,
      issueSuccess: closedIssues.length > 0 ? doneIssues / closedIssues.length : null,
      attempts: sessions.length,
      terminalAttempts: terminalSessions.length,
      attemptSuccess: terminalSessions.length > 0 ? doneSessions / terminalSessions.length : null,
      retryRate: sessions.length > 0 ? (sessions.length - distinctSessionIssues) / sessions.length : null,
      retryExtraAttempts: Math.max(0, sessions.length - distinctSessionIssues),
      reuseRate: reviewerWithSha.length > 0 ? reused / reviewerWithSha.length : null,
      reuseDenominator: reviewerWithSha.length,
      humanWaitMs,
      humanWaitQuality: QUALITY_EXACT,
      interventions: humanActions.length,
      avgReviewerRounds: reviewedIssues > 0 ? roundsSum / reviewedIssues : null,
      reviewedIssues,
      changeRequestRate: reviewedIssues > 0 ? changeRequestedIssues / reviewedIssues : null,
      sessionWallMs: nearestRankPercentiles(sessionWallValues(sessions), "inferred", ["session_bookkeeping_proxy"]),
      spawnEnvelopeMs: nearestRankPercentiles(
        usages.map((u) => u.duration_ms),
        "inferred",
        ["includes_spawn_slot_wait", "includes_post_exit_work"]
      ),
      checkpointMs: nearestRankPercentiles(checkpointValues(sessions), "inferred", ["heartbeat_proxy"]),
      phaseWallMs: UNAVAILABLE_PHASES.map(({ phase, reasons }) => ({ phase, stat: unavailableStat(reasons) })),
      failedDurationMs: coverageSum(
        perSessionValues(failedSessions, usageBySession, (u) => u.duration_ms),
        "inferred",
        ["includes_spawn_slot_wait", "includes_post_exit_work"]
      ),
      failedTokensIn: coverageSum(perSessionValues(failedSessions, usageBySession, (u) => u.tokens_in)),
      failedTokensOut: coverageSum(perSessionValues(failedSessions, usageBySession, (u) => u.tokens_out)),
      failedCostUsd: coverageSum(perSessionValues(failedSessions, usageBySession, (u) => u.cost_usd)),
    },
    byRole,
    byRuntime,
    byModel,
    failures,
    issues: pageIssues.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      repo: i.repo,
      attempts: sessionsByIssue.get(i.id)?.length ?? 0,
      updatedAt: i.updated_at,
    })),
    pagination: { page: safePage, limit, total: issues.length, totalPages },
    meta: {
      generatedAt: new Date(now).toISOString(),
      partial: partialReasons.length > 0,
      partialReasons,
    },
  };
}
