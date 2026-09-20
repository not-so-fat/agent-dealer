// NOT-180: per-attempt native Muse Code configuration.
//
// Materializes everything one `muse exec` attempt may see — settings.json, XDG dirs, auth link,
// argv, env — outside the worktree, and refuses (before anything is written or spawned) when a
// required restriction is not one NOT-177 proved Muse can enforce. Only controls recorded in
// docs/evaluations/muse-code/headless-contract.md are emitted; nothing here is assumed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MuseRole = "developer" | "reviewer";

/** Named capabilities NOT-177 found Muse cannot enforce. */
export type MuseCapability = "mcp_tool_allowlist_enforcement" | "cron_tool_disable";

/**
 * What has been proven to be enforced by the pinned Muse build. Both are `false` on
 * 1.3.0-R3401.1 (probes 7-9). Callers cannot supply this: `prepareMuseAttempt` always uses
 * `NOT_177_EVIDENCE`. Flip a value here only after re-running probe 8 / 9 against the pinned build
 * (or pin a new build) and committing the result; the generated settings then carry the control.
 */
export interface MuseEnforcementEvidence {
  mcp_tool_allowlist_enforcement: boolean;
  cron_tool_disable: boolean;
}

export const NOT_177_EVIDENCE: Readonly<MuseEnforcementEvidence> = Object.freeze({
  mcp_tool_allowlist_enforcement: false,
  cron_tool_disable: false,
});

export const MUSE_MODEL = "muse-spark-1.3-contributor";
export const AGENT_DECK_SERVER = "agent-deck";

/** Deck reads a worker needs. `call_service_tool` (outbound mutation) is never in this list. */
export const AGENT_DECK_READ_TOOLS = [
  "get_bound_deck",
  "get_playbook",
  "list_service_tools",
  "bind_workspace",
] as const;
export const AGENT_DECK_DENIED_TOOLS = ["call_service_tool"] as const;

const CRON_TOOLS = ["cron_create", "cron_list", "cron_delete"] as const;
const REMINDERS = [
  "skill-reminder",
  "verify-reminder",
  "memory-reminder",
  "todo-reminder",
  "goal-reminder",
  "scope-reminder",
] as const;

/** Flags that widen trust, sandbox, approvals or orchestration. Never emitted, refused if seen. */
const FORBIDDEN_FLAGS = [
  "--yolo",
  "--disable-sandbox",
  "--disable-approval",
  "--trust-workspace",
  "--worktree",
  "-w",
  "--subagent-worktree-isolation",
  "--preset",
  "--agents",
  "--permission-profile",
  "--no-session-log",
];

/** Which ambient env vars reach Muse. Everything else (META_API_KEY, MUSE_*, CODEX_HOME, ...) is dropped. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR"];

const ATTEMPT_PREFIX = "muse-attempt-";
const SENTINEL = ".dealer-muse-attempt";

export type MuseIsolationCode =
  | "unenforceable_restriction"
  | "invalid_input"
  | "unsafe_path"
  | "invalid_settings"
  | "invalid_argv";

/** Messages name fields and paths, never values that could be credentials. */
export class MuseIsolationError extends Error {
  constructor(
    readonly code: MuseIsolationCode,
    message: string,
    readonly capabilities: readonly MuseCapability[] = []
  ) {
    super(message);
    this.name = "MuseIsolationError";
  }
}

export type MuseCredential =
  | { kind: "auth-file"; path: string }
  | { kind: "api-key"; apiKey: string };

