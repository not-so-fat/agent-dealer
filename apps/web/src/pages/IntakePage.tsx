import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, LinearCandidate } from "@agent-dealer/shared";
import InboxCandidateCard from "../components/intake/InboxCandidateCard";
import InboxPanel from "../components/intake/InboxPanel";
import LinearImportPanel from "../components/intake/LinearImportPanel";
import LinearIssuePanel from "../components/intake/LinearIssuePanel";
import ManualTaskForm from "../components/intake/ManualTaskForm";
import { fetchLinearInbox } from "../api";

type PanelMode = "issue" | "import" | "manual" | null;

type Props = {
  agents: AgentWithHealth[];
  onRefresh: () => void;
  onGoOperations: () => void;
  onManageAgents: () => void;
};

export default function IntakePage({ agents, onRefresh, onGoOperations, onManageAgents }: Props) {
  const [candidates, setCandidates] = useState<LinearCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelMode>(null);

  const refreshInbox = useCallback(() => {
    setLoading(true);
    setError(null);
    return fetchLinearInbox()
      .then((items) => {
        setCandidates(items);
        return items;
      })
      .catch((e) => {
        setError(String(e));
        setCandidates([]);
        return [] as LinearCandidate[];
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshInbox();
  }, [refreshInbox]);

  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  const afterKick = () => {
    onRefresh();
    setPanel(null);
    setSelectedId(null);
    refreshInbox();
    onGoOperations();
  };

  const openImport = () => {
    setPanel("import");
    refreshInbox();
  };

  const openManual = () => {
    setSelectedId(null);
    setPanel("manual");
  };

  const selectIssue = (id: string) => {
    setSelectedId(id);
    setPanel("issue");
  };

  const closePanel = () => {
    setPanel(null);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 pt-4 pb-3 border-b border-white/[0.06] shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-4 max-w-6xl mx-auto w-full">
          <div>
            <h1 className="heading-page">Inbox</h1>
            <p className="text-sm text-white/50 mt-1">
              Tasks waiting to kick — import from Linear or add manually
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button" onClick={openImport} className="btn-ghost px-4 py-2 text-sm">
              Linear Import
            </button>
            <button type="button" onClick={openManual} className="btn-gold px-4 py-2 text-sm">
              + Manual Task
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 max-w-6xl mx-auto w-full">
        <div className="flex-1 flex flex-col min-h-0 min-w-0 px-6 py-4">
          {error && <p className="text-sm text-red-400/90 mb-3">{error}</p>}

          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="text-sm text-white/45">
              {loading ? "Loading…" : `${candidates.length} task${candidates.length === 1 ? "" : "s"}`}
            </p>
            <button type="button" onClick={() => refreshInbox()} disabled={loading} className="btn-ghost px-2 py-1 text-xs">
              Refresh
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
            {candidates.length === 0 && !loading ? (
              <div className="py-12 text-center space-y-3">
                <p className="text-sm text-white/45">No tasks in inbox</p>
                <div className="flex justify-center gap-2">
                  <button type="button" onClick={openImport} className="btn-ghost px-3 py-1.5 text-sm">
                    Linear Import
                  </button>
                  <button type="button" onClick={openManual} className="btn-gold px-3 py-1.5 text-sm">
                    + Manual Task
                  </button>
                </div>
              </div>
            ) : (
              candidates.map((c) => (
                <InboxCandidateCard
                  key={c.id}
                  candidate={c}
                  selected={selectedId === c.id && panel === "issue"}
                  onSelect={() => selectIssue(c.id)}
                />
              ))
            )}
          </div>
        </div>

        {panel === "issue" && selected && (
          <InboxPanel
            title={selected.identifier}
            subtitle={selected.title}
            onClose={closePanel}
          >
            <LinearIssuePanel
              issue={selected}
              agents={agents}
              onPromoted={afterKick}
              onManageAgents={onManageAgents}
            />
          </InboxPanel>
        )}

        {panel === "import" && (
          <InboxPanel title="Linear Import" subtitle="Fetch issues assigned to you" onClose={closePanel}>
            <LinearImportPanel
              agents={agents}
              loading={loading}
              candidateCount={candidates.length}
              onRefresh={refreshInbox}
              onConfigSaved={refreshInbox}
            />
          </InboxPanel>
        )}

        {panel === "manual" && (
          <InboxPanel title="Manual Task" subtitle="For testing — not the main path" onClose={closePanel}>
            <ManualTaskForm
              agents={agents}
              onCreated={afterKick}
              onManageAgents={onManageAgents}
              embedded
            />
          </InboxPanel>
        )}
      </div>
    </div>
  );
}
