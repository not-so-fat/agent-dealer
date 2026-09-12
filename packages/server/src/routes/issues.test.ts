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
const { transitionIssue } = await import("../repository/issues.js");

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

test("GET /api/issues/:id returns header, timeline, actions, findings, usage, readiness, metrics", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Detail issue", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };
  const res = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    issue: { id: string };
    timeline: unknown[];
    humanActions: unknown[];
    findings: unknown[];
    usageSummary: unknown;
    readiness: { ok: boolean; missing: string[] };
    humanWaitMs: number;
    interventionCount: number;
    latestWorkflowInstance: unknown;
  };
  assert.equal(body.issue.id, created.id);
  assert.ok(Array.isArray(body.timeline));
  assert.ok(Array.isArray(body.humanActions));
  assert.ok(Array.isArray(body.findings));
  assert.ok(body.usageSummary);
  // No acceptanceCriteria was given at create time — not startable yet.
  assert.equal(body.readiness.ok, false);
  assert.ok(body.readiness.missing.includes("acceptance criteria"));
  assert.equal(body.humanWaitMs, 0);
  assert.equal(body.interventionCount, 0);
  assert.equal(body.latestWorkflowInstance, null);
  await app.close();
});

test("PATCH /api/issues/:id updates editable fields and satisfies the readiness gate", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Underspecified", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/issues/${created.id}`,
    payload: { acceptanceCriteria: "It compiles and tests pass" },
  });
  assert.equal(patchRes.statusCode, 200);
  const patched = patchRes.json() as { acceptanceCriteria: string | null };
  assert.equal(patched.acceptanceCriteria, "It compiles and tests pass");

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    readiness: { ok: boolean };
  };
  assert.equal(detail.readiness.ok, true);
  await app.close();
});

test("PATCH /api/issues/:id rejects an edit while a workflow is active", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Active workflow",
        repo: "/repo",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "Ready to go",
      },
    })
  ).json() as { id: string };
  const startRes = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(startRes.statusCode, 200);

  const patchRes = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload: { title: "Renamed" } });
  assert.equal(patchRes.statusCode, 409);
  await app.close();
});

test("PATCH /api/issues/:id rejects an edit to a terminal (done) issue even though it has no active workflow", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Completed issue",
        repo: "/repo",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "Ready to go",
      },
    })
  ).json() as { id: string };
  // Drive it to a terminal status directly — a `done` issue has no active workflow
  // instance either, which is exactly the gap: "no active instance" alone must not be
  // read as "editable."
  transitionIssue(created.id, "developing");
  transitionIssue(created.id, "reviewing");
  transitionIssue(created.id, "final_review");
  transitionIssue(created.id, "done");

  const patchRes = await app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload: { title: "Renamed" } });
  assert.equal(patchRes.statusCode, 409);
  await app.close();
});

test("POST /api/issues/:id/start with acceptance criteria starts the workflow", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Startable",
        repo: "/repo",
        baseBranch: "main",
        developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
        reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
        acceptanceCriteria: "It works",
      },
    })
  ).json() as { id: string };

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { instance: { id: string }; workItem: { id: string; kind: string } };
  assert.ok(body.instance.id);
  assert.equal(body.workItem.kind, "developer");

  const detail = (await app.inject({ method: "GET", url: `/api/issues/${created.id}` })).json() as {
    issue: { status: string };
  };
  assert.equal(detail.issue.status, "developing");
  await app.close();
});

test("POST /api/issues/:id/start without acceptance criteria opens a product_scope_decision", async () => {
  const app = await buildApp();
  const created = (
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "Underspecified start", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID } })
  ).json() as { id: string };

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/start` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { needsScopeDecision: { actionType: string } };
  assert.equal(body.needsScopeDecision.actionType, "product_scope_decision");
  await app.close();
});

test("POST /api/issues/:id/start 404s for an unknown id", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "POST", url: "/api/issues/does-not-exist/start" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /api/issues/:id 404s for an unknown id", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/issues/does-not-exist" });
  assert.equal(res.statusCode, 404);
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
