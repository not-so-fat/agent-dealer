// packages/server/src/adapters/agent-deck-bind.ts
//
// Server-side Agent Deck preflight for a worker session (NOT-106). Before a
// developer/reviewer session spawns, the coordinator materializes a per-attempt,
// runtime-specific MCP config that sends `x-agent-deck-deck-id` (+ workspace) with
// **no** Authorization — Agent Deck's launch-fixed deck session (NOT-105). Then it
// verifies with a live `get_bound_deck` before spawn.
//
// Worker prompts still instruct `bind_workspace` first; under a launch-fixed deck that
// bind confirms the equipped deck (and rejects a different one with DECK_FIXED).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PermissionPolicy, Runtime } from "@agent-dealer/shared";
import { getAgentDeckMcpUrl } from "./agent-deck.js";
import { getWorkerMcpConfigDir } from "../paths.js";
import { resolveAmbientCodexHome } from "../cli-env.js";
import { codexMcpServersTable } from "./codex-scoped-config.js";

const CODEX_HOME_ENV_VAR = "CODEX_HOME";

/** One tool call within a single connected MCP session. */
export type DeckToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type WorkerDeckConnectionOutcome =
  | {
      ok: true;
      /** Runtime-specific: a claude `--mcp-config` file, a codex `CODEX_HOME` directory,
       * or the cursor worktree `.cursor/mcp.json` path. */
      mcpConfigPath: string;
      /** Extra env the spawned CLI needs — codex needs `CODEX_HOME` pointed at the scoped directory. */
      mcpEnv?: Record<string, string>;
    }
  | { ok: false; kind: "infra_failure"; reason: string }
  /** NOT-136: nothing answered at all (refused / DNS / timeout). Not the agent's fault and
   * not retryable on a ~3s cadence — the caller defers instead of spending an infra attempt. */
  | { ok: false; kind: "deck_unavailable"; reason: string };

/**
 * NOT-136: a preflight call got no answer at all. Raised **only** where a call is awaited
 * (`withinPreflightDeadline`), never by the assertions that judge an answer we did receive —
 * so a deck that is up and reports its own upstream as down (`isError: true` with the text
 * `fetch failed`, the NOT-101 shape) still fails the attempt instead of looking like a dead
 * port just because its prose reads like one.
 */
class DeckUnreachableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The shared preflight budget ran out — no answer, as opposed to an answer we rejected. */
class PreflightTimeoutError extends DeckUnreachableError {
  constructor(message: string) {
    super(new Error(message));
  }
}

/**
 * NOT-136: the shape of a transport-level failure — *nothing was listening / nothing
 * answered*. A shape test alone cannot separate "the deck is down" from "the deck told us
 * something that reads like it", so this is only ever applied to an error thrown out of an
 * awaited call, never to one raised about a received result.
 */
const UNREACHABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/** `fetch failed` is what undici surfaces to us when the port is dead — the literal string
 * observed in the NOT-136 incident. The rest are the same conditions reported as prose by
 * intermediate layers that dropped the `cause` chain. Prose is the *last* resort, and only
 * after `deckAnswered` has ruled out a response — see below. */
const UNREACHABLE_MESSAGE_RE =
  /\bfetch failed\b|\bsocket hang up\b|\bgetaddrinfo\b|\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/i;

