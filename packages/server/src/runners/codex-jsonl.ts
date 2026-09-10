type StreamEvent = Record<string, unknown>;

export function parseCodexJsonl(raw: string): StreamEvent[] {
  const stdoutOnly = stripStderrTrailer(raw);
  const events: StreamEvent[] = [];
  for (const line of stdoutOnly.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as StreamEvent);
    } catch {
      // skip non-json (e.g. trailing stderr markers if present)
    }
  }
  return events;
}

/** spawnCli appends stderr after a marker — ignore that for JSONL parse. */
export function stripStderrTrailer(raw: string): string {
  const idx = raw.indexOf("\n--- stderr ---\n");
  return idx >= 0 ? raw.slice(0, idx) : raw;
}

export function extractCodexThreadId(events: StreamEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === "thread.started" && typeof e.thread_id === "string") {
      return e.thread_id;
    }
  }
  return undefined;
}

function itemOf(e: StreamEvent): Record<string, unknown> | undefined {
  const item = e.item;
  if (item && typeof item === "object") return item as Record<string, unknown>;
  return undefined;
}

export function extractCodexResultText(events: StreamEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "item.completed") continue;
    const item = itemOf(e);
    if (item?.type === "agent_message" && typeof item.text === "string" && item.text.length > 0) {
      return item.text;
    }
  }
  return undefined;
}

function usageFromTurn(events: StreamEvent[]): Record<string, number> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "turn.completed") continue;
    const usage = e.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const u = usage as Record<string, unknown>;
    const out: Record<string, number> = {};
    if (typeof u.input_tokens === "number") out.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") out.output_tokens = u.output_tokens;
    if (typeof u.cached_input_tokens === "number") out.cache_read_input_tokens = u.cached_input_tokens;
    if (typeof u.reasoning_output_tokens === "number") {
      out.output_tokens = (out.output_tokens ?? 0) + u.reasoning_output_tokens;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

function errorMessage(events: StreamEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "turn.failed") {
      const err = e.error;
      if (typeof err === "string") return err;
      if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
        return (err as { message: string }).message;
      }
      return "turn failed";
    }
    if (e.type === "error") {
      if (typeof e.message === "string") return e.message;
      return "codex error";
    }
  }
  return undefined;
}

/**
 * Map Codex JSONL events into Claude/Cursor-shaped NDJSON so persist extractors work unchanged.
 */
export function normalizeCodexEvents(events: StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  const threadId = extractCodexThreadId(events);
  if (threadId) {
    out.push({ type: "system", subtype: "init", session_id: threadId });
  }

  for (const e of events) {
    if (e.type === "item.completed" || e.type === "item.started" || e.type === "item.updated") {
      const item = itemOf(e);
      if (!item) continue;
      const itemType = String(item.type ?? "");

      if (itemType === "agent_message" && typeof item.text === "string" && item.text) {
        out.push({
          type: "assistant",
          message: { content: [{ type: "text", text: item.text }] },
        });
      } else if (itemType === "reasoning" && typeof item.text === "string" && item.text) {
        out.push({ type: "thinking", text: item.text });
      } else if (itemType === "command_execution") {
        const cmd = typeof item.command === "string" ? item.command : "command";
        out.push({ type: "tool_call", name: "Bash", text: cmd });
      } else if (itemType === "mcp_tool_call") {
        const name = typeof item.name === "string" ? item.name : "mcp";
        out.push({ type: "tool_call", name });
      } else if (itemType === "file_change") {
        out.push({ type: "tool_call", name: "Edit" });
      }
    }
  }

  const err = errorMessage(events);
  const resultText = extractCodexResultText(events);
  const usage = usageFromTurn(events);

  if (err) {
    out.push({
      type: "result",
      is_error: true,
      result: err,
      ...(usage ? { usage } : {}),
    });
  } else if (resultText) {
    out.push({
      type: "result",
      result: resultText,
      ...(usage ? { usage } : {}),
    });
  } else if (usage) {
    out.push({ type: "result", result: "", usage });
  }

  return out;
}
