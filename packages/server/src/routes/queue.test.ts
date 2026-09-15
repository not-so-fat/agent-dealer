// packages/server/src/routes/queue.test.ts
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-queue-routes-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { registerQueueRoutes } = await import("./queue.js");
const { startWorkflow } = await import("../coordinator/commands.js");

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM queue_entries;
    DELETE FROM work_items;
    DELETE FROM workflow_events;
    DELETE FROM workflow_instances;
    DELETE FROM human_actions;
    DELETE FROM artifacts;
    DELETE FROM issues;
  `);
});

async function app() {
  const f = Fastify();
  await registerQueueRoutes(f);
  return f;
}

function issue() {
  return createIssue({
    title: "Q",
    acceptanceCriteria: "ok",
    repo: "/r",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    source: "manual",
  });
}

test("POST /api/queue enqueues; GET lists; DELETE dequeues", async () => {
  const f = await app();
  const i = issue();
  const post = await f.inject({ method: "POST", url: "/api/queue", payload: { issueId: i.id } });
  assert.equal(post.statusCode, 200);
  const body = post.json();
  assert.equal(body.issueId, i.id);
  assert.equal(body.state, "queued");

  const list = await f.inject({ method: "GET", url: "/api/queue" });
  assert.equal(list.statusCode, 200);
  const entries = list.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Q");

  const del = await f.inject({ method: "DELETE", url: `/api/queue/${i.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().state, "removed");

  const empty = await f.inject({ method: "GET", url: "/api/queue" });
  assert.equal(empty.json().length, 0);
  await f.close();
});

test("POST /api/queue rejects terminal and active-workflow issues", async () => {
  const f = await app();
  const i = issue();
  startWorkflow(i.id);
  const res = await f.inject({ method: "POST", url: "/api/queue", payload: { issueId: i.id } });
  assert.equal(res.statusCode, 409);
  await f.close();
});

test("POST /api/queue is idempotent when already queued", async () => {
  const f = await app();
  const i = issue();
  const first = await f.inject({ method: "POST", url: "/api/queue", payload: { issueId: i.id } });
  const second = await f.inject({ method: "POST", url: "/api/queue", payload: { issueId: i.id } });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().id, second.json().id);
  await f.close();
});
