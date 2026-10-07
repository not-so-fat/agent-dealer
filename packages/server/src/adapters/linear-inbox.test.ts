import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildIssueFilter,
  getLinearIssue,
  LINEAR_CANDIDATE_PAGE_SIZE,
  listLinearCandidates,
  fetchLinearIntakeMetadata,
  nodeToCandidate,
  parseLinearIssueRef,
} from "./linear-inbox.js";
test("parseLinearIssueRef accepts identifier, URL, and UUID", () => {
  assert.equal(parseLinearIssueRef("NOT-103"), "NOT-103");
  assert.equal(parseLinearIssueRef("  not-90  "), "NOT-90");
  assert.equal(
    parseLinearIssueRef("https://linear.app/not-so-fat/issue/NOT-103/sequential-issue-queue"),
    "NOT-103"
  );
  assert.equal(
    parseLinearIssueRef("7a2e7533-65f8-4752-a903-d419f47b2093"),
    "7a2e7533-65f8-4752-a903-d419f47b2093"
  );
  assert.equal(parseLinearIssueRef(""), null);
  assert.equal(parseLinearIssueRef("not a ticket"), null);
});

test("buildIssueFilter omits assignee when assigneeMe is false", () => {
  const filter = buildIssueFilter(
    {
      stateFilter: ["Backlog", "Todo", "In Progress", "In Review"],
      teamId: "team-1",
      assigneeMe: false,
      syncEnabled: true,
    },
    "viewer-1"
  );
  assert.deepEqual(filter, {
    state: { name: { in: ["Backlog", "Todo", "In Progress", "In Review"] } },
    team: { id: { eq: "team-1" } },
  });
});

test("nodeToCandidate resolves exactly one repo: label to the canonical identity", () => {
  const c = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-242",
    title: "t",
    url: "https://linear.app/not-so-fat/issue/NOT-242/t",
    labels: { nodes: [{ name: "agent-dealer" }, { name: "repo:github.com/not-so-fat/agent-dealer" }] },
  });
  // Raw labels stay available alongside the resolved hint.
  assert.deepEqual(c.labels, ["agent-dealer", "repo:github.com/not-so-fat/agent-dealer"]);
  assert.equal(c.repoResolution?.status, "resolved");
  assert.equal(c.repoResolution?.repository, "github.com/not-so-fat/agent-dealer");
  assert.equal(c.repoResolution?.sourceLabel, "repo:github.com/not-so-fat/agent-dealer");
});

test("nodeToCandidate leaves zero repo: labels unresolved and conflicts several", () => {
  const none = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-1",
    title: "t",
    url: "https://linear.app/x/issue/NOT-1/t",
    labels: { nodes: [{ name: "agent-dealer" }] },
  });
  assert.equal(none.repoResolution?.status, "unresolved");
  assert.equal(none.repoResolution?.repository, undefined);

  const conflict = nodeToCandidate({
    id: "uuid-2",
    identifier: "NOT-2",
    title: "t",
    url: "https://linear.app/x/issue/NOT-2/t",
    labels: { nodes: [{ name: "repo:github.com/a/one" }, { name: "repo:github.com/b/two" }] },
  });
  assert.equal(conflict.repoResolution?.status, "conflict");
  assert.equal(conflict.repoResolution?.repository, undefined);
  assert.deepEqual(conflict.repoResolution?.labels, ["repo:github.com/a/one", "repo:github.com/b/two"]);
});

test("nodeToCandidate marks a non-GitHub repo: value invalid", () => {
  const c = nodeToCandidate({
    id: "uuid-3",
    identifier: "NOT-3",
    title: "t",
    url: "https://linear.app/x/issue/NOT-3/t",
    labels: { nodes: [{ name: "repo:https://gitlab.com/acme/app" }] },
  });
  assert.equal(c.repoResolution?.status, "invalid");
  assert.equal(c.repoResolution?.repository, undefined);
  assert.deepEqual(c.repoResolution?.labels, ["repo:https://gitlab.com/acme/app"]);
  assert.ok(c.repoResolution?.error);
});

test("buildIssueFilter includes assignee when assigneeMe is true", () => {
  const filter = buildIssueFilter(
    {
      stateFilter: ["Todo"],
      teamId: null,
      assigneeMe: true,
      syncEnabled: true,
    },
    "viewer-1"
  );
  assert.deepEqual(filter, {
    state: { name: { in: ["Todo"] } },
    assignee: { id: { eq: "viewer-1" } },
  });
});

