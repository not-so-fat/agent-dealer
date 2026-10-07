// packages/server/src/coordinator/runtime-auth-park.ts
//
// NOT-368: mid-run runtime login failures that the live auth probe still confirms are
// parked for a human (policy_escalation) instead of burning the infra-retry budget.
// Detection stays in runtime-auth-health / failure-cause; this module owns the park
// evidence shape, the probe tie-breaker, the consecutive-park cap, and the resolve-time
// re-probe gate.
import type { AgentHealthIssue, Runtime } from "@agent-dealer/shared";
import {
  CLAUDE_AUTH_REMEDIATION,
  CODEX_AUTH_REMEDIATION,
  CURSOR_AUTH_REMEDIATION,
  CURSOR_KEYCHAIN_REMEDIATION,
  MUSE_AUTH_REMEDIATION,
  RUNTIME_AUTH_LABEL,
} from "@agent-dealer/shared";

/** Cap on consecutive confirmed auth parks per issue before a distinct escalation. */
export const MAX_CONSECUTIVE_AUTH_PARKS = 3;

/** Evidence key on a policy_escalation raised for a confirmed runtime login failure. */
export const RUNTIME_AUTH_PARK_EVIDENCE_KEY = "runtimeAuthPark";

/** Work-item payload flag: this developer/reviewer retry spent the one transient auth retry. */
export const AUTH_TRANSIENT_RETRY_PAYLOAD_KEY = "authTransientRetry";

export type RuntimeAuthParkEvidence = {
  runtime: Runtime;
  remediation: string;
  rawCause: string;
  /** 1-based park ordinal within the consecutive streak (1..MAX). */
  consecutivePark: number;
};

/**
 * High-confidence auth failure context for the session_failed / timed_out route.
 * Medium / unattributed auth is omitted — those keep today's infra-retry path.
 */
export type AuthFailureRouting = {
  confidence: "high";
  runtime: Runtime;
  remediation: string;
  rawCause: string;
  /** Live probe still reports runtime_auth or cursor_keychain. */
  probeStillFailing: boolean;
  /** Auth parks already on this issue in the current consecutive streak. */
  consecutiveAuthParks: number;
  /** A prior high-confidence auth failure on this issue already took the one transient retry. */
  authTransientRetrySpent: boolean;
};

const REMEDIATION_BY_RUNTIME: Record<Runtime, string> = {
  cursor_local: CURSOR_AUTH_REMEDIATION,
  codex_local: CODEX_AUTH_REMEDIATION,
  claude_code: CLAUDE_AUTH_REMEDIATION,
  muse_code: MUSE_AUTH_REMEDIATION,
};

/** True when the live auth probe still says the runtime cannot authenticate. */
export function authProbeConfirmsFailure(issues: readonly AgentHealthIssue[]): boolean {
  return issues.some((i) => i.code === "runtime_auth" || i.code === "cursor_keychain");
}

/** Prefer the probe's own remediation text when present; else the classified one. */
export function remediationFromProbe(
  issues: readonly AgentHealthIssue[],
  fallback: string
): string {
  const hit = issues.find((i) => i.code === "runtime_auth" || i.code === "cursor_keychain");
  return hit?.message?.trim() ? hit.message : fallback;
}

export function defaultRemediationForRuntime(runtime: Runtime, keychain = false): string {
  if (runtime === "cursor_local" && keychain) return CURSOR_KEYCHAIN_REMEDIATION;
  return REMEDIATION_BY_RUNTIME[runtime];
}

export function parseRuntimeAuthParkEvidence(
  evidenceJson: string | null | undefined
): RuntimeAuthParkEvidence | null {
  if (!evidenceJson) return null;
  try {
    const parsed = JSON.parse(evidenceJson) as Record<string, unknown>;
    const raw = parsed[RUNTIME_AUTH_PARK_EVIDENCE_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const ev = raw as Record<string, unknown>;
    if (
      (ev.runtime !== "cursor_local" &&
        ev.runtime !== "codex_local" &&
        ev.runtime !== "claude_code" &&
        ev.runtime !== "muse_code") ||
      typeof ev.remediation !== "string" ||
      typeof ev.rawCause !== "string" ||
      typeof ev.consecutivePark !== "number"
    ) {
      return null;
    }
    return {
      runtime: ev.runtime,
      remediation: ev.remediation,
      rawCause: ev.rawCause,
      consecutivePark: ev.consecutivePark,
    };
  } catch {
    return null;
  }
}

export function isRuntimeAuthParkAction(action: { evidenceJson: string | null }): boolean {
  return parseRuntimeAuthParkEvidence(action.evidenceJson) != null;
}

/**
 * Resolve-time re-probe gate (NOT-368). A still-failing probe keeps the action open;
 * a passing probe lets resume proceed (no round / infra charge — same as NOT-93 park resume).
 */
export type AuthParkResolveGate =
  | { proceed: true }
  | { proceed: false; remediation: string; message: string };

export function gateRuntimeAuthParkResume(opts: {
  evidence: RuntimeAuthParkEvidence;
  probeStillFailing: boolean;
  probeRemediation?: string;
}): AuthParkResolveGate {
  if (!opts.probeStillFailing) return { proceed: true };
  const remediation = opts.probeRemediation?.trim() || opts.evidence.remediation;
  const label = RUNTIME_AUTH_LABEL[opts.evidence.runtime];
  return {
    proceed: false,
    remediation,
    message: `${label} is still not authenticated — ${remediation}`,
  };
}

/** Operator-facing reason for a confirmed auth park (parks 1–3). */
export function authParkReason(opts: {
  runtime: Runtime;
  remediation: string;
  rawCause: string;
}): string {
  const label = RUNTIME_AUTH_LABEL[opts.runtime];
  return (
    `${label} is not logged in — ${opts.remediation}` +
    (opts.rawCause.trim() ? `\n\nCause: ${opts.rawCause.trim()}` : "")
  );
}

/** Distinct escalation after MAX consecutive auth parks (the 4th confirmed failure). */
export function repeatedAuthEscalationReason(opts: {
  runtime: Runtime;
  remediation: string;
  rawCause: string;
  priorParks: number;
}): string {
  const label = RUNTIME_AUTH_LABEL[opts.runtime];
  return (
    `Repeated ${label} login failures after ${opts.priorParks} parks — ` +
    `fix authentication before resuming. ${opts.remediation}` +
    (opts.rawCause.trim() ? `\n\nCause: ${opts.rawCause.trim()}` : "")
  );
}
