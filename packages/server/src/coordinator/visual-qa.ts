// packages/server/src/coordinator/visual-qa.ts
//
// NOT-381: runtime-aware developer visual QA with SHA-bound receipts.
//
// NOT-303 proved `Google Chrome.app` headless aborts inside the Muse sandbox and
// shipped a Muse-specific preflight (`adapters/muse-visual-qa.ts`) whose explicit
// non-goal was changing how Claude Code, Codex Local, or Cursor run Chrome. A
// Claude Code takeover then demonstrated the preferred capable-runtime path: run the
// branch's real backend and frontend without mocks, drive headless Chrome, and
// inspect the actual UI at desktop and mobile viewports. This module makes that the
// normal Dealer developer behavior when the runtime supports it while preserving
// the Muse fallback untouched:
//
// - `developerVisualQaPolicy` resolves the runtime to the Muse preflight or the
//   capable-runtime section (`capableDeveloperVisualQaPromptSection`). Only
//   `muse_code` takes the Muse path; every other runtime attempts one bounded
//   in-session probe and reports a structured receipt. Unknown runtimes default
//   to capable: the probe degrades gracefully to `unavailable`, so a wrong
//   default costs one probe, never a missed verification.
// - `parseVisualQaReceipt` reads the structured `Visual QA:` block from the
//   implementation conclusion (status, HEAD SHA, real-app/mocks declaration,
//   scenario, viewports, commands, screenshots; `capability` for unavailable).
// - `collectDeveloperVisualQa` validates a `verified` receipt against the exact
//   developer handoff SHA, copies accepted screenshots into Dealer-owned storage,
//   removes the transient worktree directory, and persists the receipt plus blob
//   references. Rejections persist a loud `visual_qa_rejected` record and never
//   block the handoff: visual QA is evidence for review, not a gate (gates stay
//   CI/operator), so a bad receipt must not burn another implementation round.
// - `readLatestVisualQa` + `visualQaReviewerSection` carry the validated receipt
//   into the reviewer input, SHA-checked against the pinned head. An unavailable
//   receipt is never presented as a verification.
//
// Out of scope (see ticket non-goals): reviewer-side browsers, CI/operator
// verification changes, pixel diffs, cross-browser testing, committing screenshots
// to the product repository.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Runtime } from "@agent-dealer/shared";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { getVisualQaDir } from "../paths.js";

/** Worktree-relative directory carrying the worker's screenshots (transient). */
export const VISUAL_QA_DIR_NAME = ".agent-dealer-visual-qa";
/** Root-anchored git info/exclude pattern: screenshots never dirty the tree, never
 * get salvaged into a commit, and never reach the product repository. */
export const VISUAL_QA_EXCLUDE_LINE = "/.agent-dealer-visual-qa/";

/** Persisted kind for an accepted visual-QA receipt (any status). */
export const VISUAL_QA_RECEIPT_KIND = "visual_qa_receipt";
/** Persisted kind for a loudly rejected receipt (fail-loud evidence, not a gate). */
export const VISUAL_QA_REJECTED_KIND = "visual_qa_rejected";

/** Default viewports when the ticket states none: desktop + mobile. */
export const DEFAULT_VISUAL_QA_VIEWPORTS = ["1440x900", "390x800"] as const;

/** Per-screenshot storage cap — a bounded guard, not a quality bar. */
export const MAX_VISUAL_QA_FILE_BYTES = 25 * 1024 * 1024;

/** Screenshot extensions the collector accepts (case-insensitive). */
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const VIEWPORT_RE = /^(\d+)x(\d+)$/;

export type VisualQaStatus = "verified" | "unavailable" | "not_required";

/** Which developer guidance a runtime gets: the Muse preflight or the
 * capable-runtime in-session attempt. */
export type DeveloperVisualQaPolicy = "muse" | "capable";

export function developerVisualQaPolicy(runtime: Runtime | string | null | undefined): DeveloperVisualQaPolicy {
  return runtime === "muse_code" ? "muse" : "capable";
}

/**
 * Worker-prompt section for browser-capable runtimes (Claude Code, Codex Local,
 * Cursor Local). One bounded probe, then the real application — never the
 * blanket no-browser assumption, and never an install/retry/sandbox-weakening
 * loop: the sandbox has no network and a failed capability is reported once.
 */
