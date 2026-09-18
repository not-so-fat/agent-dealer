// packages/server/src/runners/prompts.ts
//
// All that survives NOT-71 of the legacy run prompt family: the reflect prompt. The plan,
// execute, execute-continuation, plan-revise and result-Q&A builders existed only for the
// deleted Operations/Inbox/Done product and its dispatcher — nothing constructs a plan or
// execute run any more. Reflect is still reachable: resolving a persisted, Run-scoped
// `outbound_delivery_interaction_required` action finalizes that run
// (queue/approve-deliver.ts) and fires the playbook learning loop.
import type { ArtifactKind, Run } from "@agent-dealer/shared";
import { getLatestArtifact } from "../repository/runs.js";

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

/** The human's retry feedback on this run, when they left any. */
function humanFeedbackText(run: Run): string {
  const fb = getLatestArtifact(run.id, "feedback");
  if (!fb?.contentJson || fb.author !== "human") return "";
  try {
    const parsed = JSON.parse(fb.contentJson) as { markdown?: string };
    return parsed.markdown?.trim() ?? "";
  } catch {
    return "";
  }
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

export function buildReflectPrompt(
  run: Run,
  opts: { trigger: "retry" | "approve"; feedback?: string }
): string {
  const planBody = artifactMarkdown("approved_plan", run.id);
  const execResult = artifactMarkdown("execution_result", run.id);
  const humanFeedback = opts.feedback?.trim() || humanFeedbackText(run);

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
