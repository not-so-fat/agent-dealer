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
import type { ExecutionContractV1, Finding, Runtime, SourceAttachmentRecord } from "@agent-dealer/shared";
import {
  sourceAttachmentsDeveloperSection,
  sourceAttachmentsReviewerSection,
} from "./source-attachments.js";
import { MUSE_SANDBOX_CAPABILITIES } from "../runners/muse-code-args.js";
import {
  checkMuseVisualQa,
  museVisualQaPromptSection,
  type MuseVisualQaStatus,
} from "../adapters/muse-visual-qa.js";
import {
  capableDeveloperVisualQaPromptSection,
  developerVisualQaPolicy,
  visualQaReviewerSection,
  type VisualQaRecord,
} from "./visual-qa.js";
import {
  formatVerificationReceiptSection,
  type VerificationReceipt,
} from "./verification-receipt.js";
import {
  formatOperatorCriteria,
  type OperatorCriterion,
} from "./operator-criteria.js";
import type { ReviewerVisualEvidenceInput } from "./reviewer-visual-evidence.js";

export interface TaskSnapshot {
  title: string;
  description: string;
  acceptanceCriteria: string;
  repo: string;
  baseBranch: string;
  /** NOT-306: frozen execution contract compiled from the ticket. Absent/null
   * for legacy issues — prompts then render exactly what they always did. */
  executionContract?: ExecutionContractV1 | null;
  /** NOT-364: frozen Linear source-attachment manifest. Absent/empty renders
   * nothing so attachment-free prompts stay byte-for-byte. */
  sourceAttachments?: SourceAttachmentRecord[];
}

/**
 * NOT-306: render the frozen execution contract as dedicated sections. These
 * are the ticket's own execution semantics — the worker follows them as
 * written and never goes back to the ticket (or anywhere else) to rediscover
 * them. Empty/absent renders nothing so legacy prompts stay byte-for-byte.
 */
function executionContractSection(contract: ExecutionContractV1 | null | undefined): string[] {
  if (!contract) return [];
  const lines = [
    `## Execution contract (frozen ${contract.version} — follow as written, do not rediscover)`,
    `These execution semantics come from the Planner-authored ticket and are frozen for this workflow. Do not re-derive them, do not renegotiate scope, and do not ask the operator to restate them.`,
    ``,
    `### Execution mode`,
    contract.executionMode,
    ``,
    `### Non-goals (out of scope — do not build these)`,
    ...contract.nonGoals.map((goal) => `- ${goal}`),
    ``,
    `### Exit predicate (you are done only when this observably holds)`,
    contract.exitPredicate,
    ``,
    `### One-PR stopping point (stop here even if more work suggests itself)`,
    contract.onePrStoppingPoint,
    ``,
    `### Per-criterion evidence (verify each criterion exactly this way)`,
  ];
  for (const criterion of contract.acceptanceCriteria) {
    lines.push(`- ${criterion.text}`);
    if (criterion.evidence) lines.push(`  Evidence: ${criterion.evidence}`);
  }
  lines.push(``);
  return lines;
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
  /** NOT-278: a Muse Code developer session gets the standard deck bootstrap above plus the
   * Muse-specific `cron_*` prohibition (Muse cannot hide those tools; use is detected
   * post-run as `muse_cron_used`). */
  museDeveloper?: boolean;
  /** NOT-303: resolved screenshot path for a Muse developer session. Defaults to the
   * coordinator-side `checkMuseVisualQa()` preflight when `museDeveloper` is set;
   * tests inject a fixed status. Ignored for non-Muse developers. */
  museVisualQa?: MuseVisualQaStatus;
  /** NOT-381: the developer session's runtime. `muse_code` (or legacy
   * `museDeveloper`) takes the Muse preflight above; every other runtime gets
   * the capable-runtime in-session visual-QA section. */
  runtime?: Runtime | string | null;
  /** Human guidance markdown added since this issue's previous worker session (design
   * doc "Guidance semantics") — a one-shot CLI process never inherits a running session,
   * so this is how guidance actually reaches the next developer/reviewer input. */
  guidance?: string[];
  /** NOT-272: the human's note from resolving a `product_scope_decision` — carried on
   * this round's work-item payload (never read from the DB), so exactly the very next
   * developer round sees it. Rendered verbatim under its own heading. */
  scopeDecisionNote?: string;
  /** NOT-310: merge-conflict repair directive — carried on this round's work-item
   * payload (never read from the DB), so exactly the queued conflict-repair round
   * sees it. Renders the base branch, the conflicting files, and the merge-first
   * instruction under its own heading. */
  conflictRepair?: ConflictRepairDirective;
  /** NOT-314: the frozen snapshot's `[operator]` criteria, parsed by the
   * coordinator (never re-derived by the worker). Renders the do-not-attempt
   * section; empty/absent renders nothing. */
  operatorCriteria?: OperatorCriterion[];
  /** NOT-314: the human's note from resolving an `operator_verification` with
   * `repair` — carried on this round's work-item payload (never read from the
   * DB), so exactly the very next developer round sees it. */
  operatorRepairNote?: string;
}