export function capableDeveloperVisualQaPromptSection(): string[] {
  return [
    `## Visual QA (in-session browser verification)`,
    `This runtime can usually launch a headless browser and serve the app on loopback — verify UI-visible work in-session instead of assuming visual QA is unavailable.`,
    `- First run ONE bounded capability probe: launch headless Chromium once (for example \`chromium --headless --screenshot=/tmp/dealer-visual-probe.png --window-size=800,600 about:blank\`, or the runtime's installed equivalent) and confirm the app can listen on loopback. If either fails, stop: do not install browsers or packages (no network), do not retry the failed capability, and do not weaken any sandbox flag to force a launch — report \`unavailable\` with the concrete failed capability instead.`,
    `- When capable, run the REAL backend and frontend from this worktree at the current HEAD and exercise the affected interaction, not just a static route. Use mocks only when an acceptance criterion explicitly permits them, and say so in the receipt.`,
    `- Capture the ticket's stated viewports, or desktop \`1440x900\` and mobile \`390x800\` by default. Save PNGs under \`.agent-dealer-visual-qa/\` (for example \`.agent-dealer-visual-qa/desktop-1440x900.png\`). The coordinator collects and deletes this directory — never commit it.`,
    `- A new commit invalidates earlier rendered evidence: capture at the final HEAD and name it in the receipt (\`git rev-parse HEAD\`).`,
    `End your implementation conclusion with a structured \`Visual QA:\` receipt block: \`Visual QA: verified\` plus \`head:\`, \`app:\`, \`scenario:\`, \`viewports:\`, \`commands:\`, \`screenshots:\` lines (screenshot paths relative to the worktree root, inside \`.agent-dealer-visual-qa/\`); or \`Visual QA: unavailable\` plus \`capability:\` naming the one concrete failed capability (browser launch, loopback listen, or another concrete failure); or \`Visual QA: not_required\` when the change has no UI-visible surface.`,
    ``,
  ];
}

/** A parsed `Visual QA:` block. Null fields were absent (or unparseable for
 * headSha/viewports — see headRaw/viewportsRaw); validation decides what a
 * status requires. */
export interface ParsedVisualQaReceipt {
  status: VisualQaStatus;
  /** Lowercased 40-hex SHA, or null when absent/invalid. */
  headSha: string | null;
  /** The `head:` value as written, for error messages. */
  headRaw: string | null;
  /** Real-app/mocks declaration (`app:`). */
  realApp: string | null;
  /** Scenario/path exercised (`scenario:` / `path:`). */
  scenario: string | null;
  /** Normalized `WxH` viewports. */
  viewports: string[];
  /** The `viewports:` value as written, for error messages. */
  viewportsRaw: string | null;
  /** Commands summary (`commands:` / `command:`). */
  commands: string | null;
  /** Declared screenshot paths as written (`screenshots:` / `screenshot:`). */
  screenshots: string[];
  /** Failed capability (`capability:`), unavailable only. */
  capability: string | null;
  /** Optional free note (`note:` / `reason:`). */
  note: string | null;
}

export type VisualQaParse =
  | { found: false }
  | { found: true; receipt: ParsedVisualQaReceipt; error: null }
  | { found: true; receipt: null; error: string };

const STATUS_LINE_RE = /^\s*visual qa\s*:\s*(.+?)\s*$/i;
const FIELD_LINE_RE =
  /^\s*(head|sha|app|scenario|path|viewports?|commands?|screenshots?|capability|note|reason)\s*:\s*(.*?)\s*$/i;
