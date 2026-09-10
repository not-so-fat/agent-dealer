import { useEffect, useState } from "react";
import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { fetchHumanActions } from "../api";

type Props = {
  onSelectIssue: (id: string) => void;
};

const TYPE_LABELS: Record<HumanActionType, string> = {
  final_review: "Final review",
  attempts_exhausted: "Attempts exhausted",
  policy_escalation: "Policy escalation",
  product_scope_decision: "Product scope decision",
};

/**
 * NOT-58 foundation: read-only global queue of open human actions. Typed
 * resolution and workflow continuation land in NOT-64.
 */
export default function HumanActionsPage({ onSelectIssue }: Props) {
  const [actions, setActions] = useState<HumanAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => fetchHumanActions().then(setActions).catch((e) => setError(String(e)));

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, []);

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
              <p className="text-sm text-white/60">{action.question}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
