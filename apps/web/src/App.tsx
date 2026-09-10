import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
import AgentsPage from "./pages/AgentsPage";
import IssuesListPage from "./pages/IssuesListPage";
import IssueDetailPage from "./pages/IssueDetailPage";
import HumanActionsPage from "./pages/HumanActionsPage";
import { fetchAgentDeckStatus, fetchAgents, fetchHumanActions } from "./api";
import AmbientBackground from "./components/ui/AmbientBackground";
import AgentsNavIcon from "./components/ui/AgentsNavIcon";
import AlertIcon from "./components/ui/AlertIcon";
import Logo from "./components/ui/Logo";

type View = "issues" | "actions" | "agents";

export default function App() {
  const [view, setView] = useState<View>("issues");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentWithHealth[]>([]);
  const [agentDeckOnline, setAgentDeckOnline] = useState(false);
  const [openActionCount, setOpenActionCount] = useState(0);

  const refreshAgents = useCallback(() => {
    fetchAgents()
      .then(({ agents }) => setAgents(agents))
      .catch(() => undefined);
  }, []);

  const refreshActionCount = useCallback(() => {
    fetchHumanActions().then((actions) => setOpenActionCount(actions.length)).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshAgents();
    fetchAgentDeckStatus()
      .then((s) => setAgentDeckOnline(s.connected))
      .catch(() => undefined);
    refreshActionCount();
    const poll = setInterval(refreshActionCount, 5000);
    return () => clearInterval(poll);
  }, [refreshAgents, refreshActionCount]);

  const goIssues = () => {
    setView("issues");
    setSelectedIssueId(null);
  };

  const navClass = (v: View) =>
    `px-3 py-2 text-base rounded ${view === v ? "bg-cyber-teal/20 text-cyber-teal" : "text-white/60 hover:text-white"}`;

  return (
    <>
      <AmbientBackground />
      <div className="relative z-10 min-h-screen flex flex-col">
        <header className="px-6 py-4 border-b border-white/10 flex flex-wrap gap-4 items-center justify-between glass-header shrink-0">
          <div className="flex items-center gap-6">
            <button type="button" onClick={goIssues} className="flex items-center gap-3 text-left rounded cursor-pointer hover:opacity-90 transition-opacity" aria-label="AgentDealer — go to Issues">
              <Logo size={40} />
              <div>
                <h1 className="text-xl font-bold sm:text-2xl" style={{ background: "linear-gradient(to right, #C4B643, #D4C760)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
                  AgentDealer
                </h1>
                <p className="text-sm text-cyber-teal">One issue, one durable coordination record</p>
              </div>
            </button>
            <nav className="flex gap-1">
              <button type="button" onClick={goIssues} className={navClass("issues")}>Issues</button>
              <button type="button" onClick={() => setView("actions")} className={navClass("actions")}>
                Human actions
                {openActionCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-xs bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded tabular-nums border border-red-400/30">
                    <AlertIcon className="w-3 h-3 shrink-0" />
                    {openActionCount}
                  </span>
                )}
              </button>
            </nav>
          </div>
          <button type="button" onClick={() => setView("agents")} className={`${navClass("agents")} inline-flex items-center gap-1.5`} aria-label="Agents" title="Agents">
            <AgentsNavIcon className="w-6 h-6 shrink-0" />
            <span>Agents</span>
          </button>
        </header>

        <main className="flex-1 flex overflow-hidden">
          {view === "issues" && !selectedIssueId && <IssuesListPage agents={agents} onSelectIssue={setSelectedIssueId} />}
          {view === "issues" && selectedIssueId && <IssueDetailPage issueId={selectedIssueId} onBack={() => setSelectedIssueId(null)} />}
          {view === "actions" && (
            <HumanActionsPage
              onSelectIssue={(id) => {
                setView("issues");
                setSelectedIssueId(id);
              }}
            />
          )}
          {view === "agents" && <AgentsPage agents={agents} agentDeckOnline={agentDeckOnline} onRefresh={refreshAgents} />}
        </main>
      </div>
    </>
  );
}