/** An HTTP status code — the range a real response can carry. */
function isHttpStatus(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * Structural proof that the deck **answered**, which vetoes every heuristic below.
 *
 * The MCP SDK reports a non-2xx response by throwing `StreamableHTTPError(status, "Error
 * POSTing to endpoint: <body>")` — the response body is pasted into the message. So a deck
 * that is up and returns HTTP 500 with the body `fetch failed` (the NOT-101 shape, where the
 * deck's own upstream is down) produces an error that reads exactly like a dead port. Message
 * matching cannot tell those apart; an HTTP status can, and it is dispositive: bytes came
 * back, so this is a real deck error and must still fail the attempt (NOT-136).
 */
function deckAnswered(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 5) return false;
  if (err instanceof StreamableHTTPError) return true;
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown; errors?: unknown };
  // Belt and braces for a duplicated SDK copy, where `instanceof` silently fails:
  // StreamableHTTPError carries the response status as a *numeric* `code` (node's transport
  // errors all use string codes like ECONNREFUSED), and other clients use status/statusCode.
  if (isHttpStatus(e.code) || isHttpStatus(e.status) || isHttpStatus(e.statusCode)) return true;
  if (Array.isArray(e.errors) && e.errors.some((nested) => deckAnswered(nested, depth + 1))) return true;
  return e.cause !== undefined && deckAnswered(e.cause, depth + 1);
}

/** Walks `cause` / `AggregateError.errors` — node's fetch buries the real code one or two levels down. */
function hasUnreachableSignal(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 5) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && UNREACHABLE_ERROR_CODES.has(e.code)) return true;
  if (typeof e.message === "string" && UNREACHABLE_MESSAGE_RE.test(e.message)) return true;
  if (Array.isArray(e.errors) && e.errors.some((nested) => hasUnreachableSignal(nested, depth + 1))) return true;
  return e.cause !== undefined && hasUnreachableSignal(e.cause, depth + 1);
}

/** True only when nothing answered: a transport signal *and* no sign of an HTTP response. */
export function isDeckUnreachableError(err: unknown): boolean {
  if (deckAnswered(err)) return false;
  return hasUnreachableSignal(err);
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  return Array.isArray(content)
    ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n").trim()
    : "";
}

/** MCP surfaces tool failures as `{ isError: true }` results, not thrown errors. */
export function assertToolResultOk(result: unknown, name: string): void {
  if ((result as { isError?: boolean } | null)?.isError) {
    throw new Error(`${name} returned an error: ${resultText(result) || "(no detail)"}`);
  }
}

/** Pull the text payload out of a (non-error) MCP tool result and JSON-parse it. */
export function parseDeckToolResult(result: unknown): Record<string, unknown> {
  const text = resultText(result);
  if (!text) throw new Error("empty tool result");
  return JSON.parse(text) as Record<string, unknown>;
}

interface MaterializedMcpConfig {
  mcpConfigPath: string;
  mcpEnv?: Record<string, string>;
}

const CODEX_AUTH_POLICY_KEYS = [
  "cli_auth_credentials_store",
  "chatgpt_base_url",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
] as const;

function readAmbientCodexAuthPolicy(ambientCodexHome: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(ambientCodexHome, "config.toml"), "utf8");
    const root = parseToml(raw) as Record<string, unknown>;
    const policy: Record<string, unknown> = {};
    for (const key of CODEX_AUTH_POLICY_KEYS) {
      if (key in root && (typeof root[key] === "string" || typeof root[key] === "number" || typeof root[key] === "boolean")) {
        policy[key] = root[key];
      }
    }
    return policy;
  } catch {
    return {};
  }
}

function deckLaunchHeaders(deckId: string, worktreePath: string): Record<string, string> {
  return {
    "x-agent-deck-deck-id": deckId,
    "x-agent-deck-workspace": worktreePath,
  };
}

/** claude's `--mcp-config` file schema — deck headers only, no Authorization. */
function urlHeaderMcpConfig(mcpUrl: string, deckId: string, worktreePath: string) {
  return {
    mcpServers: {
      "agent-deck": {
        type: "http",
        url: mcpUrl,
        headers: deckLaunchHeaders(deckId, worktreePath),
      },
    },
  };
}

