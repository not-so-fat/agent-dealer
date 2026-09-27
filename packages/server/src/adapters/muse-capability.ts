// packages/server/src/adapters/muse-capability.ts
//
// NOT-277: Muse Code auto-updates itself (expected, never fought). An update once silently stopped
// granting developer sessions the shell/write tool, and every developer round after it surfaced
// only as a generic `dirty_worktree` escalation. So whenever `muse --version` reports a version not
// yet checked, one real developer-posture session is run whose only path to success is a shell
// call; the result is cached per version (and persisted, so a restart does not re-bill it):
//
//  - capable      → recorded as the confirmed baseline, admission proceeds with no manual step;
//  - missing      → developer admission blocked, message names old → new version + capability;
//  - error        → the check could not complete: blocked with a distinct "could not verify"
//                   message (fail closed), retried after a backoff;
//  - in flight    → blocked while the one-time check runs (never assumed capable).
//
// Deliberately NOT covered: NOT-177's security-enforcement evidence (`mcp_tool_allowlist_enforcement`,
// `cron_tool_disable` in runners/muse-config-core.ts) stays manually re-validated as before.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentHealthIssue } from "@agent-dealer/shared";
import { DEVELOPER_ROLE_CEILING } from "@agent-dealer/shared";
import { getDataDir } from "../db/index.js";

export type MuseCapabilityProbeResult =
  | { status: "capable" }
  | { status: "missing"; detail: string }
  | { status: "error"; detail: string };

export type MuseCapabilityProbe = (version: string) => Promise<MuseCapabilityProbeResult>;

type CheckedVersion = { version: string; checkedAt: number } & MuseCapabilityProbeResult;

type PersistedState = {
  /** Last version whose developer sessions were confirmed to get shell/write access. */
  confirmedVersion: string | null;
  lastChecked: CheckedVersion | null;
};

/** A probe that could not complete is retried after this long (the block stays up meanwhile). */
const ERROR_RETRY_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 5 * 60_000;
const PROBE_MAX_MODEL_STEPS = 20;
const STATE_FILE = "muse-capability.json";
const CAPABILITY = "shell/write access";

let state: PersistedState | null = null;
let inFlight: { version: string; promise: Promise<void> } | null = null;
/** Bumped whenever a check settles, so callers can tell a result landed mid-read. */
let settledCount = 0;
/** Bumped by resets so a probe started before a reset cannot write into the fresh state. */
let generation = 0;
let probeImpl: MuseCapabilityProbe = defaultMuseCapabilityProbe;

function statePath(): string {
  return path.join(getDataDir(), STATE_FILE);
}

function loadState(): PersistedState {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<PersistedState>;
    state = {
      confirmedVersion: typeof parsed.confirmedVersion === "string" ? parsed.confirmedVersion : null,
      lastChecked: parsed.lastChecked && typeof parsed.lastChecked.version === "string" ? parsed.lastChecked : null,
    };
  } catch {
    state = { confirmedVersion: null, lastChecked: null };
  }
  return state;
}

