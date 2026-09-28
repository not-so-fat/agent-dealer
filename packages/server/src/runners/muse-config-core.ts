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

/**
 * NOT-278: the read-only allowlist is a reviewer requirement, not a developer requirement.
 * Developers receive the selected deck's full surface, including `call_service_tool`. These
 * lists only ever materialize for a reviewer build that proves allowlist enforcement.
 */
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
/** Test-only harness vars for the fake `muse` fixture (fixtures/fake-muse.mjs), which can only be
 * selected via the operator/test `MUSE_CLI` override — and passed through only when that
 * override is set, so production runs of the default binary never carry them. */
const FAKE_HARNESS_PREFIX = "FAKE_MUSE_";

const ATTEMPT_PREFIX = "muse-attempt-";
const SENTINEL = ".dealer-muse-attempt";

export type MuseIsolationCode =
  | "unenforceable_restriction"
  | "invalid_input"
  | "unsafe_path"
  | "invalid_settings"
  | "invalid_argv"
  | "cleanup_failed";

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

/**
 * NOT-278: capabilities a role needs that the evidence does not prove. Developers receive the
 * selected deck's full surface (including `call_service_tool`), so no allowlist enforcement is
 * required; `cron_*` stays prohibited by the developer prompt and is detected post-run
 * (`muse_cron_used`), not mechanically disabled. Reviewers still need both controls proven.
 */
export function unenforceableRestrictions(
  role: MuseRole,
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): MuseCapability[] {
  if (role === "developer") return [];
  const missing: MuseCapability[] = [];
  // Outbound mutation (`call_service_tool`) must stay denied for reviewers, and Muse only
  // stores enabled_tools/disabled_tools unless this is proven.
  if (!evidence.mcp_tool_allowlist_enforcement) missing.push("mcp_tool_allowlist_enforcement");
  // cron jobs are background orchestration that fired a second agent run inside the process.
  if (!evidence.cron_tool_disable) missing.push("cron_tool_disable");
  return missing;
}

/**
 * NOT-278: the deckless worker posture shared by every Muse settings.json — workflows and
 * subagents off, reminder child runs off, plus `cron_*` only when proven mechanically
 * disableable. The capacity serve host (which is shared across decks and never runs a
 * session) uses this directly; per-attempt sessions add the required `agent-deck` server
 * below. Exported only for that host — it is not a session attempt and `assertMuseSettings`
 * rejects it (exactly one required `agent-deck` server is mandatory for a launch).
 */
export function buildMuseBaseSettings(
  role: MuseRole = "developer",
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): Omit<MuseSettings, "mcpServers"> {
  const runtime_capabilities: MuseSettings["runtime_capabilities"] = {};
  for (const name of REMINDERS) {
    runtime_capabilities[`plugin:tbh-reminders:reminder:${name}`] = { enabled: false };
  }
  // NOT-278: `cron_*` can only be claimed disabled for reviewers on a build that proves it.
  // Developers are prohibited by prompt and detected post-run; their settings never claim it.
  if (role === "reviewer" && evidence.cron_tool_disable) {
    for (const tool of CRON_TOOLS) runtime_capabilities[`tool:${tool}`] = { enabled: false };
  }
  return {
    schema_version: 1,
    run: { workflow_trigger_mode: "off", subagent_delegation_mode: "off" },
    runtime_capabilities,
  };
}

/**
 * NOT-278: developers always receive the selected deck's full surface unfiltered — their
 * settings never carry `enabled_tools`/`disabled_tools` claims. The read-only allowlist only
 * materializes for reviewers on a build that proves enforcement.
 */
export function buildMuseSettings(
  agentDeck: MuseAttemptInput["agentDeck"],
  role: MuseRole = "developer",
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): MuseSettings {
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
  if (role === "reviewer" && evidence.mcp_tool_allowlist_enforcement) {
    server.enabled_tools = [...AGENT_DECK_READ_TOOLS];
    server.disabled_tools = [...AGENT_DECK_DENIED_TOOLS];
  }
  return {
    ...buildMuseBaseSettings(role, evidence),
    mcpServers: { [AGENT_DECK_SERVER]: server },
  };
}

