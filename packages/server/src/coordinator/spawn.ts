// packages/server/src/coordinator/spawn.ts
//
// The real per-runtime developer/reviewer CLI spawn wrapper. `runners/claude.ts`'s
// runClaude/runCursor/runCodex are hardcoded to the legacy `Run` shape and a closed
// plan|execute|reflect|qa mode union (design doc §Coordinator) — they cannot take a
// developer/reviewer session's prompt/policy directly, so this is new spawn glue reusing
// only the generic, already-role-agnostic pieces: `spawnCli` (process lifecycle) and
// `buildDeveloperArgs`/`buildReviewerArgs` (per-runtime arg/permission generation, NOT-60).
//
// `DeveloperSpawn`/`ReviewerSpawn` are the injectable seams — production code uses
// `realDeveloperSpawn`/`realReviewerSpawn`, tests inject a fake so no paid CLI is ever
// spawned in CI (the confirmed NOT-61/62 scope call: fake the agent session, keep
// worktree/push/PR/review verification real).
import path from "node:path";
import type { PermissionPolicy, Runtime } from "@agent-dealer/shared";
import { getTemporalLogsDir } from "../paths.js";
import { resolveClaudeBin, resolveCodexBin, resolveCursorBin } from "../cli-env.js";
import { spawnCli } from "../runners/spawn-cli.js";
import { buildDeveloperArgs, buildReviewerArgs } from "./args.js";
import { assertReviewerReadOnly } from "./permissions.js";
import { extractResultTranscript } from "./usage.js";

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
  /**
   * Path to the per-attempt Agent Deck MCP config carrying this attempt's minted
   * execution authority (NOT-87/92) — absent when the profile has no deckId. Meaning is
   * runtime-specific: a `--mcp-config` file for claude, a scoped `.cursor/mcp.json`
   * (inside the worktree) for cursor, or a `CODEX_HOME` directory for codex. Never merged
   * with any ambient/user config, so a spawned worker's only route to Agent Deck is this
   * one short-lived, scoped server.
   */
  mcpConfigPath?: string;
  /** Extra process env the spawned CLI needs to resolve mcpConfigPath (codex's bearer-token env var). */
  mcpEnv?: Record<string, string>;
  /** When set, write the NDJSON stream here (NOT-109 live strip / activity sampler). */
  logPath?: string;
}

export function developerSessionLogPath(sessionId: string): string {
  return path.join(getTemporalLogsDir(), `${sessionId}-developer-${Date.now()}.ndjson`);
}

export function reviewerSessionLogPath(sessionId: string): string {
  return path.join(getTemporalLogsDir(), `${sessionId}-reviewer-${Date.now()}.ndjson`);
}

export type DeveloperSpawn = (input: DeveloperSpawnInput) => Promise<DeveloperSpawnResult>;

/** Same shape as a developer spawn — the reviewer session is a one-shot CLI run too. */
export type ReviewerSpawnResult = DeveloperSpawnResult;
export type ReviewerSpawnInput = DeveloperSpawnInput;
export type ReviewerSpawn = (input: ReviewerSpawnInput) => Promise<ReviewerSpawnResult>;

const BIN_FOR: Record<Runtime, () => string> = {
  claude_code: resolveClaudeBin,
  cursor_local: resolveCursorBin,
  codex_local: resolveCodexBin,
};

export const realDeveloperSpawn: DeveloperSpawn = async (input) => {
  const args = buildDeveloperArgs(input.runtime, input.prompt, input.model ?? undefined, input.policy, input.mcpConfigPath);
  const logPath = input.logPath ?? developerSessionLogPath(input.sessionId);
  const { exitCode, transcript, timedOut } = await spawnCli(
    input.sessionId,
    BIN_FOR[input.runtime](),
    args,
    input.cwd,
    { logPath, timeoutMs: input.timeoutMs, env: input.mcpEnv }
  );
  return { exitCode, transcript: extractResultTranscript(logPath, input.runtime, transcript), logPath, timedOut };
};

/**
 * Asserts the read-only invariant on the generated args before every real reviewer spawn
 * — not just in tests — so a future change to `buildReviewerArgs`/`roleCeiling` that
 * loosens a reviewer's tools can never silently reach a live spawn.
 */
export const realReviewerSpawn: ReviewerSpawn = async (input) => {
  const args = buildReviewerArgs(input.runtime, input.prompt, input.model ?? undefined, input.policy, input.mcpConfigPath);
  assertReviewerReadOnly(args);
  const logPath = input.logPath ?? reviewerSessionLogPath(input.sessionId);
  const { exitCode, transcript, timedOut } = await spawnCli(
    input.sessionId,
    BIN_FOR[input.runtime](),
    args,
    input.cwd,
    { logPath, timeoutMs: input.timeoutMs, env: input.mcpEnv }
  );
  return { exitCode, transcript: extractResultTranscript(logPath, input.runtime, transcript), logPath, timedOut };
};
