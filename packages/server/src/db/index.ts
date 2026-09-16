import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_AGENT_CLAUDE_ID,
  BUILTIN_AGENT_CURSOR_ID,
  BUILTIN_AGENT_CODEX_ID,
  CURSOR_DEFAULT_MODEL,
} from "@agent-dealer/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getDataDir(): string {
  const home = process.env.AGENT_DEALER_HOME ?? path.join(os.homedir(), ".agent-dealer");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function getDbPath(): string {
  return path.join(getDataDir(), "dealer.db");
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(getDbPath());
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
  }
  return dbInstance;
}

/** Tests only — drops the cached connection so a later getDb()/migrate() reopens against
 * whatever AGENT_DEALER_HOME is set to next, instead of silently reusing a stale handle
 * to the previous test's database. */
export function closeDb(): void {
  dbInstance?.close();
  dbInstance = null;
}

export function migrate(): void {
  const db = getDb();

  // NOT-91 added `stale_at` (and an index on it) to `authority_attempts`, but that table
  // itself was introduced earlier (NOT-93). Every other incremental ALTER in this function
  // runs AFTER the schema.sql exec below because schema.sql's CREATE TABLE/INDEX
  // statements are themselves idempotent (IF NOT EXISTS) against an already-current table.
  // This one column can't wait that long: schema.sql's own
  // `CREATE INDEX idx_authority_attempts_stale ON authority_attempts(status, stale_at)`
  // throws "no such column: stale_at" against a pre-NOT-91 `authority_attempts` table
  // before the exec below ever reaches the incremental-ALTER section — aborting migrate()
  // (and every table's schema updates after it) for any database that ran migrate()
  // between NOT-93 and NOT-91 landing. Must run first, and only if the table already
  // exists — a brand-new database gets the column from schema.sql's CREATE TABLE directly.
  const authorityAttemptsExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_attempts'")
    .get();
  if (authorityAttemptsExists) {
    const authorityAttemptCols = db.prepare("PRAGMA table_info(authority_attempts)").all() as Array<{ name: string }>;
    if (!authorityAttemptCols.some((c) => c.name === "stale_at")) {
      db.exec("ALTER TABLE authority_attempts ADD COLUMN stale_at TEXT");
    }
  }

  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN agent_id TEXT REFERENCES agents(id)");
    db.exec("ALTER TABLE runs ADD COLUMN agent_name TEXT");
  }

  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "workspace_root")) {
    db.exec("ALTER TABLE agents ADD COLUMN workspace_root TEXT");
  }

  const runCols2 = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols2.some((c) => c.name === "external_label")) {
    db.exec("ALTER TABLE runs ADD COLUMN external_label TEXT");
  }

  const agentCols2 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols2.some((c) => c.name === "default_plan_model")) {
    db.exec("ALTER TABLE agents ADD COLUMN default_plan_model TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN default_execute_model TEXT");
  }

  const agentCols3 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols3.some((c) => c.name === "default_plan_budget_json")) {
    db.exec("ALTER TABLE agents ADD COLUMN default_plan_budget_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN default_execute_budget_json TEXT");
  }

  const runCols3 = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols3.some((c) => c.name === "plan_model")) {
    db.exec("ALTER TABLE runs ADD COLUMN plan_model TEXT");
    db.exec("ALTER TABLE runs ADD COLUMN execute_model TEXT");
  }

  // NOT-60: role-neutral agent-profile columns + the frozen per-session execution
  // snapshot. Additive ALTERs (SQLite has no ADD COLUMN IF NOT EXISTS), guarded by a
  // PRAGMA check so re-running migrate() is a no-op.
  const agentCols4 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentCols4.some((c) => c.name === "default_model")) {
    db.exec("ALTER TABLE agents ADD COLUMN default_model TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN default_budget_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN purpose TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN playbook_ids_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN external_memory_refs_json TEXT");
    db.exec("ALTER TABLE agents ADD COLUMN permission_policy_json TEXT");
    // Backfill the role-neutral defaults from the legacy phase columns — execute first,
    // then plan (design §`agents`). The old columns stay legacy-readable for one release.
    db.exec(`
      UPDATE agents SET
        default_model = COALESCE(default_execute_model, default_plan_model),
        default_budget_json = COALESCE(default_execute_budget_json, default_plan_budget_json)
      WHERE default_model IS NULL AND default_budget_json IS NULL
    `);
  }

  const workerSessionCols = db.prepare("PRAGMA table_info(worker_sessions)").all() as Array<{
    name: string;
  }>;
  if (!workerSessionCols.some((c) => c.name === "profile_snapshot_json")) {
    db.exec("ALTER TABLE worker_sessions ADD COLUMN profile_snapshot_json TEXT");
  }
  // NOT-124: spawned-CLI liveness evidence. Existing rows stay NULL, which recovery reads
  // as "no evidence" and falls back to the timestamp-only reclaim it has always done.
  //
  // Each column is guarded on its OWN presence, not on the pair. Every `ALTER TABLE` here
  // commits separately, so a process killed between two of them leaves the table half
  // upgraded — and a guard keyed on the first column would then skip the block forever
  // while every worker_sessions INSERT still names the second, failing permanently. Checked
  // independently, the same pass that could have produced that state also repairs it.
  if (!workerSessionCols.some((c) => c.name === "process_pid")) {
    db.exec("ALTER TABLE worker_sessions ADD COLUMN process_pid INTEGER");
  }
  if (!workerSessionCols.some((c) => c.name === "process_owner")) {
    db.exec("ALTER TABLE worker_sessions ADD COLUMN process_owner TEXT");
  }

  // Tighten the workflow-event idempotency index to UNIQUE for DBs created before the
  // constraint (schema.sql's IF NOT EXISTS won't upgrade an existing non-unique index).
  // A pre-fix DB may already hold duplicate keys — the old index was non-unique and
  // appendWorkflowEvent() inserted unconditionally — so dedupe first, then swap the
  // index, all inside one transaction so a failure never leaves the table indexless.
  const wfIdemIdx = db.prepare("PRAGMA index_list(workflow_events)").all() as Array<{
    name: string;
    unique: number;
  }>;
  const nonUnique = wfIdemIdx.find(
    (i) => i.name === "idx_workflow_events_idempotency" && i.unique === 0
  );
  if (nonUnique) {
    db.transaction(() => {
      // Preservation policy: for each repeated provider key keep the first event
      // recorded for it (lowest rowid = earliest insert) and drop the later copies —
      // a duplicate delivery should collapse to its original, matching the runtime
      // ON CONFLICT DO NOTHING behaviour.
      //
      // causation_event_id is a self-FK, so first repoint any reference that points at
      // a discarded duplicate to the canonical (kept) event for that key — otherwise
      // the DELETE below fails with FOREIGN KEY constraint failed and rolls back.
      db.exec(`
        WITH canon AS (
          SELECT idempotency_key, MIN(rowid) AS keep_rowid
          FROM workflow_events
          WHERE idempotency_key IS NOT NULL
          GROUP BY idempotency_key
        ),
        remap AS (
          SELECT e.id AS dup_id, k.id AS canon_id
          FROM workflow_events e
          JOIN canon c ON c.idempotency_key = e.idempotency_key
          JOIN workflow_events k ON k.rowid = c.keep_rowid
          WHERE e.idempotency_key IS NOT NULL AND e.rowid <> c.keep_rowid
        )
        UPDATE workflow_events
        SET causation_event_id = remap.canon_id
        FROM remap
        WHERE workflow_events.causation_event_id = remap.dup_id
      `);
      db.exec(`
        DELETE FROM workflow_events
        WHERE idempotency_key IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM workflow_events
            WHERE idempotency_key IS NOT NULL
            GROUP BY idempotency_key
          )
      `);
      db.exec("DROP INDEX idx_workflow_events_idempotency");
      db.exec(
        "CREATE UNIQUE INDEX idx_workflow_events_idempotency ON workflow_events(idempotency_key) WHERE idempotency_key IS NOT NULL"
      );
    })();
  }

  const artifactCols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  if (!artifactCols.some((c) => c.name === "issue_id")) {
    // Additive per spec §"artifacts": issue_id/worker_session_id are nullable here since
    // existing rows predate the issue model — every row the migration or new coordinator
    // writes going forward populates issue_id.
    db.exec("ALTER TABLE artifacts ADD COLUMN issue_id TEXT REFERENCES issues(id)");
    db.exec("ALTER TABLE artifacts ADD COLUMN worker_session_id TEXT REFERENCES worker_sessions(id)");
  }

  // NOT-57 Task 1 amendment: issue-linked artifacts have no run, so run_id must be
  // nullable — but SQLite can't ALTER a column's NOT NULL away, so rebuild the table for
  // any database created before schema.sql dropped the constraint (fresh databases from
  // the updated schema.sql never hit this branch).
  const artifactRunIdCol = (db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string; notnull: number }>).find(
    (c) => c.name === "run_id"
  );
  if (artifactRunIdCol?.notnull === 1) {
    db.exec(`
      CREATE TABLE artifacts_new (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        content_json TEXT,
        blob_path TEXT,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        issue_id TEXT REFERENCES issues(id),
        worker_session_id TEXT REFERENCES worker_sessions(id)
      );
      INSERT INTO artifacts_new (id, run_id, kind, content_json, blob_path, author, created_at, issue_id, worker_session_id)
        SELECT id, run_id, kind, content_json, blob_path, author, created_at, issue_id, worker_session_id FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_new RENAME TO artifacts;
      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    `);
  }

  // NOT-63: infra-attempt budget, separate from the review-round budget above — a flaky
  // session/git/gh/Agent Deck/publish failure must not spend the same counter as a
  // reviewer's genuine `changes_requested`.
  const issueCols = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  if (!issueCols.some((c) => c.name === "max_infra_attempts")) {
    db.exec("ALTER TABLE issues ADD COLUMN max_infra_attempts INTEGER NOT NULL DEFAULT 3");
    db.exec("ALTER TABLE issues ADD COLUMN infra_attempts INTEGER NOT NULL DEFAULT 0");
  }

  // NOT-102: per-issue auto-merge after reviewer approve (kick UI defaults on; existing
  // rows stay off so in-flight workflows keep the human final_review path).
  const issueColsForAutoMerge = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  if (!issueColsForAutoMerge.some((c) => c.name === "auto_merge")) {
    db.exec("ALTER TABLE issues ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0");
  }

  // NOT-93: Deck's own correlation id for the INTERACTION_REQUIRED response that raised a
  // deck_interaction_required action — lets a repeated signal for the same request dedupe
  // to one open action instead of piling up duplicates.
  const humanActionCols = db.prepare("PRAGMA table_info(human_actions)").all() as Array<{ name: string }>;
  if (!humanActionCols.some((c) => c.name === "request_id")) {
    db.exec("ALTER TABLE human_actions ADD COLUMN request_id TEXT");
  }

  // NOT-95: a Run-scoped action (outbound-draft delivery parking) has no Issue, so issue_id
  // must become nullable — SQLite can't ALTER a column's NOT NULL away, so rebuild the table
  // for any database created before schema.sql dropped the constraint (fresh databases from
  // the updated schema.sql never hit this branch). Same recipe as the artifacts_new rebuild
  // above.
  const humanActionIssueIdCol = (
    db.prepare("PRAGMA table_info(human_actions)").all() as Array<{ name: string; notnull: number }>
  ).find((c) => c.name === "issue_id");
  if (humanActionIssueIdCol?.notnull === 1) {
    db.exec(`
      CREATE TABLE human_actions_new (
        id TEXT PRIMARY KEY,
        issue_id TEXT REFERENCES issues(id),
        run_id TEXT REFERENCES runs(id),
        workflow_instance_id TEXT REFERENCES workflow_instances(id),
        action_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        question TEXT NOT NULL,
        evidence_json TEXT,
        response_options_json TEXT,
        continuation_preview_json TEXT,
        request_id TEXT,
        status TEXT NOT NULL,
        resolution_json TEXT,
        resolved_by TEXT,
        requested_at TEXT NOT NULL,
        resolved_at TEXT
      );
      INSERT INTO human_actions_new (
        id, issue_id, workflow_instance_id, action_type, reason, question, evidence_json,
        response_options_json, continuation_preview_json, request_id, status, resolution_json,
        resolved_by, requested_at, resolved_at
      )
        SELECT
          id, issue_id, workflow_instance_id, action_type, reason, question, evidence_json,
          response_options_json, continuation_preview_json, request_id, status, resolution_json,
          resolved_by, requested_at, resolved_at
        FROM human_actions;
      DROP TABLE human_actions;
      ALTER TABLE human_actions_new RENAME TO human_actions;
      CREATE INDEX IF NOT EXISTS idx_human_actions_issue ON human_actions(issue_id);
      CREATE INDEX IF NOT EXISTS idx_human_actions_status ON human_actions(status);
    `);
  } else if (!humanActionCols.some((c) => c.name === "run_id")) {
    // Rebuild already happened in a prior migrate() run (or this is a fresh schema.sql
    // database missing only this additive column for some other reason) — plain add.
    db.exec("ALTER TABLE human_actions ADD COLUMN run_id TEXT REFERENCES runs(id)");
  }
  // Always last, once run_id is guaranteed to exist (fresh schema.sql create, the rebuild
  // above, or the plain ALTER above) — see schema.sql's comment on why this index isn't
  // declared there.
  db.exec("CREATE INDEX IF NOT EXISTS idx_human_actions_run ON human_actions(run_id)");

  // NOT-91: findOpenHumanActionByRequestId's dedupe was a plain read-then-create check —
  // two concurrent duplicate INTERACTION_REQUIRED deliveries could both see "no open
  // action" and both insert. Tighten to a real constraint enforced via createHumanAction's
  // `ON CONFLICT ... DO NOTHING` (repository/human-actions.ts). Must run AFTER the NOT-95
  // rebuild above: that rebuild drops and recreates `human_actions` (to make issue_id
  // nullable) without carrying over any index created before it, so creating this index
  // earlier in the same migrate() call — as a prior version of this migration did — got it
  // silently dropped by the very next block, and only a second restart (skipping the rebuild
  // block on its now-nullable issue_id) actually created it (review-caught bug). Re-querying
  // PRAGMA index_list here, after the rebuild, is what makes this idempotent no matter which
  // branch above ran. A pre-fix database may already hold a duplicate open pair from exactly
  // that race — dedupe first (keep the earliest per (issue_id, action_type, request_id),
  // auto-resolve any later duplicate), then create the index, all in one transaction so a
  // failure never leaves the table indexless.
  const humanActionIdx = db.prepare("PRAGMA index_list(human_actions)").all() as Array<{ name: string }>;
  if (!humanActionIdx.some((i) => i.name === "idx_human_actions_open_request")) {
    db.transaction(() => {
      db.exec(`
        UPDATE human_actions SET
          status = 'resolved',
          resolution_json = '{"choice":"resolved_via_dedupe_migration"}',
          resolved_by = 'system',
          resolved_at = datetime('now')
        WHERE status = 'open' AND request_id IS NOT NULL AND rowid NOT IN (
          SELECT MIN(rowid) FROM human_actions
          WHERE status = 'open' AND request_id IS NOT NULL
          GROUP BY issue_id, action_type, request_id
        )
      `);
      db.exec(`
        CREATE UNIQUE INDEX idx_human_actions_open_request ON human_actions(issue_id, action_type, request_id)
        WHERE status = 'open' AND request_id IS NOT NULL
      `);
    })();
  }

  // NOT-111: runtime usage-cap availability (one row per runtime account).
  const runtimeAvail = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_availability'")
    .get() as { name: string } | undefined;
  if (!runtimeAvail) {
    db.exec(`
      CREATE TABLE runtime_availability (
        runtime TEXT PRIMARY KEY,
        unavailable_until TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT,
        observed_at TEXT NOT NULL
      );
    `);
  }

  // NOT-103: sequential issue admission queue.
  const queueEntries = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queue_entries'")
    .get() as { name: string } | undefined;
  if (!queueEntries) {
    db.exec(`
      CREATE TABLE queue_entries (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        enqueued_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'admitted', 'removed')),
        wait_reason TEXT,
        wait_reason_at TEXT
      );
      CREATE UNIQUE INDEX idx_queue_entries_queued_issue
        ON queue_entries(issue_id) WHERE state = 'queued';
      CREATE INDEX idx_queue_entries_queued_position
        ON queue_entries(position) WHERE state = 'queued';
    `);
  }

  seedBuiltinAgents(db);
  seedIntakeSettings(db);
  migrateLegacyAgentDeckPort(db);
  migrateLinearInboxUnlock(db);

  // Default agents are normal rows — clear legacy built-in flag.
  db.exec("UPDATE agents SET is_builtin = 0 WHERE is_builtin = 1");
}

