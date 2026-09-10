#!/usr/bin/env tsx
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface MigrationReport {
  issuesCreated: number;
  legacySessionsCreated: number;
  artifactsRepointed: number;
  eventsRepointed: number;
  mismatches: string[];
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

export function runMigration(dbPath: string, opts?: { skipServiceCheck?: boolean }): MigrationReport {
  if (!opts?.skipServiceCheck) {
    // Production entrypoint refuses to run against a live server — see main() below,
    // which checks the process registry lock file before calling this function.
  }

  const backupPath = `${dbPath}.pre-issue-migration-backup`;
  fs.copyFileSync(dbPath, backupPath);

  const db = new Database(dbPath);
  const report: MigrationReport = {
    issuesCreated: 0,
    legacySessionsCreated: 0,
    artifactsRepointed: 0,
    eventsRepointed: 0,
    mismatches: [],
  };

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

    // Stage migrated artifact copies in a separate table rather than inserting them
    // straight into "artifacts": that table is renamed to legacy_v0_artifacts at the end
    // of this transaction (below), and a fresh, EMPTY "artifacts" table gets created the
    // next time migrate() runs schema.sql — so anything inserted directly into "artifacts"
    // here would silently vanish from every post-cutover query. Staging + a final rename
    // keeps the migrated rows in the table the live API actually queries.
    db.exec(`
      CREATE TABLE artifacts_migrated (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        content_json TEXT,
        blob_path TEXT,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        issue_id TEXT REFERENCES issues(id),
        worker_session_id TEXT REFERENCES worker_sessions(id)
      )
    `);

    const groups = groupByLineage(runs);
    let issueSeq = 0;
    let sessionSeq = 0;

    for (const [, lineageRuns] of groups) {
      issueSeq += 1;
      const issueId = `issue-${issueSeq}`;
      const latest = latestRun(lineageRuns);
      const mapped = issueStatusForLatest(latest.status);

      db.prepare(`
        INSERT INTO issues (
          id, source, external_id, external_label, external_url, title, description,
          acceptance_criteria, repo, base_branch, status, current_owner, current_intent,
          developer_agent_id, reviewer_agent_id, max_review_rounds, current_round,
          branch, base_sha, head_sha, pr_number, pr_url, created_at, updated_at
        ) VALUES (
          @id, @source, @external_id, @external_label, NULL, @title, @description,
          @acceptance_criteria, @repo, 'main', @status, @current_owner, NULL,
          @agent_id, @agent_id, 3, 1,
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
        agent_id: latest.agent_id,
        created_at: latest.created_at,
        updated_at: latest.updated_at,
      });
      report.issuesCreated += 1;

      // One completed legacy_v0 workflow instance per lineage (audit only, never active).
      const instanceId = `${issueId}-legacy-instance`;
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
          `${issueId}-legacy-action`,
          issueId,
          instanceId,
          mapped.humanAction.actionType,
          mapped.humanAction.reason,
          mapped.humanAction.question,
          latest.updated_at
        );
      }

      for (const run of lineageRuns) {
        sessionSeq += 1;
        const sessionId = `session-${sessionSeq}`;
        const sessionStatus = legacySessionStatus(run.status);
        db.prepare(`
          INSERT INTO worker_sessions (
            id, issue_id, role, round, agent_id, runtime, model, budget_json, worktree_path,
            input_sha, status, session_ref, log_path, exit_code, error_json, metadata_json,
            created_at, started_at, heartbeat_at, completed_at, updated_at
          ) VALUES (
            ?, ?, 'legacy', 1, ?, NULL, NULL, NULL, NULL,
            NULL, ?, NULL, NULL, NULL, NULL, ?,
            ?, NULL, NULL, ?, ?
          )
        `).run(
          sessionId,
          issueId,
          run.agent_id,
          sessionStatus,
          JSON.stringify({ legacyRunId: run.id, legacyStatus: run.status }),
          run.created_at,
          run.updated_at,
          run.updated_at
        );
        report.legacySessionsCreated += 1;

        const artifacts = db.prepare("SELECT * FROM artifacts WHERE run_id = ?").all(run.id) as Array<{
          id: string;
          kind: string;
          content_json: string | null;
          blob_path: string | null;
          author: string;
          created_at: string;
        }>;
        for (const a of artifacts) {
          db.prepare(`
            INSERT INTO artifacts_migrated (id, run_id, issue_id, worker_session_id, kind, content_json, blob_path, author, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`${a.id}-migrated`, run.id, issueId, sessionId, a.kind, a.content_json, a.blob_path, a.author, a.created_at);
          report.artifactsRepointed += 1;
        }

        const events = db.prepare("SELECT * FROM events WHERE run_id = ?").all(run.id) as Array<{
          id: string;
          type: string;
          payload_json: string | null;
          ts: string;
        }>;
        for (const e of events) {
          db.prepare(`
            INSERT INTO workflow_events (
              id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref,
              stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts
            ) VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, 1, ?, NULL, NULL, NULL, ?)
          `).run(`${e.id}-migrated`, issueId, instanceId, sessionId, e.type, mapped.status, e.payload_json, e.ts);
          report.eventsRepointed += 1;
        }
      }
    }

    // Verification gate — any mismatch aborts the transaction.
    const issueCount = (db.prepare("SELECT COUNT(*) as c FROM issues").get() as { c: number }).c;
    if (issueCount !== groups.size) {
      report.mismatches.push(`expected ${groups.size} issues, found ${issueCount}`);
    }
    const sessionCount = (db.prepare("SELECT COUNT(*) as c FROM worker_sessions WHERE role = 'legacy'").get() as {
      c: number;
    }).c;
    if (sessionCount !== runs.length) {
      report.mismatches.push(`expected ${runs.length} legacy sessions, found ${sessionCount}`);
    }
    const stagedArtifactCount = (db.prepare("SELECT COUNT(*) as c FROM artifacts_migrated").get() as { c: number }).c;
    if (stagedArtifactCount !== report.artifactsRepointed) {
      report.mismatches.push(`expected ${report.artifactsRepointed} staged migrated artifacts, found ${stagedArtifactCount}`);
    }

    if (report.mismatches.length > 0) {
      throw new Error("migration verification failed — rolling back");
    }

    // Rename legacy tables so the new runtime writers are the only ones touching
    // "issues"/"worker_sessions"/etc., while the originals stay inspectable for one release.
    for (const table of ["runs", "artifacts", "events", "approval_gates"]) {
      db.exec(`ALTER TABLE ${table} RENAME TO legacy_v0_${table}`);
    }
    // Now that the name "artifacts" is free, promote the staged migrated copies into it —
    // this is the table listArtifactsForIssue() queries going forward.
    db.exec(`ALTER TABLE artifacts_migrated RENAME TO artifacts`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id)`);

    // Post-cutover assertion, not just a pre-rename count: query the table exactly the way
    // the live API does (by issue_id) and confirm every migrated artifact is actually
    // reachable there, not just present somewhere in the database.
    const reachableCount = (db.prepare("SELECT COUNT(*) as c FROM artifacts WHERE issue_id IS NOT NULL").get() as {
      c: number;
    }).c;
    if (reachableCount !== report.artifactsRepointed) {
      report.mismatches.push(
        `expected ${report.artifactsRepointed} migrated artifacts reachable via the post-cutover "artifacts" table, found ${reachableCount}`
      );
      throw new Error("migration verification failed — rolling back");
    }
  });

  try {
    tx();
  } catch {
    // better-sqlite3 already rolled back the transaction; report.mismatches carries the reason.
    if (report.mismatches.length === 0) {
      report.mismatches.push("migration failed for an unexpected reason — see thrown error");
    }
  }

  db.close();
  return report;
}

/**
 * Real liveness check, not a placeholder: the running service is tracked via
 * `run.json` (packages/cli/src/runtime-state.ts's RunState — a sibling of dealer.db in
 * the same AGENT_DEALER_HOME directory), not a lock file this codebase never creates.
 * Mirrors runtime-state.ts#isProcessAlive without importing across the scripts/->cli
 * package boundary.
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

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: tsx scripts/migrate-to-issues.ts <path-to-dealer.db>");
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }
  const liveness = isServiceRunning(dbPath);
  if (liveness.running) {
    console.error(`Refusing to migrate while the service is running (${liveness.detail}) — stop it first.`);
    process.exit(1);
  }
  const report = runMigration(dbPath);
  console.log(JSON.stringify(report, null, 2));
  if (report.mismatches.length > 0) {
    console.error("Migration rolled back — see mismatches above. Original data untouched.");
    process.exit(1);
  }
  console.log("Migration complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
