// NOT-260: GET/PUT /api/settings/repository-mappings — normalized round
// trip plus HTTP 400 with a readable error that preserves the last valid array.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-repo-mappings-routes-"));

const { migrate } = await import("../db/index.js");
const { registerRepositoryMappingsRoutes } = await import("./repository-mappings.js");

before(() => {
  migrate();
});

async function buildApp() {
  const app = Fastify();
  await registerRepositoryMappingsRoutes(app);
  return app;
}

test("GET returns { mappings: [] } on a fresh install", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/settings/repository-mappings" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { mappings: [] });
});

test("PUT persists and returns normalized mappings", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/repository-mappings",
    payload: { mappings: [{ label: "agent-dealer", repository: "not-so-fat/agent-dealer" }] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    mappings: [{ label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" }],
  });

  const get = await app.inject({ method: "GET", url: "/api/settings/repository-mappings" });
  assert.deepEqual(get.json(), {
    mappings: [{ label: "agent-dealer", repository: "github.com/not-so-fat/agent-dealer" }],
  });
});

test("PUT editing the repository overwrites the label's value", async () => {
  const app = await buildApp();
  await app.inject({
    method: "PUT",
    url: "/api/settings/repository-mappings",
    payload: { mappings: [{ label: "agent-dealer", repository: "not-so-fat/agent-dealer" }] },
  });
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/repository-mappings",
    payload: { mappings: [{ label: "agent-dealer", repository: "not-so-fat/other" }] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    mappings: [{ label: "agent-dealer", repository: "github.com/not-so-fat/other" }],
  });
});

test("PUT with duplicate normalized labels returns 400 and preserves the array", async () => {
  const app = await buildApp();
  await app.inject({
    method: "PUT",
    url: "/api/settings/repository-mappings",
    payload: { mappings: [{ label: "agent-dealer", repository: "not-so-fat/other" }] },
  });
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/repository-mappings",
    payload: {
      mappings: [
        { label: "agent-dealer", repository: "not-so-fat/agent-dealer" },
        { label: " AGENT-DEALER ", repository: "not-so-fat/other" },
      ],
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: string };
  assert.ok(body.error && body.error.length > 0, "readable error");

  const get = await app.inject({ method: "GET", url: "/api/settings/repository-mappings" });
  assert.deepEqual(get.json(), {
    mappings: [{ label: "agent-dealer", repository: "github.com/not-so-fat/other" }],
  });
});

test("PUT with empty labels, invalid repos, or 101 rows returns 400 atomically", async () => {
  const app = await buildApp();
  await app.inject({
    method: "PUT",
    url: "/api/settings/repository-mappings",
    payload: { mappings: [{ label: "keep", repository: "a/b" }] },
  });
  const lastValid = { mappings: [{ label: "keep", repository: "github.com/a/b" }] };

  for (const payload of [
    { mappings: [{ label: "   ", repository: "a/b" }] },
    { mappings: [{ label: "ok", repository: "not a repo!!" }] },
    {
      mappings: Array.from({ length: 101 }, (_, i) => ({ label: `l${i}`, repository: "a/b" })),
    },
    { mappings: "nope" },
  ]) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/repository-mappings",
      payload,
    });
    assert.equal(res.statusCode, 400);
    assert.ok((res.json() as { error?: string }).error, "readable error");
  }

  const get = await app.inject({ method: "GET", url: "/api/settings/repository-mappings" });
  assert.deepEqual(get.json(), lastValid);
});
