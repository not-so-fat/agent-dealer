import { useState } from "react";
import type { QueueSnapshot, Run } from "@agent-dealer/shared";
import PipelineQueueColumn from "../components/ops/PipelineQueueColumn";
import PipelineTicketsPanel from "../components/ops/PipelineTicketsPanel";
import PlanApprovalColumn from "../components/ops/PlanApprovalColumn";
import RunCard from "../components/RunCard";
import KanbanColumn from "../components/ui/KanbanColumn";

type Props = {
  snapshot: QueueSnapshot | null;
  selectedRunId: string | null;
  onSelectRun: (run: Run | null) => void;
};

type PipelinePanel = "planning" | "progress" | null;

export default function OperationsPage({ snapshot, selectedRunId, onSelectRun }: Props) {
  const [pipelinePanel, setPipelinePanel] = useState<PipelinePanel>(null);

  const planApproval = snapshot?.awaitingPlanReview ?? [];
  const planningActive = snapshot?.planningActiveRuns ?? [];
  const planningQueued = snapshot?.planningQueuedRuns ?? [];
  const running = snapshot?.runningRuns ?? [];
  const waiting = snapshot?.waitingExecution ?? [];
  const resultReview = snapshot?.resultReviewRuns ?? [];

  const planningTickets = [
    ...planningActive.map((run) => ({ run, queueBadge: "active" as const })),
    ...planningQueued.map((run) => ({ run, queueBadge: "queued" as const })),
  ];
  const progressTickets = [
    ...running.map((run) => ({ run, queueBadge: "active" as const })),
    ...waiting.map((run) => ({ run, queueBadge: "queued" as const })),
  ];

  const togglePanel = (panel: Exclude<PipelinePanel, null>) => {
    setPipelinePanel((current) => (current === panel ? null : panel));
  };

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full w-full min-h-0">
        <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 h-full min-h-0 items-start">
          <PipelineQueueColumn
            title="In Planning"
            total={planningTickets.length}
            open={pipelinePanel === "planning"}
            onToggle={() => togglePanel("planning")}
            accent="border-t-cyber-violet/60"
            titleAccent="text-cyber-violet-light/80"
            openRing="ring-cyber-violet/25"
          />

          <div className="relative min-h-0 h-full w-full self-stretch">
            <PlanApprovalColumn
              runs={planApproval}
              selectedId={selectedRunId}
              onSelect={onSelectRun}
            />
            {pipelinePanel === "planning" && (
              <PipelineTicketsPanel
                title="In Planning"
                items={planningTickets}
                activeBadgeLabel="Planning"
                selectedId={selectedRunId}
                onSelect={onSelectRun}
                onClose={() => setPipelinePanel(null)}
                accent="border-t-cyber-violet"
                titleAccent="text-cyber-violet-light"
                empty="Nothing planning — promote from Inbox"
              />
            )}
          </div>
        </div>

        <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 h-full min-h-0 items-start">
          <PipelineQueueColumn
            title="In Progress"
            total={progressTickets.length}
            open={pipelinePanel === "progress"}
            onToggle={() => togglePanel("progress")}
            accent="border-t-[#C4B643]"
            titleAccent="text-[#E8DC7A]"
            openRing="ring-[#C4B643]/25"
          />

          <div className="relative min-h-0 h-full w-full self-stretch">
            <KanbanColumn
              title="Review Result"
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
            {pipelinePanel === "progress" && (
              <PipelineTicketsPanel
                title="In Progress"
                items={progressTickets}
                activeBadgeLabel="Running"
                selectedId={selectedRunId}
                onSelect={onSelectRun}
                onClose={() => setPipelinePanel(null)}
                accent="border-t-[#C4B643]"
                titleAccent="text-[#E8DC7A]"
                empty="Queue empty — approve a plan to start"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
