// NOT-175: pure view-model for the Execution report page (no React/DOM —
// tested with node:test via tsc, see executionReport.test.ts). The page renders
// these display rows; every string decision (N/A vs N/M known, sparse
// flags, unknown-bucket emphasis) lives here so tests pin it without a browser.
import {
  coverageCellText,
  formatCompactCount,
  formatCount,
  formatMs,
  formatRate,
  formatUsd,
  isSparseSample,
  percentileCellText,
  sampleLabel,
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
  /** NOT-244 structured success readouts: percentage separate from evidence. */
  issueSuccessDisplay: SuccessDisplay;
  attemptSuccessDisplay: SuccessDisplay;
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
  /** NOT-229 structured readouts: values kept separate from their labels/notes. */
  wall: PercentileDisplay;
  envelope: PercentileDisplay;
  tokensIn: CoverageDisplay;
  tokensOut: CoverageDisplay;
  cost: CoverageDisplay;
  duration: CoverageDisplay;
  failedCost: CoverageDisplay;
  failedTokensIn: CoverageDisplay;
  failedTokensOut: CoverageDisplay;
  failedDuration: CoverageDisplay;
}

/**
 * NOT-229: percentile as structured parts — P50/P95 values separate from
 * their labels, sample size/sparse as supporting text. `available === false`
 * renders one `N/A` state with no P50/P95 numbers.
 */
export interface PercentileDisplay {
  available: boolean;
  p50Text: string | null;
  p95Text: string | null;
  /** Supporting sample note, e.g. `n=2 (sparse)`; never part of the value. */
  sampleText: string;
  sampleTitle: string;
  sparse: boolean;
}

/**
 * NOT-229: coverage sum as structured parts — the known aggregate stays the
 * primary value while `known/total` evidence is a separate note. Missing
 * metadata is N/A, never zero. With `compact`, the visible value is
 * shortened (tokens) and `exactText` carries the full comma-formatted value
 * for accessible/title text.
 */
export interface CoverageDisplay {
  available: boolean;
  valueText: string;
  exactText: string | null;
  noteText: string | null;
  noteTitle: string | null;
  incomplete: boolean;
}

export function toPercentileDisplay(
  stat: { p50: number | null; p95: number | null; n: number },
  format: (n: number) => string
): PercentileDisplay {
  if (stat.n === 0 || (stat.p50 === null && stat.p95 === null)) {
    return {
      available: false,
      p50Text: null,
      p95Text: null,
      sampleText: "n=0",
      sampleTitle: "No observations in this cohort",
      sparse: true,
    };
  }
  return {
    available: true,
    p50Text: stat.p50 === null ? null : format(stat.p50),
    p95Text: stat.p95 === null ? null : format(stat.p95),
    sampleText: sampleLabel(stat.n),
    sampleTitle: `Sample size ${stat.n}${isSparseSample(stat.n) ? " — fewer than 5 observations, compare with care" : ""}`,
    sparse: isSparseSample(stat.n),
  };
}

export function toCoverageDisplay(
  stat: { sum: number | null; known: number; total: number },
  format: (n: number) => string,
  opts?: { compact?: boolean }
): CoverageDisplay {
  if (stat.sum === null || stat.known === 0) {
    return {
      // NOT-244: Reports-page missing copy is `N/A` — never zero, 0%, or a dash.
      available: false,
      valueText: "N/A",
      exactText: null,
      noteText: null,
      noteTitle: null,
      incomplete: stat.known < stat.total,
    };
  }
  const exact = format(stat.sum);
  const valueText = opts?.compact ? formatCompactCount(stat.sum) : exact;
  const incomplete = stat.known < stat.total;
  return {
    available: true,
    valueText,
    exactText: opts?.compact ? exact : null,
    noteText: incomplete ? `${formatCount(stat.known)}/${formatCount(stat.total)} known` : null,
    noteTitle: incomplete ? "Partial sample — missing provider metadata is excluded, never zero" : null,
    incomplete,
  };
}

/**
 * NOT-244: success as structured parts — the percentage stays the primary
 * value while the denominator evidence (`74/86` + noun) is a separate
 * fragment. Missing data reads `N/A`, never zero, 0%, or a dash.
 */
export interface SuccessDisplay {
  available: boolean;
  /** Primary percentage, e.g. `86.0%`; `N/A` when missing. */
  valueText: string;
  /** Denominator counts, e.g. `74/86`; null when missing. */
  evidenceCounts: string | null;
  /** Denominator noun, e.g. `closed` / `terminal`; null when missing. */
  evidenceNoun: string | null;
  /** Exact definition for title/accessibility text. */
  title: string;
}

export function toSuccessDisplay(
  value: number | null,
  denominator: number,
  closedNoun: string
): SuccessDisplay {
  if (value === null || denominator === 0) {
    return {
      available: false,
      valueText: "N/A",
      evidenceCounts: null,
      evidenceNoun: null,
      title: `No ${closedNoun} in this cohort`,
    };
  }
  return {
    available: true,
    valueText: formatRate(value),
    evidenceCounts: `${formatCount(Math.round(value * denominator))}/${formatCount(denominator)}`,
    evidenceNoun: closedNoun,
    title: `Exact share over ${denominator} ${closedNoun}`,
  };
}

