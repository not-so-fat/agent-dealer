// packages/server/src/coordinator/usage.ts
//
// Pulls token/cost usage out of a developer/reviewer session's raw ndjson log, so
// developer-effect.ts / reviewer-effect.ts can attribute cost per the design doc's
// `usage_events` table. Reuses the exact per-runtime event parsers persist.ts already
// uses for the legacy `Run` model (runners/stream-json.ts, runners/codex-jsonl.ts)
// rather than re-implementing stream-format parsing for the new coordinator.
import type { Runtime } from "@agent-dealer/shared";
import { extractResultText, parseNdjsonFile } from "../runners/stream-json.js";
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

/**
 * The final assistant message text out of a developer/reviewer session's raw ndjson log
 * — never the raw multi-event stream `spawnCli` hands back as its in-memory `transcript`.
 * That raw stream is not a single coherent document: with `--stream-partial-output`
 * (cursor) the same growing answer appears as many overlapping partial fragments before
 * its final, complete form, so any parser (e.g. reviewer-result.ts's fenced-JSON regex)
 * run directly against it can match an early, truncated fragment instead of the finished
 * output. Reuses the exact per-runtime `type: "result"` extraction `extractSpawnUsage`
 * already applies to the same log, so both stay in sync with how each runtime's events
 * are parsed/normalized. Falls back to the raw transcript when nothing parses (e.g. a
 * crash before any structured event, or a non-stream-json output format) so callers never
 * regress to less text than they had before this extraction existed.
 */
export function extractResultTranscript(logPath: string, runtime: Runtime, fallback: string): string {
  if (!fs.existsSync(logPath)) return fallback;
  const events =
    runtime === "codex_local"
      ? normalizeCodexEvents(parseCodexJsonl(fs.readFileSync(logPath, "utf8")))
      : parseNdjsonFile(logPath);
  return extractResultText(events) ?? fallback;
}
