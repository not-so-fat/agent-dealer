import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AgentWithHealth, HumanAction, LinearCandidate } from "@agent-dealer/shared";
import {
  createIssue,
  dequeueIssue,
  fetchIssuesPage,
  fetchLinearInbox,
  fetchQueue,
  fetchRecentRepos,
  lookupLinearIssue,
  moveQueueEntry,
  resolveHumanAction,
  type IssuesListPageResult,
  type QueueEntryRow,
} from "../api";
import {
  EMPTY_ISSUES_FORM,
  formToIssuesFilters,
  hasActiveIssuesFilters,
  issuesPageText,
  issuesRangeText,
  searchToIssuesFilters,
  searchToIssuesForm,
  serializeIssuesQuery,
  setIssuesPageQuery,
  ISSUE_STATUS_OPTIONS,
  type IssuesFilterForm,
} from "../lib/issuesList";
import IssueStatusBadge from "../components/issues/IssueStatusBadge";
import NeedsAttentionPanel from "../components/issues/NeedsAttentionPanel";
import AlertIcon from "../components/ui/AlertIcon";

type Props = {
  agents: AgentWithHealth[];
  /** Every open human action, issue-scoped and run-scoped — polled by the shell. */
  humanActions: HumanAction[];
  onHumanActionsChanged: () => void;
};

