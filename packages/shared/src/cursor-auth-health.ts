import type { AgentHealthIssue } from "./agents.js";

/** Shared remediation for Cursor macOS keychain stuck-auth (NOT-114 / NOT-103). */
export const CURSOR_KEYCHAIN_REMEDIATION =
  "Cursor macOS keychain auth is stuck (errSecDuplicateItem). Delete the item and sign in again: " +
  "`security delete-generic-password -s cursor-access-token -a cursor-user` then `agent login` " +
  "(or `cursor-agent login`). See docs/TROUBLESHOOTING.md#cursor-macos-keychain-auth.";

export const CURSOR_KEYCHAIN_HEALTH_ISSUE: AgentHealthIssue = {
  code: "cursor_keychain",
  message: CURSOR_KEYCHAIN_REMEDIATION,
};

const KEYCHAIN_STUCK_PATTERNS: RegExp[] = [
  /errsecduplicateitem/i,
  /security exit code 45/i,
  /keychain item is stuck/i,
  /couldn't save your login to the macOS keychain/i,
  /could not save your login to the macOS keychain/i,
];

/** True when Cursor status/login/stderr indicates a stuck macOS keychain item. */
export function isCursorKeychainStuckOutput(output: string): boolean {
  return KEYCHAIN_STUCK_PATTERNS.some((re) => re.test(output));
}

/**
 * Classify Cursor auth health from status/login/stderr text.
 * Keychain stuck wins over generic "not logged in" (same remediations differ).
 * Also usable by session failure classifiers (NOT-113) for the same remediation string.
 */
export function cursorAuthIssueFromOutput(output: string): AgentHealthIssue | null {
  if (isCursorKeychainStuckOutput(output)) {
    return { ...CURSOR_KEYCHAIN_HEALTH_ISSUE };
  }
  const out = output.toLowerCase();
  if (
    out.includes("not logged in") ||
    out.includes("login required") ||
    out.includes("not authenticated")
  ) {
    return { code: "runtime_auth", message: "Run cursor-agent login" };
  }
  return null;
}
