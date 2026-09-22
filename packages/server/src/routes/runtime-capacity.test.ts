// packages/server/src/routes/runtime-capacity.test.ts
//
// NOT-245: GET /api/runtime-capacity returns every configured runtime with
// its windows, freshness, and explicit unavailable reasons — and never leaks
// evidence refs or raw payloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-route-"));
process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH = "1";
process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = "1";

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { clearAllCapacitySnapshots } = await import("../repository/runtime-capacity.js");
const { fixtureMultiWindowAdapter } = await import("../capacity/adapter.js");
const { refreshCapacityFromAdapters } = await import("../capacity/service.js");
const { registerRoutes } = await import("./index.js");
const { RuntimeCapacityResponse } = await import("@agent-dealer/shared");

migrate();

async function buildApp() {
  const app = Fastify();
  await registerRoutes(app);
  return app;
}

test("GET /api/runtime-capacity returns normalized entries without evidence", async () => {
  clearAllCapacitySnapshots();
  createAgent({
    name: "route-a",
    runtime: "claude_code",
    deckId: "11111111-1111-4111-8111-111111111111",
  });
  createAgent({
    name: "route-b",
    runtime: "claude_code",
    deckId: "22222222-2222-4222-8222-222222222222",
  });
  const now = Date.now();
  await refreshCapacityFromAdapters([fixtureMultiWindowAdapter(now)], now);

  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/runtime-capacity" });
  assert.equal(res.statusCode, 200);
  const body = RuntimeCapacityResponse.parse(res.json());
  const claude = body.runtimes.filter((r) => r.runtime === "claude_code");
  assert.equal(claude.length, 1);
  assert.equal(claude[0].windows.length, 2);
  assert.ok(claude[0].windows.every((w) => w.unavailableReason === null));
  const raw = JSON.stringify(res.json());
  assert.ok(!raw.includes("evidence"), "no evidence pointers leak to the browser");
  await app.close();
});
