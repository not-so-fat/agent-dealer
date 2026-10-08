// packages/server/src/routes/queue.test.ts
import { test, before, beforeEach, afterEach } from "node:test";
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

const savedEnv = {
  MAX_COORDINATOR_CONCURRENCY: process.env.MAX_COORDINATOR_CONCURRENCY,
  MAX_CONCURRENT_RUNS: process.env.MAX_CONCURRENT_RUNS,
};

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
  // NOT-215: the persisted concurrency setting must not leak between tests.
  getDb().prepare("DELETE FROM intake_settings WHERE key = 'admission.maxActiveIssues'").run();
  // NOT-378: ceiling assertions assume no environment overrides.
  delete process.env.MAX_COORDINATOR_CONCURRENCY;
  delete process.env.MAX_CONCURRENT_RUNS;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

test("NOT-215: GET /api/queue/status reports the truthful admission read model", async () => {
  const f = await app();
  const res = await f.inject({ method: "GET", url: "/api/queue/status" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    active: 0,
    waiting: 0,
    limit: 1,
    maxActiveIssues: 1,
    // NOT-378: default five-process ceiling, options 1–5.
    ceiling: 5,
    options: [1, 2, 3, 4, 5],
    overCap: false,
  });
  await f.close();
});

test("NOT-215: PUT /api/queue/settings persists 1..5 and the status reflects it", async () => {
  const f = await app();
  for (const value of [1, 2, 3, 4, 5]) {
    const put = await f.inject({
      method: "PUT",
      url: "/api/queue/settings",
      payload: { maxActiveIssues: value },
    });
    assert.equal(put.statusCode, 200, `accepts ${value}`);
    assert.equal(put.json().maxActiveIssues, value);
    assert.equal(put.json().limit, value);
  }

  const status = await f.inject({ method: "GET", url: "/api/queue/status" });
  assert.equal(status.json().maxActiveIssues, 5);
  assert.equal(status.json().limit, 5);
  await f.close();
});

test("NOT-215: the persisted limit survives a server restart (fresh app, same DB)", async () => {
  const f = await app();
  const put = await f.inject({
    method: "PUT",
    url: "/api/queue/settings",
    payload: { maxActiveIssues: 5 },
  });
  assert.equal(put.statusCode, 200);
  await f.close();

  const restarted = await app();
  const status = await restarted.inject({ method: "GET", url: "/api/queue/status" });
  assert.equal(status.json().maxActiveIssues, 5);
  assert.equal(status.json().limit, 5);
  await restarted.close();
});

test("NOT-215: PUT /api/queue/settings rejects values outside 1..5", async () => {
  const f = await app();
  for (const payload of [
    { maxActiveIssues: 0 },
    { maxActiveIssues: 6 },
    { maxActiveIssues: 99 },
    { maxActiveIssues: 1.5 },
    { maxActiveIssues: "x" },
    {},
  ]) {
    const res = await f.inject({ method: "PUT", url: "/api/queue/settings", payload });
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(payload)}`);
    assert.equal(typeof res.json().error, "string");
  }
  // A rejected write leaves the stored value alone.
  const status = await f.inject({ method: "GET", url: "/api/queue/status" });
  assert.equal(status.json().maxActiveIssues, 1);
  await f.close();
});

test("NOT-378: PUT /api/queue/settings rejects a value above the effective ceiling", async () => {
  process.env.MAX_COORDINATOR_CONCURRENCY = "3";
  const f = await app();
  const res = await f.inject({
    method: "PUT",
    url: "/api/queue/settings",
    payload: { maxActiveIssues: 4 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(
    res.json().error,
    "maxActiveIssues 4 exceeds the effective worker/spawn ceiling of 3"
  );

  const status = await f.inject({ method: "GET", url: "/api/queue/status" });
  assert.equal(status.json().maxActiveIssues, 1, "a rejected write leaves the stored value alone");
  assert.equal(status.json().ceiling, 3);
  assert.deepEqual(status.json().options, [1, 2, 3]);
  await f.close();
});
