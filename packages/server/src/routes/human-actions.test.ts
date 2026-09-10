import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-action-routes-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, transitionIssue } = await import("../repository/issues.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { registerHumanActionRoutes } = await import("./human-actions.js");

before(() => {
  migrate();
});

async function buildApp() {
  const app = Fastify();
  await registerHumanActionRoutes(app);
  return app;
}

function seedIssueAwaitingFinalReview() {
  const issue = createIssue({ title: "Awaiting review", repo: "/repo", baseBranch: "main", developerAgentId: BUILTIN_AGENT_CLAUDE_ID, reviewerAgentId: BUILTIN_AGENT_CURSOR_ID, maxReviewRounds: 3, source: "manual" });
  transitionIssue(issue.id, "developing");
  transitionIssue(issue.id, "reviewing");
  transitionIssue(issue.id, "final_review", { currentOwner: "human" });
  const action = createHumanAction({ issueId: issue.id, actionType: "final_review", reason: "Reviewer approved", question: "Accept?" });
  return { issue, action };
}

test("GET /api/human-actions lists only open actions", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "GET", url: "/api/human-actions" });
  const list = res.json() as Array<{ id: string; status: string }>;
  assert.ok(list.some((a) => a.id === action.id && a.status === "open"));
  await app.close();
});

test("resolving final_review as complete marks the issue done", async () => {
  const app = await buildApp();
  const { issue, action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(res.statusCode, 200);
  assert.equal(getIssue(issue.id)?.status, "done");
  const after = await app.inject({ method: "GET", url: "/api/human-actions" });
  assert.equal((after.json() as unknown[]).some((a: any) => a.id === action.id), false);
  await app.close();
});

test("resolving an already-resolved action returns its resolved state instead of erroring", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  const second = await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "complete" } });
  assert.equal(second.statusCode, 200);
  const body = second.json() as { status: string };
  assert.equal(body.status, "resolved");
  await app.close();
});

test("resolving final_review as repair sends the issue back to repairing", async () => {
  const app = await buildApp();
  const { issue, action } = seedIssueAwaitingFinalReview();
  await app.inject({ method: "POST", url: `/api/human-actions/${action.id}/resolve`, payload: { resolvedBy: "yusuke", choice: "repair" } });
  assert.equal(getIssue(issue.id)?.status, "repairing");
  await app.close();
});
