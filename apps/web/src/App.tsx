import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
import AgentsPage from "./pages/AgentsPage";
import IssuesListPage from "./pages/IssuesListPage";
import IssueDetailPage from "./pages/IssueDetailPage";
import { fetchAgentDeckStatus, fetchAgents } from "./api";
import AmbientBackground from "./components/ui/AmbientBackground";
import AgentsNavIcon from "./components/ui/AgentsNavIcon";
import Logo from "./components/ui/Logo";

type View = "issues" | "agents";

export default function App() {
  const [view, setView] = useState<View>("issues");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentWithHealth[]>([]);
  const [agentDeckOnline, setAgentDeckOnline] = useState(false);

  const refreshAgents = useCallback(() => {
    fetchAgents()
      .then(({ agents }) => setAgents(agents))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshAgents();
    fetchAgentDeckStatus()
      .then((s) => setAgentDeckOnline(s.connected))
      .catch(() => undefined);
  }, [refreshAgents]);

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
          {view === "agents" && <AgentsPage agents={agents} agentDeckOnline={agentDeckOnline} onRefresh={refreshAgents} />}
        </main>
      </div>
    </>
  );
}
