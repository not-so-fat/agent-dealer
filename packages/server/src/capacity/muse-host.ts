// packages/server/src/capacity/muse-host.ts
//
// NOT-270: server-owned long-lived `muse serve` host for Muse 5H/1W capacity.
//
// NOT-269 proved the only supported acquisition path: a host that actually
// observed the account's provider traffic (a real session's `turn/start`
// flow on that same host), whose `usage/changed` notifications and
// `usage/read` answers then carry the `window` + `weekly` pair. A fresh
// host is structurally unobserved — the retired one-shot poll (spawn →
// `usage/read` → exit) could only ever read `missing` — and
// `session/resume` carries no usage, so neither is used here.
//
// Ownership (exactly the NOT-269 design):
// - One `muse serve` host per server process, started at first demand.
//   Concurrent readers share it: connection startup and `usage/read` are
//   both single-flight, so there is never a second Muse execution host
//   per concurrent request.
// - The host is held open only once it has observed provider traffic
//   (state worth preserving across restarts is process-local to the
//   host). A host that has observed nothing is released right after the
//   read — an unobserved host holds no state, so releasing it loses
//   nothing, and production keeps no lifetime child that can only answer
//   `missing`. The next throttled refresh transparently respawns it.
//   The release never fires while an execution turn is using the
//   connection (`hasInflightExecution`): a capacity read must not SIGTERM
//   an admitted turn.
// - The host launches under a server-owned XDG home
//   (`prepareMuseServeHome`): the deckless worker base posture
//   (`buildMuseBaseSettings` — no MCP servers, no subagents, no workflows,
//   no reminders) plus a symlink to the ambient login, so the host never
//   inherits the operator's ambient config. It runs no sessions; deck-enabled
//   developer turns each carry their own required `agent-deck` server on the
//   isolated exec lane.
// - `usage/changed` is ingested as soon as received; the throttled
//   on-demand `usage/read` on the same host is the final read.
// - Restart/crash: usage state is process-local to the host, so a dead host
//   restarts empty — `missing` until fresh provider traffic is observed on
//   it. Never backfill from another host. No leaked child processes:
//   every failure path kills the child and the next read restarts it;
//   `shutdownMuseCapacityHost()` releases the host for clean shutdown.
// - Ingest is newest-`observedAtMs`-wins (`ingestMuseUsagePayload`): an
//   older finishing read cannot clobber newer rows, and a fresh-host
//   `missing` never overwrites or deletes a newer known pair.
// - Failures preserve last-good rows (`noteMuseCapacityFailure`): a failure
//   diagnostic never sits beside valid windows, and a successful recovery
//   clears the sentinel.
// - Capacity stays independent from `runtime_availability` hard-cap
//   admission: this module never reads or writes health rows.
// - The free read path enforces the read-only allowlist (`initialize`,
//   `initialized`, `usage/read`) and never starts billable work. The separate
//   default-on fallback in `muse-probe.ts` may create a dedicated restricted
//   host for one fixed, bounded turn after the complete pair has been absent
//   for an hour.
//
// Execution precondition (NOT-269): only a host that observes the account's
// provider traffic can answer `usage/read`. NOT-278 removed developer turns
// from this host: every deck-enabled Muse developer turn runs the isolated
// `muse exec` lane (coordinator/muse-spawn.ts), which cannot observe the
// host, so the session-boundary refresh hook
// (`refreshMuseCapacityAfterSession` in coordinator/muse-spawn.ts) stays
// honest N/A with last-good rows preserved until a genuine turn observes
// the host again. If no genuine turn has populated a complete current pair
// for an hour, `muse-probe.ts` may use its own host for the bounded paid
// fallback. Per-session Agent Deck support for the serve protocol is a
// non-goal until the protocol can represent isolated session MCP identity.
//
// PRODUCT DECISION (2026-09-26, resolved via human_action on this ticket):
// the runner migration is in scope for NOT-270, in this same PR, not a
// follow-up ticket. Facts supporting that decision:
// - Sandbox-network posture is a fixed constant across every existing
//   developer/reviewer invocation today (`--sandbox-network restricted`,
//   see runners/muse-code-args.ts) — there is no per-session variation to
//   lose. `muse serve --sandbox-network restricted` at host startup
//   reproduces it exactly; this is a one-line host-launch change, not a
//   rewrite.
// - Approval mode is already wire-selectable per session
//   (`SessionStartParams.approvalMode`), matching today's
//   `--approval-mode never`.
// - Re-verify the NOT-177/179/181 sandbox contracts (shell/write/network
//   restriction actually holds under `serve`) using a free
//   `--provider echo` session/turn on the host — no live paid Meta turn is
//   needed for this verification.
// - Accepted, explicit tradeoff (not an oversight): `muse serve` has no
//   wire- or host-level equivalent to `--disable-web-tools` or
//   `--no-foreign-personal-context` in this Muse version (1.4.0). Real
//   turns routed through the owned host run without those two specific
//   restrictions. Everything else (network sandbox, approval mode, write/
//   shell restriction) is unaffected.
// This question was escalated twice on this ticket (product_scope_decision,
// resolved both times); the decision above is final for NOT-270's scope.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapacityUnavailableReason, RuntimeCapacityResponse } from "@agent-dealer/shared";
import { MUSE_CLI_ENV, resolveMuseAuthFile, resolveMuseBin } from "../cli-env.js";
import { getDataDir } from "../db/index.js";
import { parseMuseVersion } from "../adapters/muse-capability.js";
import { buildMuseBaseSettings } from "../runners/muse-config.js";
import {
  MSP_USAGE_CHANGED,
  MUSE_CLIENT_INFO,
  MUSE_SERVE_ARGV,
  assertMuseExecMethod,
  assertMuseReadOnlyMethod,
  hasMuseCredential,
  ingestMuseUsagePayload,
  museCapacityTimeoutMs,
  museClassifyRpcError,
  museEvidenceRef,
  museRefreshThrottleMs,
  museUuidv7,
  noteMuseCapacityFailure,
  parseMuseRpcLine,
  type MspExecMethod,
  type MspReadOnlyMethod,
} from "./muse.js";

