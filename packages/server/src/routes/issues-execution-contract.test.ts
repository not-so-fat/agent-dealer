// NOT-306: Linear/Planner tickets compile into frozen execution contracts.
// Web, API, and CLI creation all funnel through POST /api/issues, so these
// route tests cover each intake path with its equivalent request shape while
// the shared compiler owns the parsing (no page-local regex anywhere).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-contract-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { getIssue } = await import("../repository/issues.js");
const { claimWorkItem } = await import("../repository/work-items.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { applyCompletion, resolveHumanActionAndAdvance, getTaskSnapshot } = await import("../coordinator/commands.js");
const { ReviewerResult } = await import("../coordinator/reviewer-result.js");
const { setAdmissionHealthCheckerForTests } = await import("../coordinator/admission.js");

before(() => {
  migrate();
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
});

after(() => setAdmissionHealthCheckerForTests(null));

beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  return app;
}

/** Planner-authored Linear ticket carrying every contract-v1 heading. */
const CONTRACT_DESCRIPTION = [
  "Compile the Planner ticket into a frozen execution contract.",
  "",
  "## Builder execution mode",
  "feature",
  "",
  "## Non-goals",
  "- Selecting a playbook or reasoning about implementation architecture",
  "- Adding a generic workflow/schema editor",
  "",
  "## Exit predicate",
  "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract.",
  "",
  "## One-PR stopping point",
  "Stop after the contract compiles, freezes, and renders in both worker prompts.",
  "",
  "## Acceptance criteria",
  "- [ ] Full ticket imports into the exact structured schema",
  "  Evidence: shared compiler fixtures | run the compiler test | every field asserted",
  "- [ ] Legacy issues without headings still start",
  "  Evidence: legacy suite | run the legacy tests | green",
  "",
].join("\n");

const EXPECTED_CONTRACT = {
  version: "v1",
  executionMode: "feature",
  nonGoals: [
    "Selecting a playbook or reasoning about implementation architecture",
    "Adding a generic workflow/schema editor",
  ],
  exitPredicate: "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract.",
  onePrStoppingPoint: "Stop after the contract compiles, freezes, and renders in both worker prompts.",
  acceptanceCriteria: [
    {
      text: "Full ticket imports into the exact structured schema",
      evidence: "shared compiler fixtures | run the compiler test | every field asserted",
    },
    {
      text: "Legacy issues without headings still start",
      evidence: "legacy suite | run the legacy tests | green",
    },
  ],
};

const BASE_AGENTS = {
  repo: "acme/app",
  baseBranch: "main",
  developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
  reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
};

test("web/API/CLI-shaped creates compile the same contract and keep the source untouched", async () => {
  const app = await buildApp();
  // Web Linear import: full ticket description, no separate criteria field —
  // the server derives it with the shared compiler.
  const webShaped = {
    title: "NOT-306: frozen execution contracts",
    description: CONTRACT_DESCRIPTION,
    source: "linear",
    externalId: "linear-uuid-web",
    externalLabel: "NOT-306",
    externalUrl: "https://linear.app/not-so-fat/issue/NOT-306/x",
    ...BASE_AGENTS,
  };
  // API direct create: same description plus an explicit override stays explicit.
  const apiShaped = {
    title: "Contract via API",
    description: CONTRACT_DESCRIPTION,
    acceptanceCriteria: "Operator-typed override",
    ...BASE_AGENTS,
  };
  // CLI agent create: source agent, description carried through.
  const cliShaped = {
    title: "Contract via CLI",
    description: CONTRACT_DESCRIPTION,
    source: "agent",
    ...BASE_AGENTS,
  };
  for (const [name, payload] of [["web", webShaped], ["api", apiShaped], ["cli", cliShaped]] as const) {
    const res = await app.inject({ method: "POST", url: "/api/issues", payload });
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    const created = res.json() as { id: string; description: string; acceptanceCriteria: string; executionContract: unknown };
    assert.deepStrictEqual(created.executionContract, EXPECTED_CONTRACT, name);
    assert.equal(created.description, CONTRACT_DESCRIPTION, `${name}: source Markdown stored unchanged`);
    const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
      issue: { executionContract: unknown; description: string; acceptanceCriteria: string };
    };
    assert.deepStrictEqual(detail.issue.executionContract, EXPECTED_CONTRACT, `${name} detail`);
    assert.equal(detail.issue.description, CONTRACT_DESCRIPTION, `${name} detail source unchanged`);
  }
  // The override wins; the derived rendering fills only when nothing was given.
  const apiCreated = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { ...apiShaped, title: "again" } })
  ).json() as { acceptanceCriteria: string };
  assert.equal(apiCreated.acceptanceCriteria, "Operator-typed override");
  const webCreated = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { ...webShaped, title: "again", externalId: "linear-uuid-web-2" } })
  ).json() as { acceptanceCriteria: string };
  assert.ok(webCreated.acceptanceCriteria.includes("- [ ] Full ticket imports into the exact structured schema"));
  assert.ok(webCreated.acceptanceCriteria.includes("Evidence: shared compiler fixtures"));
  await app.close();
});

