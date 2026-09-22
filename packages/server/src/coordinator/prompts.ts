// packages/server/src/coordinator/prompts.ts
//
// Developer/reviewer-round prompt building. Adapted from archive/not-57-full-p0-slice's
// coordinator/prompts.ts: `TaskSnapshot` now matches the artifact frozen at workflow
// start (commands.ts's `startWorkflowCore`) and Agent Deck guidance follows the profile
// snapshot's `playbookIds` list (NOT-60), not a single legacy `playbookId`.
//
// `buildReviewerPrompt` embeds the diff and prior evidence as text rather than telling
// the reviewer to run `git diff` itself: a claude reviewer's read-only tool set
// (`READ_ONLY_BUILTIN_TOOLS` in args.ts) has no Bash at all, so it cannot shell out —
// every artifact it needs to judge must already be in the prompt.
import type { Finding } from "@agent-dealer/shared";
import {
  formatVerificationReceiptSection,
  type VerificationReceipt,
} from "./verification-receipt.js";

export interface TaskSnapshot {
  title: string;
  description: string;
  acceptanceCriteria: string;
  repo: string;
  baseBranch: string;
}

export interface DeveloperPromptInput {
  taskSnapshot: TaskSnapshot;
  round: number;
  findings?: Finding[];
  /** Set when this session is a bounded infra retry of the SAME round (the prior attempt
   * crashed, timed out, produced no PR, failed checks, or hit a git/gh adapter error) —
   * the branch/worktree may already carry that attempt's partial work, so the opening
   * instruction must say so instead of claiming a fresh start. */
  retryReason?: string;
  /** Prior session's implementation conclusion when this is an infra retry — the agent
   * otherwise only sees a short failure string and re-discovers state via git. */
  priorConclusion?: string;
  /** NOT-130: prior session's SHA-scoped verification receipt when HEAD is unchanged —
   * evidence that the suite already passed on this tip; never an instruction to skip. */
  priorVerificationReceipt?: VerificationReceipt;
  /** The generated worktree the agent is actually running in — binding must target this, not the original repo checkout. */
  worktreePath?: string;
  deckId?: string | null;
  /** NOT-181: a Muse Code session has no MCP servers and no Agent Deck — say so instead of the
   * "misconfigured: Agent Deck is required" stop, and forbid the `cron_*` tools Muse cannot hide. */
  noAgentDeck?: boolean;
  /** Human guidance markdown added since this issue's previous worker session (design
   * doc "Guidance semantics") — a one-shot CLI process never inherits a running session,
   * so this is how guidance actually reaches the next developer/reviewer input. */
  guidance?: string[];
}

function guidanceSection(guidance: string[] | undefined): string[] {
  if (!guidance?.length) return [];
  return [
    `## Guidance from the team (added since your last session)`,
    `Apply this unless it would require changing the frozen acceptance criteria, scope, or round limits — if it would, say so in your conclusion instead of deviating.`,
    ``,
    ...guidance.flatMap((g) => [g.trim(), ``]),
  ];
}

/**
 * An agent with a deckId is launched with that deck already equipped in its MCP session
 * (NOT-106). `bind_workspace` confirms the equipped deck for this session cwd — it does
 * not pick a different deck. Without an explicit bind-first instruction, models either
 * skip Deck entirely or (cursor_local) invent a bind against the wrong path from ambient
 * habit. Worktrees are Dealer-managed checkouts (NOT-149); Deck authority comes from the
 * profile's fixed Deck header via launch selection — no repository-local `.agent-deck/use.json`.
 *
 * Linear (and other deck MCPs) must go through Agent Deck (`list_service_tools` /
 * `call_service_tool`) — never a raw Linear URL / web fetch. When Task/AC only point at
 * a ticket id, that deck fetch *is* the brief, not optional enrichment.
 *
 * Workers never start without a deckId (fail-closed at admission/effect).
 */
function noAgentDeckSection(): string[] {
  return [
    `This session has no Agent Deck and no MCP servers. The Task and Acceptance criteria above are the complete brief — if they only reference a ticket id you cannot look it up, so say so in your conclusion instead of guessing.`,
    `Never call \`cron_create\`, \`cron_list\` or \`cron_delete\` and never schedule anything: a session that does is failed and escalated to the operator.`,
    ``,
  ];
}

function agentDeckSection(
  worktreePath: string | undefined,
  deckId: string | null | undefined,
  noAgentDeck?: boolean
): string[] {
  if (noAgentDeck) return noAgentDeckSection();
  if (!deckId || !worktreePath) {
    return [
      `This session is misconfigured: Agent Deck is required but missing. Stop and report the bootstrap failure — do not improvise without the deck.`,
    ];
  }
  return [
    `First equip this agent: bind_workspace({ deckId: "${deckId}", workspaceRoot: "${worktreePath}" }). Do this before any other Agent Deck or Linear call — without that bind you are not running the configured agent.`,
    `This bootstrap is a hard gate. If bind_workspace, get_bound_deck, or any configured get_playbook call fails, stop before inspecting or changing the task and report the bootstrap failure — do not improvise without the deck.`,
    `Then get_bound_deck / list_service_tools / call_service_tool as needed. Ticket detail (Linear, etc.) is only available through Agent Deck service tools — do not web-fetch Linear URLs. If Task/Acceptance criteria only reference a ticket id, fetch that ticket via Agent Deck before implementing; otherwise treat the Task/Acceptance criteria above as authoritative and use Linear only to enrich.`,
  ];
}

