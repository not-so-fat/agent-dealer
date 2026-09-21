import { Link } from "react-router-dom";
import type { HumanAction } from "@agent-dealer/shared";
import AlertIcon from "../ui/AlertIcon";
import HumanActionChoices from "./HumanActionChoices";
import { actionContextLines, actionLabel, parseResponseOptions } from "../../lib/humanActions";

type Props = {
  actions: HumanAction[];
  busyActionId: string | null;
  onResolve: (actionId: string, choice: string) => void;
};

/**
 * Every open human action, on the Issues home (NOT-71). Issue-scoped items open their issue,
 * where the durable timeline and evidence live. Run-scoped items (outbound-draft delivery
 * parking, NOT-95) have no issue to open, so they carry their own context and resolve inline
 * — before this panel existed they were only reachable from the standalone Human actions
 * page, and deleting that page without this would have stranded them.
 *
 * Renders nothing when no action is open: the home screen needs no action-center chrome then.
 */
export default function NeedsAttentionPanel({ actions, busyActionId, onResolve }: Props) {
  if (actions.length === 0) return null;

  return (
    <div className="mb-4 rounded border border-red-400/30 bg-red-500/10">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-red-400/20">
        <AlertIcon className="w-4 h-4 shrink-0 text-red-300" />
        <span className="font-ui-display text-sm font-medium text-red-200">
          {actions.length} {actions.length === 1 ? "item needs" : "items need"} your attention
        </span>
      </div>
      <div className="divide-y divide-white/5">
        {actions.map((action) => {
          const label = actionLabel(action.actionType);
          const context = actionContextLines(action);

          if (action.issueId) {
            return (
              <Link
                key={action.id}
                to={`/issues/${action.issueId}`}
                className="block w-full text-left px-4 py-2 hover:bg-white/5 transition-colors"
              >
                <span className="text-xs uppercase tracking-wide text-red-300/80">{label}</span>
                <span className="text-sm text-white/80 ml-2">{action.question}</span>
              </Link>
            );
          }

          const options = parseResponseOptions(action);
          return (
            <div key={action.id} className="px-4 py-3 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs uppercase tracking-wide text-red-300/80">{label}</span>
                <span className="text-xs text-white/35 shrink-0">
                  {new Date(action.requestedAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-white/85">{action.question}</p>
              {action.reason && action.reason !== action.question && (
                <p className="text-xs text-white/50">{action.reason}</p>
              )}
              {context.map((line) => (
                <p key={line} className="text-xs text-white/50">
                  {line}
                </p>
              ))}
              {options.length > 0 ? (
                <HumanActionChoices
                  options={options}
                  disabled={busyActionId === action.id}
                  onChoose={(choice) => onResolve(action.id, choice)}
                />
              ) : (
                // Nothing here invents a choice the server would reject: an action that
                // declares no response options has no safe resolution from the UI.
                <p className="text-xs text-amber-200/80">
                  This item declares no response options — resolve it from the CLI
                  (<code>agent-dealer action</code>).
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
