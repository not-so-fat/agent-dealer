import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { AgentHealthIssue, AgentProfile, AgentWithHealth, Runtime } from "@agent-dealer/shared";
import {
  CODEX_AUTH_REMEDIATION,
  MUSE_AUTH_REMEDIATION,
  cursorAuthIssueFromOutput,
  runtimeAuthIssueFromOutput,
} from "@agent-dealer/shared";
import {
  claudeBinExists,
  cursorBinExists,
  resolveClaudeBin,
  cursorInvokeArgs,
  resolveCursorBin,
  resolveCodexBin,
  codexBinExists,
  resolveMuseBin,
  museBinExists,
  resolveMuseAuthFile,
  MUSE_CLI_ENV,
} from "../cli-env.js";
import {
  checkAgentDeckHealth,
  checkAgentDeckMcpRegistration,
  fetchDecks,
  type AgentDeckMcpRegistration,
  type DeckAccessResult,
} from "./agent-deck.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";

const RUNTIME_LABEL: Record<Runtime, string> = {
  claude_code: "Claude",
  cursor_local: "Cursor",
  codex_local: "Codex",
  muse_code: "Muse Code",
};

function capHealthIssues(runtime: Runtime): AgentHealthIssue[] {
  const avail = runtimeAvailability(runtime);
  if (avail.available) return [];
  const until = new Date(avail.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [
    {
      code: "usage_capped",
      message: `${RUNTIME_LABEL[runtime]} capped until ${until}`,
    },
  ];
}

const RUNTIME_CACHE_MS = 60_000;
/** Soft probe failures must not stick for the full health TTL — sleep/wake flakes recover on the next tick. */
const SOFT_PROBE_CACHE_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
/** After the first soft fail, retry with these delays before publishing unconfirmed auth. */
const DEFAULT_SOFT_RETRY_BACKOFFS_MS = [250, 750];
/** Require this many consecutive soft-fail rounds (each round already retried) before flipping healthy→unhealthy. */
const SOFT_FAIL_STREAK_TO_UNHEALTHY = 2;
/** Hold a recent healthy result across a single soft-fail streak after host sleep. */
const HEALTHY_GRACE_MS = 5 * 60_000;

type CommandResult = { ok: boolean; output: string; timedOut: boolean };

type CachedRuntimeIssues = {
  at: number;
  issues: AgentHealthIssue[];
  softProbeFailure: boolean;
};

const runtimeIssueCache = new Map<Runtime, CachedRuntimeIssues>();
let githubIssueCache: { at: number; issues: AgentHealthIssue[] } | null = null;

/** Cursor soft-fail streak across health ticks (NOT-157). Reset on hard auth or success. */
let cursorSoftFailStreak = 0;
let cursorLastHealthyAt: number | null = null;

let probeTimeoutMsForTests: number | null = null;
let softRetryBackoffsMsForTests: number[] | null = null;

/**
 * Shorten probe timeout / retry backoff in unit tests so sleep-stub scenarios stay fast.
 * Pass `null` to restore production defaults.
 */
export function setCursorProbeTimingForTests(
  opts: { timeoutMs?: number | null; retryBackoffsMs?: number[] | null } | null
): void {
  if (opts == null) {
    probeTimeoutMsForTests = null;
    softRetryBackoffsMsForTests = null;
    return;
  }
  probeTimeoutMsForTests = opts.timeoutMs === undefined ? probeTimeoutMsForTests : opts.timeoutMs;
  softRetryBackoffsMsForTests =
    opts.retryBackoffsMs === undefined ? softRetryBackoffsMsForTests : opts.retryBackoffsMs;
}

function probeTimeoutMs(): number {
  return probeTimeoutMsForTests ?? DEFAULT_PROBE_TIMEOUT_MS;
}

function softRetryBackoffsMs(): number[] {
  return softRetryBackoffsMsForTests ?? DEFAULT_SOFT_RETRY_BACKOFFS_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RunCommandFn = (
  cmd: string,
  args: string[],
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv
) => Promise<CommandResult>;

function defaultRunCommand(
  cmd: string,
  args: string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, output: output || "timeout", timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d) => {
      output += d.toString();
    });
    child.on("error", (err) => {
      finish({ ok: false, output: err.message, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, output, timedOut: false });
    });
  });
}

