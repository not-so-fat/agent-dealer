// packages/server/src/coordinator/session-activity.ts
//
// NOT-170: normalize structured runtime stream events into activity kinds for the
// append-only `session_activity_events` evidence table, and scan new log bytes
// incrementally so the sampler persists only new semantic events — never one row per
// tick. Observational only: nothing here may be imported by admission, leases,
// recovery, routing, retry, termination, or scheduling code.

export type SessionActivityKind =
  | "assistant_output"
  | "provider_wait"
  | "tool_started"
  | "tool_completed"
  | "unknown_activity";

export type SessionActivityState = "started" | "completed" | "observed";

export interface NormalizedActivity {
  kind: SessionActivityKind;
  state: SessionActivityState;
  /** Pairs tool_started with tool_completed across runtimes; null when unnamed. */
  callId: string | null;
}

type StreamEvent = Record<string, unknown>;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

interface ContentPart {
  type?: string;
  name?: string;
  id?: string;
  text?: string;
  tool_use_id?: string;
}

function assistantContent(e: StreamEvent): ContentPart[] {
  if (e.type !== "assistant") return [];
  const msg = asRecord(e.message);
  const content = msg?.content;
  return Array.isArray(content) ? (content as ContentPart[]) : [];
}

function userContent(e: StreamEvent): ContentPart[] {
  if (e.type !== "user") return [];
  const msg = asRecord(e.message);
  const content = msg?.content;
  return Array.isArray(content) ? (content as ContentPart[]) : [];
}

/** Claude completion: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id }] } }. */
export function claudeToolResults(e: StreamEvent): string[] {
  const out: string[] = [];
  for (const c of userContent(e)) {
    if (c.type === "tool_result" && typeof c.tool_use_id === "string") out.push(c.tool_use_id);
  }
  return out;
}

/** Every tool_use block in an assistant event (parallel batches included). */
export function claudeToolUses(e: StreamEvent): Array<{ id: string | null; name: string | null }> {
  const out: Array<{ id: string | null; name: string | null }> = [];
  for (const c of assistantContent(e)) {
    if (c.type !== "tool_use") continue;
    out.push({
      id: typeof c.id === "string" ? c.id : null,
      name: typeof c.name === "string" ? c.name : null,
    });
  }
  return out;
}

function assistantText(e: StreamEvent): string | null {
  const text = assistantContent(e)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
  return text.length ? text : null;
}

/** Cursor nests tools as `{ readToolCall: { args } }` — no top-level name. */
function cursorToolKey(e: StreamEvent): string | null {
  if (e.type !== "tool_call") return null;
  const nested = asRecord(e.tool_call);
  if (!nested) return null;
  for (const [key, value] of Object.entries(nested)) {
    if (!key.endsWith("ToolCall") || !value || typeof value !== "object") continue;
    return key;
  }
  return null;
}

function codexItem(e: StreamEvent): { eventType: string; itemType: string; id: string | null } | null {
  const eventType = str(e.type);
  if (eventType !== "item.started" && eventType !== "item.completed" && eventType !== "item.updated") {
    return null;
  }
  const item = asRecord(e.item);
  if (!item) return null;
  const itemType = str(item.type);
  if (!itemType) return null;
  const id = str(item.id) ?? str(item.call_id) ?? str(e.call_id) ?? null;
  return { eventType, itemType, id };
}

const TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "file_change", "shell", "tool_call"]);

const RETRY_TEXT_RE = /rate[\s_-]*limit|usage[\s_-]*limit|quota|429|retrying|backoff|temporarily unavailable|overloaded/i;

function errorText(e: StreamEvent): string {
  const parts: string[] = [];
  for (const key of ["error", "message", "result", "reason"] as const) {
    const v = e[key];
    if (typeof v === "string") parts.push(v);
    else if (v && typeof v === "object") {
      const m = (v as { message?: unknown }).message;
      if (typeof m === "string") parts.push(m);
    }
  }
  return parts.join("\n");
}