/**
 * NOT-310: what the conflict-repair developer round must resolve before anything
 * else. `files` holds the conflicting paths observed when the coordinator's own
 * base merge failed; empty when the conflict was only ever seen via `gh` (the
 * agent then discovers the files from its own merge output).
 */
export interface ConflictRepairDirective {
  baseBranch: string;
  branch: string;
  files: string[];
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

/** NOT-310: the merge-conflict repair directive. Empty/absent renders nothing so
 * ordinary rounds produce byte-for-byte the prompt they always did. */
function conflictRepairSection(directive: ConflictRepairDirective | undefined): string[] {
  const base = directive?.baseBranch?.trim();
  const branch = directive?.branch?.trim();
  if (!base || !branch) return [];
  const files = (directive?.files ?? []).map((f) => f.trim()).filter((f) => f.length > 0);
  return [
    `## Merge conflict with ${base} — resolve it first`,
    `This PR's branch \`${branch}\` cannot merge into \`${base}\`: the base moved and merging it conflicts. Do this before any other work in this round:`,
    ``,
    `1. In your worktree: \`git fetch origin ${base}\` and \`git merge origin/${base}\`.`,
    `2. Resolve every conflict preserving both sides' intent — the base side carries other tickets' merged work, never discard it to keep your side.`,
    files.length > 0
      ? `   Files seen conflicting at merge time: ${files.map((f) => `\`${f}\``).join(", ")}.`
      : `   The conflicting files are unknown — your own merge output lists them; resolve all of them.`,
    `3. Run the full verification suite on the resolved tree, then commit the resolution.`,
    `4. Never rebase this published branch and never force-push — the coordinator publishes your tip with a plain push.`,
    ``,
  ];
}

/** NOT-314: the frozen snapshot's `[operator]` criteria for the developer.
 * Empty/absent renders nothing so operator-free tasks produce byte-for-byte
 * the prompt they always did. */
function operatorDeveloperSection(criteria: OperatorCriterion[] | undefined): string[] {
  if (!criteria?.length) return [];
  return [
    `## Operator verification required ([operator] criteria)`,
    `These acceptance criteria can only be proven by a human operator with real credentials, a real login, or a paid session — Dealer blocks the merge until the operator records the result, so do not work around the gate. Do not attempt these; ship the ready-to-run probe and a doc, put the exact command in the PR body:`,
    ``,
    ...formatOperatorCriteria(criteria),
    ``,
  ];
}

/** NOT-314: an operator_verification `repair` note, verbatim. Empty/absent
 * renders nothing so ordinary rounds produce byte-for-byte the prompt they always did. */
function operatorRepairSection(note: string | undefined): string[] {
  if (!note?.trim()) return [];
  return [
    `## Operator verification feedback`,
    `A human reviewed the operator-gated criteria and sent the work back instead of verifying. Address this before anything else, and do not ask the operator to re-verify the same head without fixing it:`,
    ``,
    note.trim(),
    ``,
  ];
}

