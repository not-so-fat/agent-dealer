// packages/server/src/adapters/muse-capability.ts
//
// NOT-277: Muse Code auto-updates itself (expected, never fought). An update once silently stopped
// granting developer sessions the shell/write tool, and every developer round after it surfaced
// only as a generic `dirty_worktree` escalation. So whenever `muse --version` reports a version not
// yet checked, one real developer-posture session is run whose only path to success is a shell
// call; the result is cached per version (and persisted, so a restart does not re-bill it).
//
// NOT-308: that gate stalled execution ~15 minutes on an inconclusive (timed-out) probe —
// "we don't know yet" blocked exactly like a proven regression, retried forever on a flat
// timer, and never asked anyone to decide. New rule: an update is never assumed guilty.
// While the current version is unchecked (in flight) or its last result is inconclusive
// (error), admission proceeds on the last confirmed baseline and verification continues
// in the background. Only a *confirmed* capability loss (`missing`) blocks admission,
// and it escalates to exactly one human action per version (acknowledge/override, or pin
// /roll back outside Dealer). Inconclusive results retry with backoff (1/2/4 min), at most
// 3 attempts per version; then they escalate once as "could not verify" and stop probing.
// A fresh install with no confirmed baseline at all keeps fail-closed behavior.
//
// The probe is a fresh `muse exec` of the on-disk binary (never the long-lived serve host, which can
// still be the pre-update build). Checks are serialized: a version reported mid-probe is checked
// once the running probe settles, and a verdict for a version no longer reported is discarded.
// Messages name the exact update — the previously reported version → the current one.
//
// Deliberately NOT covered: NOT-177's security-enforcement evidence (`mcp_tool_allowlist_enforcement`,
// `cron_tool_disable`, pinned in the runners' Muse config core) stays manually re-validated as before.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentHealthIssue, HumanAction } from "@agent-dealer/shared";
import { DEVELOPER_ROLE_CEILING } from "@agent-dealer/shared";
import { MUSE_CLI_ENV, resolveMuseBin } from "../cli-env.js";
import { getDataDir } from "../db/index.js";
import { createHumanAction, listHumanActionsByRequestId } from "../repository/human-actions.js";

export type MuseCapabilityProbeResult =
  | { status: "capable" }
  | { status: "missing"; detail: string }
  | { status: "error"; detail: string };

export type MuseCapabilityProbe = (version: string) => Promise<MuseCapabilityProbeResult>;

type CheckedVersion = {
  version: string;
  checkedAt: number;
  /** Consecutive inconclusive results for this version (meaningful for `error` only). */
  attempts: number;
  /** Wall-clock time the probe ran, for escalation text (NOT-308). Null when unknown. */
  durationMs: number | null;
} & MuseCapabilityProbeResult;

type PersistedState = {
  /** Last version whose developer sessions were confirmed to get shell/write access. */
  confirmedVersion: string | null;
  /**
   * The version `muse --version` last reported and the one it was reported before it, so a
   * message names the exact update (B → C), not the last good baseline (A → C).
   */
  current: { version: string; from: string | null } | null;
  /** Result for `current.version` only; a result for any other version is never stored. */
  lastChecked: CheckedVersion | null;
  /**
   * Versions the operator acknowledged via a `muse_capability` human action: a `missing`
   * verdict for one of these no longer blocks admission. Version-scoped and sticky — a
   * later version gets its own verdict and its own escalation.
   */
  overriddenVersions: string[];
};

/**
 * NOT-308: an inconclusive check retries with backoff, not a flat timer — the delay after
 * the Nth consecutive error is ERROR_BACKOFF_MS[N-1]. After MAX_ERROR_ATTEMPTS errors the
 * version is exhausted: it escalates once as "could not verify" and is never re-probed
 * automatically (the 4-minute entry is the delay a fourth attempt would have waited —
 * asserting it never fires is the exhaustion proof).
 */
const ERROR_BACKOFF_MS = [60_000, 2 * 60_000, 4 * 60_000];
const MAX_ERROR_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 5 * 60_000;
const PROBE_MAX_MODEL_STEPS = 20;
const STATE_FILE = "muse-capability.json";
const CAPABILITY = "shell/write access";