test("a contract ticket starts — readiness is satisfied by the derived criteria", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Startable contract", description: CONTRACT_DESCRIPTION, ...BASE_AGENTS },
    })
  ).json() as { id: string };
  const startRes = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(startRes.statusCode, 200, startRes.body);
  // Starting freezes the compiled contract alongside the source description.
  const frozen = getTaskSnapshot(getIssue(created.id)!);
  assert.deepStrictEqual(frozen.executionContract, EXPECTED_CONTRACT);
  assert.equal(frozen.description, CONTRACT_DESCRIPTION);
  await app.close();
});

test("legacy issues with no contract headings keep current behavior and stay startable", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Legacy", description: "Just a plain description.", acceptanceCriteria: "It works", ...BASE_AGENTS },
    })
  ).json() as { id: string; executionContract: null };
  assert.equal(created.executionContract, null);
  const startRes = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(startRes.statusCode, 200, startRes.body);
  const frozen = getTaskSnapshot(getIssue(created.id)!);
  assert.equal(frozen.executionContract, null);
  await app.close();
});

test("an Acceptance-criteria-only ticket keeps the legacy extraction and stays startable", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "AC-only legacy",
        description: "Ship it.\n\n## Acceptance criteria\nIt works and it ships.",
        ...BASE_AGENTS,
      },
    })
  ).json() as { executionContract: null; acceptanceCriteria: string; id: string };
  assert.equal(created.executionContract, null);
  assert.equal(created.acceptanceCriteria, "It works and it ships.");
  const startRes = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(startRes.statusCode, 200, startRes.body);
  await app.close();
});

const INVALID_DESCRIPTIONS: Array<{ name: string; description: string; match: RegExp }> = [
  {
    name: "unknown execution mode",
    description: CONTRACT_DESCRIPTION.replace("feature", "teleport"),
    match: /unknown execution mode/,
  },
  {
    name: "empty exit predicate",
    description: CONTRACT_DESCRIPTION.replace(
      "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract.",
      ""
    ),
    match: /Exit predicate/,
  },
  {
    name: "duplicate criterion",
    description: CONTRACT_DESCRIPTION.replace(
      "- [ ] Legacy issues without headings still start",
      "- [ ] Full ticket imports into the exact structured schema"
    ),
    match: /duplicate criterion/i,
  },
  {
    name: "empty Evidence line",
    description: CONTRACT_DESCRIPTION.replace(
      "  Evidence: legacy suite | run the legacy tests | green",
      "  Evidence:"
    ),
    match: /Evidence/,
  },
  {
    name: "duplicate heading",
    description: `${CONTRACT_DESCRIPTION}\n## Non-goals\n- one more\n`,
    match: /duplicate.*Non-goals/i,
  },
  {
    name: "missing section once a signal is present",
    description: "## Builder execution mode\nfeature\n\n## Acceptance criteria\n- [ ] Done\n",
    match: /missing.*Non-goals/i,
  },
];

for (const { name, description, match } of INVALID_DESCRIPTIONS) {
  test(`POST rejects an invalid contract with an actionable error: ${name}`, async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Bad contract", description, ...BASE_AGENTS },
    });
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
    assert.match((res.json() as { error: string }).error, match, name);
    await app.close();
  });
}

