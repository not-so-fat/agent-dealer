// NOT-288: the Issues home and Issue Detail share one compact action card —
// short question plus one-sentence context by default, full paths/commands/
// SHAs/evidence under Details — with choice labels sourced from the server's
// responseOptionsJson in both places.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
// node --import tsx compiles JSX in classic mode: components reference the
// React global at render time. (Under automatic JSX runtimes this is inert.)
(globalThis as { React?: unknown }).React ??= React;
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { HumanAction, Issue } from "@agent-dealer/shared";
import { summarizeHumanAction } from "@agent-dealer/shared";
import type { IssueDetail as WebIssueDetail } from "../../api.js";
import HumanActionCard from "./HumanActionCard.js";
import NeedsAttentionPanel from "./NeedsAttentionPanel.js";
import IssueDetailBody from "./IssueDetailBody.js";

const LOCAL_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WORKTREE_PATH = "/Users/friend/.agent-dealer-dev/worktrees/310f25af-developer";

function actionFixture(extra: Partial<HumanAction> = {}): HumanAction {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    issueId: "22222222-2222-4222-8222-222222222222",
    runId: null,
    workflowInstanceId: "33333333-3333-4333-8333-333333333333",
    actionType: "policy_escalation",
    reason: "Developer worktree has uncommitted changes after the session ended.",
    question: "Developer worktree has uncommitted changes after the session ended. Resume development, or close the issue?",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify([
      { choice: "resume", label: "Resume development" },
      { choice: "close", label: "Close" },
    ]),
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: "2026-09-20T10:00:00.000Z",
    resolvedAt: null,
    ...extra,
  };
}

function worktreeConflictAction(): HumanAction {
  const reason =
    `issue branch is already used by worktree at ${WORKTREE_PATH}. ` +
    `Recovery:\ngit -C ${WORKTREE_PATH} status\ngit worktree remove --force ${WORKTREE_PATH}`;
  return actionFixture({
    reason,
    question: `${reason} Resume development, or close the issue?`,
    evidenceJson: JSON.stringify({ worktreeBlocker: { fingerprint: "abc123" } }),
  });
}

function divergedAction(): HumanAction {
  return actionFixture({
    reason: "Developer's commits could not be pushed: rejected: non-fast-forward",
    question: "Developer's commits could not be pushed: rejected. Push local, resume, or close?",
    evidenceJson: JSON.stringify({
      pushDivergence: {
        branch: "issue-1",
        localSha: LOCAL_SHA,
        remoteSha: REMOTE_SHA,
        ahead: 2,
        behind: 1,
        relationship: "diverged",
        worktreePath: WORKTREE_PATH,
      },
    }),
    responseOptionsJson: JSON.stringify([
      { choice: "push_with_lease", label: "Push with lease" },
      { choice: "resume", label: "Resume development" },
      { choice: "close", label: "Close" },
    ]),
  });
}

function ordinaryAction(): HumanAction {
  const reason = "Git/GitHub verification failed: gh pr checks timed out. (infra-attempt limit reached).";
  return actionFixture({ reason, question: `${reason} Resume development, or close the issue?` });
}

/** renderToStaticMarkup escapes quotes/apostrophes — accept either form. */
function htmlContains(html: string, text: string): boolean {
  if (html.includes(text)) return true;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  return html.includes(escaped);
}

function renderCard(action: HumanAction): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HumanActionCard action={action} linkTo={`/issues/${action.issueId}`} onChoose={() => {}} />
    </MemoryRouter>
  );
}

/** The collapsed default view ends at <details>: technical facts live inside it. */
function collapsedBoundary(html: string): { head: string; details: string } {
  const idx = html.indexOf("<details");
  assert.ok(idx > 0, "card renders a collapsed Details disclosure");
  assert.ok(!/<details[^>]*\bopen\b/.test(html), "Details start collapsed");
  return { head: html.slice(0, idx), details: html.slice(idx) };
}

