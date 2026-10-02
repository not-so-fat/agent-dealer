// packages/server/src/coordinator/playbook-feedback.ts
//
// NOT-305: Dealer-side playbook-use receipts and failure/correction signals to Deck.
//
// Product boundary (NOT-162): Dealer owns worker/run correlation, durable workflow
// evidence, outcomes, review findings, human retry feedback, and the decision that a
// failure report exists. Deck owns feedback-signal storage, curation, playbook
// attribution, patch proposals, and accepted playbook content. Dealer never synthesizes
// a playbook edit and never attributes a failure to one playbook.
//
// Two durable artifacts, both idempotent across retries/restarts:
//
// - `playbook_use_receipt`: one per terminal worker session, naming exactly the
//   playbooks Deck observed that session fetch (via the NOT-304 correlation seam),
//   plus collection status/error. Never stores prompts, tool arguments/results,
//   repository names, or issue descriptions — only the fields the design names.
// - `deck_feedback_signal`: one per failure/correction trigger (human retry,
//   attempts exhaustion, recurring blocking finding), sent to Deck as a `signal_only`
//   feedback record with a deterministic source key. Clean runs record receipts only.
import { parseProfileSnapshot } from "@agent-dealer/shared";
import type { WorkerSession } from "@agent-dealer/shared";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { callDeckTool } from "../adapters/reflect-authority.js";
import type { AuthorizedDeckCallResult } from "../adapters/reflect-authority.js";
import { getIssue } from "../repository/issues.js";
import { getWorkerSession, listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { createIssueArtifact } from "../repository/artifacts.js";
import { listArtifactsForIssueByKind } from "../repository/artifacts-for-issue.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { listHumanActionsForIssue } from "../repository/human-actions.js";

const CORRELATION_TOOL_TIMEOUT_MS = 15_000;
const SIGNAL_TOOL_TIMEOUT_MS = 15_000;

/**
 * Bound, read-only Deck correlation operation (the NOT-304 seam): given the opaque
 * per-session correlation UUID Dealer passed in the launch configuration, returns the
 * playbooks Deck actually observed that session fetch. Dealer calls it; Deck owns the
 * usage stream and the attribution.
 */
export const DECK_CORRELATION_TOOL = "list_card_usage_by_correlation";

export const PLAYBOOK_USE_RECEIPT_KIND = "playbook_use_receipt";
export const DECK_FEEDBACK_SIGNAL_KIND = "deck_feedback_signal";

export type ReceiptStatus = "collected" | "skipped" | "error";

export interface PlaybookUseReceipt {
  workerSessionId: string;
  role: WorkerSession["role"];
  deckId: string | null;
  correlationId: string | null;
  runtime: string | null;
  model: string | null;
  /** Exactly the playbook IDs Deck observed this session fetch — never configured IDs. */
  playbookIds: string[];
  firstFetchedAt: string | null;
  lastFetchedAt: string | null;
  status: ReceiptStatus;
  reason?: string;
  error?: string;
}

export type DeckSignalTrigger = "human_retry" | "attempts_exhausted" | "recurring_blocking";

export interface PlaybookFeedbackDeps {
  checkHealth: typeof checkAgentDeckHealth;
  callTool: typeof callDeckTool;
}

const defaultDeps: PlaybookFeedbackDeps = {
  checkHealth: checkAgentDeckHealth,
  callTool: callDeckTool,
};

const TERMINAL_SESSION = new Set(["done", "failed", "timed_out", "cancelled"]);

function sessionDeckId(session: WorkerSession): string | null {
  return parseProfileSnapshot(session.profileSnapshotJson)?.deckId ?? null;
}

function parseReceiptContent(contentJson: string | null): PlaybookUseReceipt | null {
  if (!contentJson) return null;
  try {
    const parsed = JSON.parse(contentJson) as Partial<PlaybookUseReceipt>;
    if (typeof parsed.workerSessionId !== "string" || !Array.isArray(parsed.playbookIds)) return null;
    return parsed as PlaybookUseReceipt;
  } catch {
    return null;
  }
}

/** Latest receipt recorded for one session — readers take the latest; a retry after an
 * earlier `error`/`skipped` row appends a fresh row rather than rewriting history.
 * (`listArtifactsForIssueByKind` orders newest-first, so the first match wins.) */
export function latestReceiptForSession(issueId: string, workerSessionId: string): PlaybookUseReceipt | null {
  const rows = listArtifactsForIssueByKind(issueId, PLAYBOOK_USE_RECEIPT_KIND);
  for (const row of rows) {
    const receipt = parseReceiptContent(row.contentJson);
    if (receipt?.workerSessionId === workerSessionId) return receipt;
  }
  return null;
}

function recordReceipt(issueId: string, workerSessionId: string | null, receipt: PlaybookUseReceipt): PlaybookUseReceipt {
  createIssueArtifact({
    issueId,
    workerSessionId,
    kind: PLAYBOOK_USE_RECEIPT_KIND,
    author: "system",
    content: receipt,
  });
  return receipt;
}

interface CorrelatedFetch {
  playbookId: string;
  firstFetchedAt: string | null;
  lastFetchedAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Parses the NOT-304 correlation response tolerantly on envelope naming (Deck owns the
 * field names) but strictly on identity: every fetch must name a non-empty playbook ID
 * string, otherwise the whole response is malformed — guessing IDs would corrupt the
 * receipt. Returns null on malformed input.
 */
export function parseCorrelatedFetches(data: unknown): CorrelatedFetch[] | null {
  const root = asRecord(data);
  if (!root) return null;
  const raw = root.fetches ?? root.usage ?? root.cards;
  if (!Array.isArray(raw)) return null;
  const fetches: CorrelatedFetch[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) return null;
    const playbookId =
      asString(record.playbook_id) ?? asString(record.playbookId) ?? asString(record.id);
    if (!playbookId) return null;
    fetches.push({
      playbookId,
      firstFetchedAt:
        asString(record.first_fetched_at) ??
        asString(record.firstFetchedAt) ??
        asString(record.fetched_at) ??
        null,
      lastFetchedAt:
        asString(record.last_fetched_at) ??
        asString(record.lastFetchedAt) ??
        asString(record.fetched_at) ??
        null,
    });
  }
  return fetches;
}

function summarizeFetches(
  fetches: CorrelatedFetch[]
): { playbookIds: string[]; firstFetchedAt: string | null; lastFetchedAt: string | null } {
  const playbookIds: string[] = [];
  const seen = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  for (const fetch of fetches) {
    if (!seen.has(fetch.playbookId)) {
      seen.add(fetch.playbookId);
      playbookIds.push(fetch.playbookId);
    }
    for (const stamp of [fetch.firstFetchedAt, fetch.lastFetchedAt]) {
      if (!stamp) continue;
      if (first === null || stamp < first) first = stamp;
      if (last === null || stamp > last) last = stamp;
    }
  }
  return { playbookIds, firstFetchedAt: first, lastFetchedAt: last };
}

export type CollectReceiptResult =
  | { collected: true; receipt: PlaybookUseReceipt; duplicate: boolean }
  | { collected: false; reason: string };

/**
 * Records the actual-use receipt for one worker session. Never throws: Deck outages
 * and malformed responses become an `error`-status receipt (a visible, retryable
 * record), and non-terminal or unknown sessions return a reason without writing.
 * Idempotent: a `collected` receipt is returned as-is; an `error`/`skipped` row is
 * re-attempted and superseded by a fresh row, so a later trigger after a restart or
 * Deck recovery heals the gap without duplicating collected evidence.
 */
export async function collectPlaybookUseReceipt(
  workerSessionId: string,
  deps: PlaybookFeedbackDeps = defaultDeps
): Promise<CollectReceiptResult> {
  const session = getWorkerSession(workerSessionId);
  if (!session) return { collected: false, reason: "unknown worker session" };
  if (!TERMINAL_SESSION.has(session.status)) {
    return { collected: false, reason: "worker session is not terminal" };
  }

  const existing = latestReceiptForSession(session.issueId, workerSessionId);
  if (existing?.status === "collected") {
    return { collected: true, receipt: existing, duplicate: true };
  }

  const deckId = sessionDeckId(session);
  const base: PlaybookUseReceipt = {
    workerSessionId,
    role: session.role,
    deckId,
    correlationId: session.deckCorrelationId,
    runtime: session.runtime,
    model: session.model,
    playbookIds: [],
    firstFetchedAt: null,
    lastFetchedAt: null,
    status: "skipped",
  };
  if (!deckId) {
    return {
      collected: false,
      reason: recordReceipt(session.issueId, workerSessionId, {
        ...base,
        reason: "no deck in session profile snapshot — nothing to correlate",
      }).reason!,
    };
  }
  if (!session.deckCorrelationId) {
    return {
      collected: false,
      reason: recordReceipt(session.issueId, workerSessionId, {
        ...base,
        reason: "no deck correlation id on worker session — nothing to correlate",
      }).reason!,
    };
  }

  const healthy = await deps.checkHealth().catch(() => false);
  if (!healthy) {
    recordReceipt(session.issueId, workerSessionId, {
      ...base,
      status: "error",
      error: "Agent Deck offline — receipt collection retryable on a later trigger",
    });
    return { collected: false, reason: "Agent Deck offline" };
  }

  const correlated: AuthorizedDeckCallResult<unknown> = await deps.callTool({
    deckId,
    toolName: DECK_CORRELATION_TOOL,
    arguments: { correlation_id: session.deckCorrelationId },
    timeoutMs: CORRELATION_TOOL_TIMEOUT_MS,
  });
  if (!correlated.ok) {
    recordReceipt(session.issueId, workerSessionId, {
      ...base,
      status: "error",
      error: correlated.reason,
    });
    return { collected: false, reason: correlated.reason };
  }
  const fetches = parseCorrelatedFetches(correlated.data);
  if (!fetches) {
    recordReceipt(session.issueId, workerSessionId, {
      ...base,
      status: "error",
      error: "malformed correlation response — no usable playbook fetch list",
    });
    return { collected: false, reason: "malformed correlation response" };
  }
  const summary = summarizeFetches(fetches);
  const receipt = recordReceipt(session.issueId, workerSessionId, {
    ...base,
    ...summary,
    status: "collected",
    ...(summary.playbookIds.length === 0 ? { reason: "no observed playbook use" } : {}),
  });
  return { collected: true, receipt, duplicate: false };
}

/** Collects receipts for every terminal session of the issue still missing one. */
export async function collectPlaybookUseReceiptsForIssue(
  issueId: string,
  deps: PlaybookFeedbackDeps = defaultDeps
): Promise<{ collected: number; pending: number; errors: number }> {
  let collected = 0;
  let pending = 0;
  let errors = 0;
  for (const session of listWorkerSessionsForIssue(issueId)) {
    if (!TERMINAL_SESSION.has(session.status)) continue;
    const result = await collectPlaybookUseReceipt(session.id, deps);
    if (result.collected && !result.duplicate) collected++;
    else if (!result.collected) {
      pending++;
      if (latestReceiptForSession(session.issueId, session.id)?.status === "error") errors++;
    }
  }
  return { collected, pending, errors };
}

// ---------------------------------------------------------------------------
// Failure/correction signals.
// ---------------------------------------------------------------------------

/** Human choices that correct or retry the work (as opposed to accepting/closing it). */
const CORRECTION_CHOICES: Record<string, readonly string[]> = {
  final_review: ["repair"],
  attempts_exhausted: ["retry"],
  policy_escalation: ["resume", "repair", "retry_merge"],
  product_scope_decision: ["resume"],
  deck_interaction_required: ["resume"],
};

function resolutionChoice(resolutionJson: string | null): string | null {
  if (!resolutionJson) return null;
  try {
    const choice = (JSON.parse(resolutionJson) as { choice?: unknown }).choice;
    return typeof choice === "string" ? choice : null;
  } catch {
    return null;
  }
}

function excerpt(text: string | null | undefined, max = 500): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export interface SignalCandidate {
  trigger: DeckSignalTrigger;
  sourceKey: string;
  humanActionId: string | null;
  failure: string;
  /**
   * Raw human-stated reason, kept separate so it lands in
   * evidence.user_feedback_excerpt. Null (or blank) when no human stated a
   * reason — buildSignalOnlyArgs then substitutes NO_HUMAN_FEEDBACK_EXCERPT,
   * because Deck's propose_playbook_patch schema requires a non-empty
   * user_feedback_excerpt on every signal_only report.
   */
  userFeedback: string | null;
}

/**
 * Explicit fallback excerpt when no human stated a reason (recurring blocking
 * findings, blank retry reasons). Deck rejects a missing/blank
 * user_feedback_excerpt, so a report must never omit it. Constant text keeps
 * repeated sends byte-identical for crash-window idempotency.
 */
export const NO_HUMAN_FEEDBACK_EXCERPT =
  "no human feedback — Dealer-observed failure (see failure_summary for observed evidence)";

/**
 * Deck's `propose_playbook_patch` input schema (additionalProperties:false).
 * Dealer may only send these top-level fields; the issue-centric reflection path
 * sends `signal_only` with `kind` + `rationale` + `evidence` and never
 * `playbook_id`/`ops` (no attribution, no synthesized edit).
 */
const DECK_SIGNAL_TOP_LEVEL_KEYS = new Set([
  "kind",
  "rationale",
  "evidence",
  "signal_ids",
  "supersedes",
  "ops",
  "playbook_id",
  "new_playbook",
]);

/** Returns null when args satisfy Deck's schema; otherwise a human-readable reason. */
export function validateSignalOnlyArgs(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) {
    if (!DECK_SIGNAL_TOP_LEVEL_KEYS.has(key)) return `unknown top-level field: ${key}`;
  }
  if (args.kind !== "signal_only") return `kind must be "signal_only"`;
  if (typeof args.rationale !== "string" || !args.rationale.trim()) {
    return "rationale must be a non-empty string";
  }
  const evidence = asRecord(args.evidence);
  if (!evidence) return "evidence must be an object";
  for (const key of Object.keys(evidence)) {
    if (key !== "failure_summary" && key !== "user_feedback_excerpt" && key !== "corrected_output_hint") {
      return `unknown evidence field: ${key}`;
    }
  }
  if (typeof evidence.failure_summary !== "string" || !evidence.failure_summary.trim()) {
    return "evidence.failure_summary must be a non-empty string";
  }
  // Deck's schema (shared PatchEvidenceContent) requires a non-empty
  // user_feedback_excerpt on every report — recurring_blocking and blank-reason
  // reports included. corrected_output_hint stays optional.
  if (typeof evidence.user_feedback_excerpt !== "string" || !evidence.user_feedback_excerpt.trim()) {
    return "evidence.user_feedback_excerpt must be a non-empty string";
  }
  if (
    "corrected_output_hint" in evidence &&
    (typeof evidence.corrected_output_hint !== "string" || !evidence.corrected_output_hint.trim())
  ) {
    return "evidence.corrected_output_hint must be a non-empty string when present";
  }
  if ("playbook_id" in args || "ops" in args) return "signal_only must not carry playbook_id or ops";
  return null;
}

