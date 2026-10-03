// NOT-314: the operator_verification action renders in the existing
// human-action UI list (label + server-declared options + context line)
// without a new page. Pure logic (no React/DOM); run via tsx + node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HumanAction } from "@agent-dealer/shared";
import { actionContextLines, actionLabel, parseResponseOptions } from "./humanActions.js";

function action(over: Partial<HumanAction>): HumanAction {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    issueId: "00000000-0000-4000-8000-000000000001",
    runId: null,
    workflowInstanceId: null,
    actionType: "operator_verification",
    reason: "Reviewer approved abc123, but 1 acceptance criterion requires a human operator",
    question: "Paste the probe output to record verification, waive with a reason, or repair?",
    evidenceJson: null,
    responseOptionsJson: null,
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: "2026-10-03T00:00:00.000Z",
    resolvedAt: null,
    ...over,
  } as HumanAction;
}

test("operator_verification has a label without a new page", () => {
  assert.equal(actionLabel("operator_verification"), "Operator verification");
});

test("existing action labels are unchanged", () => {
  assert.equal(actionLabel("final_review"), "Final review");
  assert.equal(actionLabel("policy_escalation"), "Policy escalation");
  assert.equal(actionLabel("muse_capability"), "Muse capability");
});

test("the server-declared verified/waive/repair options parse through", () => {
  const options = parseResponseOptions(
    action({
      responseOptionsJson: JSON.stringify([
        { choice: "verified", label: "Verified — merge" },
        { choice: "waive", label: "Waive — merge without it" },
        { choice: "repair", label: "Another repair round" },
      ]),
    })
  );
  assert.deepEqual(
    options.map((o) => o.choice),
    ["verified", "waive", "repair"]
  );
});

test("operator evidence renders a context line naming the count and gated head", () => {
  const lines = actionContextLines(
    action({
      evidenceJson: JSON.stringify({
        operatorVerification: {
          criteria: [
            {
              text: "Operator can sign in with SSO [operator]",
              commands: ["`npm run probe:sso -- --env staging`"],
            },
          ],
          headSha: "abc123def456",
        },
      }),
    })
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /1 criterion/);
  assert.match(lines[0]!, /abc123de/);
});

test("actions without operator evidence render no operator line", () => {
  assert.deepEqual(actionContextLines(action({})), []);
});
