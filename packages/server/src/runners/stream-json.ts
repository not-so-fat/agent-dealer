import fs from "node:fs";
import type { RunPhase, Runtime, UsageContent } from "@agent-dealer/shared";

// NDJSON stream parsing shared by the coordinator's session readers (usage, live progress,
// verification receipts, usage caps) and the legacy reflect runner. NOT-71 removed the
// plan-triage and outbound-draft block extractors along with the plan/execute product that
// produced those blocks, and the stream-trace builder with the run detail view that showed it.

type StreamEvent = Record<string, unknown>;

export function parseNdjson(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as StreamEvent);
    } catch {
      // skip non-json
    }
  }
  return events;
}

export function parseNdjsonFile(logPath: string): StreamEvent[] {
  if (!fs.existsSync(logPath)) return [];
  return parseNdjson(fs.readFileSync(logPath, "utf8"));
}

export function extractSessionId(events: StreamEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === "system" && typeof e.session_id === "string") return e.session_id;
  }
  return undefined;
}

export function extractResultText(events: StreamEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "result" && typeof e.result === "string" && e.result.length > 0) {
      return e.result;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const msg = events[i].message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (!msg?.content) continue;
    const text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (text.length > 20) return text;
  }
  return undefined;
}

export function extractUsage(
  events: StreamEvent[],
  phase: RunPhase,
  runtime: Runtime
): UsageContent {
  const result = events.find((e) => e.type === "result");
  const init = events.find((e) => e.type === "system");
  const usage = (result?.usage ?? {}) as Record<string, number>;
  const modelUsage = result?.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }> | undefined;
  const primaryModel = modelUsage ? Object.keys(modelUsage)[0] : undefined;

  return {
    phase,
    runtime,
    totalCostUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? usage.cacheReadTokens,
    cacheWriteTokens: usage.cache_write_input_tokens ?? usage.cacheWriteTokens,
    durationMs: typeof result?.duration_ms === "number" ? result.duration_ms : undefined,
    model: (init?.model as string | undefined) ?? primaryModel,
    numTurns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
  };
}