export interface MuseAttemptInput {
  role: MuseRole;
  worktreePath: string;
  /** Parent of the per-attempt dir. Must be outside the worktree and outside any temp dir. */
  baseDir: string;
  agentDeck: { url: string; deckId: string; workspace: string };
  credential: MuseCredential;
  sessionId: string;
  prompt: string;
  maxModelSteps: number;
  /** Ambient environment to filter; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The exact launch contract of one attempt. Frozen; anything else is not an approved launch. */
export interface MuseLaunch {
  /** Real path of the assigned worktree. The Muse sandbox roots its write access at cwd (NOT-177). */
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Only set for api-key credentials: write to the child's stdin, never argv/env/disk. */
  readonly stdin?: string;
}

export interface MuseAttempt extends MuseLaunch {
  root: string;
  settingsPath: string;
  settings: MuseSettings;
  /** Scrubs the credential from text bound for logs, errors, or the database. */
  redact(text: string): string;
  /**
   * Re-reads the config on disk and requires `launch` (default: this attempt) to equal the
   * approved cwd/argv/env/stdin exactly. Pass what you actually spawn with, immediately before spawn.
   */
  verify(launch?: MuseLaunch): void;
  /** Removes the per-attempt dir (settings, data, auth link). Idempotent; never touches the operator's auth. */
  cleanup(): void;
}

export interface MuseSettings {
  schema_version: 1;
  run: { workflow_trigger_mode: "off"; subagent_delegation_mode: "off" };
  runtime_capabilities: Record<string, { enabled: false }>;
  mcpServers: Record<string, MuseMcpServer>;
}

interface MuseMcpServer {
  type: "streamable-http";
  url: string;
  headers: Record<string, string>;
  mode: "required";
  enabled_tools?: string[];
  disabled_tools?: string[];
}

/** Capabilities a role needs that the evidence does not prove. Both roles need both today. */
export function unenforceableRestrictions(
  _role: MuseRole,
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): MuseCapability[] {
  const missing: MuseCapability[] = [];
  // Outbound mutation (`call_service_tool`) must stay denied for every role, and Muse only
  // stores enabled_tools/disabled_tools unless this is proven.
  if (!evidence.mcp_tool_allowlist_enforcement) missing.push("mcp_tool_allowlist_enforcement");
  // cron jobs are background orchestration that fired a second agent run inside the process.
  if (!evidence.cron_tool_disable) missing.push("cron_tool_disable");
  return missing;
}

export function buildMuseSettings(
  agentDeck: MuseAttemptInput["agentDeck"],
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): MuseSettings {
  const runtime_capabilities: MuseSettings["runtime_capabilities"] = {};
  for (const name of REMINDERS) {
    runtime_capabilities[`plugin:tbh-reminders:reminder:${name}`] = { enabled: false };
  }
  if (evidence.cron_tool_disable) {
    for (const tool of CRON_TOOLS) runtime_capabilities[`tool:${tool}`] = { enabled: false };
  }
  const server: MuseMcpServer = {
    type: "streamable-http",
    url: agentDeck.url,
    headers: {
      "x-agent-deck-deck-id": agentDeck.deckId,
      "x-agent-deck-workspace": agentDeck.workspace,
    },
    // `mode`, not `required`: writing both drops the whole MCP block. Never "optional".
    mode: "required",
  };
  if (evidence.mcp_tool_allowlist_enforcement) {
    server.enabled_tools = [...AGENT_DECK_READ_TOOLS];
    server.disabled_tools = [...AGENT_DECK_DENIED_TOOLS];
  }
  return {
    schema_version: 1,
    run: { workflow_trigger_mode: "off", subagent_delegation_mode: "off" },
    runtime_capabilities,
    mcpServers: { [AGENT_DECK_SERVER]: server },
  };
}

/** Whitelist check on a settings object (generated or re-read from disk). */
export function assertMuseSettings(
  settings: unknown,
  agentDeck: MuseAttemptInput["agentDeck"],
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): void {
  const expected = buildMuseSettings(agentDeck, evidence);
  if (JSON.stringify(sortKeys(settings)) !== JSON.stringify(sortKeys(expected))) {
    throw new MuseIsolationError(
      "invalid_settings",
      "Muse settings differ from the approved role settings (extra, missing, or altered keys)"
    );
  }
  const servers = Object.keys((settings as MuseSettings).mcpServers ?? {});
  if (servers.length !== 1 || servers[0] !== AGENT_DECK_SERVER) {
    throw new MuseIsolationError("invalid_settings", "Muse settings must configure exactly the agent-deck MCP server");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

export function buildMuseArgv(input: {
  role: MuseRole;
  sessionId: string;
  maxModelSteps: number;
  prompt: string;
  apiKeyStdin?: boolean;
}): string[] {
  const argv = [
    "exec",
    ...(input.apiKeyStdin ? ["--api-key-stdin"] : []),
    "--json",
    "--no-foreign-personal-context",
    "--model",
    MUSE_MODEL,
    "--approval-mode",
    "never",
    "--approval-judge",
    "off",
    "--sandbox-network",
    "restricted",
    "--disable-web-tools",
    "--session-id",
    input.sessionId,
    "--max-model-steps",
    String(input.maxModelSteps),
  ];
  if (input.role === "reviewer") argv.push("--disable-write", "--disable-shell");
  argv.push(input.prompt);
  assertMuseArgv(argv, input.role);
  return argv;
}

/** Refuses argv that widens trust/sandbox/orchestration or drops a required restriction. */
export function assertMuseArgv(argv: readonly string[], role: MuseRole): void {
  // The prompt is the last positional; flags inside it would be parsed by Muse.
  const flags = argv.slice(0, -1);
  for (const arg of flags) {
    const name = arg.split("=")[0]!;
    if (FORBIDDEN_FLAGS.includes(name)) {
      throw new MuseIsolationError("invalid_argv", `Muse argv contains forbidden flag ${name}`);
    }
  }
  if (argv[0] !== "exec") throw new MuseIsolationError("invalid_argv", "Muse argv must start with exec");
  const requireValue = (flag: string, value: string) => {
    const i = flags.indexOf(flag);
    if (i < 0 || flags[i + 1] !== value) {
      throw new MuseIsolationError("invalid_argv", `Muse argv must set ${flag} ${value}`);
    }
  };
  requireValue("--approval-mode", "never");
  requireValue("--sandbox-network", "restricted");
  requireValue("--model", MUSE_MODEL);
  if (!flags.includes("--json")) throw new MuseIsolationError("invalid_argv", "Muse argv must set --json");
  if (!flags.includes("--no-foreign-personal-context")) {
    throw new MuseIsolationError("invalid_argv", "Muse argv must set --no-foreign-personal-context");
  }
  const readOnly = flags.includes("--disable-write") && flags.includes("--disable-shell");
  if (role === "reviewer" && !readOnly) {
    throw new MuseIsolationError("invalid_argv", "Reviewer argv must set --disable-write and --disable-shell");
  }
  if (role === "developer" && (flags.includes("--disable-write") || flags.includes("--disable-shell"))) {
    throw new MuseIsolationError("invalid_argv", "Developer argv must not disable write or shell");
  }
}

/** Env for the child: filtered ambient vars plus the per-attempt XDG dirs. No credentials. */
export function buildMuseEnv(
  root: string,
  ambient: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = ambient[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(ambient)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  env.MUSE_NO_AUTO_UPDATE = "1";
  env.XDG_CONFIG_HOME = path.join(root, "config");
  env.XDG_DATA_HOME = path.join(root, "data");
  return env;
}

/** `$XDG_CONFIG_HOME/muse/auth.json` (or `~/.config/muse/auth.json`) of the operator. Never read. */
export function defaultOperatorAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME ?? os.homedir(), ".config");
  return path.join(configHome, "muse", "auth.json");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realDir(p: string, label: string): string {
  if (!path.isAbsolute(p)) throw new MuseIsolationError("invalid_input", `${label} must be an absolute path`);
  try {
    if (!fs.statSync(p).isDirectory()) throw new Error("not a directory");
    return fs.realpathSync(p);
  } catch {
    throw new MuseIsolationError("invalid_input", `${label} must be an existing directory`);
  }
}

function tempRoots(): string[] {
  const roots = new Set<string>(["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", os.tmpdir()]);
  for (const r of [...roots]) {
    try {
      roots.add(fs.realpathSync(r));
    } catch {
      // Missing temp roots cannot host anything.
    }
  }
  return [...roots];
}

function validateInput(input: MuseAttemptInput): { worktree: string; baseDir: string } {
  if (input.role !== "developer" && input.role !== "reviewer") {
    throw new MuseIsolationError("invalid_input", "role must be developer or reviewer");
  }
  const worktree = realDir(input.worktreePath, "worktreePath");
  const baseDir = realDir(input.baseDir, "baseDir");
  if (isInside(baseDir, worktree) || isInside(worktree, baseDir)) {
    throw new MuseIsolationError("unsafe_path", "Per-attempt config must live outside the worktree");
  }
  // The Muse sandbox leaves temp dirs writable (probe 6), so neither the worktree nor the
  // config can be protected from the worker there.
  for (const tmp of tempRoots()) {
    if (isInside(worktree, tmp) || isInside(baseDir, tmp)) {
      throw new MuseIsolationError("unsafe_path", "Worktree and per-attempt config must not be under a temp dir");
    }
  }
  const { url, deckId, workspace } = input.agentDeck ?? ({} as MuseAttemptInput["agentDeck"]);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    if (parsed.username || parsed.password) throw new Error("userinfo");
  } catch {
    throw new MuseIsolationError("invalid_input", "agentDeck.url must be an http(s) URL without credentials");
  }
  if (!deckId?.trim() || !workspace?.trim()) {
    throw new MuseIsolationError("invalid_input", "agentDeck.deckId and agentDeck.workspace are required");
  }
  let workspaceReal: string | undefined;
  try {
    workspaceReal = fs.realpathSync(workspace);
  } catch {
    // Reported below.
  }
  if (workspaceReal !== worktree) {
    throw new MuseIsolationError("invalid_input", "agentDeck.workspace must be the attempt's worktree");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId ?? "")) {
    throw new MuseIsolationError("invalid_input", "sessionId must be a UUID");
  }
  if (!Number.isInteger(input.maxModelSteps) || input.maxModelSteps < 1) {
    throw new MuseIsolationError("invalid_input", "maxModelSteps must be a positive integer");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim() === "" || input.prompt.startsWith("-")) {
    throw new MuseIsolationError("invalid_input", "prompt must be non-empty and must not start with '-'");
  }
  const cred = input.credential;
  if (cred?.kind === "auth-file") {
    if (!path.isAbsolute(cred.path) || !fs.existsSync(cred.path) || !fs.statSync(cred.path).isFile()) {
      throw new MuseIsolationError("invalid_input", "credential.path must be an existing auth file");
    }
  } else if (cred?.kind === "api-key") {
    if (typeof cred.apiKey !== "string" || cred.apiKey.trim() === "") {
      throw new MuseIsolationError("invalid_input", "credential.apiKey must be non-empty");
    }
  } else {
    throw new MuseIsolationError("invalid_input", "credential is required");
  }
  return { worktree, baseDir };
}

export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const v of values) out = out.split(v).join("[REDACTED]");
    return out
      .replace(/(META_API_KEY\s*=\s*)\S+/g, "$1[REDACTED]")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]");
  };
}

