import { z } from "zod";

/**
 * NOT-175: fleet-level execution-comparison report contract.
 *
 * The report reads `GET /api/execution-analysis` (NOT-173 surface). Every
 * aggregate follows docs/EXECUTION_ANALYSIS.md:
 * - missing cost/tokens/duration are excluded and counted in `known / total`,
 *   never coerced to zero;
 * - every percentile carries its sample count `n`;
 * - aggregates over a partial sample carry reason `partial_sample`.
 */

// Conservative default window: the API and the UI must agree on it.
export const DEFAULT_EXECUTION_REPORT_WINDOW_DAYS = 30;
export const EXECUTION_REPORT_MAX_LIMIT = 100;
export const EXECUTION_REPORT_DEFAULT_LIMIT = 25;
/** Cohorts with fewer than this many observations are labelled sparse. */
export const SPARSE_SAMPLE_THRESHOLD = 5;

export function defaultExecutionReportWindow(now: number = Date.now()): { from: string; to: string } {
  const to = new Date(now).toISOString();
  const from = new Date(now - DEFAULT_EXECUTION_REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

export const ExecutionReportRole = z.enum(["developer", "reviewer", "legacy"]);
export type ExecutionReportRole = z.infer<typeof ExecutionReportRole>;

/** Failure codes: the closed taxonomy from docs/EXECUTION_ANALYSIS.md §7. */
export const ExecutionFailureCode = z.enum([
  "authentication_configuration",
  "provider_capacity_rate_limit",
  "agent_cli_crash",
  "tool_test_timeout",
  "coordinator_crash",
  "validation_failure",
  "publish_git_failure",
  "agent_deck_unavailable",
  "host_sleep_liveness",
  "unknown",
]);
export type ExecutionFailureCode = z.infer<typeof ExecutionFailureCode>;

export const ExecutionFailureDomain = z.enum(["task", "infrastructure", "unknown"]);
export type ExecutionFailureDomain = z.infer<typeof ExecutionFailureDomain>;

export const ExecutionReportQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  repo: z.string().optional(),
  role: ExecutionReportRole.optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  /** Comma-separated issue statuses, e.g. `done,closed`. */
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(EXECUTION_REPORT_MAX_LIMIT).default(EXECUTION_REPORT_DEFAULT_LIMIT),
});
export type ExecutionReportQuery = z.infer<typeof ExecutionReportQuery>;

export const EvidenceQuality = z.enum(["exact", "inferred", "unavailable"]);
export type EvidenceQuality = z.infer<typeof EvidenceQuality>;

/** Nearest-rank percentile value with its sample count (§3 item 6). */
export const PercentileStat = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  n: z.number().int().min(0),
  quality: EvidenceQuality,
  reasons: z.array(z.string()),
});
export type PercentileStat = z.infer<typeof PercentileStat>;

/** Sum over known values only, with completeness counts (§4). */
export const CoverageSum = z.object({
  sum: z.number().nullable(),
  known: z.number().int().min(0),
  total: z.number().int().min(0),
  quality: EvidenceQuality,
  reasons: z.array(z.string()),
});
export type CoverageSum = z.infer<typeof CoverageSum>;
export type CoverageStat = CoverageSum;

export const CohortRow = z.object({
  key: z.string(),
  issues: z.number().int().min(0),
  attempts: z.number().int().min(0),
  /** done issues / (done + closed) issues; null when no closed issue in the cohort. */
  issueSuccess: z.number().nullable(),
  issueSuccessDenominator: z.number().int().min(0),
  /** done sessions / terminal sessions; null when no terminal session in the cohort. */
  attemptSuccess: z.number().nullable(),
  attemptSuccessDenominator: z.number().int().min(0),
  sessionWallMs: PercentileStat,
  spawnEnvelopeMs: PercentileStat,
  retryRate: z.number().nullable(),
  tokensIn: CoverageSum,
  tokensOut: CoverageSum,
  costUsd: CoverageSum,
  durationMs: CoverageSum,
});
export type CohortRow = z.infer<typeof CohortRow>;

export const FailureDistributionEntry = z.object({
  code: ExecutionFailureCode,
  domain: ExecutionFailureDomain,
  count: z.number().int().min(0),
  share: z.number().nullable(),
  /** Issue ids in this bucket (first N) + total, for deep links. */
  issueIds: z.array(z.string()),
  issueTotal: z.number().int().min(0),
});
export type FailureDistributionEntry = z.infer<typeof FailureDistributionEntry>;

export const ExecutionReportIssueRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  repo: z.string(),
  attempts: z.number().int().min(0),
  updatedAt: z.string(),
});
export type ExecutionReportIssueRow = z.infer<typeof ExecutionReportIssueRow>;

