import { useEffect, useState } from "react";
import type { AgentWithHealth, HumanAction, HumanActionType } from "@agent-dealer/shared";
import { createIssue, fetchHumanActions, fetchIssues, type IssueListRow } from "../api";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import AlertIcon from "../components/ui/AlertIcon";

type Props = {
  agents: AgentWithHealth[];
  onSelectIssue: (id: string) => void;
};

const ACTION_LABELS: Record<HumanActionType, string> = {
  final_review: "Final review",
  attempts_exhausted: "Attempts exhausted",
  policy_escalation: "Policy escalation",
  product_scope_decision: "Product scope decision",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function IssuesListPage({ agents, onSelectIssue }: Props) {
  const [issues, setIssues] = useState<IssueListRow[] | null>(null);
  const [actions, setActions] = useState<HumanAction[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [developerAgentId, setDeveloperAgentId] = useState("");
  const [reviewerAgentId, setReviewerAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    fetchIssues().then(setIssues).catch((e) => setError(String(e)));
    fetchHumanActions().then(setActions).catch(() => undefined);
  };

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, []);

  const submitCreate = async () => {
    if (!title.trim() || !repo.trim() || !developerAgentId || !reviewerAgentId) {
      setError("Title, repo, developer, and reviewer are required");
      return;
    }
    try {
      await createIssue({
        title,
        repo,
        baseBranch: baseBranch.trim() || "main",
        description: description.trim() || undefined,
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
        developerAgentId,
        reviewerAgentId,
        maxReviewRounds: 3,
        maxInfraAttempts: 3,
        source: "manual",
      });
      setShowCreate(false);
      setTitle("");
      setRepo("");
      setDescription("");
      setAcceptanceCriteria("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex-1 min-h-0 px-6 py-4 w-full overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white/90">Issues</h2>
        <button type="button" className="btn-gold px-4" onClick={() => setShowCreate((v) => !v)}>
          New issue
        </button>
      </div>

      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}

      {actions.length > 0 && (
        <div className="mb-4 rounded border border-red-400/30 bg-red-500/10">
          <div className="px-4 py-2 flex items-center gap-2 border-b border-red-400/20">
            <AlertIcon className="w-4 h-4 shrink-0 text-red-300" />
            <span className="text-sm font-medium text-red-200">
              {actions.length} {actions.length === 1 ? "issue needs" : "issues need"} your attention
            </span>
          </div>
          <div className="divide-y divide-white/5">
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onSelectIssue(a.issueId)}
                className="w-full text-left px-4 py-2 hover:bg-white/5 transition-colors"
              >
                <span className="text-xs uppercase tracking-wide text-red-300/80">{ACTION_LABELS[a.actionType]}</span>
                <span className="text-sm text-white/80 ml-2">{a.question}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showCreate && (
        <div className="mb-4 p-4 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
          <p className="text-xs text-white/50">
            Workflow: <span className="text-white/75">developer implements → reviewer (up to 3 rounds) → final human review</span>. agent-dealer coordinates the handoffs and never merges.
          </p>
          <input className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" rows={3} placeholder="Problem statement / description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <textarea className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" rows={3} placeholder="Acceptance criteria" value={acceptanceCriteria} onChange={(e) => setAcceptanceCriteria(e.target.value)} />
          <div className="flex gap-2">
            <input className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Repo path" value={repo} onChange={(e) => setRepo(e.target.value)} />
            <input className="w-32 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Base branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </div>
          <select className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" value={developerAgentId} onChange={(e) => setDeveloperAgentId(e.target.value)}>
            <option value="">Developer agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <select className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" value={reviewerAgentId} onChange={(e) => setReviewerAgentId(e.target.value)}>
            <option value="">Reviewer agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button type="button" className="btn-gold px-4" onClick={submitCreate}>Create</button>
            <button type="button" className="px-4 py-2 text-sm text-white/60 hover:text-white" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      {issues === null ? (
        <p className="text-white/50 text-sm">Loading…</p>
      ) : issues.length === 0 ? (
        <p className="text-white/45 text-sm">No issues yet — create one to get started.</p>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => onSelectIssue(issue.id)}
              className="w-full text-left flex items-center gap-3 px-4 py-3 rounded border border-white/10 bg-panel-elevated/40 hover:bg-panel-elevated/70 transition-colors"
            >
              {issue.hasOpenHumanAction && <AlertIcon className="w-4 h-4 shrink-0 text-red-400" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white/90 truncate">{issue.title}</p>
                {issue.currentIntent && <p className="text-xs text-white/50 truncate">{issue.currentIntent}</p>}
              </div>
              <span className="text-xs text-white/40 capitalize shrink-0">{issue.currentOwner}</span>
              <IssueStatusBadge status={issue.status} />
              <span className="text-xs text-white/35 shrink-0 w-16 text-right">{timeAgo(issue.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
