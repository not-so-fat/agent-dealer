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
  reviewQaPairs,
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

function outboundDraftContractSection(): string {
  return [
    "## Outbound actions (Slack/email prefer draft; other services may write directly)",
    "Prefer ending with a fenced ```json draft for Slack/email (and any write you want human approval on before send).",
    "call_service_tool IS available during execution — use it for non-message deck writes (Linear, GitHub, Docmost, …) when the task must complete the write now.",
    "For Slack/email (or when drafting), do NOT send mid-run: end your reply with exactly one fenced ```json block shaped like:",
    '{"actionType":"slack_message"|"email"|"service_tool_call","summary":{"target":"#channel, recipient, or service action","body":"exact message text or short human summary"},"toolCall":{"serviceName":"<deck service UUID>","toolName":"<tool from list_service_tools>","arguments":{...}}}',
    "Rules:",
    "- At most one outbound draft block per run (omit the block if you already called call_service_tool to finish the write).",
    "- Call bind_workspace, then get_bound_deck and list_service_tools — never invent a service UUID or tool name.",
    "- toolCall.serviceName must be the exact service id from the bound deck (not a display name).",
    "- Slack: toolName is slack_send_message; arguments.channel_id is the user or channel id from slack_search_users (never guess IDs from meeting notes); arguments.message must byte-match summary.body.",
    "- Email: use the real tool name and message field from list_service_tools; message body must byte-match summary.body.",
    "- service_tool_call: summary is for the human review card; arguments need not byte-match summary.body.",
    "- Draft path: do not perform the send — the human approves and the server delivers verbatim.",
  ].join("\n");
}