function saveState(next: PersistedState): void {
  state = next;
  try {
    fs.writeFileSync(statePath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    // In-memory state still gates this process; only restart persistence is lost.
    console.warn(`[muse-capability] could not persist ${statePath()}: ${String(err)}`);
  }
}

/** `Muse Code 1.3.0 (1.3.0-R3401.1)` → `1.3.0-R3401.1`; otherwise the last non-empty line. */
export function parseMuseVersion(output: string): string | null {
  const paren = /\(([^()\s]+)\)\s*$/m.exec(output.trim());
  if (paren) return paren[1]!;
  const last = output.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return last ?? null;
}

function transition(from: string | null, to: string): string {
  return from && from !== to ? `Muse Code updated ${from} → ${to}` : `Muse Code ${to}`;
}

function issueFor(checked: CheckedVersion, confirmedVersion: string | null): AgentHealthIssue[] {
  if (checked.status === "capable") return [];
  const head = transition(confirmedVersion, checked.version);
  if (checked.status === "missing") {
    return [
      {
        code: "runtime_capability",
        message:
          `${head}: developer sessions no longer get ${CAPABILITY} (${checked.detail}) — ` +
          `developer admission blocked until a Muse Code version passes the check`,
      },
    ];
  }
  return [
    {
      code: "runtime_capability",
      message:
        `Could not verify Muse Code developer ${CAPABILITY} after version change ` +
        `(${confirmedVersion && confirmedVersion !== checked.version ? `${confirmedVersion} → ` : ""}${checked.version}): ` +
        `${checked.detail} — developer admission blocked; the check retries automatically`,
    },
  ];
}

function startCheck(version: string, onSettled: () => void): void {
  const gen = generation;
  const promise = (async () => {
    let result: MuseCapabilityProbeResult;
    try {
      result = await probeImpl(version);
    } catch (err) {
      result = { status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
    if (gen !== generation) return;
    const prev = loadState();
    const checked: CheckedVersion = { version, checkedAt: Date.now(), ...result };
    saveState({
      confirmedVersion: result.status === "capable" ? version : prev.confirmedVersion,
      lastChecked: checked,
    });
    const from = prev.confirmedVersion;
    if (result.status === "capable") {
      console.log(`[muse-capability] ${transition(from, version)}: developer ${CAPABILITY} confirmed`);
    } else {
      console.warn(`[muse-capability] ${issueFor(checked, from)[0]!.message}`);
    }
  })().finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
    settledCount += 1;
    if (gen === generation) onSettled();
  });
  inFlight = { version, promise };
}

/**
 * Capability issues for the currently reported Muse version. Never awaits the probe: a version not
 * yet checked starts one background check (single-flight) and blocks until it settles; `onSettled`
 * lets the caller drop its health cache so admission unblocks as soon as the result is in.
 */
export function museCapabilityIssues(version: string, onSettled: () => void = () => {}): AgentHealthIssue[] {
  const s = loadState();
  const checked = s.lastChecked?.version === version ? s.lastChecked : null;
  const retryDue = checked?.status === "error" && Date.now() - checked.checkedAt >= ERROR_RETRY_MS;
  if (checked && !retryDue) return issueFor(checked, s.confirmedVersion);

  if (!inFlight || inFlight.version !== version) startCheck(version, onSettled);
  if (checked) return issueFor(checked, s.confirmedVersion); // error retry: keep the block up
  return [
    {
      code: "runtime_capability",
      message:
        `${transition(s.confirmedVersion, version)}: verifying developer ${CAPABILITY} ` +
        `(one-time check for this version) — developer admission waits for the result`,
    },
  ];
}

/** True while a capability check is running (callers use a short health-cache TTL meanwhile). */
export function museCapabilityCheckInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Changes each time a check settles. A health read that spans a settle must not cache what it
 * read — it may be the "verifying" block the settle just superseded.
 */
export function museCapabilitySettleCount(): number {
  return settledCount;
}

/** Tests: resolve once any in-flight capability check has settled. */
export async function settleMuseCapabilityCheckForTests(): Promise<void> {
  while (inFlight) await inFlight.promise;
}

/** Tests: replace the real `muse` probe. Pass `null` to restore it. */
export function setMuseCapabilityProbeForTests(fn: MuseCapabilityProbe | null): void {
  probeImpl = fn ?? defaultMuseCapabilityProbe;
}

/** Tests: forget in-memory and persisted state; any in-flight probe result is discarded. */
export function resetMuseCapabilityStateForTests(): void {
  generation += 1;
  inFlight = null;
  state = null;
  fs.rmSync(statePath(), { force: true });
}

/** Tests: backdate the last check so the error-retry path can be exercised without waiting. */
export function ageMuseCapabilityCheckForTests(ms: number): void {
  const s = loadState();
  if (s.lastChecked) saveState({ ...s, lastChecked: { ...s.lastChecked, checkedAt: s.lastChecked.checkedAt - ms } });
}

/** `git hash-object` of a string — what `probe.sh` writes; not computable without running it. */
function gitBlobSha1(content: string): string {
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

/**
 * One real developer session (same lane, posture and model a developer round uses) in a throwaway
 * git repo. Its only path to success is running `sh probe.sh`, which writes a git blob hash of a
 * fresh nonce to result.txt — the model cannot produce that value without a shell call, and the
 * file only exists if the shell could write the workspace.
 */
export async function defaultMuseCapabilityProbe(version: string): Promise<MuseCapabilityProbeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-capability-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const nonce = randomUUID();
    fs.writeFileSync(
      path.join(dir, "probe.sh"),
      `#!/bin/sh\nprintf '%s' '${nonce}' | git hash-object --stdin > result.txt\n`
    );
    const { runMuseDeveloperSession } = await import("../coordinator/muse-spawn.js");
    const run = await runMuseDeveloperSession({
      sessionId: randomUUID(),
      runtime: "muse_code",
      policy: DEVELOPER_ROLE_CEILING,
      model: null,
      maxModelSteps: PROBE_MAX_MODEL_STEPS,
      prompt:
        "Dealer capability check. Using your shell tool, run exactly this command in the current " +
        "directory: sh probe.sh\nDo not create or edit result.txt any other way. When the command " +
        "has finished, reply with the single word DONE.",
      cwd: dir,
      timeoutMs: PROBE_TIMEOUT_MS,
      logPath: path.join(dir, "probe.ndjson"),
    });
    let written: string | null = null;
    try {
      written = fs.readFileSync(path.join(dir, "result.txt"), "utf8").trim();
    } catch {
      written = null;
    }
    if (written === gitBlobSha1(nonce)) return { status: "capable" };
    if (run.timedOut) return { status: "error", detail: `probe session on ${version} timed out` };
    const failure = run.muse?.failure;
    if (failure) return { status: "error", detail: `probe session failed (${failure.kind}: ${failure.message})` };
    if (run.exitCode !== 0) return { status: "error", detail: `probe session exited ${run.exitCode}` };
    return {
      status: "missing",
      detail:
        written === null
          ? "probe session completed without running its shell command"
          : "probe session completed but the shell command's output was not produced",
    };
  } catch (err) {
    return { status: "error", detail: `probe could not run: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
