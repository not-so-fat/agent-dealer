// NOT-242: intake routes surface the server-resolved `repo:` hint on candidates.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-intake-linear-"));

const { migrate } = await import("../db/index.js");
const { registerRoutes } = await import("./index.js");

function node(id: string, identifier: string, labelNames: string[]) {
  return {
    id,
    identifier,
    title: `title ${identifier}`,
    description: "body",
    url: `https://linear.app/not-so-fat/issue/${identifier}/x`,
    state: { name: "Todo" },
    team: { id: "team-1" },
    labels: { nodes: labelNames.map((name) => ({ name })) },
  };
}

const LIST_NODES = [
  node("uuid-1", "NOT-242", ["repo:github.com/not-so-fat/agent-dealer"]),
  node("uuid-2", "NOT-243", ["agent-dealer"]),
  node("uuid-3", "NOT-244", ["repo:github.com/a/one", "repo:github.com/b/two"]),
  node("uuid-4", "NOT-245", ["repo:https://gitlab.com/acme/app"]),
];

const realFetch = globalThis.fetch;

before(() => {
  migrate();
  process.env.LINEAR_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
      variables?: { id?: string };
    };
    const payload =
      typeof body.variables?.id === "string"
        ? { data: { issue: LIST_NODES.find((n) => n.identifier === "NOT-242") ?? null } }
        : {
            data: {
              issues: { nodes: LIST_NODES, pageInfo: { hasNextPage: false, endCursor: null } },
            },
          };
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(payload),
    };
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.LINEAR_API_KEY;
});

async function buildApp() {
  const app = Fastify();
  await registerRoutes(app);
  return app;
}

test("GET /api/intake/linear returns candidates with resolved repo hints", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/intake/linear" });
  assert.equal(res.statusCode, 200);
  const json = res.json() as { candidates: Array<{ identifier: string; repoResolution?: { status: string; repository?: string; labels?: string[] } }> };
  assert.equal(json.candidates.length, 4);

  const one = json.candidates.find((c) => c.identifier === "NOT-242");
  assert.equal(one?.repoResolution?.status, "resolved");
  assert.equal(one?.repoResolution?.repository, "github.com/not-so-fat/agent-dealer");

  const none = json.candidates.find((c) => c.identifier === "NOT-243");
  assert.equal(none?.repoResolution?.status, "unresolved");
  assert.equal(none?.repoResolution?.repository, undefined);

  const conflict = json.candidates.find((c) => c.identifier === "NOT-244");
  assert.equal(conflict?.repoResolution?.status, "conflict");
  assert.deepEqual(conflict?.repoResolution?.labels, ["repo:github.com/a/one", "repo:github.com/b/two"]);

  const invalid = json.candidates.find((c) => c.identifier === "NOT-245");
  assert.equal(invalid?.repoResolution?.status, "invalid");
  assert.equal(invalid?.repoResolution?.repository, undefined);
});

test("GET /api/intake/linear/lookup returns the candidate with its repo hint", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/intake/linear/lookup?q=NOT-242" });
  assert.equal(res.statusCode, 200);
  const json = res.json() as {
    candidate: { identifier: string; repoResolution?: { status: string; repository?: string } };
  };
  assert.equal(json.candidate.identifier, "NOT-242");
  assert.equal(json.candidate.repoResolution?.status, "resolved");
  assert.equal(json.candidate.repoResolution?.repository, "github.com/not-so-fat/agent-dealer");
});

test("GET /api/intake/linear/lookup rejects an unparseable ref without calling Linear", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/intake/linear/lookup?q=not%20a%20ticket" });
  assert.equal(res.statusCode, 400);
});
