import fs from "node:fs";
import { PlanTriageBlock } from "@agent-dealer/shared";
import type { PlanQuestion, RunPhase, Runtime, StreamTraceEntry, UsageContent } from "@agent-dealer/shared";

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

function stripMarkdownFences(text: string): string {
  const m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1].trim() : text.trim();
}

export function extractSessionId(events: StreamEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === "system" && typeof e.session_id === "string") return e.session_id;
  }
  return undefined;
}

export function extractResultIsError(events: StreamEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "result") return Boolean(e.is_error);
  }
  return false;
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

export function extractPlanMarkdown(events: StreamEvent[]): string {
  const raw = extractResultText(events) ?? "";
  return stripMarkdownFences(raw);
}

export interface PlanTriageExtraction {
  markdown: string;
  verdict: "trivial" | "needs_review";
  rationale: string;
  questions: PlanQuestion[];
  parseFallback: boolean;
}

const TRIAGE_FALLBACK = {
  verdict: "needs_review" as const,
  rationale: "Agent did not return a valid triage block",
  questions: [] as PlanQuestion[],
  parseFallback: true,
};

/** Parse the trailing fenced json triage block from plan markdown (PRD F1.2). */
export function extractPlanTriage(planMarkdown: string): PlanTriageExtraction {
  const blocks = [...planMarkdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = blocks[blocks.length - 1];
  if (!last) return { markdown: planMarkdown.trim(), ...TRIAGE_FALLBACK };
  try {
    const parsed = PlanTriageBlock.parse(JSON.parse(last[1]));
    const markdown = (
      planMarkdown.slice(0, last.index) + planMarkdown.slice(last.index! + last[0].length)
    ).trim();
    return {
      markdown,
      verdict: parsed.verdict,
      rationale: parsed.rationale,
      questions: parsed.questions,
      parseFallback: false,
    };
  } catch {
    return { markdown: planMarkdown.trim(), ...TRIAGE_FALLBACK };
  }
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

function appendAssistantText(entries: StreamTraceEntry[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = entries[entries.length - 1];
  if (last?.type === "assistant") {
    last.text = `${last.text}${text}`.slice(-4000);
  } else {
    entries.push({ type: "assistant", text: trimmed.slice(0, 4000) });
  }
}

export function buildStreamTrace(events: StreamEvent[], maxEntries = 80): StreamTraceEntry[] {
  const entries: StreamTraceEntry[] = [];

  for (const e of events) {
    const t = String(e.type ?? "");

    if (t === "system" && e.subtype === "init") {
      entries.push({
        type: "system",
        text: `session ${String(e.session_id ?? "?").slice(0, 8)} · model ${String(e.model ?? "?")}`,
      });
    }

    if (t === "thinking") {
      const delta = typeof e.text === "string" ? e.text : "";
      if (e.subtype === "completed") {
        entries.push({ type: "thinking", text: "(reasoning complete)" });
      } else if (delta) {
        const last = entries[entries.length - 1];
        if (last?.type === "thinking" && last.text !== "(reasoning complete)") {
          last.text = `${last.text}${delta}`.slice(-2000);
        } else {
          entries.push({ type: "thinking", text: delta.slice(0, 2000) });
        }
      }
    }

    if (t === "assistant") {
      const msg = e.message as { content?: Array<{ type?: string; text?: string; thinking?: string; name?: string }> } | undefined;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === "thinking" && block.thinking) {
            entries.push({ type: "thinking", text: block.thinking.slice(0, 2000) });
          } else if (block.type === "text" && block.text) {
            appendAssistantText(entries, block.text);
          } else if (block.type === "tool_use" && block.name) {
            entries.push({ type: "tool", text: `invoke ${block.name}`, toolName: block.name });
          }
        }
      }
    }

    if (t === "tool_call") {
      const name = String((e as { name?: string }).name ?? (e as { tool_name?: string }).tool_name ?? "tool");
      entries.push({ type: "tool", text: `invoke ${name}`, toolName: name });
    }

    if (t === "rate_limit_event") {
      const info = e.rate_limit_info as { status?: string; rateLimitType?: string } | undefined;
      entries.push({
        type: "rate_limit",
        text: `rate limit ${info?.status ?? "?"} (${info?.rateLimitType ?? "?"})`,
      });
    }

    if (t === "result") {
      const preview = typeof e.result === "string" ? e.result.slice(0, 500) : "";
      entries.push({
        type: "result",
        text: preview || (e.is_error ? "error" : "done"),
      });
    }
  }

  return entries.slice(-maxEntries);
}
