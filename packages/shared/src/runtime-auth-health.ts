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

/**
 * Used when text proves an auth failure but does not say which CLI printed it. All three
 * runtimes print a bare `Not logged in`, so naming one of them there would be a guess — and
 * a confidently wrong remediation (`cursor-agent login` for a Codex log) is worse than the
 * generic crash reason it replaces.
 */
export const AMBIGUOUS_AUTH_REMEDIATION =
  "A runtime CLI reported it is not authenticated, but the log does not say which one — " +
  "check the agent's runtime login: `cursor-agent login`, `codex login`, or `claude auth login`";

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

/**
 * Which CLI *wrote* this text, as opposed to what it said. The auth pattern lists above
 * overlap by design — `not logged in` is printed verbatim by cursor-agent, codex and claude
 * alike — so they answer "is this an auth failure", never "whose failure is it". These
 * anchors answer the second question: each names its own vendor, binary or credential
 * variable, which no other runtime has a reason to print. Anything that matches none of them
 * (or more than one) is left unattributed rather than guessed at.
 */
const RUNTIME_VENDOR_ANCHORS: Record<Runtime, RegExp[]> = {
  // "set CURSOR_API_KEY environment variable" / "run `cursor-agent login`".
  cursor_local: [/cursor[_-]api[_-]key/i, /cursor-agent\b/i],
  // "OpenAI Codex v0.154.0", "url: wss://api.openai.com/...", OPENAI_API_KEY, `codex login`.
  codex_local: [/openai/i, /\bcodex\b/i],
  // "Please run /login", ANTHROPIC_API_KEY, `claude auth login`.
  claude_code: [/anthropic/i, /please run \/login/i, /\bclaude\b/i],
};

const AUTH_PATTERNS_BY_RUNTIME: Record<Runtime, RegExp[]> = {
  cursor_local: CURSOR_AUTH_PATTERNS,
  codex_local: CODEX_AUTH_PATTERNS,
  claude_code: CLAUDE_AUTH_PATTERNS,
};

const ALL_RUNTIMES = ["cursor_local", "codex_local", "claude_code"] as const;

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

/** `runtime: null` means "definitely an auth failure, but the text does not name the CLI". */
export type RuntimeAuthClassification = {
  runtime: Runtime | null;
  issue: AgentHealthIssue;
};

/**
 * Classify a log whose runtime is unknown — the failure-reason classifier reads a spawn log
 * by path and does not always know which CLI wrote it (worker_sessions.runtime is nullable,
 * and older rows disagree with what actually ran).
 *
 * Attribution is deliberately conservative, in this order:
 *  1. a single vendor anchor in text that also reads as that runtime's auth failure;
 *  2. otherwise, an auth failure only one runtime's patterns recognise at all;
 *  3. otherwise unattributed (`runtime: null`) with the generic remediation.
 *
 * Trying the runtimes in a fixed order instead would report Claude's `Not logged in · Please
 * run /login` as Cursor, because Cursor's list carries the shared `not logged in` too.
 */
export function anyRuntimeAuthIssueFromOutput(output: string): RuntimeAuthClassification | null {
  // The keychain signature names Cursor on its own (errSecDuplicateItem / macOS keychain).
  if (isCursorKeychainStuckOutput(output)) {
    return { runtime: "cursor_local", issue: { ...CURSOR_KEYCHAIN_HEALTH_ISSUE } };
  }
  const matched = ALL_RUNTIMES.filter((r) =>
    AUTH_PATTERNS_BY_RUNTIME[r].some((re) => re.test(output))
  );
  if (matched.length === 0) return null;
  // Anchors are only consulted within the runtimes whose auth prose matched, so a log that
  // merely mentions another CLI by name cannot steal the attribution.
  const anchored = matched.filter((r) => RUNTIME_VENDOR_ANCHORS[r].some((re) => re.test(output)));
  const named = anchored.length === 1 ? anchored[0] : matched.length === 1 ? matched[0] : null;
  if (named) {
    return { runtime: named, issue: { code: "runtime_auth", message: REMEDIATION_BY_RUNTIME[named] } };
  }
  return { runtime: null, issue: { code: "runtime_auth", message: AMBIGUOUS_AUTH_REMEDIATION } };
}