const BLOCK_END_RE = /^\s*(#{1,6}\s|```)/;

function normalizeStatus(token: string): VisualQaStatus | null {
  const t = token.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (t === "verified") return "verified";
  if (t === "unavailable") return "unavailable";
  if (t === "not required") return "not_required";
  // Legacy Muse line (`Visual QA: not run (<reason>)`) — the incapable-runtime
  // report, normalized to unavailable (never to a pass).
  if (t === "not run") return "unavailable";
  return null;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((p) => p.trim().replace(/^`+|`+$/g, "").replace(/^"+|"+$/g, "").trim())
    .filter((p) => p.length > 0);
}

/**
 * Parse the LAST `Visual QA:` block in the conclusion (a worker that corrects
 * itself wins). Fields are `key: value` lines after the status line until a
 * markdown heading/fence or the end; unknown lines are ignored, last key wins.
 * No `Visual QA:` line → `{ found: false }` (status quo, not an error).
 */
export function parseVisualQaReceipt(conclusion: string): VisualQaParse {
  const lines = conclusion.split(/\r?\n/);
  let statusIndex = -1;
  let statusText = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(STATUS_LINE_RE);
    if (m) {
      statusIndex = i;
      statusText = m[1]!.trim();
    }
  }
  if (statusIndex < 0) return { found: false };

  // `Visual QA: not run (<reason>)` / `unavailable (<reason>)` carry the failed
  // capability inline; legacy `verified (<png>, exit <code>)` carries no fields.
  let token = statusText;
  let inline: string | null = null;
  const paren = statusText.match(/^([^()]+?)\s*\((.+)\)\s*$/);
  if (paren) {
    token = paren[1]!.trim();
    inline = paren[2]!.trim() || null;
  }
  const status = normalizeStatus(token);
  if (!status) {
    return {
      found: true,
      receipt: null,
      error: `unknown Visual QA status "${token}" (expected verified, unavailable, or not_required)`,
    };
  }

  const fields = new Map<string, string>();
  for (let i = statusIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (BLOCK_END_RE.test(line)) break;
    const m = line.match(FIELD_LINE_RE);
    if (m) fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  const get = (...names: string[]): string | null => {
    for (const n of names) {
      const v = fields.get(n);
      if (v !== undefined && v.length > 0) return v;
    }
    return null;
  };

  const headRaw = get("head", "sha");
  const headSha = headRaw && FULL_SHA_RE.test(headRaw.toLowerCase()) ? headRaw.toLowerCase() : null;
  const viewportsRaw = get("viewports", "viewport");
  const viewports = viewportsRaw
    ? splitList(viewportsRaw)
        .map((v) => v.toLowerCase())
        .filter((v) => VIEWPORT_RE.test(v))
    : [];
  const screenshotsRaw = get("screenshots", "screenshot");
  const capabilityField = get("capability");
  // The inline parenthetical is the failed capability for unavailable/not-run;
  // otherwise it is a free note (e.g. legacy `verified (<png>, exit 0)`).
  const capability =
    status === "unavailable" ? (capabilityField ?? inline) : capabilityField;
  const note = get("note", "reason") ?? (status === "unavailable" ? null : inline);

  return {
    found: true,
    receipt: {
      status,
      headSha,
      headRaw,
      realApp: get("app"),
      scenario: get("scenario", "path"),
      viewports,
      viewportsRaw,
      commands: get("commands", "command"),
      screenshots: screenshotsRaw ? splitList(screenshotsRaw) : [],
      capability,
      note,
    },
    error: null,
  };
}

export interface ValidateVisualQaOpts {
  /** The coordinator-verified developer handoff SHA the receipt must name. */
  expectedHeadSha: string;
  /** Managed worktree root the screenshot paths resolve against. */
  worktreePath: string;
}

export type VisualQaValidation = { ok: true } | { ok: false; reason: string };

const invalid = (reason: string): VisualQaValidation => ({ ok: false, reason });

/**
 * Validate a parsed receipt. A `verified` receipt must name the exact handoff
 * SHA and every screenshot must be a regular file inside the dedicated
 * worktree directory — symlinks, path escapes, and missing files fail loudly.
 * `unavailable` must name one concrete failed capability; `not_required`
 * requires nothing and never collects screenshots.
 */
export function validateVisualQaReceipt(
  receipt: ParsedVisualQaReceipt,
  opts: ValidateVisualQaOpts
): VisualQaValidation {
  if (receipt.status === "not_required") return { ok: true };
  if (receipt.status === "unavailable") {
    if (!receipt.capability) {
      return invalid(
        "unavailable Visual QA receipt names no failed capability (capability: browser launch, loopback listen, or another concrete failure)"
      );
    }
    return { ok: true };
  }

  // Verified: every field is required, and the SHA must bind exactly.
  if (!receipt.headRaw) return invalid("verified Visual QA receipt names no HEAD SHA (head: <40-hex>)");
  if (!receipt.headSha) {
    return invalid(`verified Visual QA receipt names an invalid HEAD SHA ("${receipt.headRaw}")`);
  }
  const expected = opts.expectedHeadSha.trim().toLowerCase();
  if (receipt.headSha !== expected) {
    return invalid(
      `verified Visual QA receipt is bound to ${receipt.headSha.slice(0, 8)} but the developer handoff is ${expected.slice(0, 8)}`
    );
  }
  if (!receipt.realApp) {
    return invalid("verified Visual QA receipt declares no real-app/mocks statement (app: real ...)");
  }
  if (!receipt.scenario) {
    return invalid("verified Visual QA receipt names no scenario/path (scenario: <route + interaction>)");
  }
  if (receipt.viewports.length === 0) {
    const raw = receipt.viewportsRaw ? ` ("${receipt.viewportsRaw}")` : "";
    return invalid(`verified Visual QA receipt names no viewport sizes${raw} (viewports: 1440x900, 390x800)`);
  }
  if (!receipt.commands) {
    return invalid("verified Visual QA receipt names no commands summary (commands: <app + capture commands>)");
  }
  if (receipt.screenshots.length === 0) {
    return invalid(
      `verified Visual QA receipt names no screenshot files (screenshots: ${VISUAL_QA_DIR_NAME}/<name>.png, ...)`
    );
  }

  const visualDir = path.resolve(opts.worktreePath, VISUAL_QA_DIR_NAME);
  for (const declared of receipt.screenshots) {
    if (!declared || declared.trim().length === 0) {
      return invalid("verified Visual QA receipt names an empty screenshot path");
    }
    if (path.isAbsolute(declared)) {
      return invalid(`verified Visual QA receipt names an absolute screenshot path, refusing: "${declared}"`);
    }
    const resolved = path.resolve(opts.worktreePath, declared);
    if (resolved !== visualDir && !resolved.startsWith(visualDir + path.sep)) {
      return invalid(
        `verified Visual QA receipt screenshot escapes the visual-artifact directory, refusing: "${declared}"`
      );
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(resolved);
    } catch {
      return invalid(`verified Visual QA receipt screenshot is missing: "${declared}"`);
    }
    if (st.isSymbolicLink()) {
      return invalid(`verified Visual QA receipt screenshot is a symlink, refusing: "${declared}"`);
    }
    if (!st.isFile()) {
      return invalid(`verified Visual QA receipt screenshot is not a regular file: "${declared}"`);
    }
    if (st.size === 0) {
      return invalid(`verified Visual QA receipt screenshot is empty: "${declared}"`);
    }
    if (st.size > MAX_VISUAL_QA_FILE_BYTES) {
      return invalid(
        `verified Visual QA receipt screenshot exceeds the ${MAX_VISUAL_QA_FILE_BYTES}-byte cap: "${declared}"`
      );
    }
    if (!SCREENSHOT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      return invalid(
        `verified Visual QA receipt screenshot has an unsupported extension (expected .png): "${declared}"`
      );
    }
  }
  return { ok: true };
}

export interface VisualQaScreenshotRef {
  fileName: string;
  blobPath: string;
  sizeBytes: number;
  sha256: string;
}

/** Content of a persisted `visual_qa_receipt` artifact. */
export interface VisualQaReceiptContent {
  status: VisualQaStatus;
  headSha: string | null;
  realApp: string | null;
  scenario: string | null;
  viewports: string[];
  commands: string | null;
  screenshots: VisualQaScreenshotRef[];
  capability: string | null;
  note: string | null;
  recordedAt: string;
}

/** Content of a persisted `visual_qa_rejected` artifact — loud evidence. */
export interface VisualQaRejectedContent {
  status: VisualQaStatus | null;
  headSha: string | null;
  expectedHeadSha: string;
  reason: string;
  recordedAt: string;
}

export interface CollectVisualQaOpts {
  issueId: string;
  sessionId: string;
  worktreePath: string;
  /** The implementation conclusion text (already extracted from the transcript). */
  conclusion: string;
  /** The coordinator-verified handoff SHA (pushed local head). */
  expectedHeadSha: string;
  now?: () => string;
}

export type CollectVisualQaResult =
  | { kind: "none" }
  | { kind: "receipt"; artifactId: string; status: VisualQaStatus }
  | { kind: "rejected"; artifactId: string; reason: string };

function safeBlobBase(index: number, declared: string): string {
  const base = path.posix.basename(declared.replace(/\\/g, "/")) || `screenshot-${index}.png`;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || `screenshot-${index}.png`;
  return `${index}-${cleaned}`;
}

/**
 * Parse, validate, and persist the developer's visual-QA receipt. Accepted
 * screenshots are copied into Dealer-owned issue storage and the transient
 * worktree directory is removed; rejections are persisted loudly and the
 * handoff proceeds — a bad receipt is failed evidence, never a new round.
 */
export function collectDeveloperVisualQa(opts: CollectVisualQaOpts): CollectVisualQaResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const parsed = parseVisualQaReceipt(opts.conclusion);
  if (!parsed.found) return { kind: "none" };
  if (!parsed.receipt) {
    const art = createIssueArtifact({
      issueId: opts.issueId,
      workerSessionId: opts.sessionId,
      kind: VISUAL_QA_REJECTED_KIND,
      author: "system",
      content: {
        status: null,
        headSha: null,
        expectedHeadSha: opts.expectedHeadSha,
        reason: parsed.error,
        recordedAt: now(),
      } satisfies VisualQaRejectedContent,
    });
    return { kind: "rejected", artifactId: art.id, reason: parsed.error };
  }
  const receipt = parsed.receipt;

  if (receipt.status !== "verified") {
    const validation = validateVisualQaReceipt(receipt, opts);
    if (!validation.ok) {
      const art = createIssueArtifact({
        issueId: opts.issueId,
        workerSessionId: opts.sessionId,
        kind: VISUAL_QA_REJECTED_KIND,
        author: "system",
        content: {
          status: receipt.status,
          headSha: receipt.headSha,
          expectedHeadSha: opts.expectedHeadSha,
          reason: validation.reason,
          recordedAt: now(),
        } satisfies VisualQaRejectedContent,
      });
      return { kind: "rejected", artifactId: art.id, reason: validation.reason };
    }
    // not_required never collects screenshots, even when the worker names some.
    const art = createIssueArtifact({
      issueId: opts.issueId,
      workerSessionId: opts.sessionId,
      kind: VISUAL_QA_RECEIPT_KIND,
      author: "agent",
      content: {
        status: receipt.status,
        headSha: receipt.headSha,
        realApp: receipt.realApp,
        scenario: receipt.scenario,
        viewports: receipt.viewports,
        commands: receipt.commands,
        screenshots: [],
        capability: receipt.capability,
        note: receipt.note,
        recordedAt: now(),
      } satisfies VisualQaReceiptContent,
    });
    return { kind: "receipt", artifactId: art.id, status: receipt.status };
  }

  const validation = validateVisualQaReceipt(receipt, opts);
  if (!validation.ok) {
    // Rejected files stay in the worktree for inspection — the directory is
    // git-excluded, so they can neither dirty the tree nor leak into a commit.
    const art = createIssueArtifact({
      issueId: opts.issueId,
      workerSessionId: opts.sessionId,
      kind: VISUAL_QA_REJECTED_KIND,
      author: "system",
      content: {
        status: receipt.status,
        headSha: receipt.headSha,
        expectedHeadSha: opts.expectedHeadSha,
        reason: validation.reason,
        recordedAt: now(),
      } satisfies VisualQaRejectedContent,
    });
    return { kind: "rejected", artifactId: art.id, reason: validation.reason };
  }

  // Accepted: copy into Dealer-owned storage, then remove the transient dir.
  const issueDir = path.join(getVisualQaDir(), opts.issueId);
  fs.mkdirSync(issueDir, { recursive: true });
  const refs: VisualQaScreenshotRef[] = [];
  const copied: string[] = [];
  try {
    receipt.screenshots.forEach((declared, i) => {
      const src = path.resolve(opts.worktreePath, declared);
      const fileName = safeBlobBase(i, declared);
      const dest = path.join(issueDir, `${opts.sessionId}-${fileName}`);
      fs.copyFileSync(src, dest);
      copied.push(dest);
      const bytes = fs.readFileSync(dest);
      refs.push({
        fileName,
        blobPath: dest,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    });
  } catch (err) {
    for (const p of copied) fs.rmSync(p, { force: true });
    const reason = `could not store Visual QA screenshots: ${err instanceof Error ? err.message : String(err)}`;
    const art = createIssueArtifact({
      issueId: opts.issueId,
      workerSessionId: opts.sessionId,
      kind: VISUAL_QA_REJECTED_KIND,
      author: "system",
      content: {
        status: receipt.status,
        headSha: receipt.headSha,
        expectedHeadSha: opts.expectedHeadSha,
        reason,
        recordedAt: now(),
      } satisfies VisualQaRejectedContent,
    });
    return { kind: "rejected", artifactId: art.id, reason };
  }
  fs.rmSync(path.resolve(opts.worktreePath, VISUAL_QA_DIR_NAME), { recursive: true, force: true });

  const art = createIssueArtifact({
    issueId: opts.issueId,
    workerSessionId: opts.sessionId,
    kind: VISUAL_QA_RECEIPT_KIND,
    author: "agent",
    content: {
      status: receipt.status,
      headSha: receipt.headSha,
      realApp: receipt.realApp,
      scenario: receipt.scenario,
      viewports: receipt.viewports,
      commands: receipt.commands,
      screenshots: refs,
      capability: receipt.capability,
      note: receipt.note,
      recordedAt: now(),
    } satisfies VisualQaReceiptContent,
  });
  return { kind: "receipt", artifactId: art.id, status: receipt.status };
}

export type VisualQaRecord =
  | { kind: "receipt"; content: VisualQaReceiptContent; createdAt: string }
  | { kind: "rejected"; content: VisualQaRejectedContent; createdAt: string };

function parseReceiptContent(raw: string | null): VisualQaReceiptContent | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<VisualQaReceiptContent>;
    if (c.status !== "verified" && c.status !== "unavailable" && c.status !== "not_required") return null;
    if (!Array.isArray(c.screenshots)) return null;
    return {
      status: c.status,
      headSha: typeof c.headSha === "string" ? c.headSha : null,
      realApp: typeof c.realApp === "string" ? c.realApp : null,
      scenario: typeof c.scenario === "string" ? c.scenario : null,
      viewports: Array.isArray(c.viewports) ? c.viewports.filter((v): v is string => typeof v === "string") : [],
      commands: typeof c.commands === "string" ? c.commands : null,
      screenshots: c.screenshots.filter(
        (s): s is VisualQaScreenshotRef =>
          !!s && typeof s === "object" && typeof (s as VisualQaScreenshotRef).blobPath === "string"
      ),
      capability: typeof c.capability === "string" ? c.capability : null,
      note: typeof c.note === "string" ? c.note : null,
      recordedAt: typeof c.recordedAt === "string" ? c.recordedAt : "",
    };
  } catch {
    return null;
  }
}

