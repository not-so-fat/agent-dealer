import { useEffect, useState } from "react";
import type { AgentWithHealth, LinearCandidate } from "@agent-dealer/shared";
import AgentPicker from "../agents/AgentPicker";
import { fetchLinearConfig, promoteLinearIssue } from "../../api";

type Props = {
  issue: LinearCandidate;
  agents: AgentWithHealth[];
  onPromoted: () => void;
  onManageAgents?: () => void;
};

export default function LinearIssuePanel({ issue, agents, onPromoted, onManageAgents }: Props) {
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchLinearConfig()
      .then((cfg) => {
        if (cfg.defaultAgentId) setAgentId(cfg.defaultAgentId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (agents.length > 0 && agentId && !agents.some((a) => a.id === agentId)) {
      setAgentId(agents[0]!.id);
    }
    if (agents.length > 0 && !agentId) {
      setAgentId(agents[0]!.id);
    }
  }, [agents, agentId]);

  const selectedAgent = agents.find((a) => a.id === agentId);

  const kickPlan = async () => {
    if (!agentId) return;
    setBusy(true);
    try {
      await promoteLinearIssue(issue.id, { agentId });
      onPromoted();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {issue.description && (
        <div className="rounded-xl p-3 glass-plate text-sm text-white/60 leading-relaxed whitespace-pre-wrap">
          {issue.description}
        </div>
      )}
      {issue.url && (
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-[#AEB4FF] hover:underline inline-block"
        >
          Open in Linear ↗
        </a>
      )}
      <AgentPicker
        agents={agents}
        selectedId={agentId}
        onSelect={setAgentId}
        onManage={onManageAgents}
        requireHealthy
      />
      <button
        type="button"
        disabled={busy || !agentId || !(selectedAgent?.healthy ?? false)}
        onClick={kickPlan}
        className="btn-gold w-full py-2"
      >
        {busy ? "Starting…" : "Kick plan"}
      </button>
    </>
  );
}
