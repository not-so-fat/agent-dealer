// packages/server/src/coordinator/dependency-readiness.integration.test.ts
//
// NOT-104 acceptance, at the admission boundary: a Linear-sourced issue whose *declared*
// blockers are unsatisfied parks with a reason instead of burning a develop/review cycle on
// a base that is missing its upstream work.
//
// Everything here is network-free — the blockers provider is injected, and the one adapter
// case (which Linear relations count) stubs `fetch` rather than calling Linear.

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlockerState } from "./dependencies.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not104-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
const { enqueueIssue, getQueuedEntryForIssue, listQueuedEntries } = await import(
  "../repository/queue-entries.js"
);
const { fetchLinearBlockers } = await import("../adapters/linear-inbox.js");
const {
  admitNext,
  setAdmissionHealthCheckerForTests,
  setCapacityPolicyForTests,
  resetCapacityPolicyForTests,
  resetEligibilityRulesForTests,
} = await import("./admission.js");
const {
  blockersFor,
  clearBlockerCacheForTests,
  resetDependenciesForTests,
  setBlockerCacheTtlForTests,
  setBlockerFailureBackoffForTests,
  setBlockerFetchTimeoutForTests,
  setBlockersProviderForTests,
  setLinearBlockerFetcherForTests,
} = await import("./dependencies.js");

before(() => migrate());

