import type { Run, UsageContent } from "@agent-dealer/shared";
import { QA_PHASE_BUDGET } from "@agent-dealer/shared";
import { runClaude } from "./claude.js";
import { buildQaPrompt } from "./prompts.js";
import { extractResultIsError, extractResultText, extractUsage, parseNdjson } from "./stream-json.js";

export interface QaRunResult {
  ok: boolean;
  answer: string;
  error?: string;
  usage: UsageContent;
}

/** One read-only Q&A turn against a finished run. Resumes the execute session when we still have it. */
export async function runQa(
  run: Run,
  question: string,
  resumeSessionId: string | null
): Promise<QaRunResult> {
  const result = await runClaude(run, "qa", run.executeModel ?? undefined, {
    promptOverride: buildQaPrompt(run, question, { grounded: Boolean(resumeSessionId) }),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });

  const events = parseNdjson(result.transcript);
  const usage = extractUsage(events, "qa", "claude_code");
  usage.maxTurns = QA_PHASE_BUDGET.maxTurns;
  usage.maxBudgetUsd = QA_PHASE_BUDGET.maxBudgetUsd;

  const answer = extractResultText(events)?.trim() ?? "";
  const failed = result.exitCode !== 0 || extractResultIsError(events) || !answer;

  return {
    ok: !failed,
    answer,
    error: failed ? `qa exited ${result.exitCode}${answer ? "" : " with no answer"}` : undefined,
    usage,
  };
}