/** NOT-314: the frozen snapshot's `[operator]` criteria for the reviewer.
 * Missing operator evidence is NOT a defect (Dealer gates the merge itself) —
 * but the probe and the doc must exist. Empty/absent renders nothing. */
function operatorReviewerSection(criteria: OperatorCriterion[] | undefined): string[] {
  if (!criteria?.length) return [];
  return [
    `## Operator-gated criteria ([operator]) — not yours to verify`,
    `Missing operator evidence is NOT a defect: Dealer blocks the merge until a human operator records the result, so never raise a blocking finding and never escalate for an unverified [operator] criterion. What you MUST check instead is that the probe and doc exist: the diff must ship the ready-to-run probe for each criterion below, the doc must name the exact command, and the PR body must carry it. A missing probe or doc IS a blocking finding.`,
    ``,
    ...formatOperatorCriteria(criteria),
    ``,
  ];
}

/**
 * NOT-316: the Muse developer sandbox limits, rendered from
 * `MUSE_SANDBOX_CAPABILITIES` (which is tied by test to the real
 * `--sandbox-network` launch flag) instead of hand-written prose, so the
 * prompt cannot drift from what the sandbox actually does. Muse developers
 * only — returns [] otherwise, so non-Muse prompts are byte-for-byte
 * unchanged.
 */
function museEnvironmentLimitsSection(): string[] {
  const caps = MUSE_SANDBOX_CAPABILITIES;
  return [
    `## Environment limits (sandbox network: ${caps.sandboxNetwork})`,
    `This session runs inside the Muse sandbox with network \`${caps.network}\` — these limits come from the launch flags and cannot be worked around:`,
    ``,
    `- Network: ${caps.network} (no DNS — the npm registry and GitHub API are unreachable).`,
    `- Loopback listeners: ${caps.loopbackListen ? "yes" : "no"} — \`listen()\` fails with EPERM, so do not start servers.`,
    `- Browser: ${caps.browser ? "yes" : "no"}.`,
    `- Credentials/Keychain: ${caps.credentialsKeychain ? "yes" : "no"}.`,
    `After one failed attempt at something the environment cannot do (install, listen, browser, credentials), stop and hand off; do not work around the sandbox.`,
    ``,
  ];
}

function acceptanceCriteriaHasTag(acceptanceCriteria: string, tag: "[agent]" | "[ci]" | "[operator]"): boolean {
  return acceptanceCriteria.includes(tag);
}

/**
 * NOT-316: what `[agent]` / `[ci]` tags on acceptance criteria mean for a Muse
 * developer. Rendered only when the AC text carries the tag (per-tag lines)
 * and only for Muse developers — otherwise returns [] so untagged and
 * non-Muse prompts are byte-for-byte what they always were. `[operator]`
 * criteria are owned by the operator-gate section (`operatorDeveloperSection`)
 * and deliberately not duplicated here.
 */
function tagSemanticsDeveloperSection(acceptanceCriteria: string): string[] {
  const lines: string[] = [];
  if (acceptanceCriteriaHasTag(acceptanceCriteria, "[agent]")) {
    lines.push(
      `- \`[agent]\`: verify yourself — prove the criterion with your own in-session runs (targeted tests); your verification is the evidence.`
    );
  }
  if (acceptanceCriteriaHasTag(acceptanceCriteria, "[ci]")) {
    lines.push(
      `- \`[ci]\`: implement or extend the named CI job/test and push — CI is the evidence, do not reproduce it locally.`
    );
  }
  if (!lines.length) return [];
  return [`## Acceptance-criterion tags ([agent] / [ci])`, ...lines, ``];
}

/**
 * NOT-316: how the reviewer judges tagged criteria. Rendered only when the AC
 * text carries the tag (per-tag lines) — untagged reviewer prompts are
 * byte-for-byte what they always were. `[ci]` is judged by the PR check
 * status in the evidence, never by local runs; an `[operator]` criterion is
 * gated by Dealer and missing operator evidence is never a defect (the
 * probe/doc existence check lives in `operatorReviewerSection` and is not
 * duplicated here).
 */