/** "50.0% (1/2 closed)" or an explicit N/A with the missing denominator. */
export function successText(value: number | null, denominator: number, closedNoun: string): {
  text: string;
  title: string;
} {
  const display = toSuccessDisplay(value, denominator, closedNoun);
  if (!display.available) {
    return { text: display.valueText, title: display.title };
  }
  return {
    text: `${display.valueText} (${display.evidenceCounts} ${display.evidenceNoun})`,
    title: display.title,
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
    issueSuccessDisplay: toSuccessDisplay(row.issueSuccess, row.issueSuccessDenominator, "closed"),
    attemptSuccessDisplay: toSuccessDisplay(row.attemptSuccess, row.attemptSuccessDenominator, "terminal attempts"),
    wallText: percentileCellText(row.sessionWallMs, formatMs),
    envelopeText: percentileCellText(row.spawnEnvelopeMs, formatMs),
    // NOT-244: a null retry rate is missing, never 0% — Reports copy reads N/A.
    retryText: row.retryRate === null ? "N/A" : formatRate(row.retryRate),
    retryTitle: "Extra attempts after a terminal attempt in the same issue/role/round ÷ attempts",
    tokensInText: coverageCellText(row.tokensIn, formatCount),
    tokensOutText: coverageCellText(row.tokensOut, formatCount),
    costText: coverageCellText(row.costUsd, formatUsd),
    costIncomplete: row.costUsd.known < row.costUsd.total,
    durationText: coverageCellText(row.durationMs, formatMs),
    failedCostText: coverageCellText(row.failedCostUsd, formatUsd),
    failedTokensText: `${coverageCellText(row.failedTokensIn, formatCount)} in · ${coverageCellText(row.failedTokensOut, formatCount)} out`,
    failedDurationText: coverageCellText(row.failedDurationMs, formatMs),
    wall: toPercentileDisplay(row.sessionWallMs, formatMs),
    envelope: toPercentileDisplay(row.spawnEnvelopeMs, formatMs),
    tokensIn: toCoverageDisplay(row.tokensIn, formatCount, { compact: true }),
    tokensOut: toCoverageDisplay(row.tokensOut, formatCount, { compact: true }),
    cost: toCoverageDisplay(row.costUsd, formatUsd),
    duration: toCoverageDisplay(row.durationMs, formatMs),
    failedCost: toCoverageDisplay(row.failedCostUsd, formatUsd),
    failedTokensIn: toCoverageDisplay(row.failedTokensIn, formatCount, { compact: true }),
    failedTokensOut: toCoverageDisplay(row.failedTokensOut, formatCount, { compact: true }),
    failedDuration: toCoverageDisplay(row.failedDurationMs, formatMs),
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
  /** NOT-229 operator wording: `unknown` reads as `Cause not recorded`. */
  displayCode: string;
  /** NOT-229 subordinate explanation for the displayed code. */
  displayNote: string;
  issueIds: string[];
  hiddenIssueCount: number;
}

export function toFailureDisplay(entry: FailureDistributionEntry, failedTotal: number): FailureDisplayEntry {
  const isUnknown = entry.code === "unknown";
  return {
    code: entry.code,
    domain: entry.domain,
    countText: formatCount(entry.count),
    // NOT-244: a null share is missing, never 0% — Reports copy reads N/A.
    shareText: entry.share === null ? "N/A" : formatRate(entry.share),
    shareTitle:
      failedTotal > 0
        ? `${formatCount(entry.count)} of ${formatCount(failedTotal)} issues with a failed attempt`
        : "No issues with a failed attempt in scope",
    isUnknown,
    blurb:
      isUnknown
        ? "Ambiguous evidence — not promoted to a specific cause."
        : `Primary cause · ${entry.domain} domain`,
    displayCode: isUnknown ? "Cause not recorded" : entry.code,
    displayNote: isUnknown ? "Needs more evidence" : `Primary cause · ${entry.domain} domain`,
    issueIds: entry.issueIds,
    hiddenIssueCount: Math.max(0, entry.issueTotal - entry.issueIds.length),
  };
}

/** Unknown bucket stays visible even when it is not the largest. */
export function orderFailureDisplay(entries: FailureDistributionEntry[]): FailureDisplayEntry[] {
  const failedTotal = entries.reduce((n, e) => n + e.count, 0);
  return entries.map((e) => toFailureDisplay(e, failedTotal));
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
 * Fetch filters from the raw URL search only — no injected window defaults.
 * The page must request exactly what the URL says so an empty query hits the
 * API's conservative default window (client-clock from/to would skew it and
 * go stale on Retry). Only filter params present in the URL are sent:
 * legacy list-only `page`/`limit` params are ignored now that Reports no
 * longer renders an issue list.
 */
export function searchToFilters(search: string): ReportFilterState {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pick = (k: string): string | undefined => {
    const v = qs.get(k)?.trim();
    return v ? v : undefined;
  };
  const out: ReportFilterState = {};
  for (const k of ["from", "to", "repo", "role", "runtime", "model", "status"] as const) {
    const v = pick(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Cohort-row deep link: the report filtered by that role/runtime/model,
 * keeping the other applied filters and dropping legacy list-only
 * `page`/`limit` params.
 */
export function cohortHref(
  search: string,
  dimension: "role" | "runtime" | "model",
  key: string
): string {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  qs.set(dimension, key);
  qs.delete("page");
  qs.delete("limit");
  qs.sort();
  const s = qs.toString();
  return `/reports/execution${s ? `?${s}` : ""}`;
}

export function formToFilters(form: ReportFormState): ReportFilterState {
  return {
    from: dateInputToIso(form.fromDate, false),
    to: dateInputToIso(form.toDate, true),
    repo: form.repo.trim() || undefined,
    role: form.role || undefined,
    runtime: form.runtime.trim() || undefined,
    model: form.model.trim() || undefined,
    status: form.status.trim() || undefined,
  };
}

export type { ExecutionReportResponse };