let runCommandImpl: RunCommandFn = defaultRunCommand;

/**
 * Replace the process spawner in unit tests (sequence injection for soft-fail / timeout).
 * Pass `null` to restore the real spawner.
 */
export function setRunCommandForTests(fn: RunCommandFn | null): void {
  runCommandImpl = fn ?? defaultRunCommand;
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return runCommandImpl(cmd, args, timeoutMs, env);
}

/** Exported for tests — clears the shared github + runtime health caches and soft-fail streak. */
export function clearAgentHealthCaches(): void {
  runtimeIssueCache.clear();
  githubIssueCache = null;
  cursorSoftFailStreak = 0;
  cursorLastHealthyAt = null;
}

function isSoftCursorProbeIssue(issue: AgentHealthIssue): boolean {
  return (
    issue.code === "runtime_auth" &&
    (/probe timed out/i.test(issue.message) || /probe failed/i.test(issue.message))
  );
}

function softCursorProbeIssue(result: CommandResult): AgentHealthIssue {
  if (result.timedOut || result.output.trim() === "timeout") {
    return {
      code: "runtime_auth",
      message: "Could not confirm Cursor auth — `cursor-agent status` probe timed out",
    };
  }
  const detail = result.output.trim().split("\n").slice(-1)[0] ?? "no output";
  return {
    code: "runtime_auth",
    message: `Could not confirm Cursor auth — \`cursor-agent status\` probe failed (${detail})`,
  };
}

/**
 * NOT-157: classified logged-out / keychain is a hard fail (immediate). Probe timeout /
 * unclassified non-zero exit is soft — retry with backoff, and do not flip a recent healthy
 * result on a single soft-fail streak after host sleep.
 */
async function cursorRuntimeIssues(): Promise<AgentHealthIssue[]> {
  const backoffs = softRetryBackoffsMs();
  const attempts = 1 + backoffs.length;
  let last: CommandResult = { ok: false, output: "no probe", timedOut: false };

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoffs[i - 1]!);
    last = await runCommand(resolveCursorBin(), cursorInvokeArgs(["status"]), probeTimeoutMs());

    // A failed *spawn* resolves with the error message as its output (`spawn cursor-agent
    // ENOENT`), not with empty output — so an absent binary must be recognised here or it
    // falls through to the unconfirmed-auth branch below and names the wrong remedy.
    if (!last.ok && (/\bENOENT\b/.test(last.output) || (!last.output.trim() && !cursorBinExists()))) {
      cursorSoftFailStreak = 0;
      cursorLastHealthyAt = null;
      return [
        {
          code: "cli_missing",
          message: "cursor-agent not found — run: curl https://cursor.com/install -fsS | bash",
        },
      ];
    }

    const authIssue = cursorAuthIssueFromOutput(last.output);
    if (authIssue) {
      cursorSoftFailStreak = 0;
      cursorLastHealthyAt = null;
      console.warn(
        `[agent-health] cursor-agent status: classified auth failure (${authIssue.code})`
      );
      return [authIssue];
    }

    if (last.ok) {
      cursorSoftFailStreak = 0;
      cursorLastHealthyAt = Date.now();
      return [];
    }

    // Soft fail this attempt — try again before publishing.
    const kind = last.timedOut || last.output.trim() === "timeout" ? "timed out" : "failed";
    console.warn(
      `[agent-health] cursor-agent status probe ${kind} (attempt ${i + 1}/${attempts})`
    );
  }

  // Retries exhausted with only soft failures.
  cursorSoftFailStreak += 1;
  const softIssue = softCursorProbeIssue(last);
  const kind = last.timedOut || last.output.trim() === "timeout" ? "timed out" : "failed";
  console.warn(
    `[agent-health] cursor-agent status probe ${kind} after retries (streak=${cursorSoftFailStreak})`
  );

  const withinGrace =
    cursorLastHealthyAt != null && Date.now() - cursorLastHealthyAt < HEALTHY_GRACE_MS;
  if (withinGrace && cursorSoftFailStreak < SOFT_FAIL_STREAK_TO_UNHEALTHY) {
    // Hold the recent healthy result — one post-sleep timeout must not park the queue.
    return [];
  }
  return [softIssue];
}