/** Whitelist check on a settings object (generated or re-read from disk). */
export function assertMuseSettings(
  settings: unknown,
  agentDeck: MuseAttemptInput["agentDeck"],
  role: MuseRole = "developer",
  evidence: MuseEnforcementEvidence = NOT_177_EVIDENCE
): void {
  const expected = buildMuseSettings(agentDeck, role, evidence);
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
  // Test-only seam: the fake fixture is driven by FAKE_MUSE_* (scenario, record path, version
  // pins) and the exec lane is exact, so without this the fixture cannot be driven at all.
  // These vars join attempt.env only when the operator/test MUSE_CLI override selects the
  // binary — i.e. only the fixture can ever receive them, never the default real binary —
  // and the pre-spawn verify() snapshot covers them exactly like every other approved var.
  if (ambient.MUSE_CLI?.trim()) {
    for (const [key, value] of Object.entries(ambient)) {
      if (key.startsWith(FAKE_HARNESS_PREFIX) && value !== undefined) env[key] = value;
    }
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Copies the fields verify() depends on; malformed shapes are left for validateInput to reject. */
function snapshotInput(raw: MuseAttemptInput): MuseAttemptInput {
  const deck = raw.agentDeck && typeof raw.agentDeck === "object" ? raw.agentDeck : undefined;
  const cred = raw.credential && typeof raw.credential === "object" ? raw.credential : undefined;
  return deepFreeze({
    ...raw,
    agentDeck: deck ? { url: deck.url, deckId: deck.deckId, workspace: deck.workspace } : (raw.agentDeck as never),
    credential: cred ? ({ ...cred } as MuseCredential) : (raw.credential as never),
    env: raw.env ? { ...raw.env } : undefined,
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/**
 * Validates, refuses unenforceable restrictions, then writes the per-attempt dir (0700) with
 * settings.json (0600) and an auth link. Throws before spawn; leaves nothing behind on failure.
 *
 * Always uses the pinned `NOT_177_EVIDENCE`, under which developers are admitted unfiltered
 * (NOT-278: the full deck surface, no allowlist claims) and reviewers are still refused. There is
 * deliberately no runtime seam that accepts other evidence: the enforced-path tests load a
 * source-rewritten copy of this file instead (see muse-config.test.ts).
 */
export function prepareMuseAttempt(input: MuseAttemptInput): MuseAttempt {
  return prepareWithEvidence(input, NOT_177_EVIDENCE);
}

// Not exported: evidence must never be caller-supplied.
function prepareWithEvidence(rawInput: MuseAttemptInput, evidence: MuseEnforcementEvidence): MuseAttempt {
  // Verification later runs against this snapshot, never against the caller's mutable object.
  const input = snapshotInput(rawInput);
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
  const credentialKind = input.credential.kind;
  const settings = deepFreeze(buildMuseSettings(agentDeck, input.role, evidence));
  assertMuseSettings(settings, agentDeck, input.role, evidence);
  const apiKey = input.credential.kind === "api-key" ? input.credential.apiKey : undefined;
  const argv = buildMuseArgv({
    role: input.role,
    sessionId: input.sessionId,
    maxModelSteps: input.maxModelSteps,
    prompt: input.prompt,
    apiKeyStdin: apiKey !== undefined,
  });

  const root = fs.mkdtempSync(path.join(baseDir, ATTEMPT_PREFIX));
  // Terminal only once the dir is confirmed gone, so a failed rmSync can be retried.
  let cleaned = false;
  const removeRoot = (requireSentinel: boolean) => {
    if (cleaned) return;
    // Only a dir this module created (prefix) directly under baseDir is removed.
    if (path.dirname(root) !== baseDir || !path.basename(root).startsWith(ATTEMPT_PREFIX)) return;
    let present = true;
    try {
      fs.lstatSync(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      present = false;
    }
    if (present) {
      // After construction the sentinel proves the dir is still ours; the dir mkdtemp just returned
      // is ours by construction even if the sentinel was never written.
      if (requireSentinel && !fs.existsSync(path.join(root, SENTINEL))) return;
      // rmSync unlinks the auth symlink without following it.
      fs.rmSync(root, { recursive: true, force: true });
    }
    cleaned = true;
  };
  const cleanup = () => removeRoot(true);
  const abortConstruction = (original: unknown): never => {
    try {
      removeRoot(false);
    } catch (rmErr) {
      const reason = original instanceof Error ? original.message : "unknown error";
      const rmReason = rmErr instanceof Error ? rmErr.message : "unknown error";
      throw new MuseIsolationError(
        "cleanup_failed",
        `Muse attempt setup failed (${reason}) and its dir ${root} could not be removed: ${rmReason}`
      );
    }
    throw original;
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
    assertMuseSettings(onDisk, agentDeck, input.role, evidence);
    const entries = fs.readdirSync(path.dirname(settingsPath)).sort();
    const allowed = credentialKind === "auth-file" ? ["auth.json", "settings.json"] : ["settings.json"];
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
    return abortConstruction(err);
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
    return abortConstruction(err);
  }
  return attempt;
}