function isProviderWaitEvent(e: StreamEvent): boolean {
  const type = str(e.type);
  // Claude explicit shapes.
  if (type === "rate_limit_event") return true;
  if (type === "system" && (e.subtype === "api_retry" || e.subtype === "retry")) return true;
  if (type === "system" && e.subtype === "error" && RETRY_TEXT_RE.test(errorText(e))) return true;
  if ((type === "error" || type === "stream_error") && RETRY_TEXT_RE.test(errorText(e))) return true;
  // Muse: task.lifecycle.status carrying a rate_limited / 429 external-attempt facet.
  if (type === "task.lifecycle.status" || e.payload_type === "task.lifecycle.status") {
    const payload = asRecord(e.event) ?? e;
    const details = asRecord(payload.details);
    const facets = details?.facets;
    if (Array.isArray(facets)) {
      for (const f of facets) {
        const facet = asRecord(f);
        if (
          facet?.kind === "external_attempt" &&
          (facet.error_kind === "rate_limited" || facet.http_status === 429)
        ) {
          return true;
        }
      }
    }
    if (RETRY_TEXT_RE.test(errorText(e))) return true;
  }
  // Codex: a failed turn that names retry/rate-limit evidence.
  if (type === "turn.failed" && RETRY_TEXT_RE.test(errorText(e))) return true;
  // Muse tool.result correlation facts may carry a rate_limited outcome marker.
  if (type === "tool.result" || e.payload_type === "tool.result") {
    const facts = asRecord(e.correlation_facts);
    const outcome = str(facts?.outcome);
    if (outcome === "rate_limited" || (typeof outcome === "string" && RETRY_TEXT_RE.test(outcome))) return true;
  }
  return false;
}

/**
 * Normalize one parsed NDJSON stream event. Returns null when the event carries no
 * semantic activity worth persisting (system init, thinking/reasoning prose, Codex
 * item.updated progress, result envelopes without provider-wait evidence, malformed
 * shapes). Multiple tool_use blocks in one assistant message yield one start each —
 * callers must persist every returned entry so parallel starts pair by call id.
 */
export function normalizeStreamEvent(e: StreamEvent): NormalizedActivity[] | null {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const type = str(e.type);

  if (isProviderWaitEvent(e)) {
    return [{ kind: "provider_wait", state: "observed", callId: null }];
  }

  // Claude tool completion arrives as a user/tool_result event — this is what closes
  // the flight opened by the assistant tool_use block with the same id.
  if (type === "user") {
    const results = claudeToolResults(e);
    if (results.length > 0) {
      return results.map((id) => ({ kind: "tool_completed" as const, state: "completed" as const, callId: id }));
    }
    return null;
  }

  if (type === "assistant") {
    const uses = claudeToolUses(e);
    if (uses.length > 0) {
      return uses.map((u) => ({ kind: "tool_started" as const, state: "started" as const, callId: u.id }));
    }
    if (assistantText(e) !== null) {
      return [{ kind: "assistant_output", state: "observed", callId: null }];
    }
    // Assistant envelope with neither text nor tool_use: structured but unclassified.
    const msg = asRecord(e.message);
    if (msg && Array.isArray(msg.content) && (msg.content as unknown[]).length > 0) {
      return [{ kind: "unknown_activity", state: "observed", callId: null }];
    }
    return null;
  }

  // Cursor / normalized tool_call shapes.
  if (type === "tool_call") {
    const subtype = str(e.subtype);
    const cursorKey = cursorToolKey(e);
    const name = str(e.name) ?? str(e.tool_name) ?? (cursorKey ? cursorKey.replace(/ToolCall$/, "") : null);
    const nested = asRecord(e.tool_call);
    const nestedResult = nested ? Object.values(nested).some((v) => asRecord(v)?.result != null) : false;
    const callId = str(e.call_id) ?? str(e.callId) ?? str(e.id) ?? null;
    const completed =
      subtype === "completed" || nestedResult || (subtype !== "started" && e.result !== undefined);
    if (completed) {
      return [{ kind: "tool_completed", state: "completed", callId }];
    }
    // A bare tool_call without completion evidence is a start (name may be unknown).
    if (subtype === "started" || name !== null || cursorKey !== null) {
      return [{ kind: "tool_started", state: "started", callId }];
    }
    return [{ kind: "unknown_activity", state: "observed", callId: null }];
  }

  // Codex native item events.
  const codex = codexItem(e);
  if (codex) {
    if (codex.eventType === "item.updated") {
      // Progress heartbeat on an already-open item — not a new start, never persisted.
      return null;
    }
    if (codex.itemType === "agent_message") {
      const item = asRecord(e.item);
      if (typeof item?.text === "string" && item.text.length > 0) {
        return [{ kind: "assistant_output", state: "observed", callId: null }];
      }
      return null;
    }
    if (codex.itemType === "reasoning") return null;
    if (TOOL_ITEM_TYPES.has(codex.itemType)) {
      if (codex.eventType === "item.completed") {
        return [{ kind: "tool_completed", state: "completed", callId: codex.id }];
      }
      return [{ kind: "tool_started", state: "started", callId: codex.id }];
    }
    return [{ kind: "unknown_activity", state: "observed", callId: codex.id }];
  }

  // Muse stdout envelopes that were not normalized into tool_call shapes.
  const payloadType = str(e.payload_type);
  if (payloadType === "task.lifecycle.side_effect_intent") {
    const event = asRecord(e.event);
    const operation = str(event?.operation);
    const key = str(event?.idempotency_key);
    if (operation?.startsWith("tool:") && key?.startsWith("tool:")) {
      return [{ kind: "tool_started", state: "started", callId: key.slice("tool:".length) }];
    }
    return null;
  }
  if (payloadType === "tool.result") {
    const callId = str(e.call_id) ?? null;
    return [{ kind: "tool_completed", state: "completed", callId }];
  }

  if (type === "result") {
    // Terminal envelope: not activity by itself (assistant text already persisted).
    return null;
  }
  if (type === "system" || type === "thinking") return null;

  // Any other well-formed object with a type is structured activity we cannot classify.
  if (type !== undefined) {
    return [{ kind: "unknown_activity", state: "observed", callId: null }];
  }
  return null;
}

