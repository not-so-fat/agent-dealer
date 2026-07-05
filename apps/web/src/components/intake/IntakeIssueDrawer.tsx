import { useCallback } from "react";
import type { AgentWithHealth, LinearCandidate } from "@agent-dealer/shared";
import DrawerNav from "../drawer/DrawerNav";
import ReviewDrawer from "../drawer/ReviewDrawer";
import LinearIssuePanel from "./LinearIssuePanel";

type QueueNav = {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
};

type Props = {
  issue: LinearCandidate;
  agents: AgentWithHealth[];
  onClose: () => void;
  onPromoted: () => void;
  onManageAgents?: () => void;
  queueNav?: QueueNav;
};

export default function IntakeIssueDrawer({
  issue,
  agents,
  onClose,
  onPromoted,
  onManageAgents,
  queueNav,
}: Props) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!queueNav) return;
      if (e.key === "ArrowLeft" && queueNav.index > 0) {
        e.preventDefault();
        queueNav.onPrev();
      }
      if (e.key === "ArrowRight" && queueNav.index < queueNav.total - 1) {
        e.preventDefault();
        queueNav.onNext();
      }
    },
    [queueNav],
  );

  return (
    <ReviewDrawer onClose={onClose} onKeyDown={onKeyDown} header={
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="font-semibold text-2xl leading-snug">{issue.identifier}</h2>
            <p className="text-sm text-white/55 leading-snug">{issue.title}</p>
          </div>
          <div className="flex items-start gap-2 shrink-0">
            {queueNav && (
              <DrawerNav
                index={queueNav.index}
                total={queueNav.total}
                onPrev={queueNav.onPrev}
                onNext={queueNav.onNext}
                label="In Inbox"
              />
            )}
            <button type="button" onClick={onClose} className="text-white/60 hover:text-white px-1" aria-label="Close">
              ✕
            </button>
          </div>
        </div>
      }
    >
      <LinearIssuePanel
        issue={issue}
        agents={agents}
        onPromoted={onPromoted}
        onManageAgents={onManageAgents}
      />
    </ReviewDrawer>
  );
}
