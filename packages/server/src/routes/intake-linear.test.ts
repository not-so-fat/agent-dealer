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
      query?: string;
      variables?: { id?: string };
    };
    const query = body.query ?? "";
    let payload: unknown;
    if (typeof body.variables?.id === "string") {
      payload = {
        data: {
          issue:
            LIST_NODES.find((n) => n.identifier === body.variables?.id) ??
            LIST_NODES.find((n) => n.identifier === "NOT-242") ??
            null,
        },
      };
    } else if (query.includes("IntakeMetadata") || /query\s*\{\s*viewer\s*\{/.test(query)) {
      payload = {
        data: {
          viewer: { id: "viewer-1", name: "Ada" },
          teams: {
            nodes: [
              {
                id: "team-1",
                name: "Core",
                key: "COR",
                states: { nodes: [{ name: "Todo", type: "unstarted" }] },
              },
            ],
          },
        },
      };
    } else {
      payload = {
        data: {
          issues: {
            nodes: LIST_NODES,
            pageInfo: { hasNextPage: listHasMoreForTest, endCursor: null },
          },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(payload),
    };
  }) as typeof fetch;
});

/** Flipped by hasMore route tests; default false for the existing candidate-list cases. */
let listHasMoreForTest = false;

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
  listHasMoreForTest = false;
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/intake/linear" });
  assert.equal(res.statusCode, 200);
  const json = res.json() as {
    candidates: Array<{ identifier: string; repoResolution?: { status: string; repository?: string; labels?: string[] } }>;
    hasMore: boolean;
  };
  assert.equal(json.candidates.length, 4);
  assert.equal(json.hasMore, false);

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

// NOT-260: a configured mapping prefills list candidates and direct lookups.
test("a mapped Linear label resolves in the candidate list with repo: fallback intact", async () => {
  const { replaceRepositoryMappings } = await import("../repository/repository-mappings.js");
  replaceRepositoryMappings({
    mappings: [{ label: "agent-dealer", repository: "not-so-fat/mapped" }],
  });
  try {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/intake/linear" });
    assert.equal(res.statusCode, 200);
    const json = res.json() as {
      candidates: Array<{
        identifier: string;
        labels?: string[];
        repoResolution?: { status: string; repository?: string; sourceLabel?: string };
      }>;
    };
    // NOT-243 carries the plain `agent-dealer` label — now mapped.
    const mapped = json.candidates.find((c) => c.identifier === "NOT-243");
    assert.equal(mapped?.repoResolution?.status, "resolved");
    assert.equal(mapped?.repoResolution?.repository, "github.com/not-so-fat/mapped");
    assert.equal(mapped?.repoResolution?.sourceLabel, "agent-dealer");
    // Raw Linear labels stay on the candidate.
    assert.deepEqual(mapped?.labels, ["agent-dealer"]);
    // NOT-242 has no mapping match — legacy repo: fallback still resolves.
    const legacy = json.candidates.find((c) => c.identifier === "NOT-242");
    assert.equal(legacy?.repoResolution?.status, "resolved");
    assert.equal(legacy?.repoResolution?.repository, "github.com/not-so-fat/agent-dealer");
    assert.equal(legacy?.repoResolution?.sourceLabel, "repo:github.com/not-so-fat/agent-dealer");
  } finally {
    replaceRepositoryMappings({ mappings: [] });
  }
});

test("a mapped Linear label resolves in direct lookup", async () => {
  const { replaceRepositoryMappings } = await import("../repository/repository-mappings.js");
  replaceRepositoryMappings({
    mappings: [{ label: "agent-dealer", repository: "not-so-fat/mapped" }],
  });
  try {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/intake/linear/lookup?q=NOT-243" });
    assert.equal(res.statusCode, 200);
    const json = res.json() as {
      candidate: {
        identifier: string;
        labels?: string[];
        repoResolution?: { status: string; repository?: string; sourceLabel?: string };
      };
    };
    assert.equal(json.candidate.identifier, "NOT-243");
    assert.equal(json.candidate.repoResolution?.status, "resolved");
    assert.equal(json.candidate.repoResolution?.repository, "github.com/not-so-fat/mapped");
    assert.equal(json.candidate.repoResolution?.sourceLabel, "agent-dealer");
    assert.deepEqual(json.candidate.labels, ["agent-dealer"]);
  } finally {
    replaceRepositoryMappings({ mappings: [] });
  }
});

// NOT-361: config / metadata / hasMore on the intake routes.
test("GET/PATCH /api/intake/linear/config round-trips picker filters", async () => {
  delete process.env.LINEAR_STATE_FILTER;
  delete process.env.LINEAR_TEAM_ID;
  const app = await buildApp();
  const patched = await app.inject({
    method: "PATCH",
    url: "/api/intake/linear/config",
    payload: { stateFilter: ["Todo"], teamId: "team-1", assigneeMe: true },
  });
  assert.equal(patched.statusCode, 200);
  const body = patched.json() as {
    stateFilter: string[];
    teamId: string | null;
    assigneeMe: boolean;
    persisted: { stateFilter: string[]; teamId: string | null; assigneeMe: boolean };
  };
  assert.deepEqual(body.persisted, { stateFilter: ["Todo"], teamId: "team-1", assigneeMe: true });

  const got = await app.inject({ method: "GET", url: "/api/intake/linear/config" });
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json().persisted, body.persisted);
});

test("env overrides are visible on the config view", async () => {
  process.env.LINEAR_STATE_FILTER = "In Review";
  process.env.LINEAR_TEAM_ID = "env-team";
  try {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/intake/linear/config" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      stateFilter: string[];
      teamId: string | null;
      envOverrides: { stateFilter: boolean; teamId: boolean };
      persisted: { stateFilter: string[]; teamId: string | null };
    };
    assert.deepEqual(body.stateFilter, ["In Review"]);
    assert.equal(body.teamId, "env-team");
    assert.equal(body.envOverrides.stateFilter, true);
    assert.equal(body.envOverrides.teamId, true);
  } finally {
    delete process.env.LINEAR_STATE_FILTER;
    delete process.env.LINEAR_TEAM_ID;
  }
});

test("GET /api/intake/linear/metadata returns teams, statuses, and viewer", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/intake/linear/metadata" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    teams: Array<{ id: string; name: string }>;
    workflowStates: Array<{ name: string }>;
    viewer: { name: string } | null;
  };
  assert.equal(body.teams[0]?.name, "Core");
  assert.ok(body.workflowStates.some((s) => s.name === "Todo"));
  assert.equal(body.viewer?.name, "Ada");
});

test("GET /api/intake/linear reports hasMore true and false", async () => {
  // Ensure assigneeMe does not short-circuit the list when viewer lookup fails.
  const app = await buildApp();
  await app.inject({
    method: "PATCH",
    url: "/api/intake/linear/config",
    payload: { assigneeMe: false },
  });
  listHasMoreForTest = true;
  const more = await app.inject({ method: "GET", url: "/api/intake/linear" });
  assert.equal(more.statusCode, 200);
  assert.equal(more.json().hasMore, true);

  listHasMoreForTest = false;
  const done = await app.inject({ method: "GET", url: "/api/intake/linear" });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().hasMore, false);
});
