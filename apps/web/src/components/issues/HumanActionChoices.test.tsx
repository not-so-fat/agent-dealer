// NOT-221: the dashboard renders the server-declared Push-with-lease button for a
// diverged `unpushed_commit` escalation, with the local/remote SHAs shown alongside.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HumanAction } from "@agent-dealer/shared";
import HumanActionChoices from "./HumanActionChoices.js";
import { actionContextLines, parseResponseOptions } from "../../lib/humanActions.js";

const LOCAL_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NEW_TIP = "cccccccccccccccccccccccccccccccccccccccc";

function divergedAction(): HumanAction {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    issueId: "22222222-2222-4222-8222-222222222222",
    runId: null,
    workflowInstanceId: "33333333-3333-4333-8333-333333333333",
    actionType: "policy_escalation",
    reason: "Developer's commits could not be pushed: diverged",
    question:
      "Developer's commits could not be pushed: diverged " +
      "Push local aaaaaaaaaaaa to origin/issue-1 with a lease pinned at remote bbbbbbbbbbbb " +
      "(local 2 commit(s) ahead, remote 1 commit(s) ahead), resume development, or close the issue?",
    evidenceJson: JSON.stringify({
      pushDivergence: {
        branch: "issue-1",
        localSha: LOCAL_SHA,
        remoteSha: REMOTE_SHA,
        ahead: 2,
        behind: 1,
        relationship: "diverged",
      },
    }),
    responseOptionsJson: JSON.stringify([
      { choice: "push_with_lease", label: "Push with lease" },
      { choice: "resume", label: "Resume development" },
      { choice: "close", label: "Close" },
    ]),
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

test("diverged action declares the Push-with-lease button next to resume/close", () => {
  const options = parseResponseOptions(divergedAction());
  assert.deepEqual(
    options.map((o) => o.choice),
    ["push_with_lease", "resume", "close"]
  );

  const html = renderToStaticMarkup(<HumanActionChoices options={options} onChoose={() => {}} />);
  assert.match(html, /Push with lease/);
  assert.match(html, /Resume development/);
  assert.match(html, /Close/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
});

test("diverged action context lines show the local and remote SHAs", () => {
  const lines = actionContextLines(divergedAction());
  const joined = lines.join("\n");
  assert.match(joined, new RegExp(LOCAL_SHA));
  assert.match(joined, new RegExp(REMOTE_SHA));
});

test("after a failed lease the moved remote tip is shown", () => {
  const action = divergedAction();
  action.evidenceJson = JSON.stringify({
    pushDivergence: {
      branch: "issue-1",
      localSha: LOCAL_SHA,
      remoteSha: REMOTE_SHA,
      ahead: 2,
      behind: 1,
      relationship: "diverged",
      observedRemoteSha: NEW_TIP,
      lastLeaseError: "stale info",
    },
  });
  const joined = actionContextLines(action).join("\n");
  assert.match(joined, new RegExp(NEW_TIP));
  assert.match(joined, /stale info/);
});

test("an action without push evidence shows no push line", () => {
  const action = divergedAction();
  action.evidenceJson = null;
  assert.ok(!actionContextLines(action).some((l) => l.startsWith("Push:")));
});
