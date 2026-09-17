// packages/server/src/coordinator/deck-outage.integration.test.ts
//
// NOT-136 acceptance: an Agent Deck outage observed at preflight is a wait, not a failed
// attempt. Four preflight failures in nine seconds used to exhaust the whole infra budget
// and park a healthy round on a human; here the same outage must cost nothing and resolve
// itself the moment the deck answers again.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeveloperOutcome } from "./routing.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-deckout-int-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "1";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.COORDINATOR_POLL_INTERVAL_MS = "50";
// Keep the backoff curve observable inside a test: 20ms, 40ms, 80ms, ...
process.env.DECK_OUTAGE_BACKOFF_BASE_MS = "20";
process.env.DECK_OUTAGE_BACKOFF_MAX_MS = "5000";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { deckOutageBackoffMs } = await import("./deck-outage-config.js");

const UNREACHABLE = "Agent Deck is unreachable — fetch failed";

before(() => migrate());
beforeEach(() => {
  getDb().exec(`
    DELETE FROM review_publications;
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
    DELETE FROM runtime_availability;
  `);
});
after(() => resetEffectHandlers());

async function pump(max = 10): Promise<void> {
  for (let i = 0; i < max; i++) {
    await runCoordinatorTick();
    await drainCoordinator();
    await new Promise((r) => setTimeout(r, 30));
  }
}

function makeIssue(name: string, maxInfraAttempts = 3): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `dealer-deckout-${name}-`));
  const dev = createAgent({ name: `dev-${name}`, runtime: "codex_local", workspaceRoot: repo });
  const rev = createAgent({ name: `rev-${name}`, runtime: "codex_local", workspaceRoot: repo });
  return createIssue({
    title: `Deck outage ${name}`,
    description: "d",
    acceptanceCriteria: "ac",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts,
    source: "manual",
  }).id;
}

test("a deck outage at preflight spends no infra attempts and never reaches needs_human", async () => {
  const issueId = makeIssue("outage", 1);

  let preflights = 0;
  registerEffectHandler("developer", async () => {
    preflights++;
    return { kind: "deck_unavailable", reason: UNREACHABLE } satisfies DeveloperOutcome;
  });

  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  // The original incident: four attempts in nine seconds against a max of three.
  assert.ok(preflights > 1, "the item must be retried, not dropped");

  const issue = getIssue(issueId)!;
  assert.equal(issue.infraAttempts, 0, "a deck outage must not spend the infra budget");
  assert.notEqual(issue.status, "needs_human");
  assert.match(issue.currentIntent ?? "", /Waiting for Agent Deck/);

  const items = listWorkItemsForIssue(issueId);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.status, "pending", "the item waits, it is not dead-lettered");
  assert.equal(items[0]!.attemptCount, 0, "the claim-time attempt bump is reverted");
  assert.ok(Date.parse(items[0]!.availableAt) > Date.now(), "the next preflight is gated behind a wait");

  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);

  const events = listWorkflowEventsForIssue(issueId);
  const deferrals = events.filter((e) => e.type === "worker.deferred");
  assert.ok(deferrals.length > 0);
  const payload = JSON.parse(deferrals[0]!.payloadJson ?? "{}");
  assert.equal(payload.outcome, "deck_unavailable", "the timeline says the deck is unavailable");
  assert.match(payload.reason, /unreachable/);
  assert.equal(events.some((e) => e.type === "worker.failed"), false, "no worker failed here");

  // Nothing spawned, so the session is cancelled rather than recorded as a crash.
  assert.equal(listWorkerSessionsForIssue(issueId).every((s) => s.status === "cancelled"), true);
});

test("the issue proceeds on its own once the deck is reachable again", async () => {
  const issueId = makeIssue("recover", 1);

  let attempts = 0;
  registerEffectHandler("developer", async () => {
    attempts++;
    // The deck comes back between the first and second preflight — as it would after a
    // restart. No human action, no resume command.
    if (attempts === 1) {
      return { kind: "deck_unavailable", reason: UNREACHABLE } satisfies DeveloperOutcome;
    }
    return { kind: "no_pr" } satisfies DeveloperOutcome;
  });

  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  assert.ok(attempts >= 2, "the deferred item must be re-attempted without human input");
  const issue = getIssue(issueId)!;
  // The recovered attempt consumed exactly one infra attempt — the no_pr one, not the outage.
  assert.equal(issue.infraAttempts, 1);
});

test("consecutive outages back off exponentially instead of retrying every ~3s", async () => {
  const issueId = makeIssue("backoff");

  registerEffectHandler("developer", async () => {
    return { kind: "deck_unavailable", reason: UNREACHABLE } satisfies DeveloperOutcome;
  });

  assert.equal(startWorkflow(issueId).ok, true);

  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    await runCoordinatorTick();
    await drainCoordinator();
    const item = listWorkItemsForIssue(issueId)[0]!;
    const deferrals = JSON.parse(item.payloadJson ?? "{}").deckUnavailableDeferrals as number;
    waits.push(deferrals);
    // Wait out this deferral so the next tick can claim the item again.
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(item.availableAt) - Date.now()) + 5));
  }

  assert.deepEqual(waits, [1, 2, 3, 4], "each outage increments this item's deferral count");
  assert.ok(
    deckOutageBackoffMs(3) > deckOutageBackoffMs(0),
    "later deferrals wait strictly longer than the first"
  );
});

test("an outage that outlives the ceiling escalates instead of waiting in silence forever", async () => {
  const prev = process.env.DECK_OUTAGE_DEFERRAL_CEILING_MS;
  process.env.DECK_OUTAGE_DEFERRAL_CEILING_MS = "50";
  try {
    const issueId = makeIssue("ceiling");
    registerEffectHandler("developer", async () => {
      return { kind: "deck_unavailable", reason: UNREACHABLE } satisfies DeveloperOutcome;
    });

    assert.equal(startWorkflow(issueId).ok, true);
    await pump(1); // first observation — defers and starts the ceiling clock
    assert.equal(getIssue(issueId)!.status, "developing");

    await new Promise((r) => setTimeout(r, 70)); // elapse the ceiling
    await pump();

    const issue = getIssue(issueId)!;
    assert.equal(issue.status, "needs_human");
    assert.equal(issue.infraAttempts, 0, "even the escalation spends no infra attempts");
    const escalation = listHumanActionsForIssue(issueId).find((a) => a.status === "open");
    assert.equal(escalation?.actionType, "policy_escalation");
    assert.match(escalation?.reason ?? "", /unreachable for over/);
  } finally {
    if (prev === undefined) delete process.env.DECK_OUTAGE_DEFERRAL_CEILING_MS;
    else process.env.DECK_OUTAGE_DEFERRAL_CEILING_MS = prev;
  }
});

test("a deck that is reachable but answers with an error still fails the attempt", async () => {
  const issueId = makeIssue("realerror", 1);

  registerEffectHandler("developer", async () => {
    return {
      kind: "deck_failure",
      reason: "preflight failed: get_playbook(pb-x) returned an error: missing",
    } satisfies DeveloperOutcome;
  });

  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.infraAttempts, 1, "a real deck error still spends the infra budget");
  assert.equal(issue.status, "needs_human");
  const events = listWorkflowEventsForIssue(issueId);
  assert.ok(events.some((e) => e.type === "worker.failed"));
  assert.equal(events.some((e) => e.type === "worker.deferred"), false);
});