/** Full wipe, in FK order — an admitted issue leaves work items and events behind. */
function resetTables() {
  getDb().exec(`
    DELETE FROM review_publications;
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
}

beforeEach(() => {
  resetTables();
  // Admission otherwise probes the real Claude/Cursor/gh CLIs per queued entry.
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
  resetDependenciesForTests();
});

afterEach(() => {
  setAdmissionHealthCheckerForTests(null);
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
  resetDependenciesForTests();
});

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not104-repo-"));
let seq = 0;

function seedIssue(opts: { source: "manual" | "linear"; externalId?: string; title?: string }) {
  const suffix = `${seq++}-${Math.random().toString(36).slice(2, 8)}`;
  const dev = createAgent({ name: `n104-dev-${suffix}`, runtime: "claude_code", workspaceRoot: repo });
  const rev = createAgent({ name: `n104-rev-${suffix}`, runtime: "claude_code", workspaceRoot: repo });
  return createIssue({
    title: opts.title ?? `Issue ${suffix}`,
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts: 2,
    source: opts.source,
    ...(opts.externalId ? { externalId: opts.externalId, externalLabel: opts.externalId } : {}),
  });
}

function blocker(over: Partial<BlockerState> & { identifier: string }): BlockerState {
  return {
    id: over.id ?? "",
    identifier: over.identifier,
    stateName: over.stateName ?? "In Progress",
    stateType: over.stateType ?? "started",
  };
}

/** Provider stub: declared blockers per Linear issue id, everything else reported as clean. */
function provideBlockers(byExternalId: Record<string, BlockerState[]>) {
  setBlockersProviderForTests(
    async (issues) => new Map(issues.map((i) => [i.externalId!, byExternalId[i.externalId!] ?? []]))
  );
}

function waitReason(issueId: string): string | null {
  return getQueuedEntryForIssue(issueId)?.waitReason ?? null;
}

test("unsatisfied declared blocker: entry is not admitted and names the blocker and its state", async () => {
  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  enqueueIssue(issue.id);
  provideBlockers({ "lin-a": [blocker({ identifier: "NOT-123", stateName: "In Progress" })] });

  assert.equal(await admitNext(), null);
  assert.equal(getIssue(issue.id)!.status, "ready");
  assert.equal(getActiveWorkflowInstance(issue.id), null);
  const entry = getQueuedEntryForIssue(issue.id);
  assert.equal(entry?.state, "queued", "blocked means parked, never dequeued");
  assert.equal(entry?.waitReason, "waiting on NOT-123 (In Progress)");
});

test("satisfaction (decision 2): unlinked blocker needs completed/canceled; dealer-linked needs dealer done", async () => {
  // Unlinked: `started` blocks, `completed` and `canceled` do not.
  for (const [stateType, stateName, admitted] of [
    ["started", "In Progress", false],
    ["backlog", "Backlog", false],
    ["completed", "Done", true],
    ["canceled", "Canceled", true],
  ] as const) {
    resetTables();
    const issue = seedIssue({ source: "linear", externalId: "lin-u" });
    enqueueIssue(issue.id);
    provideBlockers({ "lin-u": [blocker({ identifier: "NOT-9", stateName, stateType })] });
    const result = await admitNext();
    assert.equal(
      result?.issueId === issue.id,
      admitted,
      `unlinked blocker in ${stateType} should ${admitted ? "" : "not "}admit`
    );
  }

  // Dealer-linked: Linear "Done" is not enough — issues get marked Done at PR-approval time,
  // before the code lands. Only dealer `done` (the PR actually merged) releases it.
  resetTables();
  const upstream = seedIssue({ source: "linear", externalId: "lin-up" });
  const dependent = seedIssue({ source: "linear", externalId: "lin-dep" });
  enqueueIssue(dependent.id);
  provideBlockers({
    "lin-dep": [blocker({ id: "lin-up", identifier: "NOT-UP", stateName: "Done", stateType: "completed" })],
  });

  assert.equal(await admitNext(), null, "Linear says Done but the dealer issue has not merged");
  assert.equal(waitReason(dependent.id), "waiting on NOT-UP (ready)");

  getDb().prepare("UPDATE issues SET status = 'done' WHERE id = ?").run(upstream.id);
  assert.equal((await admitNext())?.issueId, dependent.id);

  // Nor does Linear `canceled` release a dealer-linked blocker: the dealer issue is still
  // unmerged, so the dependent would branch from a base without it. Dealer status is the
  // only authority once the blocker is in dealer — even after it is closed there.
  resetTables();
  const abandoned = seedIssue({ source: "linear", externalId: "lin-ab" });
  const downstream = seedIssue({ source: "linear", externalId: "lin-down" });
  enqueueIssue(downstream.id);
  provideBlockers({
    "lin-down": [
      blocker({ id: "lin-ab", identifier: "NOT-AB", stateName: "Canceled", stateType: "canceled" }),
    ],
  });

  assert.equal(await admitNext(), null, "canceled in Linear, still developing in dealer");
  assert.equal(waitReason(downstream.id), "waiting on NOT-AB (ready)");

  getDb().prepare("UPDATE issues SET status = 'closed' WHERE id = ?").run(abandoned.id);
  assert.equal(await admitNext(), null, "dealer `closed` is not `done` either");
  assert.equal(waitReason(downstream.id), "waiting on NOT-AB (closed)");
});

test("blocker merges: the entry is admitted on the next tick, with no unblock event and across a restart", async () => {
  const upstream = seedIssue({ source: "linear", externalId: "lin-up" });
  const dependent = seedIssue({ source: "linear", externalId: "lin-dep" });
  enqueueIssue(dependent.id);
  provideBlockers({
    "lin-dep": [
      blocker({ id: "lin-up", identifier: "NOT-UP", stateName: "In Progress", stateType: "started" }),
    ],
  });

  assert.equal(await admitNext(), null);
  assert.equal(await admitNext(), null, "still blocked on a later tick — level-triggered, not edge");
  assert.equal(getQueuedEntryForIssue(dependent.id)?.state, "queued");

  // The PR lands. Nothing notifies admission; the next tick simply re-reads the world, which
  // is also what a freshly restarted server does.
  getDb().prepare("UPDATE issues SET status = 'done' WHERE id = ?").run(upstream.id);

  const admittedAt = await admitNext();
  assert.equal(admittedAt?.issueId, dependent.id);
  assert.equal(getIssue(dependent.id)!.status, "developing");
  assert.equal(getQueuedEntryForIssue(dependent.id), null);
});

test("skip-ahead: a blocked head entry is skipped and a later eligible entry is admitted in the same tick", async () => {
  const blocked = seedIssue({ source: "linear", externalId: "lin-head", title: "Blocked head" });
  const free = seedIssue({ source: "linear", externalId: "lin-tail", title: "Eligible tail" });
  enqueueIssue(blocked.id);
  enqueueIssue(free.id);
  provideBlockers({ "lin-head": [blocker({ identifier: "NOT-7", stateName: "Todo", stateType: "unstarted" })] });

  const result = await admitNext();
  assert.equal(result?.issueId, free.id);
  assert.equal(getIssue(blocked.id)!.status, "ready");
  assert.equal(waitReason(blocked.id), "waiting on NOT-7 (Todo)");
});

test("manual issues are never blocked by this rule, including while Linear is unreachable", async () => {
  const manual = seedIssue({ source: "manual" });
  enqueueIssue(manual.id);
  // A provider that would blow up if it were ever consulted for a manual issue.
  setBlockersProviderForTests(async () => {
    throw new Error("Linear 503");
  });

  assert.equal((await admitNext())?.issueId, manual.id);
  assert.equal(getIssue(manual.id)!.status, "developing");
});

test("fetch failure: Linear-sourced parks with `dependency state unavailable` while manual is admitted, and resumes with no operator action", async () => {
  const linear = seedIssue({ source: "linear", externalId: "lin-a", title: "Linear head" });
  const manual = seedIssue({ source: "manual", title: "Manual tail" });
  enqueueIssue(linear.id);
  enqueueIssue(manual.id);
  setBlockersProviderForTests(async () => {
    throw new Error("Linear HTTP 503");
  });

  assert.equal((await admitNext())?.issueId, manual.id, "a Linear outage must not pause manual work");
  const parked = getQueuedEntryForIssue(linear.id);
  assert.equal(parked?.state, "queued", "parked, never dequeued/failed/canceled");
  assert.equal(parked?.waitReason, "dependency state unavailable");
  assert.equal(getIssue(linear.id)!.status, "ready");

  // Linear comes back. No operator action, no re-enqueue — the next tick admits it.
  getDb().prepare("UPDATE issues SET status = 'done' WHERE id = ?").run(manual.id);
  provideBlockers({});
  assert.equal((await admitNext())?.issueId, linear.id);
});

test("cycle: two issues blocking each other both park, each naming the other", async () => {
  const a = seedIssue({ source: "linear", externalId: "lin-a", title: "A" });
  const b = seedIssue({ source: "linear", externalId: "lin-b", title: "B" });
  enqueueIssue(a.id);
  enqueueIssue(b.id);
  provideBlockers({
    "lin-a": [blocker({ id: "lin-b", identifier: "NOT-B", stateName: "Todo", stateType: "unstarted" })],
    "lin-b": [blocker({ id: "lin-a", identifier: "NOT-A", stateName: "Todo", stateType: "unstarted" })],
  });

  assert.equal(await admitNext(), null, "a cycle stalls the pair — it never produces a wrong run");
  assert.equal(waitReason(a.id), "waiting on NOT-B (ready)");
  assert.equal(waitReason(b.id), "waiting on NOT-A (ready)");
  assert.deepEqual(
    listQueuedEntries().map((e) => e.issueId),
    [a.id, b.id]
  );
});

test("a hanging Linear API cannot stall the coordinator tick", async () => {
  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  enqueueIssue(issue.id);
  setBlockerFetchTimeoutForTests(50);
  setBlockersProviderForTests(() => new Promise<never>(() => {}));

  const startedAt = Date.now();
  assert.equal(await admitNext(), null);
  assert.ok(Date.now() - startedAt < 2_000, "admitNext must return on the timeout, not on the fetch");
  assert.equal(waitReason(issue.id), "dependency state unavailable");
  assert.equal(getQueuedEntryForIssue(issue.id)?.state, "queued");
});

test("one batched query per admitNext that finds a free slot, and none when capacity is full", async () => {
  const one = seedIssue({ source: "linear", externalId: "lin-1" });
  const two = seedIssue({ source: "linear", externalId: "lin-2" });
  const three = seedIssue({ source: "linear", externalId: "lin-3" });
  for (const i of [one, two, three]) enqueueIssue(i.id);

  const calls: string[][] = [];
  setLinearBlockerFetcherForTests(async (ids) => {
    calls.push([...ids].sort());
    return new Map(ids.map((id) => [id, [blocker({ identifier: `X-${id}` })]]));
  });

  await admitNext();
  assert.deepEqual(calls, [["lin-1", "lin-2", "lin-3"]], "one query covering every queued entry");

  // Capacity full → admitNext returns before building the context, so zero Linear traffic.
  clearBlockerCacheForTests();
  setCapacityPolicyForTests(() => 0);
  await admitNext();
  assert.equal(calls.length, 1, "a busy system makes no Linear calls");
});

test("the TTL cache is never served past its TTL when the refresh fails", async () => {
  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  let mode: "ok" | "fail" = "ok";
  let fetches = 0;
  setLinearBlockerFetcherForTests(async (ids) => {
    fetches++;
    if (mode === "fail") throw new Error("Linear HTTP 500");
    return new Map(ids.map((id) => [id, []]));
  });

  setBlockerCacheTtlForTests(60_000);
  assert.deepEqual([...(await blockersFor([issue]))], [["lin-a", []]]);
  assert.equal(fetches, 1);
  // Inside the TTL: served from cache, no second query.
  assert.deepEqual([...(await blockersFor([issue]))], [["lin-a", []]]);
  assert.equal(fetches, 1);

  // Past the TTL with a failing refresh: the expired list is *not* reused — a dependency
  // declared during the outage would otherwise be invisible for the whole outage.
  setBlockerCacheTtlForTests(0);
  mode = "fail";
  await assert.rejects(() => blockersFor([issue]), /Linear HTTP 500/);

  // ...and that surfaces at the admission boundary as a park, not as "no blockers".
  setLinearBlockerFetcherForTests(async () => {
    throw new Error("Linear HTTP 500");
  });
  enqueueIssue(issue.id);
  assert.equal(await admitNext(), null);
  assert.equal(waitReason(issue.id), "dependency state unavailable");
});

test("a failing Linear is asked once per backoff window, not once per tick", async () => {
  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  enqueueIssue(issue.id);
  let fetches = 0;
  setLinearBlockerFetcherForTests(async () => {
    fetches++;
    throw new Error("Linear HTTP 503");
  });

  for (let tick = 0; tick < 5; tick++) assert.equal(await admitNext(), null);
  assert.equal(fetches, 1, "an outage must not become one query per 3s tick");
  assert.equal(waitReason(issue.id), "dependency state unavailable");

  // The window is short, and nothing else has to happen: once it lapses the next tick asks
  // again and admits on the first success.
  setBlockerFailureBackoffForTests(0);
  assert.equal(await admitNext(), null, "one more failure to lapse the window");
  assert.equal(fetches, 2);
  setLinearBlockerFetcherForTests(async (ids) => new Map(ids.map((id) => [id, []])));
  assert.equal((await admitNext())?.issueId, issue.id);
});

test("overlapping ticks share one fetch: the second parks instead of opening a second call", async () => {
  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  let release: (v: Map<string, BlockerState[]>) => void = () => {};
  let fetches = 0;
  setLinearBlockerFetcherForTests(() => {
    fetches++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });

  const first = blockersFor([issue]);
  await assert.rejects(() => blockersFor([issue]), /already in flight/);
  release(new Map([["lin-a", []]]));
  assert.deepEqual([...(await first)], [["lin-a", []]]);
  assert.equal(fetches, 1);
});

type StubRequest = { query: string; variables: { ids: string[]; after: string | null } };

/**
 * Stub Linear's GraphQL endpoint for `fetchLinearBlockers`: one `issues.nodes` payload per
 * call, in order (the last one repeats). Returns the request bodies so a test can assert how
 * many queries were made and which cursor each carried.
 */
function stubLinearIssues(pages: unknown[][]): { requests: StubRequest[]; restore: () => void } {
  const requests: StubRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "lin_test";
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    requests.push(JSON.parse(init.body ?? "{}"));
    const nodes = pages[Math.min(requests.length - 1, pages.length - 1)] ?? [];
    return {
      ok: true,
      json: async () => ({ data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }),
    };
  }) as unknown as typeof globalThis.fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalKey;
    },
  };
}

/** `n` relations of one type, enough to fill a page — none of them a `blocks` edge. */
function noiseRelations(n: number, type: "related" | "duplicate"): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    type,
    issue: { id: `lin-noise-${i}`, identifier: `NOT-N${i}`, state: { name: "Todo", type: "unstarted" } },
  }));
}

test("only `blocks` relations from inverseRelations gate admission", async () => {
  const { requests, restore } = stubLinearIssues([
    [
      {
        id: "lin-a",
        inverseRelations: {
          nodes: [
            { type: "blocks", issue: { id: "lin-b", identifier: "NOT-B", state: { name: "In Progress", type: "started" } } },
            { type: "related", issue: { id: "lin-c", identifier: "NOT-C", state: { name: "Todo", type: "unstarted" } } },
            { type: "duplicate", issue: { id: "lin-d", identifier: "NOT-D", state: { name: "Todo", type: "unstarted" } } },
            // An unreadable blocker (other team / deleted) is still unsatisfied.
            { type: "blocks", issue: null },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
  ]);

  try {
    const blockers = await fetchLinearBlockers(["lin-a"]);
    assert.deepEqual(blockers.get("lin-a")?.map((b) => b.identifier), ["NOT-B", "an unreadable blocker"]);
    const body = requests[0]!;
    assert.match(body.query, /inverseRelations/);
    assert.doesNotMatch(body.query, /\n\s*relations\(/, "reading `relations` gates the wrong side");
    assert.deepEqual(body.variables.ids, ["lin-a"]);
  } finally {
    restore();
  }

  // The sub-issue hierarchy is never read at all, so an open parent epic cannot block its
  // own children: the only edge this rule knows about is the `blocks` relation above.
  const child = seedIssue({ source: "linear", externalId: "lin-child" });
  enqueueIssue(child.id);
  provideBlockers({ "lin-child": [] });
  assert.equal((await admitNext())?.issueId, child.id);
});

test("a relation list longer than one page is paged through, not treated as a failure", async () => {
  // `related` and `duplicate` share the connection with `blocks`, so a heavily cross-linked
  // ticket can push its real blocker onto a later page. Dropping the issue there would park
  // it forever — every tick would re-read the same first page.
  const { requests, restore } = stubLinearIssues([
    [
      {
        id: "lin-a",
        inverseRelations: {
          nodes: noiseRelations(50, "related"),
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    ],
    [
      {
        id: "lin-a",
        inverseRelations: {
          nodes: [
            ...noiseRelations(3, "duplicate"),
            { type: "blocks", issue: { id: "lin-b", identifier: "NOT-B", state: { name: "In Progress", type: "started" } } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
  ]);

  try {
    const blockers = await fetchLinearBlockers(["lin-a"]);
    assert.deepEqual(blockers.get("lin-a")?.map((b) => b.identifier), ["NOT-B"]);
    assert.equal(requests.length, 2, "the nested connection is paged, not re-read");
    assert.deepEqual(requests[1]?.variables, { ids: ["lin-a"], after: "cursor-1" });
  } finally {
    restore();
  }
});

test("relation volume alone never blocks: 51 non-`blocks` relations resolve to no blockers", async () => {
  const { restore } = stubLinearIssues([
    [
      {
        id: "lin-a",
        inverseRelations: {
          nodes: noiseRelations(50, "related"),
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    ],
    [
      {
        id: "lin-a",
        inverseRelations: {
          nodes: noiseRelations(1, "duplicate"),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
  ]);

  try {
    assert.deepEqual((await fetchLinearBlockers(["lin-a"])).get("lin-a"), []);
  } finally {
    restore();
  }

  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  enqueueIssue(issue.id);
  provideBlockers({ "lin-a": [] });
  assert.equal((await admitNext())?.issueId, issue.id);
});

test("a relation list Linear will not finish is unknown, not `no blockers`", async () => {
  // The follow-up page comes back without the issue: we saw part of the list, and the
  // blocker that matters may be in the part we did not. That is unknown → park for this
  // tick, and the next tick simply asks again.
  const { restore } = stubLinearIssues([
    [
      {
        id: "lin-a",
        inverseRelations: {
          nodes: [{ type: "related", issue: null }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    ],
    [],
  ]);

  try {
    assert.equal((await fetchLinearBlockers(["lin-a"])).has("lin-a"), false);
  } finally {
    restore();
  }

  const issue = seedIssue({ source: "linear", externalId: "lin-a" });
  enqueueIssue(issue.id);
  setLinearBlockerFetcherForTests(async () => new Map());
  assert.equal(await admitNext(), null);
  assert.equal(waitReason(issue.id), "dependency state unavailable");
});