/**
 * Builds the Deck-stored `signal_only` payload. Every Dealer-owned reference the
 * inbox needs — deterministic source key, dealer issue/session refs, observed
 * playbook use (or an explicit `no observed playbook use` line) — lives inside
 * Deck-stored fields (`rationale` + `evidence.failure_summary`), because Deck's
 * schema drops anything else. The source key is embedded verbatim so a repeated
 * send after a crash between the Deck call and the local artifact write is
 * recognizable as the same report.
 */
export function buildSignalOnlyArgs(
  candidate: SignalCandidate,
  opts: { issueId: string; workerSessionIds: string[]; playbookIds: string[] }
): Record<string, unknown> {
  const baseRationale =
    candidate.trigger === "human_retry"
      ? "Human correction during Dealer review — reported once as supporting evidence, without attributing the failure to any playbook."
      : candidate.trigger === "attempts_exhausted"
        ? "Dealer review attempts were exhausted — reported once as supporting evidence, without attributing the failure to any playbook."
        : "A blocking review finding recurred across rounds — reported once as supporting evidence, without attributing the failure to any playbook.";
  const sessionsLine = opts.workerSessionIds.length > 0 ? opts.workerSessionIds.join(", ") : "none";
  const playbooksLine =
    opts.playbookIds.length > 0 ? opts.playbookIds.join(", ") : "no observed playbook use";
  // Deck requires user_feedback_excerpt on every report. Prefer the human's own
  // words; otherwise the finding's rationale/title excerpt the candidate already
  // selected; otherwise an explicit no-feedback line (never omitted, never blank).
  const userFeedbackExcerpt =
    candidate.userFeedback?.trim() ? candidate.userFeedback : NO_HUMAN_FEEDBACK_EXCERPT;
  return {
    kind: "signal_only",
    rationale:
      `${baseRationale} ` +
      `Dealer source ${candidate.sourceKey} | trigger ${candidate.trigger} | ` +
      `dealer issue ${opts.issueId} | worker sessions ${sessionsLine}.`,
    evidence: {
      failure_summary:
        `${candidate.failure}\n\n` +
        `Dealer issue: ${opts.issueId}\n` +
        `Worker sessions: ${sessionsLine}\n` +
        `Playbooks observed in use: ${playbooksLine}\n` +
        `Source key: ${candidate.sourceKey}`,
      user_feedback_excerpt: userFeedbackExcerpt,
    },
  };
}

