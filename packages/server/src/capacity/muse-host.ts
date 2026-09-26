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
// - The client enforces the read-only allowlist (`initialize`,
//   `initialized`, `usage/read`) — a capacity read by itself never sends
//   `session/start`, a prompt, a turn, a tool, or any other billable method.
//
// Structural precondition (NOT-269): Dealer runs Muse turns as `muse exec`
// subprocesses, so an exec-driven server leaves this host unobserved and
// Muse capacity reads honest N/A until real turns flow through a serve
// host. No synthetic model prompt is ever issued to refresh capacity.
// Every real Dealer Muse session already ends with a best-effort refresh
// kick at the session boundary (`refreshMuseCapacityAfterSession` in
// coordinator/muse-spawn.ts) — no separate model turn, last-good preserved
// — so the day the runner migration lands (real `session/start` +
// `turn/start` through this owned host), that same hook is the final read
// that populates 5H/1W.
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

import { spawn, type ChildProcess } from "node:child_process";
import type { CapacityUnavailableReason, RuntimeCapacityResponse } from "@agent-dealer/shared";
import { MUSE_CLI_ENV, resolveMuseAuthFile, resolveMuseBin } from "../cli-env.js";
import {
  MSP_USAGE_CHANGED,
  MUSE_CLIENT_INFO,
  MUSE_SERVE_ARGV,
  assertMuseReadOnlyMethod,
  hasMuseCredential,
  ingestMuseUsagePayload,
  museCapacityTimeoutMs,
  museClassifyRpcError,
  museEvidenceRef,
  museRefreshThrottleMs,
  noteMuseCapacityFailure,
  parseMuseRpcLine,
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
}

export type MuseHostReadOutcome =
  | { status: "observed"; written: string[]; skippedStale: string[] }
  | { status: "missing" }
  | { status: "failure"; reason: CapacityUnavailableReason };

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

  constructor(opts: MuseHostOptions = {}) {
    this.opts = { ...opts };
  }

  /** True while a live child backs this host. */
  isConnected(): boolean {
    return !this.dead && this.child !== null && this.child.exitCode === null;
  }

  private mergedEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.opts.env };
  }

  /**
   * @param final true on the shutdown path (server teardown / explicit
   * release): escalate synchronously — the process is exiting (or the
   * caller is done with the child now), so no 2 s timer that the event
   * loop may never run can be trusted to reap a SIGTERM-ignoring host.
   */
  private killChild(final = false): void {
    const child = this.child;
    this.child = null;
    this.dead = true;
    for (const [, p] of this.pending) {
      try {
        p.resolve({});
      } catch {
        // Never throw out of teardown.
      }
    }
    this.pending.clear();
    this.buffer = "";
    try {
      child?.kill();
    } catch {
      // Already exited — nothing to signal.
    }
    if (child && child.exitCode === null) {
      if (final) {
        // Synchronous backstop: a host that ignores SIGTERM during
        // shutdown must still die before process exit — no timer involved.
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited — nothing to signal.
        }
        return;
      }
      // A wedged host can ignore SIGTERM; escalate once against that exact
      // child so a hung process can never leak. The timer holds only the old
      // handle, so it can never signal a replacement host spawned later.
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
    const msg = parseMuseRpcLine(line);
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

  /** Start (or reuse) the connection. Single-flight across callers. */
  async ensureStarted(): Promise<boolean> {
    if (this.isConnected()) return true;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<boolean> {
    this.killChild();
    const timeoutMs = this.opts.timeoutMs ?? museCapacityTimeoutMs();
    const mergedEnv = this.mergedEnv();
    if (!hasMuseCredential(mergedEnv, this.opts.authFilePath ?? resolveMuseAuthFile())) {
      return false;
    }
    const command = this.opts.command ?? resolveMuseBin();
    const args = this.opts.args ?? [...MUSE_SERVE_ARGV];
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...mergedEnv, ...MUSE_CLI_ENV },
      });
    } catch (err) {
      this.startFailure = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "unsupported" : null;
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
    child.on("error", () => {
      if (!this.isCurrentChild(child)) return;
      this.killChild();
    });
    child.stdin?.on("error", () => {
      if (!this.isCurrentChild(child)) return;
      this.killChild();
    });
    child.on("close", () => {
      // Process-local usage state dies with the host (NOT-269 restart rule).
      // Guarded: a SIGTERMed hung child that exits after a restart spawned
      // its replacement must not kill the new host.
      if (!this.isCurrentChild(child)) return;
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
          kind === "auth" ? "auth" : kind === "unsupported" ? "unsupported" : null;
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
    return true;
  }

  private startFailure: "auth" | "unsupported" | null = null;

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
      } else if (!this.observedOnConnection) {
        // The host observed nothing and holds no state worth keeping:
        // release the child instead of parking a lifetime process that
        // can only answer `missing`. The next refresh transparently
        // respawns it; last-good DB rows are untouched either way.
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
      if (this.startFailure === "unsupported") {
        await noteMuseCapacityFailure("unsupported");
        return { status: "failure", reason: "unsupported" };
      }
      // No credential, spawn failure, timeout, or bad exit before the
      // handshake: honest `missing`, last-good rows preserved.
      console.error("[muse-capacity] host start failed: missing");
      await noteMuseCapacityFailure("missing");
      return { status: "missing" };
    }
    this.readSeq += 1;
    const id = `muse-capacity-${this.connectionEpoch}-${this.readSeq}`;
    const res = await this.sendRequest<{
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    }>(id, "usage/read", {}, timeoutMs);
    if (this.dead || !res) {
      console.error("[muse-capacity] host read failed: timeout");
      this.killChild();
      await noteMuseCapacityFailure("missing");
      return { status: "missing" };
    }
    if (res.error) {
      const kind = museClassifyRpcError(res.error);
      if (kind === "auth") {
        console.error("[muse-capacity] host read failed: unauthenticated");
        await noteMuseCapacityFailure("missing");
        return { status: "missing" };
      }
      if (kind === "unsupported") {
        console.error("[muse-capacity] host read failed: unsupported");
        await noteMuseCapacityFailure("unsupported");
        return { status: "failure", reason: "unsupported" };
      }
      console.error("[muse-capacity] host read failed: malformed");
      await noteMuseCapacityFailure("unparsable");
      return { status: "failure", reason: "unparsable" };
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
      return { status: "missing" };
    }
    return { status: "observed", written: outcome.written, skippedStale: outcome.skippedStale };
  }

  /**
   * Clean shutdown: release the child so no host process leaks. Final —
   * a SIGTERM-ignoring host is SIGKILLed synchronously, never left to a
   * timer the exiting event loop may never run.
   */
  async shutdown(): Promise<void> {
    this.killChild(true);
    this.starting = null;
    this.inflightRead = null;
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