export function buildDeveloperPrompt(input: DeveloperPromptInput): string {
  const opening = input.retryReason
    ? `This is a retry of round ${input.round} (same review round — prior attempt did not hand off cleanly).`
    : input.round === 1
      ? `You are already on this issue's dedicated branch (already checked out for you by Dealer off ${input.taskSnapshot.baseBranch}). Commit your work there.`
      : `This is repair round ${input.round}. Address every blocking finding below, then commit your changes.`;
  const parts = [
    opening,
    ``,
  ];

  if (input.retryReason) {
    parts.push(
      `## Previous attempt`,
      `- **Last failure:** ${input.retryReason}`,
      `- Check \`git status\` / \`git log\` on the branch off ${input.taskSnapshot.baseBranch}. Commits from that attempt may already be there — **continue; do not re-implement from scratch**.`,
      `- If the failure was only coordinator GitHub verification (PR create / checks) after work was already committed or pushed, verify acceptance criteria on the existing commits, fix only gaps, commit if needed, then end. Do not open a PR yourself.`,
      ``
    );
    if (input.priorConclusion?.trim()) {
      parts.push(`### Prior implementation conclusion`, input.priorConclusion.trim(), ``);
    }
    if (input.priorVerificationReceipt) {
      parts.push(...formatVerificationReceiptSection(input.priorVerificationReceipt));
    }
  }

  parts.push(
    `## Task`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
  );

  if (input.findings?.length) {
    parts.push(`## Findings to address`);
    for (const f of input.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      parts.push(`- [${f.severity}] ${f.title}${loc}: ${f.rationale}`);
    }
    parts.push(``);
  }

  parts.push(...guidanceSection(input.guidance));
  parts.push(...agentDeckSection(input.worktreePath, input.deckId, input.noAgentDeck));

  parts.push(
    `## Required`,
    // NOT-115: encourage incremental commits so a mid-session death leaves less
    // uncommitted work for dirty_worktree escalation — soft mitigation only.
    // NOT-146: timed-spawn handoff bar is commits + targeted tests for the change.
    // Full suite / Lens run on a separate verify/review budget (NOT-74) — they do not
    // gate developer clean_handoff; the coordinator does not block on full-suite alone.
    `Run targeted tests for the change. A clean handoff is valid with commits plus those targeted tests — full suite / Lens checks are not required inside this timed developer spawn (they run on a separate review/verify budget). Make incremental commits with \`git\` at coherent slice boundaries (for example after the tests for that slice pass) — do not leave all work uncommitted until the very end. A final commit of any remaining changes and the **implementation conclusion** remain required before you exit.`,
    `Commit any remaining changes with \`git\` — do NOT push and do NOT open a pull request; the coordinator pushes your branch and opens/updates the draft PR after this session ends.`,
    `End your reply with a short **implementation conclusion**: what changed, why, any deviations from the acceptance criteria, and known follow-ups. This is distinct from the PR description and is required every round.`
  );

  return parts.join("\n");
}

export interface ReviewerPromptInput {
  taskSnapshot: TaskSnapshot;
  round: number;
  baseSha: string;
  headSha: string;
  /** `git diff baseSha headSha`, already captured by the coordinator (see module doc). */
  diff: string;
  implementationConclusion?: string | null;
  /** The developer round's checks_evidence artifact, rendered as text. */
  checksSummary?: string | null;
  findings?: Finding[];
  /** The generated worktree the agent is actually running in — binding must target this, not the original repo checkout. */
  worktreePath?: string;
  deckId?: string | null;
  /** See DeveloperPromptInput.guidance. */
  guidance?: string[];
}

const REVIEWER_RESULT_SHAPE =
  '{"verdict":"approved"|"changes_requested"|"escalated","baseSha":"...","headSha":"...","acceptanceCriteriaAssessment":"...","evidenceAssessment":"...","findings":[{"fingerprint":"stable-slug","severity":"blocking"|"non_blocking","title":"...","rationale":"...","file":"...","line":0}],"risks":["..."],"productScopeQuestion":"..."}';