function gitCaptured(worktreePath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", ["-C", worktreePath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

function isCursorMcpTracked(worktreePath: string): boolean {
  const result = gitCaptured(worktreePath, ["ls-files", "--error-unmatch", ".cursor/mcp.json"]);
  return result.ok;
}

/** Append `/.cursor/mcp.json` idempotently to git's info/exclude.
 *
 * Note: for a linked worktree, `git rev-parse --git-path info/exclude` resolves to the
 * *main* repository's `.git/info/exclude` (shared across all worktrees of that repo), not
 * a per-worktree file. The `/.cursor/mcp.json` pattern is still correct per worktree root;
 * we rewrite with a single occurrence so concurrent preparations can't leave duplicate lines. */
function ensureCursorMcpExcluded(worktreePath: string): void {
  const excludePathResult = gitCaptured(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excludePathResult.ok) {
    throw new Error(`could not resolve git info/exclude: ${excludePathResult.stderr || "unknown error"}`);
  }
  const excludePath = path.resolve(worktreePath, excludePathResult.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const line = "/.cursor/mcp.json";
  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const kept = existing
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && l.trim() !== line);
  kept.push(line);
  fs.writeFileSync(excludePath, `${kept.join("\n")}\n`, { mode: 0o644 });
}

/**
 * Writes this attempt's deck-launch MCP config as the spawned worker's route to Agent Deck
 * (NOT-106) — no mint, no Authorization.
 *
 * - claude: JSON file outside the worktree (`--mcp-config --strict-mcp-config`).
 * - codex: per-attempt `CODEX_HOME` outside the worktree with `http_headers` in config.toml.
 * - cursor: `<worktree>/.cursor/mcp.json` + info/exclude so the worktree stays porcelain-clean.
 */
async function materializeWorkerMcpConfig(opts: {
  runtime: Runtime;
  deckId: string;
  worktreePath: string;
  /**
   * The session's resolved policy. The scoped config is the only place a codex session's
   * tool surface can be narrowed — codex has no `--disallowedTools` equivalent — so a
   * policy-blind config silently grants whatever the deck exposes (NOT-134).
   */
  policy: PermissionPolicy;
}): Promise<MaterializedMcpConfig> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const mcpUrl = `${mcpBase}/mcp`;
  const headers = deckLaunchHeaders(opts.deckId, opts.worktreePath);

  // Muse Code has no Agent Deck / MCP wiring (NOT-178 non-goal; NOT-181 owns it). Refuse before
  // anything is written rather than fall through to the Claude config below.
  if (opts.runtime === "muse_code") {
    throw new Error("Muse Code does not support Agent Deck MCP configuration");
  }

  if (opts.runtime === "codex_local") {
    const codexHome = path.join(getWorkerMcpConfigDir(), `codex-home-${opts.deckId.slice(0, 8)}-${randomUUID()}`);
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    try {
      const ambientHome = resolveAmbientCodexHome();
      try {
        const ambientAuthPath = path.join(ambientHome, "auth.json");
        if (fs.existsSync(ambientAuthPath)) {
          fs.symlinkSync(ambientAuthPath, path.join(codexHome, "auth.json"));
        }
      } catch {
        // best-effort — OS-keychain-backed hosts have no auth.json
      }
      const toml = stringifyToml({
        ...readAmbientCodexAuthPolicy(ambientHome),
        mcp_servers: codexMcpServersTable({
          mcpUrl,
          headers,
          allowOutboundMutation: opts.policy.outboundMutation,
        }),
      });
      fs.writeFileSync(path.join(codexHome, "config.toml"), toml, { mode: 0o600 });
    } catch (err) {
      fs.rmSync(codexHome, { recursive: true, force: true });
      throw err;
    }
    return {
      mcpConfigPath: codexHome,
      mcpEnv: { [CODEX_HOME_ENV_VAR]: codexHome },
    };
  }

  if (opts.runtime === "cursor_local") {
    if (isCursorMcpTracked(opts.worktreePath)) {
      throw new Error(
        ".cursor/mcp.json is tracked in this repository — refusing to overwrite a tracked file for the worker MCP config"
      );
    }
    ensureCursorMcpExcluded(opts.worktreePath);
    const cursorDir = path.join(opts.worktreePath, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const filePath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { "agent-deck": { url: mcpUrl, headers } } }, null, 2) + "\n",
      { mode: 0o600 }
    );
    return { mcpConfigPath: filePath };
  }

  // claude_code — the only runtime left.
  const dir = getWorkerMcpConfigDir();
  const filePath = path.join(dir, `claude-mcp-${opts.deckId.slice(0, 8)}-${randomUUID()}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(urlHeaderMcpConfig(mcpUrl, opts.deckId, opts.worktreePath)), { mode: 0o600 });
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return { mcpConfigPath: filePath };
}

/** `get_bound_deck`'s deck-identity field. */
function assertBoundDeckMatches(result: unknown, expectedDeckId: string): void {
  const payload = parseDeckToolResult(result);
  const boundDeckId = typeof payload.id === "string" ? payload.id : undefined;
  if (boundDeckId !== expectedDeckId) {
    throw new Error(`get_bound_deck returned deck ${boundDeckId ?? "(missing id)"}, expected ${expectedDeckId}`);
  }
}

function assertPlaybookMatches(result: unknown, expectedPlaybookId: string): void {
  const payload = parseDeckToolResult(result);
  const playbookId = typeof payload.id === "string" ? payload.id : undefined;
  if (playbookId !== expectedPlaybookId) {
    throw new Error(
      `get_playbook returned ${playbookId ?? "(missing id)"}, expected ${expectedPlaybookId}`
    );
  }
}

type VerifyDeckResult =
  | { ok: true }
  | { ok: false; kind: "infra_failure" | "deck_unavailable"; reason: string };

/**
 * Single classification point for every preflight error. The split is decided by *where* the
 * error came from, not by how it reads: only the call boundary raises `DeckUnreachableError`.
 */
function verifyFailed(err: unknown): VerifyDeckResult {
  const reason = err instanceof Error ? err.message : String(err);
  return err instanceof DeckUnreachableError
    ? { ok: false, kind: "deck_unavailable", reason }
    : { ok: false, kind: "infra_failure", reason };
}

/**
 * Run one preflight operation inside the shared absolute deadline and clear its timer.
 * This is the one place a preflight awaits the deck, so it is also the one place a
 * transport failure is recognized as the deck being unreachable (NOT-136).
 */
async function withinPreflightDeadline<T>(opts: {
  label: string;
  deadlineMs: number;
  timeoutMs: number;
  run: () => Promise<T>;
}): Promise<T> {
  const remainingMs = opts.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new PreflightTimeoutError(`${opts.label} timed out after ${opts.timeoutMs}ms total preflight budget`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PreflightTimeoutError(`${opts.label} timed out after ${opts.timeoutMs}ms total preflight budget`)),
      remainingMs
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(opts.run), timeout]);
  } catch (err) {
    if (err instanceof DeckUnreachableError) throw err;
    throw isDeckUnreachableError(err) ? new DeckUnreachableError(err) : err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function verifyDeckConnection(opts: {
  deckId: string;
  worktreePath: string;
  playbookIds: string[];
  callTool?: DeckToolCaller;
  timeoutMs: number;
}): Promise<VerifyDeckResult> {
  const deadlineMs = Date.now() + opts.timeoutMs;
  const callBeforeDeadline = <T>(label: string, run: () => Promise<T>) =>
    withinPreflightDeadline({ label, deadlineMs, timeoutMs: opts.timeoutMs, run });

  if (opts.callTool) {
    let result: unknown;
    try {
      result = await callBeforeDeadline("get_bound_deck", () =>
        opts.callTool!("get_bound_deck", {})
      );
    } catch (err) {
      return verifyFailed(err);
    }
    try {
      assertToolResultOk(result, "get_bound_deck");
      assertBoundDeckMatches(result, opts.deckId);
      for (const playbookId of new Set(opts.playbookIds)) {
        const playbook = await callBeforeDeadline(`get_playbook(${playbookId})`, () =>
          opts.callTool!("get_playbook", { playbook_id: playbookId })
        );
        assertToolResultOk(playbook, `get_playbook(${playbookId})`);
        assertPlaybookMatches(playbook, playbookId);
      }
      return { ok: true };
    } catch (err) {
      return verifyFailed(err);
    }
  }
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers: deckLaunchHeaders(opts.deckId, opts.worktreePath) },
  });
  const client = new Client({ name: "agent-dealer-deck-preflight", version: "0.0.1" });
  try {
    await callBeforeDeadline("Agent Deck connection", () => client.connect(transport));
    const result = await callBeforeDeadline("get_bound_deck", () =>
      client.callTool({ name: "get_bound_deck", arguments: {} })
    );
    assertToolResultOk(result, "get_bound_deck");
    assertBoundDeckMatches(result, opts.deckId);
    for (const playbookId of new Set(opts.playbookIds)) {
      const playbook = await callBeforeDeadline(`get_playbook(${playbookId})`, () =>
        client.callTool({ name: "get_playbook", arguments: { playbook_id: playbookId } })
      );
      assertToolResultOk(playbook, `get_playbook(${playbookId})`);
      assertPlaybookMatches(playbook, playbookId);
    }
    return { ok: true };
  } catch (err) {
    return verifyFailed(err);
  } finally {
    try {
      await client.close();
    } catch {
      // best-effort after a connection or deadline failure
    }
  }
}

/**
 * Materialize a per-attempt MCP config for the profile's deck and verify with
 * `get_bound_deck` and every configured playbook before spawn. No mint, no ledger, no
 * Authorization. A deck-bound worker is fail-closed: missing playbook authority is an
 * infrastructure failure, never permission to improvise without the configured recipe.
 *
 * NOT-136: "the deck said no" and "the deck is not running" are different outcomes. Only the
 * former is `infra_failure` (a spent attempt); an unreachable deck returns `deck_unavailable`
 * so the caller can wait for it to come back.
 */
export async function prepareWorkerDeckConnection(opts: {
  deckId: string;
  worktreePath: string;
  runtime: Runtime;
  playbookIds?: string[];
  /** Session policy — narrows the materialized MCP config's tool surface (NOT-134). */
  policy: PermissionPolicy;
  verifyCallTool?: DeckToolCaller;
  timeoutMs?: number;
}): Promise<WorkerDeckConnectionOutcome> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DECK_BIND_TIMEOUT_MS ?? 30_000);

  let materialized: MaterializedMcpConfig;
  try {
    materialized = await materializeWorkerMcpConfig({
      runtime: opts.runtime,
      deckId: opts.deckId,
      worktreePath: opts.worktreePath,
      policy: opts.policy,
    });
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: `MCP materialization failed: ${(err as Error).message}` };
  }

  const verified = await verifyDeckConnection({
    deckId: opts.deckId,
    worktreePath: opts.worktreePath,
    playbookIds: opts.playbookIds ?? [],
    callTool: opts.verifyCallTool,
    timeoutMs,
  });
  if (!verified.ok) {
    try {
      fs.rmSync(materialized.mcpConfigPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return verified.kind === "deck_unavailable"
      ? { ok: false, kind: "deck_unavailable", reason: `Agent Deck is unreachable — ${verified.reason}` }
      : { ok: false, kind: "infra_failure", reason: `preflight failed: ${verified.reason}` };
  }

  return { ok: true, mcpConfigPath: materialized.mcpConfigPath, mcpEnv: materialized.mcpEnv };
}

/** Best-effort cleanup of the on-disk MCP config after a spawn ends. */
export async function releaseWorkerDeckConnection(opts: { mcpConfigPath: string }): Promise<void> {
  try {
    fs.rmSync(opts.mcpConfigPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
