// packages/server/src/static-ui.test.ts
// NOT-142: packaged Fastify must SPA-fallback client routes so reload/deep-link work.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

const uiDist = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-static-ui-"));
fs.writeFileSync(
  path.join(uiDist, "index.html"),
  "<!doctype html><html><body>agent-dealer-spa</body></html>\n"
);
process.env.AGENT_DEALER_UI_DIST = uiDist;

const { registerStaticUi } = await import("./static-ui.js");

after(() => {
  fs.rmSync(uiDist, { recursive: true, force: true });
  delete process.env.AGENT_DEALER_UI_DIST;
});

async function buildApp() {
  const app = Fastify();
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/ping", async () => ({ ok: true }));
  await registerStaticUi(app);
  return app;
}

test("NOT-142: unknown non-API paths serve index.html for SPA deep links", async () => {
  const app = await buildApp();
  for (const url of ["/issues", "/issues/abc-123", "/agents", "/typo-path"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, url);
    assert.match(res.body, /agent-dealer-spa/, url);
  }
  await app.close();
});

test("NOT-142: /api/* and /health keep not-found/health semantics (no SPA catch-all)", async () => {
  const app = await buildApp();

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });

  const apiOk = await app.inject({ method: "GET", url: "/api/ping" });
  assert.equal(apiOk.statusCode, 200);

  const apiMissing = await app.inject({ method: "GET", url: "/api/does-not-exist" });
  assert.equal(apiMissing.statusCode, 404);
  assert.deepEqual(apiMissing.json(), { error: "Not found" });

  await app.close();
});