/** One-shot: unlock assigneeMe / stateFilter only when they still hold pre-unlock defaults.
 * Deliberate Settings customizations and env-seeded filters (e.g. Todo+Backlog) are left alone. */
function migrateLinearInboxUnlock(db: Database.Database): void {
  const flag = db
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get("linear.inboxUnlockV1") as { value_json: string } | undefined;
  if (flag) return;

  const openStates = ["Backlog", "Todo", "In Progress", "In Review"];
  const upsert = db.prepare(
    "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  );

  const assigneeRow = db
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get("linear.assigneeMe") as { value_json: string } | undefined;
  let assigneeMe = true; // pre-unlock default when missing
  if (assigneeRow) {
    try {
      assigneeMe = JSON.parse(assigneeRow.value_json) as boolean;
    } catch {
      assigneeMe = true;
    }
  }
  if (assigneeMe === true) {
    upsert.run("linear.assigneeMe", JSON.stringify(false));
  }

  const stateRow = db
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get("linear.stateFilter") as { value_json: string } | undefined;
  let stateFilter: unknown = ["Todo"]; // pre-unlock code default when missing
  if (stateRow) {
    try {
      stateFilter = JSON.parse(stateRow.value_json);
    } catch {
      stateFilter = ["Todo"];
    }
  }
  if (isLegacyLinearStateFilterDefault(stateFilter)) {
    upsert.run("linear.stateFilter", JSON.stringify(openStates));
  }

  upsert.run("linear.inboxUnlockV1", JSON.stringify(true));
}

/** Pre-unlock persisted default was exactly `["Todo"]` (see prior getPersistedLinearIntakeConfig). */
export function isLegacyLinearStateFilterDefault(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === "Todo";
}

function migrateLegacyAgentDeckPort(db: Database.Database): void {
  const row = db
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get("agentDeck.port") as { value_json: string } | undefined;
  if (!row) return;
  try {
    const port = JSON.parse(row.value_json) as number;
    if (port === 11111) {
      db.prepare("UPDATE intake_settings SET value_json = ? WHERE key = ?").run("1111", "agentDeck.port");
    }
  } catch {
    /* ignore */
  }
}

function seedIntakeSettings(db: Database.Database): void {
  const openDefault = ["Backlog", "Todo", "In Progress", "In Review"];
  const stateFilter = (process.env.LINEAR_STATE_FILTER ?? openDefault.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const teamId = process.env.LINEAR_TEAM_ID ?? null;

  const defaults: Record<string, unknown> = {
    "linear.stateFilter": stateFilter.length > 0 ? stateFilter : openDefault,
    "linear.teamId": teamId,
    "linear.assigneeMe": false,
    "linear.defaultAgentId": null,
    "linear.syncEnabled": true,
    "linear.routingRules": [],
    "agentDeck.host": "127.0.0.1",
    "agentDeck.port": 1111,
  };

  const deckFromEnv = process.env.AGENT_DECK_API_URL;
  if (deckFromEnv) {
    try {
      const u = new URL(deckFromEnv);
      defaults["agentDeck.host"] = u.hostname;
      defaults["agentDeck.port"] = u.port ? Number(u.port) : 1111;
    } catch {
      /* keep defaults */
    }
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO intake_settings (key, value_json) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, JSON.stringify(value));
  }
}

function seedBuiltinAgents(db: Database.Database): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, runtime, deck_id, deck_name, playbook_id, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?, ?)
  `);
  insert.run(BUILTIN_AGENT_CLAUDE_ID, "Claude", "claude_code", now, now);
  insert.run(BUILTIN_AGENT_CURSOR_ID, "Cursor", "cursor_local", now, now);
  insert.run(BUILTIN_AGENT_CODEX_ID, "Codex", "codex_local", now, now);

  db.prepare(
    `UPDATE agents SET
      default_plan_model = COALESCE(default_plan_model, ?),
      default_execute_model = COALESCE(default_execute_model, ?),
      updated_at = ?
     WHERE id = ? AND runtime = 'cursor_local'`
  ).run(CURSOR_DEFAULT_MODEL, CURSOR_DEFAULT_MODEL, now, BUILTIN_AGENT_CURSOR_ID);
}