test("PATCH validates an edited description and backfills missing criteria", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Editable", description: "plain", ...BASE_AGENTS },
    })
  ).json() as { id: string };
  // A contract-breaking edit is a 400, not a silent half-parse.
  const bad = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { description: CONTRACT_DESCRIPTION.replace("feature", "teleport") },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match((bad.json() as { error: string }).error, /unknown execution mode/);
  // Adding the contract fills the missing criteria from the ticket.
  const good = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { description: CONTRACT_DESCRIPTION },
  });
  assert.equal(good.statusCode, 200, good.body);
  const patched = good.json() as { description: string; acceptanceCriteria: string; executionContract: unknown };
  assert.equal(patched.description, CONTRACT_DESCRIPTION);
  assert.deepStrictEqual(patched.executionContract, EXPECTED_CONTRACT);
  assert.ok(patched.acceptanceCriteria.includes("- [ ] Full ticket imports into the exact structured schema"));
  await app.close();
});

test("an active workflow keeps its frozen contract — later edits are refused", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Frozen", description: CONTRACT_DESCRIPTION, ...BASE_AGENTS },
    })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` })).statusCode, 200);
  const before = getTaskSnapshot(getIssue(created.id)!);
  assert.deepStrictEqual(before.executionContract, EXPECTED_CONTRACT);
  const refused = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { description: CONTRACT_DESCRIPTION.replace("feature", "refactor") },
  });
  assert.equal(refused.statusCode, 409);
  const after = getTaskSnapshot(getIssue(created.id)!);
  assert.deepStrictEqual(after, before);
  await app.close();
});

// NOT-363: source-reload fixtures — a ready Linear-sourced issue pulls the
// latest ticket text through POST /api/issues/:id/reload-source.
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { queueStatusForIssue } = await import("../coordinator/admission.js");
const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");

/** Refreshed Linear description: new exit predicate, wholly new criteria. */
const RELOADED_DESCRIPTION = [
  "The Planner improved the ticket after import.",
  "",
  "## Builder execution mode",
  "feature",
  "",
  "## Non-goals",
  "- Selecting a playbook or reasoning about implementation architecture",
  "- Adding a generic workflow/schema editor",
  "",
  "## Exit predicate",
  "Reloading a Linear-sourced issue pulls the latest ticket text and recompiles the contract.",
  "",
  "## One-PR stopping point",
  "Stop after the refreshed contract freezes and renders.",
  "",
  "## Acceptance criteria",
  "- [ ] Reloaded ticket compiles into the refreshed structured schema",
  "  Evidence: reload fixtures | run the reload tests | every field asserted",
  "- [ ] Old local criteria do not survive a source reload",
  "  Evidence: reload suite | run the reload tests | green",
  "",
].join("\n");

const EXPECTED_RELOADED_CONTRACT = {
  version: "v1",
  executionMode: "feature",
  nonGoals: [
    "Selecting a playbook or reasoning about implementation architecture",
    "Adding a generic workflow/schema editor",
  ],
  exitPredicate: "Reloading a Linear-sourced issue pulls the latest ticket text and recompiles the contract.",
  onePrStoppingPoint: "Stop after the refreshed contract freezes and renders.",
  acceptanceCriteria: [
    {
      text: "Reloaded ticket compiles into the refreshed structured schema",
      evidence: "reload fixtures | run the reload tests | every field asserted",
    },
    {
      text: "Old local criteria do not survive a source reload",
      evidence: "reload suite | run the reload tests | green",
    },
  ],
};

function linearNodeForTest(description: string | null) {
  return {
    id: "linear-uuid-1",
    identifier: "NOT-123",
    title: "Refreshed title from Linear",
    description,
    url: "https://linear.app/not-so-fat/issue/NOT-123/refreshed",
    state: { name: "Todo" },
    team: { id: "team-1" },
    labels: { nodes: [] },
  };
}

const realFetch = globalThis.fetch;
let linearIssueNodeForTest: unknown = null;
let linearHttpFailsForTest = false;

before(() => {
  process.env.LINEAR_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    if (linearHttpFailsForTest) {
      return { ok: false, status: 500, headers: new Headers(), text: async () => "boom" };
    }
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
      query?: string;
      variables?: { id?: string; ids?: string[] };
    };
    // Single-issue fetch (getLinearIssue) answers the reload; relation walks
    // (fetchLinearBlockers, from queue wait-reason classification) answer no
    // blockers so positions stay comparable.
    const payload =
      typeof body.variables?.id === "string"
        ? { data: { issue: linearIssueNodeForTest } }
        : { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(payload),
    };
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.LINEAR_API_KEY;
});

function resetLinearMock(node: unknown, httpFails = false) {
  linearIssueNodeForTest = node;
  linearHttpFailsForTest = httpFails;
}

const LINEAR_ISSUE_PAYLOAD = {
  title: "NOT-123: stale imported title",
  description: CONTRACT_DESCRIPTION,
  // A Dealer-local clarification that a reload must wipe: the refreshed
  // description's derived criteria replace it, they never merge with it.
  acceptanceCriteria: "Operator-typed override",
  source: "linear",
  externalId: "linear-uuid-1",
  externalLabel: "NOT-123",
  externalUrl: "https://linear.app/not-so-fat/issue/NOT-123/stale",
  ...BASE_AGENTS,
};

async function createLinearIssue(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: "POST", url: "/api/issues", payload: LINEAR_ISSUE_PAYLOAD });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: string };
}

test("NOT-185 + NOT-306: a parked re-freeze updates source and compiled contract atomically", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Parked contract",
        description: CONTRACT_DESCRIPTION,
        ...BASE_AGENTS,
        maxReviewRounds: 1,
      },
    })
  ).json() as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` })).statusCode, 200);

  const complete = async (outcome: Parameters<typeof applyCompletion>[2]) => {
    const item = claimWorkItem("route-test", { leaseMs: 60_000 })!;
    await applyCompletion(item.id, item.leaseToken!, outcome);
  };
  const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload });

  await complete({ kind: "clean_handoff", branch: "b", headSha: "abc", baseSha: "base", prNumber: 1, prUrl: "https://gh/pr/1" });
  await complete({
    kind: "verdict",
    result: ReviewerResult.parse({
      verdict: "changes_requested",
      baseSha: "b",
      headSha: "h",
      acceptanceCriteriaAssessment: "ok",
      evidenceAssessment: "ok",
      findings: [],
      risks: [],
    }),
  });

  // Re-scope the ticket at the park: new exit predicate, one criterion dropped.
  const rescoped = CONTRACT_DESCRIPTION.replace(
    "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract.",
    "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract, rescoped."
  ).replace("- [ ] Legacy issues without headings still start\n  Evidence: legacy suite | run the legacy tests | green\n", "");
  const parked = await patch({ description: rescoped });
  assert.equal(parked.statusCode, 200, parked.body);

  const action = listHumanActionsForIssue(created.id).find((a) => a.actionType === "attempts_exhausted")!;
  assert.equal(resolveHumanActionAndAdvance(action.id, "operator", "retry").ok, true);
  // Source and compiled contract re-froze together — never one without the other.
  const frozen = getTaskSnapshot(getIssue(created.id)!);
  assert.equal(frozen.description, rescoped);
  assert.equal(frozen.executionContract?.exitPredicate,
    "Importing a Planner-authored Linear ticket yields a versioned frozen execution contract, rescoped.");
  assert.equal(frozen.executionContract?.acceptanceCriteria.length, 1);
  assert.deepStrictEqual(getIssue(created.id)!.executionContract, frozen.executionContract);
  await app.close();
});

