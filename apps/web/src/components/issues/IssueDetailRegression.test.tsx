// NOT-174 regression: the existing Issue Detail strips (live/failure vocabulary,
// timeline labels, status badges) keep working alongside Execution analysis.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type {
  AgentWithHealth,
  HumanAction,
  Issue,
  WorkflowEvent,
  WorkflowInstance,
  WorkerSession,
} from "@agent-dealer/shared";
import type { IssueDetail as WebIssueDetail } from "../../api.js";
import IssueTimeline from "./IssueTimeline.js";
import IssueStatusBadge from "./IssueStatusBadge.js";
import IssueDetailBody from "./IssueDetailBody.js";
import IssueConfigurationSection, { IssueConfigurationEditor } from "./IssueConfiguration.js";

function event(extra: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: "evt-1",
    issueId: "issue-1",
    workflowInstanceId: null,
    type: "worker.failed",
    actorType: "developer",
    actorRef: "agent-1",
    round: 1,
    workerSessionId: null,
    stage: "developing",
    idempotencyKey: null,
    causationEventId: null,
    ts: "2026-09-20T10:00:00.000Z",
    payloadJson: null,
    artifactRef: null,
    ...extra,
  };
}

test("empty timeline keeps its empty state", () => {
  const html = renderToStaticMarkup(<IssueTimeline events={[]} />);
  assert.match(html, /No activity yet/);
});

test("worker failed/started events keep role-aware labels", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({ id: "a", type: "worker.failed", round: 2 }),
        event({ id: "b", type: "worker.started", actorType: "reviewer", round: 1 }),
        event({ id: "c", type: "workflow.started", actorType: "system", actorRef: null }),
      ]}
    />
  );
  assert.match(html, /Developer failed \(round 2\)/);
  assert.match(html, /Reviewer started \(round 1\)/);
  assert.match(html, /Workflow started/);
});

test("deck-unavailable deferral still reads as waiting, not a worker problem", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({
          id: "d",
          type: "worker.deferred",
          payloadJson: JSON.stringify({ outcome: "deck_unavailable" }),
        }),
      ]}
    />
  );
  assert.match(html, /Waiting for Agent Deck/);
});

test("review verdicts keep their handoff rendering", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({
          id: "r",
          type: "review.submitted",
          actorType: "reviewer",
          payloadJson: JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "major" }] }),
        }),
      ]}
    />
  );
  assert.match(html, /changes requested/);
  assert.match(html, /1 finding/);
});

function issueFixture(extra: Partial<Issue> = {}): Issue {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "manual",
    externalId: null,
    externalLabel: null,
    externalUrl: null,
    title: "Fix the retry badge",
    description: "Make the retry say what it kept.",
    acceptanceCriteria: "Operator sees preserved kinds.",
    repo: "github.com/owner/repo",
    baseBranch: "main",
    status: "ready",
    currentOwner: "developer",
    currentIntent: null,
    developerAgentId: null,
    reviewerAgentId: null,
    maxReviewRounds: 3,
    currentRound: 1,
    maxInfraAttempts: 2,
    infraAttempts: 0,
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

function sessionFixture(extra: Partial<WorkerSession> = {}): WorkerSession {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    issueId: "11111111-1111-4111-8111-111111111111",
    role: "developer",
    round: 1,
    agentId: null,
    runtime: "claude_code",
    model: "opus-4",
    budgetJson: null,
    worktreePath: "/tmp/wt/issue-1",
    inputSha: null,
    status: "running",
    sessionRef: null,
    logPath: "/tmp/logs/session-1.log",
    exitCode: null,
    errorJson: null,
    metadataJson: null,
    profileSnapshotJson: null,
    processPid: 1234,
    processOwner: "coordinator",
    processStartedAt: null,
    createdAt: "2026-09-20T09:30:00.000Z",
    startedAt: "2026-09-20T09:31:00.000Z",
    heartbeatAt: "2026-09-20T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...extra,
  };
}

