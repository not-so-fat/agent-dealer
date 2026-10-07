// packages/server/src/routes/issues-delete.test.ts
//
// NOT-365: DELETE /api/issues/:id — Dealer-local hard delete.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-delete-"));

const { migrate, getDb, getDataDir } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { registerIssueRoutes } = await import("./issues.js");
const { getIssue, transitionIssue } = await import("../repository/issues.js");
const { enqueueIssue, getQueuedEntryForIssue, listQueuedEntries } = await import("../repository/queue-entries.js");
const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { startWorkflowInstance, completeWorkflowInstance } = await import("../repository/workflow-events.js");
const { createWorkerSession, startSession, completeSession } = await import("../repository/worker-sessions.js");
const { enqueueWorkItem, cancelWorkItem } = await import("../repository/work-items.js");
const { createHumanAction } = await import("../repository/human-actions.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { recordUsageEvent } = await import("../repository/usage-events.js");
const { recordFailureCauses } = await import("../repository/failure-causes.js");
const { insertSessionActivityEvent } = await import("../repository/session-activity.js");
const { reconcileFinding } = await import("../repository/findings.js");
const { replaceSourceAttachments } = await import("../repository/source-attachments.js");
const { getSourceAttachmentsDir } = await import("../paths.js");
const { countIssueScopedRows, removeDealerPathContained, ISSUE_SCOPED_TABLES } = await import(
  "../coordinator/delete-issue.js"
);

before(() => {
  migrate();
});

async function buildApp() {
  const app = Fastify();
  await registerIssueRoutes(app);
  return app;
}

function cleanTables() {
  getDb().exec(`
    DELETE FROM review_publications;
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM authority_attempts;
    DELETE FROM failure_causes;
    DELETE FROM session_activity_events;
    DELETE FROM findings;
    DELETE FROM usage_events;
    DELETE FROM issue_source_attachments;
    DELETE FROM workflow_instances;
    DELETE FROM queue_entries;
    DELETE FROM issues;
  `);
}

beforeEach(() => {
  cleanTables();
});

async function createIssue(
  app: Awaited<ReturnType<typeof buildApp>>,
  extra: Record<string, unknown> = {},
  enqueue = true
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: {
      title: "Delete me",
      repo: "acme/app",
      baseBranch: "main",
      developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
      reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
      enqueue,
      ...extra,
    },
  });
  assert.equal(res.statusCode, 200, `create failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

function setStatus(issueId: string, status: string): void {
  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run(status, issueId);
}

/** Write a Dealer-owned file under AGENT_DEALER_HOME and return its path. */
function homeFile(name: string, content = "dealer-owned bytes"): string {
  const file = path.join(getDataDir(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Seed one row in every issue-scoped table for a settled (completed-instance,
 * terminal-session, cancelled-work-item) issue, with real Dealer-owned files
 * for every collected path kind. Returns the file paths the delete must remove.
 */
function seedFullHistory(issueId: string): { files: string[]; attachmentDir: string } {
  const logFile = homeFile(`.temporal/logs/${issueId}-developer.ndjson`, '{"t":"log"}\n');
  const artifactBlob = homeFile(`artifact-${issueId}.ndjson`, '{"t":"trace"}\n');
  const failureLog = homeFile(`failure-${issueId}.log`, "boom\n");
  const attachmentBlob = path.join(getSourceAttachmentsDir(), issueId, "spec.pdf");
  fs.mkdirSync(path.dirname(attachmentBlob), { recursive: true });
  fs.writeFileSync(attachmentBlob, "%PDF-bytes");

  const instance = startWorkflowInstance(issueId, "dev-reviewer-v1");
  const session = createWorkerSession({ issueId, role: "developer", round: 1 });
  const created = appendWorkflowEvent({
    issueId,
    type: "issue.created",
    actorType: "human",
    stage: "ready",
    workflowInstanceId: instance.id,
  });
  appendWorkflowEvent({
    issueId,
    type: "worker.completed",
    actorType: "developer",
    stage: "developing",
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    causationEventId: created.id,
  });
  const item = enqueueWorkItem({ issueId, workflowInstanceId: instance.id, kind: "developer", round: 1 });
  // A settled (cancelled) work item still owns a publication claim row.
  getDb()
    .prepare(
      `INSERT INTO review_publications (work_item_id, state, result_json, event, used_comment_fallback, claimed_at, updated_at)
       VALUES (?, 'published', '{}', 'commented', 0, ?, ?)`
    )
    .run(item.id, new Date().toISOString(), new Date().toISOString());
  cancelWorkItem(item.id);
  createHumanAction({
    issueId,
    workflowInstanceId: instance.id,
    actionType: "attempts_exhausted",
    reason: "spent",
    question: "Retry?",
  });
  reconcileFinding({
    issueId,
    fingerprint: "fp-1",
    severity: "major",
    title: "Race",
    rationale: "racy",
    round: 1,
  });
  createIssueArtifact({ issueId, workerSessionId: session.id, kind: "dev_trace", blobPath: artifactBlob, author: "developer" });
  recordUsageEvent({ issueId, workerSessionId: session.id, role: "developer" });
  recordFailureCauses([
    {
      issueId,
      workflowInstanceId: instance.id,
      cause: {
        code: "agent_cli_crash",
        domain: "infrastructure",
        primary: true,
        confidence: "high",
        evidenceSource: "session_error",
        occurredAt: null,
        eventCursor: null,
        rawReason: "cli died",
        sessionId: session.id,
        logPath: failureLog,
        eventId: null,
        eventType: null,
        quality: "exact",
      },
    },
  ]);
  insertSessionActivityEvent({
    issueId,
    workerSessionId: session.id,
    activityKind: "assistant",
    state: "completed",
    summary: "did a thing",
  });
  replaceSourceAttachments(issueId, [
    {
      linearAttachmentId: "att-1",
      kind: "file",
      title: "spec.pdf",
      safeFileName: "spec.pdf",
      blobPath: attachmentBlob,
      contentType: "application/pdf",
      sizeBytes: 10,
      sha256: "abc",
      url: "https://linear.app/file/att-1",
      subtitle: null,
      source: null,
    },
  ]);
  // A settled (closed) authority attempt for this issue — deleted, never blocking.
  getDb()
    .prepare(
      `INSERT INTO authority_attempts
        (id, owner_kind, owner_id, idempotency_key, authority_id, deck_id, run_id, attempt_id,
         ttl_ms, tool_scope_hint_json, status, stale_at, expires_at, created_at, updated_at)
       VALUES (?, 'developer', ?, ?, 'auth-1', 'deck-1', 'run-1', 'attempt-1',
         60000, NULL, 'closed', NULL, ?, ?, ?)`
    )
    .run(
      `aa-${issueId}`,
      `${issueId}:developer`,
      `idem-${issueId}`,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
  completeSession(session.id, { status: "done", logPath: logFile });
  completeWorkflowInstance(instance.id, "done");

  const counts = countIssueScopedRows(issueId);
  for (const table of ISSUE_SCOPED_TABLES) {
    if (table === "issues") continue;
    assert.ok(counts[table]! > 0, `fixture must seed ${table}`);
  }
  return { files: [logFile, artifactBlob, failureLog, attachmentBlob], attachmentDir: path.join(getSourceAttachmentsDir(), issueId) };
}

function foreignKeyViolations(): string[] {
  return (getDb().prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>)
    .map((r) => r.table);
}

test("DELETE removes a ready issue; detail 404s and list/queue no longer name it", async () => {
  const app = await buildApp();
  const id = await createIssue(app);
  assert.ok(getQueuedEntryForIssue(id), "ready issue starts queued");

  const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
  assert.equal(del.statusCode, 200, del.body);
  const body = del.json() as { deleted: boolean; removedQueueEntry: boolean; residualPaths: string[] };
  assert.equal(body.deleted, true);
  assert.equal(body.removedQueueEntry, true);
  assert.deepEqual(body.residualPaths, []);

  assert.equal((await app.inject({ method: "GET", url: `/api/issues/${id}` })).statusCode, 404);
  const list = (await app.inject({ method: "GET", url: "/api/issues" })).json() as Array<{ id: string }>;
  assert.ok(!list.some((i) => i.id === id));
  assert.equal(getQueuedEntryForIssue(id), null);
  assert.equal(listQueuedEntries().some((e) => e.issueId === id), false);
  assert.deepEqual(foreignKeyViolations(), []);
  await app.close();
});

test("DELETE removes done and closed issues (unguarded terminal states stay deletable)", async () => {
  const app = await buildApp();
  for (const status of ["done", "closed"] as const) {
    const id = await createIssue(app, {}, false);
    setStatus(id, status);
    const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
    assert.equal(del.statusCode, 200, `${status}: ${del.body}`);
    assert.equal((await app.inject({ method: "GET", url: `/api/issues/${id}` })).statusCode, 404);
    assert.equal(getIssue(id), null);
  }
  assert.deepEqual(foreignKeyViolations(), []);
  await app.close();
});

test("DELETE 404s for an unknown issue", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "DELETE", url: "/api/issues/does-not-exist" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("DELETE empties every issue-scoped table and removes blobs/logs with no FK violations", async () => {
  const app = await buildApp();
  const id = await createIssue(app, {}, false);
  setStatus(id, "done");
  const { files, attachmentDir } = seedFullHistory(id);
  for (const f of files) assert.ok(fs.existsSync(f), `fixture file must exist: ${f}`);

  const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
  assert.equal(del.statusCode, 200, del.body);
  assert.deepEqual((del.json() as { residualPaths: string[] }).residualPaths, []);

  const counts = countIssueScopedRows(id);
  for (const [table, n] of Object.entries(counts)) {
    assert.equal(n, 0, `${table} must be empty after delete`);
  }
  assert.deepEqual(foreignKeyViolations(), []);
  for (const f of files) assert.ok(!fs.existsSync(f), `blob/log must be removed: ${f}`);
  assert.ok(!fs.existsSync(attachmentDir), "issue source-attachment dir must be removed");
  assert.equal((await app.inject({ method: "GET", url: `/api/issues/${id}` })).statusCode, 404);
  await app.close();
});

/** Full seeded-database plus file-tree snapshot — guard refusals must change neither. */
function snapshotAll(): { db: string; files: string[] } {
  const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((n) => !n.startsWith("sqlite_"));
  const db: Record<string, unknown[]> = {};
  for (const table of tables) {
    db[table] = getDb().prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as unknown[];
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      files.push(p);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(p);
    }
  };
  walk(getDataDir());
  return { db: JSON.stringify(db), files: files.sort() };
}

async function assertRefused409(
  app: Awaited<ReturnType<typeof buildApp>>,
  id: string,
  needle: RegExp,
  before: { db: string; files: string[] }
): Promise<void> {
  const res = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
  assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${res.body}`);
  assert.match((res.json() as { error: string }).error, needle);
  assert.ok(getIssue(id), "refused delete must keep the issue row");
  const after = snapshotAll();
  assert.equal(after.db, before.db, "refused delete must change no database row");
  assert.deepEqual(after.files, before.files, "refused delete must change no file");
}

