// packages/server/src/coordinator/spawn.ts
//
// The real per-runtime developer CLI spawn wrapper. `runners/claude.ts`'s runClaude/
// runCursor/runCodex are hardcoded to the legacy `Run` shape and a closed
// plan|execute|reflect|qa mode union (design doc §Coordinator) — they cannot take a
// developer session's prompt/policy directly, so this is new spawn glue reusing only the
// generic, already-role-agnostic pieces: `spawnCli` (process lifecycle) and
// `buildDeveloperArgs` (per-runtime arg/permission generation, NOT-60).
//
// `DeveloperSpawn` is the injectable seam — production code uses `realDeveloperSpawn`,
// tests inject a fake so no paid CLI is ever spawned in CI (the confirmed NOT-61 scope
// call: fake the agent session, keep worktree/push/PR verification real).
import path from "node:path";
import type { PermissionPolicy, Runtime } from "@agent-dealer/shared";
import { getTemporalLogsDir } from "../paths.js";
import { resolveClaudeBin, resolveCodexBin, resolveCursorBin } from "../cli-env.js";
import { spawnCli } from "../runners/spawn-cli.js";
import { buildDeveloperArgs } from "./args.js";

export interface DeveloperSpawnResult {
  exitCode: number;
  transcript: string;
  logPath: string;
  timedOut: boolean;
}

export interface DeveloperSpawnInput {
  sessionId: string;
  runtime: Runtime;
  policy: PermissionPolicy;
  model: string | null;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}

export type DeveloperSpawn = (input: DeveloperSpawnInput) => Promise<DeveloperSpawnResult>;

const BIN_FOR: Record<Runtime, () => string> = {
  claude_code: resolveClaudeBin,
  cursor_local: resolveCursorBin,
  codex_local: resolveCodexBin,
};

function developerLogPath(sessionId: string): string {
  return path.join(getTemporalLogsDir(), `${sessionId}-developer-${Date.now()}.ndjson`);
}

export const realDeveloperSpawn: DeveloperSpawn = async (input) => {
  const args = buildDeveloperArgs(input.runtime, input.prompt, input.model ?? undefined, input.policy);
  const logPath = developerLogPath(input.sessionId);
  const { exitCode, transcript, timedOut } = await spawnCli(
    input.sessionId,
    BIN_FOR[input.runtime](),
    args,
    input.cwd,
    { logPath, timeoutMs: input.timeoutMs }
  );
  return { exitCode, transcript, logPath, timedOut };
};