function parseRejectedContent(raw: string | null): VisualQaRejectedContent | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<VisualQaRejectedContent>;
    if (typeof c.reason !== "string" || !c.reason) return null;
    if (typeof c.expectedHeadSha !== "string" || !c.expectedHeadSha) return null;
    return {
      status: c.status === "verified" || c.status === "unavailable" || c.status === "not_required" ? c.status : null,
      headSha: typeof c.headSha === "string" ? c.headSha : null,
      expectedHeadSha: c.expectedHeadSha,
      reason: c.reason,
      recordedAt: typeof c.recordedAt === "string" ? c.recordedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * The newest visual-QA record of either kind for the issue (a repair round's
 * receipt supersedes an earlier round's; a same-millisecond tie prefers the
 * rejection, the louder record). Null when no attempt reported visual QA.
 */
export function readLatestVisualQa(issueId: string): VisualQaRecord | null {
  const receiptArt = latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND);
  const rejectedArt = latestIssueArtifact(issueId, VISUAL_QA_REJECTED_KIND);
  const receipt = parseReceiptContent(receiptArt?.contentJson ?? null);
  const rejected = parseRejectedContent(rejectedArt?.contentJson ?? null);
  if (receipt && receiptArt && rejected && rejectedArt) {
    return rejectedArt.createdAt >= receiptArt.createdAt
      ? { kind: "rejected", content: rejected, createdAt: rejectedArt.createdAt }
      : { kind: "receipt", content: receipt, createdAt: receiptArt.createdAt };
  }
  if (rejected && rejectedArt) return { kind: "rejected", content: rejected, createdAt: rejectedArt.createdAt };
  if (receipt && receiptArt) return { kind: "receipt", content: receipt, createdAt: receiptArt.createdAt };
  return null;
}