/**
 * Muse Code health (NOT-178). Three outcomes, nothing guessed:
 *  - `cli_missing`: the spawn itself failed with ENOENT (or the resolved path does not exist);
 *  - `runtime_auth`: no credential to run with — `META_API_KEY` unset and no saved login file
 *    (the state whose `muse exec` stderr is captured in muse-exec-missing-credentials.txt);
 *  - `runtime_unknown`: the version probe failed or timed out for any other reason.
 *
 * Muse has no offline `auth status` (NOT-177), and its only credential-validating call is a
 * billed `muse exec`, so a *present* but expired login is not detectable here — it surfaces at
 * the first run, which the same classifier reads from stderr. `auth.json` is tested for
 * existence only, never read.
 */
async function museRuntimeIssues(): Promise<AgentHealthIssue[]> {
  const bin = resolveMuseBin();
  const ver = await runCommand(bin, ["--version"], probeTimeoutMs(), {
    ...process.env,
    ...MUSE_CLI_ENV,
  });
  if (!ver.ok && (/\bENOENT\b/.test(ver.output) || (!ver.output.trim() && !museBinExists()))) {
    return [
      {
        code: "cli_missing",
        message: "Muse Code CLI not found — install Muse Code (`muse`) or set MUSE_CLI",
      },
    ];
  }
  if (!ver.ok) {
    const detail = ver.timedOut
      ? "timed out"
      : (ver.output.trim().split("\n").slice(-1)[0] ?? "no output");
    return [
      {
        code: "runtime_unknown",
        message: `Could not determine Muse Code health — \`muse --version\` failed (${detail})`,
      },
    ];
  }
  if (!process.env.META_API_KEY && !fs.existsSync(resolveMuseAuthFile())) {
    return [{ code: "runtime_auth", message: MUSE_AUTH_REMEDIATION }];
  }
  return [];
}

/** Exported for direct testing — bypasses the 60s cache in runtimeIssues(). */
export async function runtimeIssuesUncached(runtime: Runtime): Promise<AgentHealthIssue[]> {
  const issues: AgentHealthIssue[] = [];

  if (runtime === "claude_code") {
    if (!claudeBinExists()) {
      const ver = await runCommand(resolveClaudeBin(), ["--version"]);
      if (!ver.ok) {
        issues.push({ code: "cli_missing", message: "Claude CLI not found — install Claude Code" });
        return issues;
      }
    }
    // NOT-133: Claude had no auth preflight at all, so a logged-out Claude agent was admitted
    // exactly the way a logged-out Cursor one was. `claude auth status` is local, offline and
    // free (it reads the credential store and prints JSON) — unlike `claude -p`, which bills.
    // Its output is what gets classified, not its exit code: logged out it prints
    // `"loggedIn": false` *and* exits 1, so only the positive signal in the body blocks. An
    // older CLI without the subcommand prints an unknown-command error that matches nothing,
    // and must not become a false block.
    if (!claudeUsesThirdPartyProvider()) {
      const auth = await runCommand(resolveClaudeBin(), ["auth", "status"]);
      const authIssue = runtimeAuthIssueFromOutput("claude_code", auth.output);
      if (authIssue) issues.push(authIssue);
    }
    return issues;
  }

  if (runtime === "codex_local") {
    if (!codexBinExists()) {
      const ver = await runCommand(resolveCodexBin(), ["--version"]);
      if (!ver.ok) {
        issues.push({ code: "cli_missing", message: "Codex CLI not found — install Codex (`codex`)" });
        return issues;
      }
    }
    // `codex --version` succeeds without auth — use login status for auth health.
    const login = await runCommand(resolveCodexBin(), ["login", "status"]);
    // The classifier runs first: `codex login status` prints "Not logged in" and the
    // exit-code heuristic below would read that as "logged in" on its own, because the
    // substring "logged in" is inside it.
    const authIssue = runtimeAuthIssueFromOutput("codex_local", login.output);
    if (authIssue) {
      issues.push(authIssue);
      return issues;
    }
    const out = login.output.toLowerCase();
    const loggedIn =
      login.ok &&
      (out.includes("logged in") || out.includes("authenticated") || out.includes("api key"));
    if (!loggedIn) {
      issues.push({ code: "runtime_auth", message: CODEX_AUTH_REMEDIATION });
    }
    return issues;
  }

  if (runtime === "muse_code") return museRuntimeIssues();

  // NOT-157: Cursor auth probe distinguishes hard (classified logged-out / keychain) from
  // soft (timeout / unclassified probe flake). Soft path retries with backoff and holds a
  // recent healthy result across a single post-sleep streak.
  return cursorRuntimeIssues();
}

