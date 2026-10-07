// packages/server/src/coordinator/linear-merge-verify.ts
//
// NOT-362: when Dealer merges an approved PR for a `source = linear` issue, the
// Linear issue it came from must either advance, or a human must be told it did
// not. Linear's GitHub integration normally drives that (attaching the PR and
// moving the issue out of Backlog), but on repositories the integration does
// not cover nothing fires and Dealer recorded nothing — the issue sat stale
// with zero evidence anywhere.
//
// The check runs after the coordinator's terminal merged transition
// (finalizeAutoMerge's `done`, plus the external-merge close-as-`done` paths):
// re-read the Linear issue over a bounded retry window and treat it as advanced
// when its state type left `backlog`/`unstarted` or its attachments contain the
// merged PR URL. Every outcome is recorded as an issue artifact (both
// directions — a stale source issue appears in history instead of being
// inferred from absence). A stale issue with `linear.syncEnabled` gets exactly
// one fallback write to the team's completed state plus the Dealer comment,
// reusing linear-sync's writer; when the fallback is unavailable or fails, one
// open `policy_escalation` names the Linear identifier, the merged PR URL and
// the observed state (idempotent re-raise by stable request id).
//
// Safety: this module never touches the Dealer issue's status, never blocks
// the merge, and never throws — callers `await` it inline on the finalize path
// and fire-and-forget it from sync cores. A resolution attempt on the raised
// action answers 409 (no active workflow on a `done` issue) without changing
// anything; the action is a notice, not a gate.

import { createIssueArtifact } from "../repository/artifacts.js";
import { listArtifactsForIssueByKind } from "../repository/artifacts-for-issue.js";
import {
  createHumanAction,
  findOpenHumanActionByRequestId,
  resolveHumanAction,
} from "../repository/human-actions.js";
import { getIssue } from "../repository/issues.js";
import { getLinearIntakeConfig } from "../repository/intake-settings.js";
import { linearGraphqlRequest } from "../adapters/linear-graphql.js";
import {
  buildDoneComment,
  dealerIssueUrl,
  postLinearIssueComment,
  resolveCompletedStateId,
  setLinearIssueState,
} from "../adapters/linear-sync.js";

/** Issue-artifact kind for every post-merge verification outcome. */
export const LINEAR_MERGE_VERIFY_ARTIFACT_KIND = "linear_merge_verify";

/** Stable request id for the stale-source human action — re-runs dedupe onto it. */
export function linearMergeStaleRequestId(issueId: string): string {
  return `linear-merge-stale:${issueId}`;
}

/** Bounded retry window so the GitHub integration has time to act. */
export const LINEAR_POST_MERGE_READ_DELAYS_MS = [0, 10_000, 30_000];

export interface LinearPostMergeObservation {
  identifier: string | null;
  linearUrl: string | null;
  stateName: string | null;
  stateType: string | null;
  teamId: string | null;
  attachmentUrls: string[];
  prAttached: boolean;
  advancedViaState: boolean;
}

export type LinearPostMergeReader = (externalId: string) => Promise<LinearPostMergeObservation>;

interface RawPostMergeIssue {
  identifier?: string | null;
  url?: string | null;
  state?: { name?: string | null; type?: string | null } | null;
  team?: { id?: string | null } | null;
  attachments?: { nodes?: Array<{ url?: string | null } | null> | null } | null;
}