function reviewQaSections(run: Run): string[] {
  const pairs = reviewQaPairs(run);
  if (pairs.length === 0) return [];
  const lines = pairs.flatMap((p) => [`Q: ${p.question}`, `A: ${p.answer}`, ``]);
  return [`## Review Q&A`, `The human asked about the prior result. Honor these answers.`, ...lines];
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

  parts.push(...reviewQaSections(run));

  if (run.deckId) {
    parts.push(
      `Use Agent Deck: bind_workspace({ deckId: "${run.deckId}", workspaceRoot: "${workspaceForRun(run)}" })`
    );
    if (run.playbookId) {
      parts.push(`Then get_playbook("${run.playbookId}") and follow it.`);
    }
  }

  parts.push(outboundDraftContractSection());
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
  parts.push(...planDelegationSections(run));
  parts.push(...reviewQaSections(run));

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

  parts.push(outboundDraftContractSection());
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
    `- Read the current playbook via get_playbook — do NOT call update_playbook or propose_playbook_patch.`,
    `- Prefer item-level ops (add_item to Gotchas/Checklist) over rewrite_body.`,
    `- Generalize identifiers (project names, paths) but keep concrete failure detail in gotchas.`,
    `- Place lessons correctly: checklist for verification, technique for patterns, gotcha/anti-pattern for mistakes.`,
    `- Output ONLY a JSON object (no markdown fences, no other text):`,
    `  {"rationale":"why this change helps future runs","ops":[{"op":"add_item","section":"Gotchas","text":"..."}],"evidence":{"failure_summary":"what went wrong","user_feedback_excerpt":"verbatim correction if any"}}`,
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

export function buildQaPrompt(
  run: Run,
  question: string,
  opts: { grounded: boolean }
): string {
  const parts = [
    `The human reviewing your finished work has a question about it.`,
    ``,
    `IMPORTANT:`,
    `- Answer the question. Do NOT modify anything — no files, no edits, no commands, no sends.`,
    `- You may read files to check your own work.`,
    `- Answer concisely in markdown. No preamble, no restating the question.`,
    `- If you do not know, say so plainly rather than guessing.`,
    ``,
  ];

  if (opts.grounded) {
    parts.push(`## Task`, taskText(run), ``);
  } else {
    parts.push(
      `Your original session is gone, so the relevant context is reproduced below.`,
      ``,
      `## Task`,
      taskText(run),
      ``
    );
    const plan = artifactMarkdown("approved_plan", run.id);
    if (plan) parts.push(`## Approved plan`, plan, ``);
    const result = artifactMarkdown("execution_result", run.id);
    if (result) parts.push(`## Execution outcome`, result, ``);
    const doc = artifactMarkdown("document", run.id);
    if (doc) parts.push(`## Deliverable`, doc, ``);
  }

  parts.push(`## Question`, question);
  return parts.join("\n");
}

function hasOutboundSendGate(category: Run["taskCategory"]): boolean {
  return category === "communication" || category === "email";
}

function planTriageContractSection(taskCategory: Run["taskCategory"] = "other"): string {
  const sendGate = hasOutboundSendGate(taskCategory);
  const rules = [
    "## Required final JSON block",
    "After the plan markdown, end your reply with exactly one fenced ```json block shaped like:",
    '{"verdict":"trivial"|"needs_review","rationale":"one sentence","questions":[{"id":"q1","question":"...","options":[{"label":"...","description":"..."}]}]}',
    "Rules:",
    sendGate
      ? '- "trivial" means safe to execute without human plan review; it requires an empty questions array. Use "trivial" when the task names recipient and message (or execution steps are obvious). The send gate reviews the exact payload before anything is sent.'
      : '- "trivial" means this plan is safe to execute without human review; it requires an empty questions array. When in doubt, use "needs_review".',
  ];
  if (sendGate) {
    rules.push(
      "- Do not ask plan questions about recipient, channel, or message wording — those are confirmed when the human approves the outbound draft.",
      "- Ask at most 3 questions, and only when a missing decision would change how you execute (not send approval). Never ask permission to proceed."
    );
  } else {
    rules.push(
      "- Ask at most 3 questions, and only when the answer changes how you would execute. Never ask permission to proceed."
    );
  }
  rules.push("- Each question needs 2-4 concrete options; give each option a short description.");
  return rules.join("\n");
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

function planDelegationSections(run: Run): string[] {
  const ansArt = getLatestArtifact(run.id, "plan_answers");
  if (!ansArt?.contentJson) return [];
  try {
    const ans = JSON.parse(ansArt.contentJson) as PlanAnswersContent;
    if (ans.outcome !== "delegated") return [];
    const triArt = getLatestArtifact(run.id, "plan_triage");
    const questions: PlanQuestion[] = triArt?.contentJson
      ? (JSON.parse(triArt.contentJson) as PlanTriageContent).questions
      : [];
    if (questions.length === 0) return [];
    const lines = questions.map((q) => {
      const options = q.options.map((o) => o.label).join(" | ");
      return `- ${q.question} (options: ${options})`;
    });
    return [
      "## Unanswered plan questions",
      "The reviewer chose to proceed without answering these. Use your best judgment.",
      ...lines,
      "",
    ];
  } catch {
    return [];
  }
}

export function buildPlanFeedbackPrompt(run: Run, feedback: string): string {
  return [
    "The human reviewed your plan and wants a revision. Revise the plan accordingly — do not execute anything.",
    "",
    "## Task",
    taskText(run),
    "",
    "## Human feedback",
    feedback.trim(),
    "",
    planTriageContractSection(run.taskCategory),
  ].join("\n");
}

export function buildPlanEditedReplanPrompt(run: Run, editedMarkdown: string): string {
  return [
    "The human edited the plan directly. Start from their edits and produce a refined plan — do not execute anything.",
    "",
    "## Task",
    taskText(run),
    "",
    "## Human-edited plan",
    editedMarkdown.trim(),
    "",
    planTriageContractSection(run.taskCategory),
  ].join("\n");
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
    planTriageContractSection(run.taskCategory),
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

  if (hasOutboundSendGate(run.taskCategory)) {
    parts.push(
      `## Outbound send gate`,
      `Execution drafts the Slack/email payload; the human approves the exact message before send.`,
      `If the task text names who to message and what to say (or the intent is obvious), plan for verdict "trivial" with no questions.`,
      ``
    );
    parts.push(
      `Output a brief bullet plan (3–5 steps). Skip a risks section unless execution is blocked.`,
      ``,
      planTriageContractSection(run.taskCategory)
    );
  } else {
    parts.push(`Output a step-by-step plan with risks.`, ``, planTriageContractSection(run.taskCategory));
  }

  return parts.join("\n");
}
