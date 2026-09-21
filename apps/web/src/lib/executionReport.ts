// NOT-175: pure view-model for the Execution report page (no React/DOM —
// tested with node:test via tsc, see executionReport.test.ts). The page renders
// these display rows; every string decision (Unavailable vs N/M known, sparse
// flags, unknown-bucket emphasis) lives here so tests pin it without a browser.
import {
  coverageCellText,
  formatCount,
  formatMs,
  formatRate,
  formatUsd,
  isSparseSample,
  percentileCellText,
  type CohortRow,
  type ExecutionReportResponse,
  type FailureDistributionEntry,
  type ReportFilterState,
} from "@agent-dealer/shared";

export const ROLE_OPTIONS = ["developer", "reviewer", "legacy"] as const;
export const RUNTIME_OPTIONS = ["claude_code", "cursor_local", "codex_local"] as const;
export const STATUS_OPTIONS = [
  "ready",
  "developing",
  "reviewing",
  "repairing",
  "final_review",
  "needs_human",
  "done",
  "closed",
] as const;

export interface CohortDisplayRow {
  key: string;
  issuesText: string;
  attemptsText: string;
  issueSuccessText: string;
  issueSuccessTitle: string;
  attemptSuccessText: string;
  attemptSuccessTitle: string;
  wallText: string;
  envelopeText: string;
  retryText: string;
  tokensInText: string;
  tokensOutText: string;
  costText: string;
  costIncomplete: boolean;
  durationText: string;
  sparse: boolean;
}

/** "50.0% (1/2 closed)" or an explicit Unavailable with the missing denominator. */
export function successText(value: number | null, denominator: number, closedNoun: string): {
  text: string;
  title: string;
} {
  if (value === null || denominator === 0) {
    return { text: "Unavailable", title: `No ${closedNoun} in this cohort` };
  }
  return {
    text: `${formatRate(value)} (${formatCount(Math.round(value * denominator))}/${formatCount(denominator)} ${closedNoun})`,
    title: `Exact share over ${denominator} ${closedNoun}`,
  };
}

export function toCohortDisplay(row: CohortRow): CohortDisplayRow {
  const issue = successText(row.issueSuccess, row.issueSuccessDenominator, "closed");
  const attempt = successText(row.attemptSuccess, row.attemptSuccessDenominator, "terminal attempts");
  return {
    key: row.key,
    issuesText: formatCount(row.issues),
    attemptsText: formatCount(row.attempts),
    issueSuccessText: issue.text,
    issueSuccessTitle: issue.title,
    attemptSuccessText: attempt.text,
    attemptSuccessTitle: attempt.title,
    wallText: percentileCellText(row.sessionWallMs, formatMs),
    envelopeText: percentileCellText(row.spawnEnvelopeMs, formatMs),
    retryText: formatRate(row.retryRate),
    tokensInText: coverageCellText(row.tokensIn, formatCount),
    tokensOutText: coverageCellText(row.tokensOut, formatCount),
    costText: coverageCellText(row.costUsd, formatUsd),
    costIncomplete: row.costUsd.known < row.costUsd.total,
    durationText: coverageCellText(row.durationMs, formatMs),
    sparse: row.attempts > 0 && isSparseSample(row.attempts),
  };
}

export interface FailureDisplayEntry {
  code: string;
  domain: string;
  countText: string;
  shareText: string;
  isUnknown: boolean;
  blurb: string;
  issueIds: string[];
  hiddenIssueCount: number;
}

export function toFailureDisplay(entry: FailureDistributionEntry): FailureDisplayEntry {
  return {
    code: entry.code,
    domain: entry.domain,
    countText: formatCount(entry.count),
    shareText: formatRate(entry.share),
    isUnknown: entry.code === "unknown",
    blurb:
      entry.code === "unknown"
        ? "Ambiguous evidence — not promoted to a specific cause."
        : `Primary cause · ${entry.domain} domain`,
    issueIds: entry.issueIds,
    hiddenIssueCount: Math.max(0, entry.issueTotal - entry.issueIds.length),
  };
}

/** Unknown bucket stays visible even when it is not the largest. */
export function orderFailureDisplay(entries: FailureDistributionEntry[]): FailureDisplayEntry[] {
  return entries.map(toFailureDisplay);
}

export function paginationText(p: { page: number; limit: number; total: number; totalPages: number }): string {
  if (p.total === 0) return "No issues match these filters";
  const start = (p.page - 1) * p.limit + 1;
  const end = Math.min(p.total, p.page * p.limit);
  return `Showing ${start}–${end} of ${formatCount(p.total)} issues · page ${p.page} of ${p.totalPages}`;
}

export function issueDetailHref(issueId: string): string {
  return `/issues/${issueId}`;
}

/** Date-input (YYYY-MM-DD) → day-boundary ISO; undefined when blank/invalid. */
export function dateInputToIso(date: string | undefined, endOfDay: boolean): string | undefined {
  if (!date?.trim()) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return undefined;
  return endOfDay ? `${date.trim()}T23:59:59.999Z` : `${date.trim()}T00:00:00.000Z`;
}

/** Report ISO → date-input value for the filter form. */
export function isoToDateInput(iso: string | undefined): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : "";
}

export interface ReportFormState {
  fromDate: string;
  toDate: string;
  repo: string;
  role: string;
  runtime: string;
  model: string;
  status: string;
}

export function filtersToForm(f: ReportFilterState): ReportFormState {
  return {
    fromDate: isoToDateInput(f.from),
    toDate: isoToDateInput(f.to),
    repo: f.repo ?? "",
    role: f.role ?? "",
    runtime: f.runtime ?? "",
    model: f.model ?? "",
    status: f.status ?? "",
  };
}

export function formToFilters(form: ReportFormState, page?: number): ReportFilterState {
  return {
    from: dateInputToIso(form.fromDate, false),
    to: dateInputToIso(form.toDate, true),
    repo: form.repo.trim() || undefined,
    role: form.role || undefined,
    runtime: form.runtime.trim() || undefined,
    model: form.model.trim() || undefined,
    status: form.status.trim() || undefined,
    ...(page && page > 1 ? { page } : {}),
  };
}

export type { ExecutionReportResponse };