test("NOT-363: reload-source pulls the latest Linear text and recompiles the contract", async () => {
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const app = await buildApp();
  const { id } = await createLinearIssue(app);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 200, res.body);
  const reloaded = res.json() as {
    title: string;
    description: string;
    acceptanceCriteria: string;
    executionContract: unknown;
    externalId: string;
    externalLabel: string;
  };
  // Same title convention as import (`<identifier>: <title>`).
  assert.equal(reloaded.title, "NOT-123: Refreshed title from Linear");
  assert.equal(reloaded.description, RELOADED_DESCRIPTION);
  assert.deepStrictEqual(reloaded.executionContract, EXPECTED_RELOADED_CONTRACT);
  // The derived criteria replace the old local override — never merge with it.
  assert.ok(reloaded.acceptanceCriteria.includes("- [ ] Reloaded ticket compiles into the refreshed structured schema"));
  assert.ok(!reloaded.acceptanceCriteria.includes("Operator-typed override"));
  assert.equal(reloaded.externalId, "linear-uuid-1");
  assert.equal(reloaded.externalLabel, "NOT-123");

  // One `issue.source_reloaded` event naming Linear with digests, never the text.
  const reloadEvents = listWorkflowEventsForIssue(id).filter((e) => e.type === "issue.source_reloaded");
  assert.equal(reloadEvents.length, 1);
  const payload = JSON.parse(reloadEvents[0]!.payloadJson!) as Record<string, unknown>;
  assert.equal(payload.source, "linear");
  assert.equal(payload.externalId, "linear-uuid-1");
  assert.equal(payload.externalLabel, "NOT-123");
  for (const key of ["prevTitleDigest", "newTitleDigest", "prevDescriptionDigest", "newDescriptionDigest"]) {
    assert.match(String(payload[key]), /^[0-9a-f]{16}$/, key);
  }
  assert.notEqual(payload.prevTitleDigest, payload.newTitleDigest);
  assert.notEqual(payload.prevDescriptionDigest, payload.newDescriptionDigest);
  assert.ok(!reloadEvents[0]!.payloadJson!.includes("Refreshed title from Linear"));
  assert.ok(!reloadEvents[0]!.payloadJson!.includes("The Planner improved the ticket"));
  await app.close();
});

