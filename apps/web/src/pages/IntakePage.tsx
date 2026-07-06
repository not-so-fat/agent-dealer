import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, LinearCandidate, LinearIntakeConfigView } from "@agent-dealer/shared";
import InboxCandidateCard from "../components/intake/InboxCandidateCard";
import InboxPanel from "../components/intake/InboxPanel";
import IntakeIssueDrawer from "../components/intake/IntakeIssueDrawer";
import LinearImportPanel from "../components/intake/LinearImportPanel";
import ManualTaskForm from "../components/intake/ManualTaskForm";
import { fetchLinearConfig, fetchLinearInbox, fetchLinearStatus } from "../api";
import { nextInQueue, queueIndex } from "../lib/reviewQueue";

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
  const [linearConfig, setLinearConfig] = useState<LinearIntakeConfigView | null>(null);
  const [linearConnected, setLinearConnected] = useState(false);

  const refreshInbox = useCallback(() => {
    setLoading(true);
    setError(null);
    return Promise.all([fetchLinearInbox(), fetchLinearConfig(), fetchLinearStatus()])
      .then(([items, cfg, status]) => {
        setCandidates(items);
        setLinearConfig(cfg);
        setLinearConnected(status.connected);
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
  const inboxIndex = selectedId ? queueIndex(candidates, selectedId) : -1;

  const goToInboxAt = useCallback((index: number) => {
    const candidate = candidates[index];
    if (candidate) {
      setSelectedId(candidate.id);
      setPanel("issue");
    }
  }, [candidates]);

  const advanceAfterKick = useCallback(
    async (currentId: string) => {
      const next = nextInQueue(candidates, currentId);
      onRefresh();
      const items = await refreshInbox();
      if (!next) {
        setPanel(null);
        setSelectedId(null);
        return;
      }
      const stillThere = items.find((c) => c.id === next.id);
      if (stillThere) {
        setSelectedId(stillThere.id);
        setPanel("issue");
        return;
      }
      const fallback = nextInQueue(items, currentId);
      if (fallback) {
        setSelectedId(fallback.id);
        setPanel("issue");
      } else {
        setPanel(null);
        setSelectedId(null);
      }
    },
    [candidates, onRefresh, refreshInbox],
  );

  const afterManualCreated = () => {
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
    setSelectedId(null);
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

      <div className="flex-1 flex flex-col min-h-0 max-w-6xl mx-auto w-full px-6 py-4">
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
              {linearConnected && linearConfig && (
                <p className="text-xs text-white/40 max-w-md mx-auto">
                  Filtering Linear: {linearConfig.stateFilter.join(", ")}
                  {linearConfig.assigneeMe ? " · assigned to you" : ""}
                  {linearConfig.envOverrides.stateFilter || linearConfig.envOverrides.teamId
                    ? " · some filters from env"
                    : ""}
                </p>
              )}
              <div className="flex justify-center gap-2">
                <button type="button" onClick={openImport} className="btn-ghost px-3 py-1.5 text-sm">
                  Linear settings
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
          <InboxPanel title="Manual Task" subtitle="Add work that isn't in Linear yet" onClose={closePanel}>
            <ManualTaskForm
              agents={agents}
              onCreated={afterManualCreated}
              onManageAgents={onManageAgents}
              embedded
            />
          </InboxPanel>
        )}

      {panel === "issue" && selected && (
        <IntakeIssueDrawer
          issue={selected}
          agents={agents}
          onClose={closePanel}
          onPromoted={() => advanceAfterKick(selected.id)}
          onManageAgents={onManageAgents}
          queueNav={
            candidates.length > 1
              ? {
                  index: inboxIndex,
                  total: candidates.length,
                  onPrev: () => goToInboxAt(inboxIndex - 1),
                  onNext: () => goToInboxAt(inboxIndex + 1),
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