// NOT-361: bounded candidate fetch — AND filters, updatedAt order, first page only.
test("listLinearCandidates requests AND filters, updatedAt order, and a single page", async () => {
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-linear-inbox-"));
  process.env.LINEAR_API_KEY = "test-key";
  delete process.env.LINEAR_STATE_FILTER;
  delete process.env.LINEAR_TEAM_ID;

  const { migrate } = await import("../db/index.js");
  migrate();
  const { patchLinearIntakeConfig } = await import("../repository/intake-settings.js");
  patchLinearIntakeConfig({
    stateFilter: ["Todo", "In Progress"],
    teamId: "team-9",
    assigneeMe: true,
  });

  const requests: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    requests.push({ query: body.query ?? "", variables: body.variables });
    if ((body.query ?? "").includes("viewer {")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ data: { viewer: { id: "viewer-1", name: "Ada" } } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "i1",
                  identifier: "NOT-1",
                  title: "one",
                  url: "https://linear.app/x/issue/NOT-1/one",
                  state: { name: "Todo" },
                  team: { id: "team-9" },
                  labels: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: true },
            },
          },
        }),
    };
  }) as typeof fetch;

  try {
    const page = await listLinearCandidates();
    assert.equal(page.candidates.length, 1);
    assert.equal(page.hasMore, true);
    // viewer (assigneeMe) + one issues page — never a second cursor page.
    assert.equal(requests.length, 2);
    const issuesReq = requests.find((r) => r.query.includes("issues("));
    assert.ok(issuesReq, "issues query sent");
    assert.match(issuesReq!.query, /orderBy:\s*updatedAt/);
    assert.match(issuesReq!.query, new RegExp(`first:\\s*${LINEAR_CANDIDATE_PAGE_SIZE}`));
    assert.ok(!issuesReq!.query.includes("$after"), "no cursor variable");
    assert.deepEqual(issuesReq!.variables?.filter, {
      state: { name: { in: ["Todo", "In Progress"] } },
      team: { id: { eq: "team-9" } },
      assignee: { id: { eq: "viewer-1" } },
    });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
  }
});

