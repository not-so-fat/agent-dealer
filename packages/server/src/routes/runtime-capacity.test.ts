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
// Never spawn a real provider from route tests: the on-demand Codex refresh is
// covered against the fake App Server in codex-app-server.test.ts.
process.env.AGENT_DEALER_CODEX_CAPACITY_REFRESH = "off";

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { clearAllCapacitySnapshots, listCapacitySnapshots, recordCapacitySnapshots } = await import(
  "../repository/runtime-capacity.js"
);
const { fixtureMultiWindowAdapter, normalizeAdapterWindow } = await import("../capacity/adapter.js");
const { refreshCapacityFromAdapters } = await import("../capacity/service.js");
const { resetMuseCapacityRefreshState } = await import("../capacity/muse.js");
const { refreshCodexCapacityFromAppServer } = await import("../capacity/codex-app-server.js");
const { registerRoutes } = await import("./index.js");
const { RuntimeCapacityResponse } = await import("@agent-dealer/shared");

const FAKE_CODEX = new URL("../capacity/fixtures/fake-codex-app-server.mjs", import.meta.url).pathname;

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

test("GET triggers the Muse refresh when muse_code is configured", async () => {
  // NOT-247: the route is the only production trigger for the Muse adapter.
  // No credential here (env key removed, empty login dir), so the refresh
  // short-circuits to a `missing` sentinel without spawning anything live.
  clearAllCapacitySnapshots();
  resetMuseCapacityRefreshState();
  const prevKey = process.env.META_API_KEY;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.META_API_KEY;
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-noauth-"));
  try {
    createAgent({
      name: "route-muse",
      runtime: "muse_code",
      deckId: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(listCapacitySnapshots("muse_code").length, 0);
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/runtime-capacity" });
      assert.equal(res.statusCode, 200);
      const body = RuntimeCapacityResponse.parse(res.json());
      const muse = body.runtimes.find((r) => r.runtime === "muse_code");
      assert.ok(muse, "muse_code entry served");
      // The refresh runs in the background (GET never blocks on it), so
      // poll briefly for the persisted sentinel.
      const deadline = Date.now() + 5000;
      while (
        !listCapacitySnapshots("muse_code").some((w) => w.windowKey === "muse_account_usage") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(
        listCapacitySnapshots("muse_code").some((w) => w.windowKey === "muse_account_usage"),
        "route-triggered refresh persisted the sentinel"
      );
    } finally {
      await app.close();
    }
  } finally {
    if (prevKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = prevKey;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    resetMuseCapacityRefreshState();
  }
});

test("GET serves one logical Codex pair after a dedup refresh of legacy duplicates", async () => {
  // NOT-263: databases written by older versions hold both the aggregate
  // aliases (`codex_rate_limit_primary/secondary`) and the detailed rows for
  // the same logical pair. One refresh against a mirroring payload must
  // delete the aliases, and GET must serve each logical window once.
  clearAllCapacitySnapshots();
  createAgent({
    name: "route-codex-dedup",
    runtime: "codex_local",
    deckId: "55555555-5555-4555-8555-555555555555",
  });
  const seedNow = Date.now();
  const seedObserved = new Date(seedNow).toISOString();
  const seed = (windowKey: string, providerBucket: string, durationMinutes: number) =>
    normalizeAdapterWindow(
      "codex_local",
      {
        windowKey,
        providerBucket,
        durationMinutes,
        providerLabel: providerBucket,
        usedValue: 9,
        usedUnit: "percent",
        usedPercent: 9,
        resetAt: new Date(seedNow + 2 * 3600_000).toISOString(),
        observedAt: seedObserved,
        source: "supported_protocol",
      },
      seedNow
    );
  recordCapacitySnapshots("codex_local", [
    seed("codex_rate_limit_primary", "primary", 300),
    seed("codex_rate_limit_secondary", "secondary", 10080),
    seed("codex_limit_main_primary", "main/primary", 300),
    seed("codex_limit_main_secondary", "main/secondary", 10080),
  ]);
  assert.equal(listCapacitySnapshots("codex_local").length, 4);

  const now = Date.now();
  await refreshCodexCapacityFromAppServer({
    command: process.execPath,
    args: [FAKE_CODEX],
    env: { FAKE_CODEX_MODE: "mirror", FAKE_CODEX_NOW_MS: String(now) },
    timeoutMs: 10_000,
    nowMs: now,
  });

  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/runtime-capacity" });
    assert.equal(res.statusCode, 200);
    const body = RuntimeCapacityResponse.parse(res.json());
    const codex = body.runtimes.find((r) => r.runtime === "codex_local");
    assert.ok(codex, "codex_local entry served");
    assert.equal(codex.unavailableReason, null);
    const keys = codex.windows.map((w) => w.windowKey);
    assert.ok(!keys.some((k) => k.startsWith("codex_rate_limit_")), `no aggregate aliases, got ${keys}`);
    // Mirrored `main` pair renders once (5H + weekly); the genuinely
    // distinct `extra` bucket renders as its own pair.
    assert.deepEqual([...keys].sort(), [
      "codex_limit_extra_primary",
      "codex_limit_extra_secondary",
      "codex_limit_main_primary",
      "codex_limit_main_secondary",
    ]);
    const mainPrimary = codex.windows.find((w) => w.windowKey === "codex_limit_main_primary")!;
    assert.equal(mainPrimary.displayLabel, "5H");
    assert.equal(mainPrimary.remainingPercent, 30);
    const raw = JSON.stringify(res.json());
    assert.ok(!raw.includes("evidence"), "no evidence pointers leak to the browser");
  } finally {
    await app.close();
  }
});

test("GET /api/runtime-capacity serves a configured Codex account without spawning", async () => {
  clearAllCapacitySnapshots();
  createAgent({
    name: "route-codex",
    runtime: "codex_local",
    deckId: "44444444-4444-4434-8444-444444444444",
  });
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/runtime-capacity" });
  assert.equal(res.statusCode, 200);
  const body = RuntimeCapacityResponse.parse(res.json());
  const codex = body.runtimes.filter((r) => r.runtime === "codex_local");
  assert.equal(codex.length, 1);
  // Refresh is off in route tests, so a snapshot-less account reads `missing`.
  assert.equal(codex[0].unavailableReason, "missing");
  await app.close();
});
