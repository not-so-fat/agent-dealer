import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  formatCount,
  formatMs,
  formatRate,
  formatUsd,
  serializeExecutionReportQuery,
  type ExecutionReportResponse,
} from "@agent-dealer/shared";
import { fetchExecutionAnalysis } from "../api";
import {
  RUNTIME_OPTIONS,
  ROLE_OPTIONS,
  STATUS_OPTIONS,
  cohortHref,
  formToFilters,
  issueDetailHref,
  orderFailureDisplay,
  searchToFilters,
  searchToForm,
  toCohortDisplay,
  toCoverageDisplay,
  toPercentileDisplay,
  type CohortDisplayRow,
  type CoverageDisplay,
  type PercentileDisplay,
  type ReportFormState,
} from "../lib/executionReport";

/**
 * NOT-229 metric hierarchy: the label and supporting notes render through the
 * shared `font-ui-display` token (UI chrome), while the operational value
 * stays Monaco. No font family is hard-coded — only the shared token.
 */
function Card({
  label,
  value,
  valueTitle,
  note,
}: {
  label: string;
  value: ReactNode;
  valueTitle?: string;
  note?: ReactNode;
}) {
  return (
    <div className="rounded border border-white/10 bg-panel-elevated/60 px-4 py-3">
      <p className="font-ui-display text-xs uppercase tracking-wide text-white/40">{label}</p>
      <div className="mt-1 font-mono text-lg font-semibold text-white/90 tabular-nums" title={valueTitle}>
        {value}
      </div>
      {note && <div className="mt-0.5 font-ui-display text-xs text-white/40">{note}</div>}
    </div>
  );
}

/** P50 and P95 as separate labeled values; sample size/sparse is supporting text. */
function PercentileReadout({ display, compact }: { display: PercentileDisplay; compact?: boolean }) {
  if (!display.available) {
    return <span className="font-mono text-white/45">Unavailable</span>;
  }
  const labelCls = compact
    ? "font-ui-display text-[11px] uppercase tracking-wide text-white/40"
    : "font-ui-display text-xs uppercase tracking-wide text-white/40";
  const valueCls = compact
    ? "font-mono text-sm font-medium text-white/85 tabular-nums"
    : "font-mono text-base font-semibold text-white/90 tabular-nums";
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="inline-flex items-baseline gap-x-1.5">
        <span className={labelCls}>P50</span>
        <span className={valueCls}>{display.p50Text ?? "–"}</span>
      </span>
      <span className="inline-flex items-baseline gap-x-1.5">
        <span className={labelCls}>P95</span>
        <span className={valueCls}>{display.p95Text ?? "–"}</span>
      </span>
      <span className="font-ui-display text-xs text-white/40" title={display.sampleTitle}>
        {display.sampleText}
      </span>
    </span>
  );
}

/** Known aggregate as the primary value; `known/total` evidence is a separate note. */
function CoverageReadout({ display, compact }: { display: CoverageDisplay; compact?: boolean }) {
  if (!display.available) {
    return <span className="font-mono text-white/45">Unavailable</span>;
  }
  const exact = display.exactText ?? display.valueText;
  const valueCls = compact
    ? "font-mono text-sm font-medium text-white/85 tabular-nums"
    : "font-mono text-base font-semibold text-white/90 tabular-nums";
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className={valueCls} title={exact} aria-label={exact}>
        {display.valueText}
      </span>
      {display.noteText && (
        <span className="font-ui-display text-xs text-white/40" title={display.noteTitle ?? undefined}>
          {display.noteText}
        </span>
      )}
    </span>
  );
}

export type CohortDimension = "role" | "runtime" | "model";