let state: PersistedState | null = null;
/** At most one probe at a time (serialized); a newer version is chained after it settles. */
let inFlight: { version: string; promise: Promise<void> } | null = null;
/** Bumped whenever a check settles, so callers can tell a result landed mid-read. */
let settledCount = 0;
/** Bumped by resets so a probe started before a reset cannot write into the fresh state. */
let generation = 0;
let probeImpl: MuseCapabilityProbe = defaultMuseCapabilityProbe;
/** Latest caller hook; a chained check reports through it too. */
let settledHook: () => void = () => {};

function statePath(): string {
  return path.join(getDataDir(), STATE_FILE);
}

function normalizeChecked(raw: unknown, currentVersion: string | null): CheckedVersion | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.version !== "string" || c.version !== currentVersion) return null;
  if (c.status !== "capable" && c.status !== "missing" && c.status !== "error") return null;
  if (typeof c.checkedAt !== "number") return null;
  const status = c.status as MuseCapabilityProbeResult["status"];
  const base = {
    version: c.version,
    checkedAt: c.checkedAt,
    // Pre-NOT-308 files have no attempts counter: a recorded error counts as its first.
    attempts: typeof c.attempts === "number" ? c.attempts : status === "error" ? 1 : 0,
    durationMs: typeof c.durationMs === "number" ? c.durationMs : null,
  };
  if (status === "capable") return { ...base, status };
  return { ...base, status, detail: typeof c.detail === "string" ? c.detail : "" };
}

