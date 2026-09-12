// packages/server/src/db/migrate-to-issues.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-migration-"));

const { migrate, getDb, getDbPath, closeDb } = await import("./index.js");
const { runMigration, rollbackMigration, isServiceRunning } = await import("./migrate-to-issues.js");
const { BUILTIN_AGENT_CLAUDE_ID, Issue, WorkerSession, WorkflowEvent, WorkflowInstance, HumanAction, IssueArtifact } =
  await import("@agent-dealer/shared");
const { createIssue, getIssue, listIssues } = await import("../repository/issues.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listWorkflowEventsForIssue, listWorkflowInstancesForIssue } = await import("../repository/workflow-events.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { createRun, addArtifact } = await import("../repository/runs.js");

const NOW = "2026-01-01T00:00:00.000Z";

/** A genuinely alive, same-user child pid — safe to signal, unlike e.g. pid 1 (which is
 * alive but throws EPERM rather than ESRCH for an unprivileged process.kill probe). */
function spawnLiveChild(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

/** Every test gets its own AGENT_DEALER_HOME + a freshly migrated (current schema) db,
 * matching how the rest of this repo's repository tests isolate state — but reopened per
 * test here (via closeDb()) since, unlike a single-database test file, this suite needs a
 * clean legacy+issue-model database for every scenario. */
function freshHome(): void {
  closeDb();
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-issue-migration-"));
  migrate();
}

/** Seeds two legacy lineages directly into the current test's database and returns its path. */
function seedLegacyLineages(): string {
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-a1', 'manual', 'run-a1', 'code', 'Done task', '/repo', ?, 'done', NULL, ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO artifacts (id, run_id, kind, content_json, author, created_at)
     VALUES ('art-a1', 'run-a1', 'execution_result', '{"exitCode":0}', 'agent', ?)`
  ).run(NOW);
  db.prepare(
    `INSERT INTO events (id, run_id, type, payload_json, ts) VALUES ('evt-a1', 'run-a1', 'run.created', NULL, ?)`
  ).run(NOW);

  // Lineage B: two runs sharing a lineage_id, latest is plan_pending — one issue, status
  // 'ready', legacy session status 'cancelled'.
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-b1', 'manual', 'run-b1', 'code', 'Retried task', '/repo', ?, 'failed', NULL, ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-b2', 'manual', 'run-b2', 'code', 'Retried task', '/repo', ?, 'plan_pending', 'run-b1', ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);

  return getDbPath();
}

test("migrates lineages into issues, is readable through production repositories, and renames legacy tables", () => {
  freshHome();
  const dbPath = seedLegacyLineages();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);
  assert.equal(report.alreadyMigrated, false);
  assert.equal(report.issuesCreated, 2);
  assert.equal(report.legacySessionsCreated, 3);
  assert.equal(report.artifactsRepointed, 1);
  assert.equal(report.eventsRepointed, 1);

  // Read back through the real production repositories (getDb() reopened against this same
  // AGENT_DEALER_HOME/dealer.db, the exact file runMigration operated on) and zod-parse
  // every returned shape — the "parse through shared schemas and are returned by
  // production repositories" acceptance criterion, not just a raw SQL check.
  const issues = listIssues();
  assert.equal(issues.length, 2);
  for (const issue of issues) Issue.parse(issue);

  const doneIssue = issues.find((i) => i.title === "Done task")!;
  const readyIssue = issues.find((i) => i.title === "Retried task")!;
  assert.equal(doneIssue.status, "done");
  assert.equal(readyIssue.status, "ready");

  const doneSessions = listWorkerSessionsForIssue(doneIssue.id);
  assert.equal(doneSessions.length, 1);
  assert.equal(doneSessions[0].role, "legacy");
  assert.equal(doneSessions[0].status, "done");
  for (const s of doneSessions) WorkerSession.parse(s);

  const readySessions = listWorkerSessionsForIssue(readyIssue.id);
  assert.equal(readySessions.length, 2);
  // run-b1 was 'failed' (→ session 'failed'), run-b2 (the latest) was 'plan_pending' (→
  // session 'cancelled' — nothing survives as a completed attempt under the new model).
  assert.deepStrictEqual(readySessions.map((s) => s.status).sort(), ["cancelled", "failed"]);
  for (const s of readySessions) WorkerSession.parse(s);

  const doneInstances = listWorkflowInstancesForIssue(doneIssue.id);
  assert.equal(doneInstances.length, 1);
  assert.equal(doneInstances[0].outcome, "migrated");
  for (const inst of doneInstances) WorkflowInstance.parse(inst);

  const doneEvents = listWorkflowEventsForIssue(doneIssue.id);
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].type, "legacy.imported");
  for (const e of doneEvents) WorkflowEvent.parse(e);

  const readyActions = listHumanActionsForIssue(readyIssue.id);
  assert.equal(readyActions.length, 0); // 'ready' mapping has no human action

  const doneArtifacts = listArtifactsForIssue(doneIssue.id);
  assert.equal(doneArtifacts.length, 1);
  assert.equal(doneArtifacts[0].kind, "execution_result");
  for (const a of doneArtifacts) IssueArtifact.parse(a);

  // Legacy tables renamed; "artifacts" (shared table) is NOT renamed.
  const tableNames = (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tableNames.includes("legacy_v0_runs"));
  assert.ok(tableNames.includes("legacy_v0_events"));
  assert.ok(tableNames.includes("legacy_v0_approval_gates"));
  assert.equal(tableNames.includes("runs"), false);
  assert.equal(tableNames.includes("artifacts_migrated"), false);
  assert.equal(tableNames.includes("artifacts"), true);
});

test("a legacy run left in 'review' seeds an open final_review human action", () => {
  freshHome();
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-r1', 'manual', 'run-r1', 'code', 'Review task', '/repo', ?, 'review', NULL, ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  const dbPath = getDbPath();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  const issue = listIssues().find((i) => i.title === "Review task")!;
  assert.equal(issue.status, "final_review");
  const actions = listHumanActionsForIssue(issue.id);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actionType, "final_review");
  HumanAction.parse(actions[0]);
});

test("after a restart, a fresh legacy run can still write an artifact without a foreign-key violation", () => {
  // Reproduces the exact reviewer-reported regression: runMigration -> migrate() (the
  // ordinary additive migration a real restart runs, which recreates a fresh, empty
  // "runs" table via CREATE TABLE IF NOT EXISTS) -> createRun -> addArtifact. Before the
  // artifacts-rebuild fix, the rename of runs -> legacy_v0_runs left artifacts.run_id's FK
  // declaration pointed at legacy_v0_runs, so this exact sequence failed with
  // "FOREIGN KEY constraint failed".
  freshHome();
  const dbPath = seedLegacyLineages();
  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  migrate(); // the restart every real cutover is followed by

  const freshRun = createRun({
    title: "Fresh post-cutover run",
    taskCategory: "code",
    status: "plan_pending",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    repo: "/repo",
  });
  assert.doesNotThrow(() => addArtifact(freshRun.id, "task_snapshot", { hello: "world" }, "system"));
});

test("after a restart, the fresh runs/events/approval_gates tables have their secondary indexes back", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  migrate();

  const db = getDb();
  const indexNames = (table: string) =>
    (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name);

  assert.ok(indexNames("runs").includes("idx_runs_status"), "fresh runs table should have idx_runs_status");
  assert.ok(indexNames("runs").includes("idx_runs_external"), "fresh runs table should have idx_runs_external");
  assert.ok(indexNames("events").includes("idx_events_run"), "fresh events table should have idx_events_run");
  assert.ok(
    indexNames("approval_gates").includes("idx_gates_run"),
    "fresh approval_gates table should have idx_gates_run"
  );

  // And the legacy data is still indexed too, just under a renamed index.
  assert.ok(indexNames("legacy_v0_runs").includes("legacy_v0_idx_runs_status"));
});

test("a legacy run left in 'failed' seeds an open attempts_exhausted human action", () => {
  freshHome();
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-f1', 'manual', 'run-f1', 'code', 'Failed task', '/repo', ?, 'failed', NULL, ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  const dbPath = getDbPath();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  const issue = listIssues().find((i) => i.title === "Failed task")!;
  assert.equal(issue.status, "needs_human");
  Issue.parse(issue);
  const actions = listHumanActionsForIssue(issue.id);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actionType, "attempts_exhausted");
  HumanAction.parse(actions[0]);

  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "failed");
});

test("a legacy run left in 'cancelled' maps to a closed issue with no human action", () => {
  freshHome();
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-x1', 'manual', 'run-x1', 'code', 'Cancelled task', '/repo', ?, 'cancelled', NULL, ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  const dbPath = getDbPath();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  const issue = listIssues().find((i) => i.title === "Cancelled task")!;
  assert.equal(issue.status, "closed");
  assert.equal(issue.currentOwner, "system");
  Issue.parse(issue);
  assert.equal(listHumanActionsForIssue(issue.id).length, 0);

  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "cancelled");
});

test("a legacy run whose agent was since deleted migrates with a null agent reference instead of violating the foreign key", () => {
  freshHome();
  const dbPath = getDbPath();
  // getDb()'s connection runs with foreign_keys = ON, so seeding a dangling agent_id
  // through it would fail at INSERT time — exactly what the app itself would enforce via
  // deleteAgent(). A real dangling reference like this can still reach a production
  // database (an older app version, or direct DB surgery), so seed it here through a
  // separate raw connection with FK enforcement off, purely to reach that state.
  const raw = new Database(dbPath);
  raw.pragma("foreign_keys = OFF");
  raw.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-deleted-agent', 'manual', 'run-deleted-agent', 'code', 'Orphaned agent task', '/repo',
       'agent-does-not-exist-anymore', 'done', NULL, ?, ?)`
  ).run(NOW, NOW);
  raw.close();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  const issue = listIssues().find((i) => i.title === "Orphaned agent task")!;
  Issue.parse(issue); // developerAgentId/reviewerAgentId are nullable — this must still parse
  assert.equal(issue.developerAgentId, null);
  assert.equal(issue.reviewerAgentId, null);

  const sessions = listWorkerSessionsForIssue(issue.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agentId, null);
  WorkerSession.parse(sessions[0]);
});

