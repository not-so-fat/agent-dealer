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
  retryTitle: string;
  tokensInText: string;
  tokensOutText: string;
  costText: string;
  costIncomplete: boolean;
  durationText: string;
  failedCostText: string;
  failedTokensText: string;
  failedDurationText: string;
  failedIncomplete: boolean;
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
    retryTitle: "Extra attempts after a terminal attempt in the same issue/role/round ÷ attempts",
    tokensInText: coverageCellText(row.tokensIn, formatCount),
    tokensOutText: coverageCellText(row.tokensOut, formatCount),
    costText: coverageCellText(row.costUsd, formatUsd),
    costIncomplete: row.costUsd.known < row.costUsd.total,
    durationText: coverageCellText(row.durationMs, formatMs),
    failedCostText: coverageCellText(row.failedCostUsd, formatUsd),
    failedTokensText: `${coverageCellText(row.failedTokensIn, formatCount)} in · ${coverageCellText(row.failedTokensOut, formatCount)} out`,
    failedDurationText: coverageCellText(row.failedDurationMs, formatMs),
    failedIncomplete:
      row.failedCostUsd.known < row.failedCostUsd.total ||
      row.failedTokensIn.known < row.failedTokensIn.total ||
      row.failedTokensOut.known < row.failedTokensOut.total ||
      row.failedDurationMs.known < row.failedDurationMs.total,
    sparse: row.attempts > 0 && isSparseSample(row.attempts),
  };
}

export interface FailureDisplayEntry {
  code: string;
  domain: string;
  countText: string;
  shareText: string;
  /** Share denominator: failed issues in scope (explicit, never implied). */
  shareTitle: string;
  isUnknown: boolean;
  blurb: string;
  issueIds: string[];
  hiddenIssueCount: number;
}

export function toFailureDisplay(entry: FailureDistributionEntry, failedTotal: number): FailureDisplayEntry {
  return {
    code: entry.code,
    domain: entry.domain,
    countText: formatCount(entry.count),
    shareText: formatRate(entry.share),
    shareTitle:
      failedTotal > 0
        ? `${formatCount(entry.count)} of ${formatCount(failedTotal)} issues with a failed attempt`
        : "No issues with a failed attempt in scope",
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
  const failedTotal = entries.reduce((n, e) => n + e.count, 0);
  return entries.map((e) => toFailureDisplay(e, failedTotal));
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

/**
 * Form state from the raw URL search, without injected window defaults: only
 * dates the user actually chose appear in the date inputs, so Apply never
 * writes implicit from/to into the URL and the default window keeps following
 * the API's conservative window instead of the client clock.
 */
export function searchToForm(search: string): ReportFormState {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pick = (k: string): string => qs.get(k)?.trim() ?? "";
  return {
    fromDate: isoToDateInput(pick("from")),
    toDate: isoToDateInput(pick("to")),
    repo: pick("repo"),
    role: pick("role"),
    runtime: pick("runtime"),
    model: pick("model"),
    status: pick("status"),
  };
}

/**
 * Pagination from the applied URL query with only `page` changed: draft form
 * edits are never applied by Previous/Next, and no other param is touched.
 * Page 1 is canonicalized away (omitted) to match filter serialization.
 */
export function setPageQuery(search: string, page: number): string {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (page <= 1) qs.delete("page");
  else qs.set("page", String(Math.floor(page)));
  qs.sort();
  return qs.toString();
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