function loadState(): PersistedState {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<PersistedState>;
    const current =
      parsed.current && typeof parsed.current.version === "string"
        ? { version: parsed.current.version, from: typeof parsed.current.from === "string" ? parsed.current.from : null }
        : null;
    state = {
      confirmedVersion: typeof parsed.confirmedVersion === "string" ? parsed.confirmedVersion : null,
      current,
      lastChecked: normalizeChecked(parsed.lastChecked, current?.version ?? null),
      overriddenVersions: Array.isArray(parsed.overriddenVersions)
        ? parsed.overriddenVersions.filter((v): v is string => typeof v === "string")
        : [],
    };
  } catch {
    state = { confirmedVersion: null, current: null, lastChecked: null, overriddenVersions: [] };
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

/**
 * NOT-308: the safety net (a dirty, shell-less developer session ending on an unconfirmed
 * version) cannot await the paid probe, so it registers here: when the check for `version`
 * settles conclusively bad (`missing`) or inconclusively exhausted, the watcher issue gets
 * its escalation then. Watchers are best-effort and capped — admission-time `ensure`
 * covers every verdict anyway, with dedupe.
 */
let missWatchers: Array<{ version: string; issueId: string }> = [];

function addMissWatcher(version: string, issueId: string): void {
  if (missWatchers.some((w) => w.version === version && w.issueId === issueId)) return;
  missWatchers.push({ version, issueId });
  if (missWatchers.length > 50) missWatchers = missWatchers.slice(-50);
}

/** Drop watchers for every version but `keep` (a version change orphaned them). */
function dropMissWatchersExcept(keep: string | null): void {
  if (keep === null) missWatchers = [];
  else if (missWatchers.some((w) => w.version !== keep)) {
    missWatchers = missWatchers.filter((w) => w.version === keep);
  }
}

/** Record `version` as the one Muse now reports; a change remembers what it changed from. */
function observe(version: string): PersistedState {
  const s = loadState();
  if (s.current?.version === version) return s;
  const from = s.current?.version ?? s.confirmedVersion;
  dropMissWatchersExcept(version);
  saveState({ ...s, current: { version, from: from !== version ? from : null }, lastChecked: null });
  return state!;
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

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "unknown time";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function issueFor(checked: CheckedVersion, from: string | null, exhausted = false): AgentHealthIssue[] {
  if (checked.status === "capable") return [];
  const head = transition(from, checked.version);
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
  // Reachable only with no confirmed baseline (fresh install): with a baseline, an
  // inconclusive result never blocks. An exhausted check says so — it will not retry.
  return [
    {
      code: "runtime_capability",
      message:
        `Could not verify Muse Code developer ${CAPABILITY} after version change ` +
        `(${from && from !== checked.version ? `${from} → ` : ""}${checked.version}): ` +
        `${checked.detail} — developer admission blocked` +
        (exhausted
          ? `; escalated for a human decision (no further automatic checks for this version)`
          : `; the check retries automatically`),
    },
  ];
}

function verifyingIssue(version: string, from: string | null): AgentHealthIssue[] {
  return [
    {
      code: "runtime_capability",
      message:
        `${transition(from, version)}: verifying developer ${CAPABILITY} ` +
        `(one-time check for this version) — developer admission waits for the result`,
    },
  ];
}

/** True once an inconclusive version has spent its whole retry budget. */
function isExhausted(checked: CheckedVersion): boolean {
  return checked.status === "error" && checked.attempts >= MAX_ERROR_ATTEMPTS;
}

/** Current version is unchecked, or its could-not-verify result is due its next backoff retry. */
function checkDue(s: PersistedState): boolean {
  if (!s.current) return false;
  const checked = s.lastChecked;
  if (!checked) return true;
  if (checked.status !== "error" || isExhausted(checked)) return false;
  return Date.now() - checked.checkedAt >= ERROR_BACKOFF_MS[checked.attempts - 1]!;
}

function startCheck(version: string): void {
  const gen = generation;
  const startedAt = Date.now();
  const promise = (async () => {
    let result: MuseCapabilityProbeResult;
    try {
      result = await probeImpl(version);
    } catch (err) {
      result = { status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
    if (gen !== generation) return;
    const prev = loadState();
    // Muse moved on while this probe ran: its verdict is about a build no longer reported, so it
    // must not overwrite state for the newer one (which is checked next, below).
    if (prev.current?.version !== version) return;
    // Only consecutive errors accumulate: a conclusive verdict resets the budget, and a
    // safety-net forced probe past exhaustion just keeps the version exhausted.
    const prevAttempts =
      prev.lastChecked?.version === version && prev.lastChecked.status === "error"
        ? prev.lastChecked.attempts
        : 0;
    const checked: CheckedVersion = {
      version,
      checkedAt: Date.now(),
      attempts: result.status === "error" ? prevAttempts + 1 : 0,
      durationMs: Date.now() - startedAt,
      ...result,
    };
    saveState({
      ...prev,
      confirmedVersion: result.status === "capable" ? version : prev.confirmedVersion,
      lastChecked: checked,
    });
    const from = prev.current.from;
    if (result.status === "capable") {
      console.log(`[muse-capability] ${transition(from, version)}: developer ${CAPABILITY} confirmed`);
      dropMissWatchersExcept(null);
    } else if (result.status === "missing") {
      console.warn(`[muse-capability] ${issueFor(checked, from)[0]!.message}`);
      escalateWatchedVersion(version);
    } else if (isExhausted(checked)) {
      console.warn(
        `[muse-capability] Could not verify Muse Code developer ${CAPABILITY} for ${version} ` +
          `after ${checked.attempts} inconclusive checks (last probe ran ${formatDuration(checked.durationMs)}): ` +
          `escalating once, no further automatic checks; admission continues on baseline ${prev.confirmedVersion ?? "none"}`
      );
      escalateWatchedVersion(version);
    } else if (checked.status === "error") {
      console.warn(
        `[muse-capability] Could not verify Muse Code developer ${CAPABILITY} for ${version} ` +
          `(attempt ${checked.attempts}/${MAX_ERROR_ATTEMPTS}, last probe ran ${formatDuration(checked.durationMs)}): ` +
          `${checked.detail} — retrying in ${formatDuration(ERROR_BACKOFF_MS[checked.attempts - 1]!)}; ` +
          `admission continues on baseline ${prev.confirmedVersion ?? "none"}`
      );
    }
  })().finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
    if (gen !== generation) return;
    settledCount += 1;
    const s = loadState();
    if (!inFlight && s.current && s.current.version !== version && checkDue(s)) startCheck(s.current.version);
    settledHook();
  });
  inFlight = { version, promise };
}

/**
 * Capability issues for the currently reported Muse version. Never awaits the probe.
 *
 * NOT-308: only evidence of a real capability loss (`missing`, and not overridden by the
 * operator) blocks admission. An unchecked version or an inconclusive (`error`) result
 * keeps verifying in the background while admission proceeds on the last confirmed
 * baseline. With no confirmed baseline at all (fresh install), every unknown blocks —
 * fail closed until the first version is confirmed.
 *
 * Checks are serialized — a version observed while another is being probed waits for
 * that probe, then is checked once. `onSettled` lets the caller drop its health cache
 * so admission sees the result as soon as it lands.
 */
export function museCapabilityIssues(version: string, onSettled: () => void = () => {}): AgentHealthIssue[] {
  settledHook = onSettled;
  const s = observe(version);
  const from = s.current!.from;
  if (checkDue(s) && !inFlight) startCheck(version);
  const checked = s.lastChecked;
  // Unchecked (including a retry already running): a baseline means "verify in the
  // background, keep working"; without one the unknown blocks.
  if (!checked) return s.confirmedVersion ? [] : verifyingIssue(version, from);
  if (checked.status === "capable") return [];
  if (checked.status === "missing") {
    return s.overriddenVersions.includes(checked.version) ? [] : issueFor(checked, from);
  }
  // Inconclusive: never a block while any baseline exists to work on.
  return s.confirmedVersion ? [] : issueFor(checked, from, isExhausted(checked));
}

/** Dedupe key for the one human action per Muse version (NOT-308). Stored as the
 * action's request_id so same-issue races collapse on the existing partial unique
 * index, and so cross-issue lookups (`listHumanActionsByRequestId`) find it. */
export function museCapabilityRequestId(version: string): string {
  return `muse-capability:${version}`;
}

export interface MuseCapabilityEvidence {
  kind: "missing" | "unverified";
  version: string;
  from: string | null;
  detail: string;
  durationMs: number | null;
  capability: string;
}

function escalationFor(
  checked: CheckedVersion,
  s: PersistedState
): { kind: "missing" | "unverified"; reason: string; question: string } | null {
  const from = s.current?.version === checked.version ? s.current.from : s.confirmedVersion;
  const baseline = s.confirmedVersion ?? "none";
  if (checked.status === "missing" && !s.overriddenVersions.includes(checked.version)) {
    return {
      kind: "missing",
      reason:
        `${transition(from, checked.version)}: developer sessions no longer get ${CAPABILITY} ` +
        `(${checked.detail}). Last probe ran ${formatDuration(checked.durationMs)} ` +
        `(probe timeout ${formatDuration(PROBE_TIMEOUT_MS)}). ` +
        `Developer admission is blocked for ${checked.version}; last confirmed baseline is ${baseline}.`,
      question:
        `Muse Code ${checked.version} lost developer ${CAPABILITY}. Acknowledge to admit developers ` +
        `on ${checked.version} anyway, or pin/roll back Muse to ${from ?? baseline} outside Dealer ` +
        `(the next version change is checked automatically)?`,
    };
  }
  if (isExhausted(checked) && checked.status === "error") {
    const detail = checked.detail;
    return {
      kind: "unverified",
      reason:
        `Could not verify Muse Code developer ${CAPABILITY} for ${checked.version} after ` +
        `${checked.attempts} inconclusive checks (last: ${detail}; last probe ran ` +
        `${formatDuration(checked.durationMs)}, probe timeout ${formatDuration(PROBE_TIMEOUT_MS)}). ` +
        `Developer admission continues on the last confirmed baseline ${baseline}; ` +
        `no further automatic checks will run for ${checked.version}.`,
      question:
        `Muse Code ${checked.version} could not be verified. Acknowledge to dismiss, ` +
        `or investigate the probe failures (roll back to ${baseline} outside Dealer if the new build is suspect)?`,
    };
  }
  return null;
}

/**
 * NOT-308: raise the human action for a version the gate cannot clear by itself —
 * exactly one per version, on whichever issue first observes the verdict. Later polls
 * (and other issues' admissions) find the open action and skip creation; a resolved one
 * means the operator already decided, so the override is recorded (if missing) and
 * nothing is re-raised. Returns the open action, or null when nothing was (re)raised.
 * Never blocks admission itself — the gate reads file state, not this.
 */
export function ensureMuseCapabilityEscalation(issueId: string): HumanAction | null {
  const s = loadState();
  const checked = s.lastChecked;
  if (!s.current || !checked || checked.version !== s.current.version) return null;
  const escalation = escalationFor(checked, s);
  if (!escalation || checked.status === "capable") return null;
  const detail = checked.detail;
  const requestId = museCapabilityRequestId(checked.version);
  const prior = listHumanActionsByRequestId("muse_capability", requestId);
  const open = prior.find((a) => a.status === "open");
  if (open) return open;
  if (prior.length > 0) {
    // Resolved outside the dedicated path (or before this build learned overrides):
    // the operator's decision stands — record it so the gate agrees, never re-raise.
    if (escalation.kind === "missing") recordMuseCapabilityOverride(checked.version);
    return null;
  }
  return createHumanAction({
    issueId,
    actionType: "muse_capability",
    reason: escalation.reason,
    question: escalation.question,
    evidence: {
      kind: escalation.kind,
      version: checked.version,
      from: s.current.from,
      detail,
      durationMs: checked.durationMs,
      capability: CAPABILITY,
    } satisfies MuseCapabilityEvidence,
    responseOptions: [{ choice: "acknowledge", label: `Acknowledge — ${escalation.kind === "missing" ? `admit on ${checked.version}` : "keep working on baseline"}` }],
    requestId,
  });
}

/** Escalate a safety-net-watched version whose probe just settled badly (best-effort). */
function escalateWatchedVersion(version: string): void {
  const owed = missWatchers.filter((w) => w.version === version);
  missWatchers = missWatchers.filter((w) => w.version !== version);
  for (const w of owed) {
    try {
      ensureMuseCapabilityEscalation(w.issueId);
    } catch (err) {
      console.warn(`[muse-capability] could not escalate ${version} on ${w.issueId}: ${String(err)}`);
    }
  }
}

/**
 * Record the operator's acknowledge/override for a `missing` version (called by the
 * `muse_capability` resolve path). The gate stops blocking that version; later versions
 * are unaffected.
 */
export function recordMuseCapabilityOverride(version: string): void {
  const s = loadState();
  if (s.overriddenVersions.includes(version)) return;
  saveState({ ...s, overriddenVersions: [...s.overriddenVersions, version].slice(-50) });
}

/**
 * Shell-ish tool names in Muse session logs. `bash` is the observed shell tool
 * (fixtures + recorded runs); anything containing `shell` is counted defensively —
 * no known non-shell Muse tool contains it. Unknown future shell names miss the count
 * and cause one extra verification probe, never a missed regression.
 */
const MUSE_SHELL_TOOL_RE = /^(bash|shell)$|^bash[\s_-]|shell/i;

/**
 * Count shell tool calls in a Muse session log. Counts both the normalized
 * `{type:"tool_call", name}` events the spawn writes to logPath and raw
 * `tool:<name>` envelope operations, whichever the file holds. Returns null when
 * the log is unreadable or holds no parseable lines — "unknown", never zero, so an
 * unreadable log alone never fires the safety net.
 */
export function countMuseShellToolCalls(logPath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  let parsed = 0;
  let shells = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let event: unknown;
    try {
      event = JSON.parse(t);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    parsed += 1;
    const rec = event as Record<string, unknown>;
    if (rec.type === "tool_call" && typeof rec.name === "string" && MUSE_SHELL_TOOL_RE.test(rec.name)) {
      shells += 1;
      continue;
    }
    const operation = (rec.payload as Record<string, unknown> | undefined)?.event as
      | Record<string, unknown>
      | undefined;
    const op = operation?.operation;
    if (typeof op === "string" && op.startsWith("tool:") && MUSE_SHELL_TOOL_RE.test(op.slice("tool:".length))) {
      shells += 1;
    }
  }
  return parsed === 0 ? null : shells;
}

export type MuseSafetyNetResult = "probed" | "watching" | "escalated" | "skipped";

/**
 * NOT-308 safety net: a developer session ending with a dirty worktree but zero shell
 * tool calls is exactly what a shell-less build looks like from the outside, so when
 * the running Muse version is not yet the confirmed baseline, verify it immediately —
 * bypassing the error backoff — and escalate a `missing` verdict on this issue.
 * Fire-and-forget (the probe settles in the background and the watcher escalates);
 * never throws and never changes the session outcome.
 */
export function museCapabilitySafetyNetAfterSession(input: {
  issueId: string;
  runtime: string;
  logPath: string;
  dirty: boolean;
}): MuseSafetyNetResult {
  try {
    if (input.runtime !== "muse_code" || !input.dirty) return "skipped";
    const shells = countMuseShellToolCalls(input.logPath);
    if (shells === null || shells > 0) return "skipped";
    const version = reportedMuseVersion();
    if (!version) return "skipped";
    const s = observe(version);
    if (s.confirmedVersion === version) return "skipped";
    const checked = s.lastChecked;
    if (checked && checked.version === version && checked.status === "missing") {
      ensureMuseCapabilityEscalation(input.issueId);
      return "escalated";
    }
    addMissWatcher(version, input.issueId);
    if (inFlight) return "watching";
    // The suspicion (dirty + shell-less) outranks the error backoff timer: probe now
    // instead of waiting it out. Exhaustion does not stop this — the session is fresh
    // evidence, and a `missing` verdict escalates while an `error` just stays exhausted.
    startCheck(version);
    return "probed";
  } catch (err) {
    console.warn(`[muse-capability] safety net skipped: ${String(err)}`);
    return "skipped";
  }
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
  settledHook = () => {};
  missWatchers = [];
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

/** What the on-disk `muse` reports now (null when it cannot say). */
function reportedMuseVersion(): string | null {
  try {
    const out = execFileSync(resolveMuseBin(), ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...MUSE_CLI_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseMuseVersion(out);
  } catch {
    return null;
  }
}

/**
 * One real developer session (same posture and model a developer round uses) in a throwaway
 * git repo. Always a fresh isolated `muse exec` of the on-disk binary — deck-enabled developer
 * turns never use the shared serve host, which may still be the pre-update build — and the
 * binary must still report `version` afterwards, so the verdict is about the build that was
 * probed. Its only path to success is running `sh probe.sh`, which writes a git blob hash of a
 * fresh nonce to result.txt — the model cannot produce that value without a shell call, and the
 * file only exists if the shell could write the workspace.
 *
 * NOT-278: the probe is not a deck session, but the exec lane always carries the
 * selected deck's required server, so the probe binds a real listed deck and preflights it
 * with `get_bound_deck` before spawning — a synthetic id could never pass that identity
 * check. The probe verdict is about the binary's shell/write capability, not about deck
 * reachability: a cheap `/health` check, the deck list, and the preflight run first, and
 * when the deck is down or rejects the probe deck the probe fails closed WITHOUT spending
 * a model session (admission already waits on the deck gate meanwhile; the retry is a
 * cheap health check, not a paid turn). The probe repo lives under the Dealer data dir,
 * never OS temp (the attempt rejects temp dirs) and never the operator home root.
 */
export type MuseCapabilityProbeHooks = {
  timeoutMs?: number;
  /** Tests: substitute deck discovery (defaults to the live `fetchDecks`). */
  listDecks?: () => Promise<
    | { ok: true; decks: Array<{ id: string; name: string }> }
    | { ok: false; code: string; message: string }
  >;
  /** Tests: substitute the live `get_bound_deck` preflight (defaults to `verifyWorkerDeckConnection`). */
  verifyDeck?: (args: { deckId: string; worktreePath: string }) => Promise<
    | { ok: true }
    | { ok: false; kind: "infra_failure" | "deck_unavailable"; reason: string }
  >;
};

export async function defaultMuseCapabilityProbe(
  version: string,
  opts: MuseCapabilityProbeHooks = {}
): Promise<MuseCapabilityProbeResult> {
  const [{ runMuseDeveloperSession }, { getAgentDeckMcpUrl, checkAgentDeckHealth, fetchDecks }] =
    await Promise.all([
      import("../coordinator/muse-spawn.js"),
      import("./agent-deck.js"),
    ]);
  const { verifyWorkerDeckConnection } = await import("./agent-deck-bind.js");
  const listDecks = opts.listDecks ?? fetchDecks;
  const verifyDeck =
    opts.verifyDeck ??
    ((args: { deckId: string; worktreePath: string }) =>
      verifyWorkerDeckConnection({ deckId: args.deckId, worktreePath: args.worktreePath, playbookIds: [] }));
  // Decouple the paid capability check from deck reachability: when the deck is down, fail
  // closed here — before any child exists — instead of burning a model session that could
  // only fail on its required deck server. The deck gate (`deck_offline`) already blocks
  // admission meanwhile, and the error-retry path re-runs this cheap check, not a turn.
  if (!(await checkAgentDeckHealth())) {
    return {
      status: "error",
      detail: `Agent Deck is unreachable — capability check for ${version} not run (no model session spent)`,
    };
  }
  const scratchParent = path.join(getDataDir(), ".temporal");
  fs.mkdirSync(scratchParent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchParent, "muse-capability-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const nonce = randomUUID();
    fs.writeFileSync(
      path.join(dir, "probe.sh"),
      `#!/bin/sh\nprintf '%s' '${nonce}' | git hash-object --stdin > result.txt\n`
    );
    // The probe session must bind a real deck: a synthetic id could never pass the
    // production `get_bound_deck` identity check, so it would either burn a paid turn
    // that only fails on its required deck server, or run on an unselected deck. List
    // the live decks and preflight the bound one before spawning — a deck that answers
    // but rejects this id fails closed here, with no model session spent.
    const listed = await listDecks();
    if (!listed.ok) {
      return {
        status: "error",
        detail: `Agent Deck deck list unavailable (${listed.message}) — capability check for ${version} not run (no model session spent)`,
      };
    }
    const probeDeckId = listed.decks[0]?.id;
    if (!probeDeckId) {
      return {
        status: "error",
        detail: `Agent Deck listed no decks — capability check for ${version} not run (no model session spent)`,
      };
    }
    const verified = await verifyDeck({ deckId: probeDeckId, worktreePath: dir });
    if (!verified.ok) {
      return {
        status: "error",
        detail:
          verified.kind === "deck_unavailable"
            ? `Agent Deck is unreachable for deck ${probeDeckId} (${verified.reason}) — capability check for ${version} not run (no model session spent)`
            : `Agent Deck rejected probe deck ${probeDeckId} (${verified.reason}) — capability check for ${version} not run (no model session spent)`,
      };
    }
    const run = await runMuseDeveloperSession({
      sessionId: randomUUID(),
      runtime: "muse_code",
      policy: DEVELOPER_ROLE_CEILING,
      model: null,
      deckId: probeDeckId,
      agentDeckUrl: `${getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "")}/mcp`,
      maxModelSteps: PROBE_MAX_MODEL_STEPS,
      prompt:
        "Dealer capability check. Using your shell tool, run exactly this command in the current " +
        "directory: sh probe.sh\nDo not create or edit result.txt any other way. When the command " +
        "has finished, reply with the single word DONE.",
      cwd: dir,
      timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      logPath: path.join(dir, "probe.ndjson"),
    });
    const after = reportedMuseVersion();
    if (after !== version) {
      return {
        status: "error",
        detail: `muse reported ${after ?? "no version"} after probing ${version} (changed during the check)`,
      };
    }
    let written: string | null = null;
    try {
      written = fs.readFileSync(path.join(dir, "result.txt"), "utf8").trim();
    } catch {
      written = null;
    }
    // A session that did not complete cleanly is never a verdict, even if the shell ran first.
    if (run.timedOut) return { status: "error", detail: `probe session on ${version} timed out` };
    const failure = run.muse?.failure;
    if (failure) return { status: "error", detail: `probe session failed (${failure.kind}: ${failure.message})` };
    if (run.exitCode !== 0) return { status: "error", detail: `probe session exited ${run.exitCode}` };
    if (written === gitBlobSha1(nonce)) return { status: "capable" };
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
