// packages/server/src/coordinator/session-progress.ts
//
// NOT-109: low-volume mid-session milestones + live intent updates so Issue Detail answers
// "what happened last?" while a developer/reviewer is running. Timeline events are
// milestones only — never per-tool-call. During a long agent spawn, a log sampler may
// refresh `currentIntent` without appending events.
//
// NOT-120: deriveLiveProgressFromLog parses the session NDJSON tail into a concrete
// operator-facing line (assistant sentence and/or tool activity) for the live strip.
import fs from "node:fs";
import path from "node:path";
import type { WorkflowEventType } from "@agent-dealer/shared";
import { getIssue, transitionIssue } from "../repository/issues.js";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import { parseNdjson } from "../runners/stream-json.js";
import {
  getSessionActivityMaxCursor,
  getSessionActivityMaxOffset,
  insertSessionActivityEvent,
} from "../repository/session-activity.js";
import { scanNewActivityLines } from "./session-activity.js";

export type SessionRole = "developer" | "reviewer";

const ROLE_LABEL: Record<SessionRole, string> = {
  developer: "Developer",
  reviewer: "Reviewer",
};

const LIVE_STATUSES = new Set(["developing", "reviewing", "repairing"]);

/** Max chars for the strip primary line (one readable line). */
export const LIVE_PROGRESS_MAX_CHARS = 120;

/** Ignore Cursor token-stream crumbs and other tiny fragments. */
const MIN_ASSISTANT_CHARS = 28;

const ACTIVITY_RULES: Array<{ match: RegExp; label: string }> = [
  { match: /lens|bugbot|security-review/i, label: "Lens check" },
  { match: /pytest|npm test|vitest|jest|node --test|flow:verify|typecheck/i, label: "running tests" },
  { match: /git commit|gh pr|commit/i, label: "committing" },
  { match: /write|stredit|applypatch|editnotebook|search_replace/i, label: "editing" },
  { match: /shell|bash|terminal/i, label: "running commands" },
  { match: /call_service_tool|get_issue|linear/i, label: "fetching ticket brief" },
  { match: /bind_workspace|get_bound_deck|get_playbook/i, label: "deck bind" },
  { match: /read|grep|glob|semanticsearch/i, label: "exploring code" },
];

/** Short worktree path for timeline payloads — last two path segments when present. */
export function shortWorktreePath(worktreePath: string | null | undefined): string | null {
  if (!worktreePath) return null;
  const parts = worktreePath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return worktreePath;
  return parts.slice(-2).join("/");
}

export interface WorkerSessionPayload {
  runtime: string | null;
  model: string | null;
  sessionId: string;
  worktreePath?: string | null;
}

export function workerSessionPayload(input: {
  runtime: string | null | undefined;
  model: string | null | undefined;
  sessionId: string;
  worktreePath?: string | null;
}): WorkerSessionPayload {
  return {
    runtime: input.runtime ?? null,
    model: input.model ?? null,
    sessionId: input.sessionId,
    ...(input.worktreePath !== undefined
      ? { worktreePath: shortWorktreePath(input.worktreePath) }
      : {}),
  };
}

/** Updates currentIntent in place (status self-loop) while a session is live. */
export function setLiveIntent(issueId: string, intent: string): void {
  const issue = getIssue(issueId);
  if (!issue || !LIVE_STATUSES.has(issue.status)) return;
  if (issue.currentIntent === intent) return;
  transitionIssue(issueId, issue.status, { currentIntent: intent });
}

export interface EmitMilestoneInput {
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string;
  role: SessionRole;
  stage: string;
  round: number;
  type: WorkflowEventType;
  intent: string;
  payload?: unknown;
}

/**
 * Append a milestone timeline event and refresh the issue's primary status line.
 * Callers must keep volume low — setup / checks / push, not every tool use.
 */
export function emitSessionMilestone(input: EmitMilestoneInput): void {
  appendWorkflowEvent({
    issueId: input.issueId,
    workflowInstanceId: input.workflowInstanceId,
    workerSessionId: input.workerSessionId,
    type: input.type,
    actorType: input.role,
    stage: input.stage,
    round: input.round,
    payload: input.payload,
  });
  setLiveIntent(input.issueId, input.intent);
}

