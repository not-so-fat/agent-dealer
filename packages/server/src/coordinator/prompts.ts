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
}

export function buildDeveloperPrompt(input: DeveloperPromptInput): string {
  const parts = [
    input.round === 1
      ? `Implement this issue on a fresh branch off ${input.taskSnapshot.baseBranch}.`
      : `This is repair round ${input.round}. Address every blocking finding below, then push and update the draft PR.`,
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

  parts.push(
    `## Required`,
    `Run tests and Lens checks. Push your branch with \`git\` and open or update the draft PR with \`gh pr create\`/\`gh pr edit\`.`,
    `End your reply with a short **implementation conclusion**: what changed, why, any deviations from the acceptance criteria, and known follow-ups. This is distinct from the PR description and is required every round.`
  );

  return parts.join("\n");
}

export interface ReviewerPromptInput {
  taskSnapshot: TaskSnapshot;
  baseSha: string;
  headSha: string;
  implementationConclusion?: string;
  priorFindings?: Finding[];
}

export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  const parts = [
    `Review this pull request. You have read-only repository access — do not edit files, push, or change workflow state.`,
    ``,
    `## Task snapshot`,
    input.taskSnapshot.title,
    input.taskSnapshot.description,
    ``,
    `## Acceptance criteria`,
    input.taskSnapshot.acceptanceCriteria,
    ``,
    `## SHAs to review`,
    `Base: ${input.baseSha}`,
    `Head: ${input.headSha}`,
    ``,
  ];

  if (input.implementationConclusion) {
    parts.push(`## Developer's implementation conclusion`, input.implementationConclusion, ``);
  }

  if (input.priorFindings?.length) {
    parts.push(`## Prior finding history`);
    for (const f of input.priorFindings) {
      parts.push(`- [${f.status}] ${f.title} (first seen round ${f.firstRound})`);
    }
    parts.push(``);
  }

  parts.push(
    `Submit your review with \`gh pr review\`, ending the review body with exactly one fenced ` +
      "```json" +
      ` block:`,
    `{"verdict":"approved"|"changes_requested"|"escalated","baseSha":"...","headSha":"...","acceptanceCriteriaAssessment":"...","evidenceAssessment":"...","findings":[{"fingerprint":"...","severity":"blocking"|"non_blocking","title":"...","rationale":"...","file":"...","line":0}],"risks":["..."],"productScopeQuestion":"..."}`,
    `Rules:`,
    `- "escalated" means you cannot form approved/changes_requested — set productScopeQuestion if a missing product decision is the reason.`,
    `- Every blocking finding needs a stable fingerprint so it can be tracked across rounds — reuse the same fingerprint if you're confirming a prior finding is still open.`
  );

  return parts.join("\n");
}