test("worktree conflict card asks a short question; path and commands sit under Details", () => {
  const html = renderCard(worktreeConflictAction());
  const { head, details } = collapsedBoundary(html);
  assert.match(head, /saved worktree still holds this branch/);
  assert.ok(!head.includes(WORKTREE_PATH), "default view hides the worktree path");
  assert.ok(!head.includes("git -C"), "default view hides recovery commands");
  assert.match(head, /preserved/);
  assert.ok(details.includes(WORKTREE_PATH), "Details reveal the worktree path");
  assert.ok(details.includes("git worktree remove"), "Details reveal the exact recovery commands");
  assert.ok(details.includes(worktreeConflictAction().reason), "Details keep the full reason");
});

test("diverged push card keeps Push with lease with SHAs pinned under Details", () => {
  const html = renderCard(divergedAction());
  const { head, details } = collapsedBoundary(html);
  assert.match(head, /pinned lease/);
  assert.match(html, /Push with lease/);
  assert.ok(!head.includes("Resume safely"), "preserved-work resume never promises safety");
  assert.ok(details.includes(LOCAL_SHA), "Details pin the full local SHA");
  assert.ok(details.includes(REMOTE_SHA), "Details pin the full remote SHA");
  assert.ok(details.includes("origin/issue-1"), "Details name the branch");
});

test("ordinary escalation offers Resume safely with a one-sentence context", () => {
  const html = renderCard(ordinaryAction());
  const { head } = collapsedBoundary(html);
  assert.match(head, /Development is parked/);
  assert.match(head, /Git\/GitHub verification failed/);
  assert.match(html, /Resume safely/);
  assert.ok(!head.includes("Resume development, or close the issue?"), "folded suffix leaves the default view");
});

function issueFixture(): Issue {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    source: "manual",
    externalId: null,
    externalLabel: null,
    externalUrl: null,
    title: "Fix the retry badge",
    description: "d",
    acceptanceCriteria: "a",
    repo: "github.com/owner/repo",
    baseBranch: "main",
    status: "needs_human",
    currentOwner: "human",
    currentIntent: null,
    developerAgentId: null,
    reviewerAgentId: null,
    maxReviewRounds: 3,
    currentRound: 1,
    maxInfraAttempts: 2,
    infraAttempts: 2,
    branch: "dealer/issue-1",
    baseSha: null,
    headSha: null,
    prNumber: null,
    prUrl: null,
    autoMerge: false,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
}

function renderHome(action: HumanAction): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NeedsAttentionPanel actions={[action]} busyActionId={null} onResolve={() => {}} />
    </MemoryRouter>
  );
}

function renderDetail(action: HumanAction): string {
  const detail: WebIssueDetail = {
    issue: issueFixture(),
    timeline: [],
    humanActions: [action],
    findings: [],
    usageSummary: { totalCostUsd: 0, totalDurationMs: 0, totalTokensIn: 0, totalTokensOut: 0 },
    readiness: { ok: true, missing: [] },
    humanWaitMs: 0,
    interventionCount: 0,
    latestWorkflowInstance: null,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <IssueDetailBody
        issueId={detail.issue.id}
        detail={detail}
        agents={[]}
        onHumanActionsChanged={() => {}}
        refresh={() => {}}
        onError={() => {}}
      />
    </MemoryRouter>
  );
}

for (const [name, make] of [
  ["worktree conflict", worktreeConflictAction],
  ["diverged push", divergedAction],
  ["ordinary escalation", ordinaryAction],
] as const) {
  test(`home and detail agree on the ${name} action`, () => {
    const action = make();
    const summary = summarizeHumanAction(action);
    const home = renderHome(action);
    const detail = renderDetail(action);
    for (const html of [home, detail]) {
      assert.ok(htmlContains(html, summary.title), "same compact question");
      if (summary.context) assert.ok(htmlContains(html, summary.context), "same one-sentence context");
      for (const option of summary.displayOptions) {
        assert.ok(htmlContains(html, option.label), `same choice label: ${option.label}`);
      }
      assert.ok(html.includes("Details"), "expandable Details present");
      assert.ok(htmlContains(html, summary.details.reason), "Details carry the full reason");
    }
    // The issue timeline stays auditable: the detail still renders its section.
    assert.match(detail, /No activity yet/);
  });
}
