import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AgentWithHealth } from "@agent-dealer/shared";
import {
  abortIssue,
  closeIssue,
  deleteDealerIssue,
  dequeueIssue,
  enqueueIssue,
  executeIssue,
  fetchIssueArtifactTrace,
  fetchIssueEvidence,
  guideIssue,
  parkIssueForHuman,
  patchIssue,
  reloadIssueSource,
  resolveHumanAction,
  startIssue,
  type IssueDetail,
  type IssueEvidence,
} from "../../api";
import IssueStatusBadge from "./IssueStatusBadge";
import AgentAssignmentEditor from "./AgentAssignmentEditor";
import IssueConfigurationSection from "./IssueConfiguration";
import ExecutionContractSummary from "./ExecutionContractSummary";
import SourceAttachmentsSection from "./SourceAttachmentsSection";
import IssueTimeline from "./IssueTimeline";
import ExecutionAnalysisSection from "./ExecutionAnalysisSection";
import HumanActionCard from "./HumanActionCard";
import { parseResponseOptions } from "../../lib/humanActions";
import { summarizeHumanAction } from "@agent-dealer/shared";

type Props = {
  issueId: string;
  detail: IssueDetail;
  agents: AgentWithHealth[];
  /** Lets the shell's open-action badge/list catch up after a resolution here. */
  onHumanActionsChanged: () => void;
  /** Reload the detail after a mutation. */
  refresh: () => void;
  /** Surface an action failure (or clear it with null) on the page-level error banner. */
  onError: (message: string | null) => void;
};

const RESOLVED_BY = "web";

/** Pretty-print an artifact's contentJson for the evidence disclosure — prefers a plain
 * "text" field (implementation conclusions, etc.) over a raw JSON dump. */
function formatArtifactContent(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as { text?: string };
    if (typeof parsed.text === "string") return parsed.text;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return contentJson;
  }
}

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function fmtHeartbeatAge(iso: string | null): string {
  if (!iso) return "no heartbeat yet";
  const ageSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const min = Math.floor(ageSec / 60);
  return `${min}m ago`;
}

function shortPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}

/** Hover text for the NOT-148 tip strip — tip vocabulary only, no engine state enums. */
function branchTipTitle(
  tip: NonNullable<IssueDetail["branchTipStatus"]>
): string {
  return [tip.branch, tip.tipLabel, tip.worktree?.path ? shortPath(tip.worktree.path) : null]
    .filter(Boolean)
    .join(" · ");
}

/** Operator suffixes after tipLabel (restart risk / dirty preserve). */
function branchTipSuffixes(
  tip: NonNullable<IssueDetail["branchTipStatus"]>
): string {
  return [
    tip.restartRisk ? "restart risk" : null,
    tip.worktree?.preserved ? "dirty worktree preserved" : null,
  ]
    .filter(Boolean)
    .map((s) => ` · ${s}`)
    .join("");
}

function branchTipWarnClass(tip: NonNullable<IssueDetail["branchTipStatus"]>): boolean {
  return Boolean(tip.restartRisk || tip.worktree?.preserved);
}

/** Sampler writes `Role · {liveProgress} (round N)` into currentIntent — don't echo that under the gold line. */
function intentDuplicatesLiveProgress(intent: string | null | undefined, progress: string | null | undefined): boolean {
  if (!intent || !progress) return false;
  if (intent === progress) return true;
  return intent.includes(progress);
}

/**
 * NOT-239: the low-prominence pre-execution Close confirmation. Rendered only
 * inside Issue Detail's secondary "More actions" area (never on list/queue
 * rows or bulk surfaces) after the operator asks to close. The copy must name
 * every consequence: no execution, queue removal, and retained history with
 * where to find it. Exported so regression tests can assert the copy without
 * driving the two-step interaction.
 */
export function CloseIssueConfirmation({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-2">
      <p className="text-sm text-white/90 font-medium">Close this issue?</p>
      <p className="text-sm text-white/70">
        It will not execute. Any queue entry will be removed. History is retained and can be
        found as closed work — filter the Issues list by status closed or open this page directly.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="px-4 py-1.5 text-sm rounded border border-red-400/50 text-red-200 hover:bg-red-500/20 disabled:opacity-50"
          disabled={busy}
          onClick={onConfirm}
        >
          Close issue
        </button>
        <button
          type="button"
          className="font-ui-display px-4 py-1.5 text-sm text-white/60 hover:text-white"
          onClick={onCancel}
        >
          Keep issue
        </button>
      </div>
    </div>
  );
}

/**
 * NOT-365: the token a typed delete confirmation requires — the displayed
 * external label (e.g. `NOT-123`) when the issue has one, otherwise the exact
 * Dealer issue id. Exact match only, enforced by
 * `isDeleteConfirmationSatisfied` below.
 */
export function deleteConfirmationToken(issue: { id: string; externalLabel: string | null }): string {
  return issue.externalLabel ?? issue.id;
}

/** Exact-match gate for the typed delete confirmation — no trimming, no case folding. */
export function isDeleteConfirmationSatisfied(typed: string, expectedToken: string): boolean {
  return typed === expectedToken;
}

/**
 * NOT-365: the low-prominence Dealer-local hard-delete confirmation. Rendered
 * only inside Issue Detail's secondary "More actions" area (never on
 * list/queue rows or bulk surfaces) after the operator asks to delete. Unlike
 * Close issue (retained history) this is permanent local removal — the copy
 * must say history/evidence/files go and, for Linear-sourced issues, that the
 * Linear ticket will not be deleted. The confirm control stays disabled until
 * the typed token matches exactly. Exported so regression tests can assert
 * the copy without driving the two-step interaction.
 */
