import { useEffect, useState } from "react";
import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { fetchHumanActions, resolveHumanAction } from "../api";

type Props = {
  onSelectIssue: (id: string) => void;
};

const CHOICES: Record<HumanActionType, Array<{ value: string; label: string }>> = {
  final_review: [
    { value: "complete", label: "Complete" },
    { value: "repair", label: "Another round" },
    { value: "close", label: "Close without accepting" },
  ],
  attempts_exhausted: [
    { value: "retry", label: "Allow another round" },
    { value: "close", label: "Close" },
  ],
  policy_escalation: [
    { value: "resume", label: "Resume" },
    { value: "close", label: "Close" },
  ],
  product_scope_decision: [{ value: "resume", label: "Resume with this decision" }],
};

const TYPE_LABELS: Record<HumanActionType, string> = {
  final_review: "Final review",
  attempts_exhausted: "Attempts exhausted",
  policy_escalation: "Policy escalation",
  product_scope_decision: "Product scope decision",
};

export default function HumanActionsPage({ onSelectIssue }: Props) {
  const [actions, setActions] = useState<HumanAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => fetchHumanActions().then(setActions).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, []);

  const resolve = async (id: string, choice: string) => {
    try {
      await resolveHumanAction(id, choice, "human");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <h2 className="text-lg font-semibold text-white/90 mb-4">Human actions</h2>
      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}

      {actions === null ? (
        <p className="text-white/50 text-sm">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="text-white/45 text-sm">Nothing needs your attention.</p>
      ) : (
        <div className="space-y-3">
          {actions.map((action) => (
            <div key={action.id} className="p-4 rounded border border-red-400/25 bg-panel-elevated/50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs uppercase tracking-wide text-red-300/80">{TYPE_LABELS[action.actionType]}</span>
                <button type="button" className="text-xs text-cyber-teal hover:underline" onClick={() => onSelectIssue(action.issueId)}>
                  View issue
                </button>
              </div>
              <p className="text-sm text-white/85 mb-1">{action.reason}</p>
              <p className="text-sm text-white/60 mb-3">{action.question}</p>
              <div className="flex gap-2">
                {CHOICES[action.actionType].map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className="btn-gold px-3 py-1.5 text-sm"
                    onClick={() => resolve(action.id, choice.value)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
