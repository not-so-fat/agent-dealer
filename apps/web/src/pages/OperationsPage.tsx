import type { QueueSnapshot, Run } from "@agent-dealer/shared";
import ExecutionQueueColumn from "../components/ops/ExecutionQueueColumn";
import PlanApprovalColumn from "../components/ops/PlanApprovalColumn";
import RunCard from "../components/RunCard";
import KanbanColumn from "../components/ui/KanbanColumn";

type Props = {
  snapshot: QueueSnapshot | null;
  selectedRunId: string | null;
  onSelectRun: (run: Run | null) => void;
};

export default function OperationsPage({ snapshot, selectedRunId, onSelectRun }: Props) {
  const planApproval = snapshot?.awaitingPlanReview ?? [];
  const running = snapshot?.runningRuns ?? [];
  const waiting = snapshot?.waitingExecution ?? [];
  const resultReview = snapshot?.resultReviewRuns ?? [];

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 h-full w-full min-h-0">
          <PlanApprovalColumn
            runs={planApproval}
            selectedId={selectedRunId}
            onSelect={onSelectRun}
          />

          <ExecutionQueueColumn
            running={running}
            waiting={waiting}
            selectedId={selectedRunId}
            onSelect={onSelectRun}
          />

          <KanbanColumn
            title="Result Review"
            count={resultReview.length}
            accent="border-t-[#C4B643]"
            titleAccent="text-[#E8DC7A]"
            isEmpty={resultReview.length === 0}
            empty={<p className="text-sm text-white/45 py-4 text-center">Nothing awaiting sign-off</p>}
          >
            {resultReview.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                selected={selectedRunId === run.id}
                onSelect={() => onSelectRun(run)}
                hideStatusBadge={run.status === "review"}
              />
            ))}
          </KanbanColumn>
        </div>
    </div>
  );
}
