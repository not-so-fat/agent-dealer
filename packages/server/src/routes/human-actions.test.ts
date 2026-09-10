import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-action-routes-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, transitionIssue } = await import("../repository/issues.js");
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

// NOT-58: the global queue is read-only. Typed resolution + continuation land in NOT-64.
test("GET /api/human-actions lists only open actions", async () => {
  const app = await buildApp();
  const { action } = seedIssueAwaitingFinalReview();
  const res = await app.inject({ method: "GET", url: "/api/human-actions" });
  const list = res.json() as Array<{ id: string; status: string }>;
  assert.ok(list.some((a) => a.id === action.id && a.status === "open"));
  await app.close();
});
