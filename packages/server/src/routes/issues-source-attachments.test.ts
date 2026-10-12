// NOT-364: atomic Linear attachment import and reload reconciliation.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const downloadBytes = new Map<string, Buffer | "http500" | "http401">();
/** Linear issue node answered to GraphQL (reload path). */
let linearNode: unknown = null;
/** Authorization headers observed on hosted-file downloads (NOT-367). */
const seenDownloadAuth: Array<string | null> = [];

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
    const headers = (init as unknown as { headers?: unknown } | undefined)?.headers;
    const auth =
      headers instanceof Headers
        ? headers.get("authorization")
        : ((headers as Record<string, string> | undefined)?.Authorization ??
          (headers as Record<string, string> | undefined)?.authorization ??
          null);
    seenDownloadAuth.push(auth);
    const fixture = downloadBytes.get(target);
    if (fixture === "http401") {
      return new Response("unauthorized", { status: 401 });
    }
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
  seenDownloadAuth.length = 0;
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
  // NOT-367: the hosted download carried the configured Linear credential.
  assert.deepEqual(seenDownloadAuth, ["test-key"]);

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

test("import maps an unauthorized (401) download to an auth error with zero rows", async () => {
  downloadBytes.set(FILE_URL, "http401");
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { ...BASE_LINEAR, linearAttachments: [FILE_ATT, LINK_ATT] },
  });
  assert.equal(res.statusCode, 502, res.body);
  const message = (res.json() as { error: string }).error;
  assert.match(message, /HTTP 401/);
  assert.match(message, /Unauthorized/);
  assert.match(message, /rejected the download credentials/);
  assert.match(message, /LINEAR_API_KEY/);
  assert.ok(!/expired/i.test(message), "a 401 must not blame URL expiry");
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
  // Removed files disappear from the pre-execution snapshot. Blob paths are
  // content-addressed, so the changed file lands on a new path with the new
  // bytes and the old blob is pruned.
  assert.deepEqual(fs.readFileSync(changed.blobPath!), TARBALL_V2);
  assert.ok(!rows.some((r) => r.linearAttachmentId === "att-file-2"));
  assert.notEqual(changed.blobPath, oldBlob);
  assert.ok(!fs.existsSync(oldBlob));
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

