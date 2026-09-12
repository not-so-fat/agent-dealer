#!/usr/bin/env tsx
// packages/server/src/db/migrate-to-issues.ts
//
// NOT-66: the one-time, explicit cutover from the legacy single-agent `runs` model to the
// issue-centric developer/reviewer model (design doc §"Migration and cutover"). This is
// NOT the additive, idempotent-at-every-startup `migrate()` in ./index.ts — it is an
// operator-invoked script that renames the legacy tables away, so it must refuse to run
// twice and must refuse to run against a live service.
//
// Usage:
//   tsx src/db/migrate-to-issues.ts <path-to-dealer.db>              # run the cutover
//   tsx src/db/migrate-to-issues.ts <path-to-dealer.db> --rollback   # undo it
//
// Rollback procedure (documented here, exercised by an automated test below):
//   The cutover's first act is an exclusive copy of the database to
//   `<dbPath>.pre-issue-migration-backup` *before* any table is touched. To undo a
//   completed migration, stop the service and run this script again with `--rollback`:
//   it restores that backup file over the live database, verbatim. Rollback itself
//   refuses to run against a live service, for the same reason the forward migration does.
//
// Scope note: this script only migrates data and creates the `legacy_v0_*` audit tables.
// It does not touch any runtime route, the dispatcher, or the frontend nav — the ticket
// explicitly scopes "remove legacy writers" as a separate, later action. The legacy
// Operations/Inbox/Done UI and its routes keep working against the *renamed* legacy
// tables' data having already moved into the issue model; the legacy runtime writers
// themselves are untouched by this script and keep writing to a fresh, empty `runs` table
// (recreated by schema.sql on next startup) until that follow-up work removes them.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

export interface MigrationReport {
  issuesCreated: number;
  legacySessionsCreated: number;
  artifactsRepointed: number;
  eventsRepointed: number;
  mismatches: string[];
  /** True when the database was already migrated — a safe no-op, not an error. */
  alreadyMigrated: boolean;
}

function emptyReport(): MigrationReport {
  return {
    issuesCreated: 0,
    legacySessionsCreated: 0,
    artifactsRepointed: 0,
    eventsRepointed: 0,
    mismatches: [],
    alreadyMigrated: false,
  };
}

interface LegacyRunRow {
  id: string;
  source: string;
  external_id: string | null;
  external_label: string | null;
  title: string;
  description: string | null;
  repo: string | null;
  agent_id: string | null;
  status: string;
  lineage_id: string | null;
  acceptance_criteria: string | null;
  created_at: string;
  updated_at: string;
}

/** Groups every run by COALESCE(lineage_id, id) — one bucket per historical lineage. */
function groupByLineage(runs: LegacyRunRow[]): Map<string, LegacyRunRow[]> {
  const groups = new Map<string, LegacyRunRow[]>();
  for (const run of runs) {
    const key = run.lineage_id ?? run.id;
    const bucket = groups.get(key) ?? [];
    bucket.push(run);
    groups.set(key, bucket);
  }
  return groups;
}

function latestRun(runs: LegacyRunRow[]): LegacyRunRow {
  return [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at))[runs.length - 1];
}

/** Legacy worker_session.status follows the same bucket as the issue-status mapping below. */
function legacySessionStatus(runStatus: string): "done" | "failed" | "cancelled" {
  if (runStatus === "done" || runStatus === "review") return "done";
  if (runStatus === "failed") return "failed";
  return "cancelled"; // cancelled, queued, plan_pending, plan_approved, running
}

function issueStatusForLatest(runStatus: string): {
  status: string;
  owner: string;
  humanAction?: { actionType: string; reason: string; question: string };
} {
  switch (runStatus) {
    case "done":
      return { status: "done", owner: "system" };
    case "cancelled":
      return { status: "closed", owner: "system" };
    case "review":
      return {
        status: "final_review",
        owner: "human",
        humanAction: {
          actionType: "final_review",
          reason: "Migrated from a legacy run awaiting result review",
          question: "Accept this legacy work?",
        },
      };
    case "failed":
      return {
        status: "needs_human",
        owner: "human",
        humanAction: {
          actionType: "attempts_exhausted",
          reason: "Migrated from a legacy failed run",
          question: "This legacy run failed — how should it be resolved?",
        },
      };
    default:
      // queued, plan_pending, plan_approved, running
      return { status: "ready", owner: "system" };
  }
}