const RESOLVED_BY = "web";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Pull an Acceptance criteria section out of a Linear markdown body when present. */
function extractAcceptanceFromLinear(description: string | undefined): string | undefined {
  if (!description?.trim()) return undefined;
  const match = description.match(/##\s*Acceptance criteria\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  const body = match?.[1]?.trim();
  return body || undefined;
}

export default function IssuesListPage({
  agents,
  humanActions,
  onHumanActionsChanged,
}: Props) {
  const [issuePage, setIssuePage] = useState<IssuesListPageResult | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  // NOT-228: applied list filters + page live in the `/issues` query string so
  // reload and back/forward restore the same view. The filter bar edits a
  // draft that only takes effect on Apply; Previous/Next touch the page only.
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const applied = searchToIssuesFilters(search);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const [filters, setFilters] = useState<IssuesFilterForm>(() => searchToIssuesForm(search));
  const [showCreate, setShowCreate] = useState(false);
  const [sourceMode, setSourceMode] = useState<"manual" | "linear">("manual");
  const [candidates, setCandidates] = useState<LinearCandidate[]>([]);
  const [selectedLinearId, setSelectedLinearId] = useState("");
  const [linearRef, setLinearRef] = useState("");
  const [linearLookupBusy, setLinearLookupBusy] = useState(false);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [developerAgentId, setDeveloperAgentId] = useState("");
  const [reviewerAgentId, setReviewerAgentId] = useState("");
  const [autoMerge, setAutoMerge] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueEntryRow[]>([]);

  const selectedLinear = candidates.find((c) => c.id === selectedLinearId) ?? null;
  const linearLocked = sourceMode === "linear" && selectedLinear != null;

  const refreshIssues = (f: typeof applied) => {
    fetchIssuesPage(f).then(setIssuePage).catch((e) => setError(String(e)));
  };

  /** Queue panel, Needs-attention panel, and historical list stay in sync.
   * The queue/admission panels are global and unfiltered; applied URL filters
   * scope only the historical list below them. */
  const refresh = () => {
    refreshIssues(appliedRef.current);
    fetchQueue()
      .then(setQueue)
      .catch(() => undefined);
  };

  /** Apply writes the draft to the URL and returns to page 1. */
  const applyFilters = (next: IssuesFilterForm) => {
    const qs = serializeIssuesQuery(formToIssuesFilters(next));
    setSearchParams(qs ? Object.fromEntries(new URLSearchParams(qs)) : {});
  };

  const resetFilters = () => {
    setFilters(EMPTY_ISSUES_FORM);
    setSearchParams({});
  };

  /** Previous/Next change only the applied page — draft edits stay in the form. */
  const gotoPage = (page: number) => {
    const qs = setIssuesPageQuery(search, page);
    setSearchParams(qs ? Object.fromEntries(new URLSearchParams(qs)) : {});
  };

  const setFilter = (patch: Partial<IssuesFilterForm>) => setFilters((f) => ({ ...f, ...patch }));

  /** Resolve an action inline (run-scoped items have no issue page to resolve them on). */
  const resolveAction = async (actionId: string, choice: string) => {
    setBusyActionId(actionId);
    setError(null);
    try {
      await resolveHumanAction(actionId, RESOLVED_BY, choice);
      onHumanActionsChanged();
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyActionId(null);
    }
  };

  // Draft form follows the URL (reload / back / forward restore the view);
  // fetching follows the URL too, so unapplied drafts never affect results.
  useEffect(() => {
    setFilters(searchToIssuesForm(search));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    refreshIssues(appliedRef.current);
    fetchQueue()
      .then(setQueue)
      .catch(() => undefined);
    const poll = setInterval(() => {
      refreshIssues(appliedRef.current);
      fetchQueue()
        .then(setQueue)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    if (!showCreate) return;
    fetchRecentRepos()
      .then(setRecentRepos)
      .catch(() => setRecentRepos([]));
    if (sourceMode === "linear") {
      fetchLinearInbox()
        .then(setCandidates)
        .catch((e) => setError(`Linear inbox: ${String(e)}`));
    }
  }, [showCreate, sourceMode]);

  useEffect(() => {
    if (!selectedLinear) return;
    setTitle(`${selectedLinear.identifier}: ${selectedLinear.title}`);
    setDescription(selectedLinear.description ?? "");
    setAcceptanceCriteria(extractAcceptanceFromLinear(selectedLinear.description) ?? "");
  }, [selectedLinear]);

  const resetForm = () => {
    setTitle("");
    setRepo("");
    setDescription("");
    setAcceptanceCriteria("");
    setSelectedLinearId("");
    setLinearRef("");
    setAutoMerge(true);
    setBaseBranch("main");
  };

  const applyLinearCandidate = (c: LinearCandidate) => {
    setCandidates((prev) => (prev.some((x) => x.id === c.id) ? prev : [c, ...prev]));
    setSelectedLinearId(c.id);
    setLinearRef(c.identifier);
  };

  const resolveLinearRef = async () => {
    const q = linearRef.trim();
    if (!q) {
      setError("Paste a Linear id (e.g. NOT-103) or issue URL");
      return;
    }
    setLinearLookupBusy(true);
    setError(null);
    try {
      const c = await lookupLinearIssue(q);
      applyLinearCandidate(c);
    } catch (e) {
      setError(`Linear lookup: ${String(e)}`);
    } finally {
      setLinearLookupBusy(false);
    }
  };

  const submitCreate = async () => {
    if (!title.trim() || !repo.trim() || !developerAgentId || !reviewerAgentId) {
      setError("Title, GitHub repository, developer, and reviewer are required");
      return;
    }
    try {
      await createIssue({
        title: title.trim(),
        repo: repo.trim(),
        baseBranch: baseBranch.trim() || "main",
        description: description.trim() || undefined,
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
        developerAgentId,
        reviewerAgentId,
        maxReviewRounds: 3,
        maxInfraAttempts: 3,
        autoMerge,
        source: sourceMode === "linear" && selectedLinear ? "linear" : "manual",
        externalId: selectedLinear?.id,
        externalLabel: selectedLinear?.identifier,
        externalUrl: selectedLinear?.url,
      });
      setShowCreate(false);
      resetForm();
      // NOT-118: the server enqueues every new issue for admission — creating never starts
      // a workflow here, so making several in a row is always safe. The queue panel below
      // shows where it landed and what it is waiting for.
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

      {queue.length > 0 && (
        <div className="mb-4 rounded border border-cyber-teal/25 bg-cyber-teal/5">
          <div className="px-4 py-2 border-b border-cyber-teal/20 flex items-center justify-between">
            <span className="text-sm font-medium text-cyber-teal">Admission queue</span>
            <span className="text-xs text-white/40">{queue.length} waiting · sequential</span>
          </div>
          <div className="divide-y divide-white/5">
            {queue.map((entry, index) => (
              <div key={entry.id} className="px-4 py-2 flex items-start gap-3">
                <span className="text-xs text-white/35 w-5 shrink-0 pt-0.5">{entry.position}</span>
                <Link
                  to={`/issues/${entry.issueId}`}
                  className="flex-1 min-w-0 text-left hover:text-cyber-teal"
                >
                  <span className="text-sm text-white/85 truncate block">
                    {entry.title ?? entry.issueId.slice(0, 8)}
                  </span>
                  {entry.waitReason ? (
                    <span className="text-xs text-amber-200/80 block mt-0.5">{entry.waitReason}</span>
                  ) : (
                    <span className="text-xs text-white/35 block mt-0.5">
                      {entry.issueStatus ?? "queued"} · next up
                    </span>
                  )}
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    className="text-xs text-white/40 hover:text-cyber-teal disabled:opacity-30"
                    disabled={index === 0}
                    title="Move to top"
                    onClick={() => {
                      moveQueueEntry(entry.issueId, "top")
                        .then(refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    Top
                  </button>
                  <button
                    type="button"
                    className="text-xs text-white/40 hover:text-cyber-teal disabled:opacity-30"
                    disabled={index === 0}
                    title="Move up"
                    onClick={() => {
                      const prev = queue[index - 1];
                      if (!prev) return;
                      moveQueueEntry(entry.issueId, { before: prev.issueId })
                        .then(refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="text-xs text-white/40 hover:text-cyber-teal disabled:opacity-30"
                    disabled={index === queue.length - 1}
                    title="Move down"
                    onClick={() => {
                      const next = queue[index + 1];
                      if (!next) return;
                      moveQueueEntry(entry.issueId, { after: next.issueId })
                        .then(refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="text-xs text-white/40 hover:text-cyber-teal disabled:opacity-30"
                    disabled={index === queue.length - 1}
                    title="Move to bottom"
                    onClick={() => {
                      moveQueueEntry(entry.issueId, "bottom")
                        .then(refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    Bottom
                  </button>
                  <button
                    type="button"
                    className="text-xs text-white/40 hover:text-white"
                    onClick={() => {
                      dequeueIssue(entry.issueId)
                        .then(refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <NeedsAttentionPanel
        actions={humanActions}
        busyActionId={busyActionId}
        onResolve={(actionId, choice) => void resolveAction(actionId, choice)}
      />

      {showCreate && (
        <div className="mb-4 p-4 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
          <p className="text-xs text-white/50">
            Workflow:{" "}
            <span className="text-white/75">
              developer → reviewer → {autoMerge ? "auto-merge on approve" : "final human review"}
            </span>
            .
          </p>
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              className={`px-3 py-1 rounded border ${sourceMode === "manual" ? "border-teal/50 text-teal" : "border-white/10 text-white/50"}`}
              onClick={() => {
                setSourceMode("manual");
                setSelectedLinearId("");
              }}
            >
              Manual
            </button>
            <button
              type="button"
              className={`px-3 py-1 rounded border ${sourceMode === "linear" ? "border-teal/50 text-teal" : "border-white/10 text-white/50"}`}
              onClick={() => setSourceMode("linear")}
            >
              From Linear
            </button>
          </div>

          {sourceMode === "linear" && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
                  placeholder="NOT-103 or Linear URL"
                  value={linearRef}
                  onChange={(e) => setLinearRef(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void resolveLinearRef();
                    }
                  }}
                />
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-teal/40 text-teal text-sm disabled:opacity-50"
                  disabled={linearLookupBusy || !linearRef.trim()}
                  onClick={() => void resolveLinearRef()}
                >
                  {linearLookupBusy ? "…" : "Lookup"}
                </button>
              </div>
              <select
                className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
                value={selectedLinearId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedLinearId(id);
                  const c = candidates.find((x) => x.id === id);
                  if (c) setLinearRef(c.identifier);
                }}
              >
                <option value="">Or pick from open inbox…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.identifier}: {c.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          <input
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm disabled:opacity-60"
            placeholder="Title"
            value={title}
            disabled={linearLocked}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm disabled:opacity-60"
            rows={3}
            placeholder="Problem statement / description"
            value={description}
            disabled={linearLocked}
            onChange={(e) => setDescription(e.target.value)}
          />
          <textarea
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            rows={3}
            placeholder="Acceptance criteria"
            value={acceptanceCriteria}
            onChange={(e) => setAcceptanceCriteria(e.target.value)}
          />
          <div className="flex gap-2 items-stretch">
            <div className="flex-1 space-y-1">
              {recentRepos.length > 0 && (
                <select
                  className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
                  value={recentRepos.includes(repo) ? repo : ""}
                  onChange={(e) => {
                    if (e.target.value) setRepo(e.target.value);
                  }}
                >
                  <option value="">Recent repositories…</option>
                  {recentRepos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
                placeholder="GitHub URL or owner/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </div>
            <input
              className="w-32 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
              placeholder="Base (seed)"
              title="Seed only — managed GitHub clones use the remote default at first checkout"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            />
          </div>
          <select
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            value={developerAgentId}
            onChange={(e) => setDeveloperAgentId(e.target.value)}
          >
            <option value="">Developer agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            value={reviewerAgentId}
            onChange={(e) => setReviewerAgentId(e.target.value)}
          >
            <option value="">Reviewer agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(e) => setAutoMerge(e.target.checked)}
              className="accent-[#C4B643]"
            />
            Auto-merge when reviewer approves (skip final human review)
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn-gold px-4" onClick={submitCreate}>
              {sourceMode === "linear" ? "Kick from Linear" : "Create"}
            </button>
            <button
              type="button"
              className="px-4 py-2 text-sm text-white/60 hover:text-white"
              onClick={() => {
                setShowCreate(false);
                resetForm();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <form
        aria-label="Issues filters"
        className="mb-4 p-4 rounded border border-white/10 bg-panel-elevated/60"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters(filters);
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Search</span>
            <input
              type="text"
              placeholder="Title or label (e.g. NOT-175)"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={filters.q}
              onChange={(e) => setFilter({ q: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Status</span>
            <select
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={filters.status}
              onChange={(e) => setFilter({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {ISSUE_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-white/50 mb-1">Repository</span>
            <input
              type="text"
              placeholder="github.com/owner/repo"
              title="Exact repository identity"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2"
              value={filters.repo}
              onChange={(e) => setFilter({ repo: e.target.value })}
            />
          </label>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer pb-2">
              <input
                type="checkbox"
                checked={filters.needsAttention}
                onChange={(e) => setFilter({ needsAttention: e.target.checked })}
                className="accent-[#C4B643]"
              />
              Needs attention
            </label>
          </div>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <button type="submit" className="btn-gold px-4">Apply</button>
            <button
              type="button"
              className="px-4 py-2 text-sm text-white/60 hover:text-white"
              onClick={resetFilters}
            >
              Reset
            </button>
          </div>
        </div>
      </form>

      {issuePage === null ? (
        <p className="text-white/50 text-sm">Loading…</p>
      ) : issuePage.total === 0 && !hasActiveIssuesFilters(applied) ? (
        <p className="text-white/45 text-sm">No issues yet — create one to get started.</p>
      ) : issuePage.total === 0 ? (
        <div className="rounded border border-white/10 bg-panel-elevated/40 px-4 py-3">
          <p className="text-white/45 text-sm">{issuesRangeText(issuePage)}</p>
          <button
            type="button"
            className="mt-2 px-3 py-1.5 text-sm rounded border border-white/15 text-white/70 hover:text-white"
            onClick={resetFilters}
          >
            Reset filters
          </button>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <h3 className="text-sm font-medium text-white/80">Issues</h3>
            <p className="text-xs text-white/40 tabular-nums">
              {issuesRangeText(issuePage)}
              {issuesPageText(issuePage) ? ` · ${issuesPageText(issuePage)}` : ""}
            </p>
          </div>
          <div className="space-y-2">
          {issuePage.issues.map((issue) => {
            // NOT-118: a queued `ready` issue must not read as an idle one — show its
            // position and what it is waiting for, right on the row.
            const entry = queue.find((e) => e.issueId === issue.id);
            return (
              <Link
                key={issue.id}
                to={`/issues/${issue.id}`}
                className="w-full text-left flex items-center gap-3 px-4 py-3 rounded border border-white/10 bg-panel-elevated/40 hover:bg-panel-elevated/70 transition-colors"
              >
                {issue.hasOpenHumanAction && <AlertIcon className="w-4 h-4 shrink-0 text-red-400" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white/90 truncate">{issue.title}</p>
                  {entry?.waitReason ? (
                    <p className="text-xs text-amber-200/80 truncate" title={entry.waitReason}>
                      {entry.waitReason}
                    </p>
                  ) : (
                    issue.currentIntent && <p className="text-xs text-white/50 truncate">{issue.currentIntent}</p>
                  )}
                </div>
                <span className="text-xs text-white/40 capitalize shrink-0">{issue.currentOwner}</span>
                {entry && (
                  <span
                    className="text-xs px-2 py-0.5 rounded border border-cyber-teal/40 text-cyber-teal shrink-0"
                    title={entry.waitReason ?? "Next up for admission"}
                  >
                    Queued #{entry.position}
                  </span>
                )}
                <IssueStatusBadge status={issue.status} />
                <span className="text-xs text-white/35 shrink-0 w-16 text-right">{timeAgo(issue.updatedAt)}</span>
              </Link>
            );
          })}
          </div>
          {issuePage.totalPages > 1 && (
            <nav aria-label="Issues pages" className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded border border-white/15 text-white/70 hover:text-white disabled:opacity-40"
                disabled={issuePage.page <= 1}
                onClick={() => gotoPage(issuePage.page - 1)}
              >
                Previous
              </button>
              <span className="text-xs text-white/45 tabular-nums">
                Page {issuePage.page} of {issuePage.totalPages}
              </span>
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded border border-white/15 text-white/70 hover:text-white disabled:opacity-40"
                disabled={issuePage.page >= issuePage.totalPages}
                onClick={() => gotoPage(issuePage.page + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