test("reload race with admission (in-transaction 409) leaves prior blob bytes untouched", async () => {
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
  assert.equal(beforeRows.length, 1);
  const beforeBlobPath = beforeRows[0]!.blobPath!;
  const beforeHash = createHash("sha256").update(fs.readFileSync(beforeBlobPath)).digest("hex");

  // The refreshed ticket carries changed bytes for the same attachment id.
  downloadBytes.set(FILE_URL, TARBALL_V2);
  const { reloadIssueSourceFromLinear } = await import("../coordinator/source-reload.js");
  const { startWorkflowInstance } = await import("../repository/workflow-events.js");
  const { getSourceAttachmentsDir } = await import("../paths.js");
  const result = await reloadIssueSourceFromLinear(created.id, {
    fetchLinearIssue: async (externalId: string) => {
      // Admission wins the race mid-flight: by the time the write
      // transaction runs, an active workflow owns the issue, so the
      // in-transaction guard must answer 409 with no partial write.
      startWorkflowInstance(created.id, "dev_reviewer_v1");
      return {
        id: externalId,
        identifier: "NOT-1",
        title: "Reloaded title",
        description: "Do the thing, reloaded.",
        url: "https://linear.app/not-so-fat/issue/NOT-1/x",
        attachments: [{ id: "att-file-1", title: "repro.tar.gz", url: FILE_URL }],
      };
    },
  });
  if (result.ok) assert.fail("expected the admission race to answer 409");
  assert.equal(result.code, 409);

  // Old task text and old attachment rows preserved — and, crucially, the
  // old blob path still holds the old bytes (a pre-fix store overwrote the
  // deterministic path before the transaction, breaking the frozen sha256).
  const { getIssue } = await import("../repository/issues.js");
  assert.equal(getIssue(created.id)!.title, BASE_LINEAR.title);
  const afterRows = listSourceAttachments(created.id);
  assert.deepEqual(
    afterRows.map((r) => r.linearAttachmentId),
    ["att-file-1"]
  );
  assert.equal(afterRows[0]!.blobPath, beforeBlobPath);
  assert.deepEqual(fs.readFileSync(afterRows[0]!.blobPath!), TARBALL_V1);
  assert.equal(
    createHash("sha256").update(fs.readFileSync(afterRows[0]!.blobPath!)).digest("hex"),
    beforeHash
  );
  // The staged-but-never-committed V2 bytes were pruned, not left behind.
  assert.deepEqual(fs.readdirSync(path.join(getSourceAttachmentsDir(), created.id)), [
    path.basename(beforeBlobPath),
  ]);
  await app.close();
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

// NOT-422: parked scope reload — the same atomic reconciliation as the
// pre-execution path, preserving the active workflow and the open action.
const PARKED_CONTRACT_V1 = [
  "Ship the friend-path run command.",
  "",
  "## Builder execution mode",
  "feature",
  "",
  "## Non-goals",
  "- Rewriting the installer",
  "",
  "## Exit predicate",
  "The friend-path run command works on a clean machine with operator proof.",
  "",
  "## One-PR stopping point",
  "Stop after the run command lands with its regression test.",
  "",
  "## Acceptance criteria",
  "- [ ] Friend-path run works",
  "  Evidence: run fixtures | run the tests | green",
  "- [ ] [operator] Clean-machine proof attached",
  "  Evidence: operator run | paste the output | reviewed",
  "",
].join("\n");

const PARKED_CONTRACT_V2 = [
  "Ship the friend-path run command.",
  "",
  "## Builder execution mode",
  "feature",
  "",
  "## Non-goals",
  "- Rewriting the installer",
  "",
  "## Exit predicate",
  "The friend-path run command works with simulator proof; clean-machine proof moved out.",
  "",
  "## One-PR stopping point",
  "Stop after the run command lands with its regression test.",
  "",
  "## Acceptance criteria",
  "- [ ] Friend-path run works",
  "  Evidence: run fixtures | run the tests | green",
  "- [ ] Simulator proof attached",
  "  Evidence: simulator run | paste the output | reviewed",
  "",
].join("\n");

function parkedNodeWith(description: string, attachments: unknown[]) {
  return { ...linearNodeWith(attachments), description };
}

let scopeAttachCounter = 0;

async function parkScopeWithAttachments(app: Awaited<ReturnType<typeof buildApp>>) {
  const { startWorkflow, applyCompletion } = await import("../coordinator/commands.js");
  const { claimWorkItem } = await import("../repository/work-items.js");
  const { ReviewerResult } = await import("../coordinator/reviewer-result.js");
  const { getIssue } = await import("../repository/issues.js");
  scopeAttachCounter += 1;
  const created = (await (
    await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        ...BASE_LINEAR,
        externalId: `linear-uuid-scope-att-${scopeAttachCounter}`,
        description: PARKED_CONTRACT_V1,
        linearAttachments: [FILE_ATT, LINK_ATT],
      },
    })
  ).json()) as { id: string };
  assert.equal(startWorkflow(created.id).ok, true);
  const dev = claimWorkItem("scope-att-test", { leaseMs: 60_000 })!;
  await applyCompletion(dev.id, dev.leaseToken!, {
    kind: "clean_handoff",
    branch: "b",
    headSha: "abc",
    baseSha: "base",
    prNumber: 1,
    prUrl: "https://gh/pr/1",
  });
  const rev = claimWorkItem("scope-att-test", { leaseMs: 60_000 })!;
  await applyCompletion(rev.id, rev.leaseToken!, {
    kind: "verdict",
    result: ReviewerResult.parse({
      verdict: "escalated",
      productScopeQuestion: "Is clean-machine proof still required?",
      baseSha: "b",
      headSha: "h",
      acceptanceCriteriaAssessment: "ok",
      evidenceAssessment: "ok",
      findings: [],
      risks: [],
    }),
  });
  assert.equal(getIssue(created.id)!.status, "needs_human");
  return created.id;
}

