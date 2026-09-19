import { useEffect, useState } from "react";
import type { PermissionPolicyOverride, ReasoningEffort, Runtime } from "@agent-dealer/shared";
import { CURSOR_DEFAULT_MODEL } from "@agent-dealer/shared";
import { fetchDecks } from "./api";
import ModelSelect from "./components/agents/ModelSelect";
import { type BudgetFormValue } from "./lib/budgetForm";

export type AgentConfigValue = {
  runtime: Runtime;
  deckId: string;
  // Issue-centric (developer/reviewer) session defaults — snapshotted per session.
  // NOT-80: only these role-neutral fields appear on the form. NOT-71 retired the legacy
  // plan→execute queue, so there is no collapsed "Legacy queue settings" section — the
  // plan/execute columns remain DB read-compat only (profile-snapshot / resolveProfile*).
  purpose: string;
  defaultModel: string;
  /** Reasoning effort for Codex/Claude; empty string = runtime default. Ignored for Cursor. */
  defaultEffort: "" | ReasoningEffort;
  defaultBudget: BudgetFormValue;
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

type Props = {
  value: AgentConfigValue;
  onChange: (v: AgentConfigValue) => void;
  agentDeckOnline: boolean;
  disabled?: boolean;
};

export default function AgentConfigFields({ value, onChange, agentDeckOnline, disabled }: Props) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckError, setDeckError] = useState<string | null>(null);

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

  const set = (patch: Partial<AgentConfigValue>) => onChange({ ...value, ...patch });
  const supportsEffort = value.runtime === "codex_local" || value.runtime === "claude_code";

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
          set({
            runtime,
            defaultModel: runtime === "cursor_local" ? CURSOR_DEFAULT_MODEL : "",
            // Cursor has no separate effort CLI flag — clear so we don't persist a no-op.
            defaultEffort: runtime === "cursor_local" ? "" : value.defaultEffort,
          });
        }}
      >
        <option value="claude_code">Claude Code (claude -p)</option>
        <option value="cursor_local">Cursor local (cursor-agent -p)</option>
        <option value="codex_local">Codex local (codex exec)</option>
      </select>
      <label className="text-xs text-[#A8C4C0] uppercase">Agent Deck (required)</label>
      <select
        className="field"
        disabled={disabled || !agentDeckOnline || !!deckError}
        value={value.deckId}
        onChange={(e) => set({ deckId: e.target.value })}
        required
      >
        <option value="" disabled={!!value.deckId}>
          {!agentDeckOnline
            ? "Agent Deck offline"
            : deckError
              ? "Agent Deck error — see below"
              : "Select a deck…"}
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
        <div className={`grid gap-2 ${supportsEffort ? "grid-cols-2" : "grid-cols-1"}`}>
          <ModelSelect
            runtime={value.runtime}
            label="Default model"
            value={value.defaultModel}
            onChange={(defaultModel) => set({ defaultModel })}
            disabled={disabled}
            compact
          />
          {supportsEffort && (
            <label className="space-y-1">
              <span className="text-xs text-[#A8C4C0] uppercase">Reasoning effort</span>
              <select
                className="field text-sm"
                disabled={disabled}
                value={value.defaultEffort}
                onChange={(e) =>
                  set({ defaultEffort: e.target.value as AgentConfigValue["defaultEffort"] })
                }
              >
                <option value="">Runtime default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          )}
        </div>
        {value.runtime === "cursor_local" && (
          <p className="text-xs text-white/40">
            Cursor has no separate effort flag — put effort in the model id if needed (e.g.
            parameterized `[effort=high]`).
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
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
          <label className="space-y-1">
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