/**
 * Bedrock/Vertex installs authenticate through AWS/GCP credentials instead of a Claude
 * login, so `claude auth status` is not the authority on whether they can run.
 */
function claudeUsesThirdPartyProvider(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" || process.env.CLAUDE_CODE_USE_VERTEX === "1"
  );
}

/**
 * Issue workflows always use `gh` after a developer session (draft PR + checks). A bad
 * or missing GitHub CLI auth wastes a full agent run and lands as `adapter_failure` —
 * surface it on every agent so Start / intake can refuse before that spend.
 */
export async function githubIssuesUncached(): Promise<AgentHealthIssue[]> {
  const status = await runCommand("gh", ["auth", "status"]);
  return classifyGithubAuthStatus({
    ok: status.ok,
    output: status.output,
    timedOut: status.timedOut,
  });
}

const GITHUB_CLI_MISSING_MESSAGE = "gh CLI not found — install GitHub CLI (`gh`)";
const GITHUB_AUTH_MESSAGE = "Run `gh auth login` — GitHub CLI auth required to open PRs";
const GITHUB_UNREACHABLE_MESSAGE =
  "Can't reach GitHub (network or keyring timeout) — check your VPN; Dealer will retry";

/**
 * Output fragments naming a timeout, TLS handshake, DNS or connection failure.
 * Matched against lowercased `gh` output. `timedout` (no space) covers ETIMEDOUT;
 * `timeout` covers gh's own "Timeout trying to log in … (keyring)" and the
 * "timeout while trying to … secret in/from keyring" variants.
 */
const GITHUB_UNREACHABLE_PATTERNS = [
  "timed out",
  "timeout",
  "timedout",
  "tls",
  "ssl",
  "handshake",
  "certificate",
  "dns",
  "could not resolve",
  "no such host",
  "name resolution",
  "eai_again",
  "enotfound",
  "getaddrinfo",
  "connection refused",
  "connection reset",
  "failed to connect",
  "could not connect",
  "network is unreachable",
  "network unreachable",
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "econnaborted",
  "socket hang up",
];

export type GithubAuthProbe = {
  ok: boolean;
  output: string;
  timedOut: boolean;
  /** spawnSync `error.code` (`ENOENT`, `ETIMEDOUT`, …) — undefined on the async path. */
  spawnErrorCode?: string;
};

/**
 * NOT-195: one `gh auth status` classifier shared by the async (`runCommand`) and
 * sync (`spawnSync`) paths. Four cases, checked in order:
 *
 * 1. CLI missing — `ENOENT` (or the pre-existing not-found texts) only. A spawn
 *    timeout also sets the sync `error`, so any-error-means-missing misread a slow
 *    network as an absent binary.
 * 2. Unreachable — spawn timeout, `ETIMEDOUT`, or output naming a timeout / TLS /
 *    DNS / connection failure. Checked before auth because gh maps some
 *    connectivity failures onto login/token wording (and the keyring-login timeout
 *    names neither). Transient: callers defer and retry.
 * 3. Logged out / invalid token — the pre-existing texts, or any other non-zero exit.
 * 4. Healthy.
 */