/** Deterministic source key — the cross-restart idempotency identity of one report. */
export function signalSourceKey(issueId: string, trigger: DeckSignalTrigger, key: string): string {
  return `dealer:${issueId}:${trigger}:${key}`;
}

function humanRetryCandidates(issueId: string, alreadyReferencedActionIds: Set<string>): SignalCandidate[] {
  const candidates: SignalCandidate[] = [];
  for (const action of listHumanActionsForIssue(issueId)) {
    if (action.status !== "resolved") continue;
    // One action produces at most one signal, whichever trigger claims it first — a
    // meaningful failure/correction appears once in Deck's feedback inbox, never once
    // per trigger that describes the same human decision.
    if (alreadyReferencedActionIds.has(action.id)) continue;
    const choice = resolutionChoice(action.resolutionJson);
    if (!choice) continue;
    if (!CORRECTION_CHOICES[action.actionType]?.includes(choice)) continue;
    const failureParts = [
      `Human ${choice} on ${action.actionType} (action ${action.id}, resolved by ${action.resolvedBy ?? "unknown"}).`,
    ];
    const reason = excerpt(action.reason);
    if (reason) failureParts.push(`Stated reason: ${reason}`);
    const question = excerpt(action.question);
    if (question) failureParts.push(`Asked: ${question}`);
    candidates.push({
      trigger: "human_retry",
      sourceKey: signalSourceKey(issueId, "human_retry", action.id),
      humanActionId: action.id,
      failure: failureParts.join(" "),
      userFeedback: reason,
    });
  }
  return candidates;
}

