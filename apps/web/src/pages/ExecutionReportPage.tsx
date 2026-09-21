import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  coverageCellText,
  formatCount,
  formatMs,
  formatRate,
  formatUsd,
  parseExecutionReportQuery,
  percentileCellText,
  serializeExecutionReportQuery,
  type ExecutionReportResponse,
} from "@agent-dealer/shared";
import { fetchExecutionAnalysis } from "../api";
import {
  RUNTIME_OPTIONS,
  ROLE_OPTIONS,
  STATUS_OPTIONS,
  filtersToForm,
  formToFilters,
  issueDetailHref,
  orderFailureDisplay,
  paginationText,
  toCohortDisplay,
  type CohortDisplayRow,
  type ReportFormState,
} from "../lib/executionReport";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import type { IssueStatus } from "@agent-dealer/shared";

function Card({ label, value, title, hint }: { label: string; value: string; title?: string; hint?: string }) {
  return (
    <div className="rounded border border-white/10 bg-panel-elevated/60 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white/90 tabular-nums" title={title}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-white/40">{hint}</p>}
    </div>
  );
}

function CohortTable({ caption, rows }: { caption: string; rows: CohortDisplayRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-white/10 bg-panel-elevated/60 px-4 py-3">
        <h4 className="text-sm font-medium text-white/80">{caption}</h4>
        <p className="mt-1 text-sm text-white/45">No attempts in this dimension for these filters.</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-white/10 bg-panel-elevated/60 overflow-x-auto">
      <table className="w-full min-w-[880px] text-sm">
        <caption className="sr-only">{caption} — sorted by name, never by cost</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
            <th scope="col" className="px-4 py-2 font-medium">{caption}</th>
            <th scope="col" className="px-3 py-2 font-medium">Issues</th>
            <th scope="col" className="px-3 py-2 font-medium">Attempts</th>
            <th scope="col" className="px-3 py-2 font-medium">Issue success</th>
            <th scope="col" className="px-3 py-2 font-medium">Attempt success</th>
            <th scope="col" className="px-3 py-2 font-medium">Session wall P50/P95</th>
            <th scope="col" className="px-3 py-2 font-medium">Tokens in</th>
            <th scope="col" className="px-3 py-2 font-medium">Tokens out</th>
            <th scope="col" className="px-3 py-2 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r) => (
            <tr key={r.key} className="tabular-nums">
              <th scope="row" className="px-4 py-2 text-left font-medium text-white/85">
                {r.key}
                {r.sparse && (
                  <span className="ml-2 text-xs font-normal text-amber-200/80" title="Fewer than 5 attempts — compare with care">
                    sparse
                  </span>
                )}
              </th>
              <td className="px-3 py-2 text-white/75">{r.issuesText}</td>
              <td className="px-3 py-2 text-white/75">{r.attemptsText}</td>
              <td className="px-3 py-2 text-white/75" title={r.issueSuccessTitle}>{r.issueSuccessText}</td>
              <td className="px-3 py-2 text-white/75" title={r.attemptSuccessTitle}>{r.attemptSuccessText}</td>
              <td className="px-3 py-2 text-white/75">{r.wallText}</td>
              <td className="px-3 py-2 text-white/75">{r.tokensInText}</td>
              <td className="px-3 py-2 text-white/75">{r.tokensOutText}</td>
              <td
                className="px-3 py-2 text-white/75"
                title={r.costIncomplete ? "Partial sample — missing provider metadata is excluded, never zero" : undefined}
              >
                {r.costText}
              </td>
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

export default function ExecutionReportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const filters = useMemo(() => parseExecutionReportQuery(search), [search]);
  const [form, setForm] = useState<ReportFormState>(() => filtersToForm(filters));
  const [report, setReport] = useState<ExecutionReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters live in the URL: reload and back/forward restore the same report.
  useEffect(() => {
    setForm(filtersToForm(filters));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchExecutionAnalysis(filters)
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
  }, [search]);

  const apply = (next: ReportFormState, page?: number) => {
    const qs = serializeExecutionReportQuery(formToFilters(next, page));
    setSearchParams(qs ? Object.fromEntries(new URLSearchParams(qs)) : {});
  };

  const set = (patch: Partial<ReportFormState>) => setForm((f) => ({ ...f, ...patch }));
  const summary = report?.summary ?? null;
  const failures = useMemo(() => (report ? orderFailureDisplay(report.failures) : []), [report]);

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-lg font-semibold text-white/90">Execution report</h2>
        {report && (
          <p className="text-xs text-white/40">
            Window {new Date(report.window.from).toLocaleDateString()} –{" "}
            {new Date(report.window.to).toLocaleDateString()} · generated{" "}
            {new Date(report.meta.generatedAt).toLocaleTimeString()}
          </p>
        )}
      </div>
      <p className="text-sm text-white/50 mb-4">
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
            <span className="block text-xs text-white/50 mb-1">From</span>
            <input
              type="date"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.fromDate}
              onChange={(e) => set({ fromDate: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">To</span>
            <input
              type="date"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.toDate}
              onChange={(e) => set({ toDate: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Repository</span>
            <input
              type="text"
              placeholder="github.com/owner/repo"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.repo}
              onChange={(e) => set({ repo: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Role</span>
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
            <span className="block text-xs text-white/50 mb-1">Runtime</span>
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
            </select>
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Model</span>
            <input
              type="text"
              placeholder="Any model"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Issue status</span>
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
              className="px-4 py-2 text-sm text-white/60 hover:text-white"
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

      <div aria-live="polite">
        {loading && (
          <p role="status" className="text-sm text-white/50">Loading execution report…</p>
        )}
        {!loading && error && (
          <div className="rounded border border-red-400/30 bg-red-500/10 px-4 py-3" role="alert">
            <p className="text-sm text-red-200">Couldn’t load the execution report: {error}</p>
            <button
              type="button"
              className="mt-2 px-3 py-1.5 text-sm rounded border border-red-300/40 text-red-100 hover:bg-red-500/20"
              onClick={() => apply(form, filters.page)}
            >
              Retry
            </button>
          </div>
        )}
        {!loading && !error && report && summary && (
          <div className="space-y-6">
            {report.meta.partial && (
              <div className="rounded border border-amber-300/30 bg-amber-400/10 px-4 py-3">
                <p className="text-sm text-amber-100 font-medium">Partial metadata</p>
                <ul className="mt-1 list-disc list-inside text-sm text-amber-100/80">
                  {report.meta.partialReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {summary.issues === 0 ? (
              <p className="text-sm text-white/45">
                No issues match these filters in this window. Widen the date range or clear filters.
              </p>
            ) : (
              <>
                <section aria-label="Summary">
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <Card
                      label="Issue success"
                      value={formatRate(summary.issueSuccess)}
                      title={`done / (done + closed), denominator ${summary.closedIssues}`}
                      hint={`${formatCount(summary.issues)} issues · ${formatCount(summary.closedIssues)} closed`}
                    />
                    <Card
                      label="Attempt success"
                      value={formatRate(summary.attemptSuccess)}
                      title={`done sessions / terminal sessions, denominator ${summary.terminalAttempts}`}
                      hint={`${formatCount(summary.attempts)} attempts · ${formatCount(summary.terminalAttempts)} terminal`}
                    />
                    <Card
                      label="Retry rate"
                      value={formatRate(summary.retryRate)}
                      title={`${summary.retryExtraAttempts} extra attempts beyond one per issue`}
                      hint={`Reuse rate ${formatRate(summary.reuseRate)} over ${formatCount(summary.reuseDenominator)} reviewer sessions with input SHA`}
                    />
                    <Card
                      label="Human wait"
                      value={formatMs(summary.humanWaitMs)}
                      hint={`${formatCount(summary.interventions)} interventions`}
                    />
                    <Card
                      label="Session wall P50/P95"
                      value={percentileCellText(summary.sessionWallMs, formatMs)}
                      hint="Session bookkeeping proxy — never CLI runtime"
                    />
                    <Card
                      label="Spawn envelope P50/P95"
                      value={percentileCellText(summary.spawnEnvelopeMs, formatMs)}
                      hint="Coordinator-measured; includes slot wait + post-exit work"
                    />
                    <Card
                      label="Checkpoint latency P50/P95"
                      value={percentileCellText(summary.checkpointMs, formatMs)}
                      hint="Session start → first heartbeat"
                    />
                    <Card
                      label="Reviewer rounds (avg)"
                      value={summary.avgReviewerRounds === null ? "Unavailable" : summary.avgReviewerRounds.toFixed(1)}
                      hint={`Change-request rate ${formatRate(summary.changeRequestRate)} over ${formatCount(summary.reviewedIssues)} reviewed`}
                    />
                  </div>
                </section>

                <section aria-label="Failed-attempt waste">
                  <h3 className="text-sm font-medium text-white/80 mb-2">Failed-attempt waste (known values only)</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Card label="Failed cost" value={coverageCellText(summary.failedCostUsd, formatUsd)} />
                    <Card
                      label="Failed tokens"
                      value={`${coverageCellText(summary.failedTokensIn, formatCount)} in · ${coverageCellText(summary.failedTokensOut, formatCount)} out`}
                    />
                    <Card label="Failed runtime" value={coverageCellText(summary.failedDurationMs, formatMs)} />
                  </div>
                </section>

                <section aria-label="Phase wall time">
                  <h3 className="text-sm font-medium text-white/80 mb-2">Phase wall time</h3>
                  <div className="rounded border border-white/10 bg-panel-elevated/60 overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <caption className="sr-only">
                        Exclusive phase wall times. Boundaries without defensible evidence are Unavailable.
                      </caption>
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                          <th scope="col" className="px-4 py-2 font-medium">Phase</th>
                          <th scope="col" className="px-3 py-2 font-medium">P50 / P95</th>
                          <th scope="col" className="px-3 py-2 font-medium">Why</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {summary.phaseWallMs.map((p) => (
                          <tr key={p.phase} className="tabular-nums">
                            <th scope="row" className="px-4 py-2 text-left font-medium text-white/85">{p.phase}</th>
                            <td className="px-3 py-2 text-white/75">{percentileCellText(p.stat, formatMs)}</td>
                            <td className="px-3 py-2 text-xs text-white/45">{p.stat.reasons.join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section aria-label="Comparisons" className="space-y-4">
                  <h3 className="text-sm font-medium text-white/80">
                    Comparisons <span className="font-normal text-white/40">— sorted by name, never by cost</span>
                  </h3>
                  <CohortTable caption="By role" rows={report.byRole.map(toCohortDisplay)} />
                  <CohortTable caption="By runtime" rows={report.byRuntime.map(toCohortDisplay)} />
                  <CohortTable caption="By model" rows={report.byModel.map(toCohortDisplay)} />
                </section>

                <section aria-label="Primary failures">
                  <h3 className="text-sm font-medium text-white/80 mb-2">Primary failure distribution</h3>
                  {failures.length === 0 ? (
                    <p className="text-sm text-white/45">No failed attempts in this window.</p>
                  ) : (
                    <div className="rounded border border-white/10 bg-panel-elevated/60 overflow-x-auto">
                      <table className="w-full min-w-[560px] text-sm">
                        <caption className="sr-only">
                          Primary failure per failed issue. Unknown is its own bucket and is never promoted.
                        </caption>
                        <thead>
                          <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
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
                              <th scope="row" className="px-4 py-2 text-left font-medium text-white/85">
                                {f.code}
                                {f.isUnknown && (
                                  <span className="ml-2 text-xs font-normal text-amber-200/90">
                                    needs evidence
                                  </span>
                                )}
                                <span className="block text-xs font-normal text-white/40">{f.blurb}</span>
                              </th>
                              <td className="px-3 py-2 text-white/75">{f.domain}</td>
                              <td className="px-3 py-2 text-white/75">{f.countText}</td>
                              <td className="px-3 py-2 text-white/75">{f.shareText}</td>
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
                                    <span className="text-xs text-white/40">+{f.hiddenIssueCount} more</span>
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

                <section aria-label="Issues">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                    <h3 className="text-sm font-medium text-white/80">Issues</h3>
                    <p className="text-xs text-white/40">{paginationText(report.pagination)}</p>
                  </div>
                  <div className="space-y-2">
                    {report.issues.map((issue) => (
                      <Link
                        key={issue.id}
                        to={issueDetailHref(issue.id)}
                        className="block rounded border border-white/10 bg-panel-elevated/60 px-4 py-2.5 hover:border-cyber-teal/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyber-teal/45"
                      >
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <IssueStatusBadge status={issue.status as IssueStatus} />
                          <span className="text-sm text-white/85 flex-1 min-w-40">{issue.title}</span>
                          <span className="text-xs text-white/40 tabular-nums">{issue.attempts} attempts</span>
                        </span>
                        <span className="mt-0.5 block text-xs text-white/35 font-mono truncate">
                          {issue.repo} · {issue.id.slice(0, 8)}
                        </span>
                      </Link>
                    ))}
                  </div>
                  {report.pagination.totalPages > 1 && (
                    <nav aria-label="Report pages" className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="px-3 py-1.5 text-sm rounded border border-white/15 text-white/70 hover:text-white disabled:opacity-40"
                        disabled={report.pagination.page <= 1}
                        onClick={() => apply(form, report.pagination.page - 1)}
                      >
                        Previous
                      </button>
                      <span className="text-xs text-white/45 tabular-nums">
                        Page {report.pagination.page} of {report.pagination.totalPages}
                      </span>
                      <button
                        type="button"
                        className="px-3 py-1.5 text-sm rounded border border-white/15 text-white/70 hover:text-white disabled:opacity-40"
                        disabled={report.pagination.page >= report.pagination.totalPages}
                        onClick={() => apply(form, report.pagination.page + 1)}
                      >
                        Next
                      </button>
                    </nav>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
