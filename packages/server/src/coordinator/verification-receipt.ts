// packages/server/src/coordinator/verification-receipt.ts
//
// NOT-130: mine verification commands from a developer session log and persist a
// SHA-scoped receipt so an infra retry can carry "already green at this tip" evidence
// without a runtime-level `--resume`. A receipt never instructs the agent to skip — it
// is evidence. HEAD move (new commits after the checks) invalidates it automatically.
import fs from "node:fs";
import { parseNdjson } from "../runners/stream-json.js";

export const VERIFICATION_RECEIPT_KIND = "verification_receipt";

/** Aligns with session-progress `isTestCommand` — suite / typecheck / flow gates. */
const VERIFICATION_COMMAND_RE =
  /pytest|npm test|npm run test|vitest|jest|node --test|flow:verify|typecheck|poc:integration|test:unit|test:ci/i;

const HEAD_CHANGING_RE =
  /\bgit\s+(?:commit|amend|rebase|reset|merge|cherry-pick|revert|pull|checkout)\b/i;

const REV_PARSE_HEAD_RE = /\bgit\s+rev-parse\s+HEAD\b/i;
const FULL_SHA_RE = /\b([0-9a-f]{40})\b/i;
const DETAIL_RE =
  /(\d+)\s*\/\s*(\d+)|(\d+)\s+(?:passed|passing)|tests?\s*[:=]?\s*(\d+)\s+passed/i;

export type VerificationOutcome = "passed" | "failed" | "unknown";

export interface VerificationCommandResult {
  command: string;
  outcome: VerificationOutcome;
  /** Compact parseable note when available, e.g. "711/711". */
  detail?: string;
}

export interface VerificationReceipt {
  headSha: string;
  commands: VerificationCommandResult[];
  recordedAt: string;
}

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_COMMAND_RE.test(command);
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

function outcomeFromClaudeResult(isError: boolean | undefined, text: string): VerificationOutcome {
  if (isError === true) return "failed";
  if (/exit code[:\s]+[1-9]\d*/i.test(text)) return "failed";
  if (isError === false) return "passed";
  if (/exit code[:\s]+0\b/i.test(text)) return "passed";
  return "unknown";
}

function outcomeFromExitCode(exitCode: number | null | undefined): VerificationOutcome {
  if (typeof exitCode !== "number") return "unknown";
  return exitCode === 0 ? "passed" : "failed";
}

function detailFromOutput(text: string): string | undefined {
  const m = text.match(DETAIL_RE);
  if (!m) return undefined;
  if (m[1] && m[2]) return `${m[1]}/${m[2]}`;
  if (m[3]) return `${m[3]} passed`;
  if (m[4]) return `${m[4]} passed`;
  return undefined;
}

function cursorShellEntry(
  e: Record<string, unknown>
): { command: string; exitCode?: number; output: string; completed: boolean } | null {
  if (e.type !== "tool_call") return null;
  const nested = e.tool_call;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const shell = (nested as { shellToolCall?: unknown }).shellToolCall;
  if (!shell || typeof shell !== "object") return null;
  const args = (shell as { args?: { command?: unknown } }).args;
  const command = typeof args?.command === "string" ? args.command : "";
  if (!command) return null;
  const subtype = typeof e.subtype === "string" ? e.subtype : "";
  const result = (shell as { result?: Record<string, unknown> }).result;
  let exitCode: number | undefined;
  let output = "";
  if (result && typeof result === "object") {
    if (typeof result.exitCode === "number") exitCode = result.exitCode;
    else if (typeof result.exit_code === "number") exitCode = result.exit_code;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    output = [stdout, stderr].filter(Boolean).join("\n");
  }
  return {
    command,
    exitCode,
    output,
    completed: subtype === "completed" || result != null,
  };
}

function claudeBashCommand(e: Record<string, unknown>): { id: string; command: string } | null {
  if (e.type !== "assistant") return null;
  const msg = e.message as
    | { content?: Array<{ type?: string; id?: string; name?: string; input?: { command?: string } }> }
    | undefined;
  for (const c of msg?.content ?? []) {
    if (c.type === "tool_use" && (c.name === "Bash" || c.name === "Shell") && c.id && c.input?.command) {
      return { id: c.id, command: c.input.command };
    }
  }
  return null;
}

function claudeToolResults(
  e: Record<string, unknown>
): Array<{ toolUseId: string; isError?: boolean; text: string }> {
  if (e.type !== "user") return [];
  const msg = e.message as
    | {
        content?: Array<{
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: unknown;
        }>;
      }
    | undefined;
  const out: Array<{ toolUseId: string; isError?: boolean; text: string }> = [];
  for (const c of msg?.content ?? []) {
    if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
    out.push({
      toolUseId: c.tool_use_id,
      isError: typeof c.is_error === "boolean" ? c.is_error : undefined,
      text: toolResultText(c.content),
    });
  }
  return out;
}

/**
 * Walk a session NDJSON log and build a receipt when at least one verification command
 * completed and we can pin it to a branch SHA that still matches the tip.
 *
 * `headShaHint` is the worktree's `git rev-parse HEAD` at persist time — used when the
 * agent never printed a SHA, and as a gate that the tip has not moved past the checks.
 */