function readLogTail(logPath: string, maxBytes = 64_000): string | null {
  if (!logPath || !fs.existsSync(logPath)) return null;
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function basenamePath(p: string): string {
  const base = path.basename(p.replace(/\\/g, "/"));
  return base || p;
}

function truncateOneLine(text: string, maxChars = LIVE_PROGRESS_MAX_CHARS): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= maxChars) return one;
  const cut = one.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${cut}…`;
}

function assistantTextFromEvent(e: Record<string, unknown>): string | null {
  if (e.type !== "assistant") return null;
  const msg = e.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (!msg?.content) {
    if (typeof e.text === "string" && e.text.trim()) return e.text;
    return null;
  }
  const text = msg.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
  return text.length ? text : null;
}

/** Cursor nests tools as `{ readToolCall: { args } }` — no top-level name. */
function cursorToolEntry(
  e: Record<string, unknown>
): { key: string; args: Record<string, unknown> } | null {
  if (e.type !== "tool_call") return null;
  const nested = e.tool_call;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
    if (!key.endsWith("ToolCall") || !value || typeof value !== "object") continue;
    const args = (value as { args?: Record<string, unknown> }).args;
    return { key, args: args && typeof args === "object" ? args : {} };
  }
  return null;
}

function toolNameFromEvent(e: Record<string, unknown>): string | null {
  const cursor = cursorToolEntry(e);
  if (cursor) {
    // readToolCall → Read, shellToolCall → Shell, mcpToolCall → Mcp
    const stem = cursor.key.replace(/ToolCall$/, "");
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  }
  if (e.type === "tool_call") {
    const name = (e as { name?: string; tool_name?: string }).name ?? (e as { tool_name?: string }).tool_name;
    return typeof name === "string" ? name : null;
  }
  if (e.type === "assistant") {
    const msg = e.message as { content?: Array<{ type?: string; name?: string }> } | undefined;
    const tool = msg?.content?.find((c) => c.type === "tool_use" && c.name);
    return tool?.name ?? null;
  }
  if (typeof e.tool_name === "string") return e.tool_name;
  if (typeof e.name === "string" && (e.type === "tool" || e.type === "function_call")) return e.name;
  return null;
}

function claudeToolInput(e: Record<string, unknown>): Record<string, unknown> | null {
  if (e.type === "assistant") {
    const msg = e.message as {
      content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }>;
    } | undefined;
    const tool = msg?.content?.find((c) => c.type === "tool_use");
    if (tool?.input && typeof tool.input === "object") return tool.input;
  }
  if (e.type === "tool_call" && e.input && typeof e.input === "object") {
    return e.input as Record<string, unknown>;
  }
  return null;
}

function isTestCommand(command: string): boolean {
  return /pytest|npm test|npm run test|vitest|jest|node --test|flow:verify|typecheck|poc:integration/i.test(
    command
  );
}

/** Concrete, human-readable tool activity for the live strip. */
export function formatToolProgress(e: Record<string, unknown>): string | null {
  const cursor = cursorToolEntry(e);
  if (cursor) {
    const { key, args } = cursor;
    if (key === "readToolCall" && typeof args.path === "string") {
      return `Reading ${basenamePath(args.path)}`;
    }
    if (key === "writeToolCall" || key === "editToolCall" || key === "applyPatchToolCall") {
      const p =
        (typeof args.path === "string" && args.path) ||
        (typeof args.file_path === "string" && args.file_path) ||
        (typeof args.target_notebook === "string" && args.target_notebook) ||
        null;
      return p ? `Editing ${basenamePath(p)}` : "Editing files";
    }
    if (key === "shellToolCall" && typeof args.command === "string") {
      const cmd = args.command.replace(/\s+/g, " ").trim();
      if (isTestCommand(cmd)) return truncateOneLine(`Running tests: ${cmd}`);
      return truncateOneLine(`Running: ${cmd}`);
    }
    if (key === "grepToolCall") {
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      return pattern ? truncateOneLine(`Searching: ${pattern}`) : "Searching code";
    }
    if (key === "globToolCall") {
      const glob =
        (typeof args.globPattern === "string" && args.globPattern) ||
        (typeof args.glob_pattern === "string" && args.glob_pattern) ||
        (typeof args.glob === "string" && args.glob) ||
        null;
      return glob ? truncateOneLine(`Finding files: ${glob}`) : "Finding files";
    }
    if (key === "mcpToolCall" || key === "getMcpToolsToolCall") {
      const name =
        (typeof args.toolName === "string" && args.toolName) ||
        (typeof args.name === "string" && args.name) ||
        (typeof args.tool_name === "string" && args.tool_name) ||
        null;
      return name ? truncateOneLine(`MCP: ${name}`) : "Calling MCP tool";
    }
    if (key === "updateTodosToolCall") return "Updating todos";
    const stem = key.replace(/ToolCall$/, "");
    return `Using ${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
  }

  const name = toolNameFromEvent(e);
  if (!name) return null;
  const input = claudeToolInput(e) ?? {};
  const haystack = `${name} ${JSON.stringify(input).slice(0, 500)}`;

  if (/^(Read|read_file)$/i.test(name) && typeof input.path === "string") {
    return `Reading ${basenamePath(input.path)}`;
  }
  if (/^(Write|StrReplace|Edit|ApplyPatch|search_replace|EditNotebook)$/i.test(name)) {
    const p =
      (typeof input.path === "string" && input.path) ||
      (typeof input.file_path === "string" && input.file_path) ||
      null;
    return p ? `Editing ${basenamePath(p)}` : "Editing files";
  }
  if (/^(Shell|Bash|Terminal)$/i.test(name) && typeof input.command === "string") {
    const cmd = input.command.replace(/\s+/g, " ").trim();
    if (isTestCommand(cmd)) return truncateOneLine(`Running tests: ${cmd}`);
    return truncateOneLine(`Running: ${cmd}`);
  }
  if (/^(Grep|rg)$/i.test(name) && typeof input.pattern === "string") {
    return truncateOneLine(`Searching: ${input.pattern}`);
  }

  for (const rule of ACTIVITY_RULES) {
    if (rule.match.test(haystack)) {
      // Title-case the coarse label for the strip.
      const label = rule.label.charAt(0).toUpperCase() + rule.label.slice(1);
      return label;
    }
  }
  return `Using ${name}`;
}

