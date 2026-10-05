// NOT-359: a parked issue shows the developer/reviewer swap box expanded by
// default, directly under the open human action card — no collapsed link. Static
// markup tests alongside IssueDetailBody (renderToStaticMarkup, no browser):
// presence/absence/preselection/disabled state are asserted on the markup, and
// the partial-PATCH contract (only changed roles) is asserted on the exported
// buildAgentSwapPatch helper the save path sends. Interaction (changing a
// selector, clicking Save/Cancel) needs a DOM harness the repo does not ship,
// so the enabled-after-change and reset branches are covered by construction:
// Save's `disabled` reads the same unchanged comparison the builder inverts,
// and parked Cancel assigns the initial ids back into the same state.
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
import IssueDetailBody, {
  AGENT_SWAP_SAVED_NOTICE,
  buildAgentSwapPatch,
} from "./IssueDetailBody.js";
import AgentAssignmentEditor from "./AgentAssignmentEditor.js";

const DEV = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const REV = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const DEV2 = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

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
    developerAgentId: DEV,
    reviewerAgentId: REV,
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
    id: DEV,
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
      id: REV,
      name: "Rev Two",
      runtime: "cursor_local",
    }),
    agentFixture({
      id: DEV2,
      name: "Dev Three",
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

/** The two swap selectors: the only <select> elements the detail renders. */
function swapSelects(html: string): RegExpMatchArray[] {
  return [...html.matchAll(/<select[^>]*>/g)];
}

test("a parked issue renders both selectors expanded without any click, preselected to the current agents", () => {
  for (const actionType of ["attempts_exhausted", "policy_escalation"] as const) {
    const html = renderBody(
      detailFixture({ humanActions: [actionFixture({ actionType })] }),
      agentsFixture()
    );
    // Expanded box, not the old collapsed link.
    assert.match(html, /Swap the developer and\/or reviewer/, `expanded copy for ${actionType}`);
    assert.doesNotMatch(html, /Swap developer \/ reviewer agents/, `no collapsed link for ${actionType}`);
    // Both selectors present and enabled.
    const selects = swapSelects(html);
    assert.equal(selects.length, 2, `two selectors for ${actionType}`);
    for (const s of selects) assert.doesNotMatch(s[0], /disabled/, `selector enabled for ${actionType}`);
    // Preselected to the issue's current agents.
    assert.match(html, new RegExp(`<option value="${DEV}"[^>]*selected`), `developer preselected for ${actionType}`);
    assert.match(html, new RegExp(`<option value="${REV}"[^>]*selected`), `reviewer preselected for ${actionType}`);
    // Save disabled while nothing changed.
    assert.match(html, /<button[^>]*disabled=""[^>]*>Save agents</, `save disabled initially for ${actionType}`);
    // The box sits under the human action card, next to the Resume/Close choices.
    assert.ok(
      html.indexOf("Human action needed") !== -1 &&
        html.indexOf("Human action needed") < html.indexOf("Swap the developer"),
      `swap box under the human action card for ${actionType}`
    );
    // No premature confirmation.
    assert.doesNotMatch(html, /Agents updated/, `no confirmation before a save for ${actionType}`);
  }
});

test("no swap box for running, reviewing, repairing, final_review, queued, ready, cap-waiting, done, closed, or other-action needs_human states", () => {
  const activeInstance = {
    id: "33333333-3333-4333-8333-333333333333",
    issueId: "11111111-1111-4111-8111-111111111111",
    workflowVersion: "v1",
    startedAt: "2026-09-20T09:30:00.000Z",
    completedAt: null,
    outcome: null,
  };
  const cases: Array<{ name: string; detail: WebIssueDetail }> = [
    {
      name: "developing",
      detail: detailFixture({ issue: issueFixture({ status: "developing" }), humanActions: [] }),
    },
    {
      name: "reviewing",
      detail: detailFixture({ issue: issueFixture({ status: "reviewing" }), humanActions: [] }),
    },
    {
      name: "repairing",
      detail: detailFixture({ issue: issueFixture({ status: "repairing" }), humanActions: [] }),
    },
    {
      name: "final_review",
      detail: detailFixture({ issue: issueFixture({ status: "final_review" }), humanActions: [] }),
    },
    {
      name: "ready",
      detail: detailFixture({ issue: issueFixture({ status: "ready" }), humanActions: [] }),
    },
    {
      name: "queued ready",
      detail: detailFixture({
        issue: issueFixture({ status: "ready" }),
        humanActions: [],
        queued: true,
        queueEntry: { position: 2, waitReason: "waiting for slot" },
      }),
    },
    {
      name: "cap-waiting",
      detail: detailFixture({
        issue: issueFixture({ status: "developing", currentOwner: "developer" }),
        humanActions: [],
        capWait: {
          kind: "usage_capped",
          until: "2026-10-04T12:00:00.000Z",
          reason: "claude_code usage capped — five_hour limit rejected",
        },
      }),
    },
    {
      name: "done",
      detail: detailFixture({ issue: issueFixture({ status: "done" }), humanActions: [] }),
    },
    {
      name: "closed",
      detail: detailFixture({ issue: issueFixture({ status: "closed" }), humanActions: [] }),
    },
    {
      name: "aborted run (closed with a completed instance)",
      detail: detailFixture({
        issue: issueFixture({ status: "closed" }),
        humanActions: [],
        latestWorkflowInstance: { ...activeInstance, completedAt: "2026-09-20T10:00:00.000Z", outcome: "closed" },
      }),
    },
    {
      name: "needs_human with only a resolved park action",
      detail: detailFixture({
        humanActions: [actionFixture({ status: "resolved" })],
      }),
    },
  ];
  const otherActionTypes = [
    "final_review",
    "product_scope_decision",
    "operator_verification",
    "deck_interaction_required",
    "reflection_interaction_required",
    "muse_capability",
  ] as const;
  for (const actionType of otherActionTypes) {
    cases.push({
      name: `needs_human with only ${actionType}`,
      detail: detailFixture({ humanActions: [actionFixture({ actionType })] }),
    });
  }
  for (const { name, detail } of cases) {
    const html = renderBody(detail, agentsFixture());
    assert.doesNotMatch(html, /Swap the developer and\/or reviewer/, `no swap copy for ${name}`);
    assert.doesNotMatch(html, /Save agents/, `no swap save for ${name}`);
    assert.doesNotMatch(html, /resume continues with the new agents/, `no swap note for ${name}`);
    assert.equal(swapSelects(html).length, 0, `no swap selectors for ${name}`);
  }
});

test("buildAgentSwapPatch sends only the changed roles", () => {
  assert.deepEqual(
    buildAgentSwapPatch(DEV, REV, DEV2, REV),
    { developerAgentId: DEV2 },
    "developer-only change patches only the developer"
  );
  assert.deepEqual(
    buildAgentSwapPatch(DEV, REV, DEV, DEV2),
    { reviewerAgentId: DEV2 },
    "reviewer-only change patches only the reviewer"
  );
  assert.deepEqual(
    buildAgentSwapPatch(DEV, REV, DEV2, DEV),
    { developerAgentId: DEV2, reviewerAgentId: DEV },
    "both changed patches both roles"
  );
  assert.deepEqual(buildAgentSwapPatch(DEV, REV, DEV, REV), {}, "nothing changed patches nothing");
  assert.deepEqual(
    buildAgentSwapPatch(null, null, DEV, REV),
    { developerAgentId: DEV, reviewerAgentId: REV },
    "unassigned currents patch both roles"
  );
});

test("the saved notice stays inside the visible box with the new agents selected", () => {
  // The confirmation line itself renders inside the editor, under the buttons.
  const saved = renderToStaticMarkup(
    <AgentAssignmentEditor
      variant="parked"
      agents={agentsFixture()}
      initialDeveloperId={DEV2}
      initialReviewerId={REV}
      busy={false}
      notice={AGENT_SWAP_SAVED_NOTICE}
      onSave={() => {}}
    />
  );
  assert.match(saved, /Agents updated\. Resume to continue with the new agents\./);
  // The box stays visible: selectors and Save remain alongside the notice.
  assert.equal(swapSelects(saved).length, 2, "selectors remain after save");
  assert.match(saved, /Save agents/);
  assert.match(saved, new RegExp(`<option value="${DEV2}"[^>]*selected`), "new developer stays selected");

  // A fresh parked render (pre-save) shows no confirmation.
  const fresh = renderToStaticMarkup(
    <AgentAssignmentEditor
      variant="parked"
      agents={agentsFixture()}
      initialDeveloperId={DEV}
      initialReviewerId={REV}
      busy={false}
      onSave={() => {}}
    />
  );
  assert.doesNotMatch(fresh, /Agents updated/);
  assert.match(fresh, /<button[^>]*disabled=""[^>]*>Save agents</, "save disabled while nothing changed");

  // The refreshed detail after a save keeps the box open on the new agents.
  const refreshed = renderBody(
    detailFixture({ issue: issueFixture({ developerAgentId: DEV2 }) }),
    agentsFixture()
  );
  assert.match(refreshed, /Swap the developer and\/or reviewer/);
  assert.match(refreshed, new RegExp(`<option value="${DEV2}"[^>]*selected`));
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
      initialDeveloperId={DEV}
      initialReviewerId={REV}
      busy={false}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
  assert.match(html, /Developer/);
  assert.match(html, /Reviewer/);
  assert.match(html, /Save agents/);
  assert.match(html, /Cancel/);
  assert.match(html, /worktree/);
  assert.match(html, /resume continues with the new agents/);
  assert.doesNotMatch(html, /queue position is kept/);
});

test("the queued editor keeps its queue copy", () => {
  const html = renderToStaticMarkup(
    <AgentAssignmentEditor
      agents={agentsFixture()}
      initialDeveloperId={DEV}
      initialReviewerId={REV}
      busy={false}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );
  assert.match(html, /queue position is kept/);
  assert.doesNotMatch(html, /resume continues with the new agents/);
});
