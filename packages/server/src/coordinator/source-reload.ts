// packages/server/src/coordinator/source-reload.ts
// NOT-363: reload a Linear-sourced issue's task text from its linked ticket.
//
// Before the workflow snapshot freezes, an operator can pull the latest title
// and description from Linear. The shared execution-contract compiler rebuilds
// the contract from the refreshed description, and the derived acceptance
// criteria replace whatever the issue carried — old local criteria never
// survive a source reload. Repository, base branch, agent assignments, policy
// limits, auto-merge, queue position, and every coordinator-owned field are
// untouched; nothing is written back to Linear.
import { createHash } from "node:crypto";
import {
  compileExecutionContract,
  ExecutionContractError,
  type Issue,
  type LinearCandidate,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { getIssue } from "../repository/issues.js";
import { appendWorkflowEvent, getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { getActiveWorkerSessionForIssue } from "../repository/worker-sessions.js";
import { getLinearIssue } from "../adapters/linear-inbox.js";

export type ReloadSourceResult =
  | { ok: true; issue: Issue }
  | { ok: false; code: number; error: string };

/** Short digest of task text for the timeline payload — never the full text. */
export function digestTaskText(text: string | null): string {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 16);
}

/**
 * NOT-363: the issue must still be pre-execution — `ready` with no active
 * workflow and no running worker. Anything else answers 409 and changes
 * nothing, so a reload that races admission fails closed instead of landing
 * on a live snapshot.
 */
function reloadConflict(issue: Issue): string | null {
  if (issue.status !== "ready") {
    return `Cannot reload the source of an issue that is ${issue.status}`;
  }
  if (getActiveWorkerSessionForIssue(issue.id)) {
    return "Cannot reload the source of an issue with an actively running session";
  }
  if (getActiveWorkflowInstance(issue.id)) {
    return "Cannot reload the source of an issue with an active workflow";
  }
  return null;
}

/**
 * One explicit server operation: fetch the linked Linear ticket through the
 * direct GraphQL adapter, replace title + description atomically, recompile
 * the execution contract, and replace the acceptance criteria with the
 * criteria derived from the refreshed description.
 *
 * `fetchLinearIssue` is injectable for tests; production passes the shared
 * `getLinearIssue` adapter. The Linear fetch happens outside the write
 * transaction, and the pre-execution guard runs twice — once for the fast
 * path, once inside the transaction — so a race with admission answers 409
 * with no partial write and no timeline event.
 */
export async function reloadIssueSourceFromLinear(
  issueId: string,
  opts?: { fetchLinearIssue?: (externalId: string) => Promise<LinearCandidate | null> }
): Promise<ReloadSourceResult> {
  const issue = getIssue(issueId);
  if (!issue) return { ok: false, code: 404, error: "Not found" };
  if (issue.source !== "linear") {
    return { ok: false, code: 400, error: "Only Linear-sourced issues can be reloaded from Linear" };
  }
  if (!issue.externalId) {
    return { ok: false, code: 400, error: "Issue has no linked Linear ticket to reload from" };
  }
  const fastPath = reloadConflict(issue);
  if (fastPath) return { ok: false, code: 409, error: fastPath };

  const fetchLinearIssue = opts?.fetchLinearIssue ?? getLinearIssue;
  let candidate: LinearCandidate | null;
  try {
    candidate = await fetchLinearIssue(issue.externalId);
  } catch (err) {
    return { ok: false, code: 502, error: `Linear reload failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!candidate) {
    return { ok: false, code: 404, error: "Linear issue not found — it may have been deleted" };
  }

  // NOT-363: the same title convention as import (`<identifier>: <title>`);
  // the description mirrors import (trimmed, empty falls back to null) so a
  // reload and a fresh import of the same ticket agree field-for-field.
  const nextTitle = `${candidate.identifier}: ${candidate.title}`;
  const nextDescription = candidate.description?.trim() ? candidate.description : null;

  // A source refresh recompiles through the shared compiler — an
  // ambiguous/malformed refreshed description is a 400 with an actionable
  // message, never a silent half-parse and never a partial write.
  let nextAcceptanceCriteria: string | null;
  try {
    nextAcceptanceCriteria = compileExecutionContract(nextDescription).acceptanceCriteria;
  } catch (err) {
    if (err instanceof ExecutionContractError) {
      return { ok: false, code: 400, error: err.message };
    }
    throw err;
  }

  const prevTitleDigest = digestTaskText(issue.title);
  const prevDescriptionDigest = digestTaskText(issue.description);

  try {
    const updated = getDb().transaction((): Issue => {
      const fresh = getIssue(issueId);
      if (!fresh) throw Object.assign(new Error("Not found"), { code: 404 });
      const conflict = reloadConflict(fresh);
      if (conflict) throw Object.assign(new Error(conflict), { code: 409 });
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `UPDATE issues SET title = @title, description = @description,
           acceptance_criteria = @acceptance_criteria, updated_at = @updated_at WHERE id = @id`
        )
        .run({
          id: issueId,
          title: nextTitle,
          description: nextDescription,
          acceptance_criteria: nextAcceptanceCriteria,
          updated_at: now,
        });
      appendWorkflowEvent({
        issueId,
        type: "issue.source_reloaded",
        actorType: "human",
        stage: fresh.status,
        payload: {
          source: "linear",
          externalId: fresh.externalId,
          externalLabel: fresh.externalLabel,
          prevTitleDigest,
          newTitleDigest: digestTaskText(nextTitle),
          prevDescriptionDigest,
          newDescriptionDigest: digestTaskText(nextDescription),
        },
      });
      const next = getIssue(issueId);
      if (!next) throw Object.assign(new Error("Not found"), { code: 404 });
      return next;
    })();
    return { ok: true, issue: updated };
  } catch (err) {
    const code = (err as { code?: number }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 404 || code === 409) return { ok: false, code, error: message };
    throw err;
  }
}
