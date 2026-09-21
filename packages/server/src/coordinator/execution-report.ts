// packages/server/src/coordinator/execution-report.ts
//
// NOT-175: fleet-level execution-comparison report behind GET /api/execution-report.
// (NOT-173 owns GET /api/execution-analysis; Fastify rejects duplicate routes.)
//
// Cohort scope comes from the shared NOT-173 predicates
// (resolveCohortWindow + listCohortIssueIds in
// read-models/execution-analysis.ts): issues whose execution started in the
// window (first workflow start, falling back to created_at) with the 365-day
// cap, and a status filter that matches issue status, session status, or
// workflow outcome. Success denominators, retry/reuse, coverage, and issue
// links are this endpoint's own (per-cohort coverage the NOT-173 cohort
// report does not carry). Phase wall time, however, is composed from the
// NOT-173 read model over the same in-scope issues, so P50/P95 follow GET
// /api/execution-analysis values exactly instead of a parallel derivation:
// exact boundaries when agent.started/agent.completed are recorded, inferred
// usage-envelope backfill otherwise, unavailable with reasons when neither
// exists — never zero, never a guess.
//
// Other inputs come only from sources the EXECUTION_ANALYSIS.md source matrix
// (§6) marks derivable today:
// - issues / worker_sessions / usage_events / human_actions columns (exact or
//   documented proxies);
// - worker.failed payloads + session errorJson for failure classification
//   (partial inference; ambiguous evidence stays `unknown`);
// - session started_at → completed_at as session wall time (inferred — session
//   bookkeeping, never CLI runtime) and usage duration_ms as spawn_envelope
//   (inferred, includes_spawn_slot_wait + includes_post_exit_work).
import {
  coverageSum,
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
import {
  composeIssueAnalysis,
  listCohortIssueIds,
  loadEvidenceForCohort,
  percentileStat as not173PercentileStat,
  resolveCohortWindow,
} from "../read-models/execution-analysis.js";
import type { AttemptAnalysis, CohortFilters } from "@agent-dealer/shared";

export const TERMINAL_SESSION_STATUSES = ["done", "failed", "timed_out", "cancelled"] as const;

export const REPORT_PHASES = [
  "queue_wait",
  "coordinator_setup",
  "agent_process",
  "coordinator_validation_publish",
] as const;

/**
 * Session-value predicate shared by the SQL scope and the NOT-173 attempt
 * selection below, so both agree. The literal "unknown" matches NULL/empty
 * (cohort rows label null runtime/model "unknown"); a null filter matches
 * everything.
 */
export function matchesSessionValue(value: string | null | undefined, filter: string | null): boolean {
  if (filter === null) return true;
  if (filter === "unknown") return value === null || value === "";
  return (value ?? "") === filter;
}

function attemptInScope(
  a: Pick<AttemptAnalysis, "role" | "runtime" | "model" | "status">,
  scope: { role: string | null; runtime: string | null; model: string | null; statuses: string[] }
): boolean {
  return (
    matchesSessionValue(a.role || null, scope.role) &&
    matchesSessionValue(a.runtime, scope.runtime) &&
    matchesSessionValue(a.model, scope.model) &&
    (scope.statuses.length === 0 || scope.statuses.includes(a.status ?? ""))
  );
}

/**
 * Phase wall time composed from the NOT-173 read model over the same
 * in-scope issues (never a parallel derivation, so P50/P95 follow GET
 * /api/execution-analysis values exactly). Queue wait is issue-level — read
 * from the unioned issue view so it is not multiplied by attempt count —
 * while setup/agent/validation phases aggregate the kept (filter-matching)
 * attempts. Each stat carries its own sample count and quality reasons.
 */
export function buildPhaseWallMs(
  issueIds: string[],
  scope: { role: string | null; runtime: string | null; model: string | null; statuses: string[] },
  hasAttemptFilter: boolean,
  now: number
): Array<{ phase: string; stat: PercentileStat }> {
  if (issueIds.length === 0) {
    // Same empty-cohort value the NOT-173 cohort report composes
    // (percentileStat over no observations), so the two agree exactly.
    return REPORT_PHASES.map((phase) => ({ phase, stat: not173PercentileStat([], []) }));
  }
  const evidence = loadEvidenceForCohort(issueIds, now);
  const analyses = issueIds.flatMap((id) => {
    const ev = evidence.get(id);
    return ev ? [composeIssueAnalysis(ev)] : [];
  });
  // Contributing issues: those with at least one kept attempt when any
  // attempt-level filter (role/runtime/model/status) is set, else every
  // in-scope issue (mirrors the NOT-173 cohort report's level/kept split).
  const level = hasAttemptFilter ? analyses.filter((a) => a.attempts.some((att) => attemptInScope(att, scope))) : analyses;
  const keptIssueIds = new Set(level.map((a) => a.issueId));
  const keptAttempts = level.flatMap((a) => a.attempts.filter((att) => attemptInScope(att, scope)));

  const queueValues: number[] = [];
  const queueInputs: Array<{ quality: "exact" | "inferred" | "unavailable"; reasons: string[] }> = [];
  for (const analysis of analyses.filter((a) => keptIssueIds.has(a.issueId))) {
    const q = analysis.unionedDurations.find((u) => u.phase === "queue_wait");
    if (q?.durationMs !== null && q?.durationMs !== undefined) {
      queueValues.push(q.durationMs);
      queueInputs.push({ quality: q.quality, reasons: q.reasons });
    }
  }
  const byPhase = (pick: (a: AttemptAnalysis) => { durationMs: number | null; quality: "exact" | "inferred" | "unavailable"; reasons: string[] }) => {
    const values: number[] = [];
    const inputs: Array<{ quality: "exact" | "inferred" | "unavailable"; reasons: string[] }> = [];
    for (const att of keptAttempts) {
      const iv = pick(att);
      if (iv.durationMs !== null) {
        values.push(iv.durationMs);
        inputs.push({ quality: iv.quality, reasons: iv.reasons });
      }
    }
    return not173PercentileStat(values, inputs);
  };
  return [
    { phase: "queue_wait", stat: not173PercentileStat(queueValues, queueInputs) },
    { phase: "coordinator_setup", stat: byPhase((a) => a.setup) },
    { phase: "agent_process", stat: byPhase((a) => a.agentProcess) },
    { phase: "coordinator_validation_publish", stat: byPhase((a) => a.validationPublish) },
  ];
}

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
  { re: /\bauth(?:entication|ori[sz]ation)?\b|unauthori[sz]ed|forbidden|not logged in|api key|keychain|credential|invalid_token|401\b|403\b/i, code: "authentication_configuration", domain: "infrastructure" },
  { re: /agent deck|deck unavailable|deck connection/i, code: "agent_deck_unavailable", domain: "infrastructure" },
  { re: /rate.?limit|429\b|capacity|overloaded|quota|usage cap|too many requests/i, code: "provider_capacity_rate_limit", domain: "infrastructure" },
  { re: /segfault|sigsegv|sigkill|sigabrt|\bspawn\b|enoent|econnreset|socket hang up|cli crash|process crashed/i, code: "agent_cli_crash", domain: "infrastructure" },
  { re: /coordinator crash|effect worker|heartbeat lost|\bleases?\b/i, code: "coordinator_crash", domain: "infrastructure" },
  { re: /validat|assertion|test fail|tests? fail|jest|vitest|pytest|changes_requested|change request|review found/i, code: "validation_failure", domain: "task" },
  { re: /\bpush\b|publish|pull request|\bpr\b|git fetch|git clone|merge conflict/i, code: "publish_git_failure", domain: "infrastructure" },
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

function isFailedStatus(status: string): boolean {
  return status === "failed" || status === "timed_out" || status === "cancelled";
}

/**
 * Retry waste: extra attempts within the same (issue, role, round) that follow
 * a terminal attempt. The first attempt in a group is never a retry; a second
 * attempt while the first is still running is overlap, not a retry. A reviewer
 * session alongside a developer session (or a second review round, which lands
 * in a new round) is normal workflow, not waste. The rate denominator is all
 * attempts in the same scope, stated wherever the rate is shown.
 */
export function countRetryExtras(sessions: SessionRow[]): number {
  const byGroup = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const key = `${s.issue_id}\u0000${s.role}\u0000${s.round}`;
    const list = byGroup.get(key) ?? [];
    list.push(s);
    byGroup.set(key, list);
  }
  let extra = 0;
  for (const group of byGroup.values()) {
    group.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    let sawTerminal = false;
    let first = true;
    for (const s of group) {
      if (!first && sawTerminal) extra += 1;
      first = false;
      if (isTerminal(s)) sawTerminal = true;
    }
  }
  return extra;
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
  const retryRate = acc.sessions.length > 0 ? countRetryExtras(acc.sessions) / acc.sessions.length : null;
  const failedSessions = acc.sessions.filter((s) => isFailedStatus(s.status));
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
    failedDurationMs: coverageSum(
      perSessionValues(failedSessions, usageBySession, (u) => u.duration_ms),
      "inferred",
      ["includes_spawn_slot_wait", "includes_post_exit_work"]
    ),
    failedTokensIn: coverageSum(perSessionValues(failedSessions, usageBySession, (u) => u.tokens_in)),
    failedTokensOut: coverageSum(perSessionValues(failedSessions, usageBySession, (u) => u.tokens_out)),
    failedCostUsd: coverageSum(perSessionValues(failedSessions, usageBySession, (u) => u.cost_usd)),
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
    failedDurationMs: emptyCoverage(),
    failedTokensIn: emptyCoverage(),
    failedTokensOut: emptyCoverage(),
    failedCostUsd: emptyCoverage(),
  };
}

