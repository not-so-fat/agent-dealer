import { test } from "node:test";
import assert from "node:assert/strict";
import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { runActionCommand } from "./action.js";
import { runAgentCommand } from "./agent.js";
import { runIssueCommand } from "./issue.js";

interface ExpectedCall {
  path: string;
  method: "GET" | "POST";
  response: unknown;
  body?: unknown;
}

function openAction(
  id: string,
  actionType: HumanActionType,
  choices: Array<{ choice: string; label: string }>,
): HumanAction {
  return {
    id,
    issueId: "00000000-0000-4000-a000-000000000010",
    runId: null,
    workflowInstanceId: null,
    actionType,
    reason: "Operator decision required",
    question: "Choose the next action",
    evidenceJson: null,
    responseOptionsJson: JSON.stringify(choices),
    continuationPreviewJson: null,
    requestId: null,
    status: "open",
    resolutionJson: null,
    resolvedBy: null,
    requestedAt: "2026-09-12T00:00:00.000Z",
    resolvedAt: null,
  };
}

test("agent-operated CLI contract: discover profiles/issues, start, inspect choices, and resolve every action type", async () => {
  const issueId = "00000000-0000-4000-a000-000000000010";
  const actions = [
    openAction("00000000-0000-4000-a000-000000000021", "product_scope_decision", [
      { choice: "resume", label: "Acceptance criteria added — start" },
    ]),
    openAction("00000000-0000-4000-a000-000000000022", "policy_escalation", [
      { choice: "resume", label: "Retry" },
      { choice: "close", label: "Close" },
    ]),
    openAction("00000000-0000-4000-a000-000000000023", "attempts_exhausted", [
      { choice: "retry", label: "Grant another round" },
      { choice: "close", label: "Close" },
    ]),
    openAction("00000000-0000-4000-a000-000000000024", "final_review", [
      { choice: "merge", label: "Merge" },
      { choice: "repair", label: "Request repair" },
      { choice: "close", label: "Close" },
    ]),
  ];
  const resolutions = ["resume", "resume", "retry", "merge"];
  const expected: ExpectedCall[] = [
    {
      path: "/api/agents",
      method: "GET",
      response: {
        agents: [
          {
            id: "00000000-0000-4000-a000-000000000001",
            runtime: "claude_code",
            defaultModel: "sonnet",
            workspaceRoot: "/repo",
            deckId: "00000000-0000-4000-a000-000000000100",
            deckName: "dev",
            healthy: true,
            issues: [],
          },
        ],
        issueCount: 0,
      },
    },
    {
      path: "/api/issues?status=ready%2Cneeds_human",
      method: "GET",
      response: [
        {
          id: issueId,
          status: "ready",
          currentOwner: "system",
          currentIntent: null,
          hasOpenHumanAction: false,
        },
      ],
    },
    {
      // NOT-118: start answers with the admission outcome — admitted (with the instance and
      // round-1 work item) or queued at a position with a wait reason.
      path: `/api/issues/${issueId}/start`,
      method: "POST",
      response: { state: "admitted", instance: { id: "wf-1" }, workItem: { id: "work-1", kind: "developer" } },
    },
    { path: "/api/human-actions", method: "GET", response: actions },
    ...actions.map((action, index): ExpectedCall => ({
      path: `/api/human-actions/${action.id}/resolve`,
      method: "POST",
      body: { choice: resolutions[index], resolvedBy: "cli-agent" },
      response: { issueStatus: index === actions.length - 1 ? "done" : "developing" },
    })),
  ];

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs: string[] = [];
  let callIndex = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = expected[callIndex++];
    assert.ok(call, `unexpected request: ${String(input)}`);
    assert.ok(String(input).endsWith(call.path), `expected ${call.path}, got ${String(input)}`);
    assert.equal(init?.method ?? "GET", call.method);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.deepEqual(body, call.body);
    return new Response(JSON.stringify(call.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  console.log = (message?: unknown) => logs.push(String(message));

  try {
    assert.equal(await runAgentCommand(["list"]), 0);
    assert.equal(await runIssueCommand(["list", "--status", "ready,needs_human"]), 0);
    assert.equal(await runIssueCommand(["start", issueId]), 0);
    assert.equal(await runActionCommand(["list"]), 0);
    for (let index = 0; index < actions.length; index += 1) {
      assert.equal(
        await runActionCommand([
          "resolve",
          actions[index].id,
          "--choice",
          resolutions[index],
          "--by",
          "cli-agent",
        ]),
        0,
      );
    }

    assert.equal(callIndex, expected.length);
    const listedActions = JSON.parse(logs[3]) as Array<HumanAction & { choices: unknown[] }>;
    assert.deepEqual(listedActions.map((action) => action.choices), actions.map((action) => JSON.parse(action.responseOptionsJson!)));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