test("DELETE refuses running/parked statuses with 409 naming the state", async () => {
  const app = await buildApp();
  for (const status of ["developing", "reviewing", "repairing", "final_review", "needs_human"] as const) {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    setStatus(id, status);
    await assertRefused409(app, id, new RegExp(`is ${status}`), snapshotAll());
  }
  await app.close();
});

test("DELETE refuses an active workflow instance, running session, and live work items", async () => {
  const app = await buildApp();

  // Active workflow instance (never completed).
  {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    startWorkflowInstance(id, "dev-reviewer-v1");
    await assertRefused409(app, id, /active workflow instance/, snapshotAll());
    cleanTables();
  }

  // Running worker session.
  {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    const session = createWorkerSession({ issueId: id, role: "developer", round: 2 });
    startSession(session.id);
    await assertRefused409(app, id, /running worker session/, snapshotAll());
    cleanTables();
  }

  // Pending and leased work items each block.
  for (const live of ["pending", "leased"] as const) {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    const instance = startWorkflowInstance(id, "dev-reviewer-v1");
    const item = enqueueWorkItem({ issueId: id, workflowInstanceId: instance.id, kind: "reviewer", round: 1 });
    if (live === "leased") {
      getDb().prepare("UPDATE work_items SET status = 'leased', lease_owner = 'test' WHERE id = ?").run(item.id);
    }
    await assertRefused409(app, id, new RegExp(`${live} work item`), snapshotAll());
    cleanTables();
  }
  await app.close();
});