const QUALITY_EXACT: EvidenceQuality = "exact";

export function buildExecutionReport(filters: ExecutionReportFilters, now: number = Date.now()): ExecutionReportResponse {
  const rawFrom = filters.from?.trim() || null;
  const rawTo = filters.to?.trim() || null;
  const rawFromMs = rawFrom === null ? NaN : Date.parse(rawFrom);
  const rawToMs = rawTo === null ? NaN : Date.parse(rawTo);
  if ((rawFrom !== null && !Number.isFinite(rawFromMs)) || (rawTo !== null && !Number.isFinite(rawToMs)) ||
    (rawFrom !== null && rawTo !== null && rawToMs < rawFromMs)) {
    throw new Error("Invalid date range: `from` and `to` must be ISO-8601 strings with from <= to");
  }
  const page = filters.page && filters.page >= 1 ? Math.floor(filters.page) : 1;
  const limit =
    filters.limit && filters.limit >= 1
      ? Math.min(Math.floor(filters.limit), EXECUTION_REPORT_MAX_LIMIT)
      : EXECUTION_REPORT_DEFAULT_LIMIT;

  const db = getDb();
  const statusSet = new Set((filters.status ?? []).map((s) => s.trim()).filter(Boolean));
  const sessionRole = filters.role?.trim() || null;
  const sessionRuntime = filters.runtime?.trim() || null;
  const sessionModel = filters.model?.trim() || null;
  const hasSessionFilter = sessionRole !== null || sessionRuntime !== null || sessionModel !== null;
  const repoFilter = filters.repo?.trim() || null;

  // Issue scope reuses the shared NOT-173 predicates: the conservative
  // default window with its 365-day cap (resolveCohortWindow), and cohort
  // membership by first workflow start with the status filter matching issue
  // status, session status, or workflow outcome (listCohortIssueIds). The
  // report accepts several statuses, so one shared call runs per status and
  // the results union — the same OR semantics as a single-status cohort call.
  // The literal "unknown" runtime/model filter matches NULL/empty sessions
  // (see matchesSessionValue), which the shared EXISTS predicate cannot
  // express, so it is stripped here and applied when sessions load below.
  const window = resolveCohortWindow(
    { from: rawFrom, to: rawTo, role: null, runtime: null, model: null, status: null, repo: null, limit: 50, offset: 0 },
    now
  );
  const from = window.fromIso;
  const to = window.toIso;
  const cohortFilterFor = (status: string | null): CohortFilters => ({
    from: null,
    to: null,
    role: sessionRole,
    runtime: sessionRuntime && sessionRuntime !== "unknown" ? sessionRuntime : null,
    model: sessionModel && sessionModel !== "unknown" ? sessionModel : null,
    status,
    repo: repoFilter,
    limit: 50,
    offset: 0,
  });
  const scopeIssueIds = new Set<string>();
  const scopeStatuses = statusSet.size === 0 ? [null] : [...statusSet];
  for (const status of scopeStatuses) {
    for (const id of listCohortIssueIds(cohortFilterFor(status), window).issueIds) {
      scopeIssueIds.add(id);
    }
  }

  // Display order stays newest-first by updated_at; the scope (population)
  // above is what feeds the phase percentiles.
  let windowIssues: IssueRow[] = [];
  if (scopeIssueIds.size > 0) {
    const ids = [...scopeIssueIds];
    const placeholders = ids.map(() => "?").join(",");
    windowIssues = (db
      .prepare(
        `SELECT id, title, status, repo, updated_at, current_round
         FROM issues WHERE id IN (${placeholders})
         ORDER BY updated_at DESC`
      )
      .all(...ids) as IssueRow[]);
  }
  const windowIssueIds = windowIssues.map((i) => i.id);

  // Sessions of those issues, narrowed by role/runtime/model.
  let sessions: SessionRow[] = [];
  if (windowIssueIds.length > 0) {
    const placeholders = windowIssueIds.map(() => "?").join(",");
    const sessionClauses: string[] = [`issue_id IN (${placeholders})`];
    const sessionArgs: unknown[] = [...windowIssueIds];
    if (sessionRole) {
      // Roles are never null; the literal "unknown" matches nothing here
      // (matchesSessionValue agrees, so phase selection stays consistent).
      sessionClauses.push(`role = ?`);
      sessionArgs.push(sessionRole);
    }
    if (sessionRuntime) {
      // Cohort rows label null runtime/model "unknown": the literal "unknown"
      // filter matches NULL/empty instead of returning nothing.
      sessionClauses.push(
        sessionRuntime === "unknown" ? `(runtime IS NULL OR runtime = '')` : `runtime = ?`
      );
      if (sessionRuntime !== "unknown") sessionArgs.push(sessionRuntime);
    }
    if (sessionModel) {
      sessionClauses.push(
        sessionModel === "unknown" ? `(model IS NULL OR model = '')` : `model = ?`
      );
      if (sessionModel !== "unknown") sessionArgs.push(sessionModel);
    }
    sessions = db
      .prepare(`SELECT * FROM worker_sessions WHERE ${sessionClauses.join(" AND ")} ORDER BY created_at ASC`)
      .all(...sessionArgs) as SessionRow[];
  }

  // When a session-level filter is set, the report scope is issues with at
  // least one matching session: summary.issues, issue success, the paginated
  // issue list, failure buckets, and reviewer/reuse aggregates must not mix
  // filtered attempt counts with unfiltered issue counts. Without a
  // session-level filter every window issue stays in scope (including issues
  // with zero sessions).
  let issues = windowIssues;
  if (hasSessionFilter) {
    const matching = new Set(sessions.map((s) => s.issue_id));
    issues = windowIssues.filter((i) => matching.has(i.id));
  }
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const issueIds = issues.map((i) => i.id);

  let usages: UsageRow[] = [];
  let failedPayloads: Array<{ issue_id: string; payload_json: string | null; ts: string }> = [];
  let humanActions: Array<{ issue_id: string; requested_at: string; resolved_at: string | null }> = [];
  let findingsCountByIssue = new Map<string, number>();
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length > 0) {
    const up = sessionIds.map(() => "?").join(",");
    usages = db
      .prepare(`SELECT worker_session_id, tokens_in, tokens_out, cost_usd, duration_ms FROM usage_events WHERE worker_session_id IN (${up})`)
      .all(...sessionIds) as UsageRow[];
  }
  if (issueIds.length > 0) {
    const ip = issueIds.map(() => "?").join(",");
    // worker.failed payloads carry issue_id, not session_id, so they cannot
    // be attributed to a matching session. Without a session-level filter
    // issue scope is the honest boundary; with one (role/runtime/model) the
    // payloads would leak failures from non-matching sessions into the
    // bucket (e.g. runtime=cursor_local reporting the Claude developer's
    // rate-limit failure while failed-waste shows no failed attempts), so
    // they are excluded and failures derive only from matching failed
    // sessions' error_json.
    if (!hasSessionFilter) {
      failedPayloads = db
        .prepare(
          `SELECT issue_id, payload_json, ts FROM workflow_events
           WHERE issue_id IN (${ip}) AND type = 'worker.failed' ORDER BY ts ASC`
        )
        .all(...issueIds) as Array<{ issue_id: string; payload_json: string | null; ts: string }>;
    }
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
  const failedSessions = sessions.filter((s) => isFailedStatus(s.status));

  // Primary failure per issue: latest worker.failed payload, else latest failed session error.
  const payloadByIssue = new Map<string, string | null>();
  for (const p of failedPayloads) payloadByIssue.set(p.issue_id, p.payload_json);
  const failedByIssue = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    if (isFailedStatus(s.status)) {
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

  // Phase wall time is composed from the NOT-173 read model over the same
  // in-scope issues with the same attempt predicate (role/runtime/model plus
  // the status filter, which NOT-173 also applies per attempt), so P50/P95
  // follow GET /api/execution-analysis values exactly.
  const phaseWallMs = buildPhaseWallMs(
    issueIds,
    { role: sessionRole, runtime: sessionRuntime, model: sessionModel, statuses: [...statusSet] },
    hasSessionFilter || statusSet.size > 0,
    now
  );

  const partialReasons: string[] = [];
  const usagesWithPartial = [...byRuntime, ...byModel].some(
    (r) => r.costUsd.reasons.includes("partial_sample") || r.tokensIn.reasons.includes("partial_sample")
  );
  if (usagesWithPartial) partialReasons.push("partial_sample: some cost/token aggregates exclude unavailable provider metadata");
  // Phase wall time is composed from the NOT-173 read model; phases without
  // exact boundaries report their own quality/reasons (inferred backfill or
  // unavailable) instead of a blanket unavailable row.
  for (const { phase, stat } of phaseWallMs) {
    if (stat.quality !== "exact" || stat.reasons.length > 0) {
      partialReasons.push(`phase_${phase}: ${stat.quality} (n=${stat.n}, ${stat.reasons.join(", ") || "no reasons"})`);
    }
  }

  const totalPages = Math.max(0, Math.ceil(issues.length / limit));
  const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const pageIssues = issues.slice((safePage - 1) * limit, safePage * limit);
  // Retry waste per (issue, role, round): extra attempts after a terminal
  // attempt. Rate denominator is all in-scope attempts.
  const retryExtraAttempts = countRetryExtras(sessions);

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
      retryRate: sessions.length > 0 ? retryExtraAttempts / sessions.length : null,
      retryExtraAttempts,
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
      phaseWallMs,
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
