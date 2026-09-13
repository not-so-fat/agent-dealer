import { useEffect, useState } from "react";
import type { PermissionPolicyOverride, Runtime } from "@agent-dealer/shared";
import { CURSOR_DEFAULT_MODEL } from "@agent-dealer/shared";
import { fetchDeckPlaybooks, fetchDecks } from "./api";
import PhaseConfigRow from "./components/agents/PhaseConfigRow";
import { budgetFormEmpty, type BudgetFormValue } from "./lib/budgetForm";

export type AgentConfigValue = {
  runtime: Runtime;
  deckId: string;
  playbookId: string;
  defaultPlanModel: string;
  defaultExecuteModel: string;
  defaultPlanBudget: BudgetFormValue;
  defaultExecuteBudget: BudgetFormValue;
  // Issue-centric (developer/reviewer) session defaults — snapshotted per session.
  purpose: string;
  defaultModel: string;
  defaultBudget: BudgetFormValue;
  playbookIds: string[];
  externalMemoryRefs: string;
  /**
   * Worktree write access this profile allows — unchecking pins it off, enforced by the
   * CLI's own tool grant (no Write/Edit/Bash, or a read-only sandbox). There is no
   * push/open-PR toggle: a PR review round proved every mechanism tried for those
   * bypassable by a session that already holds Bash, so they aren't offered as a
   * profile capability (see profile-snapshot.ts's PermissionPolicy doc comment).
   */
  allowWorktreeWrite: boolean;
};

/** Form capability flags → the tighten-only override the API stores (null when unchanged). */
export function permissionOverride(v: AgentConfigValue): PermissionPolicyOverride | null {
  const o: PermissionPolicyOverride = {};
  if (!v.allowWorktreeWrite) o.worktreeWrite = false;
  return Object.keys(o).length ? o : null;
}

