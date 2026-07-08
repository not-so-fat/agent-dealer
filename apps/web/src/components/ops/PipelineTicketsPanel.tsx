import type { Run } from "@agent-dealer/shared";
import RunCard from "../RunCard";

type QueueItem = { run: Run; queueBadge: "active" | "queued" };

type Props = {
  title: string;
  items: QueueItem[];
  activeBadgeLabel: string;
  selectedId: string | null;
  onSelect: (run: Run) => void;
  onClose: () => void;
  accent: string;
  titleAccent: string;
  empty: string;
  autoApprovedRunIds?: string[];
};

/** Wide overlay panel — same slot as Review Plan / Result Review columns. */
export default function PipelineTicketsPanel({
  title,
  items,
  activeBadgeLabel,
  selectedId,
  onSelect,
  onClose,
  accent,
  titleAccent,
  empty,
  autoApprovedRunIds = [],
}: Props) {
  return (
    <section
      className={`absolute inset-0 z-10 flex flex-col min-h-0 rounded-xl overflow-hidden border border-white/10 border-t-2 ${accent} bg-[#0F0F0C] shadow-2xl`}
    >
      <header className="px-4 pt-3 pb-2.5 border-b border-white/[0.06] shrink-0 flex items-center justify-between gap-3">
        <h2 className={`heading-column ${titleAccent}`}>{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-white/45 hover:text-white/70 px-2 py-1 rounded border border-white/10 hover:border-white/20 transition-colors shrink-0"
        >
          Close
        </button>
      </header>
      <div className="flex-1 min-h-0 p-2 space-y-2 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-sm text-white/45 py-4 text-center">{empty}</p>
        ) : (
          items.map(({ run, queueBadge }) => (
            <RunCard
              key={run.id}
              run={run}
              selected={selectedId === run.id}
              onSelect={() => onSelect(run)}
              queueBadge={queueBadge}
              queueActiveLabel={activeBadgeLabel}
              queueQueuedLabel="In queue"
              hideStatusBadge
              extraBadge={
                autoApprovedRunIds.includes(run.id)
                  ? { label: "Auto-approved", className: "bg-emerald-400/15 text-emerald-200 border-emerald-400/35" }
                  : undefined
              }
            />
          ))
        )}
      </div>
    </section>
  );
}
