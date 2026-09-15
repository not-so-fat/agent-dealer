import type { LinearCandidate, LinearIntakeConfig } from "@agent-dealer/shared";
import { findActiveByExternalId, listRunsReadyForPlanReview } from "../repository/runs.js";
import { DEFAULT_LINEAR_STATE_FILTER, getLinearIntakeConfig } from "../repository/intake-settings.js";

export { DEFAULT_LINEAR_STATE_FILTER };

const LINEAR_API = "https://api.linear.app/graphql";

const PAGE_SIZE = 50;

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

/**
 * Normalize free-form kick input to a Linear issue id or identifier.
 * Accepts `NOT-103`, a UUID, or a Linear issue URL.
 */
export function parseLinearIssueRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fromUrl = trimmed.match(/linear\.app\/[^/]+\/issue\/([A-Za-z0-9_-]+)/i);
  if (fromUrl?.[1]) return fromUrl[1];

  if (/^[A-Z][A-Z0-9]*-\d+$/i.test(trimmed)) return trimmed.toUpperCase();

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
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
  const nodes: LinearIssueNode[] = [];
  let after: string | undefined;

  for (;;) {
    const data = (await linearQuery(
      `query PollIssues($filter: IssueFilter, $after: String) {
        issues(filter: $filter, first: ${PAGE_SIZE}, after: $after) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after: after ?? null }
    )) as {
      issues: {
        nodes: LinearIssueNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    nodes.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
    after = data.issues.pageInfo.endCursor;
  }

  return nodes.filter((n) => !isPromoted(n.id)).map(nodeToCandidate);
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

/** Resolve free-form kick text to a Linear candidate (or null if not found / unparseable). */
export async function lookupLinearIssue(raw: string): Promise<LinearCandidate | null> {
  const id = parseLinearIssueRef(raw);
  if (!id) return null;
  return getLinearIssue(id);
}

/** Runs with a plan ready for human review. */
export function listAwaitingPlanReview() {
  return listRunsReadyForPlanReview();
}
