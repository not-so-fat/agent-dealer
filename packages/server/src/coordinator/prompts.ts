// packages/server/src/coordinator/prompts.ts
//
// Developer-round prompt building. Adapted from archive/not-57-full-p0-slice's
// coordinator/prompts.ts: `TaskSnapshot` now matches the artifact frozen at workflow
// start (commands.ts's `startWorkflowCore`) and Agent Deck guidance follows the profile
// snapshot's `playbookIds` list (NOT-60), not a single legacy `playbookId`. Only the
// developer half is lifted — `buildReviewerPrompt` is NOT-62 scope.
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
