import { useEffect, useState } from "react";
import type { Runtime } from "@agent-dealer/shared";
import { fetchDeckPlaybooks, fetchDecks } from "./api";
import ModelSelect from "./components/agents/ModelSelect";

export type AgentConfigValue = {
  runtime: Runtime;
  deckId: string;
  playbookId: string;
  defaultPlanModel: string;
  defaultExecuteModel: string;
};

type Deck = { id: string; name: string };
type Playbook = { id: string; title: string };

type Props = {
  value: AgentConfigValue;
  onChange: (v: AgentConfigValue) => void;
  agentDeckOnline: boolean;
  disabled?: boolean;
};

export default function AgentConfigFields({ value, onChange, agentDeckOnline, disabled }: Props) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);

  useEffect(() => {
    fetchDecks().then(setDecks).catch(() => setDecks([]));
  }, []);

  useEffect(() => {
    if (!value.deckId) {
      setPlaybooks([]);
      return;
    }
    fetchDeckPlaybooks(value.deckId)
      .then(setPlaybooks)
      .catch(() => setPlaybooks([]));
  }, [value.deckId]);

  const set = (patch: Partial<AgentConfigValue>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2">
      <div className="text-base uppercase tracking-wide text-[#92E4DD]">Agent</div>
      <label className="text-xs text-[#A8C4C0] uppercase">Runtime (required)</label>
      <select
        className="field"
        disabled={disabled}
        value={value.runtime}
        onChange={(e) =>
          set({
            runtime: e.target.value as Runtime,
            defaultPlanModel: "",
            defaultExecuteModel: "",
          })
        }
      >
        <option value="claude_code">Claude Code (claude -p)</option>
        <option value="cursor_local">Cursor local (cursor agent -p)</option>
      </select>
      <ModelSelect
        runtime={value.runtime}
        label="Default planning model"
        value={value.defaultPlanModel}
        onChange={(defaultPlanModel) => set({ defaultPlanModel })}
        disabled={disabled}
      />
      <ModelSelect
        runtime={value.runtime}
        label="Default execution model"
        value={value.defaultExecuteModel}
        onChange={(defaultExecuteModel) => set({ defaultExecuteModel })}
        disabled={disabled}
      />
      <label className="text-xs text-[#A8C4C0] uppercase">Agent Deck (optional)</label>
      <select
        className="field"
        disabled={disabled || !agentDeckOnline}
        value={value.deckId}
        onChange={(e) => set({ deckId: e.target.value, playbookId: "" })}
      >
        <option value="">{agentDeckOnline ? "No deck — degraded mode" : "Agent Deck offline"}</option>
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            ◆ {d.name}
          </option>
        ))}
      </select>
      {value.deckId && playbooks.length > 0 && (
        <>
          <label className="text-xs text-[#A8C4C0] uppercase">Playbook (optional)</label>
          <select
            className="field"
            disabled={disabled}
            value={value.playbookId}
            onChange={(e) => set({ playbookId: e.target.value })}
          >
            <option value="">No playbook — agent uses task + plan only</option>
            {playbooks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </>
      )}
      {!value.deckId && value.runtime && (
        <p className="text-xs text-white/45">Degraded mode: no deck MCP. Audit trail still captured.</p>
      )}
    </div>
  );
}

export function agentConfigured(run: { runtime: string | null }): boolean {
  return !!run.runtime;
}

export function agentSummary(run: {
  agentName?: string | null;
  runtime: string | null;
  deckName: string | null;
  deckId: string | null;
  playbookId: string | null;
  planModel?: string | null;
  executeModel?: string | null;
}): string {
  if (run.agentName) {
    const parts = [run.agentName];
    if (run.deckName || run.deckId) parts.push(`◆ ${run.deckName ?? run.deckId}`);
    if (run.planModel) parts.push(`plan:${run.planModel}`);
    if (run.executeModel) parts.push(`exec:${run.executeModel}`);
    return parts.join(" · ");
  }
  const parts = [run.runtime ?? "no runtime"];
  if (run.deckName || run.deckId) parts.push(`◆ ${run.deckName ?? run.deckId}`);
  if (run.playbookId) parts.push(`pb:${run.playbookId.slice(0, 8)}…`);
  if (run.planModel) parts.push(`plan:${run.planModel}`);
  if (run.executeModel) parts.push(`exec:${run.executeModel}`);
  return parts.join(" · ");
}
