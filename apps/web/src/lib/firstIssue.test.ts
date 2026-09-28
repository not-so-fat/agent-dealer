// NOT-287: view-model tests for the guided first-issue strip — the
// fresh/dismissed/filtered-empty/post-first-issue matrix plus the next-step
// rule and per-profile dismissal persistence. Pure logic (no React/DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentWithHealth } from "@agent-dealer/shared";
import {
  FIRST_ISSUE_DISMISS_KEY,
  dismissFirstIssue,
  isFirstIssueDismissed,
  nextFirstIssueStep,
  shouldShowFirstIssueStrip,
} from "./firstIssue.js";

let agentSeq = 0;
/** Minimal AgentWithHealth — mirrors the seeded builtin shape (deck_id NULL,
 * deck_missing, unhealthy) unless overridden. */
function agentFixture(extra: Partial<AgentWithHealth> = {}): AgentWithHealth {
  agentSeq += 1;
  return {
    id: `00000000-0000-4000-a000-00000000000${agentSeq}`,
    name: `Seeded ${agentSeq}`,
    runtime: "claude_code",
    workspaceRoot: null,
    deckId: null,
    deckName: null,
    playbookId: null,
    defaultPlanModel: null,
    defaultExecuteModel: null,
    defaultPlanBudgetJson: null,
    defaultExecuteBudgetJson: null,
    defaultModel: null,
    defaultEffort: null,
    defaultBudgetJson: null,
    purpose: null,
    playbookIdsJson: null,
    externalMemoryRefsJson: null,
    permissionPolicyJson: null,
    isBuiltin: false,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    healthy: false,
    issues: [
      {
        code: "deck_missing",
        message: "Set an Agent Deck on the Agents page — workers never start without one",
      },
    ],
    ...extra,
  };
}

/** Exactly what seedBuiltinAgents inserts on a fresh install: three rows, no
 * deck, unhealthy with deck_missing. */
function freshSeedAgents(): AgentWithHealth[] {
  return [
    agentFixture({ name: "Claude", runtime: "claude_code" }),
    agentFixture({ name: "Cursor", runtime: "cursor_local" }),
    agentFixture({ name: "Codex", runtime: "codex_local" }),
  ];
}

function healthyAgent(extra: Partial<AgentWithHealth> = {}): AgentWithHealth {
  return agentFixture({
    deckId: "11111111-1111-4111-8111-111111111111",
    deckName: "Deck",
    healthy: true,
    issues: [],
    ...extra,
  });
}

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

test("next step is agents when no agent rows exist", () => {
  assert.equal(nextFirstIssueStep([]), "agents");
});

test("fresh seeded agents (no deck, deck_missing) still route to Agents", () => {
  // seedBuiltinAgents always inserts these three rows, so row count alone
  // would wrongly send a fresh profile to New issue.
  assert.equal(nextFirstIssueStep(freshSeedAgents()), "agents");
});

test("next step is new-issue once a healthy developer and reviewer exist", () => {
  // One healthy non-Muse agent covers both roles.
  assert.equal(nextFirstIssueStep([healthyAgent()]), "new-issue");
  assert.equal(
    nextFirstIssueStep([...freshSeedAgents(), healthyAgent()]),
    "new-issue"
  );
  assert.equal(
    nextFirstIssueStep([
      healthyAgent({ runtime: "muse_code" }),
      healthyAgent({ runtime: "cursor_local" }),
    ]),
    "new-issue"
  );
});

test("healthy Muse Code alone cannot review, so Agents stays the step", () => {
  assert.equal(
    nextFirstIssueStep([healthyAgent({ runtime: "muse_code" })]),
    "agents"
  );
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
