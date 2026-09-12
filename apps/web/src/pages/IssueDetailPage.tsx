import { useEffect, useState } from "react";
import {
  abortIssue,
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

type Props = {
  issueId: string;
  onBack: () => void;
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

export default function IssueDetailPage({ issueId, onBack }: Props) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [evidence, setEvidence] = useState<IssueEvidence | null>(null);
  const [traces, setTraces] = useState<Record<string, { content: string; loading: boolean; error?: string }>>({});
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAcceptance, setEditAcceptance] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => fetchIssueDetail(issueId).then(setDetail).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 4000);
    return () => clearInterval(poll);
  }, [issueId]);

  if (error) return <div className="p-6 text-red-300 text-sm">{error}</div>;
  if (!detail) return <div className="p-6 text-white/50 text-sm">Loading…</div>;

  const { issue, timeline, humanActions, usageSummary, readiness, humanWaitMs, interventionCount, latestWorkflowInstance } = detail;
  const durationMs = latestWorkflowInstance
    ? new Date(latestWorkflowInstance.completedAt ?? Date.now()).getTime() - new Date(latestWorkflowInstance.startedAt).getTime()
    : 0;
  const openActions = humanActions.filter((a) => a.status === "open");
  const canEdit = readiness.ok === false || openActions.some((a) => a.actionType === "product_scope_decision");
  const hasActiveWorkflow = latestWorkflowInstance != null && latestWorkflowInstance.completedAt === null;

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
      await startIssue(issueId);
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

  const resolveScopeDecision = async (actionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await resolveHumanAction(actionId, RESOLVED_BY, "resume");
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
        <button type="button" onClick={onBack} className="text-sm text-white/50 hover:text-white mb-3">
          ← Issues
        </button>

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

        {!readiness.ok && !openActions.some((a) => a.actionType === "product_scope_decision") && (
          <div className="mb-4 p-3 rounded border border-amber-400/30 bg-amber-500/10">
            <p className="text-xs text-amber-300 font-medium">Not startable yet — missing: {readiness.missing.join(", ")}</p>
          </div>
        )}

        {openActions.length > 0 && (
          <div className="mb-4 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-2">
            <p className="text-xs text-red-300 font-medium">Human action needed</p>
            {openActions.map((a) => (
              <div key={a.id}>
                <p className="text-sm text-white/80">{a.question}</p>
                {a.actionType === "product_scope_decision" && readiness.ok && (
                  <button type="button" className="btn-gold px-3 py-1 mt-1 text-xs" disabled={busy} onClick={() => resolveScopeDecision(a.id)}>
                    Resume
                  </button>
                )}
              </div>
            ))}
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
          <button type="button" className="btn-gold px-4 py-2 mb-4 disabled:opacity-50" disabled={!readiness.ok || busy} onClick={doStart}>
            Start
          </button>
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