export function DeleteIssueConfirmation({
  expectedToken,
  externalLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  expectedToken: string;
  externalLabel: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const satisfied = isDeleteConfirmationSatisfied(typed, expectedToken);
  return (
    <div className="mt-2 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-2">
      <p className="text-sm text-white/90 font-medium">Delete this issue from Dealer?</p>
      <p className="text-sm text-white/70">
        This permanently deletes the Dealer-local issue — its history, evidence, and files
        cannot be recovered.
        {externalLabel
          ? ` The Linear ticket ${externalLabel} will not be deleted.`
          : " There is no linked Linear ticket to affect."}
      </p>
      <label className="block text-xs text-white/60">
        Type <span className="font-mono text-white/85">{expectedToken}</span> to confirm
        <input
          className="mt-1 block w-full bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm text-white/90 font-mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={expectedToken}
          autoComplete="off"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="px-4 py-1.5 text-sm rounded border border-red-400/50 text-red-200 hover:bg-red-500/20 disabled:opacity-50"
          disabled={busy || !satisfied}
          onClick={onConfirm}
        >
          Delete from Dealer
        </button>
        <button
          type="button"
          className="font-ui-display px-4 py-1.5 text-sm text-white/60 hover:text-white"
          onClick={onCancel}
        >
          Keep issue
        </button>
      </div>
    </div>
  );
}

/**
 * NOT-365: collaborators for the Dealer-local delete side-effect sequence. The
 * component passes its live hooks/state; regression tests pass stubs — either
 * way `executeDeleteIssueFlow` below runs the real navigation/refresh path.
 */
export interface DeleteIssueFlowDeps {
  /** DELETE request — resolves with the server's residual paths. */
  removeIssue: (issueId: string) => Promise<{ residualPaths: string[] }>;
  /** Leave the (now 404) detail route for the Issues list with the notice. */
  navigateToIssues: (deletedNotice: string) => void;
  onHumanActionsChanged: () => void;
  closeConfirmation: () => void;
  reportError: (error: unknown) => void;
  refresh: () => void;
}

/** Success notice for a deleted issue — Linear-sourced issues always carry the
 * ticket-spared sentence; unremoved Dealer-owned files are named explicitly. */
export function buildDeleteSuccessNotice(args: {
  issueId: string;
  externalLabel: string | null;
  residualPaths: string[];
}): string {
  const label = args.externalLabel ?? args.issueId;
  const residual =
    args.residualPaths.length > 0
      ? ` ${args.residualPaths.length} Dealer-owned file(s) could not be removed: ${args.residualPaths.join(", ")}`
      : "";
  return args.externalLabel
    ? `Issue ${label} deleted from Dealer. The Linear ticket was not deleted.${residual}`
    : `Issue ${label} permanently deleted from Dealer.${residual}`;
}

/**
 * NOT-365: the Dealer-local delete side-effect sequence — `doDelete` delegates
 * here, so this is the real path and not a test double. On success the detail
 * route is gone (a refresh would 404), so it closes the confirmation, refreshes
 * the shell's human-action badge, and navigates to the active Issues list —
 * which remounts and re-fetches issues/queue/history itself — with the deletion
 * notice. On refusal (a 409 over live work this view could not see) it closes
 * the confirmation, reports the server's error, and refreshes to the live state
 * instead of a stale success. Never throws: the outcome is the return value.
 */
export async function executeDeleteIssueFlow(
  issueId: string,
  issue: { externalLabel: string | null },
  deps: DeleteIssueFlowDeps
): Promise<"deleted" | "refused"> {
  try {
    const result = await deps.removeIssue(issueId);
    const notice = buildDeleteSuccessNotice({
      issueId,
      externalLabel: issue.externalLabel,
      residualPaths: result.residualPaths,
    });
    deps.closeConfirmation();
    deps.onHumanActionsChanged();
    deps.navigateToIssues(notice);
    return "deleted";
  } catch (e) {
    deps.closeConfirmation();
    deps.reportError(e);
    deps.refresh();
    return "refused";
  }
}

/**
 * NOT-359: confirmation line kept inside the parked swap box after a save —
 * the box stays expanded, the refreshed detail carries the new agents, and this
 * tells the owner a resume continues with them.
 */
export const AGENT_SWAP_SAVED_NOTICE = "Agents updated. Resume to continue with the new agents.";

/**
 * NOT-359: a parked-swap save PATCHes only the roles that actually changed —
 * one PATCH per save, never a full reassignment when a single role moved.
 */
export function buildAgentSwapPatch(
  currentDeveloperId: string | null,
  currentReviewerId: string | null,
  nextDeveloperId: string,
  nextReviewerId: string
): { developerAgentId?: string; reviewerAgentId?: string } {
  const patch: { developerAgentId?: string; reviewerAgentId?: string } = {};
  if (nextDeveloperId !== (currentDeveloperId ?? "")) patch.developerAgentId = nextDeveloperId;
  if (nextReviewerId !== (currentReviewerId ?? "")) patch.reviewerAgentId = nextReviewerId;
  return patch;
}

/** The next allowed action, per the ticket's workflow rail: an open human action's own
 * compact summary question when one exists (NOT-288 — never a folded git command
 * block), otherwise a derived "waiting on X" from currentOwner. */
function nextActionLabel(detail: IssueDetail): string {
  const open = detail.humanActions.find((a) => a.status === "open");
  if (open) return summarizeHumanAction(open).title;
  switch (detail.issue.currentOwner) {
    case "developer":
      return "Waiting on the developer";
    case "reviewer":
      return "Waiting on the reviewer";
    case "human":
      return "Waiting on you";
    default:
      return detail.issue.status === "done" || detail.issue.status === "closed" ? "Complete" : "Idle";
  }
}

/**
 * NOT-174: the fetched-issue half of IssueDetailPage, extracted so page-level
 * regression tests can render the live strip, failure strip, branch tip,
 * action/edit controls, evidence panel, timeline, and the execution-analysis
 * mount without driving the fetch/poll loop. The page owns fetching; this owns
 * everything rendered once a detail exists.
 */
export default function IssueDetailBody({ issueId, detail, agents, onHumanActionsChanged, refresh, onError }: Props) {
  const [evidence, setEvidence] = useState<IssueEvidence | null>(null);
  const [traces, setTraces] = useState<Record<string, { content: string; loading: boolean; error?: string }>>({});
  const [guidance, setGuidance] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAcceptance, setEditAcceptance] = useState("");
  const [busy, setBusy] = useState(false);
  /** Outcome of the last Start — admitted, or queued at a position with a reason. */
  const [startNotice, setStartNotice] = useState<string | null>(null);
  /** NOT-240 pre-execution configuration editor (ready, no active workflow). */
  const [configEditing, setConfigEditing] = useState(false);
  /** NOT-359 parked swap confirmation — the box itself is always expanded, so
   * there is no editing toggle; this only holds the post-save notice. */
  const [swapNotice, setSwapNotice] = useState<string | null>(null);
  /** NOT-239 pre-execution close: two-step inside the low-prominence area below. */
  const [closeConfirming, setCloseConfirming] = useState(false);
  /** NOT-365 Dealer-local hard delete: typed two-step in the same area. */
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  /** After a successful delete the detail route is gone — land on the list. */
  const navigate = useNavigate();
  /** NOT-363: source-reload confirmation — the reload replaces local task-text edits. */
  const [reloadConfirming, setReloadConfirming] = useState(false);
  /** NOT-239 unambiguous result banner after a successful close. */
  const [closeNotice, setCloseNotice] = useState<string | null>(null);
  /** NOT-272: optional per-action decision note for a product_scope_decision resolve. */
  const [scopeNotes, setScopeNotes] = useState<Record<string, string>>({});
  /** NOT-314: required per-action result note for an operator_verification resolve —
   * the server 400s every choice without a non-empty note. */
  const [operatorNotes, setOperatorNotes] = useState<Record<string, string>>({});

  const fail = (e: unknown) => onError(String(e));

  const { issue, timeline, humanActions, usageSummary, readiness, humanWaitMs, interventionCount, latestWorkflowInstance, activeWorkerSession, liveProgress, latestSessionFailure, branchTipStatus, queued, queueEntry, capWait } = detail;
  const developerAgent = agents.find((a) => a.id === issue.developerAgentId);
  const developerBlocked = developerAgent && !developerAgent.healthy;
  const developerBlockReason = developerAgent?.issues[0]?.message ?? "Developer agent is unhealthy";
  const durationMs = latestWorkflowInstance
    ? new Date(latestWorkflowInstance.completedAt ?? Date.now()).getTime() - new Date(latestWorkflowInstance.startedAt).getTime()
    : 0;
  const openActions = humanActions.filter((a) => a.status === "open");
  // NOT-358: a parked issue (open attempts_exhausted or policy_escalation) offers the
  // agent swap inline — same worktree and branch, resume continues with the new agents.
  const isParkedForSwap =
    issue.status === "needs_human" &&
    openActions.some((a) => a.actionType === "attempts_exhausted" || a.actionType === "policy_escalation");
  const canEdit = readiness.ok === false || openActions.some((a) => a.actionType === "product_scope_decision");
  const hasActiveWorkflow = latestWorkflowInstance != null && latestWorkflowInstance.completedAt === null;
  // NOT-363: the task-text editor stays available for every pre-execution
  // `ready` issue, even when readiness already passes — the old gate only
  // opened it on missing fields or an open scope decision.
  const canTaskEditPreExecution = issue.status === "ready" && !hasActiveWorkflow;
  const showTaskEditor = canEdit || canTaskEditPreExecution;
  // NOT-363: Reload from Linear only for an eligible Linear-sourced issue —
  // `ready`, no active workflow, no running worker. The server re-checks all
  // of this, so a race answers 409 there instead of landing on a live snapshot.
  const hasRunningWorker = activeWorkerSession?.status === "running";
  const canReloadSource =
    issue.source === "linear" &&
    issue.status === "ready" &&
    !hasActiveWorkflow &&
    !hasRunningWorker;
  // NOT-239: pre-execution Close is for `ready` with no active workflow only — it
  // must never alias Abort on running work, and terminal issues have nothing to close.
  const canClose = issue.status === "ready" && !hasActiveWorkflow;
  // NOT-365: Dealer-local hard delete is for settled states only — `ready`
  // (possibly queued), `done`, or `closed` — with no active workflow. The
  // server re-checks every guard (running session, live work, worktree) and
  // answers 409 there, so this is display gating only.
  const canDelete =
    (issue.status === "ready" || issue.status === "done" || issue.status === "closed") &&
    !hasActiveWorkflow;
  // NOT-240: every `ready` issue with no active workflow is still pre-execution and
  // has no frozen task snapshot — queue membership never decides repairability.
  const canConfigEdit = issue.status === "ready" && !hasActiveWorkflow;
  const sessionLive =
    activeWorkerSession &&
    activeWorkerSession.status === "running" &&
    (issue.status === "developing" || issue.status === "reviewing" || issue.status === "repairing");
  // Hide the failure strip while a live session is running — the live strip owns that slot.
  const showLatestFailure = Boolean(latestSessionFailure) && !sessionLive;

  const submitGuidance = async () => {
    if (!guidance.trim()) return;
    await guideIssue(issueId, guidance);
    setGuidance("");
    refresh();
  };

  const beginEdit = () => {
    setEditTitle(issue.title);
    setEditDescription(issue.description ?? "");
    setEditAcceptance(issue.acceptanceCriteria ?? "");
    setEditing(true);
  };

  const saveEdit = async () => {
    setBusy(true);
    onError(null);
    try {
      await patchIssue(issueId, {
        title: editTitle.trim() || undefined,
        description: editDescription.trim() || null,
        acceptanceCriteria: editAcceptance.trim() || null,
      });
      setEditing(false);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doReloadSource = async () => {
    setBusy(true);
    onError(null);
    try {
      // NOT-363: the server replaces title/description/acceptance criteria
      // from Linear and recompiles the contract; the refreshed detail below
      // shows the new text and contract immediately. Linear/contract failures
      // surface on the page-level banner with the server's message.
      await reloadIssueSource(issueId);
      setReloadConfirming(false);
      refresh();
    } catch (e) {
      // A 409 means admission or a worker won the race: close the
      // confirmation and refresh to the live state instead of a stale success.
      setReloadConfirming(false);
      fail(e);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const doStart = async () => {
    setBusy(true);
    onError(null);
    try {
      // NOT-118: Start moves this issue to the front of the admission queue. It runs now if
      // a slot is free, otherwise it waits at position 1 — it never jumps the queue.
      const result = await startIssue(issueId);
      setStartNotice(
        result.state === "admitted"
          ? null
          : `Queued at position ${result.position}${result.waitReason ? ` — ${result.waitReason}` : ""}`
      );
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doEnqueue = async () => {
    setBusy(true);
    onError(null);
    try {
      await enqueueIssue(issueId);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doExecute = async () => {
    setBusy(true);
    onError(null);
    try {
      // NOT-217 Execute now: direct admission, bypassing queue order only. A refusal
      // throws with the reason and changes nothing — the refreshed queue entry below
      // still shows the untouched position.
      await executeIssue(issueId);
      setStartNotice(null);
      setConfigEditing(false);
      refresh();
    } catch (e) {
      fail(e);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async (repo: string, developerAgentId: string, reviewerAgentId: string) => {
    setBusy(true);
    onError(null);
    try {
      // One PATCH for all three execution inputs: the server normalizes/validates
      // the repository like issue creation, keeps queue position, rechecks
      // readiness and the wait reason, and records the before/after on the timeline.
      await patchIssue(issueId, { repo, developerAgentId, reviewerAgentId });
      setConfigEditing(false);
      refresh();
    } catch (e) {
      // A 409 means admission won the race: close the editor and refresh to the
      // now-read-only configuration instead of a stale success.
      setConfigEditing(false);
      fail(e);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveAgentSwap = async (developerAgentId: string, reviewerAgentId: string) => {
    setBusy(true);
    onError(null);
    try {
      // NOT-359: one PATCH with only the changed roles — the server re-freezes
      // the profile snapshot on the next resume and records the before/after on
      // the timeline. The box stays expanded: the refreshed detail carries the
      // new agents and the notice confirms a resume continues with them.
      await patchIssue(
        issueId,
        buildAgentSwapPatch(issue.developerAgentId, issue.reviewerAgentId, developerAgentId, reviewerAgentId)
      );
      setSwapNotice(AGENT_SWAP_SAVED_NOTICE);
      refresh();
    } catch (e) {
      // A 409 means a resume or session won the race: refresh to the live state
      // instead of leaving a stale success — the box stays open on the live agents.
      fail(e);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const doParkForHuman = async () => {
    setBusy(true);
    onError(null);
    try {
      await parkIssueForHuman(issueId);
      onHumanActionsChanged();
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doDequeue = async () => {
    setBusy(true);
    onError(null);
    try {
      await dequeueIssue(issueId);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doClose = async () => {
    setBusy(true);
    onError(null);
    try {
      await closeIssue(issueId);
      setCloseConfirming(false);
      setCloseNotice(
        "Issue closed — it will not execute. History is retained and can be found as closed work."
      );
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    onError(null);
    try {
      // NOT-365: the record is gone after this — the flow below leaves the
      // detail route for the active Issues list on success (a refresh would
      // 404), and closes the confirmation plus refreshes to the live state on
      // a 409 over work this view could not see.
      await executeDeleteIssueFlow(
        issueId,
        { externalLabel: issue.externalLabel },
        {
          removeIssue: deleteDealerIssue,
          navigateToIssues: (deletedNotice) => navigate("/issues", { state: { deletedNotice } }),
          onHumanActionsChanged,
          closeConfirmation: () => setDeleteConfirming(false),
          reportError: (e) => fail(e),
          refresh,
        }
      );
    } finally {
      setBusy(false);
    }
  };

  const doAbort = async () => {
    if (!confirm("Abort this workflow? The current worker will stop and the issue will close. History and evidence are kept.")) {
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await abortIssue(issueId);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const resolveActionChoice = async (actionId: string, choice: string, note?: string) => {
    setBusy(true);
    onError(null);
    try {
      await resolveHumanAction(actionId, RESOLVED_BY, choice, note);
      onHumanActionsChanged();
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const loadEvidence = () => {
    if (!evidence) fetchIssueEvidence(issueId).then(setEvidence).catch((e) => fail(e));
  };

  const loadTrace = (artifactId: string) => {
    if (traces[artifactId]) return; // already loaded or loading
    setTraces((prev) => ({ ...prev, [artifactId]: { content: "", loading: true } }));
    fetchIssueArtifactTrace(issueId, artifactId)
      .then((t) => setTraces((prev) => ({ ...prev, [artifactId]: { content: t.content, loading: false } })))
      .catch((e) => setTraces((prev) => ({ ...prev, [artifactId]: { content: "", loading: false, error: String(e) } })));
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div className="max-w-3xl">
        <Link to="/issues" className="font-ui-display inline-block text-sm text-white/50 hover:text-white mb-3">
          ← Issues
        </Link>

        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90">{issue.title}</h2>
            <p className="text-xs text-white/45 mt-1">
              Owner: <span className="capitalize">{issue.currentOwner}</span>
              {issue.currentIntent ? ` · ${issue.currentIntent}` : ""}
            </p>
            <div className="flex flex-wrap gap-3 mt-2 text-xs text-white/40">
              {issue.prUrl && <a href={issue.prUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">PR #{issue.prNumber}</a>}
              {issue.externalUrl && <a href={issue.externalUrl} target="_blank" rel="noreferrer" className="text-cyber-teal hover:underline">{issue.externalLabel ?? "External link"}</a>}
              <span>Round {issue.currentRound}/{issue.maxReviewRounds}</span>
              <span>Infra attempts {issue.infraAttempts}/{issue.maxInfraAttempts}</span>
              <span title="Wall-clock time from workflow start to completion (or now)">{fmtDuration(durationMs)} elapsed</span>
              <span title={`${usageSummary.totalTokensIn} in / ${usageSummary.totalTokensOut} out tokens`}>${usageSummary.totalCostUsd.toFixed(2)}</span>
              {humanWaitMs > 0 && <span title="Time spent waiting on a human, excluding autonomous processing">{fmtDuration(humanWaitMs)} human wait</span>}
              {interventionCount > 0 && <span>{interventionCount} intervention{interventionCount === 1 ? "" : "s"}</span>}
            </div>
          </div>
          <IssueStatusBadge status={issue.status} />
        </div>

        {/* NOT-239: unambiguous closed result — the refreshed detail shows the Closed
            badge, and this banner confirms no execution will happen. */}
        {closeNotice && (
          <div className="mb-4 p-3 rounded border border-white/15 bg-white/[0.04]">
            <p className="text-sm text-white/85">{closeNotice}</p>
          </div>
        )}

        {/* NOT-240: execution configuration — repository, developer, reviewer — always
            visible near the top. Editable only while `ready` with no active workflow;
            after workflow start the frozen inputs stay read-only. */}
        <IssueConfigurationSection
          issue={issue}
          agents={agents}
          canEdit={canConfigEdit}
          editing={configEditing}
          busy={busy}
          onBeginEdit={() => setConfigEditing(true)}
          onSave={(repo, dev, rev) => void saveConfig(repo, dev, rev)}
          onCancel={() => setConfigEditing(false)}
        />

        {/* NOT-306: frozen execution contract, read-only — the ticket
            description stays the only authoring surface, so this renders no
            inputs. Absent for legacy/contract-free issues. */}
        {issue.executionContract && <ExecutionContractSummary contract={issue.executionContract} />}

        {/* NOT-364: durable Linear source attachments — files with safe name,
            size and checksum; links as labeled metadata only. Empty/absent
            renders nothing. */}
        <SourceAttachmentsSection attachments={detail.sourceAttachments} />

        {/* Workflow rail: current node/owner is above; next allowed action here. */}
        <div className="mb-4 p-3 rounded border border-white/10 bg-panel-elevated/40 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-white/45">Next</p>
            <p className="text-sm text-white/85">{nextActionLabel(detail)}</p>
          </div>
          {hasActiveWorkflow && (
            <button type="button" className="btn-ghost-danger px-3 py-1.5 text-xs shrink-0 disabled:cursor-not-allowed disabled:opacity-60" disabled={busy} onClick={doAbort}>
              Abort workflow
            </button>
          )}
        </div>

        {/* NOT-118: queued is a real state of its own — a `ready` issue waiting in the
            admission queue must never look like an idle one nobody has picked up. */}
        {queueEntry && (
          <div className="mb-4 p-3 rounded border border-cyber-teal/30 bg-cyber-teal/5">
            <p className="text-xs text-cyber-teal font-medium uppercase tracking-wide">
              Queued · position {queueEntry.position}
            </p>
            <p className="text-sm text-white/80 mt-0.5">
              {queueEntry.waitReason ?? "Next up — starts as soon as the coordinator ticks"}
            </p>
          </div>
        )}

        {/* NOT-358: usage-cap / deck-outage wait behind an availability window, with
            a Park for human action next to the notice. Parking cancels the wait
            without touching the worktree and hands the issue to a human. */}
        {capWait && (
          <div className="mb-4 p-3 rounded border border-amber-400/30 bg-amber-500/10 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-amber-300 font-medium uppercase tracking-wide">
                {capWait.kind === "usage_capped" ? "Waiting on usage cap" : "Waiting on Agent Deck"}
              </p>
              <p className="text-sm text-white/80 mt-0.5 break-words">{capWait.reason}</p>
              <p className="text-xs text-white/45 mt-0.5">
                Wait until {new Date(capWait.until).toLocaleString()}
              </p>
            </div>
            <button
              type="button"
              className="btn-gold px-3 py-1.5 text-xs shrink-0 disabled:opacity-50"
              disabled={busy}
              title="Park this issue for a human — cancels the wait without touching the worktree; a resume continues with whichever agents are then set"
              onClick={doParkForHuman}
            >
              Park for human
            </button>
          </div>
        )}

        {sessionLive && activeWorkerSession && (
          <div className="mb-4 p-3 rounded border border-cyber-teal/35 bg-cyber-teal/5 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyber-teal animate-pulse" aria-hidden />
              <p className="text-xs text-cyber-teal font-medium uppercase tracking-wide">Running now</p>
            </div>
            <p className="text-sm text-white/90">
              <span className="capitalize">{activeWorkerSession.role}</span>
              {activeWorkerSession.runtime ? ` · ${activeWorkerSession.runtime}` : ""}
              {activeWorkerSession.model ? ` · ${activeWorkerSession.model}` : ""}
              {` · round ${activeWorkerSession.round}`}
            </p>
            <p className="text-sm text-[#C4B643] truncate" title={liveProgress ?? issue.currentIntent ?? "session started"}>
              Last progress: {liveProgress ?? issue.currentIntent ?? "session started"}
            </p>
            {branchTipStatus && (
              <p
                className={`text-xs ${branchTipWarnClass(branchTipStatus) ? "text-amber-300" : "text-white/55"}`}
                title={branchTipTitle(branchTipStatus)}
              >
                Branch tip: {branchTipStatus.tipLabel}
                {branchTipSuffixes(branchTipStatus)}
              </p>
            )}
            {liveProgress &&
              issue.currentIntent &&
              !/session running/i.test(issue.currentIntent) &&
              !intentDuplicatesLiveProgress(issue.currentIntent, liveProgress) && (
              <p className="text-xs text-white/45 truncate" title={issue.currentIntent}>
                {issue.currentIntent}
              </p>
            )}
            <p className="text-xs text-white/45">
              Heartbeat {fmtHeartbeatAge(activeWorkerSession.heartbeatAt)}
              {shortPath(activeWorkerSession.worktreePath) ? ` · ${shortPath(activeWorkerSession.worktreePath)}` : ""}
            </p>
            {activeWorkerSession.logPath && (
              <p className="text-xs text-white/40 font-mono break-all" title={activeWorkerSession.logPath}>
                Log: {shortPath(activeWorkerSession.logPath) ?? activeWorkerSession.logPath}
              </p>
            )}
          </div>
        )}

        {showLatestFailure && latestSessionFailure && (
          <div className="mb-4 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-1.5">
            <p className="text-xs text-red-300 font-medium uppercase tracking-wide">Latest session failure</p>
            <p className="text-sm text-white/90 whitespace-pre-wrap break-words">{latestSessionFailure.reason}</p>
            <p className="text-xs text-white/45">
              {latestSessionFailure.role ? <span className="capitalize">{latestSessionFailure.role}</span> : "Worker"}
              {latestSessionFailure.outcome ? ` · ${latestSessionFailure.outcome}` : ""}
              {` · ${new Date(latestSessionFailure.when).toLocaleString()}`}
              {` · infra ${latestSessionFailure.infraAttempts}/${latestSessionFailure.maxInfraAttempts}`}
            </p>
            {branchTipStatus && (
              <p
                className={`text-xs ${branchTipWarnClass(branchTipStatus) ? "text-amber-300" : "text-white/55"}`}
                title={branchTipTitle(branchTipStatus)}
              >
                Branch tip: {branchTipStatus.tipLabel}
                {branchTipSuffixes(branchTipStatus)}
              </p>
            )}
            {latestSessionFailure.logPath && (
              <p className="text-xs text-white/40 font-mono break-all" title={latestSessionFailure.logPath}>
                Log: {shortPath(latestSessionFailure.logPath) ?? latestSessionFailure.logPath}
              </p>
            )}
          </div>
        )}

        {/* NOT-148: tip / restart-risk when developing or reviewing without a live/failure strip. */}
        {branchTipStatus && !sessionLive && !showLatestFailure && (
          <div className="mb-4 p-3 rounded border border-white/10 bg-white/[0.03] space-y-1">
            <p className="text-xs text-white/45 uppercase tracking-wide">Branch tip</p>
            <p
              className={`text-sm ${branchTipWarnClass(branchTipStatus) ? "text-amber-300" : "text-white/80"}`}
              title={branchTipTitle(branchTipStatus)}
            >
              {branchTipStatus.tipLabel}
              {branchTipSuffixes(branchTipStatus)}
            </p>
          </div>
        )}

        {!readiness.ok && !openActions.some((a) => a.actionType === "product_scope_decision") && (
          <div className="mb-4 p-3 rounded border border-amber-400/30 bg-amber-500/10">
            <p className="text-xs text-amber-300 font-medium">Not startable yet — missing: {readiness.missing.join(", ")}</p>
          </div>
        )}

        {openActions.length > 0 && (
          <div className="mb-4 p-3 rounded border border-red-400/30 bg-red-500/10 space-y-2">
            <p className="text-xs text-red-300 font-medium">Human action needed</p>
            {openActions.map((a) => {
              // product_scope_decision keeps its own gated button: resolving it before
              // acceptance criteria actually exist would just bounce off the server, so it
              // is only offered once `readiness.ok`. Every other action type
              // (policy_escalation, attempts_exhausted, final_review,
              // deck_interaction_required, …) has no such precondition — render the
              // server's own response options generically rather than hardcoding choices
              // per type. NOT-288: every action renders through HumanActionCard so the
              // detail agrees with the Issues home on the compact question, choice
              // labels, and Details content.
              const scopeDecision = a.actionType === "product_scope_decision";
              // NOT-314: operator_verification keeps its own gated buttons — every
              // choice requires the result note, so the generic noteless
              // onChoose below would just bounce off the server with a 400.
              if (a.actionType === "operator_verification") {
                const options = parseResponseOptions(a);
                const note = operatorNotes[a.id] ?? "";
                const noteReady = note.trim().length > 0;
                return (
                  <HumanActionCard key={a.id} action={a} hideChoicesHint>
                    <div className="space-y-1">
                      <textarea
                        className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white/85 placeholder:text-white/30"
                        rows={2}
                        placeholder="Result note (required) — paste the probe output, waiver reason, or repair note"
                        value={note}
                        disabled={busy}
                        onChange={(e) => setOperatorNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                      />
                      <div className="flex flex-wrap gap-2">
                        {options.map((o) => (
                          <button
                            key={o.choice}
                            type="button"
                            className="btn-gold px-3 py-1 text-xs disabled:opacity-50"
                            disabled={busy || !noteReady}
                            title={noteReady ? undefined : "Enter the result note first — the server requires it"}
                            onClick={() => resolveActionChoice(a.id, o.choice, note)}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </HumanActionCard>
                );
              }
              return scopeDecision ? (
                <HumanActionCard key={a.id} action={a} hideChoicesHint>
                  {readiness.ok && (
                    <div className="space-y-1">
                      <textarea
                        className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white/85 placeholder:text-white/30"
                        rows={2}
                        placeholder="Decision note (optional) — shown to the next developer round"
                        value={scopeNotes[a.id] ?? ""}
                        disabled={busy}
                        onChange={(e) => setScopeNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="btn-gold px-3 py-1 text-xs"
                        disabled={busy}
                        onClick={() => resolveActionChoice(a.id, "resume", scopeNotes[a.id])}
                      >
                        Resume
                      </button>
                    </div>
                  )}
                </HumanActionCard>
              ) : (
                <HumanActionCard
                  key={a.id}
                  action={a}
                  disabled={busy}
                  onChoose={(choice) => resolveActionChoice(a.id, choice)}
                />
              );
            })}
          </div>
        )}

        {/* NOT-359: parked agent swap — always expanded directly under the open
            human action card, next to the Resume/Close choices, preselected to
            the current agents. The worktree, branch and review rounds are kept;
            a resume continues with the new agents. Rendered for parked issues
            only — every other state renders nothing here. */}
        {isParkedForSwap && (
          <div className="mb-4">
            <AgentAssignmentEditor
              key={`${issue.developerAgentId ?? ""}:${issue.reviewerAgentId ?? ""}`}
              variant="parked"
              agents={agents}
              initialDeveloperId={issue.developerAgentId}
              initialReviewerId={issue.reviewerAgentId}
              busy={busy}
              notice={swapNotice}
              onSave={(dev, rev) => void saveAgentSwap(dev, rev)}
            />
          </div>
        )}

        {(showTaskEditor || canReloadSource) && !editing && !reloadConfirming && (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
            {showTaskEditor && (
              <button type="button" className="font-ui-display text-xs text-cyber-teal hover:underline" onClick={beginEdit}>
                Edit title / description / acceptance criteria
              </button>
            )}
            {canReloadSource && (
              <button
                type="button"
                className="font-ui-display text-xs text-cyber-teal hover:underline"
                title="Pull the latest title, description, and acceptance criteria from the linked Linear ticket — local edits will be replaced"
                onClick={() => setReloadConfirming(true)}
              >
                Reload from Linear
              </button>
            )}
          </div>
        )}
        {/* NOT-363: the reload replaces local title/description/acceptance-criteria
            edits, so it confirms first — repository, agents, and queue position
            are unchanged, and nothing is written back to Linear. */}
        {canReloadSource && reloadConfirming && !editing && (
          <div className="mb-4 p-3 rounded border border-cyber-teal/30 bg-cyber-teal/5 space-y-2">
            <p className="text-sm text-white/90 font-medium">
              Reload the latest task text from Linear{issue.externalLabel ? ` ${issue.externalLabel}` : ""}?
            </p>
            <p className="text-sm text-white/70">
              This replaces the local title, description, and acceptance criteria with the
              latest ticket text. Local edits will be lost. Repository, agents, and queue
              position are unchanged, and nothing is written back to Linear.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-gold px-4 py-1.5 text-sm disabled:opacity-50"
                disabled={busy}
                onClick={doReloadSource}
              >
                Reload from Linear
              </button>
              <button
                type="button"
                className="font-ui-display px-4 py-1.5 text-sm text-white/60 hover:text-white"
                onClick={() => setReloadConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {editing && (
          <div className="mb-4 p-3 rounded border border-white/10 bg-panel-elevated/60 space-y-2">
            <input className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Title" />
            <textarea className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" rows={2} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Description" />
            <textarea className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm" rows={2} value={editAcceptance} onChange={(e) => setEditAcceptance(e.target.value)} placeholder="Acceptance criteria" />
            <div className="flex gap-2">
              <button type="button" className="btn-gold px-4 py-1.5 text-sm" disabled={busy} onClick={saveEdit}>Save</button>
              <button type="button" className="font-ui-display px-4 py-1.5 text-sm text-white/60 hover:text-white" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* "ready" is the normal path; a "needs_human" issue with no open action left is
            reachable after resolving a migrated (legacy-cutover) final_review/
            attempts_exhausted action with repair/retry — that resolution deliberately
            never reactivates the completed legacy_v0 instance, so this Start button is
            the "explicit new workflow start" the migration design promises. The backend
            (startWorkflow's preStart check) already accepts needs_human the same as
            ready; this just stops the resolution from being a dead end in the UI. */}
        {(issue.status === "ready" || (issue.status === "needs_human" && openActions.length === 0)) && (
          <div className="mb-4 space-y-2">
            {developerBlocked && (
              <p className="text-sm text-amber-200/90">
                Fix before Start: {developerBlockReason}
              </p>
            )}
            {startNotice && <p className="text-sm text-amber-200/90">{startNotice}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-gold px-4 py-2 disabled:opacity-50"
                disabled={!readiness.ok || busy || !!developerBlocked}
                title={
                  developerBlocked
                    ? developerBlockReason
                    : "Run next — move to the front of the admission queue; runs now if a slot is free, otherwise waits first with a reason"
                }
                onClick={doStart}
              >
                Run next
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm border border-cyber-teal/40 rounded text-cyber-teal hover:bg-cyber-teal/10 disabled:opacity-50"
                disabled={!readiness.ok || busy || !!developerBlocked}
                title={
                  developerBlocked
                    ? developerBlockReason
                    : "Execute now — start immediately, skipping queue order; refuses (changing nothing) when capacity, readiness, blockers, or agent health prevents it"
                }
                onClick={doExecute}
              >
                Execute now
              </button>
              {!queued ? (
                <button
                  type="button"
                  className="font-ui-display px-4 py-2 text-sm border border-white/15 rounded text-white/80 hover:border-cyber-teal/50 hover:text-cyber-teal disabled:opacity-50"
                  disabled={busy || hasActiveWorkflow}
                  title="Add to queue — append to the end of the admission queue; does not start anything now"
                  onClick={doEnqueue}
                >
                  Add to queue
                </button>
              ) : (
                <button
                  type="button"
                  className="font-ui-display px-4 py-2 text-sm border border-white/15 rounded text-white/60 hover:text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={doDequeue}
                >
                  Remove from queue
                </button>
              )}
            </div>
            {queued && canConfigEdit && !configEditing && (
              <p className="text-xs text-white/40">
                Queued — edit repository / agents from the Configuration section above; position is kept.
              </p>
            )}
          </div>
        )}

        {/* NOT-174: operator-facing where-time-went explanation; the live strip,
            failure strip, branch tip, actions, evidence, and timeline above/below
            are unchanged. */}
        <ExecutionAnalysisSection issueId={issueId} />

        <div className="border-t border-white/10 pt-3">
          <IssueTimeline events={timeline} />
        </div>

        <div className="mt-4 flex gap-2">
          <input
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            placeholder="Guide this issue…"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGuidance()}
          />
          <button type="button" className="btn-gold px-4" onClick={submitGuidance}>Send</button>
        </div>

        {/* NOT-239: low-prominence secondary actions. Close issue lives here — and
            only here — so an operator opens the issue and reads its context first.
            Remove from queue (above) means "do not run yet" and keeps the issue
            ready; Close issue means "this work is no longer needed" and it will
            never execute. NOT-365: Delete from Dealer joins them here — permanent
            local removal with a typed confirmation, never touching Linear.
            Never on list rows, queue rows, or bulk surfaces. */}
        {(canClose || canDelete) && (
          <details className="mt-6">
            <summary className="text-xs text-white/45 cursor-pointer hover:text-white/70">More actions</summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs text-white/45">
                {canClose
                  ? "Remove from queue means do not run yet — the issue stays ready and can run later. Close issue means this work is no longer needed — it will never execute, but history is kept."
                  : "This work is finished — there is nothing left to close or abort."}
                {canDelete
                  ? " Delete from Dealer permanently removes the local issue, its history, and its files."
                  : ""}
              </p>
              {canClose &&
                (!closeConfirming ? (
                  <button
                    type="button"
                    className="font-ui-display text-xs text-white/50 hover:text-red-300 underline underline-offset-2 disabled:opacity-50"
                    disabled={busy}
                    title="Retire this issue without running it — removes any queue entry, keeps history as closed work"
                    onClick={() => setCloseConfirming(true)}
                  >
                    Close issue
                  </button>
                ) : (
                  <CloseIssueConfirmation
                    busy={busy}
                    onConfirm={() => void doClose()}
                    onCancel={() => setCloseConfirming(false)}
                  />
                ))}
              {canDelete &&
                (!deleteConfirming ? (
                  <button
                    type="button"
                    className="font-ui-display text-xs text-white/50 hover:text-red-300 underline underline-offset-2 disabled:opacity-50"
                    disabled={busy}
                    title="Permanently delete the Dealer-local issue, its history, and its files — the Linear ticket is not deleted"
                    onClick={() => setDeleteConfirming(true)}
                  >
                    Delete from Dealer
                  </button>
                ) : (
                  <DeleteIssueConfirmation
                    expectedToken={deleteConfirmationToken(issue)}
                    externalLabel={issue.externalLabel}
                    busy={busy}
                    onConfirm={() => void doDelete()}
                    onCancel={() => setDeleteConfirming(false)}
                  />
                ))}
            </div>
          </details>
        )}

        {/* Evidence: closed by default — artifact-first with expandable detail, not
            implementation noise shown up front. */}
        <details className="mt-6" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadEvidence()}>
          <summary className="text-xs text-white/45 cursor-pointer hover:text-white/70">Evidence & raw trace</summary>
          {!evidence ? (
            <p className="text-xs text-white/40 mt-2">Loading…</p>
          ) : (
            <div className="mt-2 space-y-3 text-xs text-white/60">
              <div>
                <p className="text-white/45 mb-1">Worker sessions</p>
                {evidence.workerSessions.map((s) => {
                  const usage = evidence.usageEvents.filter((u) => u.workerSessionId === s.id);
                  const cost = usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
                  const tokensIn = usage.reduce((sum, u) => sum + (u.tokensIn ?? 0), 0);
                  const tokensOut = usage.reduce((sum, u) => sum + (u.tokensOut ?? 0), 0);
                  return (
                    <p key={s.id}>
                      {s.role} round {s.round} · {s.status}
                      {s.startedAt && s.completedAt ? ` · ${fmtDuration(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime())}` : ""}
                      {usage.length > 0 ? ` · $${cost.toFixed(3)} · ${tokensIn}→${tokensOut} tok` : ""}
                    </p>
                  );
                })}
                {evidence.workerSessions.length === 0 && <p className="text-white/35">None yet.</p>}
              </div>
              <div>
                <p className="text-white/45 mb-1">Artifacts</p>
                {evidence.artifacts.map((a) => {
                  const trace = traces[a.id];
                  return (
                    <details key={a.id} className="mb-1.5" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && a.blobPath && loadTrace(a.id)}>
                      <summary className="cursor-pointer hover:text-white/80">
                        {a.kind} · {new Date(a.createdAt).toLocaleString()}
                      </summary>
                      <div className="mt-1 pl-3 border-l border-white/10 space-y-1">
                        {a.contentJson && <pre className="whitespace-pre-wrap break-words text-white/55">{formatArtifactContent(a.contentJson)}</pre>}
                        {a.blobPath && (
                          <div>
                            <p className="text-white/40">Raw trace: {a.blobPath}</p>
                            {trace?.loading && <p className="text-white/35">Loading trace…</p>}
                            {trace?.error && <p className="text-red-300/80">{trace.error}</p>}
                            {trace && !trace.loading && !trace.error && (
                              <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-white/50 bg-black/20 rounded p-2">{trace.content || "(empty)"}</pre>
                            )}
                          </div>
                        )}
                        {!a.contentJson && !a.blobPath && <p className="text-white/35">No content recorded.</p>}
                      </div>
                    </details>
                  );
                })}
                {evidence.artifacts.length === 0 && <p className="text-white/35">None yet.</p>}
              </div>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