export interface MuseHostOptions {
  /** Binary to spawn. Defaults to the resolved `muse` CLI. */
  command?: string;
  /** Args for the binary. Defaults to the versioned serve argv. */
  args?: string[];
  /** Extra env for the subprocess (merged over process.env). */
  env?: NodeJS.ProcessEnv;
  /** Per-read bound in ms (default 15s, env AGENT_DEALER_MUSE_CAPACITY_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Muse login file (existence only, never read). Defaults to resolveMuseAuthFile(). */
  authFilePath?: string;
  /**
   * NOT-273: working directory for the serve child. Defaults to
   * `resolveMuseHostCwd()` — a dedicated directory under the server's managed
   * data dir, never the ambient process cwd. Overridable for tests.
   */
  cwd?: string;
  /** Spawn implementation override (tests). Defaults to `node:child_process` spawn. */
  spawnImpl?: typeof spawn;
  /**
   * NOT-277: what the binary reports as its version (null when it cannot say). Defaults to
   * `<muse> --version` for the resolved CLI; with a `command` override and no reader the host's
   * version is unknown (null).
   */
  readVersion?: () => Promise<string | null>;
}

function readResolvedMuseVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      resolveMuseBin(),
      ["--version"],
      { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...MUSE_CLI_ENV } },
      (err, stdout) => resolve(err ? null : parseMuseVersion(stdout))
    );
  });
}

/**
 * NOT-273: dedicated cwd for the coordinator-owned `muse serve` child.
 * The spawn must never inherit the server process's ambient working
 * directory (in a maintainer's `npm run dev` checkout that is the repo
 * itself, where a stray `git add . && git commit` in the child would land
 * real commits on the checkout). Created if missing.
 */
