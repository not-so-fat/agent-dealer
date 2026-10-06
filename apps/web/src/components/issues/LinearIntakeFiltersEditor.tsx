import { useEffect, useMemo, useState } from "react";
import type {
  LinearIntakeConfigView,
  LinearIntakeMetadata,
  LinearWorkflowStateOption,
} from "@agent-dealer/shared";
import {
  fetchLinearIntakeConfig,
  fetchLinearIntakeMetadata,
  patchLinearIntakeConfig,
} from "../../api";

// NOT-361: compact inline Linear picker filters (Team / Assignee / Status).
// Lives beside the From Linear open-inbox picker; saving or closing never
// touches the parent New issue form — the page owns selection and fields.

const DEFAULT_OPEN_STATES = ["Backlog", "Todo", "In Progress", "In Review"] as const;

export function uniqueStatusNames(
  states: readonly LinearWorkflowStateOption[],
  teamId: string | null
): string[] {
  const filtered = teamId
    ? states.filter((s) => s.teamId === teamId)
    : states;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of filtered) {
    const key = s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.name);
  }
  return out;
}

export default function LinearIntakeFiltersEditor({
  initialConfig,
  initialMetadata,
  loadConfig = fetchLinearIntakeConfig,
  loadMetadata = fetchLinearIntakeMetadata,
  saveConfig = patchLinearIntakeConfig,
  onSaved,
  onClose,
}: {
  initialConfig?: LinearIntakeConfigView;
  initialMetadata?: LinearIntakeMetadata;
  loadConfig?: () => Promise<LinearIntakeConfigView>;
  loadMetadata?: () => Promise<LinearIntakeMetadata>;
  saveConfig?: typeof patchLinearIntakeConfig;
  /** Called after a successful save so the parent can refetch candidates only. */
  onSaved?: () => void;
  onClose?: () => void;
}) {
  const [view, setView] = useState<LinearIntakeConfigView | null>(initialConfig ?? null);
  const [metadata, setMetadata] = useState<LinearIntakeMetadata | null>(initialMetadata ?? null);
  const [teamId, setTeamId] = useState(initialConfig?.persisted.teamId ?? "");
  const [assigneeMe, setAssigneeMe] = useState(initialConfig?.persisted.assigneeMe ?? false);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(
    initialConfig?.persisted.stateFilter ?? [...DEFAULT_OPEN_STATES]
  );
  const [loaded, setLoaded] = useState(
    initialConfig !== undefined && initialMetadata !== undefined
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initialConfig !== undefined && initialMetadata !== undefined) return;
    let live = true;
    Promise.all([
      initialConfig ? Promise.resolve(initialConfig) : loadConfig(),
      initialMetadata ? Promise.resolve(initialMetadata) : loadMetadata(),
    ])
      .then(([cfg, meta]) => {
        if (!live) return;
        setView(cfg);
        setMetadata(meta);
        setTeamId(cfg.persisted.teamId ?? "");
        setAssigneeMe(cfg.persisted.assigneeMe);
        setSelectedStatuses(cfg.persisted.stateFilter);
        setLoaded(true);
      })
      .catch((e) => {
        if (!live) return;
        setError(String(e));
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [initialConfig, initialMetadata, loadConfig, loadMetadata]);

  const statusOptions = useMemo(
    () => uniqueStatusNames(metadata?.workflowStates ?? [], teamId || null),
    [metadata, teamId]
  );

  // Keep selected statuses that still exist; when options load empty (API gap),
  // preserve the persisted list so Save remains meaningful.
  const displayStatuses = statusOptions.length > 0 ? statusOptions : selectedStatuses;

  const teamDisabled = Boolean(view?.envOverrides.teamId);
  const statusDisabled = Boolean(view?.envOverrides.stateFilter);
  const hasEnvOverride = teamDisabled || statusDisabled;

  const toggleStatus = (name: string) => {
    setSelectedStatuses((prev) => {
      const has = prev.some((s) => s.toLowerCase() === name.toLowerCase());
      if (has) return prev.filter((s) => s.toLowerCase() !== name.toLowerCase());
      return [...prev, name];
    });
  };

  const save = async () => {
    setError(null);
    setNotice(null);
    if (selectedStatuses.length === 0) {
      setError("Select at least one workflow status");
      return;
    }
    setSaving(true);
    try {
      const updated = await saveConfig({
        stateFilter: selectedStatuses,
        teamId: teamId.trim() || null,
        assigneeMe,
      });
      setView(updated);
      setTeamId(updated.persisted.teamId ?? "");
      setAssigneeMe(updated.persisted.assigneeMe);
      setSelectedStatuses(updated.persisted.stateFilter);
      setNotice(
        updated.envOverrides.stateFilter || updated.envOverrides.teamId
          ? "Saved locally — env still overrides the disabled controls"
          : "Saved"
      );
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="rounded border border-white/10 bg-black/20 px-3 py-2 space-y-2"
      aria-label="Linear intake filters"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/60">Linear intake filters</p>
        {onClose && (
          <button
            type="button"
            className="text-xs text-white/50 hover:text-white"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </div>

      {!loaded ? (
        <p className="text-xs text-white/40">Loading…</p>
      ) : (
        <>
          {hasEnvOverride && (
            <p
              className="text-xs text-amber-200/90 rounded bg-amber-500/10 border border-amber-400/20 px-2 py-1.5"
              data-testid="linear-filter-env-notice"
            >
              {teamDisabled && statusDisabled ? (
                <>
                  <code className="text-amber-100/90">LINEAR_TEAM_ID</code> and{" "}
                  <code className="text-amber-100/90">LINEAR_STATE_FILTER</code> override
                  saved Team and Status.
                </>
              ) : teamDisabled ? (
                <>
                  <code className="text-amber-100/90">LINEAR_TEAM_ID</code> overrides saved
                  Team.
                </>
              ) : (
                <>
                  <code className="text-amber-100/90">LINEAR_STATE_FILTER</code> overrides
                  saved Status.
                </>
              )}{" "}
              Remove the env var to use the value below.
            </p>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-white/50">Team</span>
            <select
              className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm disabled:opacity-50"
              aria-label="Team"
              value={teamId}
              disabled={teamDisabled || !loaded}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">All teams</option>
              {(metadata?.teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.key ? ` (${t.key})` : ""}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-1" disabled={!loaded}>
            <legend className="text-xs text-white/50">Assignee</legend>
            <label className="flex items-center gap-2 text-sm text-white/80 cursor-pointer">
              <input
                type="radio"
                name="linear-assignee"
                checked={!assigneeMe}
                onChange={() => setAssigneeMe(false)}
                className="accent-[#C4B643]"
              />
              Anyone
            </label>
            <label className="flex items-center gap-2 text-sm text-white/80 cursor-pointer">
              <input
                type="radio"
                name="linear-assignee"
                checked={assigneeMe}
                onChange={() => setAssigneeMe(true)}
                className="accent-[#C4B643]"
              />
              Assigned to me
              {metadata?.viewer?.name ? (
                <span className="text-xs text-white/40">({metadata.viewer.name})</span>
              ) : null}
            </label>
          </fieldset>

          <fieldset className="space-y-1" disabled={statusDisabled || !loaded}>
            <legend className="text-xs text-white/50">Status</legend>
            {displayStatuses.length === 0 ? (
              <p className="text-xs text-white/40">No workflow statuses available.</p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1" data-testid="linear-status-list">
                {displayStatuses.map((name) => {
                  const checked = selectedStatuses.some(
                    (s) => s.toLowerCase() === name.toLowerCase()
                  );
                  return (
                    <label
                      key={name}
                      className="flex items-center gap-2 text-sm text-white/80 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={statusDisabled}
                        onChange={() => toggleStatus(name)}
                        className="accent-[#C4B643]"
                      />
                      {name}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          {error && (
            <p className="text-xs text-red-300" data-testid="linear-filters-error">
              {error}
            </p>
          )}
          {notice && (
            <p className="text-xs text-teal-200/80" data-testid="linear-filters-notice">
              {notice}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs px-2 py-1 rounded border border-teal/40 text-teal disabled:opacity-50"
              disabled={saving || !loaded}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
