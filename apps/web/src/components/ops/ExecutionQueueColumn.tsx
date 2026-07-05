import type { Run } from "@agent-dealer/shared";
import RunCard from "../RunCard";
import KanbanColumn from "../ui/KanbanColumn";

type QueueItem = { run: Run; queueStatus: "running" | "waiting" };

type Props = {
  running: Run[];
  waiting: Run[];
  selectedId: string | null;
  onSelect: (run: Run) => void;
};

/** Merged execution queue — running at top, waiting below in FIFO order. */
export default function ExecutionQueueColumn({ running, waiting, selectedId, onSelect }: Props) {
  const items: QueueItem[] = [
    ...running.map((run) => ({ run, queueStatus: "running" as const })),
    ...waiting.map((run) => ({ run, queueStatus: "waiting" as const })),
  ];

  return (
    <KanbanColumn
      title="In Progress"
      count={items.length}
      accent="border-t-[#92E4DD]"
      titleAccent="text-[#92E4DD]"
      isEmpty={items.length === 0}
      empty={<p className="text-sm text-white/45 py-4 text-center">Queue empty — approve a plan to start</p>}
    >
      {items.map(({ run, queueStatus }) => (
        <RunCard
          key={run.id}
          run={run}
          selected={selectedId === run.id}
          onSelect={() => onSelect(run)}
          queueBadge={queueStatus}
          statusOverride={queueStatus === "waiting" ? "plan_approved" : "running"}
        />
      ))}
    </KanbanColumn>
  );
}
