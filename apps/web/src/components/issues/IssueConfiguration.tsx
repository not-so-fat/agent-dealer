import { useState } from "react";
import type { AgentWithHealth, Issue } from "@agent-dealer/shared";
import { runtimeLabel } from "../../lib/display";
import { healthNote, optionLabel, sortedAgents } from "./AgentAssignmentEditor";

/** Read-only row for one configured agent: profile name + runtime, or an explicit
 * unavailable state when the id points at a missing/deleted profile — never blank. */
function agentValue(agentId: string | null, agents: AgentWithHealth[]): string {
  if (!agentId) return "Not assigned";
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return "Unavailable — profile removed";
  const base = `${agent.name} · ${runtimeLabel(agent.runtime)}`;
  if (!agent.healthy) return `${base} (unhealthy: ${agent.issues[0]?.message ?? "needs attention"})`;
  return base;
}

function agentTitle(agentId: string | null, agents: AgentWithHealth[]): string | undefined {
  if (!agentId) return undefined;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return `Configured profile ${agentId} is not on record (deleted?)`;
  return `${agent.name} · ${runtimeLabel(agent.runtime)}${agent.healthy ? " · healthy" : ` · ${agent.issues[0]?.message ?? "unhealthy"}`}`;
}

type EditorProps = {
  agents: AgentWithHealth[];
  initialRepo: string;
  initialDeveloperId: string | null;
  initialReviewerId: string | null;
  busy: boolean;
  onSave: (repo: string, developerAgentId: string, reviewerAgentId: string) => void;
  onCancel: () => void;
};

/**
 * NOT-240 pre-execution configuration editor: repository + developer + reviewer saved
 * together through the existing issue PATCH contract. Repository accepts the same
 * GitHub URL / owner/repo forms as issue creation (the server normalizes and
 * validates); agent choices mirror the queued assignment editor, healthy first.
 * Saving a queued issue keeps its queue position and rechecks the wait reason;
 * a save that races workflow admission answers 409 and the caller refreshes.
 */
export function IssueConfigurationEditor({
  agents,
  initialRepo,
  initialDeveloperId,
  initialReviewerId,
  busy,
  onSave,
  onCancel,
}: EditorProps) {
  const [repo, setRepo] = useState(initialRepo);
  const [developerId, setDeveloperId] = useState(initialDeveloperId ?? "");
  const [reviewerId, setReviewerId] = useState(initialReviewerId ?? "");
  const ordered = sortedAgents(agents);
  const developer = agents.find((a) => a.id === developerId);
  const reviewer = agents.find((a) => a.id === reviewerId);
  const developerNote = healthNote(developer);
  const reviewerNote = healthNote(reviewer);
  const unchanged =
    repo.trim() === initialRepo &&
    developerId === (initialDeveloperId ?? "") &&
    reviewerId === (initialReviewerId ?? "");

  return (
    <div className="p-3 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
      <p className="text-xs text-white/50">
        Edit configuration — repository, developer, and reviewer save together. Queue
        position is kept, readiness and the wait reason are rechecked, and the change
        is recorded on the timeline.
      </p>
      <label className="block space-y-1">
        <span className="text-xs text-white/45 uppercase tracking-wide">Repository</span>
        <input
          className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          value={repo}
          disabled={busy}
          placeholder="GitHub URL or owner/repo"
          title="GitHub URL or owner/repo — normalized to github.com/owner/repo, same validation as issue creation"
          onChange={(e) => setRepo(e.target.value)}
        />
      </label>
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
          disabled={busy || !repo.trim() || !developerId || !reviewerId || unchanged}
          title="Save via the issue PATCH contract — keeps queue position, rechecks readiness and the wait reason"
          onClick={() => onSave(repo.trim(), developerId, reviewerId)}
        >
          Save configuration
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

type SectionProps = {
  issue: Issue;
  agents: AgentWithHealth[];
  /** True for a `ready` issue with no active workflow — queued or not. */
  canEdit: boolean;
  editing: boolean;
  busy: boolean;
  onBeginEdit: () => void;
  onSave: (repo: string, developerAgentId: string, reviewerAgentId: string) => void;
  onCancel: () => void;
};

/**
 * NOT-240: the execution configuration — repository, developer, reviewer — shown for
 * every issue status without requiring an expansion or the execution-analysis view.
 * After workflow start the frozen inputs stay visible but read-only.
 */
export default function IssueConfigurationSection({
  issue,
  agents,
  canEdit,
  editing,
  busy,
  onBeginEdit,
  onSave,
  onCancel,
}: SectionProps) {
  return (
    <div className="mb-4 p-3 rounded border border-white/10 bg-white/[0.03] space-y-1.5">
      <p className="text-xs text-white/45 uppercase tracking-wide">Configuration</p>
      <p className="text-sm text-white/85" title={`Exact repository identity: ${issue.repo}`}>
        <span className="text-white/45">Repository </span>
        {issue.repo}
      </p>
      <p className="text-sm text-white/85" title={agentTitle(issue.developerAgentId, agents)}>
        <span className="text-white/45">Developer </span>
        {agentValue(issue.developerAgentId, agents)}
      </p>
      <p className="text-sm text-white/85" title={agentTitle(issue.reviewerAgentId, agents)}>
        <span className="text-white/45">Reviewer </span>
        {agentValue(issue.reviewerAgentId, agents)}
      </p>
      {canEdit && !editing && (
        <button
          type="button"
          className="text-xs text-cyber-teal hover:underline disabled:opacity-50"
          disabled={busy}
          onClick={onBeginEdit}
        >
          Edit configuration
        </button>
      )}
      {canEdit && editing && (
        <IssueConfigurationEditor
          agents={agents}
          initialRepo={issue.repo}
          initialDeveloperId={issue.developerAgentId}
          initialReviewerId={issue.reviewerAgentId}
          busy={busy}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}