/**
 * Derive a short operator-facing activity line from the latest tool-ish log events.
 * Returns null when the log has nothing actionable yet.
 */
export function deriveActivityFromLog(logPath: string): string | null {
  const progress = deriveLiveProgressFromLog(logPath);
  if (!progress) return null;
  // Keep sampler labels short when mapping into currentIntent.
  return progress;
}

/**
 * Parse the session log tail into a concrete live-progress line for the issue strip.
 * Prefers a meaningful coalesced assistant sentence when present after the latest tool;
 * otherwise the latest tool activity. Ignores tiny token-stream fragments.
 */
export function deriveLiveProgressFromLog(
  logPath: string,
  maxChars = LIVE_PROGRESS_MAX_CHARS
): string | null {
  const raw = readLogTail(logPath);
  if (!raw) return null;
  const events = parseNdjson(raw);
  if (!events.length) return null;

  let lastTool: string | null = null;
  let lastToolIsStarted = false;
  const trailingAssistant: string[] = [];
  let collectingAssistant = true;

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const assistant = assistantTextFromEvent(e);
    if (assistant !== null) {
      if (collectingAssistant) trailingAssistant.unshift(assistant);
      continue;
    }

    // Stop coalescing assistant tokens once we hit a non-assistant event.
    collectingAssistant = false;

    if (e.type === "tool_call" || toolNameFromEvent(e)) {
      // Prefer "started" over "completed" for "what is happening now".
      const subtype = typeof e.subtype === "string" ? e.subtype : "";
      if (subtype === "completed" && lastTool) continue;
      const label = formatToolProgress(e);
      if (!label) continue;
      if (!lastTool || (subtype === "started" && !lastToolIsStarted)) {
        lastTool = label;
        lastToolIsStarted = subtype === "started" || subtype === "";
      }
      // Keep scanning for a started call if we only have completed so far.
      if (lastToolIsStarted) break;
      continue;
    }

    if (lastTool || trailingAssistant.length) break;
  }

  const coalesced = trailingAssistant.join("").replace(/\s+/g, " ").trim();
  if (coalesced.length >= MIN_ASSISTANT_CHARS) {
    return truncateOneLine(coalesced, maxChars);
  }
  if (lastTool) return truncateOneLine(lastTool, maxChars);

  // No trailing assistant / recent tool — scan the tail for any earlier tool activity.
  for (let i = events.length - 1; i >= 0; i--) {
    const label = formatToolProgress(events[i]!);
    if (label) return truncateOneLine(label, maxChars);
  }
  return null;
}

/** Cap per-tick incremental log reads so one tick stays cheap on large logs. */
const ACTIVITY_READ_MAX_BYTES = 256_000;