function attemptsExhaustedCandidates(issueId: string, alreadyReferencedActionIds: Set<string>): SignalCandidate[] {
  const candidates: SignalCandidate[] = [];
  for (const action of listHumanActionsForIssue(issueId)) {
    if (action.actionType !== "attempts_exhausted") continue;
    // A resolved attempts_exhausted:retry is already reported as a human_retry above —
    // one action produces at most one signal, whichever trigger claims it first.
    if (alreadyReferencedActionIds.has(action.id)) continue;
    const choice = action.status === "resolved" ? resolutionChoice(action.resolutionJson) : null;
    candidates.push({
      trigger: "attempts_exhausted",
      sourceKey: signalSourceKey(issueId, "attempts_exhausted", action.id),
      humanActionId: action.id,
      failure:
        `Review attempts were exhausted (action ${action.id}, ` +
        `${action.status === "resolved" ? `human chose ${choice ?? "unknown"}` : "awaiting human decision"}). ` +
        `Stated reason: ${excerpt(action.reason) ?? "(none recorded)"}`,
      userFeedback: excerpt(action.reason),
    });
  }
  return candidates;
}

function recurringBlockingCandidate(issueId: string): SignalCandidate | null {
  const recurring = listFindingsForIssue(issueId).filter(
    (f) => f.status === "recurring" && f.severity === "blocking"
  );
  if (recurring.length === 0) return null;
  const lines = recurring.map(
    (f) => `- ${f.fingerprint} (rounds ${f.firstRound}–${f.lastRound}): ${excerpt(f.title, 200) ?? "(untitled)"}`
  );
  // No human stated this failure — the closest thing to a feedback excerpt is the
  // recurring finding's own rationale/title. When even that is blank the builder
  // falls back to the explicit no-feedback line (Deck still requires the field).
  const findingFeedback =
    recurring
      .map((f) => excerpt(f.rationale) ?? excerpt(f.title, 200))
      .find((text): text is string => text !== null) ?? null;
  return {
    trigger: "recurring_blocking",
    sourceKey: signalSourceKey(issueId, "recurring_blocking", "issue"),
    humanActionId: null,
    failure:
      `${recurring.length} blocking finding(s) recurred across review rounds:\n${lines.join("\n")}`,
    userFeedback: findingFeedback,
  };
}

