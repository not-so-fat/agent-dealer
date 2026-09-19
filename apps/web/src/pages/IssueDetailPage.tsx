import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentWithHealth } from "@agent-dealer/shared";
import {
  abortIssue,
  dequeueIssue,
  enqueueIssue,
  fetchIssueArtifactTrace,
  fetchIssueDetail,
  fetchIssueEvidence,
  guideIssue,
  patchIssue,
  resolveHumanAction,
  startIssue,
  type IssueDetail,
  type IssueEvidence,
} from "../api";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import IssueTimeline from "../components/issues/IssueTimeline";
import HumanActionChoices from "../components/issues/HumanActionChoices";
import { parseResponseOptions } from "../lib/humanActions";

type Props = {
  issueId: string;
  agents: AgentWithHealth[];
  /** Lets the shell's open-action badge/list catch up after a resolution here. */
  onHumanActionsChanged: () => void;
};

const RESOLVED_BY = "web";

/** Pretty-print an artifact's contentJson for the evidence disclosure — prefers a plain
 * "text" field (implementation conclusions, etc.) over a raw JSON dump. */
function formatArtifactContent(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as { text?: string };
    if (typeof parsed.text === "string") return parsed.text;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return contentJson;
  }
}

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function fmtHeartbeatAge(iso: string | null): string {
  if (!iso) return "no heartbeat yet";
  const ageSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const min = Math.floor(ageSec / 60);
  return `${min}m ago`;
}

function shortPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}

/** Hover text for the NOT-148 tip strip — tip vocabulary only, no engine state enums. */
function branchTipTitle(
  tip: NonNullable<IssueDetail["branchTipStatus"]>
): string {
  return [tip.branch, tip.tipLabel, tip.worktree?.path ? shortPath(tip.worktree.path) : null]
    .filter(Boolean)
    .join(" · ");
}

/** Operator suffixes after tipLabel (restart risk / dirty preserve). */
function branchTipSuffixes(
  tip: NonNullable<IssueDetail["branchTipStatus"]>
): string {
  return [
    tip.restartRisk ? "restart risk" : null,
    tip.worktree?.preserved ? "dirty worktree preserved" : null,
  ]
    .filter(Boolean)
    .map((s) => ` · ${s}`)
    .join("");
}

function branchTipWarnClass(tip: NonNullable<IssueDetail["branchTipStatus"]>): boolean {
  return Boolean(tip.restartRisk || tip.worktree?.preserved);
}

/** Sampler writes `Role · {liveProgress} (round N)` into currentIntent — don't echo that under the gold line. */
function intentDuplicatesLiveProgress(intent: string | null | undefined, progress: string | null | undefined): boolean {
  if (!intent || !progress) return false;
  if (intent === progress) return true;
  return intent.includes(progress);
}

/** The next allowed action, per the ticket's workflow rail: an open human action's own
 * response options when one exists, otherwise a derived "waiting on X" from currentOwner. */
function nextActionLabel(detail: IssueDetail): string {
  const open = detail.humanActions.find((a) => a.status === "open");
  if (open) return open.question;
  switch (detail.issue.currentOwner) {
    case "developer":
      return "Waiting on the developer";
    case "reviewer":
      return "Waiting on the reviewer";
    case "human":
      return "Waiting on you";
    default:
      return detail.issue.status === "done" || detail.issue.status === "closed" ? "Complete" : "Idle";
  }
}

