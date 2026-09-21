// packages/server/src/read-models/execution-analysis.ts
//
// NOT-173: the dedicated read-model/service layer for issue-level explanations
// and fleet-level runtime/model comparison (epic NOT-161, contract
// docs/EXECUTION_ANALYSIS.md). Fastify routes call into here; no composition
// lives in the routes.
//
// Pure helpers (union, nearest-rank, covered aggregates, reviewer derivation)
// are exported for unit tests. DB composition is batched: one query per table
// per issue (or per cohort chunk with IN), never one query per issue/session —
// see the query helpers below and the EXPLAIN QUERY PLAN assertions in the
// route tests.
import type {
  AttemptAnalysis,
  CohortExecutionReport,
  CohortFilters,
  CohortSliceStat,
  CoveredTotal,
  ExecutionQuality,
  FirstCheckpointView,
  IssueExecutionAnalysis,
  NestedInterval,
  PercentileStat,
  PhaseInterval,
  RateStat,
  RetryReuseView,
  ReviewerView,
  UnionedPhaseDuration,
} from "@agent-dealer/shared";
import {
  DEFAULT_COHORT_WINDOW_DAYS,
  MAX_COHORT_WINDOW_DAYS,
} from "@agent-dealer/shared";
import type { FailureCause } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { deriveAttemptIntervals, type BoundaryEvent } from "../coordinator/execution-intervals.js";
import { deriveQueueHistory, type QueueHistoryEvent, type QueueHistoryRow } from "../coordinator/queue-history.js";
import {
  deriveAttemptWaste,
  deriveFirstCheckpoint,
  deriveRetrySummary,
  type AgentBoundary,
  type CheckpointRecord,
  type ReuseRecord,
  type WasteSession,
  type WasteUsage,
} from "../coordinator/attempt-waste.js";
import { deriveSilenceIntervals, type SilenceActivityPoint, type SleepWindow } from "../coordinator/session-silence.js";
import { CheckpointObservedPayload, RetryReusedPayload } from "@agent-dealer/shared";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface Range { start: number; end: number; }

