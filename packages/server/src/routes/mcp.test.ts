import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import cors from "@fastify/cors";
import Fastify, { type InjectOptions } from "fastify";

const home = mkdtempSync(join(tmpdir(), "dealer-mcp-"));
process.env.AGENT_DEALER_HOME = home;

const { closeDb, migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createHumanAction, getHumanAction } = await import("../repository/human-actions.js");
const { registerRoutes } = await import("./index.js");
const { registerIssueRoutes } = await import("./issues.js");
const { registerQueueRoutes } = await import("./queue.js");
const { registerHumanActionRoutes } = await import("./human-actions.js");
const { registerMcpRoutes } = await import("./mcp.js");

const app = Fastify();
const endpoint = new URL("http://127.0.0.1:2222/mcp");
const client = new Client({ name: "dealer-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint, {
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const response = await app.inject({
      method: request.method as InjectOptions["method"],
      url: new URL(request.url).pathname,
      headers: { ...Object.fromEntries(request.headers), host: endpoint.host },
      ...(request.body && { payload: await request.text() }),
    });
    assert.equal(response.headers["mcp-session-id"], undefined);
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, String(value));
    }
    return new Response(response.body || null, { status: response.statusCode, headers });
  },
});

const issueInput = {
  title: "MCP & REST parity",
  repo: "acme/app",
  developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
  reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
};

const realFetch = globalThis.fetch;
const originalLinearKey = process.env.LINEAR_API_KEY;