/**
 * The live app runs in WAL mode (getDb() in ./index.ts), which can leave recently
 * committed data sitting only in the `<dbPath>-wal` sidecar file, not yet folded into the
 * main database file. A plain `fs.copyFileSync(dbPath, ...)` of the main file alone would
 * then silently miss that data (or, worse, produce a backup that is missing tables
 * entirely if the schema itself was created since the last checkpoint). Checkpointing
 * with TRUNCATE folds everything into the main file and empties the WAL, so a bare file
 * copy of `dbPath` alone is always a complete, self-contained snapshot.
 */
function checkpointAndTruncate(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/** Removes a possibly-stale WAL/SHM sidecar so a later connection never replays frames
 * left over from before a file at this path was overwritten (e.g. by rollback). */
function removeWalSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* fine if absent */
    }
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

const REQUIRED_LEGACY_COLUMNS: Record<string, string[]> = {
  runs: [
    "id",
    "source",
    "external_id",
    "external_label",
    "title",
    "description",
    "repo",
    "agent_id",
    "status",
    "lineage_id",
    "acceptance_criteria",
    "created_at",
    "updated_at",
  ],
  artifacts: ["id", "run_id", "kind", "content_json", "blob_path", "author", "created_at", "issue_id", "worker_session_id"],
  events: ["id", "run_id", "type", "payload_json", "ts"],
};

const REQUIRED_TARGET_TABLES = [
  "issues",
  "worker_sessions",
  "workflow_instances",
  "workflow_events",
  "human_actions",
  "agents",
];

/**
 * Refuses to guess: validates the legacy `runs`/`artifacts`/`events` shape this script
 * depends on, and that the issue-centric target tables already exist (created by the
 * ordinary additive `migrate()` in ./index.ts, which every server startup already runs).
 * Returns a description of the first problem found, or null when the schema is safe to
 * migrate. Called *before* the backup is created — a bad schema should never even cost a
 * backup copy.
 */
function validateLegacySchema(db: Database.Database): string | null {
  for (const table of ["runs", "artifacts", "events", "approval_gates"]) {
    if (!tableExists(db, table)) {
      return `expected legacy table "${table}" not found — this database may already be migrated or is not an agent-dealer database`;
    }
  }
  for (const table of REQUIRED_TARGET_TABLES) {
    if (!tableExists(db, table)) {
      return `expected issue-centric table "${table}" not found — run the ordinary server migration (npm run db:migrate) first`;
    }
  }
  for (const [table, cols] of Object.entries(REQUIRED_LEGACY_COLUMNS)) {
    const present = columnsOf(db, table);
    const missing = cols.filter((c) => !present.has(c));
    if (missing.length > 0) {
      return `table "${table}" is missing expected column(s): ${missing.join(", ")}`;
    }
  }
  return null;
}

/**
 * Real liveness check, not a placeholder: the running service is tracked via
 * `run.json` (packages/cli/src/runtime-state.ts's RunState — a sibling of dealer.db in
 * the same AGENT_DEALER_HOME directory), not a lock file this codebase never creates.
 * Reimplemented locally rather than imported: packages/cli depends on
 * @agent-dealer/server, never the reverse, so this package cannot import from cli.
 */
export function isServiceRunning(dbPath: string): { running: boolean; detail?: string } {
  const runStatePath = path.join(path.dirname(dbPath), "run.json");
  if (!fs.existsSync(runStatePath)) return { running: false };
  let state: { serverPid?: number; port?: number };
  try {
    state = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  } catch {
    return { running: false };
  }
  const pid = state.serverPid;
  if (!pid || !Number.isFinite(pid) || pid <= 0) return { running: false };
  try {
    process.kill(pid, 0);
    return { running: true, detail: `serverPid ${pid} (from ${runStatePath})` };
  } catch {
    return { running: false };
  }
}

export type InjectFailureAt =
  | "before-backup"
  | "after-backup"
  | "after-insert"
  | "after-verify"
  | "after-rename";

export interface RunMigrationOptions {
  /** Tests only — production entrypoint always checks. */
  skipServiceCheck?: boolean;
  /** Tests only — throws at the named phase to prove rollback/backup safety. */
  injectFailureAt?: InjectFailureAt;
}