export interface SentSignal {
  sourceKey: string;
  trigger: DeckSignalTrigger;
  signalId: string | null;
}

export interface ReportSignalsResult {
  sent: SentSignal[];
  skipped: string[];
  error?: string;
}

function existingSignalKeys(issueId: string): {
  sentKeys: Set<string>;
  pendingKeys: Set<string>;
  actionIds: Set<string>;
} {
  const sentKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const actionIds = new Set<string>();
  for (const artifact of listArtifactsForIssueByKind(issueId, DECK_FEEDBACK_SIGNAL_KIND)) {
    try {
      const content = JSON.parse(artifact.contentJson ?? "{}") as {
        sourceKey?: unknown;
        humanActionId?: unknown;
        status?: unknown;
      };
      if (typeof content.sourceKey === "string") {
        // Pre-intent rows (written before the pending/sent split) carry
        // status "sent" or no status at all — both count as delivered.
        if (content.status === "pending" || content.status === "sending") {
          pendingKeys.add(content.sourceKey);
        } else {
          sentKeys.add(content.sourceKey);
          // Only a delivered report claims its human action. A pending intent
          // reserves the source key (no second pending row) but must not
          // suppress the candidate — otherwise the retry the intent exists to
          // enable would never be generated.
          if (typeof content.humanActionId === "string") actionIds.add(content.humanActionId);
        }
      }
    } catch {
      // malformed content — nothing to dedupe on its account
    }
  }
  return { sentKeys, pendingKeys, actionIds };
}

