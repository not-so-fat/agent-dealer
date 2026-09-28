// NOT-287: pure view-model for the guided first-issue strip (no React/DOM —
// tested with node:test via tsx). The strip shows only for a truly fresh
// issue history: zero historical issues (including closed), no active list
// filters, and not dismissed for this local profile. A filtered list that
// happens to show zero results must never trigger onboarding, and creating
// the first issue removes the strip via the history count.

export const FIRST_ISSUE_DISMISS_KEY = "agent-dealer:first-issue-dismissed:v1";

export type FirstIssueStep = "agents" | "new-issue";

/** Next incomplete step: configure agents first, otherwise create the issue. */
export function nextFirstIssueStep(agentCount: number): FirstIssueStep {
  return agentCount > 0 ? "new-issue" : "agents";
}

export interface FirstIssueVisibility {
  /** Total historical issues, including closed — null while still loading. */
  historyTotal: number | null;
  /** True when the list URL narrows the view (search/status/repo/attention). */
  filtersActive: boolean;
  /** True when this local profile dismissed the strip. */
  dismissed: boolean;
}

/** Show the strip only on a fresh, unfiltered, undismissed home. While the
 * history count is still loading (null) the strip stays hidden so the
 * operator home never flashes onboarding. */
export function shouldShowFirstIssueStrip(v: FirstIssueVisibility): boolean {
  return v.historyTotal === 0 && !v.filtersActive && !v.dismissed;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Persisted dismissal for this local profile (best-effort — private-mode
 * storage failures simply mean the strip returns next visit). */
export function isFirstIssueDismissed(store: Storage | null = storage()): boolean {
  try {
    return store?.getItem(FIRST_ISSUE_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissFirstIssue(store: Storage | null = storage()): void {
  try {
    store?.setItem(FIRST_ISSUE_DISMISS_KEY, "1");
  } catch {
    // best-effort persistence only
  }
}
