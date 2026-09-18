import type { LinearCandidate, LinearIntakeConfig } from "@agent-dealer/shared";
import { DEFAULT_LINEAR_STATE_FILTER, getLinearIntakeConfig } from "../repository/intake-settings.js";
import { linearGraphqlRequest } from "./linear-graphql.js";

export { DEFAULT_LINEAR_STATE_FILTER };

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
  operation: string,
  query: string,
  variables?: Record<string, unknown>,
  opts?: { timeoutMs?: number }
): Promise<unknown> {
  return linearGraphqlRequest({
    operation,
    query,
    variables,
    timeoutMs: opts?.timeoutMs,
  });
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
  const data = (await linearQuery(
    "getLinearViewer",
    `query { viewer { id name email } }`
  )) as {
    viewer: LinearViewer | null;
  };
  return data.viewer;
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
      "listLinearCandidates",
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

  return nodes.map(nodeToCandidate);
}

export async function getLinearIssue(issueId: string): Promise<LinearCandidate | null> {
  const data = (await linearQuery(
    "getLinearIssue",
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

interface RelationPage {
  nodes?: LinearRelationNode[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

const RELATION_PAGE_FIELDS = `
  nodes { type issue { id identifier state { name type } } }
  pageInfo { hasNextPage endCursor }
`;

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
 * Every request covers the whole batch — per-entry queries would make a 10-entry queue at a
 * 60s TTL cost ~600 Linear requests/hour. Ids Linear does not return are simply absent from
 * the map; the caller treats that as "unknown", never as "no blockers". An issue with more
 * relations than fit in one page is *paged through* rather than dropped: `related` and
 * `duplicate` links share that connection, so a well-linked ticket would otherwise park for
 * good on relations that were never meant to gate it. Those nested pages are walked in
 * rounds, one request per round across every issue still paging, so relation volume costs
 * extra requests only in depth (rare) and never in queue width.
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

  // Relations gathered so far per issue. Deleting an id here is how an incomplete list stays
  // "unknown": it never reaches `out`, and the caller parks the entry for this tick only.
  const relationsById = new Map<string, LinearRelationNode[]>();
  let paging: PendingRelationPage[] = [];

  let after: string | undefined;
  for (;;) {
    const data = (await linearQuery(
      "fetchLinearBlockers",
      `query BlockingRelations($ids: [ID!], $after: String) {
        issues(filter: { id: { in: $ids } }, first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
          nodes {
            id
            inverseRelations(first: ${PAGE_SIZE}) { ${RELATION_PAGE_FIELDS} }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { ids: issueIds, after: after ?? null },
      { timeoutMs: remaining() }
    )) as {
      issues: {
        nodes: Array<{ id: string; inverseRelations?: RelationPage }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    for (const node of data.issues.nodes) {
      // A list we did not get at all is unknown, not "no blockers": the one unsatisfied
      // blocker may be exactly the relation we are missing.
      if (!node.inverseRelations) continue;
      relationsById.set(node.id, [...(node.inverseRelations.nodes ?? [])]);
      const next = nextRelationCursor(node.inverseRelations, null);
      if (next === INCOMPLETE) relationsById.delete(node.id);
      else if (next) paging.push({ id: node.id, after: next });
    }

    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
    after = data.issues.pageInfo.endCursor;
  }

  // One request per round, however many issues are still paging.
  while (paging.length > 0) {
    const pages = await fetchInverseRelationRound(paging, remaining);
    const nextRound: PendingRelationPage[] = [];
    for (const pending of paging) {
      const page = pages.get(pending.id);
      const relations = relationsById.get(pending.id);
      // Linear stopped returning the issue mid-walk: we saw part of the list and the blocker
      // that matters may be in the part we did not.
      if (!page || !relations) {
        relationsById.delete(pending.id);
        continue;
      }
      relations.push(...(page.nodes ?? []));
      const next = nextRelationCursor(page, pending.after);
      if (next === INCOMPLETE) relationsById.delete(pending.id);
      else if (next) nextRound.push({ id: pending.id, after: next });
    }
    paging = nextRound;
  }

  for (const [id, relations] of relationsById) {
    out.set(id, relations.filter((r) => r.type === "blocks").map(relationToBlocker));
  }
  return out;
}

interface PendingRelationPage {
  id: string;
  after: string;
}

/** A relation list Linear will not let us finish — the id stays out of the result. */
const INCOMPLETE = Symbol("incomplete relation page");

/**
 * Where to continue a relation connection: `null` when the list is complete, a cursor when
 * there is more, `INCOMPLETE` when Linear claims more but hands back no usable cursor (which
 * would otherwise loop forever).
 */
function nextRelationCursor(
  page: RelationPage,
  after: string | null
): string | null | typeof INCOMPLETE {
  if (!page.pageInfo?.hasNextPage) return null;
  const cursor = page.pageInfo.endCursor;
  if (!cursor || cursor === after) return INCOMPLETE;
  return cursor;
}

/**
 * Advance every still-paging issue by one nested page in a single request.
 *
 * Each issue needs its own cursor, which one `issues(filter:)` selection cannot express, so
 * the round is built as one aliased selection per issue. That keeps the cost of deep relation
 * lists at one request per *round* rather than one per entry — the acceptance criterion is
 * "no per-entry queries", and a queue of well-linked tickets is exactly where the naive
 * version multiplies. Issues Linear omits come back absent from the map.
 */
async function fetchInverseRelationRound(
  pending: PendingRelationPage[],
  remaining: () => number | undefined
): Promise<Map<string, RelationPage>> {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, unknown> = {};

  pending.forEach((entry, i) => {
    varDefs.push(`$ids${i}: [ID!], $after${i}: String`);
    selections.push(
      `r${i}: issues(filter: { id: { in: $ids${i} } }, first: 1, includeArchived: true) {
        nodes {
          id
          inverseRelations(first: ${PAGE_SIZE}, after: $after${i}) { ${RELATION_PAGE_FIELDS} }
        }
      }`
    );
    variables[`ids${i}`] = [entry.id];
    variables[`after${i}`] = entry.after;
  });

  const data = (await linearQuery(
    "fetchLinearBlockersPage",
    `query BlockingRelationsPage(${varDefs.join(", ")}) {\n${selections.join("\n")}\n}`,
    variables,
    { timeoutMs: remaining() }
  )) as Record<string, { nodes?: Array<{ id: string; inverseRelations?: RelationPage }> } | null>;

  const out = new Map<string, RelationPage>();
  pending.forEach((entry, i) => {
    const page = data[`r${i}`]?.nodes?.find((n) => n.id === entry.id)?.inverseRelations;
    if (page) out.set(entry.id, page);
  });
  return out;
}

/** Resolve free-form kick text to a Linear candidate (or null if not found / unparseable). */
export async function lookupLinearIssue(raw: string): Promise<LinearCandidate | null> {
  const id = parseLinearIssueRef(raw);
  if (!id) return null;
  return getLinearIssue(id);
}
