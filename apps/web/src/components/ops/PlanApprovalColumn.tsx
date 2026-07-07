import type { Run } from "@agent-dealer/shared";
import RunCard from "../RunCard";
import KanbanColumn from "../ui/KanbanColumn";

type Props = {
  runs: Run[];
  openQuestionCounts: Record<string, number>;
  selectedId: string | null;
  onSelect: (run: Run) => void;
};

/** Leftmost Operations column — runs with a plan ready for human review. */
export default function PlanApprovalColumn({ runs, openQuestionCounts, selectedId, onSelect }: Props) {
  const needsAnswer = runs.filter((r) => openQuestionCounts[r.id]).length;
  return (
    <KanbanColumn
      title={needsAnswer > 0 ? `Review Plan · ${needsAnswer} need answers` : "Review Plan"}
      count={runs.length}
      accent="border-t-cyber-violet"
      titleAccent="text-cyber-violet-light"
      isEmpty={runs.length === 0}
      empty={<p className="text-sm text-white/45 py-4 text-center">No plans ready yet</p>}
    >
      {runs.map((run) => {
        const n = openQuestionCounts[run.id];
        return (
          <RunCard
            key={run.id}
            run={run}
            selected={selectedId === run.id}
            onSelect={() => onSelect(run)}
            hideStatusBadge
            extraBadge={
              n
                ? {
                    label: n === 1 ? "1 question" : `${n} questions`,
                    className: "bg-amber-400/15 text-amber-200 border-amber-400/35",
                  }
                : undefined
            }
          />
        );
      })}
    </KanbanColumn>
  );
}
