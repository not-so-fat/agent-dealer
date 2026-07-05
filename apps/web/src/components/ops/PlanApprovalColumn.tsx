import type { Run } from "@agent-dealer/shared";
import RunCard from "../RunCard";
import KanbanColumn from "../ui/KanbanColumn";

type Props = {
  runs: Run[];
  selectedId: string | null;
  onSelect: (run: Run) => void;
};

/** Leftmost Operations column — plan_pending runs awaiting human approval. */
export default function PlanApprovalColumn({ runs, selectedId, onSelect }: Props) {
  return (
    <KanbanColumn
      title="Plan Approval"
      count={runs.length}
      accent="border-t-cyber-violet"
      titleAccent="text-cyber-violet-light"
      isEmpty={runs.length === 0}
      empty={<p className="text-sm text-white/45 py-4 text-center">No plans in queue</p>}
    >
      {runs.map((run) => (
        <RunCard
          key={run.id}
          run={run}
          selected={selectedId === run.id}
          onSelect={() => onSelect(run)}
          hideStatusBadge
        />
      ))}
    </KanbanColumn>
  );
}