test("fetchLinearIntakeMetadata returns teams, statuses, and viewer", async () => {
  process.env.LINEAR_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const op = (bodies[bodies.length - 1] as { query?: string }).query ?? "";
    if (op.includes("IntakeMetadataViewer")) {
      return new Response(
        JSON.stringify({
          data: { viewer: { id: "v1", name: "Ada", email: "ada@example.com" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        data: {
          teams: {
            nodes: [
              {
                id: "t1",
                name: "Core",
                key: "COR",
                states: {
                  nodes: [
                    { name: "Todo", type: "unstarted" },
                    { name: "Done", type: "completed" },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    const meta = await fetchLinearIntakeMetadata();
    assert.equal(meta.viewer?.name, "Ada");
    assert.equal(meta.teams[0]?.name, "Core");
    assert.ok(meta.workflowStates.some((s) => s.name === "Todo" && s.teamId === "t1"));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
  }
});

test("fetchLinearIntakeMetadata walks team pages beyond Linear's default first page", async () => {
  process.env.LINEAR_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let teamPageCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: { after?: string | null; first?: number };
    };
    if ((body.query ?? "").includes("IntakeMetadataViewer")) {
      return new Response(JSON.stringify({ data: { viewer: { id: "v1", name: "Ada" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    teamPageCalls += 1;
    assert.equal(body.variables?.first, 50, "requests a bounded team page");
    if (teamPageCalls === 1) {
      assert.equal(body.variables?.after ?? null, null, "first page has no cursor");
      return new Response(
        JSON.stringify({
          data: {
            teams: {
              nodes: [
                {
                  id: "t1",
                  name: "Alpha",
                  states: { nodes: [{ name: "Todo", type: "unstarted" }] },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    assert.equal(body.variables?.after, "cursor-1", "follows endCursor");
    return new Response(
      JSON.stringify({
        data: {
          teams: {
            nodes: [
              {
                id: "t2",
                name: "Zeta",
                states: { nodes: [{ name: "In Progress", type: "started" }] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    const meta = await fetchLinearIntakeMetadata();
    assert.equal(teamPageCalls, 2, "walks a second team page");
    assert.deepEqual(
      meta.teams.map((t) => t.name),
      ["Alpha", "Zeta"]
    );
    assert.ok(meta.workflowStates.some((s) => s.name === "In Progress" && s.teamId === "t2"));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
  }
});

test("fetchLinearIntakeMetadata fails clearly without LINEAR_API_KEY", async () => {
  delete process.env.LINEAR_API_KEY;
  await assert.rejects(() => fetchLinearIntakeMetadata(), /LINEAR_API_KEY/);
});

// NOT-364: issue attachment metadata on candidates — hosted files and external
// links, without regressing labels, repo resolution, or the 50-item page bound.
test("nodeToCandidate carries file and link attachments with stable ids", () => {
  const c = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-364",
    title: "t",
    url: "https://linear.app/x/issue/NOT-364/t",
    labels: { nodes: [{ name: "repo:github.com/not-so-fat/agent-dealer" }] },
    attachments: {
      nodes: [
        {
          id: "att-file-1",
          title: "repro.tar.gz",
          url: "https://uploads.linear.app/abc/repro.tar.gz",
        },
        {
          id: "att-link-1",
          title: "Design doc",
          url: "https://docs.example.com/x",
          subtitle: "Spec",
          source: "google-docs",
        },
      ],
    },
  });
  assert.equal(c.attachments?.length, 2);
  assert.deepEqual(c.attachments?.[0], {
    id: "att-file-1",
    title: "repro.tar.gz",
    url: "https://uploads.linear.app/abc/repro.tar.gz",
  });
  assert.deepEqual(c.attachments?.[1], {
    id: "att-link-1",
    title: "Design doc",
    url: "https://docs.example.com/x",
    subtitle: "Spec",
    source: "google-docs",
  });
  // Labels and repo resolution are untouched by the attachment connection.
  assert.deepEqual(c.labels, ["repo:github.com/not-so-fat/agent-dealer"]);
  assert.equal(c.repoResolution?.status, "resolved");
});

test("nodeToCandidate drops malformed attachments and coerces source metadata", () => {
  const c = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-364",
    title: "t",
    url: "https://linear.app/x/issue/NOT-364/t",
    labels: { nodes: [] },
    attachments: {
      nodes: [
        { id: "", title: "no id", url: "https://uploads.linear.app/x" },
        { id: "att-no-url", title: "no url", url: "" },
        { id: "att-obj-source", title: "f", url: "https://uploads.linear.app/f", source: { kind: "slack" } },
      ],
    },
  });
  assert.equal(c.attachments?.length, 1);
  assert.equal(c.attachments?.[0]?.id, "att-obj-source");
  assert.equal(c.attachments?.[0]?.source, `{"kind":"slack"}`);
});

test("getLinearIssue carries attachment metadata on exact lookup", async () => {
  process.env.LINEAR_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        data: {
          issue: {
            id: "linear-uuid-9",
            identifier: "NOT-9",
            title: "exact",
            url: "https://linear.app/x/issue/NOT-9/exact",
            state: { name: "Todo" },
            team: { id: "team-1" },
            labels: { nodes: [] },
            attachments: {
              nodes: [
                { id: "a1", title: "repro.tar.gz", url: "https://uploads.linear.app/a/repro.tar.gz" },
              ],
            },
          },
        },
      }),
  })) as typeof fetch;
  try {
    const found = await getLinearIssue("NOT-9");
    assert.equal(found?.identifier, "NOT-9");
    assert.equal(found?.attachments?.length, 1);
    assert.equal(found?.attachments?.[0]?.title, "repro.tar.gz");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
  }
});

test("nodeToCandidate defaults missing attachments to an empty list", () => {
  const c = nodeToCandidate({
    id: "uuid-1",
    identifier: "NOT-1",
    title: "t",
    url: "https://linear.app/x/issue/NOT-1/t",
    labels: { nodes: [] },
  });
  assert.deepEqual(c.attachments, []);
});

// NOT-364: the candidate page still requests one bounded page and now carries
// the attachments connection on every issue selection.
test("listLinearCandidates queries attachments within the single 50-item page", async () => {
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-linear-inbox-att-"));
  process.env.LINEAR_API_KEY = "test-key";
  delete process.env.LINEAR_STATE_FILTER;
  delete process.env.LINEAR_TEAM_ID;

  const { migrate } = await import("../db/index.js");
  migrate();
  const { patchLinearIntakeConfig } = await import("../repository/intake-settings.js");
  patchLinearIntakeConfig({ stateFilter: ["Todo"], teamId: null, assigneeMe: false });

  const requests: Array<{ query: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as { query?: string };
    requests.push({ query: body.query ?? "" });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "i1",
                  identifier: "NOT-1",
                  title: "one",
                  url: "https://linear.app/x/issue/NOT-1/one",
                  state: { name: "Todo" },
                  team: { id: "team-9" },
                  labels: { nodes: [] },
                  attachments: {
                    nodes: [
                      { id: "a1", title: "repro.tar.gz", url: "https://uploads.linear.app/a/repro.tar.gz" },
                      { id: "a2", title: "Doc", url: "https://docs.example.com/x", subtitle: "s" },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        }),
    };
  }) as typeof fetch;

  try {
    const page = await listLinearCandidates();
    assert.equal(page.candidates.length, 1);
    assert.equal(requests.length, 1, "still a single page — no cursor walk");
    assert.match(requests[0]!.query, /attachments\s*\{\s*nodes\s*\{\s*id title url subtitle source\s*\}\s*\}/);
    assert.match(requests[0]!.query, new RegExp(`first:\\s*${LINEAR_CANDIDATE_PAGE_SIZE}`));
    assert.equal(page.candidates[0]!.attachments?.length, 2);
    assert.equal(page.candidates[0]!.attachments?.[0]?.id, "a1");
    assert.equal(page.candidates[0]!.attachments?.[1]?.subtitle, "s");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
  }
});
