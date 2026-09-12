// packages/server/src/coordinator/usage.ts
//
// Pulls token/cost usage out of a developer/reviewer session's raw ndjson log, so
// developer-effect.ts / reviewer-effect.ts can attribute cost per the design doc's
// `usage_events` table. Reuses the exact per-runtime event parsers persist.ts already
// uses for the legacy `Run` model (runners/stream-json.ts, runners/codex-jsonl.ts)
// rather than re-implementing stream-format parsing for the new coordinator.
import type { Runtime } from "@agent-dealer/shared";
import { parseNdjsonFile } from "../runners/stream-json.js";
import { normalizeCodexEvents, parseCodexJsonl } from "../runners/codex-jsonl.js";
import fs from "node:fs";

export interface SpawnUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

const EMPTY: SpawnUsage = { tokensIn: null, tokensOut: null, costUsd: null };

/** Best-effort: a missing/unparseable log never blocks recording the session's duration. */
export function extractSpawnUsage(logPath: string, runtime: Runtime): SpawnUsage {
  if (!fs.existsSync(logPath)) return EMPTY;
  const events =
    runtime === "codex_local"
      ? normalizeCodexEvents(parseCodexJsonl(fs.readFileSync(logPath, "utf8")))
      : parseNdjsonFile(logPath);
  const result = events.find((e) => (e as { type?: string }).type === "result") as
    | { usage?: Record<string, number>; total_cost_usd?: number }
    | undefined;
  const usage = result?.usage ?? {};
  return {
    tokensIn: usage.input_tokens ?? usage.inputTokens ?? null,
    tokensOut: usage.output_tokens ?? usage.outputTokens ?? null,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
  };
}
