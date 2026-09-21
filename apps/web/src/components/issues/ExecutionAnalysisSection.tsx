import { useEffect, useState } from "react";
import type {
  AttemptAnalysis,
  CoveredTotal,
  ExecutionQuality,
  FailureCause,
  IssueExecutionAnalysis,
  NestedInterval,
  UnionedPhaseDuration,
} from "@agent-dealer/shared";
import { fetchIssueExecutionAnalysis } from "../../api";

/** Format epoch-ms durations without ever coercing null to zero. Null stays null. */
export function fmtAnalysisDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) {
    const sec = totalSec % 60;
    return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  }
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hr}h` : `${hr}h ${rest}m`;
}

export function fmtAnalysisTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `${Math.round(n).toLocaleString("en-US")} tokens`;
}

export function fmtAnalysisCost(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  return `$${usd.toFixed(2)}`;
}

const PHASE_LABELS: Record<UnionedPhaseDuration["phase"], string> = {
  queue_wait: "Queue / admission wait",
  coordinator_setup: "Setup",
  agent_process: "Agent process",
  coordinator_validation_publish: "Validation / publish",
  coordinator_work: "Coordinator work",
};

const SILENCE_LABELS: Record<string, string> = {
  model_provider_wait: "Silent · waiting on model provider",
  tool_or_subprocess_in_flight: "Silent · tool/subprocess in flight",
  host_suspended: "Silent · host suspended",
  no_structured_output: "Silent · no structured output yet",
  unknown: "Silent · unknown cause",
};

function humanizeCode(code: string): string {
  return code.replace(/_/g, " ");
}

function qualityTitle(quality: ExecutionQuality, reasons: string[]): string {
  const base = `Evidence quality: ${quality}`;
  return reasons.length > 0 ? `${base} — ${reasons.join(", ")}` : base;
}

/** Inline quality marker — always text, never color-only. */
function QualityTag({ quality, reasons }: { quality: ExecutionQuality; reasons: string[] }) {
  return (
    <span
      className={`text-[11px] tabular-nums ${
        quality === "exact"
          ? "text-white/40"
          : quality === "inferred"
            ? "text-amber-300/90"
            : "text-white/35 italic"
      }`}
      title={qualityTitle(quality, reasons)}
    >
      · {quality}
    </span>
  );
}

/** Missing values render "Unavailable" plus the reason — never a zero. */
function Unavailable({ reasons }: { reasons: string[] }) {
  const reason = reasons.length > 0 ? reasons.join(", ") : "no reason recorded";
  return (
    <span className="text-white/45 italic" title={`Unavailable — ${reason}`}>
      Unavailable
      <span className="text-[11px]"> — {reason}</span>
    </span>
  );
}

function CoveredValue({
  covered,
  format,
  unit,
}: {
  covered: CoveredTotal;
  format: (v: number) => string;
  unit: string;
}) {
  if (covered.value == null) {
    return <Unavailable reasons={covered.reasons} />;
  }
  const partial = covered.known < covered.total;
  return (
    <span title={`${qualityTitle(covered.quality, covered.reasons)} · known ${covered.known} of ${covered.total} ${unit}`}>
      {format(covered.value)}
      <QualityTag quality={covered.quality} reasons={covered.reasons} />
      {partial && (
        <span className="text-[11px] text-white/40" title={`Known for ${covered.known} of ${covered.total} ${unit}`}>
          {" "}
          (known {covered.known} of {covered.total})
        </span>
      )}
    </span>
  );
}

function FailureCard({ cause, primary }: { cause: FailureCause; primary: boolean }) {
  return (
    <div
      className={
        primary
          ? "p-2.5 rounded border border-red-400/30 bg-red-500/10 space-y-1"
          : "p-2 rounded border border-white/10 bg-white/[0.02] space-y-1"
      }
    >
      <p className={primary ? "text-sm font-medium text-red-200" : "text-xs text-white/60"}>
        {primary ? "First failure: " : "Consequence: "}
        {humanizeCode(cause.code)}
      </p>
      <p className={primary ? "text-sm text-white/85 whitespace-pre-wrap break-words" : "text-xs text-white/55 whitespace-pre-wrap break-words"}>
        {cause.rawReason}
      </p>
      <p className="text-[11px] text-white/40" title={qualityTitle(cause.quality === "exact" ? "exact" : "inferred", [`evidence: ${cause.evidenceSource}`, `confidence: ${cause.confidence}`])}>
        {cause.domain} · {cause.confidence} confidence · via {cause.evidenceSource.replace(/_/g, " ")} · {cause.quality}
        {cause.occurredAt ? ` · ${new Date(cause.occurredAt).toLocaleString()}` : ""}
      </p>
    </div>
  );
}

function SilenceRow({ interval }: { interval: NestedInterval }) {
  const label = SILENCE_LABELS[interval.category ?? "unknown"] ?? SILENCE_LABELS.unknown!;
  const duration = fmtAnalysisDuration(interval.durationMs);
  const hostSuspended = interval.category === "host_suspended";
  return (
    <li
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 border-b border-white/5 last:border-0 ${
        hostSuspended ? "text-amber-200/90" : "text-white/70"
      }`}
    >
      <span
        className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${
          hostSuspended ? "border-amber-400/40 bg-amber-500/10" : "border-white/15 bg-white/5"
        }`}
        title={
          hostSuspended
            ? "Overlapping durable host-sleep evidence split this gap — the host was suspended, not the agent."
            : "Observational gap with no new structured activity — not a diagnosis of what the agent was doing."
        }
      >
        {label}
      </span>
      <span className="text-xs tabular-nums">
        {duration ?? <Unavailable reasons={interval.reasons} />}
      </span>
      <QualityTag quality={interval.quality} reasons={interval.reasons} />
    </li>
  );
}

function AttemptRow({ attempt }: { attempt: AttemptAnalysis }) {
  const setup = fmtAnalysisDuration(attempt.setup.durationMs);
  const process = fmtAnalysisDuration(attempt.agentProcess.durationMs);
  const validation = fmtAnalysisDuration(attempt.validationPublish.durationMs);
  return (
    <li className="py-1.5 border-b border-white/5 last:border-0 space-y-0.5">
      <p className="text-sm text-white/85">
        <span className="capitalize">{attempt.role}</span>
        <span className="text-white/45">
          {attempt.runtime ? ` · ${attempt.runtime}` : ""}
          {attempt.model ? ` · ${attempt.model}` : ""}
          {` · round ${attempt.round} · ${attempt.status}`}
        </span>
        {attempt.publishOnly && (
          <span
            className="ml-2 text-[11px] px-1.5 py-0.5 rounded border border-cyber-teal/40 bg-cyber-teal/10 text-cyber-teal"
            title="Publish-only attempt: no agent process ran — the coordinator published prior work."
          >
            publish-only
          </span>
        )}
      </p>
      <p className="text-xs text-white/50 tabular-nums">
        <span title={setup ? undefined : `Setup unavailable — ${attempt.setup.reasons.join(", ") || "no reason recorded"}`}>
          Setup {setup ?? <span className="italic">Unavailable — {attempt.setup.reasons.join(", ") || "no reason recorded"}</span>}
        </span>
        <QualityTag quality={attempt.setup.quality} reasons={attempt.setup.reasons} />
        {" · "}
        <span title={process ? undefined : `Agent process unavailable — ${attempt.agentProcess.reasons.join(", ") || "no reason recorded"}`}>
          Agent {process ?? <span className="italic">Unavailable — {attempt.agentProcess.reasons.join(", ") || "no reason recorded"}</span>}
        </span>
        <QualityTag quality={attempt.agentProcess.quality} reasons={attempt.agentProcess.reasons} />
        {" · "}
        <span title={validation ? undefined : `Validation/publish unavailable — ${attempt.validationPublish.reasons.join(", ") || "no reason recorded"}`}>
          Validation/publish {validation ?? <span className="italic">Unavailable — {attempt.validationPublish.reasons.join(", ") || "no reason recorded"}</span>}
        </span>
        <QualityTag quality={attempt.validationPublish.quality} reasons={attempt.validationPublish.reasons} />
      </p>
      {attempt.failureCauses.length > 0 && (
        <p className="text-[11px] text-white/45">
          Failures: {attempt.failureCauses.map((c) => humanizeCode(c.code)).join(", ")}
        </p>
      )}
    </li>
  );
}

/** Pure view — renders a fetched analysis with no network access (testable). */
export function ExecutionAnalysisView({ analysis }: { analysis: IssueExecutionAnalysis }) {
  const elapsed = fmtAnalysisDuration(analysis.elapsed.durationMs);
  const exclusive = fmtAnalysisDuration(analysis.exclusiveTotalMs);
  const checkpointMs = fmtAnalysisDuration(analysis.firstCheckpoint.msSinceWorkflowStart);
  const nestedWaits = analysis.nested.filter((n) => n.kind !== "unexplained_silence");
  const nestedSilence = analysis.nested.filter((n) => n.kind === "unexplained_silence");
  const attemptSilence = analysis.attempts.flatMap((a) => a.silence);
  const allSilence = [...nestedSilence, ...attemptSilence];
  const silenceUnknown =
    analysis.attempts.length > 0 &&
    analysis.attempts.every((a) => a.silence.length === 0 && a.silenceQuality === "unavailable");
  const humanWait = fmtAnalysisDuration(analysis.humanWaitMs);
  const reuseRate = analysis.retry.reuseRate == null ? null : `${Math.round(analysis.retry.reuseRate * 100)}% reused`;

  return (
    <div className="space-y-3">
      {/* Elapsed + exclusive total: nested waits explain phases, never add to the total. */}
      <div>
        <p className="text-sm text-white/85 tabular-nums">
          Elapsed {elapsed ?? <Unavailable reasons={analysis.elapsed.reasons} />}
          <QualityTag quality={analysis.elapsed.quality} reasons={analysis.elapsed.reasons} />
        </p>
        <p
          className="text-xs text-white/45 tabular-nums"
          title="Unioned top-level phases with overlaps removed (human wait excluded). Nested waits below explain phases — they are never added to this total."
        >
          Exclusive phase total {exclusive ?? <Unavailable reasons={analysis.exclusiveTotalReasons} />}
          <QualityTag quality={analysis.exclusiveTotalQuality} reasons={analysis.exclusiveTotalReasons} />
          <span> · overlaps unioned, not summed</span>
        </p>
      </div>

      {/* Phase breakdown from unioned durations. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">Phase breakdown</h4>
        <ul>
          {analysis.unionedDurations.map((d) => {
            const duration = fmtAnalysisDuration(d.durationMs);
            return (
              <li key={d.phase} className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-sm">
                <span className="text-white/70 w-36 shrink-0">{PHASE_LABELS[d.phase] ?? d.phase}</span>
                <span className="text-white/85 tabular-nums">
                  {duration ?? <Unavailable reasons={d.reasons} />}
                </span>
                <QualityTag quality={d.quality} reasons={d.reasons} />
                {d.known < d.total && (
                  <span className="text-[11px] text-white/40">(known {d.known} of {d.total})</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-white/45 tabular-nums mt-1">
          Human wait {humanWait ?? <Unavailable reasons={analysis.humanWaitReasons} />}
          <QualityTag quality={analysis.humanWaitQuality} reasons={analysis.humanWaitReasons} />
          <span title="Human wait is tracked separately — it never adds to the phase total."> · never additive</span>
        </p>
        {nestedWaits.length > 0 && (
          <ul className="mt-1">
            {nestedWaits.map((n, i) => (
              <li key={i} className="text-xs text-white/50 tabular-nums">
                <span title="Nested drill-down: explains its parent phase, never adds to the total.">
                  ↳ {n.kind === "human_wait" ? "Human wait" : n.category ?? n.kind}
                </span>{" "}
                {fmtAnalysisDuration(n.durationMs) ?? <Unavailable reasons={n.reasons} />}
                <QualityTag quality={n.quality} reasons={n.reasons} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Attempts. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">
          Attempts ({analysis.attempts.length})
        </h4>
        {analysis.attempts.length === 0 ? (
          <p className="text-xs text-white/45 italic">No attempts recorded yet.</p>
        ) : (
          <ul>
            {analysis.attempts.map((a) => (
              <AttemptRow key={a.sessionId} attempt={a} />
            ))}
          </ul>
        )}
      </div>

      {/* Failure: first actionable cause primary, consequences secondary. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">Failure</h4>
        {analysis.primaryFailure ? (
          <div className="space-y-1.5">
            <FailureCard cause={analysis.primaryFailure} primary />
            {analysis.consequenceCauses.length > 0 && (
              <div className="space-y-1 opacity-80">
                {analysis.consequenceCauses.map((c, i) => (
                  <FailureCard key={`${c.code}-${i}`} cause={c} primary={false} />
                ))}
              </div>
            )}
          </div>
        ) : analysis.primaryFailureQuality === "unavailable" ? (
          <p className="text-sm text-white/60 italic" title={qualityTitle("unavailable", analysis.primaryFailureReasons)}>
            Unknown — {analysis.primaryFailureReasons.join(", ") || "no failure evidence recorded"}
          </p>
        ) : (
          <p className="text-sm text-white/45">No failure recorded.</p>
        )}
      </div>

      {/* Waste over known values only. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">
          Retry waste ({analysis.waste.failedAttempts} failed attempt{analysis.waste.failedAttempts === 1 ? "" : "s"})
        </h4>
        <p className="text-sm text-white/85 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
          <span title="Failed-attempt agent-process time over known values only">
            Runtime <CoveredValue covered={analysis.waste.runtimeMs} format={(v) => fmtAnalysisDuration(Math.round(v)) ?? "?"} unit="attempts" />
          </span>
          <span title="Failed-attempt input tokens over known values only">
            In <CoveredValue covered={analysis.waste.tokensIn} format={(v) => fmtAnalysisTokens(v) ?? "?"} unit="attempts" />
          </span>
          <span title="Failed-attempt output tokens over known values only">
            Out <CoveredValue covered={analysis.waste.tokensOut} format={(v) => fmtAnalysisTokens(v) ?? "?"} unit="attempts" />
          </span>
          <span title="Failed-attempt known cost over known values only">
            Cost <CoveredValue covered={analysis.waste.costUsd} format={(v) => fmtAnalysisCost(v) ?? "?"} unit="attempts" />
          </span>
        </p>
      </div>

      {/* First checkpoint. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">First checkpoint</h4>
        {analysis.firstCheckpoint.msSinceWorkflowStart == null && analysis.firstCheckpoint.kind == null ? (
          <p className="text-sm text-white/60 italic" title={qualityTitle(analysis.firstCheckpoint.quality, analysis.firstCheckpoint.reasons)}>
            Unavailable — {analysis.firstCheckpoint.reasons.join(", ") || "no checkpoint recorded"}
          </p>
        ) : (
          <p className="text-sm text-white/85 tabular-nums">
            {analysis.firstCheckpoint.kind ? humanizeCode(analysis.firstCheckpoint.kind) : "Checkpoint"}
            {analysis.firstCheckpoint.observedSha ? ` · ${analysis.firstCheckpoint.observedSha.slice(0, 12)}` : ""}
            {checkpointMs ? ` · ${checkpointMs} after workflow start` : ""}
            <QualityTag quality={analysis.firstCheckpoint.quality} reasons={analysis.firstCheckpoint.reasons} />
          </p>
        )}
      </div>

      {/* Retry reuse. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">Retry reuse</h4>
        <p className="flex flex-wrap gap-1.5" aria-label="Retry reuse summary">
          <span
            className="text-[11px] px-1.5 py-0.5 rounded border border-cyber-teal/40 bg-cyber-teal/10 text-cyber-teal"
            title="Retries that preserved prior work — a reused worktree, commit, or verification receipt."
          >
            Reused {analysis.retry.reused}
          </span>
          <span
            className="text-[11px] px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-white/60"
            title="Retries that started cold — no prior worktree, commit, or verification was reused."
          >
            Cold {analysis.retry.cold}
          </span>
          {analysis.retry.unknown > 0 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-white/60 italic"
              title={`Unknown reuse for ${analysis.retry.unknown} retr${analysis.retry.unknown === 1 ? "y" : "ies"} — ${analysis.retry.reasons.join(", ") || "no reuse evidence"}.`}
            >
              Unknown {analysis.retry.unknown}
            </span>
          )}
          {analysis.retry.publishOnly > 0 && (
            <span
              className="text-[11px] px-1.5 py-0.5 rounded border border-cyber-violet/40 bg-cyber-violet/10 text-cyber-violet-light"
              title="Publish-only retries ran no agent process — the coordinator published already-verified work."
            >
              Publish-only {analysis.retry.publishOnly}
            </span>
          )}
          <span className="text-[11px] text-white/45 tabular-nums self-center">
            {reuseRate ?? <Unavailable reasons={analysis.retry.reasons} />}
            <QualityTag quality={analysis.retry.quality} reasons={analysis.retry.reasons} />
          </span>
        </p>
        <p className="text-[11px] text-white/40 mt-0.5">
          Reuse preserves a worktree, commit, verification receipt, or publish-only result.
        </p>
      </div>

      {/* Silence — observational only, never idle/hung. */}
      <div>
        <h4 className="text-xs text-white/45 uppercase tracking-wide mb-1">Silence</h4>
        <p className="text-[11px] text-white/40 mb-1">
          Silence is observational — gaps with no new structured activity. It describes what was observed, never a diagnosis.
        </p>
        {allSilence.length === 0 ? (
          silenceUnknown ? (
            <p className="text-sm text-white/60 italic">Unknown — silence cannot be derived without agent-process bounds.</p>
          ) : (
            <p className="text-sm text-white/45">No silence observed.</p>
          )
        ) : (
          <ul aria-label="Observed silence intervals">
            {allSilence.map((s, i) => (
              <SilenceRow key={i} interval={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function ExecutionAnalysisSection({ issueId }: { issueId: string }) {
  const [analysis, setAnalysis] = useState<IssueExecutionAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setAnalysis(null);
    setError(null);
    setLoading(true);
    let cancelled = false;
    fetchIssueExecutionAnalysis(issueId)
      .then((a) => {
        if (!cancelled) {
          setAnalysis(a);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          // A 404 means no workflow has run yet — that is an empty state, not an error.
          if (/not found/i.test(String(e))) {
            setAnalysis(null);
            setError(null);
          } else {
            setError(String(e).replace(/^Error:\s*/i, ""));
          }
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  return (
    <section aria-labelledby="execution-analysis-heading" className="mb-4 p-3 rounded border border-white/10 bg-white/[0.03]">
      <h3 id="execution-analysis-heading" className="font-ui-display text-sm font-medium text-white/85 mb-2">
        Execution analysis
      </h3>
      {loading && <p className="text-xs text-white/40">Loading execution analysis…</p>}
      {!loading && error && <p className="text-xs text-red-300">{error}</p>}
      {!loading && !error && !analysis && (
        <p className="text-xs text-white/45">No execution analysis yet — start the workflow to see where time goes.</p>
      )}
      {!loading && !error && analysis && <ExecutionAnalysisView analysis={analysis} />}
    </section>
  );
}
