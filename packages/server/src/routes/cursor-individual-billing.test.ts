// packages/server/src/routes/cursor-individual-billing.test.ts
//
// NOT-250: GET /api/cursor-individual-billing serves the experimental opt-in
// surface — disabled reads `enabled: false` N/A with no credential or
// dashboard access, and responses validate against the shared contract with
// no secret material.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-indiv-route-"));
process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH = "1";
process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = "1";
// Never poll providers from route tests: on-demand refreshes are covered
// against mocks in the adapter tests.
process.env.AGENT_DEALER_CODEX_CAPACITY_REFRESH = "off";
process.env.AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH = "off";
process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH = "off";

const { migrate } = await import("../db/index.js");
const { registerRoutes } = await import("./index.js");
const { CursorIndividualBilling } = await import("@agent-dealer/shared");
const { CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV } = await import(
  "../capacity/cursor-individual-credentials.js"
);

migrate();

let savedOptIn: string | undefined;
let savedCredFile: string | undefined;

beforeEach(() => {
  savedOptIn = process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY;
  savedCredFile = process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  delete process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY;
  delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
});

afterEach(() => {
  if (savedOptIn === undefined) delete process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY;
  else process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY = savedOptIn;
  if (savedCredFile === undefined) delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  else process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = savedCredFile;
});

async function buildApp() {
  const app = Fastify();
  await registerRoutes(app);
  return app;
}

test("disabled reads enabled:false N/A without credential or endpoint access", async () => {
  // A credential file exists — the disabled route must still never read it
  // (and there is no mock HTTP anyway: any attempt would throw or hang).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-indiv-route-creds-"));
  try {
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, JSON.stringify({ token: "route-secret-must-not-leak" }));
    process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = file;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/cursor-individual-billing" });
    assert.equal(res.statusCode, 200);
    const body = CursorIndividualBilling.parse(res.json());
    assert.equal(body.enabled, false);
    assert.equal(body.configured, false);
    assert.equal(body.source, "unavailable");
    assert.equal(body.unavailableReason, "missing");
    assert.equal(body.remainingPercent, null);
    assert.ok(
      !JSON.stringify(res.json()).includes("route-secret-must-not-leak"),
      "no credential material reaches the browser"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in without stored data reads enabled N/A (missing)", async () => {
  process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY = "experimental";
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/cursor-individual-billing" });
  assert.equal(res.statusCode, 200);
  const body = CursorIndividualBilling.parse(res.json());
  assert.equal(body.enabled, true);
  assert.equal(body.unavailableReason, "missing");
});