function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
}

/**
 * Validates, refuses unenforceable restrictions, then writes the per-attempt dir (0700) with
 * settings.json (0600) and an auth link. Throws before spawn; leaves nothing behind on failure.
 */
export function prepareMuseAttempt(input: MuseAttemptInput): MuseAttempt {
  return prepareWithEvidence(input, NOT_177_EVIDENCE);
}

/**
 * Test seam for exercising the enforced-restriction paths against a hypothetical build. Not part
 * of the production API: production code must go through `prepareMuseAttempt`, which is pinned to
 * `NOT_177_EVIDENCE`.
 */
export const museConfigTesting = {
  prepareWithEvidence: (input: MuseAttemptInput, evidence: MuseEnforcementEvidence): MuseAttempt =>
    prepareWithEvidence(input, evidence),
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function prepareWithEvidence(input: MuseAttemptInput, evidence: MuseEnforcementEvidence): MuseAttempt {
  const missing = unenforceableRestrictions(input.role, evidence);
  if (missing.length > 0) {
    throw new MuseIsolationError(
      "unenforceable_restriction",
      `Muse cannot mechanically enforce required restrictions for ${input.role}: ${missing.join(", ")}`,
      missing
    );
  }
  const { worktree, baseDir } = validateInput(input);
  const agentDeck = input.agentDeck;
  const settings = deepFreeze(buildMuseSettings(agentDeck, evidence));
  assertMuseSettings(settings, agentDeck, evidence);
  const apiKey = input.credential.kind === "api-key" ? input.credential.apiKey : undefined;
  const argv = buildMuseArgv({
    role: input.role,
    sessionId: input.sessionId,
    maxModelSteps: input.maxModelSteps,
    prompt: input.prompt,
    apiKeyStdin: apiKey !== undefined,
  });

  const root = fs.mkdtempSync(path.join(baseDir, ATTEMPT_PREFIX));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Only a dir this module created (prefix + sentinel) directly under baseDir is removed.
    // rmSync unlinks the auth symlink without following it.
    if (path.dirname(root) !== baseDir || !path.basename(root).startsWith(ATTEMPT_PREFIX)) return;
    if (!fs.existsSync(path.join(root, SENTINEL))) return;
    fs.rmSync(root, { recursive: true, force: true });
  };

  const settingsPath = path.join(root, "config", "muse", "settings.json");
  const approved = deepFreeze({
    cwd: worktree,
    argv: [...argv],
    env: buildMuseEnv(root, input.env),
    stdin: apiKey === undefined ? undefined : `${apiKey}\n`,
  }) as MuseLaunch;
  const verify = (launch: MuseLaunch = attempt) => {
    if (launch.cwd !== approved.cwd) {
      throw new MuseIsolationError("invalid_argv", "Muse must be launched with cwd set to the assigned worktree");
    }
    if (fs.realpathSync(launch.cwd) !== worktree) {
      throw new MuseIsolationError("invalid_argv", "Muse launch cwd no longer resolves to the assigned worktree");
    }
    if (!sameJson([...launch.argv], approved.argv)) {
      throw new MuseIsolationError("invalid_argv", "Muse argv differs from the approved launch argv");
    }
    if (!sameJson(launch.env, approved.env)) {
      throw new MuseIsolationError("invalid_argv", "Muse env differs from the approved launch env");
    }
    if (launch.stdin !== approved.stdin) {
      throw new MuseIsolationError("invalid_argv", "Muse stdin differs from the approved launch stdin");
    }
    const expectDir = (dir: string) => {
      if ((fs.statSync(dir).mode & 0o077) !== 0) throw new MuseIsolationError("unsafe_path", "Attempt dir is not private");
    };
    let onDisk: unknown;
    try {
      expectDir(root);
      if ((fs.statSync(settingsPath).mode & 0o077) !== 0) {
        throw new MuseIsolationError("unsafe_path", "settings.json is not private");
      }
      onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (err) {
      if (err instanceof MuseIsolationError) throw err;
      throw new MuseIsolationError("invalid_settings", "Muse settings.json is missing or unreadable");
    }
    assertMuseSettings(onDisk, agentDeck, evidence);
    const entries = fs.readdirSync(path.dirname(settingsPath)).sort();
    const allowed = input.credential.kind === "auth-file" ? ["auth.json", "settings.json"] : ["settings.json"];
    if (entries.join() !== allowed.join()) {
      throw new MuseIsolationError("invalid_settings", "Unexpected files in the per-attempt Muse config dir");
    }
    assertMuseArgv([...approved.argv], input.role);
  };

  try {
    fs.chmodSync(root, 0o700);
    writePrivate(path.join(root, SENTINEL), "");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, "data"), { recursive: true, mode: 0o700 });
    writePrivate(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    if (input.credential.kind === "auth-file") {
      fs.symlinkSync(input.credential.path, path.join(path.dirname(settingsPath), "auth.json"));
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  const attempt: MuseAttempt = Object.freeze({
    root,
    settingsPath,
    settings,
    cwd: approved.cwd,
    argv: approved.argv,
    env: approved.env,
    stdin: approved.stdin,
    redact: createRedactor(apiKey ? [apiKey] : []),
    verify,
    cleanup,
  });
  try {
    verify();
  } catch (err) {
    cleanup();
    throw err;
  }
  return attempt;
}