function recordSignalIntent(
  issueId: string,
  candidate: SignalCandidate,
  opts: { deckId: string; workerSessionIds: string[]; playbookIds: string[] }
): void {
  createIssueArtifact({
    issueId,
    kind: DECK_FEEDBACK_SIGNAL_KIND,
    author: "system",
    content: {
      sourceKey: candidate.sourceKey,
      trigger: candidate.trigger,
      humanActionId: candidate.humanActionId,
      signalId: null,
      deckId: opts.deckId,
      workerSessionIds: opts.workerSessionIds,
      playbookIds: opts.playbookIds,
      observedPlaybookUse: opts.playbookIds.length > 0 ? "observed" : "none",
      failure: candidate.failure,
      status: "pending",
    },
  });
}

function recordStatus(issueId: string, content: Record<string, unknown>): void {
  createIssueArtifact({ issueId, kind: "reflect_status", author: "system", content });
}

/**
 * Sends one idempotent `signal_only` Deck report per failure/correction trigger found
 * in the issue's durable state. Never throws and never changes the issue outcome: a
 * Deck outage (or malformed response) records a visible, retryable `reflect_status`
 * and preserves whatever state the issue already reached.
 *
 * A clean run — no human correction, no attempts exhaustion, no recurring blocking
 * finding — sends nothing: receipts alone are the record.
 */