test("NOT-422: parked scope reload recompiles the contract, reconciles attachments, and preserves the workflow", async () => {
  downloadBytes.set(FILE_URL, TARBALL_V1);
  const app = await buildApp();
  const id = await parkScopeWithAttachments(app);
  const { getIssue } = await import("../repository/issues.js");
  const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const { getHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");
  const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
  const { getTaskSnapshot } = await import("../coordinator/commands.js");

  const before = getIssue(id)!;
  const instanceBefore = getActiveWorkflowInstance(id)!;
  const actionBefore = listHumanActionsForIssue(id).find((a) => a.actionType === "product_scope_decision")!;
  const sessionsBefore = listWorkerSessionsForIssue(id);
  const frozenBefore = getTaskSnapshot(before);
  const oldBlob = listSourceAttachments(id).find((r) => r.kind === "file")!.blobPath!;
  assert.ok(fs.existsSync(oldBlob));

  // Linear now: amended contract (the [operator] criterion is gone), the same
  // file id with new bytes, a brand-new file, and the link removed.
  const FILE_B_URL = "https://uploads.linear.app/abc/b.bin";
  const TARBALL_B = Buffer.from("brand-new-bytes");
  downloadBytes.set(FILE_URL, TARBALL_V2);
  downloadBytes.set(FILE_B_URL, TARBALL_B);
  linearNode = parkedNodeWith(PARKED_CONTRACT_V2, [
    { id: "att-file-1", title: "repro.tar.gz", url: FILE_URL },
    { id: "att-file-3", title: "b.bin", url: FILE_B_URL },
  ]);

  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 200, res.body);
  const reloaded = res.json() as {
    title: string;
    description: string;
    acceptanceCriteria: string;
    executionContract: { exitPredicate: string; acceptanceCriteria: Array<{ text: string }> };
  };
  assert.equal(reloaded.title, "NOT-1: Reloaded title");
  assert.equal(reloaded.description, PARKED_CONTRACT_V2);
  assert.equal(
    reloaded.executionContract.exitPredicate,
    "The friend-path run command works with simulator proof; clean-machine proof moved out."
  );
  assert.ok(!reloaded.acceptanceCriteria.includes("[operator] Clean-machine proof attached"));
  assert.ok(reloaded.acceptanceCriteria.includes("Simulator proof attached"));

  // Attachments reconciled atomically: changed bytes land, the new file
  // appears, and the removed link disappears. The replaced blob is retained —
  // the frozen snapshot still references it until Resume re-freezes.
  const rows = listSourceAttachments(id);
  assert.deepEqual(
    rows.map((r) => r.linearAttachmentId).sort(),
    ["att-file-1", "att-file-3"]
  );
  const changed = rows.find((r) => r.linearAttachmentId === "att-file-1")!;
  assert.equal(changed.sha256, createHash("sha256").update(TARBALL_V2).digest("hex"));
  assert.deepEqual(fs.readFileSync(changed.blobPath!), TARBALL_V2);
  assert.ok(fs.existsSync(oldBlob), "blob still referenced by the frozen snapshot is retained");

  // Everything else is preserved: repository/configuration, workflow
  // instance, PR/head/branch, rounds, counters, sessions, and the open action.
  const after = getIssue(id)!;
  const preserved = (issue: typeof after) => ({
    repo: issue.repo,
    baseBranch: issue.baseBranch,
    developerAgentId: issue.developerAgentId,
    reviewerAgentId: issue.reviewerAgentId,
    maxReviewRounds: issue.maxReviewRounds,
    maxInfraAttempts: issue.maxInfraAttempts,
    maxCiAttempts: issue.maxCiAttempts,
    autoMerge: issue.autoMerge,
    status: issue.status,
    currentRound: issue.currentRound,
    infraAttempts: issue.infraAttempts,
    ciAttempts: issue.ciAttempts,
    branch: issue.branch,
    baseSha: issue.baseSha,
    headSha: issue.headSha,
    prNumber: issue.prNumber,
    prUrl: issue.prUrl,
    source: issue.source,
    externalId: issue.externalId,
    externalLabel: issue.externalLabel,
    externalUrl: issue.externalUrl,
  });
  assert.deepEqual(preserved(after), preserved(before));
  assert.equal(getActiveWorkflowInstance(id)!.id, instanceBefore.id);
  assert.deepEqual(getHumanAction(actionBefore.id)!, { ...actionBefore });
  assert.deepEqual(listWorkerSessionsForIssue(id), sessionsBefore);
  assert.equal(listWorkflowEventsForIssue(id).filter((e) => e.type === "issue.source_reloaded").length, 1);

  // The frozen snapshot still carries the old text AND the old manifest until Resume.
  const frozenAfter = getTaskSnapshot(after);
  assert.equal(frozenAfter.description, PARKED_CONTRACT_V1);
  assert.ok(frozenAfter.acceptanceCriteria.includes("[operator] Clean-machine proof attached"));
  assert.deepEqual(frozenAfter.sourceAttachments, frozenBefore.sourceAttachments);
  assert.ok(frozenAfter.sourceAttachments!.some((a) => a.linearAttachmentId === "att-link-1"));
  await app.close();
});

