// packages/server/src/adapters/agent-deck-bind.ts
//
// Server-side Agent Deck preflight for a worker session (NOT-87/92). A generated worktree
// must never inherit a persistent, path-scoped credential, so before a developer/reviewer
// session spawns the coordinator mints a short-lived execution authority for this specific
// attempt (NOT-85 §5.2), materializes a per-attempt, runtime-specific MCP config carrying
// that authority as the spawned worker's *only* way to reach Agent Deck (see
// `materializeWorkerMcpConfig`), and hands the result back for `spawn.ts` to wire into the
// runtime's own CLI invocation.
//
// This replaces the NOT-60 `bindAndVerify`/`bind_workspace` preflight: under execution
// authority, `bind_workspace` is deny-by-default control-plane (Deck returns
// INTERACTION_REQUIRED for it unconditionally — the deck/scope is already pinned by the
// authority at mint time, per NOT-86's as-built `EXECUTION_AUTHORITY_ALLOWED_TOOLS`
// allowlist). A live `get_bound_deck` round-trip using the freshly minted authority
// stands in for the old bind+verify round-trip, catching a bad mint (wrong deck,
// audience mismatch) before the paid worker session ever spawns.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Runtime } from "@agent-dealer/shared";
import { getAgentDeckMcpUrl } from "./agent-deck.js";
import { mintAuthority as defaultMintAuthority, revokeAuthority, type MintAuthorityInput, type MintAuthorityResult } from "./execution-authority.js";
import { getExecutionAuthorityConfigDir } from "../paths.js";
import { resolveAmbientCodexHome } from "../cli-env.js";

export { revokeAuthority };

// Fallback only — every real caller (developer-effect.ts, reviewer-effect.ts) passes an
// explicit ttlMs derived from that role's own session timeout. A fixed default here would
// otherwise be silently shorter than a configurable session timeout and expire the
// authority mid-session (PR #19 review).
const DEFAULT_TTL_MS = 30 * 60_000;

/**
 * Added on top of a role's own (configurable) session timeout to get the authority's
 * ttlMs — covers the mint + live `get_bound_deck` verify round-trip that happens
 * *before* the spawned session's own timeout clock starts, so the authority can't
 * expire mid-session even at that timeout's exact edge.
 */
export const AUTHORITY_TTL_HEADROOM_MS = 5 * 60_000;

const CODEX_BEARER_ENV_VAR = "AGENT_DECK_AUTHORITY_BEARER";
const CODEX_HOME_ENV_VAR = "CODEX_HOME";

/**
 * Runtimes execution authority can materialize an isolated, single-server MCP config
 * for. `cursor_local` is deliberately excluded (PR #19 review): cursor-agent loads
 * project *and* global `.cursor/mcp.json` and has no flag to isolate one from the
 * other, so `--approve-mcps` would auto-approve every ambient MCP server on the
 * machine, not just a freshly-scoped one — a worse hole than the ambient access cursor
 * already had before this ticket. Until cursor ships a real isolation mechanism,
 * `acquireWorkerAuthority` refuses to mint for it rather than claim a scoping
 * guarantee it cannot enforce.
 */
const AUTHORITY_SUPPORTED_RUNTIMES: ReadonlySet<Runtime> = new Set(["claude_code", "codex_local"]);

/** One tool call within a single connected MCP session. */
export type DeckToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type WorkerAuthorityOutcome =
  | {
      ok: true;
      authorityId: string;
      /** Runtime-specific: a claude `--mcp-config` file, or a codex `CODEX_HOME`
       * directory — see `materializeWorkerMcpConfig`. */
      mcpConfigPath: string;
      /** Extra env the spawned CLI needs to resolve mcpConfigPath — codex needs both
       * `CODEX_HOME` (pointed at the scoped directory) and its bearer-token env var
       * (read from the environment, never written to config.toml). */
      mcpEnv?: Record<string, string>;
      expiresAt: string;
    }
  /** Deck returned a typed control-plane requirement — never retried with the same inputs;
   * the caller must release the worker and route to a human action (NOT-87 §6.3). */
  | { ok: false; kind: "interaction_required"; reason: string }
  /** This profile's (runtime, deckId) combination has no isolation mechanism at all
   * (currently: cursor_local + any deck) — a permanent configuration mismatch, not a
   * transient hiccup. Never retried: retrying spawns and fails identically every time
   * until the infra-attempt budget is burned for nothing (PR #19 review). */
  | { ok: false; kind: "runtime_unsupported"; reason: string }
  /** Enrollment/config/network failure — the caller's existing bounded infra-retry policy applies. */
  | { ok: false; kind: "infra_failure"; reason: string };

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