export default function IssueDetailPage({ issueId, agents, onHumanActionsChanged }: Props) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [evidence, setEvidence] = useState<IssueEvidence | null>(null);
  const [traces, setTraces] = useState<Record<string, { content: string; loading: boolean; error?: string }>>({});
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAcceptance, setEditAcceptance] = useState("");
  const [busy, setBusy] = useState(false);
  /** Outcome of the last Start — admitted, or queued at a position with a reason. */
  const [startNotice, setStartNotice] = useState<string | null>(null);

  const refresh = () =>
    fetchIssueDetail(issueId)
      .then((d) => {
        setDetail(d);
        setError(null);
        setNotFound(false);
      })
      .catch((e) => {
        const msg = String(e).replace(/^Error:\s*/i, "").trim();
        if (/^not found$/i.test(msg)) {
          setNotFound(true);
          setError(null);
          setDetail(null);
        } else {
          setError(msg);
          setNotFound(false);
        }
      });

  useEffect(() => {
    // Route reuse no longer unmounts this page when only :issueId changes — clear every
    // local draft so issue A's edit/guidance state cannot overlay issue B.
    setDetail(null);
    setEvidence(null);
    setTraces({});
    setGuidance("");
    setError(null);
    setNotFound(false);
    setEditing(false);
    setEditTitle("");
    setEditDescription("");
    setEditAcceptance("");
    setBusy(false);
    setStartNotice(null);
    refresh();
    const poll = setInterval(refresh, 4000);
    return () => clearInterval(poll);
  }, [issueId]);

  if (notFound) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-10">
        <div className="max-w-md space-y-3">
          <h2 className="text-lg font-semibold text-white/90">Issue not found</h2>
          <p className="text-sm text-white/55">
            No issue exists for this ID — it may have been deleted, or the link is wrong.
          </p>
          <Link to="/issues" className="inline-block text-sm text-cyber-teal hover:underline">
            ← Back to Issues
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 space-y-3">
        <p className="text-red-300 text-sm">{error}</p>
        <Link to="/issues" className="inline-block text-sm text-cyber-teal hover:underline">
          ← Back to Issues
        </Link>
      </div>
    );
  }
  if (!detail) return <div className="p-6 text-white/50 text-sm">Loading…</div>;

  const { issue, timeline, humanActions, usageSummary, readiness, humanWaitMs, interventionCount, latestWorkflowInstance, activeWorkerSession, liveProgress, latestSessionFailure, branchTipStatus, queued, queueEntry } = detail;
  const developerAgent = agents.find((a) => a.id === issue.developerAgentId);
  const developerBlocked = developerAgent && !developerAgent.healthy;
  const developerBlockReason = developerAgent?.issues[0]?.message ?? "Developer agent is unhealthy";
  const durationMs = latestWorkflowInstance
    ? new Date(latestWorkflowInstance.completedAt ?? Date.now()).getTime() - new Date(latestWorkflowInstance.startedAt).getTime()
    : 0;
  const openActions = humanActions.filter((a) => a.status === "open");
  const canEdit = readiness.ok === false || openActions.some((a) => a.actionType === "product_scope_decision");
  const hasActiveWorkflow = latestWorkflowInstance != null && latestWorkflowInstance.completedAt === null;
  const sessionLive =
    activeWorkerSession &&
    activeWorkerSession.status === "running" &&
    (issue.status === "developing" || issue.status === "reviewing" || issue.status === "repairing");
  // Hide the failure strip while a live session is running — the live strip owns that slot.
  const showLatestFailure = Boolean(latestSessionFailure) && !sessionLive;

  const submitGuidance = async () => {
    if (!guidance.trim()) return;
    await guideIssue(issueId, guidance);
    setGuidance("");
    refresh();
  };

  const beginEdit = () => {
    setEditTitle(issue.title);
    setEditDescription(issue.description ?? "");
    setEditAcceptance(issue.acceptanceCriteria ?? "");
    setEditing(true);
  };

  const saveEdit = async () => {
    setBusy(true);
    setError(null);
    try {
      await patchIssue(issueId, {
        title: editTitle.trim() || undefined,
        description: editDescription.trim() || null,
        acceptanceCriteria: editAcceptance.trim() || null,
      });
      setEditing(false);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doStart = async () => {
    setBusy(true);
    setError(null);
    try {
      // NOT-118: Start moves this issue to the front of the admission queue. It runs now if
      // a slot is free, otherwise it waits at position 1 — it never jumps the queue.
      const result = await startIssue(issueId);
      setStartNotice(
        result.state === "admitted"
          ? null
          : `Queued at position ${result.position}${result.waitReason ? ` — ${result.waitReason}` : ""}`
      );
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doEnqueue = async () => {
    setBusy(true);
    setError(null);
    try {
      await enqueueIssue(issueId);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doDequeue = async () => {
    setBusy(true);
    setError(null);
    try {
      await dequeueIssue(issueId);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doAbort = async () => {
    if (!confirm("Abort this workflow? The current worker will stop and the issue will close. History and evidence are kept.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await abortIssue(issueId);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const resolveActionChoice = async (actionId: string, choice: string) => {
    setBusy(true);
    setError(null);
    try {
      await resolveHumanAction(actionId, RESOLVED_BY, choice);
      onHumanActionsChanged();
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadEvidence = () => {
    if (!evidence) fetchIssueEvidence(issueId).then(setEvidence).catch((e) => setError(String(e)));
  };

  const loadTrace = (artifactId: string) => {
    if (traces[artifactId]) return; // already loaded or loading
    setTraces((prev) => ({ ...prev, [artifactId]: { content: "", loading: true } }));
    fetchIssueArtifactTrace(issueId, artifactId)
      .then((t) => setTraces((prev) => ({ ...prev, [artifactId]: { content: t.content, loading: false } })))
      .catch((e) => setTraces((prev) => ({ ...prev, [artifactId]: { content: "", loading: false, error: String(e) } })));
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div className="max-w-3xl">
        <Link to="/issues" className="inline-block text-sm text-white/50 hover:text-white mb-3">
          ← Issues
        </Link>

        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90">{issue.title}</h2>
            <p className="text-xs text-white/45 mt-1">
              Owner: <span className="capitalize">{issue.currentOwner}</span>
              {issue.currentIntent ? ` · ${issue.currentIntent}` : ""}
            </p>
            <div className="flex flex-wrap gap-3 mt-2 text-xs text-white/40">
              {issue.prUrl && <a href={issue.prUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">PR #{issue.prNumber}</a>}
              {issue.externalUrl && <a href={issue.externalUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">{issue.externalLabel ?? "External link"}</a>}
              <span>Round {issue.currentRound}/{issue.maxReviewRounds}</span>
              <span>Infra attempts {issue.infraAttempts}/{issue.maxInfraAttempts}</span>
              <span title="Wall-clock time from workflow start to completion (or now)">{fmtDuration(durationMs)} elapsed</span>
              <span title={`${usageSummary.totalTokensIn} in / ${usageSummary.totalTokensOut} out tokens`}>${usageSummary.totalCostUsd.toFixed(2)}</span>
              {humanWaitMs > 0 && <span title="Time spent waiting on a human, excluding autonomous processing">{fmtDuration(humanWaitMs)} human wait</span>}
              {interventionCount > 0 && <span>{interventionCount} intervention{interventionCount === 1 ? "" : "s"}</span>}
            </div>
          </div>
          <IssueStatusBadge status={issue.status} />
        </div>

        {/* Workflow rail: current node/owner is above; next allowed action here. */}
        <div className="mb-4 p-3 rounded border border-white/10 bg-panel-elevated/40 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-white/45">Next</p>
            <p className="text-sm text-white/85">{nextActionLabel(detail)}</p>
          </div>
          {hasActiveWorkflow && (
            <button type="button" className="btn-ghost-danger px-3 py-1.5 text-xs shrink-0 disabled:cursor-not-allowed disabled:opacity-60" disabled={busy} onClick={doAbort}>
              Abort workflow
            </button>
          )}
        </div>

        {/* NOT-118: queued is a real state of its own — a `ready` issue waiting in the
            admission queue must never look like an idle one nobody has picked up. */}
        {queueEntry && (
          <div className="mb-4 p-3 rounded border border-cyber-teal/30 bg-cyber-teal/5">
            <p className="text-xs text-cyber-teal font-medium uppercase tracking-wide">
              Queued · position {queueEntry.position}
            </p>
            <p className="text-sm text-white/80 mt-0.5">
              {queueEntry.waitReason ?? "Next up — starts as soon as the coordinator ticks"}
            </p>
          </div>
        )}

        {sessionLive && activeWorkerSession && (
          <div className="mb-4 p-3 rounded border border-cyber-teal/35 bg-cyber-teal/5 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyber-teal animate-pulse" aria-hidden />
              <p className="text-xs text-cyber-teal font-medium uppercase tracking-wide">Running now</p>
            </div>
            <p className="text-sm text-white/90">
              <span className="capitalize">{activeWorkerSession.role}</span>
              {activeWorkerSession.runtime ? ` · ${activeWorkerSession.runtime}` : ""}
              {activeWorkerSession.model ? ` · ${activeWorkerSession.model}` : ""}
              {` · round ${activeWorkerSession.round}`}
            </p>
            <p className="text-sm text-[#C4B643] truncate" title={liveProgress ?? issue.currentIntent ?? "session started"}>
              Last progress: {liveProgress ?? issue.currentIntent ?? "session started"}
            </p>
            {branchTipStatus && (
              <p
                className={`text-xs ${branchTipWarnClass(branchTipStatus) ? "text-amber-300" : "text-white/55"}`}
                title={branchTipTitle(branchTipStatus)}
              >
                Branch tip: {branchTipStatus.tipLabel}
                {branchTipSuffixes(branchTipStatus)}
              </p>
            )}
            {liveProgress &&
              issue.currentIntent &&
              !/session running/i.test(issue.currentIntent) &&
              !intentDuplicatesLiveProgress(issue.currentIntent, liveProgress) && (
              <p className="text-xs text-white/45 truncate" title={issue.currentIntent}>
                {issue.currentIntent}
              </p>
            )}
            <p className="text-xs text-white/45">
              Heartbeat {fmtHeartbeatAge(activeWorkerSession.heartbeatAt)}
              {shortPath(activeWorkerSession.worktreePath) ? ` · ${shortPath(activeWorkerSession.worktreePath)}` : ""}
            </p>
            {activeWorkerSession.logPath && (
              <p className="text-xs text-white/40 font-mono break-all" title={activeWorkerSession.logPath}>
                Log: {shortPath(activeWorkerSession.logPath) ?? activeWorkerSession.logPath}
              </p>
            )}
          </div>
        )}

        {showLatestFailure && latestSessionFailure && (
          <div className="mb-4 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-1.5">
            <p className="text-xs text-red-300 font-medium uppercase tracking-wide">Latest session failure</p>
            <p className="text-sm text-white/90 whitespace-pre-wrap break-words">{latestSessionFailure.reason}</p>
            <p className="text-xs text-white/45">
              {latestSessionFailure.role ? <span className="capitalize">{latestSessionFailure.role}</span> : "Worker"}
              {latestSessionFailure.outcome ? ` · ${latestSessionFailure.outcome}` : ""}
              {` · ${new Date(latestSessionFailure.when).toLocaleString()}`}
              {` · infra ${latestSessionFailure.infraAttempts}/${latestSessionFailure.maxInfraAttempts}`}
            </p>
            {branchTipStatus && (
              <p
                className={`text-xs ${branchTipWarnClass(branchTipStatus) ? "text-amber-300" : "text-white/55"}`}
                title={branchTipTitle(branchTipStatus)}
              >
                Branch tip: {branchTipStatus.tipLabel}
                {branchTipSuffixes(branchTipStatus)}
              </p>
            )}
            {latestSessionFailure.logPath && (
              <p className="text-xs text-white/40 font-mono break-all" title={latestSessionFailure.logPath}>
                Log: {shortPath(latestSessionFailure.logPath) ?? latestSessionFailure.logPath}
              </p>
            )}
          </div>
        )}

        {/* NOT-148: tip / restart-risk when developing or reviewing without a live/failure strip. */}
        {branchTipStatus && !sessionLive && !showLatestFailure && (
          <div className="mb-4 p-3 rounded border border-white/10 bg-white/[0.03] space-y-1">
            <p className="text-xs text-white/45 uppercase tracking-wide">Branch tip</p>
            <p
              className={`text-sm ${branchTipWarnClass(branchTipStatus) ? "text-amber-300" : "text-white/80"}`}
              title={branchTipTitle(branchTipStatus)}
            >
              {branchTipStatus.tipLabel}
              {branchTipSuffixes(branchTipStatus)}
            </p>
          </div>
        )}

        {!readiness.ok && !openActions.some((a) => a.actionType === "product_scope_decision") && (
          <div className="mb-4 p-3 rounded border border-amber-400/30 bg-amber-500/10">
            <p className="text-xs text-amber-300 font-medium">Not startable yet — missing: {readiness.missing.join(", ")}</p>
          </div>
        )}

        {openActions.length > 0 && (
          <div className="mb-4 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-2">
            <p className="text-xs text-red-300 font-medium">Human action needed</p>
            {openActions.map((a) => {
              // product_scope_decision keeps its own gated button: resolving it before
              // acceptance criteria actually exist would just bounce off the server, so it
              // is only offered once `readiness.ok`. Every other action type
              // (policy_escalation, attempts_exhausted, final_review,
              // deck_interaction_required, …) has no such precondition — render the
              // server's own response options generically rather than hardcoding choices
              // per type.
              const scopeDecision = a.actionType === "product_scope_decision";
              return (
                <div key={a.id} className="space-y-1">
                  <p className="text-sm text-white/80">{a.question}</p>
                  {scopeDecision ? (
                    readiness.ok && (
                      <button
                        type="button"
                        className="btn-gold px-3 py-1 text-xs"
                        disabled={busy}
                        onClick={() => resolveActionChoice(a.id, "resume")}
                      >
                        Resume
                      </button>
                    )
                  ) : (
                    <HumanActionChoices
                      options={parseResponseOptions(a)}
                      disabled={busy}
                      onChoose={(choice) => resolveActionChoice(a.id, choice)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canEdit && !editing && (
          <button type="button" className="mb-4 text-xs text-cyber-teal hover:underline" onClick={beginEdit}>
            Edit title / description / acceptance criteria
          </button>
        )}
        {editing && (
          <div className="mb-4 p-3 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
            <input className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Title" />
            <textarea className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" rows={2} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Description" />
            <textarea className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" rows={2} value={editAcceptance} onChange={(e) => setEditAcceptance(e.target.value)} placeholder="Acceptance criteria" />
            <div className="flex gap-2">
              <button type="button" className="btn-gold px-4 py-1.5 text-sm" disabled={busy} onClick={saveEdit}>Save</button>
              <button type="button" className="px-4 py-1.5 text-sm text-white/60 hover:text-white" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* "ready" is the normal path; a "needs_human" issue with no open action left is
            reachable after resolving a migrated (legacy-cutover) final_review/
            attempts_exhausted action with repair/retry — that resolution deliberately
            never reactivates the completed legacy_v0 instance, so this Start button is
            the "explicit new workflow start" the migration design promises. The backend
            (startWorkflow's preStart check) already accepts needs_human the same as
            ready; this just stops the resolution from being a dead end in the UI. */}
        {(issue.status === "ready" || (issue.status === "needs_human" && openActions.length === 0)) && (
          <div className="mb-4 space-y-2">
            {developerBlocked && (
              <p className="text-sm text-amber-200/90">
                Fix before Start: {developerBlockReason}
              </p>
            )}
            {startNotice && <p className="text-sm text-amber-200/90">{startNotice}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-gold px-4 py-2 disabled:opacity-50"
                disabled={!readiness.ok || busy || !!developerBlocked}
                title={
                  developerBlocked
                    ? developerBlockReason
                    : "Move to the front of the admission queue — runs now if a slot is free"
                }
                onClick={doStart}
              >
                Run next
              </button>
              {!queued ? (
                <button
                  type="button"
                  className="px-4 py-2 text-sm border border-white/15 rounded text-white/80 hover:border-cyber-teal/50 hover:text-cyber-teal disabled:opacity-50"
                  disabled={busy || hasActiveWorkflow}
                  onClick={doEnqueue}
                >
                  Add to queue
                </button>
              ) : (
                <button
                  type="button"
                  className="px-4 py-2 text-sm border border-white/15 rounded text-white/60 hover:text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={doDequeue}
                >
                  Remove from queue
                </button>
              )}
            </div>
          </div>
        )}

        <div className="border-t border-white/10 pt-3">
          <IssueTimeline events={timeline} />
        </div>

        <div className="mt-4 flex gap-2">
          <input
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            placeholder="Guide this issue…"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGuidance()}
          />
          <button type="button" className="btn-gold px-4" onClick={submitGuidance}>Send</button>
        </div>

        {/* Evidence: closed by default — artifact-first with expandable detail, not
            implementation noise shown up front. */}
        <details className="mt-6" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadEvidence()}>
          <summary className="text-xs text-white/45 cursor-pointer hover:text-white/70">Evidence & raw trace</summary>
          {!evidence ? (
            <p className="text-xs text-white/40 mt-2">Loading…</p>
          ) : (
            <div className="mt-2 space-y-3 text-xs text-white/60">
              <div>
                <p className="text-white/45 mb-1">Worker sessions</p>
                {evidence.workerSessions.map((s) => {
                  const usage = evidence.usageEvents.filter((u) => u.workerSessionId === s.id);
                  const cost = usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
                  const tokensIn = usage.reduce((sum, u) => sum + (u.tokensIn ?? 0), 0);
                  const tokensOut = usage.reduce((sum, u) => sum + (u.tokensOut ?? 0), 0);
                  return (
                    <p key={s.id}>
                      {s.role} round {s.round} · {s.status}
                      {s.startedAt && s.completedAt ? ` · ${fmtDuration(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime())}` : ""}
                      {usage.length > 0 ? ` · $${cost.toFixed(3)} · ${tokensIn}→${tokensOut} tok` : ""}
                    </p>
                  );
                })}
                {evidence.workerSessions.length === 0 && <p className="text-white/35">None yet.</p>}
              </div>
              <div>
                <p className="text-white/45 mb-1">Artifacts</p>
                {evidence.artifacts.map((a) => {
                  const trace = traces[a.id];
                  return (
                    <details key={a.id} className="mb-1.5" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && a.blobPath && loadTrace(a.id)}>
                      <summary className="cursor-pointer hover:text-white/80">
                        {a.kind} · {new Date(a.createdAt).toLocaleString()}
                      </summary>
                      <div className="mt-1 pl-3 border-l border-white/10 space-y-1">
                        {a.contentJson && <pre className="whitespace-pre-wrap break-words text-white/55">{formatArtifactContent(a.contentJson)}</pre>}
                        {a.blobPath && (
                          <div>
                            <p className="text-white/40">Raw trace: {a.blobPath}</p>
                            {trace?.loading && <p className="text-white/35">Loading trace…</p>}
                            {trace?.error && <p className="text-red-300/80">{trace.error}</p>}
                            {trace && !trace.loading && !trace.error && (
                              <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-white/50 bg-black/20 rounded p-2">{trace.content || "(empty)"}</pre>
                            )}
                          </div>
                        )}
                        {!a.contentJson && !a.blobPath && <p className="text-white/35">No content recorded.</p>}
                      </div>
                    </details>
                  );
                })}
                {evidence.artifacts.length === 0 && <p className="text-white/35">None yet.</p>}
              </div>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
