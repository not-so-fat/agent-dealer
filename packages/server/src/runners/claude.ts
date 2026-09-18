// packages/server/src/runners/claude.ts
//
// The legacy `Run` runner, reduced to its one surviving caller after NOT-71: the playbook
// reflect (runners/reflect.ts). `runAgent`/`runCursor` and the codex runner drove the
// deleted plan/execute product's dispatcher; the coordinator spawns developer/reviewer
// sessions through coordinator/spawn.ts instead, which shares only `spawnCli`.
import fs from "node:fs";
import path from "node:path";
import type { Run } from "@agent-dealer/shared";
import { buildReflectPrompt, workspaceForRun } from "./prompts.js";
import { resolveClaudeBin } from "../cli-env.js";
import { resolveBudgetForPhase } from "../repository/runs.js";
import { budgetCliArgs } from "@agent-dealer/shared";
import { buildClaudeReflectArgs } from "./claude-args.js";
import { logPathFor, spawnCli, timeoutMsForMode, type RunnerResult } from "./spawn-cli.js";

/** Runs the reflect phase for a finished legacy run. `promptOverride` is what reflect.ts
 * passes; the fallback keeps the prompt source next to the args that permit it. */
export async function runClaudeReflect(
  run: Run,
  opts?: { promptOverride?: string }
): Promise<RunnerResult> {
  const mcpConfig =
    process.env.CLAUDE_MCP_CONFIG ?? path.join(process.env.HOME ?? "", ".claude.json");
  if (!fs.existsSync(mcpConfig)) {
    throw new Error(`MCP config not found: ${mcpConfig}. Set CLAUDE_MCP_CONFIG.`);
  }

  const prompt = opts?.promptOverride ?? buildReflectPrompt(run, { trigger: "retry" });
  const logPath = logPathFor(run, "reflect");

  const args = [
    "-p",
    prompt,
    "--mcp-config",
    mcpConfig,
    ...budgetCliArgs(resolveBudgetForPhase(run, "reflect")),
    ...buildClaudeReflectArgs(),
  ];

  const { exitCode, transcript, timedOut } = await spawnCli(
    run.id,
    resolveClaudeBin(),
    args,
    workspaceForRun(run),
    { logPath, timeoutMs: timeoutMsForMode("reflect") }
  );
  return { exitCode, transcript, logPath, timedOut };
}
