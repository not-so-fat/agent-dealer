import fs from "node:fs";
import path from "node:path";
import type { Run } from "@agent-dealer/shared";
import { buildExecutionPrompt, buildExecutionContinuationPrompt, buildPlanPrompt, buildReflectPrompt, workspaceForRun } from "./prompts.js";
import { humanFeedbackText, lineageParentExecuteSessionId } from "./run-context.js";
import { cursorInvokeArgs, resolveClaudeBin, resolveCursorBin } from "../cli-env.js";
import { resolveBudgetForPhase, resolveModelForPhase, getRun } from "../repository/runs.js";
import { budgetCliArgs } from "@agent-dealer/shared";
import { buildClaudePhaseArgs } from "./claude-args.js";
import { runCodex } from "./codex.js";
import {
  logPathFor,
  spawnCli,
  timeoutMsForMode,
  type RunnerResult,
} from "./spawn-cli.js";

export { getActiveLogPath, killRunProcess } from "./process-registry.js";
export { logPathFor, spawnCli, timeoutMsForMode, type RunnerResult } from "./spawn-cli.js";

export async function runClaude(
  run: Run,
  mode: "execute" | "plan" | "reflect" | "qa" = "execute",
  model?: string,
  opts?: { promptOverride?: string; resumeSessionId?: string }
): Promise<RunnerResult> {
  const mcpConfig =
    process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");
  if (!fs.existsSync(mcpConfig)) {
    throw new Error(`MCP config not found: ${mcpConfig}. Set CLAUDE_MCP_CONFIG.`);
  }

  if (mode === "qa" && !opts?.promptOverride) {
    throw new Error("qa mode requires a promptOverride");
  }

  const phaseBudget = mode === "qa" ? null : resolveBudgetForPhase(run, mode);

  const resumeSessionId =
    opts?.resumeSessionId ??
    (mode === "execute" && humanFeedbackText(run) ? lineageParentExecuteSessionId(run) : null);

  const prompt =
    opts?.promptOverride ??
    (mode === "plan"
      ? buildPlanPrompt(run)
      : mode === "reflect"
        ? buildReflectPrompt(run, { trigger: "retry" })
        : resumeSessionId
          ? buildExecutionContinuationPrompt(run)
          : buildExecutionPrompt(run));
  const logPath = logPathFor(run, mode);

  const args = [
    ...(model ? ["--model", model] : []),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    "-p",
    prompt,
    "--mcp-config",
    mcpConfig,
    ...budgetCliArgs(phaseBudget),
    ...buildClaudePhaseArgs(run, mode),
  ];

  const { exitCode, transcript, timedOut } = await spawnCli(
    run.id,
    resolveClaudeBin(),
    args,
    workspaceForRun(run),
    { logPath, timeoutMs: timeoutMsForMode(mode) }
  );
  return { exitCode, transcript, logPath, timedOut };
}

export async function runCursor(
  run: Run,
  mode: "execute" | "plan" | "qa" = "execute",
  model?: string,
  opts?: { promptOverride?: string; resumeSessionId?: string }
): Promise<RunnerResult> {
  if (mode === "qa" && !opts?.promptOverride) {
    throw new Error("qa mode requires a promptOverride");
  }
  const prompt =
    opts?.promptOverride ?? (mode === "plan" ? buildPlanPrompt(run) : buildExecutionPrompt(run));
  const logPath = logPathFor(run, mode);

  const args = cursorInvokeArgs([
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    ...(mode === "qa" ? ["--mode", "ask"] : []),
    ...(opts?.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    ...(model ? ["--model", model] : []),
    prompt,
  ]);

  const { exitCode, transcript, timedOut } = await spawnCli(
    run.id,
    resolveCursorBin(),
    args,
    workspaceForRun(run),
    { logPath, timeoutMs: timeoutMsForMode(mode) }
  );
  return { exitCode, transcript, logPath, timedOut };
}

export async function runAgent(
  run: Run,
  mode: "execute" | "plan" = "execute",
  revise?: { resumeSessionId?: string; prompt: string }
): Promise<RunnerResult> {
  const fresh = getRun(run.id) ?? run;
  const model = resolveModelForPhase(fresh, mode);
  if (fresh.runtime === "cursor_local") return runCursor(fresh, mode, model);
  if (fresh.runtime === "codex_local") {
    return runCodex(
      fresh,
      mode,
      model ?? undefined,
      revise ? { promptOverride: revise.prompt, resumeSessionId: revise.resumeSessionId } : undefined
    );
  }
  return runClaude(
    fresh,
    mode,
    model,
    revise ? { promptOverride: revise.prompt, resumeSessionId: revise.resumeSessionId } : undefined
  );
}

/** @deprecated use stream-json extractPlanMarkdown via persistRunOutput */
export function extractPlanFromTranscript(transcript: string): string {
  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        result?: string;
        message?: { content?: Array<{ text?: string }> };
      };
      if (obj.type === "result" && obj.result) return obj.result;
      if (obj.message?.content) {
        const text = obj.message.content.map((c) => c.text ?? "").join("");
        if (text.length > 50) return text;
      }
    } catch {
      // skip
    }
  }
  return transcript.slice(-8000);
}