function detailFixture(extra: Partial<WebIssueDetail> = {}): WebIssueDetail {
  return {
    issue: issueFixture(),
    timeline: [],
    humanActions: [],
    findings: [],
    usageSummary: { totalCostUsd: 1.23, totalDurationMs: 600_000, totalTokensIn: 12_000, totalTokensOut: 4_000 },
    readiness: { ok: true, missing: [] },
    humanWaitMs: 0,
    interventionCount: 0,
    latestWorkflowInstance: null,
    ...extra,
  };
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
    </MemoryRouter>,
  );
}

test("live strip keeps running-session vocabulary, progress, and branch tip", () => {
  const instance: WorkflowInstance = {
    id: "33333333-3333-4333-8333-333333333333",
    issueId: "11111111-1111-4111-8111-111111111111",
    workflowVersion: "v1",
    startedAt: "2026-09-20T09:30:00.000Z",
    completedAt: null,
    outcome: null,
  };
  const html = renderBody(
    detailFixture({
      issue: issueFixture({ status: "developing", currentIntent: "Working on the fix" }),
      latestWorkflowInstance: instance,
      activeWorkerSession: sessionFixture(),
      liveProgress: "Writing the retry badge",
      branchTipStatus: {
        branch: "dealer/issue-1",
        state: "ahead",
        commitsAhead: 2,
        tipLabel: "2 ahead",
        restartRisk: false,
        worktree: null,
      },
    }),
  );
  assert.match(html, /Running now/);
  assert.match(html, /Last progress: Writing the retry badge/);
  assert.match(html, /Branch tip: 2 ahead/);
  assert.match(html, /Heartbeat/);
  assert.doesNotMatch(html, /Latest session failure/);
});

test("failure strip keeps the latest failure with branch tip and log", () => {
  const html = renderBody(
    detailFixture({
      issue: issueFixture({ status: "repairing" }),
      latestSessionFailure: {
        reason: "npm test timed out after 300s",
        when: "2026-09-20T10:00:00.000Z",
        role: "developer",
        outcome: "failed",
        sessionId: "session-1",
        logPath: "/tmp/logs/session-1.log",
        infraAttempts: 1,
        maxInfraAttempts: 3,
      },
      branchTipStatus: {
        branch: "dealer/issue-1",
        state: "empty",
        commitsAhead: 0,
        tipLabel: "no tip yet",
        restartRisk: true,
        worktree: null,
      },
    }),
  );
  assert.match(html, /Latest session failure/);
  assert.match(html, /npm test timed out/);
  assert.match(html, /Branch tip: no tip yet/);
  assert.match(html, /restart risk/);
  assert.doesNotMatch(html, /Running now/);
});

test("branch-tip panel mounts when no live or failure strip owns the slot", () => {
  const html = renderBody(
    detailFixture({
      issue: issueFixture({ status: "reviewing" }),
      branchTipStatus: {
        branch: "dealer/issue-1",
        state: "ahead",
        commitsAhead: 1,
        tipLabel: "1 ahead",
        restartRisk: false,
        worktree: null,
      },
    }),
  );
  assert.match(html, /Branch tip/);
  assert.match(html, /1 ahead/);
});

test("ready issue keeps its action controls", () => {
  const html = renderBody(detailFixture({ issue: issueFixture({ status: "ready" }) }));
  assert.match(html, /Run next/);
  assert.match(html, /Execute now/);
  assert.match(html, /Add to queue/);
});

test("unready issue keeps its edit control", () => {
  const html = renderBody(
    detailFixture({
      issue: issueFixture({ status: "ready" }),
      readiness: { ok: false, missing: ["acceptance criteria"] },
    }),
  );
  assert.match(html, /Edit title \/ description \/ acceptance criteria/);
  assert.match(html, /Not startable yet/);
});