test("NOT-422: attachment-only parked reload shows sourceAttachments pending and Resume re-freezes the manifest", async () => {
  downloadBytes.set(FILE_URL, TARBALL_V1);
  const app = await buildApp();
  const id = await parkScopeWithAttachments(app);
  const { getIssue } = await import("../repository/issues.js");
  const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
  const { getTaskSnapshot, resolveHumanActionAndAdvance, TASK_SNAPSHOT_ARTIFACT_KIND } = await import(
    "../coordinator/commands.js"
  );
  const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
  const { materializeSourceAttachments } = await import("../coordinator/source-attachments.js");

  const oldBlob = listSourceAttachments(id).find((r) => r.kind === "file")!.blobPath!;
  const snapshotsBefore = listArtifactsForIssue(id).filter((a) => a.kind === TASK_SNAPSHOT_ARTIFACT_KIND).length;
  assert.equal(snapshotsBefore, 1);

  // Linear changed only the inputs: identical contract text (and the same
  // derived title), new bytes for the file, the link removed.
  downloadBytes.set(FILE_URL, TARBALL_V2);
  linearNode = {
    ...parkedNodeWith(PARKED_CONTRACT_V1, [{ id: "att-file-1", title: "repro.tar.gz", url: FILE_URL }]),
    title: "import me",
  };
  const res = await app.inject({ method: "POST", url: `/api/issues/${id}/reload-source` });
  assert.equal(res.statusCode, 200, res.body);

  // Text byte-identical, rows swapped, the replaced blob retained for the
  // frozen snapshot that still references it.
  const parked = getIssue(id)!;
  assert.equal(parked.title, BASE_LINEAR.title);
  assert.equal(parked.description, PARKED_CONTRACT_V1);
  assert.ok(parked.acceptanceCriteria!.includes("[operator] Clean-machine proof attached"));
  assert.deepEqual(
    listSourceAttachments(id).map((r) => r.linearAttachmentId),
    ["att-file-1"]
  );
  assert.ok(fs.existsSync(oldBlob), "replaced blob retained while the frozen snapshot references it");
  assert.ok(getTaskSnapshot(parked).sourceAttachments!.some((a) => a.linearAttachmentId === "att-link-1"));

  // Issue Detail reads the amended inputs as pending for the next snapshot —
  // and only the manifest is pending.
  const detail = (await app.inject({ method: "GET", url: `/api/issues/${id}` })).json() as {
    pendingSnapshotChangedFields: string[];
  };
  assert.deepEqual(detail.pendingSnapshotChangedFields, ["sourceAttachments"]);

  // Resume re-freezes exactly one new snapshot carrying the amended manifest.
  const action = listHumanActionsForIssue(id).find((a) => a.actionType === "product_scope_decision")!;
  const resolved = resolveHumanActionAndAdvance(action.id, "operator", "resume");
  assert.equal(resolved.ok, true);
  const snapshots = listArtifactsForIssue(id).filter((a) => a.kind === TASK_SNAPSHOT_ARTIFACT_KIND);
  assert.equal(snapshots.length, snapshotsBefore + 1);
  const events = listWorkflowEventsForIssue(id);
  const refreshed = events.filter((e) => e.type === "task_snapshot.refreshed");
  assert.equal(refreshed.length, 1);
  assert.deepEqual(JSON.parse(refreshed[0].payloadJson!).changedFields, ["sourceAttachments"]);
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf("task_snapshot.refreshed") < types.lastIndexOf("repair.started"));

  const snap = getTaskSnapshot(getIssue(id)!);
  assert.equal(snap.sourceAttachments!.length, 1);
  assert.equal(snap.sourceAttachments![0]!.sha256, createHash("sha256").update(TARBALL_V2).digest("hex"));
  // The next round materializes the amended bytes — never "stored bytes are missing".
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-scope-att-only-"));
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  const materialized = materializeSourceAttachments(worktree, snap.sourceAttachments);
  assert.equal(materialized.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(worktree, materialized[0]!.relativePath)), TARBALL_V2);
  await app.close();
});