async function defaultPostMergeReader(externalId: string): Promise<LinearPostMergeObservation> {
  const data = (await linearGraphqlRequest({
    operation: "readLinearPostMergeState",
    query: `query PostMergeState($id: String!) {
      issue(id: $id) {
        identifier
        url
        state { name type }
        team { id }
        attachments(first: 50) { nodes { url } }
      }
    }`,
    variables: { id: externalId },
    timeoutMs: 15_000,
  })) as { issue: RawPostMergeIssue | null };
  if (!data.issue) throw new Error(`Linear issue not found: ${externalId}`);
  const urls = (data.issue.attachments?.nodes ?? [])
    .map((n) => n?.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  return {
    identifier: data.issue.identifier ?? null,
    linearUrl: data.issue.url ?? null,
    stateName: data.issue.state?.name ?? null,
    stateType: data.issue.state?.type ?? null,
    teamId: data.issue.team?.id ?? null,
    attachmentUrls: urls,
    prAttached: false,
    advancedViaState: false,
  };
}

let postMergeReader: LinearPostMergeReader = defaultPostMergeReader;

/** Test hook — inject a fake Linear reader so tests never hit the network. */
export function setPostMergeReaderForTests(fn: LinearPostMergeReader | null): void {
  postMergeReader = fn ?? defaultPostMergeReader;
}

let readDelaysMs: number[] = LINEAR_POST_MERGE_READ_DELAYS_MS;

/** Test hook — shrink the retry window (e.g. `[0, 0]`) so tests stay fast. */
export function setPostMergeDelaysForTests(delays: number[] | null): void {
  readDelaysMs = delays ?? LINEAR_POST_MERGE_READ_DELAYS_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** State types that still mean "the integration has not acted". */
function isStaleStateType(stateType: string | null): boolean {
  const t = (stateType ?? "").toLowerCase();
  return t === "" || t === "backlog" || t === "unstarted";
}

export type LinearPostMergeResult =
  | { checked: true; advanced: boolean; advancedVia?: "state" | "attachment"; fallback?: string; actionId?: string | null }
  | { checked: false; reason: string };

function fallbackAlreadyWritten(issueId: string): boolean {
  for (const artifact of listArtifactsForIssueByKind(issueId, LINEAR_MERGE_VERIFY_ARTIFACT_KIND)) {
    try {
      if ((JSON.parse(artifact.contentJson ?? "null") as { fallback?: unknown })?.fallback === "written") {
        return true;
      }
    } catch {
      // A row this module did not write — ignore, never treat as a guard.
    }
  }
  return false;
}

function dismissOpenStaleAction(issueId: string, note: string): void {
  const open = findOpenHumanActionByRequestId(issueId, "policy_escalation", linearMergeStaleRequestId(issueId));
  if (open) {
    try {
      resolveHumanAction(open.id, "system", { choice: "dismissed", note });
    } catch {
      // Resolving the notice must never fail the verification.
    }
  }
}

function staleReasonText(opts: {
  identifier: string;
  prUrl: string | null;
  stateName: string | null;
  stateType: string | null;
  unreadable?: string | null;
}): string {
  const observed = opts.unreadable
    ? `could not be re-read (${opts.unreadable})`
    : `still ${opts.stateName ?? "unknown state"}${opts.stateType ? ` (${opts.stateType})` : ""}`;
  return (
    `Linear ${opts.identifier} ${observed} after the merged PR ${opts.prUrl ?? "(no PR URL recorded)"}. ` +
    `Linear's GitHub integration did not advance it, so advance it by hand. ` +
    `The Dealer issue itself is done and stays done — this action is a notice, not a gate.`
  );
}

/**
 * Re-read the Linear source issue after a merged terminal transition and either
 * confirm it advanced, advance it once via the conditional fallback, or raise
 * the one human action. Records an artifact in every direction. Never throws
 * and never touches the Dealer issue's status.
 */
export async function verifyLinearPostMerge(issueId: string): Promise<LinearPostMergeResult> {
  try {
    return await verifyLinearPostMergeInner(issueId);
  } catch (err) {
    return { checked: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function verifyLinearPostMergeInner(issueId: string): Promise<LinearPostMergeResult> {
  const issue = getIssue(issueId);
  if (!issue || issue.source !== "linear" || !issue.externalId) {
    return { checked: false, reason: "not a Linear-sourced issue" };
  }
  const linearId = issue.externalId;
  const prUrl = issue.prUrl;

  let observation: LinearPostMergeObservation | null = null;
  let readError: string | null = null;
  for (let attempt = 0; attempt < readDelaysMs.length; attempt += 1) {
    if (readDelaysMs[attempt]! > 0) await sleep(readDelaysMs[attempt]!);
    try {
      const read = await postMergeReader(linearId);
      const advancedViaState = !isStaleStateType(read.stateType);
      const prAttached = prUrl != null && read.attachmentUrls.includes(prUrl);
      observation = { ...read, prAttached, advancedViaState };
      if (advancedViaState || prAttached) break;
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
  }

  const identifier = observation?.identifier ?? issue.externalLabel ?? linearId;
  const reads = observation
    ? {
        stateName: observation.stateName,
        stateType: observation.stateType,
        prAttached: observation.prAttached,
      }
    : { error: readError };

  if (observation && (observation.advancedViaState || observation.prAttached)) {
    const advancedVia = observation.advancedViaState ? "state" : "attachment";
    createIssueArtifact({
      issueId,
      kind: LINEAR_MERGE_VERIFY_ARTIFACT_KIND,
      author: "system",
      content: {
        check: "post_merge",
        linearId,
        identifier,
        prUrl,
        reads,
        outcome: "advanced",
        advancedVia,
      },
    });
    dismissOpenStaleAction(issueId, `Linear ${identifier} advanced (${advancedVia}); notice cleared.`);
    return { checked: true, advanced: true, advancedVia };
  }

  // Stale (or unreadable): the fallback fires only after the integration has
  // demonstrably not acted — an unreadable issue never reaches the writer.
  const syncEnabled = getLinearIntakeConfig().syncEnabled && Boolean(process.env.LINEAR_API_KEY);
  const teamId = observation?.teamId ?? null;
  let fallback = "skipped" as string;
  if (syncEnabled && teamId && !fallbackAlreadyWritten(issueId)) {
    try {
      const stateId = await resolveCompletedStateId(teamId);
      if (!stateId) {
        fallback = "unavailable:no-completed-state";
      } else {
        const label = issue.externalLabel ?? identifier;
        await postLinearIssueComment(linearId, buildDoneComment(label, dealerIssueUrl(issueId), "View issue"));
        await setLinearIssueState(linearId, stateId);
        fallback = "written";
        dismissOpenStaleAction(issueId, `Dealer fallback advanced Linear ${identifier}; notice cleared.`);
      }
    } catch (err) {
      fallback = `failed:${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (fallbackAlreadyWritten(issueId)) {
    fallback = "already_recorded";
  } else if (!syncEnabled) {
    fallback = "unavailable:sync-disabled";
  } else if (!teamId) {
    fallback = "unavailable:no-team";
  }

  let actionId: string | null = null;
  if (fallback !== "written" && fallback !== "already_recorded") {
    const reason = staleReasonText({
      identifier,
      prUrl,
      stateName: observation?.stateName ?? null,
      stateType: observation?.stateType ?? null,
      unreadable: observation ? null : readError,
    });
    const requestId = linearMergeStaleRequestId(issueId);
    const open = findOpenHumanActionByRequestId(issueId, "policy_escalation", requestId);
    if (open) {
      actionId = open.id;
    } else {
      const action = createHumanAction({
        issueId,
        workflowInstanceId: null,
        actionType: "policy_escalation",
        reason,
        question: reason,
        evidence: {
          linearMergeStale: true,
          linearId,
          identifier,
          linearUrl: observation?.linearUrl ?? null,
          prUrl,
          observedStateName: observation?.stateName ?? null,
          observedStateType: observation?.stateType ?? null,
          fallback,
        },
        responseOptions: [
          { choice: "resume", label: "Resume development" },
          { choice: "close", label: "Close" },
        ],
        requestId,
      });
      actionId = action.id;
    }
  }

  createIssueArtifact({
    issueId,
    kind: LINEAR_MERGE_VERIFY_ARTIFACT_KIND,
    author: "system",
    content: {
      check: "post_merge",
      linearId,
      identifier,
      prUrl,
      reads,
      outcome: "stale",
      fallback,
      actionId,
    },
  });
  return { checked: true, advanced: false, fallback, actionId };
}

/** Fire-and-forget entry for sync cores (close/abort resolutions) — never throws. */
export function triggerLinearPostMerge(issueId: string): void {
  void verifyLinearPostMerge(issueId).catch((err) => {
    console.error(`[linear-merge-verify] post-merge check for ${issueId} failed:`, err);
  });
}