test("open human action keeps its question and server-declared choices", () => {
  const action: HumanAction = {
    id: "44444444-4444-4444-8444-444444444444",
    issueId: "11111111-1111-4111-8111-111111111111",
    runId: null,
    workflowInstanceId: null,
    actionType: "policy_escalation",
    reason: "needs a human call",
    question: "Allow the deploy?",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify([
      { choice: "approve", label: "Approve" },
      { choice: "deny", label: "Deny" },
    ]),
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: "2026-09-20T09:45:00.000Z",
    resolvedAt: null,
  };
  const html = renderBody(
    detailFixture({ issue: issueFixture({ status: "needs_human" }), humanActions: [action] }),
  );
  assert.match(html, /Human action needed/);
  assert.match(html, /Allow the deploy\?/);
  assert.match(html, /Approve/);
});

test("evidence panel, timeline, analysis section, and guidance mount together", () => {
  const html = renderBody(
    detailFixture({
      issue: issueFixture({ status: "developing" }),
      timeline: [event({ id: "a", type: "worker.failed", round: 2 })],
    }),
  );
  assert.match(html, /Evidence &amp; raw trace/);
  assert.match(html, /Developer failed \(round 2\)/);
  assert.match(html, /Execution analysis/);
  assert.match(html, /Guide this issue/);
});

test("status badges keep every status label", () => {
  const cases = [
    ["ready", "Ready"],
    ["developing", "Developing"],
    ["reviewing", "Reviewing"],
    ["repairing", "Repairing"],
    ["final_review", "Final review"],
    ["needs_human", "Needs human"],
    ["done", "Done"],
    ["closed", "Closed"],
  ] as const;
  for (const [status, label] of cases) {
    const html = renderToStaticMarkup(<IssueStatusBadge status={status} />);
    assert.match(html, new RegExp(label), `badge for ${status}`);
  }
});

// NOT-240: execution configuration fixtures.
const DEV_ID = "55555555-5555-4555-8555-555555555555";
const REV_ID = "66666666-6666-4666-8666-666666666666";

function agentFixture(extra: Partial<AgentWithHealth> = {}): AgentWithHealth {
  return {
    id: DEV_ID,
    name: "Cursor Dev",
    runtime: "cursor_local",
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
    isBuiltin: false,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    healthy: true,
    issues: [],
    ...extra,
  };
}

const DEV = agentFixture();
const REV = agentFixture({ id: REV_ID, name: "Codex Rev", runtime: "codex_local" });

function configuredIssue(extra: Partial<Issue> = {}): Issue {
  return issueFixture({
    repo: "github.com/owner/repo",
    developerAgentId: DEV_ID,
    reviewerAgentId: REV_ID,
    ...extra,
  });
}

test("configuration section shows repository, developer, and reviewer without expansion", () => {
  const html = renderBody(detailFixture({ issue: configuredIssue() }), [DEV, REV]);
  assert.match(html, /Configuration/);
  assert.match(html, /github\.com\/owner\/repo/);
  assert.match(html, /Cursor Dev/);
  assert.match(html, /Cursor/);
  assert.match(html, /Codex Rev/);
  assert.match(html, /Codex/);
});

test("missing agent profiles render an explicit unavailable state", () => {
  const html = renderBody(detailFixture({ issue: configuredIssue() }), []);
  assert.match(html, /Configuration/);
  assert.match(html, /Unavailable/);
});

test("unqueued ready issue can open the configuration editor", () => {
  const html = renderBody(
    detailFixture({ issue: configuredIssue({ status: "ready" }), queued: false, queueEntry: null }),
    [DEV, REV],
  );
  assert.match(html, /Edit configuration/);
});

test("queued ready issue can open the configuration editor without losing its wait reason", () => {
  const html = renderBody(
    detailFixture({
      issue: configuredIssue({ status: "ready" }),
      queued: true,
      queueEntry: { position: 2, waitReason: "waiting for slot" },
    }),
    [DEV, REV],
  );
  assert.match(html, /Edit configuration/);
  assert.match(html, /position 2/);
  assert.match(html, /waiting for slot/);
});

