import type { HumanAction } from "@agent-dealer/shared";
import AlertIcon from "../ui/AlertIcon";
import HumanActionCard from "./HumanActionCard";

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
 * NOT-288: both scopes render through HumanActionCard, the same compact
 * summary + expandable Details Issue Detail uses — so the home and the detail
 * agree on the question, choice labels, and Details content for one action.
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
          if (action.issueId) {
            return (
              <div key={action.id} className="px-4 py-3 hover:bg-white/5 transition-colors">
                <HumanActionCard action={action} linkTo={`/issues/${action.issueId}`} />
              </div>
            );
          }

          return (
            <div key={action.id} className="px-4 py-3">
              <HumanActionCard
                action={action}
                disabled={busyActionId === action.id}
                onChoose={(choice) => onResolve(action.id, choice)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