/**
 * Reviewer-prompt section for the validated visual receipt, SHA-checked against
 * the pinned head. A receipt bound to another head is stale evidence, never
 * verification of this head; an unavailable receipt is a routing state, never
 * a pass. Null renders nothing so receipt-free reviews stay byte-for-byte.
 */
export function visualQaReviewerSection(record: VisualQaRecord | null, pinnedHeadSha: string): string[] {
  if (!record) return [];
  const pinned = pinnedHeadSha.trim().toLowerCase();
  if (record.kind === "rejected") {
    const expected = record.content.expectedHeadSha.trim().toLowerCase();
    if (expected !== pinned) {
      return [
        `## Visual QA (superseded rejection — not this head)`,
        `A prior attempt's Visual QA receipt was rejected (${record.content.reason}) for head \`${record.content.expectedHeadSha.slice(0, 8)}\`, not the pinned head \`${pinnedHeadSha.slice(0, 8)}\`. Judge this head's visual evidence on its own.`,
        ``,
      ];
    }
    return [
      `## Visual QA (INVALID receipt — the claimed verification is rejected)`,
      `The developer claimed visual verification for this head, but the coordinator rejected the receipt: ${record.content.reason}. Judge this head as if no visual evidence exists — a rejected receipt is never verification.`,
      ``,
    ];
  }

  const c = record.content;
  const bound = c.headSha?.trim().toLowerCase() || null;
  if (c.status === "verified") {
    if (!bound || bound !== pinned) {
      return [
        `## Visual QA (stale receipt — not this head)`,
        `The developer verified rendered UI at \`${(c.headSha ?? "unknown").slice(0, 8)}\`, not the pinned head \`${pinnedHeadSha.slice(0, 8)}\`. A new commit invalidates earlier rendered evidence — do not treat this as verification of the pinned head.`,
        ``,
      ];
    }
    const lines = [
      `## Visual QA (developer receipt — SHA-bound to this head)`,
      `The developer's coordinator-validated receipt names this exact head. Treat it as evidence for the UI-visible criteria — not as your own verification: you still review the code. The screenshots are archived as Dealer blobs (you cannot view them); judge the binding, the real-app declaration, and whether the scenario covers the UI-visible acceptance criteria.`,
      ``,
      `- status: verified at \`${c.headSha}\``,
      `- app: ${c.realApp ?? "(undeclared)"}`,
      `- scenario: ${c.scenario ?? "(undeclared)"}`,
      `- viewports: ${c.viewports.length ? c.viewports.join(", ") : "(undeclared)"}`,
      `- commands: ${c.commands ?? "(undeclared)"}`,
    ];
    if (c.screenshots.length > 0) {
      lines.push(`- screenshots (${c.screenshots.length} archived):`);
      for (const s of c.screenshots) {
        lines.push(`  - ${s.fileName} (${s.sizeBytes.toLocaleString("en-US")} bytes, sha256:${s.sha256.slice(0, 16)}…)`);
      }
    }
    if (c.note) lines.push(`- note: ${c.note}`);
    lines.push(``);
    return lines;
  }

  if (c.status === "unavailable") {
    return [
      `## Visual QA (UNAVAILABLE — not verified)`,
      `The developer runtime could not produce rendered evidence in-session. Failed capability: ${c.capability ?? "(undeclared)"}. This is a verification-routing state, never a pass: judge UI-visible criteria from the code and route rendered verification to CI or operator evidence. Missing runtime capability is not itself a defect.`,
      ``,
    ];
  }

  return [
    `## Visual QA (not required — no UI-visible surface claimed)`,
    `The developer reported this change has no UI-visible surface. If you find UI-visible effects, the receipt is wrong: missing visual evidence for UI-visible acceptance criteria is a blocking finding per the screenshot rule in the verdict contract.`,
    ``,
  ];
}