export function classifyGithubAuthStatus(probe: GithubAuthProbe): AgentHealthIssue[] {
  const out = probe.output.toLowerCase();
  if (
    probe.spawnErrorCode === "ENOENT" ||
    out.includes("enoent") ||
    out.includes("not found") ||
    out.includes("no such file")
  ) {
    return [{ code: "github_cli_missing", message: GITHUB_CLI_MISSING_MESSAGE }];
  }
  if (
    probe.timedOut ||
    probe.spawnErrorCode === "ETIMEDOUT" ||
    GITHUB_UNREACHABLE_PATTERNS.some((p) => out.includes(p))
  ) {
    return [{ code: "github_unreachable", message: GITHUB_UNREACHABLE_MESSAGE }];
  }
  if (
    !probe.ok ||
    out.includes("not logged in") ||
    out.includes("failed to log in") ||
    out.includes("token in keyring is invalid") ||
    out.includes("re-authenticate") ||
    out.includes("to re-authenticate")
  ) {
    return [{ code: "github_auth", message: GITHUB_AUTH_MESSAGE }];
  }
  return [];
}

/**
 * Unit/CI tests must not call the real `gh auth status` — runners usually have no
 * usable token, and the startWorkflow preflight would refuse every kick. Set
 * `AGENT_DEALER_SKIP_GITHUB_HEALTH=1` in `test:unit` / `test:ci`. Production and
 * local `npm run dev` leave it unset so Start still refuses bad auth.
 */
function githubHealthSkippedForTests(): boolean {
  return process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH === "1";
}

