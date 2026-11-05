#!/usr/bin/env tsx
// Recompute usage_events.tokens_in from session logs so Claude/Cursor rows include
// cache read/write (extractSpawnUsage used to store bare input_tokens only).
//
// Usage:
//   AGENT_DEALER_ENV=production npx tsx scripts/repair-usage-tokens-in.ts
//   AGENT_DEALER_ENV=production npx tsx scripts/repair-usage-tokens-in.ts --apply
//
// Default is dry-run. Only updates rows where the recomputed value differs.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);

  const apply = process.argv.includes("--apply");

  const { getDb } = await import("../packages/server/src/db/index.js");
  const { extractSpawnUsage } = await import("../packages/server/src/coordinator/usage.js");

  type Row = {
    usage_id: string;
    worker_session_id: string;
    runtime: string;
    log_path: string | null;
    tokens_in: number | null;
  };

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.id AS usage_id, u.worker_session_id, u.runtime, s.log_path, u.tokens_in
       FROM usage_events u
       JOIN worker_sessions s ON s.id = u.worker_session_id
       WHERE u.runtime IN ('claude_code', 'cursor_local')
         AND u.tokens_in IS NOT NULL`
    )
    .all() as Row[];

  let missingLog = 0;
  let unchanged = 0;
  let updated = 0;
  let deltaSum = 0;
  const samples: Array<{ id: string; runtime: string; before: number; after: number }> = [];

  const update = db.prepare(`UPDATE usage_events SET tokens_in = ? WHERE id = ?`);

  const run = db.transaction(() => {
    for (const row of rows) {
      if (!row.log_path || !fs.existsSync(row.log_path)) {
        missingLog += 1;
        continue;
      }
      const recomputed = extractSpawnUsage(
        row.log_path,
        row.runtime as "claude_code" | "cursor_local"
      ).tokensIn;
      if (recomputed === null || recomputed === row.tokens_in) {
        unchanged += 1;
        continue;
      }
      deltaSum += recomputed - (row.tokens_in ?? 0);
      if (samples.length < 5) {
        samples.push({
          id: row.worker_session_id.slice(0, 8),
          runtime: row.runtime,
          before: row.tokens_in ?? 0,
          after: recomputed,
        });
      }
      if (apply) update.run(recomputed, row.usage_id);
      updated += 1;
    }
  });

  run();

  const out = {
    mode: apply ? "apply" : "dry-run",
    scanned: rows.length,
    missingLog,
    unchanged,
    wouldUpdateOrUpdated: updated,
    deltaSumTokensIn: deltaSum,
    samples,
  };
  fs.mkdirSync(path.join(root, ".temporal", "logs"), { recursive: true });
  const logPath = path.join(
    root,
    ".temporal",
    "logs",
    `repair-usage-tokens-in-${apply ? "apply" : "dry"}-${Date.now()}.json`
  );
  fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`wrote ${logPath}`);
  if (!apply && updated > 0) {
    console.log("Re-run with --apply to write updates.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
