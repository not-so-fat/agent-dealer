import { useEffect, useState } from "react";
import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { fetchHumanActions, resolveHumanAction } from "../api";

type Props = {
  onSelectIssue: (id: string) => void;
};

const ACTION_LABELS: Record<HumanActionType, string> = {
  final_review: "Final review",
  attempts_exhausted: "Attempts exhausted",
  policy_escalation: "Policy escalation",
  product_scope_decision: "Product scope decision",
};

const RESOLVED_BY = "web";

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function EvidencePreview({ action }: { action: HumanAction }) {
  const evidence = parseJson<{ review?: { verdict: string; findings?: Array<{ severity: string; title: string }> } }>(
    action.evidenceJson
  );
  const continuation = parseJson<{ resumeRole?: string; resumeHeadSha?: string | null }>(action.continuationPreviewJson);
  if (!evidence && !continuation) return null;
  return (
    <div className="mt-2 text-xs text-white/50 space-y-1">
      {evidence?.review && (
        <p>
          Reviewer verdict: <span className="text-white/70">{evidence.review.verdict}</span>
          {evidence.review.findings?.length ? ` · ${evidence.review.findings.length} finding(s)` : ""}
        </p>
      )}
      {continuation?.resumeRole && (
        <p>
          Continuation: resumes as <span className="text-white/70">{continuation.resumeRole}</span>
          {continuation.resumeHeadSha ? ` at ${continuation.resumeHeadSha.slice(0, 8)}` : ""}
        </p>
      )}
    </div>
  );
}

export default function HumanActionsPage({ onSelectIssue }: Props) {
  const [actions, setActions] = useState<HumanAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => fetchHumanActions().then(setActions).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, []);

  const resolve = async (actionId: string, choice: string) => {
    setBusyId(actionId);
    setError(null);
    try {
      await resolveHumanAction(actionId, RESOLVED_BY, choice);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <h2 className="text-lg font-semibold text-white/90 mb-4">Human actions</h2>
      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}

      {actions === null ? (
        <p className="text-white/50 text-sm">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="text-white/45 text-sm">No open actions — every issue is progressing on its own.</p>
      ) : (
        <div className="space-y-3">
          {actions.map((action) => {
            const options = parseJson<Array<{ choice: string; label: string }>>(action.responseOptionsJson) ?? [];
            return (
              <div key={action.id} className="p-4 rounded border border-red-400/30 bg-red-500/5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <button
                    type="button"
                    onClick={() => onSelectIssue(action.issueId)}
                    className="text-xs uppercase tracking-wide text-red-300/80 hover:text-red-200"
                  >
                    {ACTION_LABELS[action.actionType]}
                  </button>
                  <span className="text-xs text-white/35">{new Date(action.requestedAt).toLocaleString()}</span>
                </div>
                <p className="text-sm text-white/85">{action.question}</p>
                {action.reason && action.reason !== action.question && (
                  <p className="text-xs text-white/50 mt-1">{action.reason}</p>
                )}
                <EvidencePreview action={action} />
                <div className="flex gap-2 mt-3">
                  {options.map((opt) => (
                    <button
                      key={opt.choice}
                      type="button"
                      className="btn-gold px-3 py-1.5 text-xs disabled:opacity-50"
                      disabled={busyId === action.id}
                      onClick={() => resolve(action.id, opt.choice)}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => onSelectIssue(action.issueId)}
                    className="px-3 py-1.5 text-xs text-white/50 hover:text-white"
                  >
                    View issue →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
