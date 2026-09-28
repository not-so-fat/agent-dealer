// packages/server/src/routes/version.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { registerVersionRoute } from "./version.js";

test("NOT-279: /api/version reports the running server package version and pid", async () => {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const expected = (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string }).version;

  const app = Fastify();
  registerVersionRoute(app);
  const res = await app.inject({ method: "GET", url: "/api/version" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { version: string; pid: number; startedAt: string };
  assert.equal(body.version, expected);
  assert.equal(body.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)));
  await app.close();
});
