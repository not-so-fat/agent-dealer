import type { Run } from "@agent-dealer/shared";
import { resolveCodexBin } from "../cli-env.js";
import { getTemporalOutputDir } from "../paths.js";
import { buildCodexExecArgs, type CodexPhaseMode } from "./codex-args.js";
import { logPathFor, spawnCli, timeoutMsForMode, type RunnerResult } from "./spawn-cli.js";
import {
  buildExecutionContinuationPrompt,
  buildExecutionPrompt,
  buildPlanPrompt,
  workspaceForRun,
} from "./prompts.js";
import { humanFeedbackText, lineageParentExecuteSessionId } from "./run-context.js";

/**
 * Resume session for Codex — mirrors Claude:
 * explicit opts win; else execute + human feedback → lineage parent execute session.
 */
export function resolveCodexResumeSessionId(
  run: Run,
  mode: CodexPhaseMode,
  optsResumeSessionId?: string
): string | undefined {
  if (optsResumeSessionId) return optsResumeSessionId;
  if (mode === "execute" && humanFeedbackText(run)) {
    return lineageParentExecuteSessionId(run) ?? undefined;
  }
  return undefined;
}

export async function runCodex(
  run: Run,
  mode: CodexPhaseMode = "execute",
  model?: string,
  opts?: {
    promptOverride?: string;
    resumeSessionId?: string;
    outputSchemaPath?: string;
    outputLastMessagePath?: string;
    addDirs?: string[];
  }
): Promise<RunnerResult> {
  if (mode === "qa" && !opts?.promptOverride) {
    throw new Error("qa mode requires a promptOverride");
  }

  const resumeSessionId = resolveCodexResumeSessionId(run, mode, opts?.resumeSessionId);

  const prompt =
    opts?.promptOverride ??
    (mode === "plan"
      ? buildPlanPrompt(run)
      : resumeSessionId
        ? buildExecutionContinuationPrompt(run)
        : buildExecutionPrompt(run));
  const logPath = logPathFor(run, mode);
  const workspaceRoot = workspaceForRun(run);

  // Match Claude execute: temporal output dir must be writable for document artifacts.
  const addDirs =
    opts?.addDirs ?? (mode === "execute" ? [getTemporalOutputDir()] : undefined);

  const args = buildCodexExecArgs({
    mode,
    workspaceRoot,
    prompt,
    model,
    resumeSessionId,
    outputSchemaPath: opts?.outputSchemaPath,
    outputLastMessagePath: opts?.outputLastMessagePath,
    addDirs,
  });

  const { exitCode, transcript, timedOut } = await spawnCli(
    run.id,
    resolveCodexBin(),
    args,
    workspaceRoot,
    { logPath, timeoutMs: timeoutMsForMode(mode) }
  );
  return { exitCode, transcript, logPath, timedOut };
}