export async function reportDeckFailureSignals(
  issueId: string,
  deps: PlaybookFeedbackDeps = defaultDeps
): Promise<ReportSignalsResult> {
  const issue = getIssue(issueId);
  if (!issue) return { sent: [], skipped: [], error: "unknown issue" };

  const { sentKeys, pendingKeys, actionIds: signalledActions } = existingSignalKeys(issueId);
  const recurring = recurringBlockingCandidate(issueId);
  const allCandidates = [
    ...humanRetryCandidates(issueId, signalledActions),
    ...attemptsExhaustedCandidates(issueId, signalledActions),
    ...(recurring ? [recurring] : []),
  ];
  const candidates = allCandidates.filter((c) => !sentKeys.has(c.sourceKey));
  const skipped = allCandidates.filter((c) => sentKeys.has(c.sourceKey)).map((c) => c.sourceKey);
  if (candidates.length === 0) return { sent: [], skipped };

  // Supporting evidence is actual use only: the union of collected receipts. No receipt
  // means the report says `no observed playbook use` — never legacy Agent configuration.
  const playbookIds: string[] = [];
  const seen = new Set<string>();
  for (const artifact of listArtifactsForIssueByKind(issueId, PLAYBOOK_USE_RECEIPT_KIND)) {
    const receipt = parseReceiptContent(artifact.contentJson);
    if (receipt?.status !== "collected") continue;
    for (const id of receipt.playbookIds) {
      if (!seen.has(id)) {
        seen.add(id);
        playbookIds.push(id);
      }
    }
  }
  const workerSessionIds = listWorkerSessionsForIssue(issueId)
    .filter((s) => TERMINAL_SESSION.has(s.status))
    .map((s) => s.id);

  // The deck the sessions actually ran with (frozen snapshots) — no deck, no send.
  const deckId =
    [...listWorkerSessionsForIssue(issueId)]
      .reverse()
      .map(sessionDeckId)
      .find((id): id is string => id !== null) ?? null;
  if (!deckId) {
    recordStatus(issueId, {
      status: "skipped",
      reason: "no deck in worker session snapshots — failure signals have nowhere to go",
      pendingSignals: candidates.map((c) => c.sourceKey),
    });
    return { sent: [], skipped, error: "no deck in worker session snapshots" };
  }

  const healthy = await deps.checkHealth().catch(() => false);
  if (!healthy) {
    recordStatus(issueId, {
      status: "failed",
      reason: "Agent Deck offline — failure signals retryable on a later trigger",
      pendingSignals: candidates.map((c) => c.sourceKey),
    });
    return { sent: [], skipped, error: "Agent Deck offline" };
  }

  const sent: SentSignal[] = [];
  let anyFailed = false;
  for (const candidate of candidates) {
    // signal_only: a feedback record, never a playbook edit. Only Deck-schema
    // fields are sent (kind/rationale/evidence) — no playbook_id (no single
    // attribution), no ops (no synthesized edit), and no Dealer-only top-level
    // keys. All Dealer refs (source key, issue/session refs, observed playbook
    // use) live inside the Deck-stored rationale/evidence fields.
    //
    // Crash safety: the pending intent row is written BEFORE the Deck call, so a
    // restart between the call and the sent row reconciles to the same source
    // key (embedded verbatim in the Deck-stored payload) instead of minting a
    // second report. A pending row without a sent row is retried, never duplicated
    // locally; a repeated send after that window carries the identical key.
    if (!pendingKeys.has(candidate.sourceKey)) {
      recordSignalIntent(issueId, candidate, { deckId, workerSessionIds, playbookIds });
      pendingKeys.add(candidate.sourceKey);
    }
    const signalArgs = buildSignalOnlyArgs(candidate, { issueId, workerSessionIds, playbookIds });
    const schemaError = validateSignalOnlyArgs(signalArgs);
    if (schemaError) {
      anyFailed = true;
      recordStatus(issueId, {
        status: "failed",
        sourceKey: candidate.sourceKey,
        error: `signal payload rejected by Dealer-side Deck schema check: ${schemaError}`,
      });
      continue;
    }
    const proposed = await deps.callTool<{ id?: unknown }>({
      deckId,
      toolName: "propose_playbook_patch",
      arguments: signalArgs,
      timeoutMs: SIGNAL_TOOL_TIMEOUT_MS,
    });
    if (!proposed.ok) {
      anyFailed = true;
      recordStatus(issueId, {
        status: "failed",
        sourceKey: candidate.sourceKey,
        error: proposed.reason,
      });
      continue;
    }
    const signalId = typeof proposed.data?.id === "string" ? proposed.data.id : null;
    createIssueArtifact({
      issueId,
      kind: DECK_FEEDBACK_SIGNAL_KIND,
      author: "system",
      content: {
        sourceKey: candidate.sourceKey,
        trigger: candidate.trigger,
        humanActionId: candidate.humanActionId,
        signalId,
        deckId,
        workerSessionIds,
        playbookIds,
        observedPlaybookUse: playbookIds.length > 0 ? "observed" : "none",
        failure: candidate.failure,
        status: "sent",
      },
    });
    sent.push({ sourceKey: candidate.sourceKey, trigger: candidate.trigger, signalId });
  }

  recordStatus(issueId, {
    status: anyFailed ? (sent.length > 0 ? "partial" : "failed") : "completed",
    signalsSent: sent.map((s) => s.sourceKey),
    playbookCount: playbookIds.length,
  });
  return { sent, skipped };
}
