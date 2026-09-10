import type { WorkerSession } from "@agent-dealer/shared";
import { resolveClaudeBin, resolveCodexBin, resolveCursorBin } from "../cli-env.js";
import { spawnCli, type RunnerResult } from "../runners/spawn-cli.js";
import { buildDeveloperArgs, buildReviewerArgs } from "./args.js";

const SESSION_TIMEOUT_MS = Number(process.env.COORDINATOR_SESSION_TIMEOUT_MS ?? 60 * 60_000);

function binFor(runtime: WorkerSession["runtime"]): string {
  if (runtime === "codex_local") return resolveCodexBin();
  if (runtime === "cursor_local") return resolveCursorBin();
  return resolveClaudeBin();
}

async function spawn(session: WorkerSession, args: string[]): Promise<RunnerResult> {
  if (!session.worktreePath) throw new Error(`Session ${session.id} has no worktreePath to spawn into`);
  const logPath = `${session.worktreePath}.log`;
  const { exitCode, transcript, timedOut } = await spawnCli(session.id, binFor(session.runtime), args, session.worktreePath, {
    logPath,
    timeoutMs: SESSION_TIMEOUT_MS,
  });
  return { exitCode, transcript, logPath, timedOut };
}

export function spawnDeveloperSession(session: WorkerSession, prompt: string): Promise<RunnerResult> {
  return spawn(session, buildDeveloperArgs(session.runtime ?? "claude_code", prompt, session.model ?? undefined));
}

export function spawnReviewerSession(session: WorkerSession, prompt: string): Promise<RunnerResult> {
  return spawn(session, buildReviewerArgs(session.runtime ?? "claude_code", prompt, session.model ?? undefined));
}
