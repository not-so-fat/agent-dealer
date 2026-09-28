// packages/server/src/coordinator/muse-spawn.ts
//
// NOT-278: the native Muse Code developer spawn. Every deck-enabled Muse developer turn runs the
// isolated `muse exec` lane: one exact, fail-closed per-attempt home built by
// `prepareMuseAttempt` (runners/muse-config.ts) — settings.json with exactly one required
// `agent-deck` server (deck/workspace headers), filtered env, stdin-only API key — verified
// immediately before spawn and removed afterwards on every outcome.
//
// The shared Muse serve host cannot carry per-session MCP configuration or deck/workspace
// headers (`session/start` accepts only command, workspace, model, and approval mode), so the
// serve lane is never used here. Fresh 5H/1W observation from the serve host is deliberately
// suspended while deck-enabled work is forced to exec; capacity stays honest N/A/stale with
// last-good rows preserved. Per-session Agent Deck support in the serve protocol is a non-goal.
//
// Muse cannot disable `cron_*` (NOT-177). The tool activity is checked here after the fact and
// surfaced as `cronCalls`; the effect turns that into a `muse_cron_used` escalation. It detects,
// it does not prevent.
import fs from "node:fs";
import path from "node:path";
import { MUSE_CODE_CONTRIBUTOR_MODEL } from "@agent-dealer/shared";
import { resolveMuseAuthFile, resolveMuseBin } from "../cli-env.js";
import { getAgentDeckMcpUrl } from "../adapters/agent-deck.js";
import { getWorkerMcpConfigDir } from "../paths.js";
import {
  prepareMuseAttempt,
  type MuseAttempt,
  type MuseCredential,
} from "../runners/muse-config.js";
import {
  parseMuseRun,
  type MuseFailure,
  type MuseUsage,
} from "../runners/muse-code-jsonl.js";
import { spawnCli } from "../runners/spawn-cli.js";
import type { DeveloperSpawnInput, DeveloperSpawnResult } from "./spawn.js";

/**
 * Step cap when the profile sets no `maxTurns`. High on purpose (the PoC's value): the developer
 * wall-clock timeout is the real limit, the cap only stops a runaway loop.
 */
export const DEFAULT_MUSE_MAX_MODEL_STEPS = 300;

/** Muse cannot disable these; any call in a session's tool activity fails it as `muse_cron_used`. */
const CRON_TOOL_RE = /^cron_(create|list|delete)$/;

const STDERR_MARKER = "\n--- stderr ---\n";

export interface MuseSessionSummary {
  /** Caller-chosen id passed as `--session-id`; names the on-disk session log. */
  museSessionId: string;
  /** The model the server confirmed, not the one requested; null when it never did. */
  confirmedModel: string | null;
  usage: MuseUsage;
  /** Non-null means the session is not a success whatever the exit code said. */
  failure: MuseFailure | null;
  /** `cron_*` tool names seen in the session's tool activity, in order. */
  cronCalls: string[];
  /** More than one run on stdout means something (e.g. a cron job) started a run in this process. */
  runCount: number;
  /** Where the untouched stdout was archived; null when the archive could not be written. */
  rawLogPath: string | null;
}

