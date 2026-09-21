import { useState } from "react";
import type { AgentWithHealth } from "@agent-dealer/shared";
import { runtimeLabel } from "../../lib/display";

type Props = {
  agents: AgentWithHealth[];
  initialDeveloperId: string | null;
  initialReviewerId: string | null;
  busy: boolean;
  onSave: (developerAgentId: string, reviewerAgentId: string) => void;
  onCancel: () => void;
};

/** True when the agent carries a durable usage-cap observation. */
function isUsageCapped(agent: AgentWithHealth): boolean {
  return agent.issues.some((i) => i.code === "usage_capped");
}

/** Healthy agents first so the safe choices are easiest to identify. */
function sortedAgents(agents: AgentWithHealth[]): AgentWithHealth[] {
  return [...agents].sort((a, b) => Number(b.healthy) - Number(a.healthy));
}

function optionLabel(agent: AgentWithHealth): string {
  const base = `${agent.name} · ${runtimeLabel(agent.runtime)}`;
  const flags: string[] = [];
  if (!agent.healthy) {
    const first = agent.issues[0]?.message ?? "unhealthy";
    flags.push(`NEEDS FIX: ${first}`);
  }
  if (isUsageCapped(agent)) flags.push("USAGE CAPPED");
  return flags.length > 0 ? `${base} — ${flags.join(" · ")}` : base;
}

function healthNote(agent: AgentWithHealth | undefined): string | null {
  if (!agent) return null;
  if (!agent.healthy) return agent.issues[0]?.message ?? "Agent is unhealthy";
  if (isUsageCapped(agent)) return "Usage capped — admission will refuse until the cap lifts";
  return null;
}

/**
 * NOT-217 queued assignment editor: change the developer/reviewer agents of a
 * pre-start issue. Each choice shows its runtime plus unhealthy/usage-capped state,
 * healthy agents sort first. Saving uses the existing issue PATCH contract; the
 * server keeps queue position, refreshes the wait reason, and records an
 * `issue.reassigned` timeline event — or answers 409 when the issue started mid-edit.
 */
export default function AgentAssignmentEditor({
  agents,
  initialDeveloperId,
  initialReviewerId,
  busy,
  onSave,
  onCancel,
}: Props) {
  const [developerId, setDeveloperId] = useState(initialDeveloperId ?? "");
  const [reviewerId, setReviewerId] = useState(initialReviewerId ?? "");
  const ordered = sortedAgents(agents);
  const developer = agents.find((a) => a.id === developerId);
  const reviewer = agents.find((a) => a.id === reviewerId);
  const developerNote = healthNote(developer);
  const reviewerNote = healthNote(reviewer);
  const unchanged = developerId === (initialDeveloperId ?? "") && reviewerId === (initialReviewerId ?? "");

  return (
    <div className="p-3 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
      <p className="text-xs text-white/50">
        Reassign agents — queue position is kept, the wait reason is rechecked, and the
        change is recorded on the timeline.
      </p>
      <label className="block space-y-1">
        <span className="text-xs text-white/45 uppercase tracking-wide">Developer</span>
        <select
          className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          value={developerId}
          disabled={busy}
          title={developer ? `${developer.name} · ${runtimeLabel(developer.runtime)}${developer.healthy ? " · healthy" : ` · ${developer.issues[0]?.message ?? "unhealthy"}`}` : "Pick a developer agent"}
          onChange={(e) => setDeveloperId(e.target.value)}
        >
          <option value="">Developer agent…</option>
          {ordered.map((a) => (
            <option key={a.id} value={a.id} title={optionLabel(a)}>
              {(a.healthy ? "● " : "○ ") + optionLabel(a)}
            </option>
          ))}
        </select>
        {developerNote && <span className="text-xs text-amber-200/80 block">{developerNote}</span>}
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-white/45 uppercase tracking-wide">Reviewer</span>
        <select
          className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          value={reviewerId}
          disabled={busy}
          title={reviewer ? `${reviewer.name} · ${runtimeLabel(reviewer.runtime)}${reviewer.healthy ? " · healthy" : ` · ${reviewer.issues[0]?.message ?? "unhealthy"}`}` : "Pick a reviewer agent"}
          onChange={(e) => setReviewerId(e.target.value)}
        >
          <option value="">Reviewer agent…</option>
          {ordered.map((a) =>
            // Muse Code is developer-only (server refuses it as a reviewer at admission).
            a.runtime === "muse_code" ? (
              <option key={a.id} value={a.id} disabled title="Muse Code cannot be a reviewer (developer role only)">
                {`○ ${a.name} · ${runtimeLabel(a.runtime)} — reviewer not supported`}
              </option>
            ) : (
              <option key={a.id} value={a.id} title={optionLabel(a)}>
                {(a.healthy ? "● " : "○ ") + optionLabel(a)}
              </option>
            )
          )}
        </select>
        {reviewerNote && <span className="text-xs text-amber-200/80 block">{reviewerNote}</span>}
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-gold px-4 py-1.5 text-sm disabled:opacity-50"
          disabled={busy || !developerId || !reviewerId || unchanged}
          title="Save via the issue PATCH contract — keeps queue position and rechecks the wait reason"
          onClick={() => onSave(developerId, reviewerId)}
        >
          Save agents
        </button>
        <button
          type="button"
          className="px-4 py-1.5 text-sm text-white/60 hover:text-white disabled:opacity-50"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