export function resolveMuseHostCwd(): string {
  const dir = path.join(getDataDir(), "capacity", "muse-host-home");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface MuseServeHome {
  /** Server-owned XDG_CONFIG_HOME for the host: worker settings + auth link. */
  configHome: string;
  /** Server-owned XDG_DATA_HOME for the host (isolated session/state dir). */
  dataHome: string;
  /** True when the ambient login was linked in (false under META_API_KEY auth). */
  authLinked: boolean;
}

/**
 * NOT-278: the owned host never runs a session — it only serves the read-only
 * handshake/`usage/read` allowlist for capacity, and it is shared across decks, so it
 * carries the deckless worker base posture (`buildMuseBaseSettings()`: no MCP servers, no
 * subagent delegation, no workflows, no reminder child runs) and never inherits the
 * operator's ambient MCP/subagent config. Builds a server-owned config home carrying those
 * base settings plus a symlink to the ambient login (linked, never read or copied; absent
 * when the operator authenticates with META_API_KEY), and an isolated data home for the
 * host's own session/state. Deck-enabled developer turns run on the isolated exec lane
 * (`coordinator/muse-spawn.ts`), each with its own required `agent-deck` server. Process-
 * scoped: one home per host instance, reused across restarts, removed on shutdown.
 */
export function prepareMuseServeHome(
  ambientAuthFile: string = resolveMuseAuthFile()
): MuseServeHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-serve-"));
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  fs.mkdirSync(path.join(configHome, "muse"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask; the home holds a login symlink.
  fs.chmodSync(root, 0o700);
  fs.chmodSync(configHome, 0o700);
  fs.chmodSync(dataHome, 0o700);
  fs.writeFileSync(
    path.join(configHome, "muse", "settings.json"),
    `${JSON.stringify(buildMuseBaseSettings(), null, 2)}\n`,
    { mode: 0o600 }
  );
  let authLinked = false;
  try {
    if (fs.existsSync(ambientAuthFile)) {
      fs.symlinkSync(ambientAuthFile, path.join(configHome, "muse", "auth.json"));
      authLinked = true;
    }
  } catch {
    // Best-effort: the credential check in start() decides admission, and
    // API-key auth needs no link at all.
  }
  return { configHome, dataHome, authLinked };
}

export type MuseHostReadOutcome =
  | { status: "observed"; written: string[]; skippedStale: string[] }
  | { status: "missing"; diagnostic: MuseHostDiagnostic }
  | { status: "failure"; reason: CapacityUnavailableReason; diagnostic: MuseHostDiagnostic };

/** Static, credential-free diagnostics kept server-side. The public capacity
 * response still uses the small shared unavailable-reason enum. */
export type MuseHostDiagnostic =
  | "credential_missing"
  | "keychain_unreadable"
  | "auth_rejected"
  | "binary_missing"
  | "spawn_failed"
  | "host_exited"
  | "handshake_timeout"
  | "handshake_rejected"
  | "transport_error"
  | "read_timeout"
  | "read_rejected"
  | "unobserved"
  | "payload_unparsable"
  | "unsupported";

type MuseHostStartFailure = Extract<
  MuseHostDiagnostic,
  | "credential_missing"
  | "keychain_unreadable"
  | "auth_rejected"
  | "binary_missing"
  | "spawn_failed"
  | "host_exited"
  | "handshake_timeout"
  | "handshake_rejected"
  | "transport_error"
  | "unsupported"
>;

const KEYCHAIN_UNREADABLE_RE = /keychain item .* unreadable|OSStatus\s+-?\d+/i;
const AUTH_FAILURE_RE = /credential|auth|login|sign[ -]?in|\b401\b|\b403\b/i;

interface PendingRead {
  resolve: (value: { result?: unknown; error?: { code?: unknown; message?: unknown } }) => void;
}

function readOnlyRequest(id: string, method: MspReadOnlyMethod, params: unknown): string {
  assertMuseReadOnlyMethod(method);
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function readOnlyNotification(method: MspReadOnlyMethod, params: unknown): string {
  assertMuseReadOnlyMethod(method);
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

function execRequestLine(id: string, method: MspExecMethod, params: unknown): string {
  assertMuseExecMethod(method);
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

export interface MuseHostRpcResponse {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** One parsed JSON-RPC line from the host (response or notification). */
export interface MuseHostMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface HostNotificationWaiter {
  predicate: (msg: MuseHostMessage) => boolean;
  resolve: (msg: MuseHostMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One long-lived connection. A new instance is created per process (plus
 * per test reset); the module singleton below guarantees at most one live
 * instance per process at a time.
 */
export class MuseCapacityHost {
  private readonly opts: MuseHostOptions;
  private child: ChildProcess | null = null;
  private dead = true;
  private starting: Promise<boolean> | null = null;
  private inflightRead: Promise<MuseHostReadOutcome> | null = null;
  private pending = new Map<string, PendingRead>();
  /** Live execution-turn subscribers (turn/completed, item/*, ...). */
  private notifWaiters = new Set<HostNotificationWaiter>();
  private buffer = "";
  private stderrTail = "";
  private readSeq = 0;
  /**
   * True once this connection has observed provider traffic (a `usage/read`
   * or `usage/changed` ingest that wrote rows). Only an observed host is
   * held open — an unobserved one is released after the read. Reset on
   * every (re)spawn: usage state is process-local, so a restarted host
   * starts unobserved.
   */
  private observedOnConnection = false;
  /** Increments on every spawn — tests use it to prove host reuse/restart. */
  connectionEpoch = 0;
  /**
   * NOT-277: the Muse version the live child runs — the on-disk binary's reported version, read
   * immediately before the spawn and again after the handshake; null when unknown or when the
   * binary changed across the spawn. A long-lived host keeps running the build it started on
   * after an auto-update, so developer work only uses it when this is the capability-checked
   * version (see `ensureStartedOnVersion`).
   */
  runningVersion: string | null = null;
  /**
   * Server-owned XDG home for the host (worker settings + auth link).
   * Built lazily on first spawn, reused across restarts, removed on
   * shutdown.
   */
  private serveHome: MuseServeHome | null = null;

  constructor(opts: MuseHostOptions = {}) {
    this.opts = { ...opts };
  }

  /** True while a live child backs this host. */
  isConnected(): boolean {
    return !this.dead && this.child !== null && this.child.exitCode === null;
  }

  /**
   * True while a real execution turn (or its admission) is using the shared
   * connection: an unanswered execution request id, or a live
   * `turn/completed` subscriber. A capacity read must never tear the host
   * down while this is true — on a fresh host the first turn is still
   * unobserved, so an unconditional unobserved-host release would SIGTERM
   * the admitted billable turn and fail it with 'no turn completion
   * observed'.
   */
  hasInflightExecution(): boolean {
    return this.pending.size > 0 || this.notifWaiters.size > 0;
  }

  /**
   * Env for the host subprocess: the server-owned XDG home always wins over
   * inherited ambient config (the server process itself may run under an
   * operator XDG home), so the host never inherits ambient MCP servers,
   * subagents, or workflows. Only an explicit XDG override in `opts.env`
   * (tests) still wins.
   */
  private mergedEnv(): NodeJS.ProcessEnv {
    const home = this.ensureServeHome();
    const env = { ...process.env, ...this.opts.env };
    if (this.opts.env?.XDG_CONFIG_HOME === undefined) env.XDG_CONFIG_HOME = home.configHome;
    if (this.opts.env?.XDG_DATA_HOME === undefined) env.XDG_DATA_HOME = home.dataHome;
    return env;
  }

  /** Lazily built server-owned home; rebuilt if removed (e.g. after shutdown). */
  private ensureServeHome(): MuseServeHome {
    const home = this.serveHome;
    if (home) {
      try {
        if (fs.existsSync(path.join(home.configHome, "muse", "settings.json"))) return home;
      } catch {
        // Fall through and rebuild.
      }
    }
    this.serveHome = prepareMuseServeHome();
    return this.serveHome;
  }

  /**
   * SIGTERM the child and release it. A wedged host can ignore SIGTERM, so
   * every kill arms a one-shot 2 s SIGKILL escalation against that exact
   * child — the timer holds only the old handle, so it can never signal a
   * replacement host spawned later. SIGKILL is the backstop for wedged
   * hosts only: a host that exits on SIGTERM is never signalled again.
   *
   * Notification waiters resolve null here so execution turns fail fast on
   * host death instead of hanging until their own timeout.
   */
  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.dead = true;
    this.runningVersion = null;
    for (const [, p] of this.pending) {
      try {
        p.resolve({});
      } catch {
        // Never throw out of teardown.
      }
    }
    this.pending.clear();
    for (const w of this.notifWaiters) {
      clearTimeout(w.timer);
      try {
        w.resolve(null);
      } catch {
        // Never throw out of teardown.
      }
    }
    this.notifWaiters.clear();
    this.buffer = "";
    try {
      child?.kill();
    } catch {
      // Already exited — nothing to signal.
    }
    if (child && child.exitCode === null) {
      const killer = setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {
          // Already exited — nothing to signal.
        }
      }, 2000);
      killer.unref?.();
    }
  }

  /** True when `child` is still the live backing process for this host. */
  private isCurrentChild(child: ChildProcess): boolean {
    return this.child === child && !this.dead;
  }

  private onLine(line: string): void {
    const msg = parseMuseRpcLine(line) as MuseHostMessage | null;
    if (!msg) return;
    if (typeof msg.method === "string" && msg.id === undefined) {
      if (msg.method === MSP_USAGE_CHANGED) {
        // Passive observation from real provider traffic on this host —
        // ingest immediately, newest-observedAtMs-wins.
        void ingestMuseUsagePayload(msg.params ?? null, {
          evidenceRef: museEvidenceRef("changed"),
        })
          .then((outcome) => {
            // A changed-notification that wrote rows means this host has
            // observed traffic: it is worth holding open.
            if (outcome.written.length > 0) this.observedOnConnection = true;
          })
          .catch(() => {
            // Best-effort: a failed ingest never breaks the connection.
          });
      }
      // Execution-turn subscribers (turn/completed, item/*, ...). A waiter
      // that fires is removed; waiters never see each other's messages.
      for (const w of [...this.notifWaiters]) {
        let match = false;
        try {
          match = w.predicate(msg);
        } catch {
          match = false;
        }
        if (match) {
          this.notifWaiters.delete(w);
          clearTimeout(w.timer);
          try {
            w.resolve(msg);
          } catch {
            // Never throw out of the read loop.
          }
        }
      }
      return;
    }
    if (typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve({ result: msg.result, error: msg.error });
      }
    }
  }

  /**
   * NOT-270 execution lane: one JSON-RPC request for REAL Dealer work
   * (`session/start`, `turn/start`, `turn/cancel`, `session/read` only —
   * anything else throws before write). Multiplexed over the single shared
   * connection by request id, so concurrent sessions share the one owned
   * host and there is never a second Muse execution host per request.
   * Resolves null on timeout, dead host, or unwritable stdin.
   */
  async execRequest(
    id: string,
    method: MspExecMethod,
    params: unknown,
    timeoutMs: number
  ): Promise<MuseHostRpcResponse | null> {
    assertMuseExecMethod(method);
    if (this.dead || !this.child || this.child.exitCode !== null) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as MuseHostRpcResponse);
        },
      });
      try {
        this.child?.stdin?.write(execRequestLine(id, method, params));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * Subscribe to one host notification (e.g. `turn/completed` for a session).
   * Resolves with the first matching message, null on timeout or host death.
   * Concurrent turns each hold their own waiter on the shared connection.
   */
  async waitForHostNotification(
    predicate: (msg: MuseHostMessage) => boolean,
    timeoutMs: number
  ): Promise<MuseHostMessage | null> {
    if (this.dead) return null;
    return new Promise((resolve) => {
      const waiter: HostNotificationWaiter = {
        predicate,
        resolve: (msg) => {
          clearTimeout(waiter.timer);
          this.notifWaiters.delete(waiter);
          resolve(msg);
        },
        timer: setTimeout(() => {
          this.notifWaiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.notifWaiters.add(waiter);
    });
  }

  /**
   * Best-effort `turn/cancel` for a timed-out or aborted execution turn.
   * Never throws; the caller owns the timeout/abort verdict regardless.
   */
  async cancelExecTurn(sessionId: string, turnId?: string): Promise<void> {
    try {
      if (this.dead) return;
      this.readSeq += 1;
      await this.execRequest(
        `muse-cancel-${this.connectionEpoch}-${this.readSeq}-${Date.now()}`,
        "turn/cancel",
        {
          commandId: museUuidv7(),
          sessionId,
          ...(turnId ? { turnId } : {}),
        },
        10_000
      );
    } catch {
      // Best-effort: cancellation must never break the caller's verdict.
    }
  }

  private sendRequest<T>(
    id: string,
    method: MspReadOnlyMethod,
    params: unknown,
    timeoutMs: number
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
      });
      try {
        this.child?.stdin?.write(readOnlyRequest(id, method, params));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * Start (or reuse) the connection. Single-flight across callers: a start
   * already in flight is always joined first. (The child is assigned before
   * the handshake completes, so checking `isConnected()` first would let a
   * second caller send requests down a half-open connection — session/start
   * arriving before `initialized` is rejected by the host.)
   */
  async ensureStarted(): Promise<boolean> {
    if (this.starting) return this.starting;
    if (this.isConnected()) return true;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * NOT-277: start (or reuse) the host, and report whether it runs `version`. A live host on any
   * other (or an unknown) version is restarted onto the current on-disk binary when it is idle;
   * while the connection is in use it is left alone and this returns false. Never true for a
   * host not known to run `version`. (NOT-278: no developer turn runs on the host any more —
   * this only gates capacity reads, which are version-independent.)
   */
  async ensureStartedOnVersion(version: string): Promise<boolean> {
    if (!(await this.ensureStarted())) return false;
    if (this.runningVersion === version) return true;
    if (this.hasInflightExecution() || this.inflightRead) return false;
    this.killChild();
    if (!(await this.ensureStarted())) return false;
    return this.runningVersion === version;
  }

  private async start(): Promise<boolean> {
    this.killChild();
    const readVersion = this.opts.readVersion ?? (this.opts.command ? async () => null : readResolvedMuseVersion);
    const versionBefore = await readVersion();
    const timeoutMs = this.opts.timeoutMs ?? museCapacityTimeoutMs();
    const mergedEnv = this.mergedEnv();
    if (!hasMuseCredential(mergedEnv, this.opts.authFilePath ?? resolveMuseAuthFile())) {
      this.startFailure = "credential_missing";
      return false;
    }
    const command = this.opts.command ?? resolveMuseBin();
    const args = this.opts.args ?? [...MUSE_SERVE_ARGV];
    let child: ChildProcess;
    try {
      // NOT-273: explicit cwd — never inherit the server process's ambient
      // working directory (which in dev is the repo checkout itself).
      const cwd = this.opts.cwd ?? resolveMuseHostCwd();
      const spawnFn = this.opts.spawnImpl ?? spawn;
      child = spawnFn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...mergedEnv, ...MUSE_CLI_ENV },
      });
    } catch (err) {
      this.startFailure =
        (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "binary_missing" : "spawn_failed";
      return false;
    }
    this.child = child;
    this.dead = false;
    this.connectionEpoch += 1;
    // Usage state is process-local: a (re)spawned host starts unobserved.
    this.observedOnConnection = false;
    this.stderrTail = "";
    child.stderr?.on("data", (buf: Buffer) => {
      // Stderr is diagnostic-only; attribute it only while this child is live.
      if (!this.isCurrentChild(child)) return;
      this.stderrTail = `${this.stderrTail}${buf.toString()}`.slice(-2000);
    });
    child.stdout?.on("data", (buf: Buffer) => {
      // A previous child killed for restart may still flush output after its
      // replacement spawns — never let a stale child feed the live buffer
      // or tear the new connection down.
      if (!this.isCurrentChild(child)) return;
      this.buffer += buf.toString();
      if (this.buffer.length > 10 * 1024 * 1024) {
        this.killChild();
        return;
      }
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.onLine(line);
        if (this.dead) return;
      }
    });
    child.on("error", (err) => {
      if (!this.isCurrentChild(child)) return;
      this.startFailure =
        (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "binary_missing" : "spawn_failed";
      this.killChild();
    });
    child.stdin?.on("error", () => {
      if (!this.isCurrentChild(child)) return;
      this.startFailure = "transport_error";
      this.killChild();
    });
    child.on("close", () => {
      // Process-local usage state dies with the host (NOT-269 restart rule).
      // Guarded: a SIGTERMed hung child that exits after a restart spawned
      // its replacement must not kill the new host.
      if (!this.isCurrentChild(child)) return;
      if (KEYCHAIN_UNREADABLE_RE.test(this.stderrTail)) {
        this.startFailure = "keychain_unreadable";
      } else if (AUTH_FAILURE_RE.test(this.stderrTail)) {
        this.startFailure = "auth_rejected";
      } else if (this.startFailure === null) {
        this.startFailure = "host_exited";
      }
      this.killChild();
    });

    const initId = `muse-capacity-init-${this.connectionEpoch}`;
    const init = await this.sendRequest<{ result?: unknown; error?: unknown }>(
      initId,
      "initialize",
      { clientInfo: { ...MUSE_CLIENT_INFO } },
      timeoutMs
    );
    if (this.dead || !init || init.error) {
      if (init?.error) {
        const kind = museClassifyRpcError(init.error);
        this.startFailure =
          kind === "auth"
            ? "auth_rejected"
            : kind === "unsupported"
              ? "unsupported"
              : "handshake_rejected";
      } else if (this.startFailure === null) {
        this.startFailure = this.dead ? "host_exited" : "handshake_timeout";
      }
      this.killChild();
      return false;
    }
    try {
      child.stdin?.write(readOnlyNotification("initialized", {}));
    } catch {
      this.killChild();
      return false;
    }
    // The spawned build is the on-disk one only if the binary did not change across the spawn.
    const versionAfter = await readVersion();
    if (this.isCurrentChild(child)) {
      this.runningVersion = versionBefore !== null && versionBefore === versionAfter ? versionBefore : null;
    }
    return true;
  }

  private startFailure: MuseHostStartFailure | null = null;

  /**
   * Final `usage/read` on the owned host. Single-flight: concurrent
   * callers share one read on the one connection. Ingests newest-wins;
   * a fresh-host `missing` preserves stored rows.
   */
  async readUsage(): Promise<MuseHostReadOutcome> {
    if (this.inflightRead) return this.inflightRead;
    this.inflightRead = this.read();
    try {
      const outcome = await this.inflightRead;
      if (outcome.status === "observed") {
        this.observedOnConnection = true;
      } else if (!this.observedOnConnection && !this.hasInflightExecution()) {
        // The host observed nothing and holds no state worth keeping:
        // release the child instead of parking a lifetime process that
        // can only answer `missing`. The next refresh transparently
        // respawns it; last-good DB rows are untouched either way.
        // Skipped while an execution turn is using the connection — the
        // release must never SIGTERM an admitted turn (see
        // hasInflightExecution).
        this.killChild();
      }
      return outcome;
    } finally {
      this.inflightRead = null;
    }
  }

  private async read(): Promise<MuseHostReadOutcome> {
    const timeoutMs = this.opts.timeoutMs ?? museCapacityTimeoutMs();
    this.startFailure = null;
    const started = await this.ensureStarted();
    if (!started) {
      // `ensureStarted` records the failure asynchronously. TypeScript does
      // not model that mutation across the awaited call, so widen the field
      // back to its declared type before selecting the fallback category.
      const diagnostic =
        (this.startFailure as MuseHostStartFailure | null) ?? "spawn_failed";
      if (diagnostic === "unsupported" || diagnostic === "binary_missing") {
        console.error(`[muse-capacity] host start failed: ${diagnostic}`);
        await noteMuseCapacityFailure("unsupported");
        return { status: "failure", reason: "unsupported", diagnostic };
      }
      // No credential, spawn failure, timeout, or bad exit before the
      // handshake: honest `missing`, last-good rows preserved.
      console.error(`[muse-capacity] host start failed: ${diagnostic}`);
      await noteMuseCapacityFailure("missing");
      return { status: "missing", diagnostic };
    }
    this.readSeq += 1;
    const id = `muse-capacity-${this.connectionEpoch}-${this.readSeq}`;
    const res = await this.sendRequest<{
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    }>(id, "usage/read", {}, timeoutMs);
    if (this.dead || !res) {
      console.error("[muse-capacity] host read failed: timeout");
      // Never tear down under an admitted turn: a capacity timeout must not
      // become a turn failure. The turn's own timeout/cancel owns that
      // verdict; the hung child is reaped when the turn settles or when a
      // later read finds the connection idle.
      if (!this.hasInflightExecution()) this.killChild();
      await noteMuseCapacityFailure("missing");
      return { status: "missing", diagnostic: "read_timeout" };
    }
    if (res.error) {
      const kind = museClassifyRpcError(res.error);
      if (kind === "auth") {
        console.error("[muse-capacity] host read failed: unauthenticated");
        await noteMuseCapacityFailure("missing");
        return { status: "missing", diagnostic: "auth_rejected" };
      }
      if (kind === "unsupported") {
        console.error("[muse-capacity] host read failed: unsupported");
        await noteMuseCapacityFailure("unsupported");
        return { status: "failure", reason: "unsupported", diagnostic: "unsupported" };
      }
      console.error("[muse-capacity] host read failed: malformed");
      await noteMuseCapacityFailure("unparsable");
      return { status: "failure", reason: "unparsable", diagnostic: "read_rejected" };
    }
    let payload = res.result;
    if (
      payload &&
      typeof payload === "object" &&
      !("usage" in (payload as Record<string, unknown>)) &&
      (payload as Record<string, unknown>).result !== undefined
    ) {
      payload = (payload as Record<string, unknown>).result;
    }
    const outcome = await ingestMuseUsagePayload(payload, {
      evidenceRef: museEvidenceRef("read"),
    });
    if (outcome.written.length === 0) {
      // Fresh/unobserved host: `usage` omitted — honest `missing`, never a
      // write, so a newer known pair is never overwritten or deleted.
      await noteMuseCapacityFailure("missing");
      return { status: "missing", diagnostic: "unobserved" };
    }
    return { status: "observed", written: outcome.written, skippedStale: outcome.skippedStale };
  }

  /**
   * Clean shutdown: release the child so no host process leaks.
   * Graceful-first — a host that exits on SIGTERM is never signalled again
   * (SIGKILL is the backstop for wedged hosts only). The close is awaited
   * for a bounded grace window and a still-alive host is SIGKILLed before
   * returning, so teardown never leaks the child and never depends on a
   * timer the exiting event loop may never run.
   */
  async shutdown(): Promise<void> {
    const child = this.child;
    this.killChild();
    this.starting = null;
    this.inflightRead = null;
    // The serve home is per-instance: remove it so restarts and test resets
    // leave no litter. A later ensureStarted() transparently rebuilds it.
    const home = this.serveHome;
    this.serveHome = null;
    if (home) {
      try {
        fs.rmSync(path.dirname(home.configHome), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (!child || child.exitCode !== null) return;
    const closed = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), 2000);
      timer.unref?.();
      child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!closed) {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // Already exited — nothing to signal.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process singleton + production refresh
// ---------------------------------------------------------------------------

let sharedHost: MuseCapacityHost | null = null;
let lastMuseHostRefreshMs = 0;

/** The server-owned host (created on first use). */
export function getMuseCapacityHost(opts: MuseHostOptions = {}): MuseCapacityHost {
  if (!sharedHost) sharedHost = new MuseCapacityHost(opts);
  return sharedHost;
}

/** Test helper — shut the shared host down so the next use starts fresh. */
export async function resetMuseCapacityHostForTests(): Promise<void> {
  lastMuseHostRefreshMs = 0;
  const host = sharedHost;
  sharedHost = null;
  await host?.shutdown();
}

/** Clean shutdown for server teardown. */
export async function shutdownMuseCapacityHost(): Promise<void> {
  const host = sharedHost;
  sharedHost = null;
  await host?.shutdown();
}

/** Test helper — reset the refresh throttle so the next refresh runs. */
export function resetMuseCapacityRefreshState(): void {
  lastMuseHostRefreshMs = 0;
}

/**
 * Bounded refresh through the owned host: one final `usage/read` on the
 * connection that observed the account's provider traffic, ingested
 * newest-`observedAtMs`-wins. Reuses the shared snapshot path; failures
 * preserve last-good rows as N/A, never as health rows.
 */
export async function refreshMuseCapacityFromHost(
  opts: MuseHostOptions & { nowMs?: number } = {}
): Promise<RuntimeCapacityResponse> {
  const { getRuntimeCapacitySnapshot } = await import("./service.js");
  const { nowMs, ...hostOpts } = opts;
  const host = getMuseCapacityHost(hostOpts);
  await host.readUsage();
  return getRuntimeCapacitySnapshot(nowMs ?? Date.now());
}

/**
 * NOT-270 production trigger for Muse capacity: throttled, bounded,
 * best-effort. Returns the refreshed snapshot, or null when
 * throttled/disabled. Never throws — callers (routes) serve the
 * last-known snapshot on null.
 */
export async function maybeRefreshMuseCapacityFromHost(
  opts: MuseHostOptions & { nowMs?: number } = {},
  nowMs = Date.now()
): Promise<RuntimeCapacityResponse | null> {
  const throttle = museRefreshThrottleMs();
  if (!Number.isFinite(throttle) || nowMs - lastMuseHostRefreshMs < throttle) return null;
  lastMuseHostRefreshMs = nowMs;
  try {
    return await refreshMuseCapacityFromHost({ ...opts, nowMs });
  } catch {
    return null;
  }
}
