import { useEffect, useState } from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
import { BUILTIN_AGENT_CLAUDE_ID } from "@agent-dealer/shared";
import AgentPicker from "../agents/AgentPicker";
import { createRun } from "../../api";

const SAMPLE = {
  title: "Write a random facts sheet",
  description: "Generate a short markdown document with 5 random fun facts about coffee. Keep it under 30 lines.",
  taskCategory: "content" as const,
};

type Props = {
  agents: AgentWithHealth[];
  onCreated: () => void;
  onManageAgents?: () => void;
  /** Strip outer panel chrome when rendered inside InboxPanel */
  embedded?: boolean;
};

export default function ManualTaskForm({ agents, onCreated, onManageAgents, embedded }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("other");
  const [repo, setRepo] = useState("");
  const [agentId, setAgentId] = useState(BUILTIN_AGENT_CLAUDE_ID);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (agents.length > 0 && !agents.some((a) => a.id === agentId)) {
      setAgentId(agents[0]!.id);
    }
  }, [agents, agentId]);

  const fillSample = () => {
    setTitle(SAMPLE.title);
    setDescription(SAMPLE.description);
    setCategory(SAMPLE.taskCategory);
  };

  const selectedAgent = agents.find((a) => a.id === agentId);
  const canKick =
    !!agentId &&
    !!title.trim() &&
    (!!repo.trim() || (selectedAgent?.healthy ?? false));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !agentId) return;
    setLoading(true);
    try {
      await createRun({
        title: title.trim(),
        description: description.trim() || undefined,
        taskCategory: category,
        repo: repo.trim() || undefined,
        agentId,
      });
      setTitle("");
      setDescription("");
      onCreated();
    } catch (err) {
      alert(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className={embedded ? "space-y-3" : "panel space-y-3"}>
      {!embedded && <h2 className="heading-panel">Manual Task</h2>}
      <AgentPicker
        agents={agents}
        selectedId={agentId}
        onSelect={setAgentId}
        onManage={onManageAgents}
      />
      <input className="field" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        className="field-mono h-16 resize-y"
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex gap-2">
        <select className="field flex-1" value={category} onChange={(e) => setCategory(e.target.value)}>
          {["code", "communication", "email", "research", "content", "other"].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          className="field flex-1"
          placeholder="Repo override (optional)"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
      </div>
      <p className="text-xs text-white/40 -mt-1">
        Uses agent workspace by default. Override here for a one-off path.
      </p>
      <button type="button" onClick={fillSample} className="btn-ghost text-xs px-2 py-1 w-full">
        Sample: random document
      </button>
      <button type="submit" disabled={loading || !canKick} className="btn-gold w-full py-2">
        {loading ? "Starting…" : "Kick plan"}
      </button>
    </form>
  );
}
