// NOT-287: view-model tests for the guided first-issue strip — the
// fresh/dismissed/filtered-empty/post-first-issue matrix plus the next-step
// rule and per-profile dismissal persistence. Pure logic (no React/DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_ISSUE_DISMISS_KEY,
  dismissFirstIssue,
  isFirstIssueDismissed,
  nextFirstIssueStep,
  shouldShowFirstIssueStrip,
} from "./firstIssue.js";

function memoryStore(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

test("fresh profile with zero historical issues sees the strip", () => {
  assert.equal(
    shouldShowFirstIssueStrip({ historyTotal: 0, filtersActive: false, dismissed: false }),
    true
  );
});

test("a historical issue — including a closed-only history — hides the strip", () => {
  // historyTotal counts closed rows too, so a closed-only past still reads
  // as "has history" here; the API helper (not this predicate) owns that.
  assert.equal(
    shouldShowFirstIssueStrip({ historyTotal: 1, filtersActive: false, dismissed: false }),
    false
  );
  assert.equal(
    shouldShowFirstIssueStrip({ historyTotal: 40, filtersActive: false, dismissed: false }),
    false
  );
});

test("a filtered list showing zero results never triggers onboarding", () => {
  assert.equal(
    shouldShowFirstIssueStrip({ historyTotal: 0, filtersActive: true, dismissed: false }),
    false
  );
});

test("dismissing hides the strip even while history is still fresh", () => {
  assert.equal(
    shouldShowFirstIssueStrip({ historyTotal: 0, filtersActive: false, dismissed: true }),
    false
  );
});

test("loading history hides the strip so onboarding never flashes", () => {
  assert.equal(
    shouldShowFirstIssueStrip({ historyTotal: null, filtersActive: false, dismissed: false }),
    false
  );
});

test("next step is agents until at least one agent is configured", () => {
  assert.equal(nextFirstIssueStep(0), "agents");
  assert.equal(nextFirstIssueStep(1), "new-issue");
  assert.equal(nextFirstIssueStep(3), "new-issue");
});

test("dismissal persists under a stable per-profile key", () => {
  assert.match(FIRST_ISSUE_DISMISS_KEY, /^agent-dealer:first-issue-dismissed:/);
  const store = memoryStore();
  assert.equal(isFirstIssueDismissed(store), false);
  dismissFirstIssue(store);
  assert.equal(isFirstIssueDismissed(store), true);
  assert.equal(store.getItem(FIRST_ISSUE_DISMISS_KEY), "1");
});

test("dismissal read is inert without storage (SSR / private mode)", () => {
  assert.equal(isFirstIssueDismissed(null), false);
  dismissFirstIssue(null);
});