/**
 * A single NDJSON line longer than this is skipped past explicitly: without a skip
 * the scanner would hold the unterminated line back forever, the offset would never
 * advance, and no later event would persist. 4MB holds any realistic tool_result
 * while bounding per-tick work.
 */
const ACTIVITY_LINE_SKIP_CAP_BYTES = 4_000_000;

function readBytesSync(fd: number, from: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, from);
  return buf;
}

function findNextNewlineEnd(fd: number, from: number, size: number): number {
  // Byte offset just past the next "\n" at or after `from`, or `size` when the
  // remainder has no newline. Bounded windows keep a garbage log from pinning a tick.
  const WINDOW = 64_000;
  let cursor = from;
  while (cursor < size) {
    const len = Math.min(WINDOW, size - cursor);
    const buf = readBytesSync(fd, cursor, len);
    const idx = buf.indexOf(0x0a);
    if (idx >= 0) return cursor + idx + 1;
    cursor += len;
    if (cursor - from > 64 * 1024 * 1024) return size;
  }
  return size;
}

interface ActivityChunk {
  /** Decoded text to scan. Empty when an oversized line was skipped or at EOF. */
  text: string;
  /** Total bytes consumed from the log, including any skipped oversized line. */
  bytesRead: number;
}

/**
 * Read the next scannable bytes from `fromOffset` (a byte offset). Extends the read
 * window past ACTIVITY_READ_MAX_BYTES until a newline is found so a long-but-valid
 * line still scans; skips explicitly past a single line longer than
 * ACTIVITY_LINE_SKIP_CAP_BYTES so the offset always advances. Returns null when the
 * log is truncated/rotated or unreadable — the caller resets to 0.
 */