test("DELETE refuses active authority attempts and existing worktrees", async () => {
  const app = await buildApp();

  // Active authority attempt naming the issue.
  {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    getDb()
      .prepare(
        `INSERT INTO authority_attempts
          (id, owner_kind, owner_id, idempotency_key, authority_id, deck_id, run_id, attempt_id,
           ttl_ms, tool_scope_hint_json, status, stale_at, expires_at, created_at, updated_at)
         VALUES (?, 'reviewer', ?, ?, 'auth-9', 'deck-1', 'run-1', 'attempt-9',
           60000, NULL, 'active', NULL, ?, ?, ?)`
      )
      .run(`aa-live-${id}`, `${id}:reviewer`, `idem-live-${id}`, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    await assertRefused409(app, id, /active authority attempt/, snapshotAll());
    cleanTables();
  }

  // A session-recorded checkout that still exists on disk blocks, naming the path.
  {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    const wt = fs.mkdtempSync(path.join(getDataDir(), "wt-"));
    fs.writeFileSync(path.join(wt, "wip.txt"), "uncommitted");
    const session = createWorkerSession({ issueId: id, role: "developer", round: 3 });
    completeSession(session.id, { status: "failed", worktreePath: wt });
    await assertRefused409(app, id, new RegExp(wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), snapshotAll());
    fs.rmSync(wt, { recursive: true, force: true });
    cleanTables();
  }

  // A recorded worktree path that no longer exists does not block.
  {
    const id = await createIssue(app, {}, false);
    seedFullHistory(id);
    const session = createWorkerSession({ issueId: id, role: "developer", round: 3 });
    completeSession(session.id, { status: "done", worktreePath: path.join(getDataDir(), "wt-long-gone") });
    const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
    assert.equal(del.statusCode, 200, del.body);
  }
  await app.close();
});

test("file cleanup removes in-root files, never follows out-of-root paths, reports failures as residuals", async () => {
  const home = getDataDir();
  // Outside sentinel: must never be touched by any path below.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-delete-outside-"));
  const sentinel = path.join(outsideDir, "sentinel.txt");
  fs.writeFileSync(sentinel, "untouchable");

  // In-root file is removed, no residual.
  const owned = homeFile("owned.txt");
  assert.equal(removeDealerPathContained(owned, home), null);
  assert.ok(!fs.existsSync(owned));

  // `..` escape to the sentinel is refused and reported.
  const escape = path.join(home, "sub", "..", "..", path.basename(path.dirname(sentinel)), "sentinel.txt");
  fs.mkdirSync(path.join(home, "sub"), { recursive: true });
  assert.equal(removeDealerPathContained(escape, home), escape);
  assert.ok(fs.existsSync(sentinel));

  // Absolute out-of-root path is refused and reported.
  assert.equal(removeDealerPathContained(sentinel, home), sentinel);
  assert.ok(fs.existsSync(sentinel));

  // Symlink inside the home pointing outside is never followed: the link stays,
  // the target stays, and the path reports as residual.
  const link = path.join(home, "evil-link.txt");
  fs.symlinkSync(sentinel, link);
  assert.equal(removeDealerPathContained(link, home), link);
  assert.ok(fs.existsSync(sentinel), "symlink target outside the home must survive");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link itself must not be followed into removal");

  // An induced unlink failure (read-only parent dir) reports a residual.
  const lockedDir = path.join(home, "locked");
  fs.mkdirSync(lockedDir, { recursive: true });
  const lockedFile = path.join(lockedDir, "x.txt");
  fs.writeFileSync(lockedFile, "x");
  fs.chmodSync(lockedDir, 0o555);
  try {
    assert.equal(removeDealerPathContained(lockedFile, home), lockedFile);
    assert.ok(fs.existsSync(sentinel));
  } finally {
    fs.chmodSync(lockedDir, 0o755);
  }

  // Already-gone paths are clean, not residual.
  assert.equal(removeDealerPathContained(path.join(home, "never-existed.txt"), home), null);

  fs.rmSync(link, { force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(outsideDir), "test must clean up its outside dir");
});

test("DELETE reports safe-path cleanup failures as residuals after the record deletion", async () => {
  const app = await buildApp();
  const id = await createIssue(app, {}, false);
  setStatus(id, "done");
  const lockedDir = path.join(getDataDir(), `locked-${id}`);
  fs.mkdirSync(lockedDir, { recursive: true });
  const blob = path.join(lockedDir, "trace.ndjson");
  fs.writeFileSync(blob, "{}\n");
  const session = createWorkerSession({ issueId: id, role: "developer", round: 1 });
  completeSession(session.id, { status: "done", logPath: blob });
  fs.chmodSync(lockedDir, 0o555);
  try {
    const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
    assert.equal(del.statusCode, 200, del.body);
    const body = del.json() as { deleted: boolean; residualPaths: string[] };
    assert.equal(body.deleted, true);
    assert.ok(body.residualPaths.includes(blob), `expected residual, got ${JSON.stringify(body)}`);
    // The database row is still gone — cleanup never resurrects it.
    assert.equal(getIssue(id), null);
    assert.equal((await app.inject({ method: "GET", url: `/api/issues/${id}` })).statusCode, 404);
  } finally {
    fs.chmodSync(lockedDir, 0o755);
    fs.rmSync(lockedDir, { recursive: true, force: true });
  }
  await app.close();
});

test("DELETE of a linear-sourced issue makes zero Linear/GitHub calls and keeps the ticket identifiers local", async () => {
  const app = await buildApp();
  const id = await createIssue(
    app,
    {
      source: "linear",
      externalId: "lin-123",
      externalLabel: "NOT-123",
      externalUrl: "https://linear.app/not-so-fat/issue/NOT-123",
    },
    false
  );
  setStatus(id, "done");
  seedFullHistory(id);

  // Outbound-adapter spy: the delete path must perform no fetch at all, and its
  // module must not import any outbound adapter — source identifiers stay local.
  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((...args: Parameters<typeof fetch>) => {
    fetches.push(String(args[0]));
    return realFetch(...args);
  }) as typeof fetch;
  try {
    const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
    assert.equal(del.statusCode, 200, del.body);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(fetches, [], "deleting a linear issue must make zero outbound calls");

  const moduleSource = fs.readFileSync(
    new URL("../coordinator/delete-issue.js", import.meta.url).pathname.replace(/\.js$/, ".ts"),
    "utf8"
  );
  assert.ok(!moduleSource.includes("adapters/"), "delete command must not import any outbound adapter");
  assert.ok(!moduleSource.includes("linear-inbox"), "no Linear client usage");
  assert.ok(!moduleSource.includes("linear-graphql"), "no Linear client usage");
  assert.ok(!moduleSource.includes("adapters/github"), "no GitHub client usage");
  assert.ok(!/[^a-z]fetch\(/.test(moduleSource), "delete command must not call fetch");
  await app.close();
});

test("DELETE closes over queue history: admitted/removed rows for the issue go too", async () => {
  const app = await buildApp();
  const id = await createIssue(app);
  // Cycle the queue entry so non-live history rows exist alongside the live one.
  getDb().prepare("UPDATE queue_entries SET state = 'admitted' WHERE issue_id = ?").run(id);
  enqueueIssue(id);
  const before = getDb().prepare("SELECT COUNT(*) AS n FROM queue_entries WHERE issue_id = ?").get(id) as { n: number };
  assert.ok(before.n >= 2);
  const del = await app.inject({ method: "DELETE", url: `/api/issues/${id}` });
  assert.equal(del.statusCode, 200, del.body);
  const after = getDb().prepare("SELECT COUNT(*) AS n FROM queue_entries WHERE issue_id = ?").get(id) as { n: number };
  assert.equal(after.n, 0);
  await app.close();
});
