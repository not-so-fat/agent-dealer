import { useState } from "react";
import type { AgentWithHealth, CreateAgentInput, UpdateAgentInput } from "@agent-dealer/shared";
import AgentConfigFields, { type AgentConfigValue } from "../AgentConfigFields";
import { createAgent, deleteAgent, updateAgent } from "../api";
import { runtimeLabel } from "../lib/display";
import Badge from "../components/ui/Badge";
import { AgentRuntimeIcon } from "../components/agents/AgentIcon";

type Props = {
  agents: AgentWithHealth[];
  agentDeckOnline: boolean;
  onRefresh: () => void;
};

const emptyConfig = (): AgentConfigValue => ({
  runtime: "claude_code",
  deckId: "",
  playbookId: "",
});

export default function AgentsPage({ agents, agentDeckOnline, onRefresh }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [config, setConfig] = useState<AgentConfigValue>(emptyConfig());
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editWorkspace, setEditWorkspace] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !workspaceRoot.trim()) return;
    setBusy(true);
    try {
      const body: CreateAgentInput = {
        name: name.trim(),
        runtime: config.runtime,
        workspaceRoot: workspaceRoot.trim(),
        deckId: config.deckId || undefined,
        playbookId: config.playbookId || undefined,
      };
      await createAgent(body);
      setName("");
      setWorkspaceRoot("");
      setConfig(emptyConfig());
      setShowForm(false);
      onRefresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (agent: AgentWithHealth) => {
    setEditingId(agent.id);
    setEditWorkspace(agent.workspaceRoot ?? "");
  };

  const saveEdit = async (agent: AgentWithHealth) => {
    setBusy(true);
    try {
      const body: UpdateAgentInput = {
        workspaceRoot: editWorkspace.trim() || null,
      };
      await updateAgent(agent.id, body);
      setEditingId(null);
      onRefresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent: AgentWithHealth) => {
    if (agent.isBuiltin) return;
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    setBusy(true);
    try {
      await deleteAgent(agent.id);
      onRefresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  const issueCount = agents.filter((a) => !a.healthy).length;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 max-w-3xl">
      <div className="mb-6">
        <h1 className="heading-page">Agents</h1>
        <p className="text-sm text-white/50 mt-1">
          Saved execution profiles — pick one at Inbox instead of configuring each task
        </p>
        <p className="text-sm text-white/45 mt-2">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
          {issueCount > 0 && (
            <span className="text-red-400 ml-2">
              · {issueCount} need{issueCount === 1 ? "s" : ""} attention
            </span>
          )}
        </p>
      </div>

      <div className="space-y-3 mb-6">
        {agents.map((agent) => (
          <div key={agent.id} className="panel flex flex-col sm:flex-row sm:items-start gap-3 justify-between">
            <div className="flex gap-3 min-w-0 flex-1">
              <AgentRuntimeIcon runtime={agent.runtime} />
              <div className="space-y-2 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg font-semibold text-[#E8F6F4]">{agent.name}</span>
                  {agent.isBuiltin && (
                    <Badge className="bg-white/5 text-white/45 border-white/15 normal-case">Built-in</Badge>
                  )}
                  {!agent.healthy && (
                    <Badge className="bg-red-500/15 text-red-300 border-red-400/30 normal-case">Needs fix</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge className="bg-white/5 text-white/55 border-white/15 normal-case">
                    {runtimeLabel(agent.runtime)}
                  </Badge>
                  {agent.deckName ? (
                    <Badge className="bg-[#92E4DD]/10 text-[#92E4DD] border-[#92E4DD]/25 normal-case">
                      ◆ {agent.deckName}
                    </Badge>
                  ) : (
                    <Badge className="bg-white/5 text-white/40 border-white/10 normal-case">No deck</Badge>
                  )}
                </div>
                {editingId === agent.id ? (
                  <div className="space-y-2 pt-1">
                    <input
                      className="field text-sm"
                      placeholder="Workspace path (e.g. /Users/me/projects/my-app)"
                      value={editWorkspace}
                      onChange={(e) => setEditWorkspace(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy || !editWorkspace.trim()}
                        onClick={() => saveEdit(agent)}
                        className="btn-gold text-sm px-3 py-1.5"
                      >
                        Save workspace
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="btn-ghost text-sm px-3 py-1.5"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-white/50 font-mono truncate" title={agent.workspaceRoot ?? undefined}>
                    {agent.workspaceRoot ? agent.workspaceRoot : "No workspace configured"}
                  </p>
                )}
                {agent.issues.length > 0 && (
                  <ul className="text-sm text-red-300/90 space-y-1">
                    {agent.issues.map((issue, i) => (
                      <li key={i}>· {issue.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {editingId !== agent.id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => startEdit(agent)}
                  className="btn-ghost text-sm px-3 py-1.5"
                >
                  Edit workspace
                </button>
              )}
              {!agent.isBuiltin && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => remove(agent)}
                  className="btn-ghost text-sm px-3 py-1.5"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showForm ? (
        <form onSubmit={submit} className="panel space-y-3">
          <h2 className="heading-panel">New Agent</h2>
          <input
            className="field"
            placeholder="Agent name (e.g. Claude · Work)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="field font-mono text-sm"
            placeholder="Workspace path (required)"
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRoot(e.target.value)}
          />
          <AgentConfigFields value={config} onChange={setConfig} agentDeckOnline={agentDeckOnline} />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !name.trim() || !workspaceRoot.trim()}
              className="btn-gold px-4 py-2"
            >
              {busy ? "Saving…" : "Create agent"}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-ghost px-4 py-2">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setShowForm(true)} className="btn-gold px-4 py-2">
          Add agent
        </button>
      )}
    </div>
  );
}