/** Union half-open [start, end) ranges. Adjacent ranges merge (same union length). */
export function unionRanges(ranges: Range[]): Range[] {
  const valid = ranges.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  valid.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/** Length of the union of half-open ranges — overlapping evidence is not double-counted. */
export function unionDurationMs(ranges: Range[]): number {
  return unionRanges(ranges).reduce((sum, r) => sum + (r.end - r.start), 0);
}

/** Nearest-rank percentile (§3 rule 6): sort ascending, rank = ceil(p/100 · n).
 * Null observations are never in the input — callers filter them first. */
export function nearestRank(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((pct / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

const QUALITY_RANK: Record<ExecutionQuality, number> = { exact: 0, inferred: 1, unavailable: 2 };
const RANK_QUALITY: ExecutionQuality[] = ["exact", "inferred", "unavailable"];

/** Weakest quality among the known inputs that were included (§4). */
export function weakestQuality(inputs: Array<{ quality: ExecutionQuality; reasons: string[] }>): {
  quality: ExecutionQuality;
  reasons: string[];
} {
  if (inputs.length === 0) return { quality: "unavailable", reasons: ["missing_provider_metadata"] };
  let worst = 0;
  const reasons = new Set<string>();
  for (const input of inputs) {
    worst = Math.max(worst, QUALITY_RANK[input.quality] ?? 2);
    for (const r of input.reasons) reasons.add(r);
  }
  return { quality: RANK_QUALITY[worst]!, reasons: [...reasons] };
}

/** Sum over known values only, with known/total completeness (§4). */
export function coveredTotal(values: Array<number | null | undefined>, opts?: { missingReason?: string }): CoveredTotal {
  const known = values.filter((v): v is number => v != null && Number.isFinite(v));
  const total = values.length;
  if (known.length === 0) {
    return { value: null, quality: "unavailable", reasons: [opts?.missingReason ?? "missing_provider_metadata"], known: 0, total };
  }
  const reasons = known.length < total ? ["partial_sample"] : [];
  return {
    value: known.reduce((a, b) => a + b, 0),
    quality: "exact",
    reasons,
    known: known.length,
    total,
  };
}

/** Percentile stat over comparable non-null observations with sample count. */
export function percentileStat(
  values: Array<number | null | undefined>,
  inputs?: Array<{ quality: ExecutionQuality; reasons: string[] }>,
): PercentileStat {
  const known = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (known.length === 0) {
    return { p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["missing_provider_metadata"] };
  }
  const { quality, reasons } = inputs ? weakestQuality(inputs) : { quality: "exact" as ExecutionQuality, reasons: [] as string[] };
  const finalReasons = known.length < values.length && !reasons.includes("partial_sample")
    ? [...reasons, "partial_sample"]
    : reasons;
  return { p50: nearestRank(known, 50), p95: nearestRank(known, 95), n: known.length, quality, reasons: finalReasons };
}

export function rateStat(numerator: number, denominator: number, opts?: { unavailableReason?: string }): RateStat {
  if (denominator <= 0) {
    return { numerator, denominator, rate: null, quality: "unavailable", reasons: [opts?.unavailableReason ?? "missing_provider_metadata"] };
  }
  return { numerator, denominator, rate: numerator / denominator, quality: "exact", reasons: [] };
}

export interface ReviewerEvidence {
  reviewerSessionCount: number;
  /** Parsed review.submitted verdict payloads (defensive: verdict may be absent). */
  verdicts: Array<{ verdict?: unknown }>;
}

export function deriveReviewerView(evidence: ReviewerEvidence): ReviewerView {
  const verdicts = evidence.verdicts.length;
  const changeRequests = evidence.verdicts.filter((v) => v.verdict === "changes_requested").length;
  if (verdicts > 0) {
    return {
      rounds: evidence.reviewerSessionCount,
      verdicts,
      changeRequests,
      changeRequestRate: changeRequests / verdicts,
      quality: "exact",
      reasons: [],
    };
  }
  if (evidence.reviewerSessionCount > 0) {
    return {
      rounds: evidence.reviewerSessionCount,
      verdicts: 0,
      changeRequests: 0,
      changeRequestRate: null,
      quality: "inferred",
      reasons: ["backfill"],
    };
  }
  return {
    rounds: 0,
    verdicts: 0,
    changeRequests: 0,
    changeRequestRate: null,
    quality: "unavailable",
    reasons: ["missing_provider_metadata"],
  };
}

function msOf(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function toPhaseInterval(
  phase: PhaseInterval["phase"],
  startMs: number | null,
  endMs: number | null,
  quality: ExecutionQuality,
  reasons: string[],
  sessionId: string | null = null,
  cursors?: { startCursor: number | null; endCursor: number | null },
): PhaseInterval {
  const durationMs = startMs != null && endMs != null
    ? endMs < startMs ? null : endMs - startMs
    : null;
  const q: ExecutionQuality = durationMs === null && quality !== "unavailable" && (startMs == null || endMs == null)
    ? quality
    : durationMs === null && startMs != null && endMs != null
      ? "unavailable"
      : quality;
  const r = [...reasons];
  if (durationMs === null && startMs != null && endMs != null && !r.includes("negative_duration")) r.push("negative_duration");
  return {
    phase,
    startMs,
    endMs,
    durationMs,
    quality: q,
    reasons: r,
    sessionId,
    startCursor: cursors?.startCursor ?? null,
    endCursor: cursors?.endCursor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Batched evidence loading — one query per table per issue set.
//
// Every loader takes an array of issue ids and returns rows grouped by issue
// id, so the cohort path issues a constant number of queries per chunk no
// matter how many issues or sessions the cohort holds (see
// loadEvidenceForCohort). EXPLAIN QUERY PLAN for each statement must show
// index use (asserted in the route tests); the supporting indexes live in
// db/schema.sql.
// ---------------------------------------------------------------------------

export interface IssueEventRow {
  issueId: string;
  sessionId: string | null;
  type: string;
  ts: string;
  cursor: number;
  payloadJson: string | null;
}

export interface SessionRow {
  id: string;
  issueId: string;
  role: string;
  round: number;
  runtime: string | null;
  model: string | null;
  status: string;
  errorJson: string | null;
  createdAt: string;
}

export interface UsageRow {
  issueId: string;
  workerSessionId: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  ts: string;
}

export interface HumanActionRow {
  issueId: string;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface FailureCauseRow extends FailureCause {
  issueId: string;
}

export interface ActivityRow {
  issueId: string;
  workerSessionId: string;
  observedAt: string;
  activityKind: string;
  callId: string | null;
}

export interface QueueEntryRow {
  issueId: string;
  id: string;
  enqueuedAt: string;
  state: string;
}

export interface WorkflowInstanceRow {
  issueId: string;
  startedAt: string;
  completedAt: string | null;
  outcome: string | null;
}

export interface IssueMetaRow {
  id: string;
  repo: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function inList(ids: string[]): string {
  return `(${ids.map(() => "?").join(",")})`;
}

/** All workflow events for a set of issues in durable (ts, rowid) order. */
export function loadEventsForIssues(issueIds: string[]): Map<string, IssueEventRow[]> {
  const out = new Map<string, IssueEventRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, worker_session_id AS sessionId, type, ts, rowid AS cursor, payload_json AS payloadJson
       FROM workflow_events WHERE issue_id IN ${inList(issueIds)} ORDER BY ts ASC, rowid ASC`
    )
    .all(...issueIds) as IssueEventRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

/** All worker sessions for a set of issues, oldest first. */
export function loadSessionsForIssues(issueIds: string[]): Map<string, SessionRow[]> {
  const out = new Map<string, SessionRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT id, issue_id AS issueId, role, round, runtime, model, status, error_json AS errorJson, created_at AS createdAt
       FROM worker_sessions WHERE issue_id IN ${inList(issueIds)} ORDER BY created_at ASC, id ASC`
    )
    .all(...issueIds) as SessionRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

/** All usage events for a set of issues. */
export function loadUsageForIssues(issueIds: string[]): Map<string, UsageRow[]> {
  const out = new Map<string, UsageRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, worker_session_id AS workerSessionId, tokens_in AS tokensIn,
              tokens_out AS tokensOut, cost_usd AS costUsd, duration_ms AS durationMs, ts
       FROM usage_events WHERE issue_id IN ${inList(issueIds)} ORDER BY ts ASC`
    )
    .all(...issueIds) as UsageRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

/** All human actions for a set of issues. */
export function loadHumanActionsForIssues(issueIds: string[]): Map<string, HumanActionRow[]> {
  const out = new Map<string, HumanActionRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, requested_at AS requestedAt, resolved_at AS resolvedAt
       FROM human_actions WHERE issue_id IN ${inList(issueIds)} ORDER BY requested_at ASC`
    )
    .all(...issueIds) as HumanActionRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

/** All recorded failure causes for a set of issues. */
export function loadFailureCausesForIssues(issueIds: string[]): Map<string, FailureCauseRow[]> {
  const out = new Map<string, FailureCauseRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, worker_session_id AS sessionId, workflow_event_id AS eventId,
              event_cursor AS eventCursor, code, domain, primary_flag AS primaryFlag, confidence,
              evidence_source AS evidenceSource, occurred_at AS occurredAt, raw_reason AS rawReason,
              log_path AS logPath, quality
       FROM failure_causes WHERE issue_id IN ${inList(issueIds)}`
    )
    .all(...issueIds) as Array<FailureCauseRow & { primaryFlag: number }>;
  for (const row of rows) {
    const { primaryFlag, issueId, ...rest } = row;
    out.get(issueId)?.push({ ...rest, issueId, primary: primaryFlag === 1, eventType: null });
  }
  return out;
}

/** All persisted session-activity rows for a set of issues. */
export function loadActivityForIssues(issueIds: string[]): Map<string, ActivityRow[]> {
  const out = new Map<string, ActivityRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, worker_session_id AS workerSessionId, observed_at AS observedAt,
              activity_kind AS activityKind, call_id AS callId
       FROM session_activity_events WHERE issue_id IN ${inList(issueIds)} ORDER BY observed_at ASC`
    )
    .all(...issueIds) as ActivityRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

/** All queue-entry rows for a set of issues. */
export function loadQueueRowsForIssues(issueIds: string[]): Map<string, QueueEntryRow[]> {
  const out = new Map<string, QueueEntryRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, id, enqueued_at AS enqueuedAt, state
       FROM queue_entries WHERE issue_id IN ${inList(issueIds)} ORDER BY enqueued_at ASC`
    )
    .all(...issueIds) as QueueEntryRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

/** All workflow instances for a set of issues, oldest first. */
export function loadInstancesForIssues(issueIds: string[]): Map<string, WorkflowInstanceRow[]> {
  const out = new Map<string, WorkflowInstanceRow[]>();
  if (issueIds.length === 0) return out;
  for (const id of issueIds) out.set(id, []);
  const rows = getDb()
    .prepare(
      `SELECT issue_id AS issueId, started_at AS startedAt, completed_at AS completedAt, outcome
       FROM workflow_instances WHERE issue_id IN ${inList(issueIds)} ORDER BY started_at ASC`
    )
    .all(...issueIds) as WorkflowInstanceRow[];
  for (const row of rows) out.get(row.issueId)?.push(row);
  return out;
}

export interface IssueEvidence {
  issueId: string;
  events: IssueEventRow[];
  sessions: SessionRow[];
  usages: UsageRow[];
  humanActions: HumanActionRow[];
  failureCauses: FailureCauseRow[];
  activities: ActivityRow[];
  queueRows: QueueEntryRow[];
  instances: WorkflowInstanceRow[];
  nowMs: number;
}

export function loadIssueEvidence(issueId: string, nowMs = Date.now()): IssueEvidence {
  const get = <T>(m: Map<string, T[]>): T[] => m.get(issueId) ?? [];
  return {
    issueId,
    events: get(loadEventsForIssues([issueId])),
    sessions: get(loadSessionsForIssues([issueId])),
    usages: get(loadUsageForIssues([issueId])),
    humanActions: get(loadHumanActionsForIssues([issueId])),
    failureCauses: get(loadFailureCausesForIssues([issueId])),
    activities: get(loadActivityForIssues([issueId])),
    queueRows: get(loadQueueRowsForIssues([issueId])),
    instances: get(loadInstancesForIssues([issueId])),
    nowMs,
  };
}

// ---------------------------------------------------------------------------
// Issue composition — pure over preloaded IssueEvidence, so fixtures can drive
// it without a database.
// ---------------------------------------------------------------------------

function parsePayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // malformed evidence never drives metrics
  }
  return {};
}

/** Sleep windows from durable host.suspended payloads, mirroring
 * repository/session-activity.ts: [detectedAt − suspendedMs, detectedAt). */
function sleepWindowsFromEvents(events: IssueEventRow[]): { windows: SleepWindow[]; approximated: boolean } {
  const windows: SleepWindow[] = [];
  let approximated = false;
  for (const event of events) {
    if (event.type !== "host.suspended") continue;
    const payload = parsePayload(event.payloadJson);
    const detected = typeof payload.detectedAt === "string" ? Date.parse(payload.detectedAt) : NaN;
    const unelapsed = typeof payload.unelapsedMs === "number" ? payload.unelapsedMs : NaN;
    const wallGap = typeof payload.wallGapMs === "number" ? payload.wallGapMs : NaN;
    const suspendedMs =
      Number.isFinite(unelapsed) && unelapsed > 0
        ? unelapsed
        : Number.isFinite(wallGap) && wallGap > 0
          ? wallGap
          : NaN;
    if (!Number.isFinite(detected) || !Number.isFinite(suspendedMs) || suspendedMs <= 0) continue;
    if (!(Number.isFinite(unelapsed) && unelapsed > 0)) approximated = true;
    windows.push({ startMs: detected - suspendedMs, endMs: detected });
  }
  return { windows, approximated };
}

function toBoundaryEvents(events: IssueEventRow[]): BoundaryEvent[] {
  return events.map((e) => ({ type: e.type, ts: e.ts, rowid: e.cursor }));
}

function cursorOf(events: IssueEventRow[], type: string, first = true): number | null {
  const found = events.filter((e) => e.type === type);
  if (found.length === 0) return null;
  const pick = first ? found[0]! : found[found.length - 1]!;
  return pick.cursor;
}

function parseCheckpointRecord(event: IssueEventRow): CheckpointRecord | null {
  if (!event.payloadJson) return null;
  const parsed = CheckpointObservedPayload.safeParse(parsePayload(event.payloadJson));
  if (!parsed.success) return null;
  return {
    sessionId: event.sessionId,
    kind: parsed.data.kind,
    observedSha: parsed.data.observedSha,
    observedAt: parsed.data.observedAt,
    origin: parsed.data.origin,
    inputSha: parsed.data.inputSha,
    samplingPrecisionMs: parsed.data.samplingPrecisionMs,
    branch: parsed.data.branch,
    ts: event.ts,
    cursor: event.cursor,
  };
}

function parseReuseRecord(event: IssueEventRow): ReuseRecord | null {
  if (!event.payloadJson || !event.sessionId) return null;
  const parsed = RetryReusedPayload.safeParse(parsePayload(event.payloadJson));
  if (!parsed.success) return null;
  return { sessionId: event.sessionId, kinds: parsed.data.kinds, retryReason: parsed.data.retryReason, ts: event.ts, cursor: event.cursor };
}

function orderCauses(causes: FailureCauseRow[]): FailureCauseRow[] {
  return [...causes].sort((a, b) => {
    const ta = msOf(a.occurredAt) ?? Number.POSITIVE_INFINITY;
    const tb = msOf(b.occurredAt) ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return (a.eventCursor ?? Number.POSITIVE_INFINITY) - (b.eventCursor ?? Number.POSITIVE_INFINITY);
  });
}

export function composeIssueAnalysis(ev: IssueEvidence): IssueExecutionAnalysis {
  const bySession = new Map<string, IssueEventRow[]>();
  for (const event of ev.events) {
    if (!event.sessionId) continue;
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }
  const usageBySession = new Map<string, UsageRow[]>();
  for (const usage of ev.usages) {
    const list = usageBySession.get(usage.workerSessionId) ?? [];
    list.push(usage);
    usageBySession.set(usage.workerSessionId, list);
  }
  const activityBySession = new Map<string, ActivityRow[]>();
  for (const row of ev.activities) {
    const list = activityBySession.get(row.workerSessionId) ?? [];
    list.push(row);
    activityBySession.set(row.workerSessionId, list);
  }

  // Workflow elapsed: first start → last completion (or now while active).
  const firstStart = ev.instances.length > 0 ? ev.instances[0]!.startedAt : null;
  const lastInstance = ev.instances.length > 0 ? ev.instances[ev.instances.length - 1]! : null;
  const elapsed: PhaseInterval = (() => {
    const s = msOf(firstStart);
    if (s === null) {
      return toPhaseInterval("queue_wait", null, null, "unavailable", ["missing_workflow_instance"]);
    }
    if (lastInstance?.completedAt) {
      const e = msOf(lastInstance.completedAt);
      return toPhaseInterval("queue_wait", s, e, e !== null && e >= s ? "exact" : "unavailable", e !== null && e >= s ? [] : ["negative_duration"]);
    }
    return toPhaseInterval("queue_wait", s, ev.nowMs, "inferred", ["open_interval"]);
  })();
  const elapsedView: PhaseInterval = { ...elapsed, phase: "queue_wait" };

  // Queue waits + nested admission/preflight drill-down.
  const queueEvents: QueueHistoryEvent[] = ev.events
    .filter((e) => e.type.startsWith("queue."))
    .map((e) => ({ cursor: e.cursor, ts: e.ts, type: e.type, payload: parsePayload(e.payloadJson) as QueueHistoryEvent["payload"] }));
  const queueRows: QueueHistoryRow[] = ev.queueRows.map((r) => ({ id: r.id, enqueuedAt: r.enqueuedAt, state: r.state }));
  const queueHistory = deriveQueueHistory(queueEvents, queueRows);

  const rawIntervals: PhaseInterval[] = [];
  for (const wait of queueHistory.queueWaits) {
    const s = msOf(wait.start);
    const e = wait.end ? msOf(wait.end) : null;
    if (wait.end == null) {
      rawIntervals.push(toPhaseInterval("queue_wait", s, null, wait.quality, wait.reasons));
    } else {
      rawIntervals.push(toPhaseInterval("queue_wait", s, e, e !== null && s !== null && e >= s ? wait.quality : "unavailable", e !== null && s !== null && e >= s ? wait.reasons : ["negative_duration"], null, { startCursor: wait.startCursor, endCursor: wait.endCursor }));
    }
  }
  const nested: NestedInterval[] = [];
  for (const wait of queueHistory.admissionWaits) {
    const s = msOf(wait.start);
    const e = wait.end ? msOf(wait.end) : null;
    nested.push({
      kind: "admission_dependency_wait",
      startMs: s,
      endMs: e,
      durationMs: s !== null && e !== null ? (e >= s ? e - s : null) : null,
      quality: wait.quality,
      reasons: wait.reasons,
      category: wait.category,
      sessionId: null,
    });
    if (wait.category === "runtime_health" || wait.category === "agent_deck") {
      nested.push({
        kind: "runtime_health_preflight",
        startMs: s,
        endMs: e,
        durationMs: s !== null && e !== null ? (e >= s ? e - s : null) : null,
        // Single-source (queue reason only): defensible but inferred. Deck-connect
        // timing evidence would be needed for exact.
        quality: wait.quality === "unavailable" ? "unavailable" : "inferred",
        reasons: [...new Set([...wait.reasons, "single_source"])],
        category: wait.category,
        sessionId: null,
      });
    }
  }

  // Per-attempt composition.
  const publishOnlySessions = new Set<string>();
  for (const event of ev.events) {
    if ((event.type === "worker.completed" || event.type === "worker.failed") && event.sessionId) {
      if (parsePayload(event.payloadJson).publishOnly === true) publishOnlySessions.add(event.sessionId);
    }
  }

  const attempts: AttemptAnalysis[] = [];
  for (const session of ev.sessions) {
    const sessionEvents = bySession.get(session.id) ?? [];
    const usages = usageBySession.get(session.id) ?? [];
    const usage = usages[0] ?? null;
    const publishOnly = publishOnlySessions.has(session.id);
    const derived = deriveAttemptIntervals({
      events: toBoundaryEvents(sessionEvents),
      usageDurationMs: usage?.durationMs,
      usageTs: usage?.ts,
      publishOnly,
    });
    const setup = toPhaseInterval("coordinator_setup", derived.setup.startMs, derived.setup.endMs, derived.setup.quality, derived.setup.reasons, session.id, { startCursor: cursorOf(sessionEvents, "worker.started"), endCursor: cursorOf(sessionEvents, "agent.started") });
    const agentProcess = toPhaseInterval("agent_process", derived.agentProcess.startMs, derived.agentProcess.endMs, derived.agentProcess.quality, derived.agentProcess.reasons, session.id, { startCursor: cursorOf(sessionEvents, "agent.started"), endCursor: cursorOf(sessionEvents, "agent.completed") });
    // NOT-169 backfill carries the duration without boundaries; surface it as the
    // interval duration so unioned totals can use it.
    if (agentProcess.durationMs === null && derived.agentProcess.durationMs !== null) {
      agentProcess.durationMs = derived.agentProcess.durationMs;
    }
    const validationPublish = toPhaseInterval(
      "coordinator_validation_publish",
      derived.validationPublish.startMs,
      derived.validationPublish.endMs,
      derived.validationPublish.quality,
      derived.validationPublish.reasons,
      session.id,
      { startCursor: cursorOf(sessionEvents, "agent.completed"), endCursor: cursorOf(sessionEvents, "worker.completed") ?? cursorOf(sessionEvents, "worker.failed") },
    );
    rawIntervals.push(setup, agentProcess, validationPublish);
    if (derived.coordinatorWork) {
      rawIntervals.push(toPhaseInterval("coordinator_work", derived.coordinatorWork.startMs, derived.coordinatorWork.endMs, derived.coordinatorWork.quality, derived.coordinatorWork.reasons, session.id));
    }

    const causes = orderCauses(ev.failureCauses.filter((c) => c.sessionId === session.id))
      .map(({ issueId: _drop, ...cause }) => cause);

    const { windows: sleepWindows, approximated } = sleepWindowsFromEvents(sessionEvents);
    const points: SilenceActivityPoint[] = (activityBySession.get(session.id) ?? [])
      .map((row) => ({ observedMs: msOf(row.observedAt) ?? NaN, kind: row.activityKind as SilenceActivityPoint["kind"], callId: row.callId }))
      .filter((p) => Number.isFinite(p.observedMs));
    const silenceDerived = deriveSilenceIntervals({
      processStartMs: derived.agentProcess.startMs,
      processEndMs: derived.agentProcess.endMs,
      processQuality: derived.agentProcess.quality,
      processReasons: derived.agentProcess.reasons,
      activities: points,
      sleepWindows,
    });
    const silence: NestedInterval[] = silenceDerived.intervals.map((iv) => ({
      kind: "unexplained_silence" as const,
      startMs: iv.startMs,
      endMs: iv.endMs,
      durationMs: iv.durationMs,
      quality: iv.quality,
      reasons: approximated && iv.category === "host_suspended" ? [...new Set([...iv.reasons, "host_sleep_approximated"])] : iv.reasons,
      category: iv.category,
      sessionId: session.id,
    }));
    nested.push(...silence);
    const silenceReasons = approximated && silenceDerived.quality !== "unavailable"
      ? [...new Set([...silenceDerived.reasons, "host_sleep_approximated"])]
      : silenceDerived.reasons;

    attempts.push({
      sessionId: session.id,
      role: session.role,
      runtime: session.runtime,
      model: session.model,
      status: session.status,
      round: session.round,
      publishOnly,
      setup,
      agentProcess,
      validationPublish,
      spawnEnvelopeMs: derived.spawnEnvelope.durationMs,
      spawnEnvelopeQuality: derived.spawnEnvelope.quality,
      spawnEnvelopeReasons: derived.spawnEnvelope.reasons,
      failureCauses: causes,
      silence,
      silenceQuality: silenceDerived.quality,
      silenceReasons,
      tokensIn: usage?.tokensIn ?? null,
      tokensOut: usage?.tokensOut ?? null,
      costUsd: usage?.costUsd ?? null,
      usageDurationMs: usage?.durationMs ?? null,
      usageQuality: usage ? "exact" : "unavailable",
      usageReasons: usage ? [] : ["missing_provider_metadata"],
    });
  }

  // Unioned durations per phase (§3 rule 2). Bounded intervals union by range;
  // boundary-less inferred durations (NOT-169 backfill) cannot be unioned, so
  // they are summed and flagged `unbounded_sum` — overlap with other attempts
  // cannot be determined from the evidence.
  const phases: PhaseInterval["phase"][] = ["queue_wait", "coordinator_setup", "agent_process", "coordinator_validation_publish", "coordinator_work"];
  const unionedDurations: UnionedPhaseDuration[] = phases.map((phase) => {
    const raws = rawIntervals.filter((r) => r.phase === phase);
    const withDuration = raws.filter((r) => r.durationMs !== null);
    if (withDuration.length === 0) {
      const reasons = raws.length > 0 ? [...new Set(raws.flatMap((r) => r.reasons))] : ["missing_provider_metadata"];
      return { phase, durationMs: null, quality: "unavailable", reasons, rawCount: raws.length, known: 0, total: raws.length };
    }
    const bounded = withDuration.filter((r) => r.startMs !== null && r.endMs !== null);
    const unbounded = withDuration.filter((r) => r.startMs === null || r.endMs === null);
    const durationMs =
      unionDurationMs(bounded.map((r) => ({ start: r.startMs!, end: r.endMs! }))) +
      unbounded.reduce((sum, r) => sum + r.durationMs!, 0);
    const { quality, reasons } = weakestQuality(withDuration.map((r) => ({ quality: r.quality, reasons: r.reasons })));
    const extra: string[] = [];
    if (withDuration.length < raws.length) extra.push("partial_sample");
    if (unbounded.length > 0) extra.push("unbounded_sum");
    const finalReasons = [...reasons, ...extra.filter((e) => !reasons.includes(e))];
    return {
      phase,
      durationMs,
      quality,
      reasons: finalReasons,
      rawCount: raws.length,
      known: withDuration.length,
      total: raws.length,
    };
  });

  // Exclusive total over unioned top-level phases; human_wait and nested
  // drill-downs never inflate it (§3 rules 3–4). coordinator_work is the
  // publish-only analog of setup/agent/validation and is included with its
  // publish_only reason preserved.
  const exclusiveParts = unionedDurations.filter((u) => u.durationMs !== null);
  const exclusiveReasons = [...new Set(exclusiveParts.flatMap((u) => u.reasons))];
  const exclusiveTotalMs = exclusiveParts.length > 0 ? exclusiveParts.reduce((sum, u) => sum + u.durationMs!, 0) : null;
  const exclusiveQuality = exclusiveTotalMs === null
    ? "unavailable" as ExecutionQuality
    : exclusiveParts.some((u) => u.quality === "inferred")
      ? "inferred" as ExecutionQuality
      : "exact" as ExecutionQuality;

  // Human wait: union of [requested_at, resolved_at), open actions closed at
  // now as inferred (§3 rule 4, §9.1).
  const humanRanges: Range[] = [];
  let humanOpen = false;
  for (const action of ev.humanActions) {
    const s = msOf(action.requestedAt);
    const e = action.resolvedAt ? msOf(action.resolvedAt) : ev.nowMs;
    if (s === null || e === null || e <= s) continue;
    if (!action.resolvedAt) humanOpen = true;
    humanRanges.push({ start: s, end: e });
  }
  const humanWaitMs = ev.humanActions.length === 0 ? 0 : unionDurationMs(humanRanges);
  const humanWaitQuality: ExecutionQuality = ev.humanActions.length === 0 ? "exact" : humanOpen ? "inferred" : "exact";
  const humanWaitReasons = ev.humanActions.length === 0 ? [] : humanOpen ? ["open_interval"] : [];
  for (const action of ev.humanActions) {
    const s = msOf(action.requestedAt);
    const e = action.resolvedAt ? msOf(action.resolvedAt) : ev.nowMs;
    nested.push({
      kind: "human_wait",
      startMs: s,
      endMs: e,
      durationMs: s !== null && e !== null && e > s ? e - s : null,
      quality: action.resolvedAt ? "exact" : "inferred",
      reasons: action.resolvedAt ? [] : ["open_interval"],
      category: null,
      sessionId: null,
    });
  }

  // Primary vs consequence causes across the issue.
  const orderedCauses = orderCauses(ev.failureCauses);
  const primaries = orderedCauses.filter((c) => c.primary);
  const primaryRow = primaries[0] ?? null;
  const stripIssue = ({ issueId: _drop, ...cause }: FailureCauseRow): FailureCause => cause;
  const primaryFailure = primaryRow ? stripIssue(primaryRow) : null;
  const consequenceCauses = orderedCauses.filter((c) => !c.primary).map(stripIssue);

  // Failed-attempt waste over known values only.
  const wasteSessions: WasteSession[] = ev.sessions.map((s) => ({
    id: s.id,
    role: s.role,
    status: s.status,
    errorJson: s.errorJson,
    createdAt: s.createdAt,
  }));
  const wasteUsages: WasteUsage[] = ev.usages.map((u) => ({
    workerSessionId: u.workerSessionId,
    tokensIn: u.tokensIn,
    tokensOut: u.tokensOut,
    costUsd: u.costUsd,
    durationMs: u.durationMs,
  }));
  const agentBoundaries: AgentBoundary[] = ev.sessions.map((s) => {
    const sessionEvents = bySession.get(s.id) ?? [];
    const starts = sessionEvents.filter((e) => e.type === "agent.started").map((e) => msOf(e.ts)).filter((v): v is number => v !== null);
    const ends = sessionEvents.filter((e) => e.type === "agent.completed").map((e) => msOf(e.ts)).filter((v): v is number => v !== null);
    return { sessionId: s.id, startMs: starts[0] ?? null, endMs: ends[0] ?? null };
  });
  const waste = deriveAttemptWaste({
    sessions: wasteSessions,
    usages: wasteUsages,
    agentBoundaries,
    publishOnlySessionIds: publishOnlySessions,
  });
  const toCovered = (agg: { value: number | null; quality: ExecutionQuality; reasons: string[]; known: number; total: number }): CoveredTotal => agg;

  // First coordinator-observed checkpoint.
  const checkpoints = ev.events.filter((e) => e.type === "checkpoint.observed").map(parseCheckpointRecord).filter((r): r is CheckpointRecord => r !== null);
  const branchPushedAt = ev.events.filter((e) => e.type === "branch.pushed").map((e) => msOf(e.ts)).filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;
  const firstCheckpointRaw = deriveFirstCheckpoint({
    workflowStartedAt: firstStart,
    checkpoints,
    legacyFirstEvidenceAt: branchPushedAt !== null ? new Date(branchPushedAt).toISOString() : null,
  });
  const firstCheckpoint: FirstCheckpointView = {
    kind: firstCheckpointRaw.kind,
    observedSha: firstCheckpointRaw.observedSha,
    msSinceWorkflowStart: firstCheckpointRaw.msSinceWorkflowStart,
    quality: firstCheckpointRaw.quality,
    reasons: firstCheckpointRaw.reasons,
  };

  // Retry reuse evidence (developer sessions; retries follow the first).
  const developerSessions = wasteSessions.filter((s) => ev.sessions.find((row) => row.id === s.id)?.role === "developer");
  const reuse: ReuseRecord[] = ev.events.filter((e) => e.type === "retry.reused").map(parseReuseRecord).filter((r): r is ReuseRecord => r !== null);
  const retrySummary = deriveRetrySummary({ sessions: developerSessions, reuse, hints: new Map() });
  const retryKnown = retrySummary.attemptsDetail.filter((a) => a.cold !== null);
  // NOT-174: pass the per-attempt reuse kinds through so the UI can badge
  // exactly what each retry preserved. `cold: null` means unknown (no evidence
  // either way) — those attempts keep `reuseKinds` absent, distinct from an
  // explicit cold retry (`[]`).
  const reuseBySession = new Map(retrySummary.attemptsDetail.map((d) => [d.sessionId, d]));
  for (const attempt of attempts) {
    const detail = reuseBySession.get(attempt.sessionId);
    if (detail && detail.cold !== null) attempt.reuseKinds = [...detail.kinds];
  }
  const preservedKinds = [...new Set(
    retrySummary.attemptsDetail.flatMap((d) => (d.cold === false ? d.kinds : [])),
  )];
  const retry: RetryReuseView = {
    attempts: retrySummary.attempts,
    retries: retrySummary.retries,
    cold: retrySummary.cold,
    reused: retrySummary.reused,
    unknown: retrySummary.unknown,
    publishOnly: retrySummary.publishOnly,
    reuseRate: retryKnown.length > 0 ? retryKnown.filter((a) => !a.cold).length / retryKnown.length : null,
    preservedKinds,
    quality: retrySummary.retries === 0 ? "unavailable" : retrySummary.unknown > 0 ? "inferred" : "exact",
    reasons: retrySummary.retries === 0 ? ["missing_provider_metadata"] : retrySummary.unknown > 0 ? ["partial_sample"] : [],
  };

  // Reviewer rounds / change-request rate.
  const reviewerSessions = ev.sessions.filter((s) => s.role === "reviewer").length;
  const verdicts = ev.events
    .filter((e) => e.type === "review.submitted")
    .map((e) => ({ verdict: parsePayload(e.payloadJson).verdict }));
  const reviewer = deriveReviewerView({ reviewerSessionCount: reviewerSessions, verdicts });

  // Metadata coverage for duration, tokens, and cost over attempts.
  const coverage = {
    duration: coveredTotal(attempts.map((a) => (a.agentProcess.durationMs !== null ? 1 : null)), { missingReason: "no_defensible_boundary" }),
    tokens: coveredTotal(attempts.map((a) => (a.tokensIn !== null || a.tokensOut !== null ? 1 : null))),
    cost: coveredTotal(attempts.map((a) => (a.costUsd !== null ? 1 : null))),
  };

  return {
    issueId: ev.issueId,
    elapsed: elapsedView,
    rawIntervals,
    unionedDurations,
    exclusiveTotalMs,
    exclusiveTotalQuality: exclusiveQuality,
    exclusiveTotalReasons: exclusiveReasons,
    nested,
    attempts,
    primaryFailure,
    primaryFailureQuality: primaryFailure ? primaryFailure.quality : "unavailable",
    primaryFailureReasons: primaryFailure ? [] : ["missing_classification"],
    consequenceCauses,
    waste: {
      failedAttempts: waste.failedAttempts,
      publishOnlyAttempts: waste.publishOnlyAttempts,
      runtimeMs: toCovered(waste.runtimeMs),
      tokensIn: toCovered(waste.tokensIn),
      tokensOut: toCovered(waste.tokensOut),
      costUsd: toCovered(waste.costUsd),
    },
    firstCheckpoint,
    retry,
    reviewer,
    humanWaitMs,
    humanWaitQuality,
    humanWaitReasons,
    interventionCount: ev.humanActions.length,
    coverage,
  };
}

export function loadEvidenceForIssues(issueIds: string[], nowMs = Date.now()): Map<string, IssueEvidence> {
  const events = loadEventsForIssues(issueIds);
  const sessions = loadSessionsForIssues(issueIds);
  const usages = loadUsageForIssues(issueIds);
  const humanActions = loadHumanActionsForIssues(issueIds);
  const failureCauses = loadFailureCausesForIssues(issueIds);
  const activities = loadActivityForIssues(issueIds);
  const queueRows = loadQueueRowsForIssues(issueIds);
  const instances = loadInstancesForIssues(issueIds);
  const out = new Map<string, IssueEvidence>();
  for (const issueId of issueIds) {
    out.set(issueId, {
      issueId,
      events: events.get(issueId) ?? [],
      sessions: sessions.get(issueId) ?? [],
      usages: usages.get(issueId) ?? [],
      humanActions: humanActions.get(issueId) ?? [],
      failureCauses: failureCauses.get(issueId) ?? [],
      activities: activities.get(issueId) ?? [],
      queueRows: queueRows.get(issueId) ?? [],
      instances: instances.get(issueId) ?? [],
      nowMs,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cohort report
// ---------------------------------------------------------------------------

export interface ResolvedCohortWindow {
  fromIso: string;
  toIso: string;
  fromMs: number;
  toMs: number;
  defaultApplied: boolean;
}

/** Conservative default window (last DEFAULT_COHORT_WINDOW_DAYS) with a hard
 * cap of MAX_COHORT_WINDOW_DAYS. Invalid bounds are 400s at the route. */
export function resolveCohortWindow(filters: CohortFilters, nowMs = Date.now()): ResolvedCohortWindow {
  const toMs = filters.to ? Date.parse(filters.to) : nowMs;
  let fromMs = filters.from ? Date.parse(filters.from) : toMs - DEFAULT_COHORT_WINDOW_DAYS * 86_400_000;
  const maxSpan = MAX_COHORT_WINDOW_DAYS * 86_400_000;
  if (toMs - fromMs > maxSpan) fromMs = toMs - maxSpan;
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    defaultApplied: !filters.from && !filters.to,
  };
}

export interface CohortIssuePage {
  issueIds: string[];
  totalIssues: number;
}

/**
 * Every issue whose execution started in the window (first workflow start;
 * issues with no instance yet fall back to created_at), in stable
 * (firstStart, id) order. Attempt-level filters (role/runtime/model/status)
 * are EXISTS-matched here so the cohort counts issues that can contribute;
 * the same predicates filter attempts during aggregation. Pagination slices
 * `issueIds` in getCohortExecutionAnalysis — the aggregates always cover the
 * whole filtered cohort, never just the page.
 */
export function listCohortIssueIds(
  filters: CohortFilters,
  window: ResolvedCohortWindow,
): CohortIssuePage {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.repo) {
    conditions.push("i.repo = ?");
    params.push(filters.repo);
  }
  if (filters.role) {
    conditions.push("EXISTS (SELECT 1 FROM worker_sessions s WHERE s.issue_id = i.id AND s.role = ?)");
    params.push(filters.role);
  }
  if (filters.runtime) {
    conditions.push("EXISTS (SELECT 1 FROM worker_sessions s WHERE s.issue_id = i.id AND s.runtime = ?)");
    params.push(filters.runtime);
  }
  if (filters.model) {
    conditions.push("EXISTS (SELECT 1 FROM worker_sessions s WHERE s.issue_id = i.id AND s.model = ?)");
    params.push(filters.model);
  }
  if (filters.status) {
    conditions.push(`(
      i.status = ?
      OR EXISTS (SELECT 1 FROM worker_sessions s WHERE s.issue_id = i.id AND s.status = ?)
      OR EXISTS (SELECT 1 FROM workflow_instances w WHERE w.issue_id = i.id AND w.outcome = ?)
    )`);
    params.push(filters.status, filters.status, filters.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT i.id AS id,
              COALESCE(MIN(w.started_at), i.created_at) AS firstStart
       FROM issues i LEFT JOIN workflow_instances w ON w.issue_id = i.id
       ${where}
       GROUP BY i.id
       HAVING firstStart >= ? AND firstStart < ?
       ORDER BY firstStart ASC, i.id ASC`
    )
    .all(...params, new Date(window.fromMs).toISOString(), new Date(window.toMs).toISOString()) as Array<{
      id: string;
      firstStart: string;
    }>;
  return {
    issueIds: rows.map((r) => r.id),
    totalIssues: rows.length,
  };
}

function attemptMatches(session: { role: string; runtime: string | null; model: string | null; status: string }, filters: CohortFilters): boolean {
  if (filters.role && session.role !== filters.role) return false;
  if (filters.runtime && session.runtime !== filters.runtime) return false;
  if (filters.model && (session.model ?? null) !== filters.model) return false;
  if (filters.status && session.status !== filters.status) return false;
  return true;
}

/** Whether any attempt-level filter is active. With none, the attempt-scoped
 * cohort metrics trivially equal the whole-issue values. */
export function hasAttemptFilter(filters: CohortFilters): boolean {
  return filters.role !== null || filters.runtime !== null || filters.model !== null || filters.status !== null;
}

/** Evidence restricted to the attempts matching the cohort filters. Sessions
 * (and the events, usages, activities, and failure causes attributable to
 * them) that do not match are dropped; unattributable issue-level rows
 * (null-session events and causes, human actions, queue rows, instances) are
 * retained because they cannot be scoped to an attempt. Composing this
 * filtered evidence with composeIssueAnalysis yields the attempt-scoped
 * cohort metrics (failed waste, retry reuse, reviewer rounds, failure
 * causes) through the exact per-issue derivation — no approximation, so a
 * per-runtime or per-model waste comparison never mixes in other runtimes'
 * failed attempts. */
export function filterIssueEvidence(ev: IssueEvidence, filters: CohortFilters): IssueEvidence {
  const keptSessions = new Set(
    ev.sessions
      .filter((s) => attemptMatches({ role: s.role, runtime: s.runtime, model: s.model, status: s.status }, filters))
      .map((s) => s.id),
  );
  return {
    ...ev,
    sessions: ev.sessions.filter((s) => keptSessions.has(s.id)),
    events: ev.events.filter((e) => e.sessionId === null || keptSessions.has(e.sessionId)),
    usages: ev.usages.filter((u) => keptSessions.has(u.workerSessionId)),
    activities: ev.activities.filter((a) => keptSessions.has(a.workerSessionId)),
    failureCauses: ev.failureCauses.filter((c) => c.sessionId == null || keptSessions.has(c.sessionId)),
  };
}

/** Batched evidence for a whole cohort, loaded in fixed-size chunks so the
 * query count grows with chunks, never with issues or sessions. */
export function loadEvidenceForCohort(issueIds: string[], nowMs = Date.now()): Map<string, IssueEvidence> {
  const out = new Map<string, IssueEvidence>();
  if (issueIds.length === 0) return out;
  const CHUNK_SIZE = 100;
  for (let i = 0; i < issueIds.length; i += CHUNK_SIZE) {
    for (const [id, ev] of loadEvidenceForIssues(issueIds.slice(i, i + CHUNK_SIZE), nowMs)) {
      out.set(id, ev);
    }
  }
  return out;
}

function combineCovered(parts: CoveredTotal[], opts?: { missingReason?: string }): CoveredTotal {
  const known = parts.reduce((a, p) => a + p.known, 0);
  const total = parts.reduce((a, p) => a + p.total, 0);
  const values = parts.map((p) => p.value).filter((v): v is number => v !== null);
  if (known === 0) {
    return { value: null, quality: "unavailable", reasons: [opts?.missingReason ?? "missing_provider_metadata"], known, total };
  }
  const { quality, reasons } = weakestQuality(
    parts.filter((p) => p.known > 0).map((p) => ({ quality: p.quality, reasons: p.reasons })),
  );
  const finalReasons = known < total && !reasons.includes("partial_sample") ? [...reasons, "partial_sample"] : reasons;
  return { value: values.reduce((a, b) => a + b, 0), quality, reasons: finalReasons, known, total };
}

function sliceStats(
  groups: Map<string, Array<{ success: boolean; wallMs: number | null; wallQuality: ExecutionQuality; wallReasons: string[]; retry: boolean }>>,
): CohortSliceStat[] {
  return [...groups.entries()]
    .map(([key, rows]): CohortSliceStat => {
      const wallValues = rows.map((r) => r.wallMs);
      const wallInputs = rows.filter((r) => r.wallMs !== null).map((r) => ({ quality: r.wallQuality, reasons: r.wallReasons }));
      const successes = rows.filter((r) => r.success).length;
      const retries = rows.filter((r) => r.retry).length;
      return {
        key,
        attempts: rows.length,
        successes,
        successRate: rows.length > 0 ? successes / rows.length : null,
        retries,
        retryRate: rows.length > 0 ? retries / rows.length : null,
        wallTimeMs: percentileStat(wallValues, wallInputs),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Compose the cohort report over the whole filtered cohort. `analyses` holds
 * every matching issue in stable order; `page` only selects the `issueIds`
 * window returned to the caller, so every page reports identical aggregates.
 * `filteredAnalyses` carries the same issues composed from filter-restricted
 * evidence (see filterIssueEvidence); attempt-scoped metrics — failed waste,
 * retry reuse, reviewer rounds, primary failures — aggregate from it, while
 * issue-level metrics (queue wait, checkpoint latency, human wait) aggregate
 * from the contributing full issues. All evidence is loaded with the batched
 * loaders (constant queries per chunk, never per issue/session). */
export function composeCohortReport(
  analyses: IssueExecutionAnalysis[],
  filters: CohortFilters,
  window: ResolvedCohortWindow,
  page: CohortIssuePage,
  filteredAnalyses: IssueExecutionAnalysis[] | null = null,
): CohortExecutionReport {
  const ordered = analyses;
  const scoped = filteredAnalyses ?? ordered;

  // Filtered attempts across the whole cohort (attempt denominator).
  const kept: Array<{ analysis: IssueExecutionAnalysis; attempt: AttemptAnalysis; retry: boolean }> = [];
  for (const analysis of ordered) {
    const matching = analysis.attempts.filter((a) =>
      attemptMatches({ role: a.role, runtime: a.runtime, model: a.model, status: a.status }, filters),
    );
    matching.forEach((attempt, index) => kept.push({ analysis, attempt, retry: index > 0 }));
  }

  // Issue-level metrics under attempt filters cover the contributing issues
  // (those with at least one kept attempt); without filters every issue
  // contributes, including ones with no sessions yet.
  const keptIssueIds = new Set(kept.map((k) => k.analysis.issueId));
  const level = filteredAnalyses !== null ? ordered.filter((a) => keptIssueIds.has(a.issueId)) : ordered;

  const phaseNames: Array<"queue_wait" | "coordinator_setup" | "agent_process" | "coordinator_validation_publish"> = [
    "queue_wait",
    "coordinator_setup",
    "agent_process",
    "coordinator_validation_publish",
  ];
  const phaseWallTime: Record<string, PercentileStat> = {};
  // Queue wait is an issue-level interval, not per-attempt: gather it from the
  // unioned issue view so it is not multiplied by attempt count.
  const queueValues: number[] = [];
  const queueInputs: Array<{ quality: ExecutionQuality; reasons: string[] }> = [];
  for (const analysis of level) {
    const q = analysis.unionedDurations.find((u) => u.phase === "queue_wait");
    if (q?.durationMs !== null && q?.durationMs !== undefined) {
      queueValues.push(q.durationMs);
      queueInputs.push({ quality: q.quality, reasons: q.reasons });
    }
  }
  phaseWallTime.queue_wait = percentileStat(queueValues, queueInputs);
  for (const phase of phaseNames.slice(1)) {
    const values: number[] = [];
    const inputs: Array<{ quality: ExecutionQuality; reasons: string[] }> = [];
    for (const { attempt } of kept) {
      const iv = phase === "coordinator_setup" ? attempt.setup : phase === "agent_process" ? attempt.agentProcess : attempt.validationPublish;
      if (iv.durationMs !== null) {
        values.push(iv.durationMs);
        inputs.push({ quality: iv.quality, reasons: iv.reasons });
      }
    }
    phaseWallTime[phase] = percentileStat(values, inputs);
  }

  const doneAttempts = kept.filter((k) => k.attempt.status === "done").length;
  const attemptSuccess = rateStat(doneAttempts, kept.length, { unavailableReason: "missing_provider_metadata" });
  // Issue success has its own denominator: issues whose latest workflow
  // completed done over all issues in the cohort — never the attempt count.
  const issueSuccess = rateStat(
    ordered.filter((a) => doneMarkerStore.get(a.issueId) === true).length,
    ordered.length,
    { unavailableReason: "missing_provider_metadata" },
  );

  // Primary failure counts/rates over filtered attempts: only causes
  // attributable to a kept attempt (plus unattributable issue-level causes)
  // are composed into the scoped analyses.
  const primaryCounts = new Map<string, number>();
  let primaryDenominator = 0;
  for (const analysis of scoped) {
    if (analysis.primaryFailure) {
      primaryDenominator += 1;
      primaryCounts.set(analysis.primaryFailure.code, (primaryCounts.get(analysis.primaryFailure.code) ?? 0) + 1);
    }
  }
  const primaryFailures = [...primaryCounts.entries()]
    .map(([code, count]) => ({ code, count, rate: primaryDenominator > 0 ? count / primaryDenominator : null }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));

  // Failed waste over the filtered attempts: each scoped analysis ran the
  // exact per-issue waste derivation on filter-restricted evidence, so a
  // per-runtime or per-model comparison never mixes in other runtimes'
  // failed attempts.
  const waste = {
    failedAttempts: scoped.reduce((a, x) => a + x.waste.failedAttempts, 0),
    runtimeMs: combineCovered(scoped.map((x) => x.waste.runtimeMs), { missingReason: "no_defensible_boundary" }),
    tokensIn: combineCovered(scoped.map((x) => x.waste.tokensIn)),
    tokensOut: combineCovered(scoped.map((x) => x.waste.tokensOut)),
    costUsd: combineCovered(scoped.map((x) => x.waste.costUsd)),
  };

  const checkpointValues = level.map((a) => a.firstCheckpoint.msSinceWorkflowStart);
  const checkpointInputs = level
    .filter((a) => a.firstCheckpoint.msSinceWorkflowStart !== null)
    .map((a) => ({ quality: a.firstCheckpoint.quality, reasons: a.firstCheckpoint.reasons }));
  const checkpointLatencyMs = percentileStat(checkpointValues, checkpointInputs);

  const totalRetries = scoped.reduce((a, x) => a + x.retry.retries, 0);
  const reusedRetries = scoped.reduce((a, x) => a + x.retry.reused, 0);
  const unknownRetries = scoped.reduce((a, x) => a + x.retry.unknown, 0);
  const knownRetries = totalRetries - unknownRetries;
  const retryReuse: RateStat = knownRetries > 0
    ? {
        numerator: reusedRetries,
        denominator: knownRetries,
        rate: reusedRetries / knownRetries,
        quality: unknownRetries > 0 ? "inferred" : "exact",
        reasons: unknownRetries > 0 ? ["partial_sample"] : [],
      }
    : { numerator: 0, denominator: 0, rate: null, quality: "unavailable", reasons: ["missing_provider_metadata"] };

  const reviewerRounds = scoped.reduce((a, x) => a + x.reviewer.rounds, 0);
  const reviewerVerdicts = scoped.reduce((a, x) => a + x.reviewer.verdicts, 0);
  const reviewerChangeRequests = scoped.reduce((a, x) => a + x.reviewer.changeRequests, 0);

  const humanWaits = level.map((a) => a.humanWaitMs);
  const humanWaitInputs = level
    .filter((a) => a.humanWaitMs !== null)
    .map((a) => ({ quality: a.humanWaitQuality, reasons: a.humanWaitReasons }));
  const humanInterventions = {
    totalActions: level.reduce((a, x) => a + x.interventionCount, 0),
    issuesWithIntervention: level.filter((a) => a.interventionCount > 0).length,
    humanWaitMs: percentileStat(humanWaits, humanWaitInputs),
  };

  // Slice breakdowns over filtered attempts. Retries in a slice = attempts
  // beyond the first in the same (issue, slice key) group, oldest first is
  // already the composed order.
  const byKey = (pick: (attempt: AttemptAnalysis) => string | null): CohortSliceStat[] => {
    const groups = new Map<string, Array<{ success: boolean; wallMs: number | null; wallQuality: ExecutionQuality; wallReasons: string[]; retry: boolean }>>();
    const seen = new Map<string, number>();
    for (const { analysis, attempt } of kept) {
      const key = pick(attempt) ?? "unknown";
      const groupKey = `${analysis.issueId}::${key}`;
      const seenCount = seen.get(groupKey) ?? 0;
      seen.set(groupKey, seenCount + 1);
      const rows = groups.get(key) ?? [];
      rows.push({
        success: attempt.status === "done",
        wallMs: attempt.agentProcess.durationMs,
        wallQuality: attempt.agentProcess.quality,
        wallReasons: attempt.agentProcess.reasons,
        retry: seenCount > 0,
      });
      groups.set(key, rows);
    }
    return sliceStats(groups);
  };

  return {
    window: { from: window.fromIso, to: window.toIso, defaultApplied: window.defaultApplied },
    pagination: { limit: filters.limit, offset: filters.offset, totalIssues: page.totalIssues },
    issueIds: page.issueIds,
    phaseWallTime,
    attemptSuccess,
    issueSuccess,
    primaryFailures,
    primaryFailureDenominator: primaryDenominator,
    waste,
    checkpointLatencyMs,
    retryReuse,
    reviewer: {
      rounds: reviewerRounds,
      verdicts: reviewerVerdicts,
      changeRequests: reviewerChangeRequests,
      changeRequestRate: reviewerVerdicts > 0 ? reviewerChangeRequests / reviewerVerdicts : null,
      quality: reviewerVerdicts > 0 ? "exact" : reviewerRounds > 0 ? "inferred" : "unavailable",
      reasons: reviewerVerdicts > 0 ? [] : reviewerRounds > 0 ? ["backfill"] : ["missing_provider_metadata"],
    },
    humanInterventions,
    byRole: byKey((a) => a.role),
    byRuntime: byKey((a) => a.runtime),
    byModel: byKey((a) => a.model),
    coverage: {
      duration: combineCovered(
        kept.map((k) => (k.attempt.agentProcess.durationMs !== null
          ? { value: 1, quality: k.attempt.agentProcess.quality, reasons: k.attempt.agentProcess.reasons, known: 1, total: 1 }
          : { value: null, quality: "unavailable" as ExecutionQuality, reasons: ["no_defensible_boundary"], known: 0, total: 1 })),
        { missingReason: "no_defensible_boundary" },
      ),
      tokens: combineCovered(
        kept.map((k) => (k.attempt.tokensIn !== null || k.attempt.tokensOut !== null
          ? { value: 1, quality: "exact" as ExecutionQuality, reasons: [] as string[], known: 1, total: 1 }
          : { value: null, quality: "unavailable" as ExecutionQuality, reasons: ["missing_provider_metadata"], known: 0, total: 1 })),
      ),
      cost: combineCovered(
        kept.map((k) => (k.attempt.costUsd !== null
          ? { value: 1, quality: "exact" as ExecutionQuality, reasons: [] as string[], known: 1, total: 1 }
          : { value: null, quality: "unavailable" as ExecutionQuality, reasons: ["missing_provider_metadata"], known: 0, total: 1 })),
      ),
    },
  };
}

/** Issue ids whose latest workflow instance completed with outcome done.
 * Set by getCohortExecutionAnalysis before composing the report: outcome is
 * issue-level state outside the composed attempt view, so it travels beside
 * the analyses rather than inside them. */
export const doneMarkerStore = new Map<string, boolean>();

/** Full cohort path: resolve window → all matching issues → chunked batched
 * evidence → per-issue composition → aggregation over the whole cohort.
 * Pagination only windows the returned `issueIds`; the aggregates always
 * describe the full filtered cohort, so every page reports the same numbers
 * and `totalIssues` agrees with the aggregate sample. */
export function getCohortExecutionAnalysis(filters: CohortFilters, nowMs = Date.now()): CohortExecutionReport {
  const window = resolveCohortWindow(filters, nowMs);
  const full = listCohortIssueIds(filters, window);
  const page: CohortIssuePage = {
    issueIds: full.issueIds.slice(filters.offset, filters.offset + filters.limit),
    totalIssues: full.totalIssues,
  };
  const evidence = loadEvidenceForCohort(full.issueIds, nowMs);
  doneMarkerStore.clear();
  const filtered = hasAttemptFilter(filters) ? new Map<string, IssueEvidence>() : null;
  for (const [id, ev] of evidence) {
    const last = ev.instances.length > 0 ? ev.instances[ev.instances.length - 1]! : null;
    doneMarkerStore.set(id, last?.outcome === "done" && last.completedAt !== null);
    if (filtered) filtered.set(id, filterIssueEvidence(ev, filters));
  }
  const analyses = full.issueIds.map((id) => composeIssueAnalysis(evidence.get(id)!));
  const filteredAnalyses = filtered ? full.issueIds.map((id) => composeIssueAnalysis(filtered.get(id)!)) : null;
  return composeCohortReport(analyses, filters, window, page, filteredAnalyses);
}

/** Full issue path: batched evidence → composition. Null when unknown. */
export function getIssueExecutionAnalysis(issueId: string, nowMs = Date.now()): IssueExecutionAnalysis | null {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM issues WHERE id = ?").get(issueId) as unknown;
  if (!exists) return null;
  return composeIssueAnalysis(loadIssueEvidence(issueId, nowMs));
}

