import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_AGENT_CLAUDE_ID,
  BUILTIN_AGENT_CURSOR_ID,
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

export function migrate(): void {
  const db = getDb();
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

  const runCols3 = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols3.some((c) => c.name === "plan_model")) {
    db.exec("ALTER TABLE runs ADD COLUMN plan_model TEXT");
    db.exec("ALTER TABLE runs ADD COLUMN execute_model TEXT");
  }

  seedBuiltinAgents(db);
  seedIntakeSettings(db);
  migrateLegacyAgentDeckPort(db);

  // Default agents are normal rows — clear legacy built-in flag.
  db.exec("UPDATE agents SET is_builtin = 0 WHERE is_builtin = 1");
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
  const stateFilter = (process.env.LINEAR_STATE_FILTER ?? "Todo")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const teamId = process.env.LINEAR_TEAM_ID ?? null;

  const defaults: Record<string, unknown> = {
    "linear.stateFilter": stateFilter.length > 0 ? stateFilter : ["Todo"],
    "linear.teamId": teamId,
    "linear.assigneeMe": true,
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

  db.prepare(
    `UPDATE agents SET
      default_plan_model = COALESCE(default_plan_model, ?),
      default_execute_model = COALESCE(default_execute_model, ?),
      updated_at = ?
     WHERE id = ? AND runtime = 'cursor_local'`
  ).run(CURSOR_DEFAULT_MODEL, CURSOR_DEFAULT_MODEL, now, BUILTIN_AGENT_CURSOR_ID);
}
