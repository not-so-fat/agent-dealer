import { useCallback, useEffect, useState } from "react";
import type { AgentWithHealth, HumanAction } from "@agent-dealer/shared";
import AgentsPage from "./pages/AgentsPage";
import IssuesListPage from "./pages/IssuesListPage";
import IssueDetailPage from "./pages/IssueDetailPage";
import { fetchAgentDeckStatus, fetchAgents, fetchHumanActions } from "./api";
import AmbientBackground from "./components/ui/AmbientBackground";
import AlertIcon from "./components/ui/AlertIcon";
import AgentsNavIcon from "./components/ui/AgentsNavIcon";
import Logo from "./components/ui/Logo";

// NOT-71: Agent Dealer is an issue queue and execution control plane. The run-oriented
// plan/execute product (Operations / Inbox / Done) and the standalone Human actions
// destination are gone — open human actions are part of the issue queue home now.
type View = "issues" | "agents";

const POLL_MS = 5000;

export default function App() {
  const [view, setView] = useState<View>("issues");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentWithHealth[]>([]);
  const [agentIssueCount, setAgentIssueCount] = useState(0);
  const [agentDeckOnline, setAgentDeckOnline] = useState(false);
  const [humanActions, setHumanActions] = useState<HumanAction[]>([]);

  const refreshAgents = useCallback(() => {
    fetchAgents()
      .then(({ agents: list, issueCount }) => {
        setAgents(list);
        setAgentIssueCount(issueCount);
      })
      .catch(console.error);
    fetchAgentDeckStatus()
      .then((s) => setAgentDeckOnline(s.connected))
      .catch(() => setAgentDeckOnline(false));
  }, []);

  // One poll for every open action, shared by the header badge and the Issues home panel —
  // the two used to poll `/api/human-actions` separately.
  const refreshHumanActions = useCallback(
    () => fetchHumanActions().then(setHumanActions).catch(() => undefined),
    []
  );

  useEffect(() => {
    refreshAgents();
    const poll = setInterval(refreshAgents, POLL_MS);
    return () => clearInterval(poll);
  }, [refreshAgents]);

  useEffect(() => {
    void refreshHumanActions();
    const poll = setInterval(() => void refreshHumanActions(), POLL_MS);
    return () => clearInterval(poll);
  }, [refreshHumanActions]);

  const openHumanActionCount = humanActions.length;
  const agentCount = agents.length;

  const navClass = (v: View) =>
    `px-3 py-2 text-base rounded ${view === v ? "bg-cyber-teal/20 text-cyber-teal" : "text-white/60 hover:text-white"}`;

  const goIssues = () => {
    setView("issues");
    setSelectedIssueId(null);
  };
  const goAgents = () => setView("agents");

  return (
    <>
      <AmbientBackground />
      <div className="relative z-10 min-h-screen flex flex-col">
        <header className="px-6 py-4 border-b border-white/10 flex flex-wrap gap-4 items-center justify-between glass-header shrink-0">
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={goIssues}
              className="flex items-center gap-3 text-left rounded cursor-pointer hover:opacity-90 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyber-teal/45"
              aria-label="AgentDealer — go to Issues"
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
                <p className="text-sm text-cyber-teal">One issue, one durable coordination record</p>
              </div>
            </button>
            <nav className="flex gap-1">
              <button type="button" onClick={goIssues} className={navClass("issues")}>
                Issues
                {openHumanActionCount > 0 && (
                  <span
                    className="ml-1.5 inline-flex items-center gap-0.5 text-xs leading-none bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded tabular-nums border border-red-400/30 align-middle"
                    title={`${openHumanActionCount} open human action${openHumanActionCount === 1 ? "" : "s"}`}
                  >
                    <AlertIcon className="w-3 h-3 shrink-0" />
                    {openHumanActionCount}
                  </span>
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
            <span>Agents</span>
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
          {view === "issues" && !selectedIssueId && (
            <IssuesListPage
              agents={agents}
              humanActions={humanActions}
              onSelectIssue={setSelectedIssueId}
              onHumanActionsChanged={refreshHumanActions}
            />
          )}
          {view === "issues" && selectedIssueId && (
            <IssueDetailPage
              issueId={selectedIssueId}
              agents={agents}
              onBack={() => setSelectedIssueId(null)}
              onHumanActionsChanged={refreshHumanActions}
            />
          )}
          {view === "agents" && (
            <AgentsPage agents={agents} agentDeckOnline={agentDeckOnline} onRefresh={refreshAgents} />
          )}
        </main>
      </div>
    </>
  );
}
