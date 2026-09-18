import type { Run } from "@agent-dealer/shared";
import { addArtifact } from "../repository/runs.js";
import { getLinearIntakeConfig } from "../repository/intake-settings.js";
import { getLinearIssue } from "./linear-inbox.js";
import { linearGraphqlRequest } from "./linear-graphql.js";

// NOT-71: the plan/execute dispatcher that fired planning_started / plan_approved /
// review / retry is deleted, and the issue workflow deliberately does not write status
// back — Linear's own GitHub integration links the PR and drives the issue state from
// the PR lifecycle, so duplicating that here would fight it. The one surviving caller is
// queue/approve-deliver.ts on the run-scoped outbound-delivery approval.
export type LinearSyncEvent = "done";

const STATE_BY_EVENT: Record<LinearSyncEvent, string> = {
  // TODO(P2): configurable per team — see docs/LINEAR_INTEGRATION.md
  done: "Done",
};

const workflowStateCache = new Map<string, Map<string, string>>();

function webBaseUrl(): string {
  return process.env.AGENT_DEALER_WEB_URL ?? "http://localhost:2222";
}

async function linearMutate(operation: string, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  return linearGraphqlRequest({ operation, query, variables });
}

async function getWorkflowStates(teamId: string): Promise<Map<string, string>> {
  const cached = workflowStateCache.get(teamId);
  if (cached) return cached;

  const data = (await linearMutate(
    "getWorkflowStates",
    `query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name } }
      }
    }`,
    { teamId }
  )) as { team: { states: { nodes: Array<{ id: string; name: string }> } } | null };

  const map = new Map<string, string>();
  for (const s of data.team?.states.nodes ?? []) {
    map.set(s.name.toLowerCase(), s.id);
  }
  workflowStateCache.set(teamId, map);
  return map;
}

async function commentCreate(issueId: string, body: string): Promise<void> {
  await linearMutate(
    "commentCreate",
    `mutation Comment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body }
  );
}

async function issueUpdateState(issueId: string, stateId: string): Promise<void> {
  await linearMutate(
    "issueUpdateState",
    `mutation UpdateIssue($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
    }`,
    { issueId, stateId }
  );
}



function buildComment(run: Run): string {
  const label = run.externalLabel ?? run.externalId ?? run.id;
  const link = `${webBaseUrl()}/?run=${run.id}`;
  return [
    `**agent-dealer** — approved and marked done (${label})`,
    ``,
    `[View run](${link})`,
  ].join("\n");
}

function recordSyncAttempt(
  run: Run,
  event: LinearSyncEvent,
  ok: boolean,
  detail: Record<string, unknown>
): void {
  addArtifact(
    run.id,
    "linear_sync",
    { event, ok, at: new Date().toISOString(), ...detail },
    "system"
  );
}


/** Non-blocking Linear write-back — callers should `.catch()` and never fail the human action. */
export async function syncLinearForRun(run: Run, event: LinearSyncEvent): Promise<void> {
  const settings = getLinearIntakeConfig();
  if (!settings.syncEnabled || !process.env.LINEAR_API_KEY || !run.externalId) {
    return;
  }


  const issue = await getLinearIssue(run.externalId);
  if (!issue?.teamId) {
    recordSyncAttempt(run, event, false, { error: "Issue or teamId not found" });
    return;
  }

  const targetStateName = STATE_BY_EVENT[event];
  const states = await getWorkflowStates(issue.teamId);
  const stateId = states.get(targetStateName.toLowerCase());

  try {
    await commentCreate(run.externalId, buildComment(run));
    if (stateId) {
      await issueUpdateState(run.externalId, stateId);
    } else {
      recordSyncAttempt(run, event, false, {
        error: `Workflow state not found: ${targetStateName}`,
        teamId: issue.teamId,
      });
      return;
    }
    recordSyncAttempt(run, event, true, { state: targetStateName });
  } catch (e) {
    recordSyncAttempt(run, event, false, { error: String(e) });
    console.error(`[linear-sync] ${event} for run ${run.id}:`, e);
  }
}
