// packages/shared/src/runtime-auth-health.ts
//
// Classify runtime CLI auth failures from status/login/stderr text. One module feeds two
// consumers, so a missed string costs twice: the admission health preflight
// (adapters/agent-health.ts) admits an agent that cannot authenticate, and the operator
// failure strip (coordinator/failure-reason.ts, NOT-113) falls back to "session failed or
// crashed" with no mention of auth.
//
// NOT-133: every pattern below is pinned by a verbatim capture in
// `src/fixtures/runtime-auth/` — see that directory's README. The bug this file is named
// for was a pattern list written from imagination (`"login required"`) that never covered
// what cursor-agent prints (`"Authentication required"`).
import type { AgentHealthIssue } from "./agents.js";
import type { Runtime } from "./runtime.js";

/** Shared remediation for Cursor macOS keychain stuck-auth (NOT-114 / NOT-103). */
export const CURSOR_KEYCHAIN_REMEDIATION =
  "Cursor macOS keychain auth is stuck (errSecDuplicateItem). Delete the item and sign in again: " +
  "`security delete-generic-password -s cursor-access-token -a cursor-user` then `agent login` " +
  "(or `cursor-agent login`). See docs/TROUBLESHOOTING.md#cursor-macos-keychain-auth.";

export const CURSOR_KEYCHAIN_HEALTH_ISSUE: AgentHealthIssue = {
  code: "cursor_keychain",
  message: CURSOR_KEYCHAIN_REMEDIATION,
};

/**
 * Remediations quote both routes the CLI itself offers. The old Cursor message named only
 * `cursor-agent login`, while the CLI's own logged-out line offers `agent login` *or*
 * `CURSOR_API_KEY` — an operator running headless needs the second one.
 */
export const CURSOR_AUTH_REMEDIATION =
  "Cursor is not authenticated — run `cursor-agent login` (the CLI calls it `agent login`), " +
  "or set CURSOR_API_KEY for automation";

export const CODEX_AUTH_REMEDIATION = "Run `codex login` (or set OPENAI_API_KEY for automation)";

export const CLAUDE_AUTH_REMEDIATION =
  "Claude Code is not authenticated — run `claude auth login` (`/login` inside a session), " +
  "or set ANTHROPIC_API_KEY for automation";

const KEYCHAIN_STUCK_PATTERNS: RegExp[] = [
  /errsecduplicateitem/i,
  /security exit code 45/i,
  /keychain item is stuck/i,
  /couldn't save your login to the macOS keychain/i,
  /could not save your login to the macOS keychain/i,
];

/**
 * Patterns are matched against raw CLI text, ANSI escapes and all — the captures keep
 * theirs, and cursor-agent colourises the very lines we key on.
 */
const CURSOR_AUTH_PATTERNS: RegExp[] = [
  // `cursor-agent -p` when logged out (cursor-agent-print-logged-out.txt). The string
  // NOT-133 was filed for: 12 sessions died on it while every pattern here missed.
  /authentication required/i,
  // Same line's remediation. Kept as a second anchor because remediation text drifts less
  // than error prose — if the sentence above is reworded again, this still catches it.
  /set CURSOR_API_KEY/i,
  // `cursor-agent status` when logged out (cursor-agent-status-logged-out.txt) — exits 0.
  /not logged in/i,
  // `cursor-agent -p` with a bad CURSOR_API_KEY (cursor-agent-print-invalid-api-key.txt).
  /the provided api key is invalid/i,
  // Retained from NOT-114. No capture prints these, but removing them could only narrow
  // coverage of CLI versions nobody has captured.
  /login required/i,
  /not authenticated/i,
];

const CODEX_AUTH_PATTERNS: RegExp[] = [
  // `codex login status` when logged out (codex-login-status-logged-out.txt) — exits 1.
  /not logged in/i,
  // `codex exec` when logged out (codex-exec-logged-out.txt): the session spawns and then
  // fails every request, so this is what a dead codex session's log actually contains.
  /401 unauthorized/i,
  /missing bearer or basic authentication/i,
];

const CLAUDE_AUTH_PATTERNS: RegExp[] = [
  // `claude -p` when logged out (claude-print-logged-out.txt): "Not logged in · Please run /login".
  /not logged in/i,
  /please run \/login/i,
  // `claude auth status` when logged out (claude-auth-status-logged-out.txt) — exits 0, so
  // the JSON body is the only signal.
  /"loggedIn"\s*:\s*false/i,
  // `claude -p` with an invalid ANTHROPIC_API_KEY (claude-print-invalid-api-key.txt).
  /failed to authenticate/i,
  /api key is invalid/i,
];

const AUTH_PATTERNS_BY_RUNTIME: Record<Runtime, RegExp[]> = {
  cursor_local: CURSOR_AUTH_PATTERNS,
  codex_local: CODEX_AUTH_PATTERNS,
  claude_code: CLAUDE_AUTH_PATTERNS,
};

const REMEDIATION_BY_RUNTIME: Record<Runtime, string> = {
  cursor_local: CURSOR_AUTH_REMEDIATION,
  codex_local: CODEX_AUTH_REMEDIATION,
  claude_code: CLAUDE_AUTH_REMEDIATION,
};

/** Operator-facing runtime names for prose built out of a classification. */
export const RUNTIME_AUTH_LABEL: Record<Runtime, string> = {
  cursor_local: "Cursor",
  codex_local: "Codex",
  claude_code: "Claude Code",
};

/** True when Cursor status/login/stderr indicates a stuck macOS keychain item. */
export function isCursorKeychainStuckOutput(output: string): boolean {
  return KEYCHAIN_STUCK_PATTERNS.some((re) => re.test(output));
}

/**
 * Classify one runtime's status/login/stderr text.
 * Cursor's keychain case wins over its plain logged-out case — same symptom, different fix.
 */
export function runtimeAuthIssueFromOutput(
  runtime: Runtime,
  output: string
): AgentHealthIssue | null {
  if (runtime === "cursor_local" && isCursorKeychainStuckOutput(output)) {
    return { ...CURSOR_KEYCHAIN_HEALTH_ISSUE };
  }
  if (AUTH_PATTERNS_BY_RUNTIME[runtime].some((re) => re.test(output))) {
    return { code: "runtime_auth", message: REMEDIATION_BY_RUNTIME[runtime] };
  }
  return null;
}

/**
 * Classify Cursor auth health from status/login/stderr text.
 * Also usable by session failure classifiers (NOT-113) for the same remediation string.
 */
export function cursorAuthIssueFromOutput(output: string): AgentHealthIssue | null {
  return runtimeAuthIssueFromOutput("cursor_local", output);
}

/**
 * Classify a log whose runtime is unknown — the failure-reason classifier reads a spawn log
 * by path and does not always know which CLI wrote it. Cursor is tried first because its
 * keychain branch is the most specific classification available; the remaining runtimes'
 * patterns are distinct enough that the first match names the right CLI.
 */
export function anyRuntimeAuthIssueFromOutput(
  output: string
): { runtime: Runtime; issue: AgentHealthIssue } | null {
  for (const runtime of ["cursor_local", "codex_local", "claude_code"] as const) {
    const issue = runtimeAuthIssueFromOutput(runtime, output);
    if (issue) return { runtime, issue };
  }
  return null;
}
