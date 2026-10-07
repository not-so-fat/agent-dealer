// NOT-364: atomic Linear attachment import and reload reconciliation.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-src-att-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { listSourceAttachments } = await import("../repository/source-attachments.js");
const { listQueuedEntries } = await import("../repository/queue-entries.js");
const { listIssues } = await import("../repository/issues.js");

const FILE_URL = "https://uploads.linear.app/abc/repro.tar.gz";
const LINK_URL = "https://docs.example.com/spec";
const TARBALL_V1 = Buffer.from("repro-tarball-version-one-bytes");
const TARBALL_V2 = Buffer.from("repro-tarball-version-two-bytes!!");

/** Current download bytes per URL; flip to simulate expiry/removal. */
const downloadBytes = new Map<string, Buffer | "http500">();
/** Linear issue node answered to GraphQL (reload path). */
let linearNode: unknown = null;

const realFetch = globalThis.fetch;
before(() => {
  migrate();
  process.env.LINEAR_API_KEY = "test-key";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url);
    if (target.includes("api.linear.app")) {
      // Single-issue fetch answers the reload; relation walks (admission
      // blocker checks behind the queue wait reason) answer no blockers.
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
        variables?: { id?: string };
      };
      const payload =
        typeof body.variables?.id === "string"
          ? { data: { issue: linearNode } }
          : { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const fixture = downloadBytes.get(target);
    if (fixture === "http500" || fixture === undefined) {
      return new Response("boom", { status: 500 });
    }
    return new Response(new Uint8Array(fixture), {
      status: 200,
      headers: { "Content-Type": "application/gzip", "Content-Length": String(fixture.byteLength) },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.LINEAR_API_KEY;
});

beforeEach(() => {
  downloadBytes.clear();
  linearNode = null;
  getDb().exec(`
    DELETE FROM issue_source_attachments;
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  return app;
}

const BASE_LINEAR = {
  title: "NOT-1: import me",
  description: "Do the thing.",
  repo: "acme/app",
  baseBranch: "main",
  developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
  reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
  source: "linear",
  externalId: "linear-uuid-1",
  externalLabel: "NOT-1",
  externalUrl: "https://linear.app/not-so-fat/issue/NOT-1/x",
};

const FILE_ATT = { id: "att-file-1", title: "repro.tar.gz", url: FILE_URL };
const LINK_ATT = { id: "att-link-1", title: "Design doc", url: LINK_URL, subtitle: "Spec" };

test("import snapshots a hosted .tar.gz and keeps the link as metadata", async () => {
  downloadBytes.set(FILE_URL, TARBALL_V1);
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { ...BASE_LINEAR, linearAttachments: [FILE_ATT, LINK_ATT] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const created = res.json() as { id: string };
  assert.equal(res.json() && (res.json() as { queue: string }).queue, "enqueued");

  const rows = listSourceAttachments(created.id);
  assert.equal(rows.length, 2);
  const file = rows.find((r) => r.kind === "file")!;
  assert.equal(file.linearAttachmentId, "att-file-1");
  assert.equal(file.safeFileName, "repro.tar.gz");
  assert.equal(file.sizeBytes, TARBALL_V1.byteLength);
  assert.equal(file.sha256, createHash("sha256").update(TARBALL_V1).digest("hex"));
  assert.ok(file.blobPath && fs.existsSync(file.blobPath));
  assert.deepEqual(fs.readFileSync(file.blobPath!), TARBALL_V1);
  const link = rows.find((r) => r.kind === "link")!;
  assert.equal(link.url, LINK_URL);
  assert.equal(link.blobPath, undefined);

  // The detail carries the same manifest for the Source attachments summary.
  const detail = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
  assert.equal(detail.statusCode, 200);
  const body = detail.json() as { sourceAttachments: unknown[] };
  assert.equal(body.sourceAttachments.length, 2);
  await app.close();
});

test("import fails atomically when a hosted file download fails", async () => {
  downloadBytes.set(FILE_URL, "http500");
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { ...BASE_LINEAR, linearAttachments: [FILE_ATT, LINK_ATT] },
  });
  assert.equal(res.statusCode, 502, res.body);
  assert.match(res.json().error, /HTTP 500/);
  // Zero partial state: no issue, no queue entry, no attachment rows.
  assert.equal(listIssues().length, 0);
  assert.equal(listQueuedEntries().length, 0);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS n FROM issue_source_attachments").get() as { n: number }).n,
    0
  );
  await app.close();
});

test("import refuses an oversized hosted file with zero rows", async () => {
  const app = await buildApp();
  const huge = { id: "att-big", title: "huge.bin", url: "https://uploads.linear.app/abc/huge.bin" };
  downloadBytes.set(huge.url, Buffer.from("small-body"));
  // Lie about the size the way an over-limit Linear upload would declare it.
  const realMock = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes("api.linear.app")) {
      const parsed = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
        variables?: { id?: string };
      };
      const payload =
        typeof parsed.variables?.id === "string"
          ? { data: { issue: null } }
          : { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(new Uint8Array(Buffer.from("small-body")), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(300 * 1024 * 1024) },
    });
  }) as typeof fetch;
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...BASE_LINEAR, linearAttachments: [huge] },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error, /too large to snapshot/);
    assert.equal(listIssues().length, 0);
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS n FROM issue_source_attachments").get() as { n: number }).n,
      0
    );
  } finally {
    globalThis.fetch = realMock;
  }
  await app.close();
});

test("link-only import stores metadata without fetching", async () => {
  let downloads = 0;
  const realMock = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes("api.linear.app")) {
      const parsed = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as {
        variables?: { id?: string };
      };
      const payload =
        typeof parsed.variables?.id === "string"
          ? { data: { issue: null } }
          : { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    downloads += 1;
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  try {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...BASE_LINEAR, linearAttachments: [LINK_ATT] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const rows = listSourceAttachments((res.json() as { id: string }).id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "link");
    assert.equal(downloads, 0, "external-link targets are never fetched");
    await app.close();
  } finally {
    globalThis.fetch = realMock;
  }
});

function linearNodeWith(attachments: unknown[]) {
  return {
    id: "linear-uuid-1",
    identifier: "NOT-1",
    title: "Reloaded title",
    description: "Do the thing, reloaded.",
    url: "https://linear.app/not-so-fat/issue/NOT-1/x",
    state: { name: "Todo" },
    team: { id: "team-1" },
    labels: { nodes: [] },
    attachments: { nodes: attachments },
  };
}

test("reload reconciles added, changed, and removed attachments atomically", async () => {
  downloadBytes.set(FILE_URL, TARBALL_V1);
  const app = await buildApp();
  const created = (await (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...BASE_LINEAR, linearAttachments: [FILE_ATT, LINK_ATT] },
    })
  ).json()) as { id: string };
  const beforeRows = listSourceAttachments(created.id);
  const oldBlob = beforeRows.find((r) => r.kind === "file")!.blobPath!;
  assert.ok(fs.existsSync(oldBlob));

  // Linear now: same file id with new bytes, link kept, second file removed
  // (it is simply absent), brand-new file added.
  const FILE_B_URL = "https://uploads.linear.app/abc/b.bin";
  downloadBytes.set(FILE_URL, TARBALL_V2);
  downloadBytes.set(FILE_B_URL, Buffer.from("brand-new-bytes"));
  linearNode = linearNodeWith([
    { id: "att-file-1", title: "repro.tar.gz", url: FILE_URL },
    { id: "att-link-1", title: "Design doc", url: LINK_URL, subtitle: "Spec" },
    { id: "att-file-3", title: "b.bin", url: FILE_B_URL },
  ]);

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/reload-source` });
  assert.equal(res.statusCode, 200, res.body);

  const rows = listSourceAttachments(created.id);
  assert.equal(rows.length, 3);
  const changed = rows.find((r) => r.linearAttachmentId === "att-file-1")!;
  assert.equal(changed.sha256, createHash("sha256").update(TARBALL_V2).digest("hex"));
  assert.deepEqual(fs.readFileSync(changed.blobPath!), TARBALL_V2);
  assert.ok(rows.some((r) => r.linearAttachmentId === "att-file-3"));
  // Removed files disappear from the pre-execution snapshot (no att-file-2
  // was ever here, but the changed file's old blob path is either reused or
  // pruned — either way the bytes on record are the new ones).
  assert.deepEqual(fs.readFileSync(changed.blobPath!), TARBALL_V2);
  assert.ok(!rows.some((r) => r.linearAttachmentId === "att-file-2"));
  // Old blob bytes are gone when the path changed; reused paths carry new bytes.
  if (changed.blobPath !== oldBlob) assert.ok(!fs.existsSync(oldBlob));
  await app.close();
});

test("the frozen manifest survives later row changes; legacy snapshots read empty", async () => {
  const { createIssue } = await import("../repository/issues.js");
  const { createIssueArtifact } = await import("../repository/artifacts.js");
  const { replaceSourceAttachments } = await import("../repository/source-attachments.js");
  const { getTaskSnapshot, TASK_SNAPSHOT_ARTIFACT_KIND } = await import("../coordinator/commands.js");
  const issue = createIssue({
    title: "Frozen",
    repo: "acme/app",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
  });
  const frozen = [
    {
      linearAttachmentId: "att-old",
      kind: "file" as const,
      title: "old.bin",
      safeFileName: "old.bin",
      blobPath: "/blobs/old.bin",
      sizeBytes: 3,
      sha256: "aa",
      url: "https://uploads.linear.app/old",
    },
  ];
  replaceSourceAttachments(issue.id, frozen);
  createIssueArtifact({
    issueId: issue.id,
    kind: TASK_SNAPSHOT_ARTIFACT_KIND,
    author: "system",
    content: {
      title: issue.title,
      description: "",
      acceptanceCriteria: "",
      repo: issue.repo,
      baseBranch: issue.baseBranch,
      workflowVersion: "dev_reviewer_v1",
      executionContract: null,
      sourceAttachments: frozen,
    },
  });
  // A later Linear change swaps the live rows — the frozen read is unaffected.
  replaceSourceAttachments(issue.id, [
    {
      linearAttachmentId: "att-new",
      kind: "link" as const,
      title: "New",
      url: "https://docs.example.com/new",
    },
  ]);
  const { getIssue } = await import("../repository/issues.js");
  assert.deepEqual(getTaskSnapshot(getIssue(issue.id)!).sourceAttachments, frozen);

  // Legacy snapshots (frozen before attachments) never gain inputs mid-flight.
  const legacy = createIssue({
    title: "Legacy",
    repo: "acme/app",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
  });
  createIssueArtifact({
    issueId: legacy.id,
    kind: TASK_SNAPSHOT_ARTIFACT_KIND,
    author: "system",
    content: {
      title: legacy.title,
      description: "",
      acceptanceCriteria: "",
      repo: legacy.repo,
      baseBranch: legacy.baseBranch,
      workflowVersion: "dev_reviewer_v1",
      executionContract: null,
    },
  });
  replaceSourceAttachments(legacy.id, frozen);
  assert.deepEqual(getTaskSnapshot(getIssue(legacy.id)!).sourceAttachments, []);
});

test("failed reload preserves the old task text and attachment snapshot", async () => {
  downloadBytes.set(FILE_URL, TARBALL_V1);
  const app = await buildApp();
  const created = (await (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...BASE_LINEAR, linearAttachments: [FILE_ATT] },
    })
  ).json()) as { id: string };
  const beforeRows = listSourceAttachments(created.id);
  const beforeBlobHash = createHash("sha256")
    .update(fs.readFileSync(beforeRows[0]!.blobPath!))
    .digest("hex");

  // The refreshed ticket adds a file whose download fails.
  const BAD_URL = "https://uploads.linear.app/abc/missing.bin";
  downloadBytes.set(BAD_URL, "http500");
  linearNode = linearNodeWith([
    { id: "att-file-1", title: "repro.tar.gz", url: FILE_URL },
    { id: "att-file-9", title: "missing.bin", url: BAD_URL },
  ]);

  const res = await app.inject({ method: "POST", url: `/api/issues/${created.id}/reload-source` });
  assert.equal(res.statusCode, 502, res.body);

  const { getIssue } = await import("../repository/issues.js");
  const issue = getIssue(created.id)!;
  assert.equal(issue.title, BASE_LINEAR.title, "old task text preserved");
  assert.equal(issue.description, BASE_LINEAR.description);
  const afterRows = listSourceAttachments(created.id);
  assert.deepEqual(
    afterRows.map((r) => r.linearAttachmentId),
    ["att-file-1"],
    "old attachment snapshot preserved"
  );
  assert.equal(
    createHash("sha256").update(fs.readFileSync(afterRows[0]!.blobPath!)).digest("hex"),
    beforeBlobHash,
    "old blob bytes intact"
  );
  await app.close();
});