test("NOT-363: reload preserves configuration and the exact queue position", async () => {
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const app = await buildApp();
  const first = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        ...LINEAR_ISSUE_PAYLOAD,
        baseBranch: "develop",
        maxReviewRounds: 5,
        maxInfraAttempts: 1,
        autoMerge: true,
      },
    })
  ).json() as { id: string };
  const second = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Queue neighbor", description: "plain", ...BASE_AGENTS },
    })
  ).json() as { id: string };

  const before = getIssue(first.id)!;
  const positionOf = (issueId: string) => queueStatusForIssue(issueId)?.position ?? null;
  const beforePositions = [positionOf(first.id), positionOf(second.id)];

  const res = await app.inject({ method: "POST", url: `/api/issues/${first.id}/reload-source` });
  assert.equal(res.statusCode, 200, res.body);

  const after = getIssue(first.id)!;
  assert.equal(after.repo, before.repo);
  assert.equal(after.baseBranch, "develop");
  assert.equal(after.developerAgentId, before.developerAgentId);
  assert.equal(after.reviewerAgentId, before.reviewerAgentId);
  assert.equal(after.maxReviewRounds, 5);
  assert.equal(after.maxInfraAttempts, 1);
  assert.equal(after.autoMerge, true);
  assert.equal(after.source, "linear");
  assert.equal(after.externalId, before.externalId);
  assert.equal(after.externalLabel, before.externalLabel);
  assert.equal(after.externalUrl, before.externalUrl);
  assert.equal(after.status, "ready");
  assert.deepStrictEqual([positionOf(first.id), positionOf(second.id)], beforePositions);
  await app.close();
});

