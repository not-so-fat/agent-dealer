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
  /** The generated worktree the agent is actually running in — binding must target this, not the original repo checkout. */
  worktreePath?: string;
  deckId?: string | null;
  playbookIds?: string[];
}

function agentDeckSection(worktreePath: string | undefined, deckId: string | null | undefined, playbookIds: string[] | undefined): string[] {
  if (!deckId || !worktreePath) return [];
  const parts = [`Use Agent Deck: bind_workspace({ deckId: "${deckId}", workspaceRoot: "${worktreePath}" })`];
  for (const playbookId of playbookIds ?? []) {
    parts.push(`Then get_playbook("${playbookId}") and follow it.`);
  }
  return parts;
}

export function buildDeveloperPrompt(input: DeveloperPromptInput): string {
  const parts = [
    input.round === 1
      ? `Implement this issue on a fresh branch off ${input.taskSnapshot.baseBranch}.`
      : `This is repair round ${input.round}. Address every blocking finding below, then commit your changes.`,
    ``,
    `## Task`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
  ];

  if (input.findings?.length) {
    parts.push(`## Findings to address`);
    for (const f of input.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      parts.push(`- [${f.severity}] ${f.title}${loc}: ${f.rationale}`);
    }
    parts.push(``);
  }

  parts.push(...agentDeckSection(input.worktreePath, input.deckId, input.playbookIds));

  parts.push(
    `## Required`,
    `Run tests and Lens checks. Commit your changes with \`git\` — do NOT push and do NOT open a pull request; the coordinator pushes your branch and opens/updates the draft PR after this session ends.`,
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
  playbookIds?: string[];
}

const REVIEWER_RESULT_SHAPE =
  '{"verdict":"approved"|"changes_requested"|"escalated","baseSha":"...","headSha":"...","acceptanceCriteriaAssessment":"...","evidenceAssessment":"...","findings":[{"fingerprint":"stable-slug","severity":"blocking"|"non_blocking","title":"...","rationale":"...","file":"...","line":0}],"risks":["..."],"productScopeQuestion":"..."}';

function reviewerContractSection(baseSha: string, headSha: string): string[] {
  return [
    `## Required final JSON block`,
    `End your reply with exactly one fenced \`\`\`json block shaped like:`,
    REVIEWER_RESULT_SHAPE,
    `Rules:`,
    `- Set "baseSha" to exactly "${baseSha}" and "headSha" to exactly "${headSha}" — these are the coordinator-verified SHAs you were checked out at, not values you compute.`,
    `- "fingerprint" must be a short, stable slug for the finding (e.g. "missing-null-check-args-ts") so the same issue re-found next round is recognized as recurring, not duplicated.`,
    `- "findings" holds every blocking AND non-blocking observation; "risks" is uncertainties that are not findings tied to a location.`,
    `- Use "changes_requested" whenever any finding is "blocking". Use "approved" only when there are none.`,
    `- Use "escalated" only when the acceptance criteria themselves are ambiguous, contradictory, or the diff reveals a missing product decision — not for ordinary code problems. Set "productScopeQuestion" to that question; omit it otherwise.`,
    `- You cannot edit files, push, or publish anything — you only return this JSON. The coordinator publishes it to GitHub on your behalf.`,
  ];
}

/** The 4000-char cap mirrors `extractConclusion` in developer-effect.ts — the tail is where the actual changes are. */
function capDiff(diff: string): string {
  const trimmed = diff.trim();
  if (!trimmed) return "(empty diff)";
  const LIMIT = 12_000;
  return trimmed.length > LIMIT
    ? `${trimmed.slice(0, LIMIT)}\n\n... [diff truncated at ${LIMIT} chars]`
    : trimmed;
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
    capDiff(input.diff),
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

  parts.push(...agentDeckSection(input.worktreePath, input.deckId, input.playbookIds));
  parts.push(``, ...reviewerContractSection(input.baseSha, input.headSha));

  return parts.join("\n");
}
