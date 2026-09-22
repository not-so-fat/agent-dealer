// packages/server/src/routes/cursor-team-billing.test.ts
//
// NOT-249: GET /api/cursor-team-billing serves the normalized team snapshot
// without the Admin API key — and never performs live HTTP in tests (the
// on-demand refresh is covered against mock fetch in cursor-team.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-team-route-"));
process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH = "1";
process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = "1";
// Never poll a provider from route tests.
process.env.AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH = "off";
delete process.env.CURSOR_ADMIN_API_KEY;

const { migrate } = await import("../db/index.js");
const { clearCursorTeamBilling, writeCursorTeamBillingRow } = await import(
  "../repository/cursor-team-billing.js"
);
const { registerRoutes } = await import("./index.js");
const { CursorTeamBilling } = await import("@agent-dealer/shared");

migrate();

async function buildApp() {
  const app = Fastify();
  await registerRoutes(app);
  return app;
}

test("without a key the route reads unconfigured with no secret leakage", async () => {
  delete process.env.CURSOR_ADMIN_API_KEY;
  clearCursorTeamBilling();
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/cursor-team-billing" });
  assert.equal(res.statusCode, 200);
  const body = CursorTeamBilling.parse(res.json());
  assert.equal(body.configured, false);
  assert.equal(body.unavailableReason, "missing");
  assert.equal(body.spendValue, null);
  const raw = JSON.stringify(res.json());
  assert.ok(!raw.includes("CURSOR_ADMIN_API_KEY"), "env name leaked");
  assert.ok(!raw.includes("evidence"), "no evidence pointers leak to the browser");
  await app.close();
});

test("with a key the route serves the stored snapshot in reported units", async () => {
  process.env.CURSOR_ADMIN_API_KEY = "route-test-key";
  try {
    clearCursorTeamBilling();
    const now = Date.now();
    writeCursorTeamBillingRow({
      cycleStart: "2026-09-01T00:00:00.000Z",
      cycleEnd: null,
      spendValue: 1250,
      spendUnit: "cents",
      hardLimitValue: null,
      hardLimitUnit: null,
      memberCount: 2,
      memberLimitOverrideCount: 1,
      usagePeriodStart: new Date(now - 30 * 24 * 3600_000).toISOString(),
      usagePeriodEnd: new Date(now).toISOString(),
      usageSpendValue: null,
      usageSpendUnit: null,
      source: "supported_protocol",
      unavailableReason: null,
      observedAt: new Date(now - 60_000).toISOString(),
      freshUntil: new Date(now + 600_000).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
      evidenceRef: "cursor-admin-api:teams/spend",
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/cursor-team-billing" });
    assert.equal(res.statusCode, 200);
    const body = CursorTeamBilling.parse(res.json());
    assert.equal(body.configured, true);
    assert.equal(body.unavailableReason, null);
    assert.equal(body.spendValue, 1250);
    assert.equal(body.spendUnit, "cents");
    assert.equal(body.hardLimitValue, null);
    assert.equal(body.memberCount, 2);
    assert.equal(body.memberLimitOverrideCount, 1);
    assert.equal(body.cycleEnd, null);
    const raw = JSON.stringify(res.json());
    assert.ok(!raw.includes("route-test-key"), "key leaked to the browser");
    assert.ok(!raw.includes("evidence"), "no evidence pointers leak to the browser");
    await app.close();
  } finally {
    delete process.env.CURSOR_ADMIN_API_KEY;
  }
});