/**
 * Codex's top-level authentication-policy keys (docs: "Enforce a login method or
 * workspace") — carried verbatim from the ambient `config.toml` into the isolated one so
 * a worker authenticates under the *same* policy `agent-health.ts`'s `codex login status`
 * already verified against the ambient host, never a looser one. `forced_login_method`/
 * `forced_chatgpt_workspace_id` make codex exit rather than silently proceed when cached
 * credentials don't match, so dropping them wouldn't just risk a wrong-context login —
 * it would let a per-attempt isolated session skip an enforcement the ambient host relies
 * on entirely.
 */
const CODEX_AUTH_POLICY_KEYS = [
  "cli_auth_credentials_store",
  "chatgpt_base_url",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
] as const;

/**
 * Real TOML parse (PR #19 review round 4 — a regex over `config.toml` text missed valid
 * single-quoted strings, trailing comments, and had no table-scoping), reading only
 * `CODEX_AUTH_POLICY_KEYS` off the *root* table. Deliberately ignores everything else in
 * the file, `mcp_servers` most of all — that table is what execution authority exists to
 * replace, never to inherit.
 */
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

/** claude's `--mcp-config` file schema. */
function urlHeaderMcpConfig(mcpUrl: string, authorityId: string, authoritySecret: string, worktreePath: string) {
  return {
    mcpServers: {
      "agent-deck": {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${authorityId}:${authoritySecret}`,
          "x-agent-deck-workspace": worktreePath,
        },
      },
    },
  };
}

/**
 * Writes this attempt's execution authority as the spawned worker's *only* route to
 * Agent Deck (NOT-87/92) — never merged with, or falling back to, any ambient/user MCP
 * config. Where the config can live is runtime-specific:
 *
 * - claude: a JSON file outside the worktree (`--mcp-config --strict-mcp-config`).
 * - codex: a per-attempt `CODEX_HOME` directory outside the worktree, whose
 *   `config.toml` names the server and an env-var to read the bearer token from —
 *   the secret itself is passed via that env var at spawn time, never written to disk.
 *   Both `CODEX_HOME` and the bearer env var are returned in `mcpEnv` for `spawn.ts` to
 *   set on the child process; without `CODEX_HOME` set, codex would silently fall back
 *   to its default (ambient, unscoped) config root. `CODEX_HOME` also owns codex's own
 *   login credentials and authentication policy (PR #19 review rounds 3-4):
 *   - `CODEX_AUTH_POLICY_KEYS` (`cli_auth_credentials_store`, `chatgpt_base_url`,
 *     `forced_login_method`, `forced_chatgpt_workspace_id`) are read out of the ambient
 *     `config.toml` with a real TOML parser (`readAmbientCodexAuthPolicy` — a regex
 *     misses valid single-quoted strings/trailing comments and has no table-scoping) and
 *     `smol-toml`-stringified into the isolated one, so the worker authenticates under
 *     the *same* enforced policy `agent-health.ts`'s `codex login status` already
 *     verified — nothing else from the ambient file (`mcp_servers` most of all) crosses
 *     over. Without `cli_auth_credentials_store` specifically, an isolated home defaults
 *     to `"auto"`, which prefers the OS credential store over `auth.json` whenever one is
 *     *available* — on a keyring-capable host explicitly configured for `"file"`
 *     storage, that would make the isolated session ignore the symlinked `auth.json` and
 *     launch logged out even though the ambient host isn't actually using the keychain.
 *   - `auth.json` (the credential itself) is *symlinked*, not copied: codex refreshes it
 *     during normal use, and a plain copy would (a) silently drop those refreshes once
 *     this per-attempt directory is deleted at release — the opposite of "durable and
 *     refreshable" — and (b) leave a live second copy of a real, possibly long-lived
 *     credential on disk if the coordinator crashes before release ever runs (see
 *     `cleanupOrphanedWorkerMcpConfig` for that crash path — a leftover symlink carries
 *     no credential bytes of its own, unlike a leftover copy). Writes codex makes through
 *     the symlink land on the one real ambient file, keeping a single source of truth.
 *
 * `runtime` is asserted supported by the caller (`acquireWorkerAuthority`) — cursor is
 * never passed here.
 */
async function materializeWorkerMcpConfig(opts: {
  runtime: "claude_code" | "codex_local";
  authorityId: string;
  authoritySecret: string;
  worktreePath: string;
}): Promise<MaterializedMcpConfig> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const mcpUrl = `${mcpBase}/mcp`;

  if (opts.runtime === "codex_local") {
    const codexHome = path.join(getExecutionAuthorityConfigDir(), `codex-home-${opts.authorityId}-${randomUUID()}`);
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    try {
      const ambientHome = resolveAmbientCodexHome();
      try {
        const ambientAuthPath = path.join(ambientHome, "auth.json");
        if (fs.existsSync(ambientAuthPath)) {
          fs.symlinkSync(ambientAuthPath, path.join(codexHome, "auth.json"));
        }
      } catch {
        // best-effort — a host using OS-keychain-backed auth (not file-backed) has no
        // auth.json to link at all, and codex's keychain lookup isn't home-dir-scoped.
      }
      const toml = stringifyToml({
        ...readAmbientCodexAuthPolicy(ambientHome),
        mcp_servers: {
          "agent-deck": { url: mcpUrl, bearer_token_env_var: CODEX_BEARER_ENV_VAR },
        },
      });
      fs.writeFileSync(path.join(codexHome, "config.toml"), toml, { mode: 0o600 });
    } catch (err) {
      // Never leave a half-written per-attempt directory behind for the caller to have
      // to know the path of (PR #19 review round 5) — the caller only learns of failure
      // via the thrown error, not this path.
      fs.rmSync(codexHome, { recursive: true, force: true });
      throw err;
    }
    return {
      mcpConfigPath: codexHome,
      mcpEnv: {
        [CODEX_HOME_ENV_VAR]: codexHome,
        [CODEX_BEARER_ENV_VAR]: `${opts.authorityId}:${opts.authoritySecret}`,
      },
    };
  }

  const dir = getExecutionAuthorityConfigDir();
  const filePath = path.join(dir, `${opts.authorityId}-${randomUUID()}.json`);
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify(urlHeaderMcpConfig(mcpUrl, opts.authorityId, opts.authoritySecret, opts.worktreePath)),
      { mode: 0o600 }
    );
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return { mcpConfigPath: filePath };
}

/** `get_bound_deck`'s own deck-identity field (confirmed against the live tool result: `{"id": "<deckId>", "name": ..., ...}`). */
function assertBoundDeckMatches(result: unknown, expectedDeckId: string): void {
  const payload = parseDeckToolResult(result);
  const boundDeckId = typeof payload.id === "string" ? payload.id : undefined;
  if (boundDeckId !== expectedDeckId) {
    throw new Error(`get_bound_deck returned deck ${boundDeckId ?? "(missing id)"}, expected ${expectedDeckId}`);
  }
}

async function verifyAuthority(opts: {
  authorityId: string;
  authoritySecret: string;
  deckId: string;
  callTool?: DeckToolCaller;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.callTool) {
    try {
      const result = await opts.callTool("get_bound_deck", {});
      assertToolResultOk(result, "get_bound_deck");
      assertBoundDeckMatches(result, opts.deckId);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${opts.authorityId}:${opts.authoritySecret}` } },
  });
  const client = new Client({ name: "agent-dealer-authority-preflight", version: "0.0.1" });
  try {
    await client.connect(transport);
    try {
      const result = await Promise.race([
        client.callTool({ name: "get_bound_deck", arguments: {} }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`get_bound_deck timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
        ),
      ]);
      assertToolResultOk(result, "get_bound_deck");
      assertBoundDeckMatches(result, opts.deckId);
      return { ok: true };
    } finally {
      await client.close();
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function interactionRequiredReason(result: Extract<MintAuthorityResult, { ok: false }>): string {
  return result.message || "Agent Deck requires a control-plane decision before this attempt can continue.";
}

export async function acquireWorkerAuthority(opts: {
  deckId: string;
  runId: string;
  attemptId: string;
  idempotencyKey: string;
  worktreePath: string;
  runtime: Runtime;
  ttlMs?: number;
  mint?: (input: MintAuthorityInput) => Promise<MintAuthorityResult>;
  verifyCallTool?: DeckToolCaller;
  timeoutMs?: number;
}): Promise<WorkerAuthorityOutcome> {
  if (!AUTHORITY_SUPPORTED_RUNTIMES.has(opts.runtime)) {
    return {
      ok: false,
      kind: "runtime_unsupported",
      reason: `execution authority is not supported for runtime ${opts.runtime} — no isolation mechanism for its MCP config exists yet`,
    };
  }

  const mint = opts.mint ?? defaultMintAuthority;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DECK_BIND_TIMEOUT_MS ?? 30_000);

  const minted = await mint({
    runId: opts.runId,
    attemptId: opts.attemptId,
    deckId: opts.deckId,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    idempotencyKey: opts.idempotencyKey,
  });
  if (!minted.ok) {
    if (minted.code === "INTERACTION_REQUIRED") {
      return { ok: false, kind: "interaction_required", reason: interactionRequiredReason(minted) };
    }
    return { ok: false, kind: "infra_failure", reason: `${minted.code}: ${minted.message}` };
  }
  const { authority } = minted;
  if (!authority.authoritySecret) {
    // Idempotent remint of a still-live authority under the same (enrollmentId,
    // idempotencyKey) never re-issues the secret (NOT-85 §7) — this attempt has none to
    // use. Each physical claim mints with a fresh idempotency key, so this should not
    // happen in normal operation; surface it as infra rather than silently proceeding
    // secret-less.
    return {
      ok: false,
      kind: "infra_failure",
      reason: `authority ${authority.authorityId} minted without a secret (idempotent remint) — retry with a fresh attempt`,
    };
  }

  const verified = await verifyAuthority({
    authorityId: authority.authorityId,
    authoritySecret: authority.authoritySecret,
    deckId: opts.deckId,
    callTool: opts.verifyCallTool,
    timeoutMs,
  });
  if (!verified.ok) {
    await revokeAuthority(authority.authorityId);
    return { ok: false, kind: "infra_failure", reason: `authority preflight failed: ${verified.reason}` };
  }

  try {
    // AUTHORITY_SUPPORTED_RUNTIMES was already checked above, so this narrowing is sound.
    const { mcpConfigPath, mcpEnv } = await materializeWorkerMcpConfig({
      runtime: opts.runtime as "claude_code" | "codex_local",
      authorityId: authority.authorityId,
      authoritySecret: authority.authoritySecret,
      worktreePath: opts.worktreePath,
    });
    return { ok: true, authorityId: authority.authorityId, mcpConfigPath, mcpEnv, expiresAt: authority.expiresAt };
  } catch (err) {
    // Same contract as a verify failure just above: a minted authority the caller never
    // learns the id of (because this function never returned it) would otherwise sit
    // live until TTL, unrevoked, for the full developer/reviewer session length (PR #19
    // review round 5).
    await revokeAuthority(authority.authorityId);
    return { ok: false, kind: "infra_failure", reason: `authority materialization failed: ${(err as Error).message}` };
  }
}

/**
 * Best-effort — never leaves a live authority or its on-disk config around after a spawn
 * ends. `recursive: true` covers codex's directory-shaped `CODEX_HOME` as well as
 * claude's single file.
 */
export async function releaseWorkerAuthority(opts: { authorityId: string; mcpConfigPath: string }): Promise<void> {
  try {
    fs.rmSync(opts.mcpConfigPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  await revokeAuthority(opts.authorityId);
}
