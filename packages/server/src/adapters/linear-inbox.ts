import type { LinearCandidate, LinearIntakeConfig } from "@agent-dealer/shared";
import { findActiveByExternalId, listRuns } from "../repository/runs.js";
import { getLinearIntakeConfig } from "../repository/intake-settings.js";

const LINEAR_API = "https://api.linear.app/graphql";

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  state?: { name: string };
  team?: { id: string };
  labels?: { nodes: Array<{ name: string }> };
}

export interface LinearViewer {
  id: string;
  name: string;
  email?: string;
}

function hasApiKey(): boolean {
  return Boolean(process.env.LINEAR_API_KEY);
}

async function linearQuery(query: string, variables?: Record<string, unknown>): Promise<unknown> {
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

function nodeToCandidate(n: LinearIssueNode): LinearCandidate {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    url: n.url,
    state: n.state?.name,
    teamId: n.team?.id,
    labels: n.labels?.nodes.map((l) => l.name) ?? [],
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  state { name }
  team { id }
  labels { nodes { name } }
`;

export async function getLinearViewer(): Promise<LinearViewer | null> {
  if (!hasApiKey()) return null;
  const data = (await linearQuery(`query { viewer { id name email } }`)) as {
    viewer: LinearViewer | null;
  };
  return data.viewer;
}

export async function testLinearConnection(): Promise<{
  connected: boolean;
  viewer?: LinearViewer;
  error?: string;
}> {
  if (!hasApiKey()) {
    return { connected: false, error: "LINEAR_API_KEY not set" };
  }
  try {
    const viewer = await getLinearViewer();
    if (!viewer) return { connected: false, error: "No viewer returned" };
    return { connected: true, viewer };
  } catch (e) {
    return { connected: false, error: String(e) };
  }
}

export function buildIssueFilter(
  settings: LinearIntakeConfig,
  viewerId?: string
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    state: { name: { in: settings.stateFilter } },
  };
  if (settings.teamId) {
    filter.team = { id: { eq: settings.teamId } };
  }
  if (settings.assigneeMe && viewerId) {
    filter.assignee = { id: { eq: viewerId } };
  }
  return filter;
}

function isPromoted(issueId: string): boolean {
  return findActiveByExternalId("linear", issueId) !== null;
}

export async function listLinearCandidates(): Promise<LinearCandidate[]> {
  if (!hasApiKey()) return [];

  const settings = getLinearIntakeConfig();
  let viewerId: string | undefined;
  if (settings.assigneeMe) {
    const viewer = await getLinearViewer();
    viewerId = viewer?.id;
    if (!viewerId) return [];
  }

  const filter = buildIssueFilter(settings, viewerId);

  const data = (await linearQuery(
    `query PollIssues($filter: IssueFilter) {
      issues(filter: $filter, first: 30) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    { filter }
  )) as { issues: { nodes: LinearIssueNode[] } };

  return data.issues.nodes
    .filter((n) => !isPromoted(n.id))
    .map(nodeToCandidate);
}

export async function getLinearIssue(issueId: string): Promise<LinearCandidate | null> {
  const data = (await linearQuery(
    `query Issue($id: String!) {
      issue(id: $id) { ${ISSUE_FIELDS} }
    }`,
    { id: issueId }
  )) as { issue: LinearIssueNode | null };

  if (!data.issue) return null;
  return nodeToCandidate(data.issue);
}

/** Runs awaiting plan review (Intake list). */
export function listAwaitingPlanReview() {
  return listRuns("plan_pending");
}