test("in-flight and terminal issues render configuration read-only", () => {
  const activeInstance: WorkflowInstance = {
    id: "33333333-3333-4333-8333-333333333333",
    issueId: "11111111-1111-4111-8111-111111111111",
    workflowVersion: "v1",
    startedAt: "2026-09-20T09:30:00.000Z",
    completedAt: null,
    outcome: null,
  };
  const cases: Array<{ status: Issue["status"]; active: boolean }> = [
    { status: "developing", active: true },
    { status: "reviewing", active: true },
    { status: "repairing", active: true },
    { status: "done", active: false },
    { status: "closed", active: false },
  ];
  for (const { status, active } of cases) {
    const html = renderBody(
      detailFixture({
        issue: configuredIssue({ status }),
        latestWorkflowInstance: active ? activeInstance : null,
      }),
      [DEV, REV],
    );
    assert.match(html, /Configuration/, `config visible for ${status}`);
    assert.match(html, /github\.com\/owner\/repo/, `repo visible for ${status}`);
    assert.doesNotMatch(html, /Edit configuration/, `no edit affordance for ${status}`);
  }
});

test("configuration editor edits repository and both agents together", () => {
  const html = renderToStaticMarkup(
    <IssueConfigurationEditor
      agents={[DEV, REV]}
      initialRepo="github.com/owner/repo"
      initialDeveloperId={DEV_ID}
      initialReviewerId={REV_ID}
      busy={false}
      onSave={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /github\.com\/owner\/repo/);
  assert.match(html, /Cursor Dev/);
  assert.match(html, /Codex Rev/);
  assert.match(html, /Save configuration/);
});

test("refreshed detail after admission wins the race renders configuration read-only", () => {
  // The editor was open on a `ready` issue; admission started the workflow elsewhere.
  // Save answers 409 and refresh() lands here: same configuration, no edit affordance,
  // and the frozen workflow snapshot is what the operator now sees.
  const html = renderBody(
    detailFixture({
      issue: configuredIssue({ status: "developing" }),
      latestWorkflowInstance: {
        id: "33333333-3333-4333-8333-333333333333",
        issueId: "11111111-1111-4111-8111-111111111111",
        workflowVersion: "v1",
        startedAt: "2026-09-20T09:30:00.000Z",
        completedAt: null,
        outcome: null,
      },
      queued: false,
      queueEntry: null,
    }),
    [DEV, REV],
  );
  assert.match(html, /Configuration/);
  assert.match(html, /github\.com\/owner\/repo/);
  assert.match(html, /Cursor Dev/);
  assert.doesNotMatch(html, /Edit configuration/);
});

test("configuration section stays read-only without an edit affordance after workflow start", () => {
  const html = renderToStaticMarkup(
    <IssueConfigurationSection
      issue={configuredIssue({ status: "developing" })}
      agents={[DEV, REV]}
      canEdit={false}
      editing={false}
      busy={false}
      onBeginEdit={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /Configuration/);
  assert.match(html, /Cursor Dev/);
  assert.doesNotMatch(html, /Edit configuration/);
});

test("timeline renders configuration updates with their label", () => {
  const html = renderToStaticMarkup(
    <IssueTimeline
      events={[
        event({
          id: "cfg",
          type: "issue.reassigned",
          actorType: "human",
          stage: "ready",
          payloadJson: JSON.stringify({
            fromRepo: "github.com/owner/old",
            toRepo: "github.com/owner/repo",
            fromDeveloperAgentId: DEV_ID,
            toDeveloperAgentId: DEV_ID,
            fromReviewerAgentId: REV_ID,
            toReviewerAgentId: REV_ID,
          }),
        }),
      ]}
    />,
  );
  assert.match(html, /Configuration updated/);
});
