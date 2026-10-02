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