test("NOT-363: reload refuses a manual issue with 400 and writes nothing", async () => {
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Manual", description: "plain", acceptanceCriteria: "It works", ...BASE_AGENTS },
    })
  ).json() as { id: string };

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/reload-source` });
  assert.equal(res.statusCode, 400, res.body);
  const untouched = getIssue(created.id)!;
  assert.equal(untouched.title, "Manual");
  assert.equal(untouched.description, "plain");
  assert.equal(untouched.acceptanceCriteria, "It works");
  assert.ok(!listWorkflowEventsForIssue(created.id).some((e) => e.type === "issue.source_reloaded"));
  await app.close();
});

test("NOT-363: reload refuses after admission with 409 and writes nothing", async () => {
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const app = await buildApp();
  const { id } = await createLinearIssue(app);
  // Force-admit: POST /start only queues when no slot is free, so admit
  // through the coordinator core — status leaves `ready` and the workflow
  // instance goes active, which is what the reload must refuse on.
  const { startWorkflow } = await import("../coordinator/commands.js");
  assert.equal(startWorkflow(id).ok, true);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 409, res.body);
  const untouched = getIssue(id)!;
  assert.equal(untouched.title, LINEAR_ISSUE_PAYLOAD.title);
  assert.equal(untouched.description, CONTRACT_DESCRIPTION);
  assert.equal(untouched.acceptanceCriteria, LINEAR_ISSUE_PAYLOAD.acceptanceCriteria);
  assert.ok(!listWorkflowEventsForIssue(id).some((e) => e.type === "issue.source_reloaded"));
  await app.close();
});

test("NOT-363: reload refuses while a worker session runs with 409 and writes nothing", async () => {
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const app = await buildApp();
  const { id } = await createLinearIssue(app);
  const session = createWorkerSession({
    issueId: id,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code",
  });
  startSession(session.id);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 409, res.body);
  assert.match((res.json() as { error: string }).error, /running session/);
  const untouched = getIssue(id)!;
  assert.equal(untouched.title, LINEAR_ISSUE_PAYLOAD.title);
  assert.equal(untouched.description, CONTRACT_DESCRIPTION);
  assert.ok(!listWorkflowEventsForIssue(id).some((e) => e.type === "issue.source_reloaded"));
  await app.close();
});

test("NOT-363: a Linear fetch failure leaves task fields and queue state unchanged", async () => {
  resetLinearMock(null, true);
  const app = await buildApp();
  const { id } = await createLinearIssue(app);
  const positionBefore = queueStatusForIssue(id);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 502, res.body);
  const untouched = getIssue(id)!;
  assert.equal(untouched.title, LINEAR_ISSUE_PAYLOAD.title);
  assert.equal(untouched.description, CONTRACT_DESCRIPTION);
  assert.equal(untouched.acceptanceCriteria, LINEAR_ISSUE_PAYLOAD.acceptanceCriteria);
  assert.equal(queueStatusForIssue(id)?.position, positionBefore?.position);
  assert.ok(!listWorkflowEventsForIssue(id).some((e) => e.type === "issue.source_reloaded"));
  await app.close();
});

test("NOT-363: a contract-validation failure on refreshed text leaves everything unchanged", async () => {
  resetLinearMock(linearNodeForTest(CONTRACT_DESCRIPTION.replace("feature", "teleport")));
  const app = await buildApp();
  const { id } = await createLinearIssue(app);
  const positionBefore = queueStatusForIssue(id);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 400, res.body);
  assert.match((res.json() as { error: string }).error, /unknown execution mode/);
  const untouched = getIssue(id)!;
  assert.equal(untouched.title, LINEAR_ISSUE_PAYLOAD.title);
  assert.equal(untouched.description, CONTRACT_DESCRIPTION);
  assert.equal(untouched.acceptanceCriteria, LINEAR_ISSUE_PAYLOAD.acceptanceCriteria);
  assert.equal(queueStatusForIssue(id)?.position, positionBefore?.position);
  assert.ok(!listWorkflowEventsForIssue(id).some((e) => e.type === "issue.source_reloaded"));
  await app.close();
});

test("NOT-363: the frozen snapshot after reload contains exactly the refreshed text", async () => {
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const app = await buildApp();
  const { startWorkflow } = await import("../coordinator/commands.js");
  const { id } = await createLinearIssue(app);
  assert.equal((await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` })).statusCode, 200);
  assert.equal(startWorkflow(id).ok, true);

  const frozen = getTaskSnapshot(getIssue(id)!);
  assert.equal(frozen.description, RELOADED_DESCRIPTION);
  assert.ok(frozen.acceptanceCriteria.includes("- [ ] Reloaded ticket compiles into the refreshed structured schema"));
  assert.ok(!frozen.acceptanceCriteria.includes("Operator-typed override"));
  assert.deepStrictEqual(frozen.executionContract, EXPECTED_RELOADED_CONTRACT);

  // And the local-edit path freezes exactly what was saved, too.
  resetLinearMock(linearNodeForTest(RELOADED_DESCRIPTION));
  const edited = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "Local edit path", description: "plain", acceptanceCriteria: "saved locally", ...BASE_AGENTS },
    })
  ).json() as { id: string };
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/api/issues/${edited.id}`, payload: { description: RELOADED_DESCRIPTION } }))
      .statusCode,
    200
  );
  assert.equal(startWorkflow(edited.id).ok, true);
  const frozenEdited = getTaskSnapshot(getIssue(edited.id)!);
  assert.equal(frozenEdited.description, RELOADED_DESCRIPTION);
  assert.deepStrictEqual(frozenEdited.executionContract, EXPECTED_RELOADED_CONTRACT);
  await app.close();
});
