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

async function linearQuery(
  query: string,
  variables?: Record<string, unknown>,
  opts?: { timeoutMs?: number }
): Promise<unknown> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    ...(opts?.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
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

/** A Linear issue that declares `blocks` on one of the issues we asked about (NOT-104). */
export interface LinearBlockerNode {
  /** Linear issue UUID — joins to `issues.external_id`. Empty when the blocker is unreadable. */
  id: string;
  /** Human label the operator sees in a wait reason, e.g. `NOT-123`. */
  identifier: string;
  /** Workflow state name, e.g. `In Progress`. */
  stateName: string;
  /** Workflow state type: triage | backlog | unstarted | started | completed | canceled. */
  stateType: string;
}

interface LinearRelationNode {
  type?: string;
  issue?: { id: string; identifier: string; state?: { name?: string; type?: string } } | null;
}

/** A blocker Linear won't let us read (other team, no permission, deleted) — never satisfied. */
const UNREADABLE_BLOCKER: LinearBlockerNode = {
  id: "",
  identifier: "an unreadable blocker",
  stateName: "no access",
  stateType: "unknown",
};

function relationToBlocker(node: LinearRelationNode): LinearBlockerNode {
  if (!node.issue) return UNREADABLE_BLOCKER;
  return {
    id: node.issue.id,
    identifier: node.issue.identifier,
    stateName: node.issue.state?.name ?? "unknown state",
    stateType: node.issue.state?.type ?? "unknown",
  };
}

/**
 * NOT-104: for each requested Linear issue id, the issues that declare `blocks` on it.
 *
 * Linear models "Y blocks X" as a relation *from* Y, so X sees it in `inverseRelations`;
 * X's own `relations` are its *downstream* issues and reading those would gate on the
 * wrong side of every edge. Only `type === "blocks"` counts — `related`, `duplicate` and
 * the parent/sub-issue hierarchy are deliberately ignored so an open parent epic does not
 * block its own children.
 *
 * `includeArchived` is on because a queued dealer issue whose Linear ticket was archived
 * must still resolve; archived blockers are judged by their state type, not the flag.
 *
 * One query (paged) for the whole batch — per-entry queries would make a 10-entry queue at
 * a 60s TTL cost ~600 Linear requests/hour. Ids Linear does not return are simply absent
 * from the map; the caller treats that as "unknown", never as "no blockers". An issue whose
 * relation list is itself longer than one page is left out for the same reason: a truncated
 * list could hide the one unsatisfied blocker and admit the run this rule exists to stop.
 */
export async function fetchLinearBlockers(
  issueIds: string[],
  opts: { timeoutMs?: number } = {}
): Promise<Map<string, LinearBlockerNode[]>> {
  const out = new Map<string, LinearBlockerNode[]>();
  if (issueIds.length === 0) return out;

  // One deadline for the whole batch, not per page: the caller's budget is a slice of a ~3s
  // coordinator tick, and a queue deeper than one page must not multiply it.
  const deadlineAt = opts.timeoutMs ? Date.now() + opts.timeoutMs : null;
  const remaining = () => (deadlineAt ? Math.max(1, deadlineAt - Date.now()) : undefined);

  let after: string | undefined;
  for (;;) {
    const data = (await linearQuery(
      `query BlockingRelations($ids: [ID!], $after: String) {
        issues(filter: { id: { in: $ids } }, first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
          nodes {
            id
            inverseRelations(first: ${PAGE_SIZE}) {
              nodes { type issue { id identifier state { name type } } }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { ids: issueIds, after: after ?? null },
      { timeoutMs: remaining() }
    )) as {
      issues: {
        nodes: Array<{
          id: string;
          inverseRelations?: { nodes?: LinearRelationNode[]; pageInfo?: { hasNextPage: boolean } };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    for (const node of data.issues.nodes) {
      // A list we only partly saw (or did not get at all) is unknown, not "no blockers":
      // the one unsatisfied blocker may be exactly the relation we are missing.
      if (!node.inverseRelations || node.inverseRelations.pageInfo?.hasNextPage) continue;
      const blockers = (node.inverseRelations.nodes ?? [])
        .filter((r) => r.type === "blocks")
        .map(relationToBlocker);
      out.set(node.id, blockers);
    }

    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
    after = data.issues.pageInfo.endCursor;
  }

  return out;
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