export function extractVerificationReceiptFromLog(
  logPath: string,
  opts?: { headShaHint?: string | null; now?: () => string }
): VerificationReceipt | null {
  if (!logPath || !fs.existsSync(logPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  const events = parseNdjson(raw);
  if (!events.length) return null;

  let observedHead: string | null = null;
  const pendingBash = new Map<string, string>();
  /** Last result per normalized command; cleared when HEAD-changing git runs. */
  const byCommand = new Map<string, VerificationCommandResult>();

  const applyShellCompleted = (command: string, outcome: VerificationOutcome, output: string) => {
    const normalized = normalizeCommand(command);
    if (!normalized) return;
    const changesHead = HEAD_CHANGING_RE.test(normalized);
    const isVerify = isVerificationCommand(normalized);
    // Compound `npm test && git commit` (or the reverse) is ambiguous — refuse to vouch.
    if (changesHead && isVerify) {
      byCommand.clear();
      observedHead = null;
      return;
    }
    if (changesHead) {
      // New tip — prior suite results no longer vouch for HEAD.
      byCommand.clear();
      observedHead = null;
    }
    if (REV_PARSE_HEAD_RE.test(normalized)) {
      const m = output.trim().match(FULL_SHA_RE);
      if (m) observedHead = m[1]!.toLowerCase();
    }
    if (!isVerify) return;
    const detail = detailFromOutput(output);
    byCommand.set(normalized, {
      command: normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized,
      outcome,
      ...(detail ? { detail } : {}),
    });
  };

  for (const e of events) {
    const bash = claudeBashCommand(e);
    if (bash) pendingBash.set(bash.id, bash.command);

    for (const result of claudeToolResults(e)) {
      const command = pendingBash.get(result.toolUseId);
      if (!command) continue;
      pendingBash.delete(result.toolUseId);
      applyShellCompleted(command, outcomeFromClaudeResult(result.isError, result.text), result.text);
    }

    const shell = cursorShellEntry(e);
    if (shell?.completed) {
      applyShellCompleted(shell.command, outcomeFromExitCode(shell.exitCode), shell.output);
    }
  }

  const commands = [...byCommand.values()];
  if (!commands.length) return null;
  // Only persist when something actually passed — a failed suite is not evidence to skip.
  if (!commands.some((c) => c.outcome === "passed")) return null;

  const hint = opts?.headShaHint?.trim().toLowerCase() || null;
  const headSha = (observedHead ?? hint)?.toLowerCase() ?? null;
  if (!headSha || !FULL_SHA_RE.test(headSha)) return null;
  // Tip moved after the checks (or agent never re-verified after committing).
  if (hint && observedHead && hint !== observedHead) return null;
  if (hint && !observedHead) {
    // Safe: no HEAD-changing command after the last verification (those clear byCommand).
  }

  return {
    headSha,
    commands,
    recordedAt: (opts?.now ?? (() => new Date().toISOString()))(),
  };
}

export function parseVerificationReceipt(content: unknown): VerificationReceipt | null {
  if (!content || typeof content !== "object") return null;
  const raw = content as {
    headSha?: unknown;
    commands?: unknown;
    recordedAt?: unknown;
  };
  if (typeof raw.headSha !== "string" || !FULL_SHA_RE.test(raw.headSha)) return null;
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) return null;
  const commands: VerificationCommandResult[] = [];
  for (const c of raw.commands) {
    if (!c || typeof c !== "object") continue;
    const row = c as { command?: unknown; outcome?: unknown; detail?: unknown };
    if (typeof row.command !== "string" || !row.command.trim()) continue;
    const outcome =
      row.outcome === "passed" || row.outcome === "failed" || row.outcome === "unknown"
        ? row.outcome
        : "unknown";
    commands.push({
      command: row.command,
      outcome,
      ...(typeof row.detail === "string" && row.detail.trim() ? { detail: row.detail.trim() } : {}),
    });
  }
  if (!commands.length) return null;
  return {
    headSha: raw.headSha.toLowerCase(),
    commands,
    recordedAt: typeof raw.recordedAt === "string" ? raw.recordedAt : new Date(0).toISOString(),
  };
}

/** Null when missing or when HEAD has moved since the receipt was recorded. */
export function receiptForCurrentHead(
  receipt: VerificationReceipt | null | undefined,
  currentHeadSha: string | null | undefined
): VerificationReceipt | null {
  if (!receipt || !currentHeadSha) return null;
  if (receipt.headSha.toLowerCase() !== currentHeadSha.trim().toLowerCase()) return null;
  return receipt;
}

/** Prompt lines under ## Previous attempt — evidence only. */
export function formatVerificationReceiptSection(receipt: VerificationReceipt): string[] {
  const short = receipt.headSha.slice(0, 8);
  const lines = [
    `### Prior verification receipt`,
    `At \`${short}\` (\`${receipt.headSha}\`), HEAD is unchanged. Prior session evidence:`,
  ];
  for (const c of receipt.commands) {
    const detail = c.detail ? ` (${c.detail})` : "";
    lines.push(`- \`${c.command}\` ${c.outcome}${detail}`);
  }
  lines.push(
    `This is evidence, not an instruction to skip — re-run anything you doubt. Do not re-run an unchanged green suite by default.`,
    ``
  );
  return lines;
}
