// NOT-358: a parked issue offers the developer/reviewer swap, and a usage-cap
// wait offers "Park for human" next to its notice. Static-markup regression tests
// alongside IssueDetailRegression.test.tsx — interaction (save/park calls) is the
// server PATCH/park contract, already covered by the route tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AgentWithHealth, HumanAction, Issue } from "@agent-dealer/shared";
import type { IssueDetail as WebIssueDetail } from "../../api.js";
import IssueDetailBody from "./IssueDetailBody.js";
import AgentAssignmentEditor from "./AgentAssignmentEditor.js";

function issueFixture(extra: Partial<Issue> = {}): Issue {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "manual",
    externalId: null,
    externalLabel: null,
    externalUrl: null,
    title: "Capped feature",
    description: "Do the thing.",
    acceptanceCriteria: "It works.",
    repo: "github.com/owner/repo",
    baseBranch: "main",
    status: "needs_human",
    currentOwner: "human",
    currentIntent: "Developer deferred — capped",
    developerAgentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    reviewerAgentId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    maxReviewRounds: 3,
    currentRound: 1,
    maxInfraAttempts: 3,
    infraAttempts: 0,
    maxCiAttempts: 3,
    ciAttempts: 0,
    branch: "dealer/issue-1",
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

function actionFixture(extra: Partial<HumanAction> = {}): HumanAction {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    issueId: "11111111-1111-4111-8111-111111111111",
    runId: null,
    workflowInstanceId: null,
    actionType: "attempts_exhausted",
    reason: "The review-round limit is reached.",
    question: "The review-round limit is reached. Retry with a fresh round, or close the issue?",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify([
      { choice: "retry", label: "Retry — another round" },
      { choice: "close", label: "Close" },
    ]),
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: "2026-09-20T09:45:00.000Z",
    resolvedAt: null,
    ...extra,
  };
}

function agentFixture(extra: Partial<AgentWithHealth> = {}): AgentWithHealth {
  return {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    name: "Dev One",
    runtime: "claude_code",
    workspaceRoot: null,
    deckId: null,
    deckName: null,
    playbookId: null,
    defaultPlanModel: null,
    defaultExecuteModel: null,
    defaultPlanBudgetJson: null,
    defaultExecuteBudgetJson: null,
    defaultModel: null,
    defaultEffort: null,
    defaultBudgetJson: null,
    purpose: null,
    playbookIdsJson: null,
    externalMemoryRefsJson: null,
    permissionPolicyJson: null,
    isBuiltin: true,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    healthy: true,
    issues: [],
    ...extra,
  };
}

function detailFixture(extra: Partial<WebIssueDetail> = {}): WebIssueDetail {
  return {
    issue: issueFixture(),
    timeline: [],
    humanActions: [actionFixture()],
    findings: [],
    usageSummary: { totalCostUsd: 0, totalDurationMs: 0, totalTokensIn: 0, totalTokensOut: 0 },
    readiness: { ok: true, missing: [] },
    humanWaitMs: 0,
    interventionCount: 0,
    latestWorkflowInstance: null,
    ...extra,
  };
}

function agentsFixture(): AgentWithHealth[] {
  return [
    agentFixture(),
    agentFixture({
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      name: "Rev Two",
      runtime: "cursor_local",
    }),
  ];
}

function renderBody(detail: WebIssueDetail, agents: AgentWithHealth[] = []): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <IssueDetailBody
        issueId="11111111-1111-4111-8111-111111111111"
        detail={detail}
        agents={agents}
        onHumanActionsChanged={() => {}}
        refresh={() => {}}
        onError={() => {}}
      />
    </MemoryRouter>
  );
}

test("a parked issue offers the agent swap, other statuses do not", () => {
  const parked = renderBody(detailFixture(), agentsFixture());
  assert.match(parked, /Swap developer \/ reviewer agents/);

  const running = renderBody(
    detailFixture({ issue: issueFixture({ status: "developing" }), humanActions: [] }),
    agentsFixture()
  );
  assert.doesNotMatch(running, /Swap developer \/ reviewer agents/);

  const ready = renderBody(
    detailFixture({ issue: issueFixture({ status: "ready" }), humanActions: [] }),
    agentsFixture()
  );
  assert.doesNotMatch(ready, /Swap developer \/ reviewer agents/);
});

test("a policy_escalation park offers the swap, other open actions do not", () => {
  const escalation = renderBody(
    detailFixture({ humanActions: [actionFixture({ actionType: "policy_escalation" })] }),
    agentsFixture()
  );
  assert.match(escalation, /Swap developer \/ reviewer agents/);

  const review = renderBody(
    detailFixture({ humanActions: [actionFixture({ actionType: "final_review" })] }),
    agentsFixture()
  );
  assert.doesNotMatch(review, /Swap developer \/ reviewer agents/);
});

test("a usage-cap wait shows the wait notice with a Park for human action", () => {
  const html = renderBody(
    detailFixture({
      issue: issueFixture({ status: "developing", currentOwner: "developer" }),
      humanActions: [],
      capWait: {
        kind: "usage_capped",
        until: "2026-10-04T12:00:00.000Z",
        reason: "claude_code usage capped — five_hour limit rejected",
      },
    }),
    agentsFixture()
  );
  assert.match(html, /Waiting on usage cap/);
  assert.match(html, /five_hour limit rejected/);
  assert.match(html, /Park for human/);
});

test("a deck-outage wait reads as an Agent Deck wait, and no wait shows no park action", () => {
  const outage = renderBody(
    detailFixture({
      issue: issueFixture({ status: "developing", currentOwner: "developer" }),
      humanActions: [],
      capWait: {
        kind: "deck_unavailable",
        until: "2026-10-04T12:00:00.000Z",
        reason: "Agent Deck unreachable — connection refused",
      },
    }),
    agentsFixture()
  );
  assert.match(outage, /Waiting on Agent Deck/);
  assert.match(outage, /Park for human/);

  const idle = renderBody(
    detailFixture({ issue: issueFixture({ status: "ready" }), humanActions: [] }),
    agentsFixture()
  );
  assert.doesNotMatch(idle, /Park for human/);
});

test("the parked editor shows both agent selects with a Save action and the parked copy", () => {
  const html = renderToStaticMarkup(
    <AgentAssignmentEditor
      variant="parked"
      agents={agentsFixture()}
      initialDeveloperId="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
      initialReviewerId="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"
      busy={false}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
  assert.match(html, /Developer/);
  assert.match(html, /Reviewer/);
  assert.match(html, /Save agents/);
  assert.match(html, /worktree/);
  assert.match(html, /resume continues with the new agents/);
  assert.doesNotMatch(html, /queue position is kept/);
});

test("the queued editor keeps its queue copy", () => {
  const html = renderToStaticMarkup(
    <AgentAssignmentEditor
      agents={agentsFixture()}
      initialDeveloperId="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
      initialReviewerId="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"
      busy={false}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
  assert.match(html, /queue position is kept/);
  assert.doesNotMatch(html, /resume continues with the new agents/);
});
