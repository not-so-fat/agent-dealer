// NOT-306: the compiled execution contract renders read-only on Issue Detail —
// mode, exit predicate, one-PR boundary, non-goals, and per-criterion evidence —
// with no inputs, so the ticket description stays the only authoring surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ExecutionContractV1, Issue } from "@agent-dealer/shared";
import type { IssueDetail as WebIssueDetail } from "../../api.js";
import ExecutionContractSummary from "./ExecutionContractSummary.js";
import IssueDetailBody from "./IssueDetailBody.js";

const CONTRACT: ExecutionContractV1 = {
  version: "v1",
  executionMode: "feature",
  nonGoals: ["Selecting a playbook", "Adding a schema editor"],
  exitPredicate: "Import yields a frozen contract visible in Dealer and both prompts.",
  onePrStoppingPoint: "Stop after the contract compiles, freezes, and renders.",
  acceptanceCriteria: [
    { text: "Full ticket imports into the exact schema", evidence: "fixtures | run compiler test | all fields asserted" },
    { text: "Legacy issues still start", evidence: null },
  ],
};

test("summary renders every contract field read-only", () => {
  const html = renderToStaticMarkup(<ExecutionContractSummary contract={CONTRACT} />);
  assert.match(html, /Execution contract/);
  assert.match(html, /v1/);
  assert.match(html, /feature/);
  assert.match(html, /Import yields a frozen contract/);
  assert.match(html, /Stop after the contract compiles/);
  assert.match(html, /Selecting a playbook/);
  assert.match(html, /Adding a schema editor/);
  assert.match(html, /Full ticket imports into the exact schema/);
  assert.match(html, /fixtures \| run compiler test \| all fields asserted/);
  assert.match(html, /Legacy issues still start/);
  assert.match(html, /Compiled from the ticket description/);
});

test("summary introduces no second technical form — zero inputs", () => {
  const html = renderToStaticMarkup(<ExecutionContractSummary contract={CONTRACT} />);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /<button/);
});

function issueFixture(extra: Partial<Issue> = {}): Issue {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "linear",
    externalId: "linear-uuid-1",
    externalLabel: "NOT-306",
    externalUrl: "https://linear.app/not-so-fat/issue/NOT-306/x",
    title: "NOT-306: frozen execution contracts",
    description: "Planner brief with contract headings.",
    acceptanceCriteria: "- [ ] Full ticket imports into the exact schema",
    repo: "github.com/owner/repo",
    baseBranch: "main",
    status: "ready",
    currentOwner: "system",
    currentIntent: null,
    developerAgentId: null,
    reviewerAgentId: null,
    maxReviewRounds: 3,
    currentRound: 1,
    maxInfraAttempts: 3,
    infraAttempts: 0,
    branch: null,
    baseSha: null,
    headSha: null,
    prNumber: null,
    prUrl: null,
    autoMerge: false,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...extra,
  };
}

function detailFixture(issue: Issue): WebIssueDetail {
  return {
    issue,
    timeline: [],
    humanActions: [],
    findings: [],
    usageSummary: { totalCostUsd: 0, totalDurationMs: 0, totalTokensIn: 0, totalTokensOut: 0 },
    readiness: { ok: true, missing: [] },
    humanWaitMs: 0,
    interventionCount: 0,
    latestWorkflowInstance: null,
  };
}

test("Issue Detail smoke: contract issue shows the read-only summary, legacy issue shows none", () => {
  const withContract = renderToStaticMarkup(
    <MemoryRouter>
      <IssueDetailBody
        issueId={issueFixture().id}
        detail={detailFixture(issueFixture({ executionContract: CONTRACT }))}
        agents={[]}
        onHumanActionsChanged={() => {}}
        refresh={() => {}}
        onError={() => {}}
      />
    </MemoryRouter>
  );
  assert.match(withContract, /aria-label="Execution contract"/);
  assert.match(withContract, /Exit predicate:/);
  assert.match(withContract, /One-PR stopping point:/);

  const legacy = renderToStaticMarkup(
    <MemoryRouter>
      <IssueDetailBody
        issueId={issueFixture().id}
        detail={detailFixture(issueFixture({ executionContract: null }))}
        agents={[]}
        onHumanActionsChanged={() => {}}
        refresh={() => {}}
        onError={() => {}}
      />
    </MemoryRouter>
  );
  assert.doesNotMatch(legacy, /aria-label="Execution contract"/);
});
