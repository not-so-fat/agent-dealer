import type { Run } from "@agent-dealer/shared";
import { getLatestArtifact } from "../repository/runs.js";
import { documentOutputHint } from "./persist.js";

export function workspaceForRun(run: Run): string {
  return run.repo ?? run.artifactWorkspace ?? process.cwd();
}

function taskText(run: Run): string {
  const title = run.title;
  const desc = run.description?.trim() ?? "";

  if (run.source === "linear") {
    const label = run.externalLabel ?? run.externalId;
    if (label) {
      return `[${label}] ${title}${desc ? `\n\n${desc}` : ""}`;
    }
  }

  return desc ? `${title}\n\n${desc}` : title;
}

function feedbackText(run: Run): string {
  const fb = getLatestArtifact(run.id, "feedback");
  if (!fb?.contentJson) return "";
  try {
    const parsed = JSON.parse(fb.contentJson) as { markdown?: string };
    return parsed.markdown?.trim() ?? "";
  } catch {
    return "";
  }
}

export function buildExecutionPrompt(run: Run): string {
  const plan = getLatestArtifact(run.id, "approved_plan");
  const planBody = plan?.contentJson
    ? (JSON.parse(plan.contentJson) as { markdown?: string }).markdown ?? ""
    : "";

  const parts = [`Execute this approved task.`, ``, `## Task`, taskText(run), ``];

  if (run.acceptanceCriteria) {
    parts.push(`## Acceptance criteria`, run.acceptanceCriteria, ``);
  }
  if (planBody) {
    parts.push(`## Approved plan`, planBody, ``);
  }

  const feedback = feedbackText(run);
  if (feedback) {
    parts.push(`## Human feedback`, feedback, ``);
  }

  if (run.taskCategory === "content" || run.taskCategory === "research") {
    parts.push(
      `## Deliverable`,
      documentOutputHint(run),
      `You MUST write the file using your Write/edit tool — do not only print markdown in chat.`,
      ``
    );
  }

  if (run.deckId) {
    parts.push(
      `Use Agent Deck: bind_workspace({ deckId: "${run.deckId}", workspaceRoot: "${workspaceForRun(run)}" })`
    );
    if (run.playbookId) {
      parts.push(`Then get_playbook("${run.playbookId}") and follow it.`);
    }
  }

  return parts.join("\n");
}

export function buildPlanPrompt(run: Run): string {
  const parts = [
    `Draft a concise execution plan (markdown) for this task.`,
    ``,
    `IMPORTANT:`,
    `- Plan only — do NOT execute, write files, edit code, or use Write/Edit tools.`,
    `- Return the plan as markdown in your reply only (no saving to disk).`,
    ``,
    `## Task`,
    taskText(run),
    ``,
  ];

  if (run.acceptanceCriteria) {
    parts.push(`## Acceptance criteria`, run.acceptanceCriteria, ``);
  }

  if (run.taskCategory === "content" || run.taskCategory === "research") {
    parts.push(
      `## Deliverable (execution phase only)`,
      `After approval, execution will produce a markdown document. Plan the steps; do not create the file now.`,
      ``
    );
  }

  parts.push(`Output a step-by-step plan with risks. End with the plan markdown only.`);

  return parts.join("\n");
}
