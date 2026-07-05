import { useMemo, useState } from "react";
import type { Run } from "@agent-dealer/shared";
import DoneRunRow from "../components/done/DoneRunRow";

type Props = {
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun: (run: Run | null) => void;
};

export default function DonePage({ runs, selectedRunId, onSelectRun }: Props) {
  const [query, setQuery] = useState("");

  const done = useMemo(
    () =>
      runs
        .filter((r) => r.status === "done")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [runs]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return done;
    return done.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.externalLabel?.toLowerCase().includes(q) ||
        r.externalId?.toLowerCase().includes(q) ||
        r.source.toLowerCase().includes(q) ||
        r.taskCategory.toLowerCase().includes(q) ||
        r.deckName?.toLowerCase().includes(q) ||
        r.agentName?.toLowerCase().includes(q)
    );
  }, [done, query]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 pt-4 pb-3 border-b border-white/[0.06] shrink-0">
        <div className="max-w-6xl mx-auto w-full">
          <h1 className="heading-page">Done</h1>
          <p className="text-sm text-white/50 mt-1">Completed runs — read-only audit trail</p>
          <input
            className="field mt-3 max-w-xl"
            placeholder="Search title, issue id, category, deck…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="text-sm text-white/45 mt-2">
            {filtered.length} of {done.length} completed
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        <div className="max-w-6xl mx-auto w-full space-y-1.5">
          {filtered.length > 0 && (
            <div
              className="hidden md:grid grid-cols-[7rem_minmax(0,1fr)_8rem_6rem_7rem_5rem] gap-x-4 px-4 pb-1 text-[10px] uppercase tracking-wider text-white/30"
              aria-hidden
            >
              <span>Source</span>
              <span>Title</span>
              <span>Agent</span>
              <span>Type</span>
              <span>Deck</span>
              <span className="text-right">Done</span>
            </div>
          )}

          {filtered.length === 0 ? (
            <p className="text-sm text-white/45 py-8 text-center">
              {done.length === 0 ? "No completed runs yet" : "No matches for your search"}
            </p>
          ) : (
            filtered.map((run) => (
              <DoneRunRow
                key={run.id}
                run={run}
                selected={selectedRunId === run.id}
                onSelect={() => onSelectRun(run)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