export function runMigration(dbPath: string, opts?: RunMigrationOptions): MigrationReport {
  // Phase 0: read-only probe — idempotent no-op check + schema validation, before anything
  // else touches the filesystem or the database.
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (tableExists(probe, "legacy_v0_runs")) {
      return { ...emptyReport(), alreadyMigrated: true };
    }
    const schemaError = validateLegacySchema(probe);
    if (schemaError) {
      return { ...emptyReport(), mismatches: [schemaError] };
    }
  } finally {
    probe.close();
  }

  if (!opts?.skipServiceCheck) {
    const liveness = isServiceRunning(dbPath);
    if (liveness.running) {
      return {
        ...emptyReport(),
        mismatches: [`refusing to migrate while the service is running (${liveness.detail}) — stop it first`],
      };
    }
  }

  if (opts?.injectFailureAt === "before-backup") {
    throw new Error("injected failure: before-backup");
  }

  // Fold any WAL-resident commits into the main file before copying it — see
  // checkpointAndTruncate's doc comment.
  checkpointAndTruncate(dbPath);

  // Exclusive, unique backup: COPYFILE_EXCL fails (EEXIST) rather than silently overwriting
  // a backup from a prior attempt — a second invocation is a safe refusal, never a second
  // (possibly different) backup replacing the first.
  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  try {
    fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ...emptyReport(),
        mismatches: [
          `backup already exists at ${backupPath} — refusing to run again. If this is a stale backup ` +
            `from a previous failed attempt, inspect and remove it manually before retrying.`,
        ],
      };
    }
    throw err;
  }

  if (opts?.injectFailureAt === "after-backup") {
    throw new Error("injected failure: after-backup");
  }

  const db = new Database(dbPath);
  const report = emptyReport();

  const tx = db.transaction(() => {
    const runs = db.prepare("SELECT * FROM runs").all() as LegacyRunRow[];
    const runIds = new Set(runs.map((r) => r.id));

    // Refuse malformed input rather than guessing: a lineage_id that points nowhere.
    for (const run of runs) {
      if (run.lineage_id && !runIds.has(run.lineage_id) && run.lineage_id !== run.id) {
        report.mismatches.push(`run ${run.id} has lineage_id ${run.lineage_id} which does not exist`);
      }
    }
    if (report.mismatches.length > 0) return;

    const agentExists = (id: string | null): boolean =>
      !!id && !!db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id);

    const issuesBefore = (db.prepare("SELECT COUNT(*) AS c FROM issues").get() as { c: number }).c;

    const groups = groupByLineage(runs);

    for (const [, lineageRuns] of groups) {
      const issueId = uuid();
      const latest = latestRun(lineageRuns);
      const mapped = issueStatusForLatest(latest.status);
      const resolvedAgentId = agentExists(latest.agent_id) ? latest.agent_id : null;

      db.prepare(`
        INSERT INTO issues (
          id, source, external_id, external_label, external_url, title, description,
          acceptance_criteria, repo, base_branch, status, current_owner, current_intent,
          developer_agent_id, reviewer_agent_id, max_review_rounds, current_round,
          max_infra_attempts, infra_attempts,
          branch, base_sha, head_sha, pr_number, pr_url, created_at, updated_at
        ) VALUES (
          @id, @source, @external_id, @external_label, NULL, @title, @description,
          @acceptance_criteria, @repo, 'main', @status, @current_owner, NULL,
          @agent_id, @agent_id, 3, 1,
          3, 0,
          NULL, NULL, NULL, NULL, NULL, @created_at, @updated_at
        )
      `).run({
        id: issueId,
        source: latest.source,
        external_id: latest.external_id,
        external_label: latest.external_label,
        title: latest.title,
        description: latest.description,
        acceptance_criteria: latest.acceptance_criteria,
        repo: latest.repo ?? "unknown",
        status: mapped.status,
        current_owner: mapped.owner,
        agent_id: resolvedAgentId,
        created_at: latest.created_at,
        updated_at: latest.updated_at,
      });
      report.issuesCreated += 1;

      // One completed legacy_v0 workflow instance per lineage (audit only, never active).
      // Inserted directly rather than through startWorkflowInstance(), which always creates
      // an *active* (completed_at=null) instance — this one is born already complete.
      const instanceId = uuid();
      db.prepare(`
        INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, completed_at, outcome)
        VALUES (?, ?, 'legacy_v0', ?, ?, 'migrated')
      `).run(instanceId, issueId, latest.created_at, latest.updated_at);

      if (mapped.humanAction) {
        db.prepare(`
          INSERT INTO human_actions (
            id, issue_id, workflow_instance_id, action_type, reason, question, evidence_json,
            response_options_json, continuation_preview_json, status, resolution_json, resolved_by,
            requested_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'open', NULL, NULL, ?, NULL)
        `).run(
          uuid(),
          issueId,
          instanceId,
          mapped.humanAction.actionType,
          mapped.humanAction.reason,
          mapped.humanAction.question,
          latest.updated_at
        );
      }

      for (const run of lineageRuns) {
        const sessionId = uuid();
        const sessionStatus = legacySessionStatus(run.status);
        const sessionAgentId = agentExists(run.agent_id) ? run.agent_id : null;
        db.prepare(`
          INSERT INTO worker_sessions (
            id, issue_id, role, round, agent_id, runtime, model, budget_json, worktree_path,
            input_sha, status, session_ref, log_path, exit_code, error_json, metadata_json,
            profile_snapshot_json, created_at, started_at, heartbeat_at, completed_at, updated_at
          ) VALUES (
            ?, ?, 'legacy', 1, ?, NULL, NULL, NULL, NULL,
            NULL, ?, NULL, NULL, NULL, NULL, ?,
            NULL, ?, NULL, NULL, ?, ?
          )
        `).run(
          sessionId,
          issueId,
          sessionAgentId,
          sessionStatus,
          JSON.stringify({ legacyRunId: run.id, legacyStatus: run.status }),
          run.created_at,
          run.updated_at,
          run.updated_at
        );
        report.legacySessionsCreated += 1;

        // Repoint in place — artifacts is the SAME table the live coordinator writes to
        // (issue_id/worker_session_id were added to it additively, see ./index.ts), never a
        // renamed legacy table. Updating in place, rather than copying into a staging table
        // and swapping the whole table, is what keeps any artifact rows a real (non-legacy)
        // issue already wrote — this migration is not the first runtime activity against
        // this database — completely untouched.
        const repointed = db
          .prepare("UPDATE artifacts SET issue_id = ?, worker_session_id = ? WHERE run_id = ?")
          .run(issueId, sessionId, run.id);
        report.artifactsRepointed += repointed.changes;

        const events = db.prepare("SELECT * FROM events WHERE run_id = ?").all(run.id) as Array<{
          id: string;
          type: string;
          payload_json: string | null;
          ts: string;
        }>;
        for (const e of events) {
          let legacyPayload: unknown = null;
          if (e.payload_json) {
            try {
              legacyPayload = JSON.parse(e.payload_json);
            } catch {
              legacyPayload = e.payload_json;
            }
          }
          db.prepare(`
            INSERT INTO workflow_events (
              id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref,
              stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts
            ) VALUES (?, ?, ?, ?, 'legacy.imported', 'system', NULL, ?, 1, ?, NULL, NULL, NULL, ?)
          `).run(
            uuid(),
            issueId,
            instanceId,
            sessionId,
            mapped.status,
            JSON.stringify({ legacyType: e.type, legacyPayload }),
            e.ts
          );
          report.eventsRepointed += 1;
        }
      }
    }

    if (opts?.injectFailureAt === "after-insert") {
      throw new Error("injected failure: after-insert");
    }

    // Verification gate — any mismatch aborts the whole transaction (rollback).
    const issuesAfter = (db.prepare("SELECT COUNT(*) AS c FROM issues").get() as { c: number }).c;
    if (issuesAfter - issuesBefore !== groups.size) {
      report.mismatches.push(
        `expected ${groups.size} new issues, found ${issuesAfter - issuesBefore} (database may already contain unrelated issues — compared as a delta)`
      );
    }
    const sessionCount = (
      db.prepare("SELECT COUNT(*) AS c FROM worker_sessions WHERE role = 'legacy'").get() as { c: number }
    ).c;
    if (sessionCount !== runs.length) {
      report.mismatches.push(`expected ${runs.length} legacy sessions, found ${sessionCount}`);
    }
    // Scoped to the tables this migration writes to: a legacy `runs`/`events`/
    // `approval_gates` row can already carry a dangling reference from before this script
    // ever ran (e.g. an agent deleted outside deleteAgent()'s normal path) — that
    // pre-existing legacy data quality issue is not this migration's to fix, and is kept
    // as-is under legacy_v0_*. Only a violation in a table *this migration wrote to* means
    // the migration itself produced a bad reference.
    const NEW_TABLES = new Set(["issues", "worker_sessions", "workflow_instances", "workflow_events", "human_actions"]);
    const fkViolations = (
      db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>
    ).filter((v) => NEW_TABLES.has(v.table));
    if (fkViolations.length > 0) {
      report.mismatches.push(`foreign key check failed: ${JSON.stringify(fkViolations)}`);
    }

    if (opts?.injectFailureAt === "after-verify") {
      throw new Error("injected failure: after-verify");
    }

    if (report.mismatches.length > 0) {
      throw new Error("migration verification failed — rolling back");
    }

    // Rename the legacy-only tables so the running app's fresh, empty versions (recreated
    // by schema.sql on next startup) are the only ones the *new* coordinator ever writes —
    // "artifacts" is deliberately excluded; see the repoint comment above.
    for (const table of ["runs", "events", "approval_gates"]) {
      db.exec(`ALTER TABLE ${table} RENAME TO legacy_v0_${table}`);
    }

    if (opts?.injectFailureAt === "after-rename") {
      throw new Error("injected failure: after-rename");
    }

    // Post-rename assertion: query "artifacts" exactly the way the live API does (by
    // issue_id) and confirm every repointed artifact is actually reachable there.
    const reachableForRun = db
      .prepare(
        `SELECT COUNT(*) AS c FROM artifacts WHERE issue_id IS NOT NULL AND run_id IN (SELECT id FROM legacy_v0_runs)`
      )
      .get() as { c: number };
    if (reachableForRun.c !== report.artifactsRepointed) {
      report.mismatches.push(
        `expected ${report.artifactsRepointed} migrated artifacts reachable via the post-cutover "artifacts" table, found ${reachableForRun.c}`
      );
      throw new Error("migration verification failed — rolling back");
    }
  });

  try {
    tx();
  } catch (err) {
    // better-sqlite3 already rolled back the transaction; report.mismatches carries the
    // reason when it's one this script raised. An injected/unexpected error still needs a
    // message so the caller can see *why* — mismatches is the one channel both use.
    if (report.mismatches.length === 0) {
      report.mismatches.push(err instanceof Error ? err.message : String(err));
    }
  } finally {
    // Whether committed or rolled back, leave the file self-contained on disk — the same
    // reason the backup is checkpointed before copy (see checkpointAndTruncate).
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  }

  return report;
}