function tagSemanticsReviewerSection(acceptanceCriteria: string): string[] {
  const lines: string[] = [];
  if (acceptanceCriteriaHasTag(acceptanceCriteria, "[ci]")) {
    lines.push(
      `- Judge \`[ci]\` criteria by the PR check status in the evidence (the CI checks section), not by local runs.`
    );
  }
  if (acceptanceCriteriaHasTag(acceptanceCriteria, "[operator]")) {
    lines.push(
      `- Do not mark an \`[operator]\` criterion as a defect — it is gated by Dealer.`
    );
  }
  if (!lines.length) return [];
  return [`## Criterion tags ([ci] / [operator]) — how to judge`, ...lines, ``];
}

/** NOT-272: a resolved product_scope_decision's human note, verbatim. Empty/absent
 * renders nothing so noteless resolves produce byte-for-byte the prompt they always did. */
function scopeDecisionSection(note: string | undefined): string[] {
  if (!note?.trim()) return [];
  return [
    `## Human decision`,
    `A human resolved the product-scope question that was holding this work. This is the decision — follow it. Do not re-derive it, do not re-escalate the same question, and do not write this decision into source comments; it is recorded on the human action.`,
    ``,
    note.trim(),
    ``,
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
/**
 * NOT-278: Muse cannot mechanically disable `cron_*`, so its developer prompt carries this
 * prohibition on top of the standard deck bootstrap. A session that calls one is failed as
 * `muse_cron_used` and escalated to the operator.
 */
function museCronProhibitionSection(): string[] {
  return [
    `Never call \`cron_create\`, \`cron_list\` or \`cron_delete\` and never schedule anything: a session that does is failed and escalated to the operator.`,
    ``,
  ];
}

function agentDeckSection(
  worktreePath: string | undefined,
  deckId: string | null | undefined
): string[] {
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

  // NOT-310: the conflict repair leads — it is this round's purpose, read before the task.
  parts.push(...conflictRepairSection(input.conflictRepair));
  // NOT-272: the scope decision leads — the developer reads it before the task itself.
  parts.push(...scopeDecisionSection(input.scopeDecisionNote));
  // NOT-314: operator repair feedback leads for the same reason.
  parts.push(...operatorRepairSection(input.operatorRepairNote));

  parts.push(
    `## Task`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
    // NOT-314: operator criteria render separately right after the criteria —
    // the worker must not attempt them, only ship the probe + doc.
    ...operatorDeveloperSection(input.operatorCriteria),
    // NOT-316: tag semantics render only for Muse developers whose AC text
    // carries the tags — otherwise nothing, so untagged and non-Muse prompts
    // stay byte-for-byte.
    ...(input.museDeveloper
      ? tagSemanticsDeveloperSection(input.taskSnapshot.acceptanceCriteria)
      : []),
    ...executionContractSection(input.taskSnapshot.executionContract),
    // NOT-364: frozen source-attachment manifest — local file paths plus
    // external-link metadata and the trust boundary. Empty/absent renders
    // nothing so attachment-free prompts stay byte-for-byte.
    ...sourceAttachmentsDeveloperSection(input.taskSnapshot.sourceAttachments),
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
  parts.push(...agentDeckSection(input.worktreePath, input.deckId));
  if (input.museDeveloper) parts.push(...museCronProhibitionSection());
  // NOT-316: sandbox limits rendered from MUSE_SANDBOX_CAPABILITIES — Muse
  // developers only, so non-Muse prompts are untouched.
  if (input.museDeveloper) parts.push(...museEnvironmentLimitsSection());
  // NOT-303: the screenshot-path preflight verdict is embedded before the session
  // starts, so the worker reads it instead of discovering the Chrome.app abort
  // mid-session. NOT-381: non-Muse runtimes get the capable-runtime in-session
  // attempt instead of the old blanket no-browser assumption.
  const visualQaPolicy = input.museDeveloper ? "muse" : developerVisualQaPolicy(input.runtime);
  if (visualQaPolicy === "muse") {
    parts.push(...museVisualQaPromptSection(input.museVisualQa ?? checkMuseVisualQa()));
  } else {
    parts.push(...capableDeveloperVisualQaPromptSection());
  }

  parts.push(
    `## Required`,
    // NOT-315: the coordinator provisions dependencies before the session spawns —
    // the sandbox has no network, so an in-session install can never work.
    `Dependencies are installed; do not run npm install (no network).`,
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
  /** NOT-314: the frozen snapshot's `[operator]` criteria, parsed by the
   * coordinator. Renders the not-a-defect section; empty/absent renders nothing. */
  operatorCriteria?: OperatorCriterion[];
  /** NOT-384: SHA-bound CI visual evidence for this head. Absent (or a
   * `not_applicable` head, which the coordinator maps to absent) renders
   * nothing so non-UI prompts stay byte-for-byte. */
  visualEvidence?: ReviewerVisualEvidenceInput;
  /** NOT-381: the latest coordinator-validated visual-QA record for the issue
   * (or the latest loud rejection), SHA-checked against the pinned head inside
   * the section. Absent renders nothing so receipt-free reviews stay
   * byte-for-byte. */
  visualQa?: { record: VisualQaRecord; pinnedHeadSha: string } | null;
}

const REVIEWER_RESULT_SHAPE =
  '{"verdict":"approved"|"changes_requested"|"escalated","baseSha":"...","headSha":"...","acceptanceCriteriaAssessment":"...","evidenceAssessment":"...","exitPredicateAssessment":"...","findings":[{"fingerprint":"stable-slug","severity":"blocking"|"non_blocking","title":"...","rationale":"...","file":"...","line":0}],"risks":["..."],"productScopeQuestion":"..."}';

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
    // NOT-306: the execution contract (when the task carries one) is judged,
    // not just the prose criteria — the exit predicate and each criterion's
    // stated evidence get their own assessments on top of the AC verdict.
    `- "acceptanceCriteriaAssessment" judges the acceptance criteria; "evidenceAssessment" must judge EACH criterion's stated evidence (where to look, action/command, expected result) one by one — never a blanket "evidence looks good".`,
    `- When the task carries an execution contract, set "exitPredicateAssessment" to whether the frozen exit predicate observably holds at this tip, and "approved" additionally requires the exit predicate to hold (AC met alone is not enough). Tasks without a contract omit "exitPredicateAssessment".`,
    `- "approved": AC met for this tip and no finding is "blocking" (non_blocking nits allowed).`,
    `- "changes_requested": any "blocking" finding a coding pass can address — including incomplete review because AC-critical files were omitted/truncated from the diff. List omitted paths in a blocking finding.`,
    `- "escalated": only when acceptance criteria / product scope are ambiguous, contradictory, or need a human product call — not ordinary code defects, not "diff too large". You MUST set non-empty "productScopeQuestion"; omit the field otherwise.`,
    // NOT-303: a missing screenshot is never a pass. Some runtimes (Muse Code: the
    // Chrome.app headless abort) cannot do visual QA in-session and say so in the
    // conclusion — echo that as "visual QA not run" in "evidenceAssessment".
    `- A missing screenshot or DOM capture is never verification: if the change has UI-visible effects and no visual evidence is in the diff, the conclusion, or the checks, state "visual QA not run" in "evidenceAssessment" — do not read the absence as a pass.`,
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

/**
 * NOT-384: SHA-bound CI visual evidence for this head. `available` names the
 * staged paths, both SHAs, and the diff summary, and instructs the reviewer to
 * judge the screenshots and the base-vs-head diff at both viewports. `missing`
 * and `failed` name the state and forbid a visual pass — and forbid a blocking
 * finding about the missing evidence itself, since Dealer holds the head for a
 * human operator automatically (a repair round must never start solely for
 * missing visual evidence). Absent renders nothing.
 */
function visualEvidenceSection(evidence: ReviewerVisualEvidenceInput | undefined): string[] {
  if (!evidence) return [];
  const head8 = evidence.headSha.slice(0, 8);
  if (evidence.state === "available") {
    const staged = evidence.staged;
    const lines = [
      `## Visual evidence (CI-captured at ${head8})`,
      `The \`Visual\` CI workflow captured this exact head (\`${evidence.headSha}\`, base \`${evidence.baseSha}\`${evidence.runId != null ? `, run ${evidence.runId}` : ""}) at the required viewports (1440x900 and 390x800), running each route's interaction steps before the screenshot. Judge the screenshots and the base-vs-head diff at both viewports — a nonzero pixel diff is evidence, never an automatic failure; decide whether the rendered changes match the task. A genuine rendered defect IS a coding finding; captures you cannot judge are a risk, never a pass.`,
      ``,
    ];
    if (staged) {
      lines.push(
        `- Head captures: \`${staged.screenshotsDir}/\``,
        `- Baseline captures: \`${staged.baselineDir}/\``,
        `- Diffs and summary: \`${staged.diffDir}/\``,
        ``
      );
    }
    if (evidence.files) {
      for (const name of ["ui-screenshots", "ui-baseline", "ui-diff"] as const) {
        const listing = evidence.files[name];
        const extra =
          listing.total > listing.files.length ? ` (+${listing.total - listing.files.length} more)` : "";
        lines.push(
          `\`${name}/\` (${listing.total} files${extra}): ${listing.files.map((f) => `\`${f}\``).join(", ") || "(empty)"}`
        );
      }
      lines.push(``);
    }
    lines.push(
      `### Diff summary (\`SUMMARY.md\`${staged?.summaryPath ? ` at \`${staged.summaryPath}\`` : ""})`,
      evidence.summary ?? "(the staged ui-diff directory has no SUMMARY.md — judge the diff PNGs directly)",
      ``,
      `Read the PNGs with your file tools — every path above is inside your read-only checkout. Record \`visual QA: verified (<n> shots at ${head8})\` in \`evidenceAssessment\`, naming the shots you judged.`,
      ``
    );
    return lines;
  }
  const reason = evidence.reason ?? "no usable CI visual captures";
  return [
    `## Visual evidence: ${evidence.state} — no usable CI captures for this head`,
    `The \`Visual\` CI workflow produced no usable screenshots for this exact head (\`${evidence.headSha}\`, base \`${evidence.baseSha}\`): ${reason}.`,
    ``,
    `Do NOT report a visual pass: write \`visual QA: not run (${evidence.state})\` in \`evidenceAssessment\`. Do not raise a blocking finding about the missing evidence itself — Dealer holds this head for a human operator automatically, and a repair round must never start solely for missing visual evidence. Judge only the code in the diff.`,
    ``,
  ];
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
    // NOT-314: missing operator evidence is NOT a defect — but the probe and
    // doc must exist. Only rendered when the snapshot carries operator criteria.
    ...operatorReviewerSection(input.operatorCriteria),
    // NOT-316: tagged-criterion judging lines — only when the AC text carries
    // the tags, so untagged reviewer prompts stay byte-for-byte.
    ...tagSemanticsReviewerSection(input.taskSnapshot.acceptanceCriteria),
    ...executionContractSection(input.taskSnapshot.executionContract),
    // NOT-364: the immutable manifest as metadata only — reviewers have no
    // shell, so no file bytes and no worktree path are promised.
    ...sourceAttachmentsReviewerSection(input.taskSnapshot.sourceAttachments),
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
  // NOT-384: SHA-bound CI captures for this head (or the missing/failed
  // notice) — rendered only when the coordinator resolved visual evidence.
  parts.push(...visualEvidenceSection(input.visualEvidence));
  // NOT-381: the coordinator-validated visual receipt (or loud rejection),
  // SHA-bound to the pinned head — the raw conclusion line above is unverified.
  parts.push(...visualQaReviewerSection(input.visualQa?.record ?? null, input.visualQa?.pinnedHeadSha ?? input.headSha));

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
