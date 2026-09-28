// NOT-287: pure view-model for the guided first-issue strip (no React/DOM —
// tested with node:test via tsx). The strip shows only for a truly fresh
// issue history: zero historical issues (including closed), no active list
// filters, and not dismissed for this local profile. A filtered list that
// happens to show zero results must never trigger onboarding, and creating
// the first issue removes the strip via the history count.

import type { AgentWithHealth } from "@agent-dealer/shared";

export const FIRST_ISSUE_DISMISS_KEY = "agent-dealer:first-issue-dismissed:v1";

export type FirstIssueStep = "agents" | "new-issue";

/** An agent can develop when it is healthy (any runtime runs a session). */
export function canDevelop(agent: AgentWithHealth): boolean {
  return agent.healthy;
}

/** Muse Code is developer-only — the server refuses it as a reviewer at
 * admission — so every other healthy agent can review. */
export function canReview(agent: AgentWithHealth): boolean {
  return agent.healthy && agent.runtime !== "muse_code";
}

/** Next incomplete step from agent health, not row count: a fresh install
 * always seeds unconfigured Claude/Cursor/Codex rows (deck_id NULL, unhealthy
 * with deck_missing), so counting rows would send a fresh profile to New
 * issue. The issue needs a developer and a reviewer, so the step stays on
 * Agents until at least one healthy agent can develop and one can review
 * (one healthy non-Muse agent covers both roles). */
export function nextFirstIssueStep(agents: AgentWithHealth[]): FirstIssueStep {
  const developer = agents.some(canDevelop);
  const reviewer = agents.some(canReview);
  return developer && reviewer ? "new-issue" : "agents";
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