test("does not touch a pre-existing genuine issue and its artifacts created before the migration ran", () => {
  freshHome();
  const preexisting = createIssue({
    title: "Already using the new model",
    repo: "/repo",
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
  const preexistingArtifact = createIssueArtifact({
    issueId: preexisting.id,
    kind: "task_snapshot",
    content: { hello: "world" },
    author: "system",
  });

  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
      lineage_id, created_at, updated_at)
     VALUES ('run-c1', 'manual', 'run-c1', 'code', 'Legacy task', '/repo', ?, 'done', NULL, ?, ?)`
  ).run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  const dbPath = getDbPath();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);
  assert.equal(report.issuesCreated, 1); // only the legacy lineage, not the pre-existing issue

  const stillThere = getIssue(preexisting.id);
  assert.ok(stillThere);
  Issue.parse(stillThere);
  assert.equal(stillThere!.title, "Already using the new model");

  const artifacts = listArtifactsForIssue(preexisting.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].id, preexistingArtifact.id);
});

test("refuses via schema validation and never creates a backup when a legacy table is missing", () => {
  freshHome();
  getDb().exec("DROP TABLE approval_gates");
  const dbPath = getDbPath();

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.ok(report.mismatches.length > 0);
  assert.match(report.mismatches[0], /approval_gates/);
  assert.equal(fs.existsSync(`${dbPath}.pre-issue-migration-backup`), false);
});

test("rolls back and leaves the original tables + a usable backup when a lineage_id points nowhere", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  getDb()
    .prepare(
      `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
        lineage_id, created_at, updated_at)
       VALUES ('run-orphan', 'manual', 'run-orphan', 'code', 'Orphan', '/repo', ?, 'done', 'does-not-exist', ?, ?)`
    )
    .run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.ok(report.mismatches.length > 0);

  const tables = (
    new Database(dbPath, { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);
  assert.ok(tables.includes("runs")); // untouched — rollback happened
  assert.equal(tables.includes("legacy_v0_runs"), false);

  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  assert.ok(fs.existsSync(backupPath));
  const backupDb = new Database(backupPath, { readonly: true });
  const backupRunCount = (backupDb.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
  assert.ok(backupRunCount > 0);
  backupDb.close();
});

test("second invocation after a completed migration is a safe no-op and does not replace the backup", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const first = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(first.mismatches, []);

  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  const backupBytesBefore = fs.readFileSync(backupPath);

  const second = runMigration(dbPath, { skipServiceCheck: true });
  assert.equal(second.alreadyMigrated, true);
  assert.deepStrictEqual(second.mismatches, []);
  assert.equal(second.issuesCreated, 0);

  const backupBytesAfter = fs.readFileSync(backupPath);
  assert.deepStrictEqual(backupBytesBefore, backupBytesAfter);
});

test("refuses without touching data when a backup already exists from a prior attempt", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  fs.writeFileSync(backupPath, "stale-backup-marker");

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.ok(report.mismatches.length > 0);
  assert.match(report.mismatches[0], /backup already exists/);

  // The stale backup is untouched — never replaced.
  assert.equal(fs.readFileSync(backupPath, "utf8"), "stale-backup-marker");
  // And the live database was never migrated.
  const tables = (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tables.includes("runs"));
});

test("refuses to migrate while the service is running, before any backup is made", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const runStatePath = path.join(path.dirname(dbPath), "run.json");
  fs.writeFileSync(runStatePath, JSON.stringify({ serverPid: process.pid, port: 2221 }));

  const report = runMigration(dbPath); // no skipServiceCheck — production path
  assert.ok(report.mismatches.length > 0);
  assert.match(report.mismatches[0], /service is running/);
  assert.equal(fs.existsSync(`${dbPath}.pre-issue-migration-backup`), false);
});

test("refuses to migrate when server.pid names a different, live process, and never touches that marker", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const other = spawnLiveChild();
  try {
    const serverPidPath = path.join(path.dirname(dbPath), "server.pid");
    fs.writeFileSync(serverPidPath, JSON.stringify({ pid: other.pid, port: 3221, startedAt: NOW }));

    const report = runMigration(dbPath); // no skipServiceCheck — production path
    assert.ok(report.mismatches.length > 0);
    assert.match(report.mismatches[0], /service is running/);
    assert.equal(fs.existsSync(`${dbPath}.pre-issue-migration-backup`), false);

    // The other process's marker must be exactly as it was — not stolen, not modified.
    const stillThere = JSON.parse(fs.readFileSync(serverPidPath, "utf8"));
    assert.equal(stillThere.pid, other.pid);
  } finally {
    other.kill();
  }
});

test("a successful migration claims and releases server.pid — no marker is left behind afterward", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const serverPidPath = path.join(path.dirname(dbPath), "server.pid");

  const report = runMigration(dbPath); // no skipServiceCheck — exercises the real claim/release path
  assert.deepStrictEqual(report.mismatches, []);
  assert.equal(
    fs.existsSync(serverPidPath),
    false,
    "the migration's own claim on server.pid must be released once it finishes, so a server can start normally afterward"
  );
});

test("a rolled-back migration still releases server.pid", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  getDb()
    .prepare(
      `INSERT INTO runs (id, source, external_id, task_category, title, repo, agent_id, status,
        lineage_id, created_at, updated_at)
       VALUES ('run-orphan', 'manual', 'run-orphan', 'code', 'Orphan', '/repo', ?, 'done', 'does-not-exist', ?, ?)`
    )
    .run(BUILTIN_AGENT_CLAUDE_ID, NOW, NOW);
  const serverPidPath = path.join(path.dirname(dbPath), "server.pid");

  const report = runMigration(dbPath); // no skipServiceCheck
  assert.ok(report.mismatches.length > 0);
  assert.equal(fs.existsSync(serverPidPath), false, "a failed migration must still release its own claim");
});

test("injected failure inside the transaction rolls back the database and leaves the backup usable", () => {
  for (const phase of ["after-insert", "after-verify", "after-rename"] as const) {
    freshHome();
    const dbPath = seedLegacyLineages();

    const report = runMigration(dbPath, { skipServiceCheck: true, injectFailureAt: phase });
    assert.ok(report.mismatches.length > 0, `phase ${phase} should report a failure`);
    assert.match(report.mismatches[0], new RegExp(phase));

    const tables = (
      new Database(dbPath, { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    assert.ok(tables.includes("runs"), `phase ${phase}: runs table should survive rollback`);
    assert.equal(tables.includes("legacy_v0_runs"), false, `phase ${phase}: rename should be rolled back`);

    const backupPath = `${dbPath}.pre-issue-migration-backup`;
    assert.ok(fs.existsSync(backupPath), `phase ${phase}: backup should exist`);
    const backupDb = new Database(backupPath, { readonly: true });
    const count = (backupDb.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
    assert.ok(count > 0, `phase ${phase}: backup should be a usable, openable database`);
    backupDb.close();
  }
});

test("injected failure before the backup is made throws and creates no backup", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  assert.throws(() => runMigration(dbPath, { skipServiceCheck: true, injectFailureAt: "before-backup" }));
  assert.equal(fs.existsSync(`${dbPath}.pre-issue-migration-backup`), false);
});

test("injected failure right after the backup throws but leaves a usable backup and untouched runs table", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  assert.throws(() => runMigration(dbPath, { skipServiceCheck: true, injectFailureAt: "after-backup" }));

  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  assert.ok(fs.existsSync(backupPath));
  const backupDb = new Database(backupPath, { readonly: true });
  assert.ok((backupDb.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c > 0);
  backupDb.close();

  const tables = (
    new Database(dbPath, { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);
  assert.ok(tables.includes("runs"));
});

test("documented rollback: restores the pre-migration backup and undoes a completed migration end-to-end", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  const beforeRunCount = (getDb().prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;

  const report = runMigration(dbPath, { skipServiceCheck: true });
  assert.deepStrictEqual(report.mismatches, []);

  const tablesAfterMigration = (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tablesAfterMigration.includes("legacy_v0_runs"));

  // Close the app's own handle to this file before restoring it out from under itself —
  // mirrors the documented procedure's "stop the service first".
  closeDb();
  const result = rollbackMigration(dbPath, { skipServiceCheck: true });
  assert.equal(result.rolledBack, true);

  const restored = new Database(dbPath, { readonly: true });
  const tablesAfterRollback = (
    restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((t) => t.name);
  assert.ok(tablesAfterRollback.includes("runs"));
  assert.equal(tablesAfterRollback.includes("legacy_v0_runs"), false);
  const runCount = (restored.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
  assert.equal(runCount, beforeRunCount);
  restored.close();
});

test("rollback refuses when no backup exists", () => {
  freshHome();
  const dbPath = getDbPath();
  const result = rollbackMigration(dbPath, { skipServiceCheck: true });
  assert.equal(result.rolledBack, false);
  assert.match(result.detail, /no backup found/);
});

test("rollback refuses while the service is running", () => {
  freshHome();
  const dbPath = seedLegacyLineages();
  runMigration(dbPath, { skipServiceCheck: true });
  const runStatePath = path.join(path.dirname(dbPath), "run.json");
  fs.writeFileSync(runStatePath, JSON.stringify({ serverPid: process.pid, port: 2221 }));

  const result = rollbackMigration(dbPath);
  assert.equal(result.rolledBack, false);
  assert.match(result.detail, /service is running/);
});

test("isServiceRunning: no run.json means not running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  assert.equal(isServiceRunning(dbPath).running, false);
});

test("isServiceRunning: run.json with a dead pid means not running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ serverPid: 999999, port: 2221 }));
  assert.equal(isServiceRunning(dbPath).running, false);
});

test("isServiceRunning: run.json with a live pid means running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ serverPid: process.pid, port: 2221 }));
  const result = isServiceRunning(dbPath);
  assert.equal(result.running, true);
  assert.ok(result.detail?.includes(String(process.pid)));
});

test("isServiceRunning: server.pid (written by a directly-launched server, no run.json at all) means running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  // No run.json — this is exactly what `npm run dev` / `npm run start` leave behind,
  // since only the CLI daemon supervisor writes run.json.
  fs.writeFileSync(path.join(dir, "server.pid"), JSON.stringify({ pid: process.pid, port: 3221 }));
  const result = isServiceRunning(dbPath);
  assert.equal(result.running, true);
  assert.ok(result.detail?.includes(String(process.pid)));
});

test("isServiceRunning: a dead server.pid falls through to a live run.json instead of reporting not-running", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-liveness-"));
  const dbPath = path.join(dir, "dealer.db");
  fs.writeFileSync(dbPath, "");
  fs.writeFileSync(path.join(dir, "server.pid"), JSON.stringify({ pid: 999999, port: 3221 }));
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ serverPid: process.pid, port: 2221 }));
  const result = isServiceRunning(dbPath);
  assert.equal(result.running, true);
  assert.ok(result.detail?.includes("run.json"));
});