test("NOT-422: failed parked reloads preserve prior text, attachments, workflow, and the open action", async () => {
  const { getIssue } = await import("../repository/issues.js");
  const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
  const { getHumanAction, listHumanActionsForIssue } = await import("../repository/human-actions.js");

  async function expectIntact(id: string, label: string) {
    const issue = getIssue(id)!;
    assert.equal(issue.title, BASE_LINEAR.title, `${label}: title intact`);
    assert.equal(issue.description, PARKED_CONTRACT_V1, `${label}: description intact`);
    assert.ok(issue.acceptanceCriteria!.includes("[operator] Clean-machine proof attached"), `${label}: criteria intact`);
    const rows = listSourceAttachments(id);
    assert.deepEqual(
      rows.map((r) => r.linearAttachmentId).sort(),
      ["att-file-1", "att-link-1"],
      `${label}: attachment rows intact`
    );
    const file = rows.find((r) => r.kind === "file")!;
    assert.deepEqual(fs.readFileSync(file.blobPath!), TARBALL_V1, `${label}: blob bytes intact`);
    const action = listHumanActionsForIssue(id).find((a) => a.actionType === "product_scope_decision")!;
    assert.equal(getHumanAction(action.id)!.status, "open", `${label}: scope action still open`);
    assert.ok(getActiveWorkflowInstance(id), `${label}: workflow still active`);
    assert.equal(issue.status, "needs_human", `${label}: still parked`);
    assert.ok(!listWorkflowEventsForIssue(id).some((e) => e.type === "issue.source_reloaded"), `${label}: no reload event`);
  }

  // A new file whose download fails: 502, prior snapshot untouched.
  downloadBytes.set(FILE_URL, TARBALL_V1);
  const app = await buildApp();
  const failedId = await parkScopeWithAttachments(app);
  const BAD_URL = "https://uploads.linear.app/abc/missing.bin";
  downloadBytes.set(BAD_URL, "http500");
  linearNode = parkedNodeWith(PARKED_CONTRACT_V2, [
    { id: "att-file-1", title: "repro.tar.gz", url: FILE_URL },
    { id: "att-file-9", title: "missing.bin", url: BAD_URL },
  ]);
  const failed = await app.inject({ method: "POST", url: `/api/issues/${failedId}/reload-source` });
  assert.equal(failed.statusCode, 502, failed.body);
  await expectIntact(failedId, "download failure");

  // A malformed amended contract: actionable 400, prior snapshot untouched.
  const badId = await parkScopeWithAttachments(app);
  const malformed = PARKED_CONTRACT_V2.replace("feature", "teleport");
  downloadBytes.set(FILE_URL, TARBALL_V1);
  linearNode = parkedNodeWith(malformed, [{ id: "att-file-1", title: "repro.tar.gz", url: FILE_URL }]);
  const bad = await app.inject({ method: "POST", url: `/api/issues/${badId}/reload-source` });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.match((bad.json() as { error: string }).error, /unknown execution mode/);
  await expectIntact(badId, "contract failure");
  await app.close();
});
