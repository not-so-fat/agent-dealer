// packages/server/src/routes/issues.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-routes-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");

before(() => {
  migrate();
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  return app;
}

test("POST /api/issues creates an issue, GET lists it", async () => {
  const app = await buildApp();
  const createRes = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { title: "Fix login bug", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID },
  });
  assert.equal(createRes.statusCode, 200);
  const created = createRes.json() as { id: string; status: string };
  assert.equal(created.status, "ready");

  const listRes = await app.inject({ method: "GET", url: "/api/issues" });
  const list = listRes.json() as Array<{ id: string }>;
  assert.ok(list.some((i) => i.id === created.id));
  await app.close();
});

test("POST /api/issues is idempotent on (source, externalId)", async () => {
  const app = await buildApp();
  const payload = { title: "Linear task", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, source: "linear", externalId: "LIN-1" };
  const first = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string };
  const second = (await app.inject({ method: "POST", url: "/api/issues", payload })).json() as { id: string };
  assert.equal(first.id, second.id);
  await app.close();
});

test("GET /api/issues/:id returns header, timeline, forecast, actions, findings", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Detail issue", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { issue: { id: string }; timeline: unknown[]; forecast: { now: string }; humanActions: unknown[]; findings: unknown[]; usageSummary: unknown };
  assert.equal(body.issue.id, created.id);
  assert.ok(Array.isArray(body.timeline));
  assert.ok(body.forecast.now.length > 0);
  await app.close();
});

test("GET /api/issues/:id 404s for an unknown id", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/issues/does-not-exist" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST /api/issues/:id/start transitions to developing and is idempotent", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Start me", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const first = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(second.statusCode, 200); // idempotent, not a 409
  await app.close();
});

test("POST /api/issues/:id/guidance appends a guidance.added event", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Guide me", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/guidance`, payload: { markdown: "please prioritize this" } });
  assert.equal(res.statusCode, 200);
  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as { timeline: Array<{ type: string }> };
  assert.ok(detail.timeline.some((e) => e.type === "guidance.added"));
  await app.close();
});