function reviewerContractSection(baseSha: string, headSha: string): string[] {
  // Verdict table matches docs/PRD_ISSUE_COORDINATION.md §6.4 / design NOT-150 — do not drift.
  return [
    `## Required final JSON block`,
    `End your reply with exactly one fenced \`\`\`json block shaped like:`,
    REVIEWER_RESULT_SHAPE,
    `Rules (verdict contract):`,
    `- Set "baseSha" to exactly "${baseSha}" and "headSha" to exactly "${headSha}" — these are the coordinator-verified SHAs you were checked out at, not values you compute.`,
    `- "fingerprint" must be a short, stable slug for the finding (e.g. "missing-null-check-args-ts") so the same issue re-found next round is recognized as recurring, not duplicated.`,
    `- "findings" holds every blocking AND non-blocking observation; "risks" is uncertainties that are not findings tied to a location.`,
    `- "approved": AC met for this tip and no finding is "blocking" (non_blocking nits allowed).`,
    `- "changes_requested": any "blocking" finding a coding pass can address — including incomplete review because AC-critical files were omitted/truncated from the diff. List omitted paths in a blocking finding.`,
    `- "escalated": only when acceptance criteria / product scope are ambiguous, contradictory, or need a human product call — not ordinary code defects, not "diff too large". You MUST set non-empty "productScopeQuestion"; omit the field otherwise.`,
    `- You cannot edit files, push, or publish anything — you only return this JSON. The coordinator publishes it to GitHub on your behalf.`,
  ];
}

/**
 * Sized to comfortably fit a realistically large PR in full (a review round found an
 * earlier, much smaller per-file cap still truncated mid-file on a genuinely large PR,
 * cutting off before the code under review). Whole files only — never a mid-hunk cut,
 * which would be actively misleading — so a file either fits completely or is entirely
 * omitted and listed in `omittedPaths`. Truncation policy (PRD §6.4 / NOT-150): coordinator
 * remaps illegal escalate / approved+blocking; never blind escalate → Resume|Close.
 */
export const TOTAL_DIFF_LIMIT = 300_000;

export interface FormattedDiff {
  text: string;
  /** True when at least one changed file had to be omitted for total length. */
  truncated: boolean;
  /** Paths omitted from the prompt body (empty when not truncated). */
  omittedPaths: string[];
}

function pathFromDiffGitHeader(headerLine: string): string | null {
  // `diff --git a/path b/path` — prefer the b/ side; fall back to a/.
  const m = headerLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!m) return null;
  return m[2] || m[1] || null;
}

export function formatDiffForPrompt(diff: string): FormattedDiff {
  const trimmed = diff.trim();
  if (!trimmed) return { text: "(empty diff)", truncated: false, omittedPaths: [] };

  const blocks = trimmed.split(/(?=^diff --git )/m).filter(Boolean);
  const manifest = blocks.map((b) => b.slice(0, b.indexOf("\n"))).join("\n");

  const pieces: string[] = [];
  const omittedPaths: string[] = [];
  let total = 0;
  for (const block of blocks) {
    if (total + block.length > TOTAL_DIFF_LIMIT) {
      const header = block.slice(0, block.indexOf("\n"));
      omittedPaths.push(pathFromDiffGitHeader(header) ?? (header || "unknown"));
      continue;
    }
    pieces.push(block);
    total += block.length;
  }

  const truncated = omittedPaths.length > 0;
  const footer = truncated
    ? `\n... [${omittedPaths.length} changed file(s) omitted — diff exceeds ${TOTAL_DIFF_LIMIT} characters. Omitted: ${omittedPaths.join(", ")}. If any omitted path is AC-critical, verdict MUST be "changes_requested" with a blocking finding listing those paths. If AC is still certifiable from the visible tip with only non_blocking findings, "approved" is allowed. Do NOT use "escalated" for truncation — escalate only with productScopeQuestion for a true product gap.]`
    : "";
  return {
    text: `Changed files (${blocks.length}):\n${manifest}\n\n${pieces.join("\n")}${footer}`,
    truncated,
    omittedPaths,
  };
}

export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const parts = [
    input.round === 1
      ? `Review this PR against the task below. You are checked out at the exact head commit, detached, read-only.`
      : `This is review round ${input.round}, after a repair. Re-check every previously blocking finding was actually addressed, then re-review the rest.`,
    ``,
    `## Task`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
    `## Diff (base ${input.baseSha.slice(0, 8)} → head ${input.headSha.slice(0, 8)})`,
    "```diff",
    formatDiffForPrompt(input.diff).text,
    "```",
    ``,
  ];

  if (input.implementationConclusion) {
    parts.push(`## Developer's implementation conclusion`, input.implementationConclusion, ``);
  }
  if (input.checksSummary) {
    parts.push(`## CI checks`, input.checksSummary, ``);
  }

  if (input.findings?.length) {
    parts.push(`## Findings from prior rounds (verify each is actually resolved)`);
    for (const f of input.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      parts.push(`- [${f.status}/${f.severity}] ${f.title}${loc}: ${f.rationale}`);
    }
    parts.push(``);
  }

  parts.push(...guidanceSection(input.guidance));
  parts.push(...agentDeckSection(input.worktreePath, input.deckId));
  parts.push(``, ...reviewerContractSection(input.baseSha, input.headSha));

  return parts.join("\n");
}
