import { useEffect, useState } from "react";
import type { AgentWithHealth, LinearIntakeConfig } from "@agent-dealer/shared";
import {
  fetchLinearConfig,
  fetchLinearStatus,
  patchLinearConfig,
} from "../../api";

type Props = {
  agents: AgentWithHealth[];
  onSaved?: () => void;
};

export default function LinearConfigPanel({ agents, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<LinearIntakeConfig | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [viewerName, setViewerName] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stateFilterText, setStateFilterText] = useState("Todo");
  const [teamId, setTeamId] = useState("");
  const [assigneeMe, setAssigneeMe] = useState(true);
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const [status, cfg] = await Promise.all([fetchLinearStatus(), fetchLinearConfig()]);
      setConnected(status.connected);
      setViewerName(status.viewer?.name ?? null);
      setStatusError(status.error ?? null);
      setConfig(cfg);
      setStateFilterText(cfg.stateFilter.join(", "));
      setTeamId(cfg.teamId ?? "");
      setAssigneeMe(cfg.assigneeMe);
      setDefaultAgentId(cfg.defaultAgentId ?? "");
      setSyncEnabled(cfg.syncEnabled);
    } catch (e) {
      setStatusError(String(e));
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const testConnection = async () => {
    setBusy(true);
    setSaveMsg(null);
    try {
      const status = await fetchLinearStatus();
      setConnected(status.connected);
      setViewerName(status.viewer?.name ?? null);
      setStatusError(status.error ?? null);
      setSaveMsg(status.connected ? "Connected" : "Not connected");
    } catch (e) {
      setStatusError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setSaveMsg(null);
    try {
      const stateFilter = stateFilterText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await patchLinearConfig({
        stateFilter: stateFilter.length > 0 ? stateFilter : ["Todo"],
        teamId: teamId.trim() || null,
        assigneeMe,
        defaultAgentId: defaultAgentId || null,
        syncEnabled,
      });
      setConfig(updated);
      setSaveMsg("Saved");
      onSaved?.();
    } catch (e) {
      setSaveMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const badge =
    connected === null ? (
      <span className="text-xs text-white/45">Checking…</span>
    ) : connected ? (
      <span className="text-xs text-emerald-300/90 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-400/25">
        Connected{viewerName ? ` · ${viewerName}` : ""}
      </span>
    ) : (
      <span className="text-xs text-amber-200/90 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-400/25">
        Missing API key
      </span>
    );

  return (
    <div className="rounded-xl glass-plate overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm text-white/70 hover:text-white/90"
      >
        <span>Linear settings</span>
        <span className="flex items-center gap-2">
          {badge}
          <span className="text-white/35">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-white/10 px-3 py-3 space-y-3 text-sm">
          {statusError && connected === false && (
            <p className="text-red-400/90 text-xs">{statusError}</p>
          )}
          <p className="text-xs text-white/45">
            API key stays in <code className="text-white/60">LINEAR_API_KEY</code> env — not stored here.
          </p>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-white/45">State filter</span>
            <input
              type="text"
              value={stateFilterText}
              onChange={(e) => setStateFilterText(e.target.value)}
              placeholder="Todo, Backlog"
              className="w-full rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-[#E8F6F4]"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-white/45">Team ID (optional)</span>
            <input
              type="text"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              placeholder="UUID"
              className="w-full rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-[#E8F6F4] font-mono text-xs"
            />
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={assigneeMe}
              onChange={(e) => setAssigneeMe(e.target.checked)}
              className="rounded"
            />
            <span>Assigned to me</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => setSyncEnabled(e.target.checked)}
              className="rounded"
            />
            <span>Sync status + comments to Linear</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-white/45">Default agent</span>
            <select
              value={defaultAgentId}
              onChange={(e) => setDefaultAgentId(e.target.value)}
              className="w-full rounded-lg bg-black/20 border border-white/10 px-2 py-1.5 text-[#E8F6F4]"
            >
              <option value="">None</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {!a.healthy ? " (needs setup)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={save} disabled={busy} className="btn-gold px-3 py-1.5 flex-1">
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={testConnection} disabled={busy} className="btn-ghost px-3 py-1.5">
              Test
            </button>
          </div>
          {saveMsg && <p className="text-xs text-white/50">{saveMsg}</p>}
          {config && (
            <p className="text-[10px] text-white/30">
              Active: {config.stateFilter.join(", ")}
              {config.assigneeMe ? " · assignee=me" : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
