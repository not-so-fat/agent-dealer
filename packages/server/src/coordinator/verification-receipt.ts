// packages/server/src/coordinator/verification-receipt.ts
//
// NOT-130: mine verification commands from a developer session log and persist a
// SHA-scoped receipt so an infra retry can carry "already green at this tip" evidence
// without a runtime-level `--resume`. A receipt never instructs the agent to skip — it
// is evidence. HEAD move (new commits after the checks) invalidates it automatically.
import { parseNdjsonFile } from "../runners/stream-json.js";

export const VERIFICATION_RECEIPT_KIND = "verification_receipt";

/**
 * A command segment is verification only when a runner invocation starts the segment
 * (start of string / after && || ; |), not when a keyword appears mid-line in `rg typecheck`.
 */
const VERIFICATION_SEGMENT_RE =
  /^(?:cd\s+\S+\s*(?:&&|;)\s+)*(?:npx\s+|pnpm\s+(?:exec\s+|run\s+)?|yarn\s+(?:run\s+)?|uv\s+run\s+)?(?:npm\s+test\b|npm\s+run\s+(?:test\b[\w:-]*|typecheck\b|flow:verify\b|poc:integration\b)|pytest\b|vitest\b|jest\b|node\s+--test\b)/i;

/**
 * Match real commit-shaped invocations, including `git -c … commit`, `git -C dir commit`,
 * and `git-yubikey-commit`. False positives that clear the receipt are safer than missing
 * a tip-changing command (which would pin a green suite to an unverified tip).
 */
const HEAD_CHANGING_RE =
  /\bgit(?:-[a-z0-9-]+)?\b[^;&|\n]*\b(?:commit|amend|rebase|reset|merge|cherry-pick|revert|pull|checkout|apply|am)\b/i;

const REV_PARSE_HEAD_RE = /\bgit(?:\s+-C\s+\S+)?\s+rev-parse\s+HEAD\b/i;
const FULL_SHA_RE = /\b([0-9a-f]{40})\b/i;

/** Prefer runner-shaped counts over a bare n/m (dates, coverage ratios, progress). */
const DETAIL_PATTERNS: Array<{ re: RegExp; format: (m: RegExpMatchArray) => string | undefined }> = [
  {
    re: /#\s*pass\s+(\d+)/i,
    format: (m) => `${m[1]} passed`,
  },
  {
    re: /(\d+)\s+passed,\s*(\d+)\s+total/i,
    format: (m) => `${m[1]}/${m[2]}`,
  },
  {
    re: /Tests?\s+(\d+)\s+passed/i,
    format: (m) => `${m[1]} passed`,
  },
  {
    re: /(\d+)\s+passed(?:ing)?\b/i,
    format: (m) => `${m[1]} passed`,
  },
  {
    re: /(\d+)\s*\/\s*(\d+)\s+tests?\s+passed/i,
    format: (m) => `${m[1]}/${m[2]}`,
  },
];

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
  return command
    .split(/(?:&&|\|\||;|\|)/)
    .some((seg) => VERIFICATION_SEGMENT_RE.test(seg.trim()));
}

/**
 * Carry a prior receipt only for interrupted / crashed style retries — not when the job
 * is to reproduce a CI/check failure at this same SHA (checks_failed).
 */
export function shouldCarryVerificationReceipt(retryReason: string | null | undefined): boolean {
  if (!retryReason?.trim()) return false;
  if (/PR checks failed|checks failed/i.test(retryReason)) return false;
  return true;
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
  for (const { re, format } of DETAIL_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const detail = format(m);
    if (detail) return detail;
  }
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

/** Every Bash/Shell tool_use in an assistant event (parallel batches included). */
function claudeBashCommands(e: Record<string, unknown>): Array<{ id: string; command: string }> {
  if (e.type !== "assistant") return [];
  const msg = e.message as
    | { content?: Array<{ type?: string; id?: string; name?: string; input?: { command?: string } }> }
    | undefined;
  const out: Array<{ id: string; command: string }> = [];
  for (const c of msg?.content ?? []) {
    if (c.type === "tool_use" && (c.name === "Bash" || c.name === "Shell") && c.id && c.input?.command) {
      out.push({ id: c.id, command: c.input.command });
    }
  }
  return out;
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
  if (!logPath) return null;
  let events: Record<string, unknown>[];
  try {
    events = parseNdjsonFile(logPath);
  } catch {
    return null;
  }
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
    for (const bash of claudeBashCommands(e)) {
      pendingBash.set(bash.id, bash.command);
    }

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
  // When only headShaHint is available, it is safe iff no HEAD-changing command ran after
  // the last verification (those clear byCommand, so we would not reach a receipt here).

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

/**
 * CI already rejected this tip — a later crash/timeout retry at the same SHA must not
 * re-inject "do not re-run an unchanged green suite" (class: ci-rejected-local-green).
 */
export function receiptSupersededByFailedChecks(
  receipt: VerificationReceipt,
  checksEvidence: { snapshot?: unknown; headSha?: unknown } | null | undefined
): boolean {
  if (!checksEvidence || checksEvidence.snapshot !== "failure") return false;
  if (typeof checksEvidence.headSha !== "string" || !checksEvidence.headSha.trim()) return false;
  return checksEvidence.headSha.trim().toLowerCase() === receipt.headSha.toLowerCase();
}

function receiptIsUniformlyGreen(receipt: VerificationReceipt): boolean {
  return receipt.commands.length > 0 && receipt.commands.every((c) => c.outcome === "passed");
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
  if (receiptIsUniformlyGreen(receipt)) {
    lines.push(
      `This is evidence, not an instruction to skip — re-run anything you doubt. Do not re-run an unchanged green suite by default.`
    );
  } else {
    lines.push(
      `This is evidence, not an instruction to skip — re-run anything you doubt. Treat only commands marked passed as already green; re-check failed or unknown ones.`
    );
  }
  lines.push(``);
  return lines;
}
