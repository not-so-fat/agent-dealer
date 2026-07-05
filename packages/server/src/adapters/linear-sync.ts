import type { Run } from "@agent-dealer/shared";
import { addArtifact, getLatestArtifact, listArtifacts } from "../repository/runs.js";
import { getLinearIntakeConfig } from "../repository/intake-settings.js";
import { getLinearIssue } from "./linear-inbox.js";

const LINEAR_API = "https://api.linear.app/graphql";

export type LinearSyncEvent = "plan_approved" | "review" | "done";

const STATE_BY_EVENT: Record<LinearSyncEvent, string> = {
  plan_approved: "In Progress",
  review: "In Review",
  done: "Done",
};

const workflowStateCache = new Map<string, Map<string, string>>();

function webBaseUrl(): string {
  return process.env.AGENT_DEALER_WEB_URL ?? "http://localhost:5173";
}

async function linearMutate(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getWorkflowStates(teamId: string): Promise<Map<string, string>> {
  const cached = workflowStateCache.get(teamId);
  if (cached) return cached;

  const data = (await linearMutate(
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
    `mutation Comment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body }
  );
}

async function issueUpdateState(issueId: string, stateId: string): Promise<void> {
  await linearMutate(
    `mutation UpdateIssue($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
    }`,
    { issueId, stateId }
  );
}

function planExcerpt(run: Run): string {
  const plan = getLatestArtifact(run.id, "approved_plan");
  if (!plan?.contentJson) return "";
  try {
    const parsed = JSON.parse(plan.contentJson) as { markdown?: string };
    const md = parsed.markdown?.trim() ?? "";
    return md.length > 600 ? `${md.slice(0, 600)}…` : md;
  } catch {
    return "";
  }
}

function resultExcerpt(run: Run): string {
  const result = getLatestArtifact(run.id, "execution_result");
  if (result?.contentJson) {
    try {
      const parsed = JSON.parse(result.contentJson) as { resultText?: string };
      const text = parsed.resultText?.trim() ?? "";
      if (text) return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch {
      /* fall through */
    }
  }
  const doc = listArtifacts(run.id).find((a) => a.kind === "document");
  if (doc?.contentJson) {
    try {
      const parsed = JSON.parse(doc.contentJson) as { markdown?: string };
      const text = parsed.markdown?.trim() ?? "";
      if (text) return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function buildComment(run: Run, event: LinearSyncEvent): string {
  const label = run.externalLabel ?? run.externalId ?? run.id;
  const link = `${webBaseUrl()}/?run=${run.id}`;

  if (event === "plan_approved") {
    const excerpt = planExcerpt(run);
    return [
      `**agent-dealer** — plan approved for ${label}`,
      ``,
      excerpt ? excerpt : `_Plan approved — see run for details._`,
      ``,
      `[Open run](${link})`,
    ].join("\n");
  }

  if (event === "review") {
    const excerpt = resultExcerpt(run);
    return [
      `**agent-dealer** — execution complete, awaiting review (${label})`,
      ``,
      excerpt ? excerpt : `_Result ready for human review._`,
      ``,
      `[Review run](${link})`,
    ].join("\n");
  }

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
    await commentCreate(run.externalId, buildComment(run, event));
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