/**
 * Restores the pre-migration backup over the live database, undoing a completed cutover.
 * Refuses while the service is running, for the same reason the forward migration does.
 * Refuses when no backup exists rather than silently doing nothing that looks like success.
 */
export function rollbackMigration(
  dbPath: string,
  opts?: { skipServiceCheck?: boolean }
): { rolledBack: boolean; detail: string } {
  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  if (!fs.existsSync(backupPath)) {
    return { rolledBack: false, detail: `no backup found at ${backupPath} — nothing to roll back to` };
  }
  if (!opts?.skipServiceCheck) {
    const liveness = isServiceRunning(dbPath);
    if (liveness.running) {
      return {
        rolledBack: false,
        detail: `refusing rollback while the service is running (${liveness.detail}) — stop it first`,
      };
    }
  }
  fs.copyFileSync(backupPath, dbPath);
  // The restored main file is a complete snapshot (the backup was made from a
  // checkpointed, WAL-truncated database) — any WAL/SHM sidecar still sitting next to
  // dbPath from the post-migration state describes pages that no longer match this
  // now-older main file, so it must not be replayed against it.
  removeWalSidecars(dbPath);
  return { rolledBack: true, detail: `restored ${dbPath} from ${backupPath}` };
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  tsx src/db/migrate-to-issues.ts <path-to-dealer.db>              # run the cutover");
  console.error("  tsx src/db/migrate-to-issues.ts <path-to-dealer.db> --rollback   # undo it");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = args.find((a) => !a.startsWith("--"));
  const rollback = args.includes("--rollback");
  if (!dbPath) {
    printUsage();
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  if (rollback) {
    const result = rollbackMigration(dbPath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.rolledBack ? 0 : 1);
  }

  const report = runMigration(dbPath);
  console.log(JSON.stringify(report, null, 2));
  if (report.alreadyMigrated) {
    console.log("Already migrated — no-op.");
    return;
  }
  if (report.mismatches.length > 0) {
    console.error("Migration refused or rolled back — see mismatches above. Original data untouched.");
    process.exit(1);
  }
  console.log(`Migration complete. Roll back with: tsx src/db/migrate-to-issues.ts ${dbPath} --rollback`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