export interface ScannedActivity {
  cursor: number;
  /**
   * Byte offset where this line starts, relative to the scanned chunk start;
   * endOffset is exclusive. Always bytes (Buffer.byteLength), never string
   * character offsets, so multibyte log content resumes at the right position.
   */
  offset: number;
  endOffset: number;
  /** 0-based index of this entry within its line — the idempotency seq. */
  seq: number;
  event: StreamEvent;
  normalized: NormalizedActivity;
}

/**
 * Scan bytes appended to a session log since `fromOffset`, parsing each new line.
 * Malformed/non-JSON lines are skipped (never fabricated into events). `cursor` is
 * the absolute 0-based line index so restarts can resume from the durable offset and
 * idempotency holds per (session, source_offset, source_seq). All offsets are byte
 * offsets. Pure over the given bytes — reads no files, writes nothing.
 */
export function scanNewActivityLines(
  raw: string,
  opts: { fromOffset?: number; baseCursor?: number } = {}
): { scanned: ScannedActivity[]; nextOffset: number; nextCursor: number } {
  // Work on the UTF-8 bytes throughout: string character offsets drift from file
  // byte offsets as soon as any multibyte content appears, which would corrupt the
  // persisted source_offset pointers and the restart resume position. 0x0A never
  // occurs inside a multibyte sequence, so byte-splitting on newlines is safe.
  const buf = Buffer.from(raw, "utf8");
  const fromOffset = opts.fromOffset ?? 0;
  const start = fromOffset >= 0 && fromOffset <= buf.length ? fromOffset : 0;
  let cursor = opts.baseCursor ?? 0;
  if (start !== fromOffset) cursor = 0;
  const scanned: ScannedActivity[] = [];
  let lineStart = start;
  const decode = (from: number, to: number): string => buf.subarray(from, to).toString("utf8");
  // Every "\n" terminates exactly one line; a trailing partial line (no newline yet)
  // is held back, and the phantom segment after a final newline is not a line.
  for (let i = start; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const lineEnd = i + 1; // include the newline
    const lineCursor = cursor;
    cursor++;
    const line = decode(lineStart, i);
    const entryStart = lineStart;
    const entryEnd = lineEnd;
    lineStart = lineEnd;
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // incomplete/malformed lines are skipped, never persisted
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const normalized = normalizeStreamEvent(parsed as StreamEvent);
    if (!normalized) continue;
    normalized.forEach((n, seq) => {
      scanned.push({ cursor: lineCursor, offset: entryStart, endOffset: entryEnd, seq, event: parsed as StreamEvent, normalized: n });
    });
  }
  return { scanned, nextOffset: lineStart, nextCursor: cursor };
}
