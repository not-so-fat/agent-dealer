import type {
  ArtifactKind,
  PlanAnswer,
  PlanAnswersContent,
  PlanQuestion,
  PlanTriageContent,
  Run,
} from "@agent-dealer/shared";
import { getLatestArtifact } from "../repository/runs.js";
import { documentOutputHint } from "./persist.js";
import {
  humanFeedbackText,
  appendPlanRetrySections,
  appendExecutionRetrySections,
  retryContext,
} from "./run-context.js";

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
  return humanFeedbackText(run);
}

function artifactMarkdown(kind: ArtifactKind, runId: string): string {
  const art = getLatestArtifact(runId, kind);
  if (!art?.contentJson) return "";
  try {
    const parsed = JSON.parse(art.contentJson) as { markdown?: string; resultText?: string };
    return parsed.markdown?.trim() ?? parsed.resultText?.trim() ?? "";
  } catch {
    return "";
  }
}

export function buildExecutionContinuationPrompt(run: Run): string {
  const ctx = retryContext(run);
  const parts = [
    `Continue this approved task from your previous session.`,
    `Apply human feedback and build on work already completed — do not restart from scratch.`,
    ``,
    `## Task`,
    taskText(run),
    ``,
  ];

  if (ctx) {
    appendExecutionRetrySections(parts, ctx);
  } else {
    const feedback = feedbackText(run);
    if (feedback) {
      parts.push(`## Human feedback`, feedback, ``);
    }
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

export function buildExecutionPrompt(run: Run): string {
  const plan = getLatestArtifact(run.id, "approved_plan");
  const planBody = plan?.contentJson
    ? (JSON.parse(plan.contentJson) as { markdown?: string }).markdown ?? ""
    : "";

  const ctx = retryContext(run);
  const parts = [
    ctx
      ? `Continue this approved task — build on the prior attempt below.`
      : `Execute this approved task.`,
    ``,
    `## Task`,
    taskText(run),
    ``,
  ];

  if (run.acceptanceCriteria) {
    parts.push(`## Acceptance criteria`, run.acceptanceCriteria, ``);
  }

  if (ctx) {
    appendExecutionRetrySections(parts, ctx);
  } else {
    if (planBody) {
      parts.push(`## Approved plan`, planBody, ``);
    }
    const feedback = feedbackText(run);
    if (feedback) {
      parts.push(`## Human feedback`, feedback, ``);
    }
  }

  parts.push(...planAnswersSections(run));

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

export function buildReflectPrompt(
  run: Run,
  opts: { trigger: "retry" | "approve"; feedback?: string }
): string {
  const planBody = artifactMarkdown("approved_plan", run.id);
  const execResult = artifactMarkdown("execution_result", run.id);
  const humanFeedback = opts.feedback?.trim() || feedbackText(run);

  const parts = [
    `Reflect on this completed agent-dealer run and propose an improvement to the playbook that was used.`,
    ``,
    `IMPORTANT:`,
    `- Read the current playbook via get_playbook — do NOT call update_playbook.`,
    `- Generalize lessons: drop project-specific names, paths, and schemas.`,
    `- Place lessons correctly: checklist for verification, technique for patterns, anti-pattern for mistakes.`,
    `- Restructure the playbook body if the structure cannot absorb the lesson cleanly.`,
    `- Output ONLY a JSON object (no markdown fences, no other text):`,
    `  {"rationale":"why this change helps future runs","proposedBody":"full updated playbook markdown body"}`,
    ``,
    `## Task`,
    taskText(run),
    ``,
  ];

  if (run.acceptanceCriteria) {
    parts.push(`## Acceptance criteria`, run.acceptanceCriteria, ``);
  }
  if (planBody) {
    parts.push(`## Approved plan`, planBody, ``);
  }
  if (execResult) {
    parts.push(`## Execution outcome`, execResult, ``);
  }
  if (opts.trigger === "retry" && humanFeedback) {
    parts.push(`## Human feedback (highest signal)`, humanFeedback, ``);
  } else if (opts.trigger === "approve") {
    parts.push(
      `## Review outcome`,
      `Human approved this run without retry feedback. Propose improvements only if the execution outcome reveals a reusable lesson.`,
      ``
    );
  }

  if (run.deckId && run.playbookId) {
    parts.push(
      `Use Agent Deck: bind_workspace({ deckId: "${run.deckId}", workspaceRoot: "${workspaceForRun(run)}" })`,
      `Then get_playbook("${run.playbookId}") to read the current body before proposing changes.`
    );
  }

  return parts.join("\n");
}

function planTriageContractSection(): string {
  return [
    "## Required final JSON block",
    "After the plan markdown, end your reply with exactly one fenced ```json block shaped like:",
    '{"verdict":"trivial"|"needs_review","rationale":"one sentence","questions":[{"id":"q1","question":"...","options":[{"label":"...","description":"..."}]}]}',
    "Rules:",
    '- "trivial" means this plan is safe to execute without human review; it requires an empty questions array. When in doubt, use "needs_review".',
    "- Ask at most 3 questions, and only when the answer changes how you would execute. Never ask permission to proceed.",
    "- Each question needs 2-4 concrete options; give each option a short description.",
  ].join("\n");
}

function planAnswersSections(run: Run): string[] {
  const ansArt = getLatestArtifact(run.id, "plan_answers");
  if (!ansArt?.contentJson) return [];
  try {
    const ans = JSON.parse(ansArt.contentJson) as PlanAnswersContent;
    if (ans.outcome !== "approved" || ans.answers.length === 0) return [];
    const triArt = getLatestArtifact(run.id, "plan_triage");
    const questions: PlanQuestion[] = triArt?.contentJson
      ? (JSON.parse(triArt.contentJson) as PlanTriageContent).questions
      : [];
    const lines = ans.answers.map((a) => {
      const q = questions.find((x) => x.id === a.questionId);
      return `- ${q?.question ?? a.questionId}: **${a.selectedLabel ?? a.freeText ?? ""}**`;
    });
    return ["## Human answers to plan questions", ...lines, ""];
  } catch {
    return [];
  }
}

export function buildPlanRevisePrompt(
  run: Run,
  questions: PlanQuestion[],
  answers: PlanAnswer[]
): string {
  const qa = answers.map((a) => {
    const q = questions.find((x) => x.id === a.questionId);
    return `- Q: ${q?.question ?? a.questionId}\n  A: ${a.selectedLabel ?? a.freeText ?? ""}`;
  });
  return [
    "The human answered your plan questions. Revise the plan accordingly — do not execute anything.",
    "",
    "## Task",
    taskText(run),
    "",
    "## Answers",
    ...qa,
    "",
    planTriageContractSection(),
  ].join("\n");
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

  const retryCtx = retryContext(run);
  if (retryCtx) {
    appendPlanRetrySections(parts, retryCtx);
  }

  if (run.taskCategory === "content" || run.taskCategory === "research") {
    parts.push(
      `## Deliverable (execution phase only)`,
      `After approval, execution will produce a markdown document. Plan the steps; do not create the file now.`,
      ``
    );
  }

  parts.push(`Output a step-by-step plan with risks.`, ``, planTriageContractSection());

  return parts.join("\n");
}