export function permissionFlagsFromJson(json: string | null | undefined): {
  allowWorktreeWrite: boolean;
} {
  let ov: PermissionPolicyOverride = {};
  try {
    if (json?.trim()) ov = JSON.parse(json);
  } catch {
    ov = {};
  }
  return { allowWorktreeWrite: ov.worktreeWrite !== false };
}

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
  const [deckError, setDeckError] = useState<string | null>(null);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [playbookError, setPlaybookError] = useState<string | null>(null);

  useEffect(() => {
    fetchDecks().then((result) => {
      if (result.ok) {
        setDecks(result.decks);
        setDeckError(null);
      } else {
        setDecks([]);
        setDeckError(result.message);
      }
    });
  }, []);

  useEffect(() => {
    if (!value.deckId) {
      setPlaybooks([]);
      setPlaybookError(null);
      return;
    }
    fetchDeckPlaybooks(value.deckId).then((result) => {
      if (result.ok) {
        setPlaybooks(result.playbooks);
        setPlaybookError(null);
      } else {
        setPlaybooks([]);
        setPlaybookError(result.message);
      }
    });
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
        onChange={(e) => {
          const runtime = e.target.value as Runtime;
          const cursorDefaults =
            runtime === "cursor_local"
              ? { defaultPlanModel: CURSOR_DEFAULT_MODEL, defaultExecuteModel: CURSOR_DEFAULT_MODEL }
              : { defaultPlanModel: "", defaultExecuteModel: "" };
          set({ runtime, ...cursorDefaults });
        }}
      >
        <option value="claude_code">Claude Code (claude -p)</option>
        <option value="cursor_local">Cursor local (cursor-agent -p)</option>
        <option value="codex_local">Codex local (codex exec)</option>
      </select>
      <PhaseConfigRow
        phase="Plan"
        runtime={value.runtime}
        model={value.defaultPlanModel}
        onModelChange={(defaultPlanModel) => set({ defaultPlanModel })}
        budget={value.defaultPlanBudget}
        onBudgetChange={(defaultPlanBudget) => set({ defaultPlanBudget })}
        disabled={disabled}
        showHint={false}
      />
      <PhaseConfigRow
        phase="Execution"
        runtime={value.runtime}
        model={value.defaultExecuteModel}
        onModelChange={(defaultExecuteModel) => set({ defaultExecuteModel })}
        budget={value.defaultExecuteBudget}
        onBudgetChange={(defaultExecuteBudget) => set({ defaultExecuteBudget })}
        disabled={disabled}
      />
      <label className="text-xs text-[#A8C4C0] uppercase">Agent Deck (optional)</label>
      <select
        className="field"
        disabled={disabled || !agentDeckOnline || !!deckError}
        value={value.deckId}
        onChange={(e) => set({ deckId: e.target.value, playbookId: "", playbookIds: [] })}
      >
        <option value="">
          {!agentDeckOnline ? "Agent Deck offline" : deckError ? "Agent Deck error — see below" : "No deck — degraded mode"}
        </option>
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            ◆ {d.name}
          </option>
        ))}
      </select>
      {agentDeckOnline && deckError && (
        <p className="text-xs text-amber-300/90">{deckError}</p>
      )}
      {value.deckId && playbookError && (
        <p className="text-xs text-amber-300/90">Playbooks unavailable: {playbookError}</p>
      )}
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

      <div className="pt-2 mt-2 border-t border-white/10 space-y-2">
        <div className="text-xs uppercase tracking-wide text-white/40">
          Issue-centric session defaults
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-[#A8C4C0] uppercase">Purpose (optional)</span>
          <input
            className="field text-sm"
            placeholder="e.g. backend refactors on the payments service"
            disabled={disabled}
            value={value.purpose}
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="col-span-1 space-y-1">
            <span className="text-xs text-[#A8C4C0] uppercase">Default model</span>
            <input
              className="field text-sm"
              placeholder="runtime default"
              disabled={disabled}
              value={value.defaultModel}
              onChange={(e) => set({ defaultModel: e.target.value })}
            />
          </label>
          <label className="col-span-1 space-y-1">
            <span className="text-xs text-[#A8C4C0] uppercase">Max turns</span>
            <input
              className="field text-sm"
              type="number"
              min={1}
              placeholder="none"
              disabled={disabled}
              value={value.defaultBudget.maxTurns}
              onChange={(e) =>
                set({ defaultBudget: { ...value.defaultBudget, maxTurns: e.target.value } })
              }
            />
          </label>
          <label className="col-span-1 space-y-1">
            <span className="text-xs text-[#A8C4C0] uppercase">Max $ / session</span>
            <input
              className="field text-sm"
              type="number"
              min={0}
              step="0.1"
              placeholder="none"
              disabled={disabled}
              value={value.defaultBudget.maxBudgetUsd}
              onChange={(e) =>
                set({ defaultBudget: { ...value.defaultBudget, maxBudgetUsd: e.target.value } })
              }
            />
          </label>
        </div>
        {value.deckId && playbooks.length > 0 && (
          <label className="block space-y-1">
            <span className="text-xs text-[#A8C4C0] uppercase">Playbooks (multi-select)</span>
            <select
              className="field text-sm"
              multiple
              size={Math.min(4, Math.max(2, playbooks.length))}
              disabled={disabled}
              value={value.playbookIds}
              onChange={(e) =>
                set({
                  playbookIds: Array.from(e.target.selectedOptions, (o) => o.value),
                })
              }
            >
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-xs text-[#A8C4C0] uppercase">
            External memory refs (one per line)
          </span>
          <textarea
            className="field text-sm font-mono"
            rows={2}
            placeholder={"vault://decisions/payments\nhttps://docs.internal/runbook"}
            disabled={disabled}
            value={value.externalMemoryRefs}
            onChange={(e) => set({ externalMemoryRefs: e.target.value })}
          />
        </label>
        <div className="space-y-1">
          <span className="text-xs text-[#A8C4C0] uppercase">Developer capabilities</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/70">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={disabled}
                checked={value.allowWorktreeWrite}
                onChange={(e) => set({ allowWorktreeWrite: e.target.checked })}
              />
              Write files
            </label>
          </div>
          <p className="text-xs text-white/40">
            Unchecking runs the developer read-only (no Write/Edit/Bash grant), same as a
            reviewer. There is no separate push / open-PR toggle — a session with file-write
            access can already push and open PRs, and no mechanism here can restrict just
            that without also removing write access.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Split a newline/comma separated textarea into a trimmed, non-empty list. */
export function parseRefList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
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
