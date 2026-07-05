import { useCallback, useEffect, useMemo, useState } from "react";
import type { QueueSnapshot, Run } from "@agent-dealer/shared";
import RunDrawer from "./components/drawer/RunDrawer";
import AgentsPage from "./pages/AgentsPage";
import DonePage from "./pages/DonePage";
import IntakePage from "./pages/IntakePage";
import OperationsPage from "./pages/OperationsPage";
import { fetchSnapshot, subscribeEvents } from "./api";
import { nextInQueue, queueIndex, reviewQueueForRun } from "./lib/reviewQueue";
import AmbientBackground from "./components/ui/AmbientBackground";
import AlertIcon from "./components/ui/AlertIcon";
import AgentsNavIcon from "./components/ui/AgentsNavIcon";
import Logo from "./components/ui/Logo";

type View = "ops" | "intake" | "done" | "agents";

export default function App() {
  const [view, setView] = useState<View>("ops");
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);

  const refresh = useCallback(() => {
    fetchSnapshot().then(setSnapshot).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const unsub = subscribeEvents(setSnapshot);
    const poll = setInterval(refresh, 5000);
    return () => {
      unsub();
      clearInterval(poll);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedRun || !snapshot) return;
    const updated = snapshot.runs.find((r) => r.id === selectedRun.id);
    if (updated) setSelectedRun(updated);
  }, [snapshot, selectedRun?.id]);

  const resultReviewCount = snapshot?.resultReviewRuns?.length ?? 0;
  const planReviewCount = snapshot?.awaitingPlanReview?.length ?? 0;
  const doneCount = snapshot?.runs.filter((r) => r.status === "done").length ?? 0;
  const agentCount = snapshot?.agents?.length ?? 0;
  const agentIssueCount = snapshot?.agentIssueCount ?? 0;

  const actionTotal = planReviewCount + resultReviewCount;

  const reviewQueue = useMemo(() => {
    if (!selectedRun || !snapshot) return [];
    return reviewQueueForRun(selectedRun, snapshot, view);
  }, [selectedRun, snapshot, view]);

  const reviewIndex = selectedRun ? queueIndex(reviewQueue, selectedRun.id) : -1;

  const goToReviewAt = useCallback((index: number) => {
    const run = reviewQueue[index];
    if (run) setSelectedRun(run);
  }, [reviewQueue]);

  const advanceAfterAction = useCallback(
    async (currentId: string) => {
      if (!snapshot) return;
      const queue = reviewQueueForRun(
        snapshot.runs.find((r) => r.id === currentId) ?? selectedRun!,
        snapshot,
        view
      );
      const next = nextInQueue(queue, currentId);
      const snap = await fetchSnapshot();
      setSnapshot(snap);
      if (!next) {
        setSelectedRun(null);
        return;
      }
      setSelectedRun(snap.runs.find((r) => r.id === next.id) ?? null);
    },
    [snapshot, selectedRun, view]
  );

  const navClass = (v: View) =>
    `px-3 py-2 text-base rounded ${view === v ? "bg-[#92E4DD]/20 text-[#92E4DD]" : "text-white/60 hover:text-white"}`;

  const goAgents = () => setView("agents");

  return (
    <>
      <AmbientBackground />
      <div className="relative z-10 min-h-screen flex flex-col">
      <header className="px-6 py-4 border-b border-white/10 flex flex-wrap gap-4 items-center justify-between glass-header shrink-0">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => {
              setView("ops");
              setSelectedRun(null);
            }}
            className="flex items-center gap-3 text-left rounded cursor-pointer hover:opacity-90 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#92E4DD]/45"
            aria-label="AgentDealer — go to Operations"
          >
            <Logo size={40} />
            <div>
              <h1
                className="text-xl font-bold sm:text-2xl"
                style={{
                  background: "linear-gradient(to right, #C4B643, #D4C760)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                AgentDealer
              </h1>
              <p className="text-sm text-[#92E4DD]">Kick tasks, approve plans, review results</p>
            </div>
          </button>
          <nav className="flex gap-1">
            <button type="button" onClick={() => setView("ops")} className={navClass("ops")}>
              Operations
              {actionTotal > 0 && (
                <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
                  {planReviewCount > 0 && (
                    <span
                      className="text-xs leading-none bg-cyber-violet/20 text-cyber-violet-light px-1.5 py-0.5 rounded tabular-nums border border-cyber-violet/35"
                      title={`${planReviewCount} plan${planReviewCount === 1 ? "" : "s"} ready to review`}
                    >
                      {planReviewCount}
                    </span>
                  )}
                  {resultReviewCount > 0 && (
                    <span
                      className="text-xs leading-none bg-[#C4B643]/30 text-[#E8DC7A] px-1.5 py-0.5 rounded tabular-nums"
                      title={`${resultReviewCount} result${resultReviewCount === 1 ? "" : "s"} to review`}
                    >
                      {resultReviewCount}
                    </span>
                  )}
                </span>
              )}
            </button>
            <button type="button" onClick={() => setView("intake")} className={navClass("intake")}>
              Inbox
            </button>
            <button type="button" onClick={() => setView("done")} className={navClass("done")}>
              Done
              {doneCount > 0 && (
                <span className="ml-1 text-xs bg-white/10 px-1.5 py-0.5 rounded">{doneCount}</span>
              )}
            </button>
          </nav>
        </div>
        <button
          type="button"
          onClick={goAgents}
          className={`${navClass("agents")} inline-flex items-center gap-1.5 transition-colors`}
          aria-label="Agents"
          title="Agents"
        >
          <AgentsNavIcon className="w-6 h-6 shrink-0" />
          {agentCount > 0 && (
            <span
              className="text-xs leading-none bg-white/10 text-white/55 px-1.5 py-0.5 rounded tabular-nums border border-white/10"
              title={`${agentCount} configured agent${agentCount === 1 ? "" : "s"}`}
            >
              {agentCount}
            </span>
          )}
          {agentIssueCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-xs leading-none bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded tabular-nums border border-red-400/30"
              title={`${agentIssueCount} need${agentIssueCount === 1 ? "s" : ""} attention`}
            >
              <AlertIcon className="w-3 h-3 shrink-0" />
              {agentIssueCount}
            </span>
          )}
        </button>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {view === "ops" && (
          <OperationsPage
            snapshot={snapshot}
            selectedRunId={selectedRun?.id ?? null}
            onSelectRun={setSelectedRun}
          />
        )}
        {view === "intake" && (
          <IntakePage
            agents={snapshot?.agents ?? []}
            onRefresh={refresh}
            onGoOperations={() => setView("ops")}
            onManageAgents={goAgents}
          />
        )}
        {view === "agents" && (
          <AgentsPage
            agents={snapshot?.agents ?? []}
            agentDeckOnline={snapshot?.agentDeckOnline ?? false}
            onRefresh={refresh}
          />
        )}
        {view === "done" && (
          <DonePage
            runs={snapshot?.runs ?? []}
            selectedRunId={selectedRun?.id ?? null}
            onSelectRun={setSelectedRun}
          />
        )}
      </main>

      {selectedRun && (
        <RunDrawer
          run={selectedRun}
          agents={snapshot?.agents ?? []}
          onClose={() => setSelectedRun(null)}
          onRefresh={refresh}
          onApproved={refresh}
          onApprovedAndNext={() => advanceAfterAction(selectedRun.id)}
          onDoneAndNext={() => advanceAfterAction(selectedRun.id)}
          queueNav={
            reviewQueue.length > 1
              ? {
                  runs: reviewQueue,
                  index: reviewIndex,
                  onPrev: () => goToReviewAt(reviewIndex - 1),
                  onNext: () => goToReviewAt(reviewIndex + 1),
                }
              : undefined
          }
          onRetry={(newRun) => {
            setSelectedRun(newRun);
            setView("ops");
            refresh();
          }}
        />
      )}
      </div>
    </>
  );
}