function CohortTable({
  caption,
  dimension,
  rows,
  cohortLink,
}: {
  caption: string;
  dimension: CohortDimension;
  rows: CohortDisplayRow[];
  cohortLink?: (dimension: CohortDimension, key: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-white/10 bg-panel-elevated/60 px-4 py-3">
        <h4 className="font-ui-display text-sm font-medium text-white/80">{caption}</h4>
        <p className="font-ui-display mt-1 text-sm text-white/45">No attempts in this dimension for these filters.</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-white/10 bg-panel-elevated/60 overflow-x-auto">
      <table className="w-full min-w-[1440px] text-sm">
        <caption className="sr-only">{caption} — sorted by name, never by cost</caption>
        <thead>
          <tr className="font-ui-display text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
            <th scope="col" className="px-4 py-2 font-medium">{caption}</th>
            <th scope="col" className="px-3 py-2 font-medium">Issues</th>
            <th scope="col" className="px-3 py-2 font-medium">Attempts</th>
            <th scope="col" className="px-3 py-2 font-medium">Issue success</th>
            <th scope="col" className="px-3 py-2 font-medium">Attempt success</th>
            <th scope="col" className="px-3 py-2 font-medium">Session wall P50/P95</th>
            <th scope="col" className="px-3 py-2 font-medium">Retry rate</th>
            <th scope="col" className="px-3 py-2 font-medium">Tokens in</th>
            <th scope="col" className="px-3 py-2 font-medium">Tokens out</th>
            <th scope="col" className="px-3 py-2 font-medium">Cost</th>
            <th scope="col" className="px-3 py-2 font-medium">Duration</th>
            <th scope="col" className="px-3 py-2 font-medium">Failed cost</th>
            <th scope="col" className="px-3 py-2 font-medium">Failed tokens</th>
            <th scope="col" className="px-3 py-2 font-medium">Failed runtime</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r) => (
            <tr key={r.key} className="tabular-nums">
              <th scope="row" className="px-4 py-2 text-left font-mono font-medium text-white/85">
                {cohortLink ? (
                  <Link
                    to={cohortLink(dimension, r.key)}
                    className="text-cyber-teal hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyber-teal/45"
                    title={`Filter the report to ${dimension} ${r.key}`}
                  >
                    {r.key}
                  </Link>
                ) : (
                  r.key
                )}
                {r.sparse && (
                  <span className="font-ui-display ml-2 text-xs font-normal text-amber-200/80" title="Fewer than 5 attempts — compare with care">
                    sparse
                  </span>
                )}
              </th>
              <td className="px-3 py-2 font-mono text-white/75">{r.issuesText}</td>
              <td className="px-3 py-2 font-mono text-white/75">{r.attemptsText}</td>
              <td className="px-3 py-2 font-mono text-white/75" title={r.issueSuccessTitle}>{r.issueSuccessText}</td>
              <td className="px-3 py-2 font-mono text-white/75" title={r.attemptSuccessTitle}>{r.attemptSuccessText}</td>
              <td className="px-3 py-2 text-white/75"><PercentileReadout display={r.wall} compact /></td>
              <td className="px-3 py-2 font-mono text-white/75" title={r.retryTitle}>{r.retryText}</td>
              <td className="px-3 py-2 text-white/75"><CoverageReadout display={r.tokensIn} compact /></td>
              <td className="px-3 py-2 text-white/75"><CoverageReadout display={r.tokensOut} compact /></td>
              <td className="px-3 py-2 text-white/75"><CoverageReadout display={r.cost} compact /></td>
              <td className="px-3 py-2 text-white/75"><CoverageReadout display={r.duration} compact /></td>
              <td className="px-3 py-2 text-white/75"><CoverageReadout display={r.failedCost} compact /></td>
              <td className="px-3 py-2 text-white/75">
                <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                  <CoverageReadout display={r.failedTokensIn} compact />
                  <span className="font-ui-display text-xs text-white/40">in</span>
                  <span className="font-ui-display text-xs text-white/40">·</span>
                  <CoverageReadout display={r.failedTokensOut} compact />
                  <span className="font-ui-display text-xs text-white/40">out</span>
                </span>
              </td>
              <td className="px-3 py-2 text-white/75"><CoverageReadout display={r.failedDuration} compact /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY_FORM: ReportFormState = {
  fromDate: "",
  toDate: "",
  repo: "",
  role: "",
  runtime: "",
  model: "",
  status: "",
};

export interface ReportContentProps {
  loading: boolean;
  error: string | null;
  report: ExecutionReportResponse | null;
  onRetry: () => void;
  /** Deep link for cohort rows (role/runtime/model filtered report views). */
  cohortLink?: (dimension: CohortDimension, key: string) => string;
}

/**
 * Pure presentational view of the report states (loading, error, empty,
 * partial). No hooks or fetching — renderable to static markup in
 * tests without a browser.
 */
export function ReportContent({ loading, error, report, onRetry, cohortLink }: ReportContentProps) {
  const summary = report?.summary ?? null;
  const failures = useMemo(() => (report ? orderFailureDisplay(report.failures) : []), [report]);
  const failedTotal = useMemo(
    () => (report ? report.failures.reduce((n, f) => n + f.count, 0) : 0),
    [report]
  );
  return (
    <div aria-live="polite">
      {loading && <p role="status" className="text-sm text-white/50">Loading execution report…</p>}
      {!loading && error && (
        <div className="rounded border border-red-400/30 bg-red-500/10 px-4 py-3" role="alert">
          <p className="font-ui-display text-sm text-red-200">Couldn’t load the execution report: {error}</p>
          <button
            type="button"
            className="font-ui-display mt-2 px-3 py-1.5 text-sm rounded border border-red-300/40 text-red-100 hover:bg-red-500/20"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && report && summary && (
        <div className="space-y-6">
          {report.meta.partial && (
            <div className="rounded border border-amber-300/30 bg-amber-400/10 px-4 py-3">
              <p className="font-ui-display text-sm text-amber-100 font-medium">Partial metadata</p>
              <ul className="font-ui-display mt-1 list-disc list-inside text-sm text-amber-100/80">
                {report.meta.partialReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {summary.issues === 0 ? (
            <p className="font-ui-display text-sm text-white/45">
              No issues match these filters in this window. Widen the date range or clear filters.
            </p>
          ) : (
            <>
              <section aria-label="Summary">
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  <Card
                    label="Issue success"
                    value={formatRate(summary.issueSuccess)}
                    valueTitle={`done / (done + closed), denominator ${summary.closedIssues}`}
                    note={`${formatCount(summary.issues)} issues · ${formatCount(summary.closedIssues)} closed`}
                  />
                  <Card
                    label="Attempt success"
                    value={formatRate(summary.attemptSuccess)}
                    valueTitle={`done sessions / terminal sessions, denominator ${summary.terminalAttempts}`}
                    note={`${formatCount(summary.attempts)} attempts · ${formatCount(summary.terminalAttempts)} terminal`}
                  />
                  <Card
                    label="Retry rate"
                    value={formatRate(summary.retryRate)}
                    valueTitle={`${summary.retryExtraAttempts} extra attempts after a terminal attempt in the same issue/role/round ÷ ${summary.attempts} attempts`}
                    note={`Reuse rate ${formatRate(summary.reuseRate)} over ${formatCount(summary.reuseDenominator)} reviewer sessions with input SHA`}
                  />
                  <Card
                    label="Human wait"
                    value={formatMs(summary.humanWaitMs)}
                    note={`${formatCount(summary.interventions)} interventions`}
                  />
                  <Card
                    label="Session wall P50/P95"
                    value={<PercentileReadout display={toPercentileDisplay(summary.sessionWallMs, formatMs)} />}
                    note="Session bookkeeping proxy — never CLI runtime"
                  />
                  <Card
                    label="Spawn envelope P50/P95"
                    value={<PercentileReadout display={toPercentileDisplay(summary.spawnEnvelopeMs, formatMs)} />}
                    note="Coordinator-measured; includes slot wait + post-exit work"
                  />
                  <Card
                    label="Checkpoint latency P50/P95"
                    value={<PercentileReadout display={toPercentileDisplay(summary.checkpointMs, formatMs)} />}
                    note="Session start → first heartbeat"
                  />
                  <Card
                    label="Reviewer rounds (avg)"
                    value={summary.avgReviewerRounds === null ? "Unavailable" : summary.avgReviewerRounds.toFixed(1)}
                    note={`Change-request rate ${formatRate(summary.changeRequestRate)} over ${formatCount(summary.reviewedIssues)} reviewed`}
                  />
                </div>
              </section>

              <section aria-label="Failed-attempt waste">
                <h3 className="font-ui-display text-sm font-medium text-white/80 mb-2">Failed-attempt waste (known values only)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Card label="Failed cost" value={<CoverageReadout display={toCoverageDisplay(summary.failedCostUsd, formatUsd)} />} />
                  <Card
                    label="Failed tokens"
                    value={
                      <span className="inline-flex flex-wrap items-baseline gap-x-2">
                        <CoverageReadout display={toCoverageDisplay(summary.failedTokensIn, formatCount, { compact: true })} />
                        <span className="font-ui-display text-xs font-normal text-white/40">in</span>
                        <span className="font-ui-display text-xs font-normal text-white/40">·</span>
                        <CoverageReadout display={toCoverageDisplay(summary.failedTokensOut, formatCount, { compact: true })} />
                        <span className="font-ui-display text-xs font-normal text-white/40">out</span>
                      </span>
                    }
                  />
                  <Card label="Failed runtime" value={<CoverageReadout display={toCoverageDisplay(summary.failedDurationMs, formatMs)} />} />
                </div>
              </section>

              <section aria-label="Phase wall time">
                <h3 className="font-ui-display text-sm font-medium text-white/80 mb-2">Phase wall time</h3>
                <p className="font-ui-display text-xs text-white/40 mb-2">
                  Composed from the execution-analysis read model over the same issues:
                  exact when agent start/complete events are recorded, inferred
                  usage-envelope backfill otherwise. Rows without evidence read
                  Unavailable — never a guess. See per-row reasons.
                </p>
                <div className="rounded border border-white/10 bg-panel-elevated/60 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <caption className="sr-only">
                      Exclusive phase wall times. Boundaries without defensible evidence are Unavailable.
                    </caption>
                    <thead>
                      <tr className="font-ui-display text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                        <th scope="col" className="px-4 py-2 font-medium">Phase</th>
                        <th scope="col" className="px-3 py-2 font-medium">P50 / P95</th>
                        <th scope="col" className="px-3 py-2 font-medium">Why</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {summary.phaseWallMs.map((p) => (
                        <tr key={p.phase} className="tabular-nums">
                          <th scope="row" className="px-4 py-2 text-left font-mono font-medium text-white/85">{p.phase}</th>
                          <td className="px-3 py-2 text-white/75"><PercentileReadout display={toPercentileDisplay(p.stat, formatMs)} compact /></td>
                          <td className="font-ui-display px-3 py-2 text-xs text-white/45">{p.stat.reasons.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section aria-label="Comparisons" className="space-y-4">
                <h3 className="font-ui-display text-sm font-medium text-white/80">
                  Comparisons <span className="font-normal text-white/40">— sorted by name, never by cost</span>
                </h3>
                <CohortTable caption="By role" dimension="role" rows={report.byRole.map(toCohortDisplay)} cohortLink={cohortLink} />
                <CohortTable caption="By runtime" dimension="runtime" rows={report.byRuntime.map(toCohortDisplay)} cohortLink={cohortLink} />
                <CohortTable caption="By model" dimension="model" rows={report.byModel.map(toCohortDisplay)} cohortLink={cohortLink} />
              </section>

              <section aria-label="Why attempts failed">
                <h3 className="font-ui-display text-sm font-medium text-white/80 mb-2">Why attempts failed</h3>
                <p className="font-ui-display text-xs text-white/40 mb-2">
                  Each issue with a failed attempt is counted once using its primary
                  actionable cause, and may later have recovered. Share is over{" "}
                  {formatCount(failedTotal)} failed {failedTotal === 1 ? "issue" : "issues"} in scope.
                </p>
                {failures.length === 0 ? (
                  <p className="font-ui-display text-sm text-white/45">No failed attempts in this window.</p>
                ) : (
                  <div className="rounded border border-white/10 bg-panel-elevated/60 overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <caption className="sr-only">
                        Why attempts failed: each issue counted once by primary cause. Cause not recorded is its own bucket and is never promoted.
                      </caption>
                      <thead>
                        <tr className="font-ui-display text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                          <th scope="col" className="px-4 py-2 font-medium">Failure</th>
                          <th scope="col" className="px-3 py-2 font-medium">Domain</th>
                          <th scope="col" className="px-3 py-2 font-medium">Issues</th>
                          <th scope="col" className="px-3 py-2 font-medium">Share</th>
                          <th scope="col" className="px-3 py-2 font-medium">Example issues</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {failures.map((f) => (
                          <tr
                            key={f.code}
                            className={f.isUnknown ? "bg-amber-400/5 tabular-nums" : "tabular-nums"}
                          >
                            <th scope="row" className="px-4 py-2 text-left text-white/85">
                              <span className="font-ui-display block font-medium" title={f.code}>
                                {f.displayCode}
                              </span>
                              <span className={`font-ui-display block text-xs font-normal ${f.isUnknown ? "text-amber-200/90" : "text-white/40"}`}>
                                {f.displayNote}
                              </span>
                            </th>
                            <td className="px-3 py-2 font-mono text-white/75">{f.domain}</td>
                            <td className="px-3 py-2 font-mono text-white/75">{f.countText}</td>
                            <td className="px-3 py-2 font-mono text-white/75" title={f.shareTitle}>{f.shareText}</td>
                            <td className="px-3 py-2">
                              <span className="flex flex-wrap gap-x-3 gap-y-1">
                                {f.issueIds.map((id) => (
                                  <Link
                                    key={id}
                                    to={issueDetailHref(id)}
                                    className="text-cyber-teal hover:underline font-mono text-xs"
                                  >
                                    {id.slice(0, 8)}
                                  </Link>
                                ))}
                                {f.hiddenIssueCount > 0 && (
                                  <span className="font-ui-display text-xs text-white/40">+{f.hiddenIssueCount} more</span>
                                )}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ExecutionReportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  // Fetch exactly what the URL says: no injected window defaults, so an
  // empty query hits the API's conservative window and Retry never reuses a
  // stale client-clock `to`.
  const fetchFilters = useMemo(() => searchToFilters(search), [search]);
  // Draft form state tracks the raw URL only: injected window defaults stay
  // out, so Apply only sends dates the user chose.
  const [form, setForm] = useState<ReportFormState>(() => searchToForm(search));
  const [report, setReport] = useState<ExecutionReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Retry must refetch even when the URL is unchanged (same query string
  // would not retrigger the fetch effect), so it bumps a counter instead.
  const [reloadTick, setReloadTick] = useState(0);

  // Filters live in the URL: reload and back/forward restore the same report.
  useEffect(() => {
    setForm(searchToForm(search));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchExecutionAnalysis(fetchFilters)
      .then((r) => {
        if (!cancelled) {
          setReport(r);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, reloadTick]);

  const apply = (next: ReportFormState) => {
    const qs = serializeExecutionReportQuery(formToFilters(next));
    setSearchParams(qs ? Object.fromEntries(new URLSearchParams(qs)) : {});
  };

  const set = (patch: Partial<ReportFormState>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-ui-display text-lg font-semibold text-white/90">Execution report</h2>
        {report && (
          <p className="font-ui-display text-xs text-white/40">
            Window {new Date(report.window.from).toLocaleDateString()} –{" "}
            {new Date(report.window.to).toLocaleDateString()} · generated{" "}
            {new Date(report.meta.generatedAt).toLocaleTimeString()}
          </p>
        )}
      </div>
      <p className="font-ui-display text-sm text-white/50 mb-4">
        Reliability, latency, retry waste, and metadata coverage by role, runtime, and model.
        Missing cost/token data reads as Unavailable — never as zero.
      </p>

      <form
        aria-label="Report filters"
        className="mb-4 p-4 rounded border border-white/10 bg-panel-elevated/60"
        onSubmit={(e) => {
          e.preventDefault();
          apply(form);
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">From</span>
            <input
              type="date"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.fromDate}
              onChange={(e) => set({ fromDate: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">To</span>
            <input
              type="date"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.toDate}
              onChange={(e) => set({ toDate: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">Repository</span>
            <input
              type="text"
              placeholder="github.com/owner/repo"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.repo}
              onChange={(e) => set({ repo: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">Role</span>
            <select
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.role}
              onChange={(e) => set({ role: e.target.value })}
            >
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">Runtime</span>
            <select
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.runtime}
              onChange={(e) => {
                set({ runtime: e.target.value });
              }}
            >
              <option value="">All runtimes</option>
              {RUNTIME_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
              <option value="unknown">unknown (missing metadata)</option>
              {form.runtime && !(RUNTIME_OPTIONS as readonly string[]).includes(form.runtime) && (
                <option value={form.runtime}>{form.runtime} (from URL)</option>
              )}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">Model</span>
            <input
              type="text"
              placeholder="Any model"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="font-ui-display block text-xs text-white/50 mb-1">Issue status</span>
            <select
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-gold px-4">Apply</button>
            <button
              type="button"
              className="font-ui-display px-4 py-2 text-sm text-white/60 hover:text-white"
              onClick={() => {
                setForm(EMPTY_FORM);
                setSearchParams({});
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </form>

      <ReportContent
        loading={loading}
        error={error}
        report={report}
        onRetry={() => setReloadTick((t) => t + 1)}
        cohortLink={(dimension, key) => cohortHref(search, dimension, key)}
      />
    </div>
  );
}