export const ExecutionReportResponse = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  filters: z.object({
    repo: z.string().nullable(),
    role: z.string().nullable(),
    runtime: z.string().nullable(),
    model: z.string().nullable(),
    status: z.array(z.string()),
  }),
  summary: z.object({
    issues: z.number().int().min(0),
    closedIssues: z.number().int().min(0),
    /** done / (done + closed); null when no closed issue. */
    issueSuccess: z.number().nullable(),
    attempts: z.number().int().min(0),
    terminalAttempts: z.number().int().min(0),
    /** done sessions / terminal sessions; null when none terminal. */
    attemptSuccess: z.number().nullable(),
    retryRate: z.number().nullable(),
    retryExtraAttempts: z.number().int().min(0),
    reuseRate: z.number().nullable(),
    reuseDenominator: z.number().int().min(0),
    humanWaitMs: z.number().int().min(0),
    humanWaitQuality: EvidenceQuality,
    interventions: z.number().int().min(0),
    avgReviewerRounds: z.number().nullable(),
    reviewedIssues: z.number().int().min(0),
    changeRequestRate: z.number().nullable(),
    sessionWallMs: PercentileStat,
    spawnEnvelopeMs: PercentileStat,
    checkpointMs: PercentileStat,
    failedDurationMs: CoverageSum,
    failedTokensIn: CoverageSum,
    failedTokensOut: CoverageSum,
    failedCostUsd: CoverageSum,
  }),
  byRole: z.array(CohortRow),
  byRuntime: z.array(CohortRow),
  byModel: z.array(CohortRow),
  failures: z.array(FailureDistributionEntry),
  issues: z.array(ExecutionReportIssueRow),
  pagination: z.object({
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  }),
  meta: z.object({
    generatedAt: z.string(),
    /** True when any aggregate is a partial sample or a phase is unavailable. */
    partial: z.boolean(),
    partialReasons: z.array(z.string()),
  }),
});
export type ExecutionReportResponse = z.infer<typeof ExecutionReportResponse>;

// --- Pure helpers (shared by the API route, the web client, and tests) ---

export interface ReportFilterState {
  from?: string;
  to?: string;
  repo?: string;
  role?: string;
  runtime?: string;
  model?: string;
  status?: string;
  page?: number;
  limit?: number;
}

/** Serialize bounded filters to a query string; empty values are omitted. */
export function serializeExecutionReportQuery(filters: ReportFilterState): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if ((k === "page" && s === "1") || (k === "limit" && s === String(EXECUTION_REPORT_DEFAULT_LIMIT))) continue;
    qs.set(k, s);
  }
  qs.sort();
  return qs.toString();
}

/** Parse a query string back to filters; window defaults match the API. */
export function parseExecutionReportQuery(search: string, now: number = Date.now()): Required<Pick<ReportFilterState, "from" | "to">> & ReportFilterState {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const win = defaultExecutionReportWindow(now);
  const pick = (k: string): string | undefined => {
    const v = qs.get(k)?.trim();
    return v ? v : undefined;
  };
  const page = Number(qs.get("page"));
  const limit = Number(qs.get("limit"));
  return {
    from: pick("from") ?? win.from,
    to: pick("to") ?? win.to,
    repo: pick("repo"),
    role: pick("role"),
    runtime: pick("runtime"),
    model: pick("model"),
    status: pick("status"),
    ...(Number.isInteger(page) && page >= 1 ? { page } : {}),
    ...(Number.isInteger(limit) && limit >= 1 ? { limit: Math.min(limit, EXECUTION_REPORT_MAX_LIMIT) } : {}),
  };
}

/** Nearest-rank P50/P95 over comparable non-null observations; n = 0 → nulls. */
export function nearestRankPercentiles(
  values: Array<number | null | undefined>,
  quality: EvidenceQuality = "exact",
  reasons: string[] = []
): PercentileStat {
  const sorted = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { p50: null, p95: null, n: 0, quality: "unavailable", reasons: ["no_observations"] };
  const rank = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))]!;
  return { p50: rank(50), p95: rank(95), n, quality, reasons };
}

/** Sum over known values only; known = 0 → unavailable (never 0). */
export function coverageSum(
  values: Array<number | null | undefined>,
  qualityOfKnown: EvidenceQuality = "exact",
  reasonsOfKnown: string[] = []
): CoverageSum {
  const knownValues = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const total = values.length;
  const known = knownValues.length;
  if (known === 0) {
    return {
      sum: null,
      known,
      total,
      quality: "unavailable",
      reasons: total === 0 ? ["no_observations"] : ["missing_provider_metadata"],
    };
  }
  const reasons = [...reasonsOfKnown];
  if (known < total) reasons.push("partial_sample");
  return {
    sum: knownValues.reduce((a, b) => a + b, 0),
    known,
    total,
    quality: qualityOfKnown,
    reasons,
  };
}

/** Cell text for a covered sum: "Unavailable" when nothing is known, else "sum (k/t known)". */
export function coverageCellText(stat: Pick<CoverageSum, "sum" | "known" | "total">, format: (n: number) => string): string {
  if (stat.sum === null || stat.known === 0) return "Unavailable";
  if (stat.known < stat.total) return `${format(stat.sum)} (${stat.known}/${stat.total} known)`;
  return format(stat.sum);
}

/** "n" always shown; cohorts below threshold are flagged sparse, never hidden. */
export function sampleLabel(n: number): string {
  return n < SPARSE_SAMPLE_THRESHOLD ? `n=${n} (sparse)` : `n=${n}`;
}

export function isSparseSample(n: number): boolean {
  return n < SPARSE_SAMPLE_THRESHOLD;
}

/** Percentile cell: value + sample count, or "Unavailable" when n = 0. */
export function percentileCellText(stat: Pick<PercentileStat, "p50" | "p95" | "n">, format: (n: number) => string): string {
  if (stat.n === 0 || (stat.p50 === null && stat.p95 === null)) return "Unavailable";
  const fmt = (v: number | null) => (v === null ? "–" : format(v));
  return `P50 ${fmt(stat.p50)} · P95 ${fmt(stat.p95)} (${sampleLabel(stat.n)})`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatMs(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m ${rest}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatRate(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return "Unavailable";
  return `${(r * 100).toFixed(1)}%`;
}