function readActivityChunk(logPath: string, fromOffset: number): ActivityChunk | null {
  if (!logPath || !fs.existsSync(logPath)) return null;
  try {
    const size = fs.statSync(logPath).size;
    if (size < fromOffset) return null; // truncated/rotated — caller resets
    if (size === fromOffset) return { text: "", bytesRead: 0 };
    const fd = fs.openSync(logPath, "r");
    try {
      let end = Math.min(size, fromOffset + ACTIVITY_READ_MAX_BYTES);
      let buf = readBytesSync(fd, fromOffset, end - fromOffset);
      while (buf.indexOf(0x0a) < 0 && end < size && buf.length < ACTIVITY_LINE_SKIP_CAP_BYTES) {
        const nextEnd = Math.min(size, end + ACTIVITY_READ_MAX_BYTES);
        buf = Buffer.concat([buf, readBytesSync(fd, end, nextEnd - end)]);
        end = nextEnd;
      }
      if (buf.indexOf(0x0a) < 0) {
        if (end >= size) {
          // One partial line, still under the cap, at EOF — hold it back; the
          // writer may still complete it, and the scanner drops it from nextOffset.
          return { text: buf.toString("utf8"), bytesRead: buf.length };
        }
        // Oversized line with more log after it: skip past its newline so later
        // events persist. The giant line itself is never parsed or stored.
        const skipEnd = findNextNewlineEnd(fd, fromOffset + buf.length, size);
        return { text: "", bytesRead: skipEnd - fromOffset };
      }
      return { text: buf.toString("utf8"), bytesRead: buf.length };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function summarizeActivityEvent(
  e: Record<string, unknown>,
  kind: string
): string | null {
  if (kind === "tool_started" || kind === "tool_completed") {
    return formatToolProgress(e);
  }
  if (kind === "assistant_output") {
    const text = assistantTextFromEvent(e);
    if (!text) return null;
    return truncateOneLine(text);
  }
  if (kind === "provider_wait") return "Provider wait/retry";
  const type = typeof e.type === "string" ? e.type : "event";
  return truncateOneLine(`Structured activity: ${type}`);
}

/**
 * While an agent CLI is running, periodically refresh currentIntent from the session log
 * without flooding the timeline. No-ops when the log has no new activity label.
 *
 * NOT-170: the same tick also persists new structured stream events (tool starts and
 * completions, assistant output, provider wait/retry) into `session_activity_events` —
 * no second polling loop. Ticks with no new log bytes persist nothing, and repeated
 * ticks never duplicate rows: resume starts from the durable MAX(source_offset) and
 * re-inserts are no-ops on UNIQUE(worker_session_id, source_offset, source_seq), where
 * source_seq distinguishes parallel entries from one NDJSON line. All offsets are
 * file byte offsets. `workerSessionId` is required for persistence; without it the
 * sampler only refreshes intent.
 */
export function startActivitySampler(opts: {
  issueId: string;
  role: SessionRole;
  round: number;
  logPath: string;
  workerSessionId?: string;
  intervalMs?: number;
}): { stop: () => void } {
  const prefix = `${ROLE_LABEL[opts.role]} ·`;
  let lastLabel: string | null = null;
  let lastOffset = 0;
  let baseCursor = 0;
  let resumeDone = false;
  const ensureResumed = () => {
    if (resumeDone || !opts.workerSessionId) return;
    resumeDone = true;
    try {
      const maxOffset = getSessionActivityMaxOffset(opts.workerSessionId);
      if (maxOffset !== null) lastOffset = maxOffset;
      const maxCursor = getSessionActivityMaxCursor(opts.workerSessionId);
      if (maxCursor !== null) baseCursor = maxCursor + 1;
    } catch {
      // persistence must never break the live strip
    }
  };
  /**
   * One incremental persist pass. Returns true when the offset advanced (more log
   * may remain); the final flush loops on it until EOF.
   */
  const sampleAndPersistActivity = (): boolean => {
    if (!opts.workerSessionId) return false;
    ensureResumed();
    let read: ActivityChunk | null;
    try {
      read = readActivityChunk(opts.logPath, lastOffset);
    } catch {
      return false;
    }
    if (read === null) {
      // Log truncated/rotated or unreadable: restart from the beginning. Rows already
      // persisted stay deduplicated by UNIQUE(worker_session_id, source_offset, source_seq).
      lastOffset = 0;
      baseCursor = 0;
      return false;
    }
    if (!read.text) {
      // EOF, or an oversized line was skipped past: advance past consumed bytes.
      if (read.bytesRead > 0) {
        lastOffset += read.bytesRead;
        return true;
      }
      return false;
    }
    let result: ReturnType<typeof scanNewActivityLines>;
    try {
      result = scanNewActivityLines(read.text, { baseCursor });
    } catch {
      return false;
    }
    const { scanned, nextOffset, nextCursor } = result;
    const observedAt = new Date().toISOString();
    if (scanned.length > 0 && opts.workerSessionId) {
      try {
        for (const s of scanned) {
          insertSessionActivityEvent({
            issueId: opts.issueId,
            workerSessionId: opts.workerSessionId,
            observedAt,
            sourceCursor: s.cursor,
            // Exclusive end byte offset: restart resumes from MAX(source_offset).
            sourceOffset: lastOffset + s.endOffset,
            sourceSeq: s.seq,
            activityKind: s.normalized.kind,
            state: s.normalized.state,
            callId: s.normalized.callId,
            summary: summarizeActivityEvent(s.event, s.normalized.kind),
            rawEvidence: `${opts.logPath}#offset=${lastOffset + s.offset}`,
          });
        }
      } catch {
        // persistence must never break the live strip
      }
    }
    lastOffset += nextOffset;
    baseCursor = nextCursor;
    // Progress when complete lines were consumed; a held-back-only chunk leaves the
    // offset untouched. bytesRead beyond nextOffset is the held-back partial tail.
    return nextOffset > 0;
  };
  const tick = () => {
    const activity = deriveLiveProgressFromLog(opts.logPath);
    if (activity && activity !== lastLabel) {
      lastLabel = activity;
      setLiveIntent(opts.issueId, `${prefix} ${activity} (round ${opts.round})`);
    }
    sampleAndPersistActivity();
  };
  const handle = setInterval(tick, opts.intervalMs ?? 10_000);
  // First sample soon so the strip moves off "session running" once tools appear.
  const first = setTimeout(tick, 2_000);
  return {
    stop() {
      clearInterval(handle);
      clearTimeout(first);
      // Final flush: events written after the last tick (e.g. a trailing tool
      // completion) must still close their flight before the process is gone.
      // Loop until EOF so a large backlog spanning several read windows still
      // persists; bounded so a pathological log cannot hang process exit.
      for (let i = 0; i < 64; i++) {
        if (!sampleAndPersistActivity()) break;
      }
    },
  };
}

/** Task/AC are "complete enough" that the agent need not fetch Linear for the brief. */
export function taskBriefIsComplete(task: { description?: string; acceptanceCriteria?: string }): boolean {
  return Boolean(task.description?.trim() && task.acceptanceCriteria?.trim());
}