/** Synchronous for startWorkflow — issue kick must refuse before spending a developer round. */
export function githubIssuesSync(): AgentHealthIssue[] {
  if (githubHealthSkippedForTests()) return [];
  if (githubIssueCache && Date.now() - githubIssueCache.at < RUNTIME_CACHE_MS) {
    return githubIssueCache.issues;
  }
  const result = spawnSync("gh", ["auth", "status"], {
    encoding: "utf8",
    timeout: 8000,
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  // NOT-195: same four-case classifier as the async path — a spawnSync timeout sets
  // `error` (ETIMEDOUT), which must not read as a missing CLI.
  const issues = classifyGithubAuthStatus({
    ok: result.status === 0,
    output,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    spawnErrorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  });
  githubIssueCache = { at: Date.now(), issues };
  return issues;
}

async function githubIssues(): Promise<AgentHealthIssue[]> {
  if (githubIssueCache && Date.now() - githubIssueCache.at < RUNTIME_CACHE_MS) {
    return githubIssueCache.issues;
  }
  const issues = await githubIssuesUncached();
  githubIssueCache = { at: Date.now(), issues };
  return issues;
}

async function runtimeIssues(runtime: Runtime): Promise<AgentHealthIssue[]> {
  const capIssues = capHealthIssues(runtime);
  const cached = runtimeIssueCache.get(runtime);
  const ttl = cached?.softProbeFailure ? SOFT_PROBE_CACHE_MS : RUNTIME_CACHE_MS;
  if (cached && Date.now() - cached.at < ttl) {
    return [...capIssues, ...cached.issues];
  }
  const issues = await runtimeIssuesUncached(runtime);
  const nonCap = issues.filter((i) => i.code !== "usage_capped");
  // Soft fail (published or grace-held) uses a short TTL so a wake retry can clear quickly;
  // a sticky 60s cache of "Could not confirm" is what parked the queue after sleep (NOT-157).
  const softProbeFailure =
    nonCap.some(isSoftCursorProbeIssue) ||
    (runtime === "cursor_local" && cursorSoftFailStreak > 0);
  runtimeIssueCache.set(runtime, { at: Date.now(), issues: nonCap, softProbeFailure });
  return [...capIssues, ...nonCap];
}

function resolveMcpRegistration(
  mcpRegistered?: boolean | AgentDeckMcpRegistration
): AgentDeckMcpRegistration {
  if (mcpRegistered === undefined) return checkAgentDeckMcpRegistration();
  if (typeof mcpRegistered === "boolean") {
    return mcpRegistered ? { status: "registered" } : { status: "missing" };
  }
  return mcpRegistered;
}

function agentSpecificIssues(
  agent: AgentProfile,
  agentDeckOnline: boolean,
  mcpRegistration: AgentDeckMcpRegistration,
  deckAccessResult: DeckAccessResult | null
): AgentHealthIssue[] {
  const issues: AgentHealthIssue[] = [];
  // NOT-181: a Muse Code worker gets no MCP servers and no Agent Deck, so a missing, offline or
  // deleted deck cannot stop it. (The profile form still asks for one; Muse ignores it.)
  if (agent.runtime === "muse_code") return issues;
  if (!agent.deckId) {
    issues.push({
      code: "deck_missing",
      message: "Set an Agent Deck on the Agents page — workers never start without one",
    });
    return issues;
  }
  if (!agentDeckOnline) {
    issues.push({ code: "deck_offline", message: "Agent Deck offline — deck MCP unavailable" });
  }
  // resolveDeckName silently returns null on this same failure elsewhere (route/index.ts) —
  // surface it here so a bound deck that can no longer be read isn't just a quiet no-op. A
  // *successful* metadata call that simply doesn't include this deck (deleted) is the same
  // user-visible failure as the call itself failing.
  if (agentDeckOnline && deckAccessResult) {
    if (!deckAccessResult.ok) {
      issues.push({ code: "deck_unauthorized", message: deckAccessResult.message });
    } else if (!deckAccessResult.decks.some((d) => d.id === agent.deckId)) {
      issues.push({
        code: "deck_unauthorized",
        message: `Deck ${agent.deckName ?? agent.deckId} is not available from Agent Deck (deleted or unreachable)`,
      });
    }
  }
  if (agent.runtime === "claude_code" && agentDeckOnline) {
    if (mcpRegistration.status === "endpoint_mismatch") {
      issues.push({
        code: "mcp_not_registered",
        message: `Claude MCP points at ${mcpRegistration.foundHost}:${mcpRegistration.foundPort}, expected ${mcpRegistration.expectedHost}:${mcpRegistration.expectedPort} — update AGENT_DECK_HOST/AGENT_DECK_MCP_PORT (or the HTTP url) in Claude MCP config`,
      });
    } else if (mcpRegistration.status === "missing") {
      issues.push({
        code: "mcp_not_registered",
        message: "Run agent-deck setup --client claude --start (Claude MCP not registered)",
      });
    }
  }
  return issues;
}

export async function healthForAgent(
  agent: AgentProfile,
  agentDeckOnline: boolean,
  runtimeIssuesByRuntime?: Map<Runtime, AgentHealthIssue[]>,
  mcpRegistered?: boolean | AgentDeckMcpRegistration,
  deckAccessResult: DeckAccessResult | null = null,
  githubIssuesList?: AgentHealthIssue[]
): Promise<AgentWithHealth> {
  const runtime =
    runtimeIssuesByRuntime !== undefined
      ? (runtimeIssuesByRuntime.get(agent.runtime) ?? [])
      : await runtimeIssues(agent.runtime);
  const mcpRegistration = resolveMcpRegistration(mcpRegistered);
  const github = githubIssuesList ?? (await githubIssues());
  const issues: AgentHealthIssue[] = [
    ...runtime,
    ...github,
    ...agentSpecificIssues(agent, agentDeckOnline, mcpRegistration, deckAccessResult),
  ];
  return {
    ...agent,
    healthy: issues.length === 0,
    issues,
  };
}

export async function listAgentsWithHealth(agents: AgentProfile[]): Promise<AgentWithHealth[]> {
  const agentDeckOnline = await checkAgentDeckHealth();
  const mcpRegistration = checkAgentDeckMcpRegistration();
  const needsDeckAccess = agents.some((a) => a.deckId);
  const deckAccessResult = agentDeckOnline && needsDeckAccess ? await fetchDecks() : null;
  const runtimes = [...new Set(agents.map((a) => a.runtime))];
  const runtimeIssuesByRuntime = new Map<Runtime, AgentHealthIssue[]>();
  const [, githubIssuesList] = await Promise.all([
    Promise.all(
      runtimes.map(async (runtime) => {
        runtimeIssuesByRuntime.set(runtime, await runtimeIssues(runtime));
      })
    ),
    githubIssues(),
  ]);
  return Promise.all(
    agents.map((a) =>
      healthForAgent(
        a,
        agentDeckOnline,
        runtimeIssuesByRuntime,
        mcpRegistration,
        deckAccessResult,
        githubIssuesList
      )
    )
  );
}
