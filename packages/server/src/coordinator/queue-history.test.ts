// packages/server/src/coordinator/queue-history.test.ts
//
// NOT-168: queue/admission wait is reconstructable from append-only queue.*
// evidence — transitions, capacity, duplicates, admission, removal, restart,
// and legacy rows.

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-qhist-"));

const { migrate, getDb, closeDb } = await import("../db/index.js");
const { createIssue } = await import("../repository/issues.js");
const {
  enqueueIssueWithOutcome,
  dequeueIssue,
  getQueuedEntryForIssue,
  markQueueEntryAdmitted,
  markQueueEntryRemoved,
  setQueueWaitReason,
} = await import("../repository/queue-entries.js");
const {
  admitNext,
  setAdmissionHealthCheckerForTests,
  resetCapacityPolicyForTests,
  resetEligibilityRulesForTests,
} = await import("./admission.js");
const {
  classifyQueueWaitReason,
  getQueueHistoryForIssue,
} = await import("./queue-history.js");

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
    DELETE FROM queue_entries;
    DELETE FROM issues;
    DELETE FROM runtime_availability;
  `);
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
});

afterEach(() => {
  setAdmissionHealthCheckerForTests(null);
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
});

async function queuedIssue(suffix: string) {
  const { createAgent } = await import("../repository/agents.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `dealer-qhist-repo-${suffix}-`));
  const dev = createAgent({ name: `dev-${suffix}`, runtime: "claude_code" });
  const rev = createAgent({ name: `rev-${suffix}`, runtime: "claude_code" });
  return createIssue({
    title: `Issue ${suffix}`,
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    source: "manual",
  });
}

function queueEventCount(issueId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM workflow_events WHERE issue_id = ? AND type LIKE 'queue.%'")
      .get(issueId) as { n: number }
  ).n;
}

test("enqueue → reason A → reason B → admit yields exact contiguous history, no duplicates", async () => {
  const issue = await queuedIssue("transitions");
  const { entry, created } = enqueueIssueWithOutcome(issue.id);
  assert.equal(created, true);

  const reasonA = "missing acceptance criteria";
  const reasonB = "runtime capped: claude_code until 2030-01-01 (usage capped)";
  assert.equal(setQueueWaitReason(entry.id, reasonA), true);
  assert.equal(setQueueWaitReason(entry.id, reasonB), true);
  assert.notEqual(markQueueEntryAdmitted(issue.id), null);

  assert.equal(queueEventCount(issue.id), 4);
  const history = getQueueHistoryForIssue(issue.id);

  assert.equal(history.queueWaits.length, 1);
  const wait = history.queueWaits[0]!;
  assert.equal(wait.quality, "exact");
  assert.deepEqual(wait.reasons, []);
  assert.ok(wait.start);
  assert.ok(wait.end);
  assert.ok(wait.endCursor! > wait.startCursor!);

  assert.equal(history.admissionWaits.length, 3);
  const [first, second, third] = history.admissionWaits;
  // Contiguous tiling of the parent interval.
  assert.equal(first!.start, wait.start);
  assert.equal(first!.end, second!.start);
  assert.equal(second!.end, third!.start);
  assert.equal(third!.end, wait.end);
  assert.equal(first!.category, "other");
  assert.equal(first!.reason, null);
  assert.equal(second!.category, "readiness");
  assert.equal(second!.reason, reasonA);
  assert.equal(third!.category, "runtime_cap");
  // Operator prose is preserved verbatim.
  assert.equal(third!.reason, reasonB);
  for (const seg of history.admissionWaits) {
    assert.equal(seg.quality, "exact");
  }
});

test("repeated enqueue / unchanged reason / repeated removal do not duplicate evidence", async () => {
  const issue = await queuedIssue("duplicates");
  const first = enqueueIssueWithOutcome(issue.id);
  assert.equal(first.created, true);
  const repeat = enqueueIssueWithOutcome(issue.id);
  assert.equal(repeat.created, false);

  assert.equal(setQueueWaitReason(first.entry.id, "missing acceptance criteria"), true);
  assert.equal(setQueueWaitReason(first.entry.id, "missing acceptance criteria"), false);

  assert.notEqual(dequeueIssue(issue.id), null);
  assert.equal(dequeueIssue(issue.id), null);
  assert.equal(markQueueEntryAdmitted(issue.id), null);

  // enqueued + one change + one removal only.
  assert.equal(queueEventCount(issue.id), 3);
  const history = getQueueHistoryForIssue(issue.id);
  assert.equal(history.queueWaits.length, 1);
  assert.equal(history.queueWaits[0]!.quality, "exact");
  assert.ok(history.queueWaits[0]!.end);
});

test("removal closes the interval; housekeeping removal is evidence too", async () => {
  const issue = await queuedIssue("removal");
  enqueueIssueWithOutcome(issue.id);
  markQueueEntryRemoved(issue.id);

  assert.equal(queueEventCount(issue.id), 2);
  const history = getQueueHistoryForIssue(issue.id);
  assert.equal(history.queueWaits.length, 1);
  assert.equal(history.queueWaits[0]!.quality, "exact");
  assert.ok(history.queueWaits[0]!.end);
});

test("capacity-full time is materialized once, not per tick", async () => {
  const occupant = await queuedIssue("cap-occ");
  getDb().prepare("UPDATE issues SET status = 'developing' WHERE id = ?").run(occupant.id);

  const waiting = await queuedIssue("cap-wait");
  enqueueIssueWithOutcome(waiting.id);

  assert.equal(await admitNext(), null);
  const entry = getQueuedEntryForIssue(waiting.id)!;
  assert.match(entry.waitReason ?? "", /waiting for slot/);
  assert.equal(queueEventCount(waiting.id), 2); // enqueued + capacity change

  // Second full tick writes nothing — no per-tick churn.
  assert.equal(await admitNext(), null);
  assert.equal(queueEventCount(waiting.id), 2);

  const history = getQueueHistoryForIssue(waiting.id);
  const last = history.admissionWaits[history.admissionWaits.length - 1]!;
  assert.equal(last.category, "capacity");
  assert.match(last.reason ?? "", /waiting for slot/);
});

test("a restart between reason changes loses and duplicates nothing", async () => {
  const issue = await queuedIssue("restart");
  const { entry } = enqueueIssueWithOutcome(issue.id);
  assert.equal(setQueueWaitReason(entry.id, "missing acceptance criteria"), true);

  // Simulate a coordinator restart: drop the connection and reopen the same DB.
  closeDb();
  migrate();

  // The stored reason survives, so a repeat is still a no-op after restart.
  assert.equal(setQueueWaitReason(entry.id, "missing acceptance criteria"), false);
  assert.equal(queueEventCount(issue.id), 2);

  assert.equal(setQueueWaitReason(entry.id, "waiting on NOT-1 (In Progress)"), true);
  assert.equal(queueEventCount(issue.id), 3);

  const history = getQueueHistoryForIssue(issue.id);
  assert.equal(history.queueWaits.length, 1);
  assert.equal(history.queueWaits[0]!.quality, "inferred");
  assert.deepEqual(history.queueWaits[0]!.reasons, ["open_interval"]);
  assert.equal(history.queueWaits[0]!.end, null);
  assert.equal(history.admissionWaits.length, 3);
  assert.equal(history.admissionWaits[2]!.category, "dependency");
  assert.equal(
    history.admissionWaits[1]!.end,
    history.admissionWaits[2]!.start,
    "reason change stays contiguous across the restart"
  );
});

test("legacy rows without events: open is inferred, terminal never gets a fabricated end", async () => {
  const open = await queuedIssue("legacy-open");
  getDb()
    .prepare(
      `INSERT INTO queue_entries (id, issue_id, position, enqueued_at, state, wait_reason, wait_reason_at)
       VALUES (?, ?, 1, ?, 'queued', 'missing acceptance criteria', ?)`
    )
    .run(`legacy-${open.id}`, open.id, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

  const done = await queuedIssue("legacy-done");
  getDb()
    .prepare(
      `INSERT INTO queue_entries (id, issue_id, position, enqueued_at, state, wait_reason, wait_reason_at)
       VALUES (?, ?, 1, ?, 'removed', 'missing acceptance criteria', ?)`
    )
    .run(`legacy-${done.id}`, done.id, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

  const openHistory = getQueueHistoryForIssue(open.id);
  assert.equal(openHistory.queueWaits.length, 1);
  assert.equal(openHistory.queueWaits[0]!.start, "2024-01-01T00:00:00.000Z");
  assert.equal(openHistory.queueWaits[0]!.end, null);
  assert.equal(openHistory.queueWaits[0]!.quality, "inferred");
  assert.deepEqual(openHistory.queueWaits[0]!.reasons, ["backfill", "open_interval"]);
  assert.deepEqual(openHistory.admissionWaits, []);

  const doneHistory = getQueueHistoryForIssue(done.id);
  assert.equal(doneHistory.queueWaits.length, 1);
  assert.equal(doneHistory.queueWaits[0]!.end, null, "no fabricated terminal timestamp");
  assert.equal(doneHistory.queueWaits[0]!.quality, "unavailable");
  assert.deepEqual(doneHistory.queueWaits[0]!.reasons, ["backfill", "missing_queue_terminal"]);
});

test("row written before instrumentation, reason recorded after: backfilled start, exact tail", async () => {
  const issue = await queuedIssue("mid-upgrade");
  getDb()
    .prepare(
      `INSERT INTO queue_entries (id, issue_id, position, enqueued_at, state, wait_reason, wait_reason_at)
       VALUES (?, ?, 1, ?, 'queued', NULL, NULL)`
    )
    .run(`legacy-${issue.id}`, issue.id, "2024-06-01T00:00:00.000Z");

  const entry = getQueuedEntryForIssue(issue.id)!;
  assert.equal(setQueueWaitReason(entry.id, "waiting for slot — running: other work"), true);
  assert.notEqual(markQueueEntryAdmitted(issue.id), null);

  const history = getQueueHistoryForIssue(issue.id);
  assert.equal(history.queueWaits.length, 1);
  const wait = history.queueWaits[0]!;
  assert.equal(wait.start, "2024-06-01T00:00:00.000Z");
  assert.ok(wait.end);
  assert.equal(wait.quality, "inferred");
  assert.deepEqual(wait.reasons, ["backfill"]);
});

test("wait-reason categories are stable codes across the admission vocabulary", async () => {
  const cases: Array<[string | null, string]> = [
    ["waiting for slot — running: Big Work", "capacity"],
    ["no free admission slots", "capacity"],
    ["issue status is final_review — not startable", "readiness"],
    ["missing acceptance criteria", "readiness"],
    ["Missing required field(s): description", "readiness"],
    ["waiting on NOT-123 (In Progress)", "dependency"],
    ["dependency state unavailable", "dependency"],
    ["Linear fetch failed — dependency state unavailable (Linear HTTP 503)", "dependency"],
    ["developer unhealthy: dev — not authenticated — run cursor-agent login", "runtime_health"],
    ["developer unhealthy: dev — Could not confirm Cursor auth — `cursor-agent status` probe timed out", "runtime_health"],
    ["missing developer agent", "runtime_health"],
    ["runtime capped: claude_code until 2030-01-01 (usage capped)", "runtime_cap"],
    ["developer unhealthy: dev — Agent Deck offline — deck MCP unavailable", "agent_deck"],
    ["developer unhealthy: dev — Run agent-deck setup --client claude --start (Claude MCP not registered)", "agent_deck"],
    ["some future reason nobody predicted", "other"],
    [null, "other"],
  ];
  for (const [reason, category] of cases) {
    assert.equal(classifyQueueWaitReason(reason), category, `classify(${JSON.stringify(reason)})`);
  }
});
