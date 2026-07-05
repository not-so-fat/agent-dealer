import type { AgentWithHealth, LinearConnectionStatus } from "@agent-dealer/shared";
import LinearConfigPanel from "./LinearConfigPanel";
import { fetchLinearStatus } from "../../api";
import { useEffect, useState } from "react";

type Props = {
  agents: AgentWithHealth[];
  loading: boolean;
  candidateCount: number;
  onRefresh: () => void;
  onConfigSaved: () => void;
};

export default function LinearImportPanel({
  agents,
  loading,
  candidateCount,
  onRefresh,
  onConfigSaved,
}: Props) {
  const [status, setStatus] = useState<LinearConnectionStatus | null>(null);

  useEffect(() => {
    fetchLinearStatus().then(setStatus).catch(() => setStatus({ connected: false, error: "Failed to check" }));
  }, []);

  return (
    <>
      <div className="rounded-xl p-3 glass-plate space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-white/70">Connection</span>
          {status?.connected ? (
            <span className="text-xs text-emerald-300/90">Connected · {status.viewer?.name}</span>
          ) : (
            <span className="text-xs text-amber-200/90">{status?.error ?? "Not connected"}</span>
          )}
        </div>
        <p className="text-sm text-white/45">
          {loading
            ? "Fetching from Linear…"
            : candidateCount === 0
              ? "No matching issues — adjust filters below or create issues in Linear."
              : `${candidateCount} issue${candidateCount === 1 ? "" : "s"} in inbox`}
        </p>
        <button type="button" onClick={onRefresh} disabled={loading} className="btn-gold w-full py-2">
          {loading ? "Importing…" : "Import from Linear"}
        </button>
      </div>
      <LinearConfigPanel
        agents={agents}
        onSaved={() => {
          onConfigSaved();
          onRefresh();
        }}
      />
      <p className="text-xs text-white/40">
        Set <code className="text-white/55">LINEAR_API_KEY</code> in env. Filters are saved locally — not the API key.
      </p>
    </>
  );
}