/** `sessions/YYYY/MM/DD/<session-id>/session.jsonl` under the attempt's data dir, if present. */
function readSessionLog(dataDir: string, museSessionId: string): string | undefined {
  const root = path.join(dataDir, "muse", "sessions");
  const visit = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === museSessionId) {
        try {
          return fs.readFileSync(path.join(child, "session.jsonl"), "utf8");
        } catch {
          return undefined;
        }
      }
      if (depth < 4) {
        const found = visit(child, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(root, 0);
}

/**
 * NOT-278: the attempt's credential. A saved login is linked, never read or copied; otherwise
 * the API key travels on stdin only (`--api-key-stdin`, written once by the launcher and never
 * logged). Missing credentials fail before spawn — nothing is written and no process starts.
 */
function resolveMuseCredential(): MuseCredential {
  const authFile = resolveMuseAuthFile();
  try {
    if (fs.existsSync(authFile)) return { kind: "auth-file", path: authFile };
  } catch {
    // An unreadable auth path is the same as a missing one: fall through to the API key.
  }
  const apiKey = process.env.META_API_KEY;
  if (apiKey !== undefined && apiKey.trim() !== "") return { kind: "api-key", apiKey };
  throw new Error("Muse Code auth required: run `muse login` or set META_API_KEY");
}

function splitSpawnLog(raw: string): { stdout: string; stderr: string } {
  const idx = raw.indexOf(STDERR_MARKER);
  return idx < 0
    ? { stdout: raw, stderr: "" }
    : { stdout: raw.slice(0, idx), stderr: raw.slice(idx + STDERR_MARKER.length) };
}

/**
 * NOT-270: reuse real Dealer Muse work as the observation opportunity. After
 * a genuine Muse session ends, kick one bounded, best-effort refresh
 * through the server-owned serve host — the proven safe point for the final
 * `usage/read`. This deliberately bypasses the GET-route throttle
 * (`maybeRefreshMuseCapacityFromHost` shares it): the final read at the
 * safe point is contractual, not opportunistic — a recent Agents-page poll
 * must never skip it. This creates no model turn of its own (the capacity
 * client only ever sends the read-only handshake/`usage/read` allowlist)
 * and never affects the session result. Exec-lane turns leave the host
 * unobserved by construction (the NOT-269 structural precondition), so the
 * read stays honest N/A with last-good rows preserved.
 */
function refreshMuseCapacityAfterSession(): void {
  void (async () => {
    try {
      const [{ configuredCapacityRuntimes }, { refreshMuseCapacityFromHost }] =
        await Promise.all([import("../capacity/service.js"), import("../capacity/muse-host.js")]);
      if (!configuredCapacityRuntimes().includes("muse_code")) return;
      await refreshMuseCapacityFromHost();
    } catch {
      // Best-effort: capacity must never break or delay a session result.
    }
  })();
}

/**
 * NOT-278: run the deck-enabled developer turn as one isolated `muse exec` attempt. Fails before
 * spawn without a frozen profile deck (the effect already maps that to `deck_failure`; this is
 * the defense in depth that keeps a deckless launch from ever reaching a child process).
 *
 * The attempt is built with `prepareMuseAttempt({ role: "developer", ... })` on a Dealer-owned
 * base directory outside the worktree and outside OS temp (the worker MCP config root), with
 * `agentDeck.url` set to the configured Agent Deck MCP endpoint ending in `/mcp` (overridable
 * for deckless infra callers), `deckId` to the frozen profile value, and `workspace` to the
 * real worktree path. Immediately before spawn the exact cwd/argv/env/stdin about to be
 * launched is verified; the child receives exactly
 * `attempt.env` (no `process.env` merge) and `attempt.stdin`, so ambient `META_API_KEY`,
 * `MUSE_*`, `CODEX_HOME`, and unrelated variables can never reach it.
 *
 * Settings, data, and the auth link are removed in `finally` on success, Muse failure,
 * timeout, abort, and spawn error — operator credentials are never touched.
 */
export async function runMuseDeveloperSession(
  input: DeveloperSpawnInput & {
    logPath: string;
    maxModelSteps?: number;
  }
): Promise<DeveloperSpawnResult> {
  const deckId = typeof input.deckId === "string" && input.deckId.trim() !== "" ? input.deckId : null;
  if (!deckId) {
    throw new Error("Muse developer session requires a frozen profile deckId — workers never start without one");
  }
  const model = input.model ?? MUSE_CODE_CONTRIBUTOR_MODEL;
  const mcpUrl =
    typeof input.agentDeckUrl === "string" && input.agentDeckUrl.trim() !== ""
      ? input.agentDeckUrl
      : `${getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "")}/mcp`;

  // prepareMuseAttempt validates everything (role controls, deck identity, credential shape,
  // unsafe paths) and writes the per-attempt dir; it removes its own dir when setup fails.
  const attempt: MuseAttempt = prepareMuseAttempt({
    role: "developer",
    worktreePath: input.cwd,
    baseDir: getWorkerMcpConfigDir(),
    agentDeck: { url: mcpUrl, deckId, workspace: input.cwd },
    credential: resolveMuseCredential(),
    sessionId: input.sessionId,
    prompt: input.prompt,
    maxModelSteps: input.maxModelSteps ?? DEFAULT_MUSE_MAX_MODEL_STEPS,
  });
  const { logPath } = input;

  let spawned: { exitCode: number; transcript: string; timedOut: boolean };
  let sessionLog: string | undefined;
  try {
    // The exact launch about to happen — a tampered settings file or a differing
    // cwd/argv/env/stdin fails here, before any process exists.
    attempt.verify({ cwd: attempt.cwd, argv: [...attempt.argv], env: { ...attempt.env }, stdin: attempt.stdin });
    spawned = await spawnCli(input.sessionId, resolveMuseBin(), [...attempt.argv], attempt.cwd, {
      logPath,
      timeoutMs: input.timeoutMs,
      env: { ...attempt.env },
      exactEnv: true,
      stdin: attempt.stdin,
      signal: input.signal,
      onSpawn: input.onSpawn,
    });
    sessionLog = readSessionLog(attempt.env.XDG_DATA_HOME, input.sessionId);
  } finally {
    attempt.cleanup();
  }

  const rawLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : spawned.transcript;
  const { stdout, stderr } = splitSpawnLog(rawLog);
  const run = parseMuseRun({
    stdout,
    stderr,
    exitCode: spawned.timedOut ? null : spawned.exitCode,
    sessionLog,
    expectedModel: model,
  });
  const cronCalls = run.tools.map((t) => t.name).filter((n): n is string => n !== null && CRON_TOOL_RE.test(n));

  const summary: MuseSessionSummary = {
    museSessionId: input.sessionId,
    confirmedModel: run.confirmedModel,
    usage: run.usage,
    failure: run.failure,
    cronCalls,
    runCount: run.runCount,
    rawLogPath: null,
  };

  // The raw envelopes stay as evidence; the log path every reader knows becomes the normalized stream.
  const rawLogPath = `${logPath.replace(/\.ndjson$/, "")}.muse-raw.jsonl`;
  try {
    fs.writeFileSync(rawLogPath, rawLog);
    summary.rawLogPath = rawLogPath;
  } catch {
    // evidence copy is best-effort; the normalized log below still carries the outcome
  }
  const events = run.events.map((e) =>
    e.type === "result" ? { ...e, muse: { ...summary, usage: run.usage } } : e
  );
  fs.writeFileSync(
    logPath,
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n${stderr.trim() ? `${STDERR_MARKER}${stderr}` : ""}`
  );

  // The real session above is the observation opportunity: kick the
  // best-effort capacity refresh (no synthetic turn, never throws, never
  // blocks this result).
  refreshMuseCapacityAfterSession();

  return {
    // A failed session must not read as success just because Muse exited 0 (wrong model, no terminal event).
    exitCode: run.failure && spawned.exitCode === 0 ? 1 : spawned.exitCode,
    transcript: run.finalText ?? "",
    logPath,
    timedOut: spawned.timedOut,
    muse: summary,
  };
}