before(async () => {
  migrate();
  process.env.LINEAR_API_KEY = "test-key";
  // Exercise the real lookup route without contacting Linear.
  globalThis.fetch = async () => Response.json({
    data: {
      issue: {
        id: "fixture",
        identifier: "NOT-633",
        title: "MCP parity fixture",
        description: "Test issue",
        url: "https://linear.app/acme/issue/NOT-633/fixture",
        state: { name: "Todo" },
        team: { id: "team-1" },
        labels: { nodes: [] },
      },
    },
  });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
  await registerIssueRoutes(app);
  await registerQueueRoutes(app);
  await registerHumanActionRoutes(app);
  await registerMcpRoutes(app, 2222);
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await app.close();
  globalThis.fetch = realFetch;
  if (originalLinearKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalLinearKey;
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

async function rest(options: InjectOptions) {
  const response = await app.inject(options);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(Array.isArray(result.content));
  const [content] = result.content;
  assert.equal(content.type, "text");
  return JSON.parse(content.text);
}

test("lists exactly the nine tools with read/write annotations", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  assert.deepEqual(Object.fromEntries(tools.map(({ name, annotations }) => [name, annotations?.readOnlyHint])), {
    list_agents: true,
    lookup_linear_issue: true,
    list_issues: true,
    get_issue: true,
    get_queue: true,
    list_human_actions: true,
    create_issue: false,
    add_guidance: false,
    resolve_human_action: false,
  });
  const create = tools.find(({ name }) => name === "create_issue");
  assert.deepEqual(create?.inputSchema.required, ["title", "repo", "developerAgentId", "reviewerAgentId"]);
});

test("read tools return the REST JSON", async () => {
  const issue = await rest({ method: "POST", url: "/api/issues", payload: issueInput });
  const ref = "https://linear.app/acme/issue/NOT-633/fixture";
  const query = { q: issueInput.title, status: issue.status, page: 1, limit: 5 };
  assert.deepEqual(await call("list_agents"), await rest({ url: "/api/agents" }));
  assert.deepEqual(await call("lookup_linear_issue", { ref }),
    await rest({ url: "/api/intake/linear/lookup", query: { q: ref } }));
  assert.deepEqual(await call("list_issues"), await rest({ url: "/api/issues" }));
  assert.deepEqual(await call("list_issues", query),
    await rest({ url: "/api/issues", query: { ...query, page: "1", limit: "5" } }));
  assert.deepEqual(await call("get_issue", { issueId: issue.id }), await rest({ url: `/api/issues/${issue.id}` }));
  assert.deepEqual(await call("get_queue"), {
    queue: await rest({ url: "/api/queue" }),
    status: await rest({ url: "/api/queue/status" }),
  });
  createHumanAction({
    issueId: issue.id,
    actionType: "reflection_interaction_required",
    reason: "Reflection paused",
    question: "Retry?",
  });
  assert.deepEqual(await call("list_human_actions"), await rest({ url: "/api/human-actions" }));
});

test("create_issue returns the REST JSON and enqueues when requested", async () => {
  const payload = { ...issueInput, enqueue: true };
  const result = await call("create_issue", payload);
  const direct = await rest({ method: "POST", url: "/api/issues", payload });
  // Independent creates mint their own IDs and timestamps.
  const { id, createdAt, updatedAt, ...report } = result;
  const { id: directId, createdAt: directCreatedAt, updatedAt: directUpdatedAt, ...directReport } = direct;
  assert.notEqual(id, directId);
  assert.ok(createdAt && updatedAt && directCreatedAt && directUpdatedAt);
  assert.deepEqual(report, directReport);
  assert.equal(result.created, true);
  assert.equal(result.queue, "enqueued");
  const queue = await rest({ url: "/api/queue" });
  assert.ok(queue.some((entry: { issueId: string }) => entry.issueId === id));
});

test("add_guidance and resolve_human_action return the REST JSON", async () => {
  const { id: issueId } = await rest({
    method: "POST", url: "/api/issues", payload: { ...issueInput, enqueue: false },
  });
  const markdown = "Use the existing helper.";
  const guidance = await call("add_guidance", { issueId, markdown });
  const directGuidance = await rest({ method: "POST", url: `/api/issues/${issueId}/guidance`, payload: { markdown } });
  // Each call appends a distinct event.
  assert.notEqual(guidance.id, directGuidance.id);
  assert.deepEqual(guidance, { ...directGuidance, id: guidance.id, ts: guidance.ts });

  const newAction = () => createHumanAction({
    issueId,
    actionType: "reflection_interaction_required",
    reason: "Reflection paused",
    question: "Retry?",
  });
  const action = newAction();
  const directAction = newAction();
  const resolution = { choice: "dismiss", note: "Handled in this test." };
  assert.deepEqual(await call("resolve_human_action", { actionId: action.id, ...resolution }),
    await rest({
      method: "POST", url: `/api/human-actions/${directAction.id}/resolve`,
      payload: { ...resolution, resolvedBy: "agent" },
    }));
  assert.equal(getHumanAction(action.id)?.resolvedBy, "agent");
});

test("a REST 404 becomes a tool error containing the status and body", async () => {
  const issueId = "unknown-issue";
  const direct = await app.inject({ url: `/api/issues/${issueId}` });
  assert.equal(direct.statusCode, 404);
  const result = await client.callTool({ name: "get_issue", arguments: { issueId } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: `HTTP 404: ${direct.body}` }]);
});

test("rejects invalid Host and Origin before a write can run", async () => {
  const args = { ...issueInput, title: "Blocked MCP request" };
  for (const headers of [
    { host: "evil.example" },
    { host: "127.0.0.1:2223" },
    { host: endpoint.host, origin: "https://evil.example" },
    { host: endpoint.host, origin: "http://localhost@evil.example" },
    { host: endpoint.host, origin: "null" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_issue", arguments: args } },
    });
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.deepEqual(await rest({ url: "/api/issues", query: { q: args.title, page: "1" } }).then((page) => page.issues), []);
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/mcp",
    headers: { host: endpoint.host, origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.equal(preflight.statusCode, 403);

  const allowed = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { host: "localhost:2222", origin: "http://127.0.0.1:1111", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.match(String(allowed.headers["content-type"]), /^application\/json/);
  assert.equal(allowed.json().result.tools.length, 9);
});
