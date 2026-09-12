import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentCommand } from "./agent.js";
import { runIssueCommand } from "./issue.js";
import { runActionCommand } from "./action.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Stubs global fetch for the duration of `fn`, recording every call and answering with
 * `responses` in order — the CLI's HTTP commands only ever talk to the local API through
 * `fetch`, so this is the contract boundary worth pinning without a real server. */
async function withStubFetch<T>(
  responses: Array<{ status: number; body: unknown }>,
  fn: (calls: Call[]) => Promise<T>
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("agent list: discovers configured profiles via GET /api/agents", async () => {
  const agents = [{ id: "a1", name: "Dev", runtime: "claude", healthy: true }];
  await withStubFetch([{ status: 200, body: { agents, issueCount: 0 } }], async (calls) => {
    const originalLog = console.log;
    let logged = "";
    console.log = (msg: string) => (logged = msg);
    try {
      const code = await runAgentCommand(["list"]);
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/agents$/);
      assert.equal(calls[0].method, "GET");
      assert.deepEqual(JSON.parse(logged), { agents, issueCount: 0 });
    } finally {
      console.log = originalLog;
    }
  });
});

test("issue list: discovers issues via GET /api/issues with an optional status filter", async () => {
  const issues = [{ id: "i1", title: "T", status: "ready", currentOwner: null, currentIntent: null, updatedAt: "now", hasOpenHumanAction: false }];
  await withStubFetch([{ status: 200, body: issues }], async (calls) => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await runIssueCommand(["list", "--status", "ready,needs_human"]);
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/issues\?status=ready%2Cneeds_human$/);
    } finally {
      console.log = originalLog;
    }
  });
});

test("issue start: calls POST /api/issues/:id/start", async () => {
  await withStubFetch([{ status: 200, body: { instance: { id: "wf1" }, workItem: { id: "w1" } } }], async (calls) => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await runIssueCommand(["start", "issue-123"]);
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/issues\/issue-123\/start$/);
      assert.equal(calls[0].method, "POST");
    } finally {
      console.log = originalLog;
    }
  });
});

test("issue start: a failed API call is reported and returns a nonzero exit code", async () => {
  await withStubFetch([{ status: 409, body: { error: "not ready" } }], async () => {
    const originalError = console.error;
    let errored = "";
    console.error = (msg: string) => (errored = msg);
    try {
      const code = await runIssueCommand(["start", "issue-123"]);
      assert.equal(code, 1);
      assert.match(errored, /not ready/);
    } finally {
      console.error = originalError;
    }
  });
});

test("action list: exposes responseOptionsJson as structured choices", async () => {
  const actions = [
    {
      id: "act1",
      issueId: "issue-123",
      workflowInstanceId: null,
      actionType: "final_review",
      reason: "done",
      question: "Accept?",
      evidenceJson: null,
      responseOptionsJson: JSON.stringify([{ choice: "complete", label: "Accept" }]),
      continuationPreviewJson: null,
      status: "open",
      resolutionJson: null,
      resolvedBy: null,
      requestedAt: "now",
      resolvedAt: null,
    },
  ];
  await withStubFetch([{ status: 200, body: actions }], async () => {
    const originalLog = console.log;
    let logged = "";
    console.log = (msg: string) => (logged = msg);
    try {
      const code = await runActionCommand(["list"]);
      assert.equal(code, 0);
      const parsed = JSON.parse(logged);
      assert.deepEqual(parsed[0].choices, [{ choice: "complete", label: "Accept" }]);
    } finally {
      console.log = originalLog;
    }
  });
});

test("action resolve: calls POST /api/human-actions/:id/resolve with choice and resolvedBy", async () => {
  await withStubFetch([{ status: 200, body: { issueStatus: "done" } }], async (calls) => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = await runActionCommand(["resolve", "act1", "--choice", "complete", "--by", "agent-x"]);
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/human-actions\/act1\/resolve$/);
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, { choice: "complete", resolvedBy: "agent-x" });
    } finally {
      console.log = originalLog;
    }
  });
});

test("action resolve: missing required flags fails without calling the API", async () => {
  await withStubFetch([{ status: 200, body: {} }], async (calls) => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await runActionCommand(["resolve", "act1", "--choice", "complete"]);
      assert.equal(code, 1);
      assert.equal(calls.length, 0);
    } finally {
      console.error = originalError;
    }
  });
});
