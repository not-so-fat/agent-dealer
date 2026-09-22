// packages/server/src/coordinator/admission.test.ts
//
// NOT-103 acceptance: occupancy, skip-ahead, manual-start counting, level-trigger
// restart, readiness-before-start, no duplicate admission across ticks.

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-admit-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue, updateIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { getActiveWorkflowInstance } = await import("../repository/workflow-events.js");
const { recordRuntimeAvailability, clearAllRuntimeAvailability } = await import(
  "../repository/runtime-availability.js"
);
const {
  enqueueIssue,
  enqueueIssueWithOutcome,
  dequeueIssue,
  listQueuedEntries,
  getQueuedEntryForIssue} = await import("../repository/queue-entries.js");
const { startWorkflow } = await import("./commands.js");
const {
  sequentialCapacityPolicy,
  occupyingStatuses,
  countOccupyingIssues,
  admitNext,
  checkRoleAgentHealthy,
  getAdmissionStatus,
  setAdmissionHealthCheckerForTests,
  setCapacityPolicyForTests,
  resetCapacityPolicyForTests,
  resetEligibilityRulesForTests} = await import("./admission.js");
const {
  getMaxActiveIssues,
  setMaxActiveIssues,
  getEffectiveMaxActiveIssues,
  admissionLimitOptions,
  workerSpawnCeiling,
} = await import("../repository/admission-settings.js");
const { setBlockersProviderForTests, resetDependenciesForTests } = await import(
  "./dependencies.js"
);

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
  // NOT-215: the persisted concurrency setting must not leak between tests.
  getDb().prepare("DELETE FROM intake_settings WHERE key = 'admission.maxActiveIssues'").run();
  clearAllRuntimeAvailability();
  setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
  resetDependenciesForTests();
});

afterEach(() => {
  setAdmissionHealthCheckerForTests(null);
  resetCapacityPolicyForTests();
  resetEligibilityRulesForTests();
  resetDependenciesForTests();
  getDb().prepare("DELETE FROM intake_settings WHERE key = 'admission.maxActiveIssues'").run();
});

function seedAgents(
  suffix: string,
  runtimes: {
    dev: "claude_code" | "codex_local" | "cursor_local" | "muse_code";
    rev: "claude_code" | "codex_local" | "cursor_local" | "muse_code";
  } = { dev: "claude_code", rev: "claude_code" }
) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `dealer-admit-repo-${suffix}-`));
  const dev = createAgent({ name: `dev-${suffix}`, runtime: runtimes.dev, deckId: "00000000-0000-4000-a000-000000000099"});
  const rev = createAgent({ name: `rev-${suffix}`, runtime: runtimes.rev, deckId: "00000000-0000-4000-a000-000000000099"});
  return { repo, dev, rev };
}

function readyIssue(
  suffix: string,
  opts: {
    acceptanceCriteria?: string | null;
    runtimes?: {
      dev: "claude_code" | "codex_local" | "cursor_local" | "muse_code";
      rev: "claude_code" | "codex_local" | "cursor_local" | "muse_code";
    };
  } = {}
) {
  const { repo, dev, rev } = seedAgents(suffix, opts.runtimes);
  const issue = createIssue({
    title: `Issue ${suffix}`,
    description: "d",
    acceptanceCriteria:
      opts.acceptanceCriteria === undefined ? "It works" : (opts.acceptanceCriteria ?? undefined),
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts: 2,
    source: "manual"});
  if (opts.acceptanceCriteria === null) {
    updateIssue(issue.id, { acceptanceCriteria: null });
  }
  return issue;
}

test("sequential CapacityPolicy returns 1 free slot when empty, 0 when any occupying", () => {
  assert.equal(sequentialCapacityPolicy([]), 1);
  assert.equal(sequentialCapacityPolicy([{ id: "a", status: "developing" }]), 0);
  assert.deepEqual([...occupyingStatuses].sort(), ["developing", "repairing", "reviewing"].sort());
});

test("occupancy: only developing|reviewing|repairing count; needs_human/final_review/done/closed release", () => {
  const a = readyIssue("occ-a");
  const b = readyIssue("occ-b");
  const c = readyIssue("occ-c");
  assert.equal(countOccupyingIssues(), 0);

  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("developing", a.id);
  assert.equal(countOccupyingIssues(), 1);

  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("needs_human", a.id);
  assert.equal(countOccupyingIssues(), 0);

  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("reviewing", b.id);
  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("final_review", c.id);
  assert.equal(countOccupyingIssues(), 1);

  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("done", b.id);
  assert.equal(countOccupyingIssues(), 0);

  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("repairing", c.id);
  assert.equal(countOccupyingIssues(), 1);
  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("closed", c.id);
  assert.equal(countOccupyingIssues(), 0);
});

test("enqueue / dequeue / list expose order and wait_reason", () => {
  const a = readyIssue("q1");
  const b = readyIssue("q2");
  enqueueIssue(a.id);
  enqueueIssue(b.id);
  const listed = listQueuedEntries();
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.issueId, a.id);
  assert.equal(listed[1]!.issueId, b.id);
  assert.equal(listed[0]!.state, "queued");
  assert.equal(listed[0]!.waitReason, null);
  assert.ok(listed[0]!.title);

  dequeueIssue(a.id);
  assert.equal(listQueuedEntries().map((e) => e.issueId).join(","), b.id);
});

test("NOT-141: enqueue reports whether it actually queued the issue or found it queued already", () => {
  const issue = readyIssue("q-outcome");
  const first = enqueueIssueWithOutcome(issue.id);
  assert.equal(first.created, true);

  // Idempotent: the same entry comes back, and the caller can see nothing changed — the
  // difference `POST /api/issues` needs so it never reports a queue action that did not happen.
  const second = enqueueIssueWithOutcome(issue.id);
  assert.equal(second.created, false);
  assert.deepEqual(second.entry, first.entry);

  dequeueIssue(issue.id);
  assert.equal(enqueueIssueWithOutcome(issue.id).created, true, "a gone entry is a real enqueue");
});

test("admitNext starts the head eligible entry when a slot is free", async () => {
  const a = readyIssue("admit-head");
  enqueueIssue(a.id);
  const result = await admitNext();
  assert.equal(result?.issueId, a.id);
  assert.equal(getIssue(a.id)!.status, "developing");
  assert.ok(getActiveWorkflowInstance(a.id));
  assert.equal(getQueuedEntryForIssue(a.id), null);
});

test("capacity gate: no evaluation while an occupying issue is active", async () => {
  const active = readyIssue("cap-active");
  const waiting = readyIssue("cap-wait");
  enqueueIssue(waiting.id);
  assert.equal(startWorkflow(active.id).ok, true);
  assert.equal(getIssue(active.id)!.status, "developing");

  const result = await admitNext();
  assert.equal(result, null);
  assert.equal(getIssue(waiting.id)!.status, "ready");
  assert.equal(getQueuedEntryForIssue(waiting.id)?.state, "queued");
  // NOT-168: capacity-full time is persisted (once per transition), not just a read overlay.
  assert.match(getQueuedEntryForIssue(waiting.id)?.waitReason ?? "", /waiting for slot/);
});

test("slot release: needs_human frees capacity so next entry admits on the next tick", async () => {
  const first = readyIssue("rel-1");
  const second = readyIssue("rel-2");
  enqueueIssue(first.id);
  enqueueIssue(second.id);
  await admitNext();
  assert.equal(getIssue(first.id)!.status, "developing");

  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("needs_human", first.id);
  getDb()
    .prepare(
      "UPDATE workflow_instances SET completed_at = ? WHERE issue_id = ? AND completed_at IS NULL"
    )
    .run(new Date().toISOString(), first.id);

  const result = await admitNext();
  assert.equal(result?.issueId, second.id);
  assert.equal(getIssue(second.id)!.status, "developing");
});

test("skip-ahead: capped/unhealthy entry records wait_reason; later eligible entry admits", async () => {
  const capped = readyIssue("skip-cap", { runtimes: { dev: "claude_code", rev: "claude_code" } });
  const ok = readyIssue("skip-ok", { runtimes: { dev: "codex_local", rev: "codex_local" } });
  enqueueIssue(capped.id);
  enqueueIssue(ok.id);

  recordRuntimeAvailability({
    runtime: "claude_code",
    unavailableUntil: new Date(Date.now() + 3600_000).toISOString(),
    reason: "claude_code usage capped"});

  const result = await admitNext();
  assert.equal(result?.issueId, ok.id);
  assert.equal(getIssue(ok.id)!.status, "developing");
  assert.equal(getIssue(capped.id)!.status, "ready");
  const cappedEntry = getQueuedEntryForIssue(capped.id)!;
  assert.equal(cappedEntry.state, "queued");
  assert.match(cappedEntry.waitReason ?? "", /capped|unhealthy|claude/i);
});

test("manual Start via startWorkflow marks queued entry admitted and blocks next admission", async () => {
  const queued = readyIssue("force-q");
  const other = readyIssue("force-other");
  enqueueIssue(queued.id);
  enqueueIssue(other.id);

  assert.equal(startWorkflow(queued.id).ok, true);
  assert.equal(getQueuedEntryForIssue(queued.id), null);

  const result = await admitNext();
  assert.equal(result, null);
  assert.equal(getIssue(other.id)!.status, "ready");
});

test("restart / level-trigger: empty occupancy + queued ready issue admits without prior events", async () => {
  const issue = readyIssue("restart");
  enqueueIssue(issue.id);
  const result = await admitNext();
  assert.equal(result?.issueId, issue.id);
  assert.equal(getIssue(issue.id)!.status, "developing");
});

test("readiness-before-start: missing AC becomes wait_reason; no product_scope_decision", async () => {
  const issue = readyIssue("no-ac", { acceptanceCriteria: null });
  enqueueIssue(issue.id);
  const result = await admitNext();
  assert.equal(result, null);
  assert.equal(getIssue(issue.id)!.status, "ready");
  const entry = getQueuedEntryForIssue(issue.id)!;
  assert.match(entry.waitReason ?? "", /acceptance criteria/i);
  assert.equal(listHumanActionsForIssue(issue.id).length, 0);
  assert.equal(getActiveWorkflowInstance(issue.id), null);
});

test("no duplicate admission across two ticks", async () => {
  const issue = readyIssue("dup");
  enqueueIssue(issue.id);
  const first = await admitNext();
  assert.equal(first?.issueId, issue.id);
  const second = await admitNext();
  assert.equal(second, null);
  assert.equal(listQueuedEntries().length, 0);
  const instances = getDb()
    .prepare("SELECT COUNT(*) AS n FROM workflow_instances WHERE issue_id = ?")
    .get(issue.id) as { n: number };
  assert.equal(instances.n, 1);
});

test("wait_reason write only when the reason changes", async () => {
  const issue = readyIssue("churn", { acceptanceCriteria: null });
  enqueueIssue(issue.id);
  await admitNext();
  const afterFirst = getQueuedEntryForIssue(issue.id)!;
  assert.ok(afterFirst.waitReason);
  const at1 = afterFirst.waitReasonAt;
  await admitNext();
  const afterSecond = getQueuedEntryForIssue(issue.id)!;
  assert.equal(afterSecond.waitReason, afterFirst.waitReason);
  assert.equal(afterSecond.waitReasonAt, at1);
});

test("CapacityPolicy is the only capacity gate (sequential wired)", async () => {
  const a = readyIssue("cap-pol-a");
  const b = readyIssue("cap-pol-b");
  enqueueIssue(a.id);
  enqueueIssue(b.id);

  setCapacityPolicyForTests(() => 0);
  assert.equal(await admitNext(), null);

  resetCapacityPolicyForTests();
  const admitted = await admitNext();
  assert.equal(admitted?.issueId, a.id);
});

test("product_scope_decision resolve force-admits a queued issue (start-path-queue-sync)", async () => {
  const { createHumanAction, listHumanActionsForIssue: listActions } = await import(
    "../repository/human-actions.js"
  );
  const { resolveHumanActionAndAdvance } = await import("./commands.js");

  const issue = readyIssue("scope-q", { acceptanceCriteria: null });
  enqueueIssue(issue.id);
  // Open the scope gate the way startWorkflow would when AC is missing.
  const action = createHumanAction({
    issueId: issue.id,
    actionType: "product_scope_decision",
    reason: "no AC",
    question: "Add AC",
    responseOptions: [{ choice: "resume", label: "Start" }]});
  updateIssue(issue.id, { acceptanceCriteria: "now has AC" });

  const resolved = resolveHumanActionAndAdvance(action.id, "test", "resume");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(issue.id)!.status, "developing");
  assert.equal(getQueuedEntryForIssue(issue.id), null);
  assert.equal(listActions(issue.id).filter((a) => a.status === "open").length, 0);
});

test("admitNext closes a stale product_scope_decision when AC was added after the gate opened", async () => {
  const { createHumanAction, listHumanActionsForIssue: listActions } = await import(
    "../repository/human-actions.js"
  );
  const { listWorkItemsForIssue } = await import("../repository/work-items.js");

  const issue = readyIssue("stale-scope", { acceptanceCriteria: null });
  enqueueIssue(issue.id);
  // A reviewer-escalated scope gate (routing.ts) left open while the issue sat queued.
  const actionId = createHumanAction({
    issueId: issue.id,
    actionType: "product_scope_decision",
    reason: "no acceptance criteria",
    question: "Add acceptance criteria",
    responseOptions: [{ choice: "resume", label: "Added — start" }]}).id;

  updateIssue(issue.id, { acceptanceCriteria: "AC added via PATCH" });
  const admitted = await admitNext();
  assert.equal(admitted?.issueId, issue.id);
  assert.equal(getIssue(issue.id)!.status, "developing");
  assert.equal(listActions(issue.id).find((a) => a.id === actionId)?.status, "resolved");
  assert.equal(listActions(issue.id).filter((a) => a.status === "open").length, 0);
  // One round-1 developer item only — resolving the stale gate later must not double-enqueue.
  assert.equal(listWorkItemsForIssue(issue.id).filter((w) => w.kind === "developer").length, 1);
});

test("housekeeping admits stale queued+active rows even when capacity is full", async () => {
  const running = readyIssue("hk-run");
  const waiting = readyIssue("hk-wait");
  enqueueIssue(running.id);
  enqueueIssue(waiting.id);
  assert.equal(startWorkflow(running.id).ok, true);
  // Simulate a stale queued row left behind a start path that forgot to force-admit.
  getDb()
    .prepare(
      `INSERT INTO queue_entries (id, issue_id, position, enqueued_at, state, wait_reason, wait_reason_at)
       VALUES (?, ?, 0, ?, 'queued', NULL, NULL)`
    )
    .run(`stale-${running.id}`, running.id, new Date().toISOString());

  assert.equal(await admitNext(), null); // capacity full — no new admission
  assert.equal(getQueuedEntryForIssue(running.id), null); // stale row cleaned
  assert.equal(getQueuedEntryForIssue(waiting.id)?.state, "queued");
});

// NOT-133 acceptance: with Cursor logged out, a cursor_local issue must wait with an auth
// reason instead of being admitted and burning its infra attempts on ~1s dead sessions.
// The stub replays the verbatim `cursor-agent status` capture (shared/src/fixtures/
// runtime-auth/README.md) through the *real* admission health checker — no injected result.
test("NOT-133: a logged-out Cursor runtime is not admitted; it waits with an auth reason", async () => {
  const { clearAgentHealthCaches } = await import("../adapters/agent-health.js");
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../shared/src/fixtures/runtime-auth/cursor-agent-status-logged-out.txt"
  );
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-stub-"));
  const stub = path.join(stubDir, "cursor-agent");
  // `cursor-agent status` exits 0 when logged out — the stub must too, or the test would
  // pass on the exit code rather than on the classification under test.
  fs.writeFileSync(stub, `#!/bin/sh\ncat ${JSON.stringify(fixture)}\nexit 0\n`);
  fs.chmodSync(stub, 0o755);

  const prev = process.env.CURSOR_CLI;
  const prevSkipHealth = process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
  process.env.CURSOR_CLI = stub;
  // Real classifier path — must not short-circuit via the unit-test skip.
  delete process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
  setAdmissionHealthCheckerForTests(null);
  clearAgentHealthCaches();
  try {
    const issue = readyIssue("cursor-logged-out", {
      runtimes: { dev: "cursor_local", rev: "cursor_local" }});
    enqueueIssue(issue.id);

    assert.equal(await admitNext(), null);
    assert.equal(getIssue(issue.id)!.status, "ready");
    assert.equal(getActiveWorkflowInstance(issue.id), null);

    const entry = getQueuedEntryForIssue(issue.id);
    assert.equal(entry?.state, "queued");
    assert.match(entry!.waitReason!, /developer unhealthy/);
    assert.match(entry!.waitReason!, /not authenticated/i);
    assert.match(entry!.waitReason!, /cursor-agent login/);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_CLI;
    else process.env.CURSOR_CLI = prev;
    if (prevSkipHealth === undefined) delete process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
    else process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = prevSkipHealth;
    clearAgentHealthCaches();
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  }
});

// NOT-178: an unhealthy Muse Code developer profile waits with a Muse-specific reason and
// spends nothing — status stays ready, no workflow instance, no attempt. Runs the *real*
// health checker against a stub CLI and an empty config home (no META_API_KEY, no auth.json).
test("NOT-178: a Muse Code developer without credentials is refused at admission", async () => {
  const { clearAgentHealthCaches } = await import("../adapters/agent-health.js");
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-stub-"));
  const stub = path.join(stubDir, "muse");
  fs.writeFileSync(stub, "#!/bin/sh\necho 'Muse Code 1.3.0 (1.3.0-R3401.1)'\n");
  fs.chmodSync(stub, 0o755);

  const saved = {
    MUSE_CLI: process.env.MUSE_CLI,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    META_API_KEY: process.env.META_API_KEY,
    SKIP: process.env.AGENT_DEALER_SKIP_AGENT_HEALTH,
  };
  process.env.MUSE_CLI = stub;
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-cfg-"));
  delete process.env.META_API_KEY;
  delete process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
  setAdmissionHealthCheckerForTests(null);
  clearAgentHealthCaches();
  try {
    const issue = readyIssue("muse-logged-out", {
      runtimes: { dev: "muse_code", rev: "codex_local" },
    });
    enqueueIssue(issue.id);

    assert.equal(await admitNext(), null);
    assert.equal(getIssue(issue.id)!.status, "ready");
    assert.equal(getActiveWorkflowInstance(issue.id), null);

    const entry = getQueuedEntryForIssue(issue.id);
    assert.equal(entry?.state, "queued");
    assert.match(entry!.waitReason!, /developer unhealthy/);
    assert.match(entry!.waitReason!, /muse login/);
  } finally {
    for (const [key, value] of Object.entries({
      MUSE_CLI: saved.MUSE_CLI,
      XDG_CONFIG_HOME: saved.XDG_CONFIG_HOME,
      META_API_KEY: saved.META_API_KEY,
      AGENT_DEALER_SKIP_AGENT_HEALTH: saved.SKIP,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearAgentHealthCaches();
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  }
});

// NOT-178: Muse Code is developer-only, so it is never a healthy reviewer — even with the
// unit-test health skip on, and without probing the CLI.
test("NOT-178: a Muse Code reviewer is refused regardless of CLI health", async () => {
  const issue = readyIssue("muse-reviewer", { runtimes: { dev: "claude_code", rev: "muse_code" } });
  setAdmissionHealthCheckerForTests(null);
  try {
    const result = await checkRoleAgentHealthy(getIssue(issue.id)!, "reviewer", { deckOnline: true });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /reviewer unhealthy.*developer role only/);
  } finally {
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  }
});

// NOT-156: reviewer health must not block developer admit; developer health still fails closed.
test("NOT-156: developer healthy + reviewer unhealthy still admits and leases developer work", async () => {
  const { listWorkItemsForIssue } = await import("../repository/work-items.js");
  const issue = readyIssue("rev-unhealthy");
  setAdmissionHealthCheckerForTests(async (_agent, role) => {
    if (role === "reviewer") {
      return {
        ok: false,
        reason: `reviewer unhealthy: ${_agent.name} — Run agent-deck setup --client claude --start (Claude MCP not registered)`,
      };
    }
    return { ok: true };
  });
  enqueueIssue(issue.id);

  const result = await admitNext();
  assert.equal(result?.issueId, issue.id);
  assert.equal(getIssue(issue.id)!.status, "developing");
  assert.ok(getActiveWorkflowInstance(issue.id));
  const developerItems = listWorkItemsForIssue(issue.id).filter((w) => w.kind === "developer");
  assert.equal(developerItems.length, 1);
  assert.equal(developerItems[0]!.status, "pending");
});

test("NOT-156: developer unhealthy + reviewer healthy parks with a developer-named wait_reason", async () => {
  const issue = readyIssue("dev-unhealthy");
  setAdmissionHealthCheckerForTests(async (_agent, role) => {
    if (role === "developer") {
      return {
        ok: false,
        reason: `developer unhealthy: ${_agent.name} — not authenticated — run cursor-agent login`,
      };
    }
    return { ok: true };
  });
  enqueueIssue(issue.id);

  assert.equal(await admitNext(), null);
  assert.equal(getIssue(issue.id)!.status, "ready");
  assert.equal(getActiveWorkflowInstance(issue.id), null);
  const entry = getQueuedEntryForIssue(issue.id)!;
  assert.equal(entry.state, "queued");
  assert.match(entry.waitReason ?? "", /developer unhealthy/);
  assert.doesNotMatch(entry.waitReason ?? "", /reviewer unhealthy/);
});

// ---------------------------------------------------------------------------
// NOT-215: configurable active-issue admission concurrency (fixed-N + per-repo).
// ---------------------------------------------------------------------------

/** Two ready issues sharing one repository path (seedAgents makes a fresh repo per call). */
function readyIssueInRepo(suffix: string, repo: string) {
  const { dev, rev } = seedAgents(`repo-${suffix}`);
  return createIssue({
    title: `Issue ${suffix}`,
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts: 2,
    source: "manual"});
}

function linearIssue(
  suffix: string,
  externalId: string,
  runtimes: {
    dev: "claude_code" | "codex_local" | "cursor_local" | "muse_code";
    rev: "claude_code" | "codex_local" | "cursor_local" | "muse_code";
  } = { dev: "codex_local", rev: "codex_local" }
) {
  const { repo, dev, rev } = seedAgents(`lin-${suffix}`, runtimes);
  return createIssue({
    title: `Linear ${suffix}`,
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 2,
    maxInfraAttempts: 2,
    source: "linear",
    externalId,
    externalLabel: `NOT-${suffix}`});
}

function instanceCount(issueId: string): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM workflow_instances WHERE issue_id = ?").get(issueId) as {
      n: number;
    }
  ).n;
}

function releaseToNeedsHuman(issueId: string): void {
  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run("needs_human", issueId);
  getDb()
    .prepare(
      "UPDATE workflow_instances SET completed_at = ? WHERE issue_id = ? AND completed_at IS NULL"
    )
    .run(new Date().toISOString(), issueId);
}

test("NOT-215: default is sequential (limit 1); raising to 2 fills the new slot on the next tick", async () => {
  assert.equal(getMaxActiveIssues(), 1);
  const a = readyIssue("raise-a");
  const b = readyIssue("raise-b");
  enqueueIssue(a.id);
  enqueueIssue(b.id);

  assert.equal((await admitNext())?.issueId, a.id);
  assert.equal(getIssue(b.id)!.status, "ready", "limit 1 still admits one per tick");

  assert.equal(setMaxActiveIssues(2), 2);
  assert.equal((await admitNext())?.issueId, b.id);
  assert.equal(getIssue(b.id)!.status, "developing");
  assert.equal(listQueuedEntries().length, 0);
});

test("NOT-215: fixed capacity 2 admits two eligible different-repository issues in one tick", async () => {
  setMaxActiveIssues(2);
  const a = readyIssue("par-a");
  const b = readyIssue("par-b");
  enqueueIssue(a.id);
  enqueueIssue(b.id);

  const first = await admitNext();
  assert.equal(first?.issueId, a.id);
  assert.equal(getIssue(a.id)!.status, "developing");
  assert.equal(getIssue(b.id)!.status, "developing");
  assert.equal(listQueuedEntries().length, 0);
  assert.equal(instanceCount(a.id), 1);
  assert.equal(instanceCount(b.id), 1);

  // Second tick admits nothing new and duplicates nothing.
  assert.equal(await admitNext(), null);
  assert.equal(instanceCount(a.id), 1);
  assert.equal(instanceCount(b.id), 1);

  assert.deepEqual(getAdmissionStatus(), {
    active: 2,
    waiting: 0,
    limit: 2,
    maxActiveIssues: 2,
    ceiling: workerSpawnCeiling(),
    options: admissionLimitOptions(),
    overCap: false,
  });
});

test("NOT-215: same-repository issues never run concurrently; the waiter names the conflict", async () => {
  setMaxActiveIssues(2);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-admit-samerepo-"));
  const a = readyIssueInRepo("same-a", repo);
  const b = readyIssueInRepo("same-b", repo);
  enqueueIssue(a.id);
  enqueueIssue(b.id);

  assert.equal((await admitNext())?.issueId, a.id);
  assert.equal(getIssue(a.id)!.status, "developing");
  assert.equal(getIssue(b.id)!.status, "ready");
  assert.equal(getActiveWorkflowInstance(b.id), null);
  assert.equal(instanceCount(b.id), 0);

  const entry = getQueuedEntryForIssue(b.id)!;
  assert.equal(entry.state, "queued");
  assert.match(entry.waitReason ?? "", /repository slot/);
  assert.ok(
    (entry.waitReason ?? "").includes(repo),
    `reason names the conflicting repo: ${entry.waitReason}`
  );
  assert.ok(
    (entry.waitReason ?? "").includes(a.title),
    `reason names the active issue: ${entry.waitReason}`
  );

  // The repo slot frees when the first issue leaves occupying states — then the waiter admits.
  releaseToNeedsHuman(a.id);
  assert.equal((await admitNext())?.issueId, b.id);
  assert.equal(getIssue(b.id)!.status, "developing");
});

test("NOT-215: blocked/capped entries stay queued while later eligible different-repo entries fill both slots", async () => {
  setMaxActiveIssues(2);
  const blocked = linearIssue("blk", "lin-blk");
  setBlockersProviderForTests(
    async (issues) =>
      new Map(
        issues.map((i) => [
          i.externalId!,
          i.externalId === "lin-blk"
            ? [{ id: "", identifier: "NOT-1", stateName: "In Progress", stateType: "started" }]
            : [],
        ])
      )
  );
  const capped = readyIssue("sk-cap", { runtimes: { dev: "claude_code", rev: "claude_code" } });
  recordRuntimeAvailability({
    runtime: "claude_code",
    unavailableUntil: new Date(Date.now() + 3600_000).toISOString(),
    reason: "claude_code usage capped"});
  const okA = readyIssue("sk-a", { runtimes: { dev: "codex_local", rev: "codex_local" } });
  const okB = readyIssue("sk-b", { runtimes: { dev: "codex_local", rev: "codex_local" } });
  enqueueIssue(blocked.id);
  enqueueIssue(capped.id);
  enqueueIssue(okA.id);
  enqueueIssue(okB.id);

  assert.equal((await admitNext())?.issueId, okA.id);
  assert.equal(getIssue(okA.id)!.status, "developing");
  assert.equal(getIssue(okB.id)!.status, "developing");
  assert.equal(getIssue(blocked.id)!.status, "ready");
  assert.equal(getIssue(capped.id)!.status, "ready");
  assert.match(getQueuedEntryForIssue(blocked.id)?.waitReason ?? "", /waiting on NOT-1/);
  assert.match(getQueuedEntryForIssue(capped.id)?.waitReason ?? "", /capped/i);
});

test("NOT-215: lowering 2 → 1 never preempts; admission pauses until occupancy drops below 1", async () => {
  setMaxActiveIssues(2);
  const a = readyIssue("low-a");
  const b = readyIssue("low-b");
  enqueueIssue(a.id);
  enqueueIssue(b.id);
  await admitNext();
  assert.equal(getIssue(a.id)!.status, "developing");
  assert.equal(getIssue(b.id)!.status, "developing");

  setMaxActiveIssues(1);
  const c = readyIssue("low-c");
  enqueueIssue(c.id);
  assert.equal(await admitNext(), null);
  assert.equal(getIssue(a.id)!.status, "developing", "lowering never stops running work");
  assert.equal(getIssue(b.id)!.status, "developing", "lowering never stops running work");
  assert.equal(getIssue(c.id)!.status, "ready");
  assert.match(getQueuedEntryForIssue(c.id)?.waitReason ?? "", /waiting for slot/);

  const over = getAdmissionStatus();
  assert.equal(over.active, 2);
  assert.equal(over.limit, 1);
  assert.equal(over.overCap, true);

  // One release is not enough — occupancy must fall *below* the new limit.
  releaseToNeedsHuman(a.id);
  assert.equal(await admitNext(), null);
  assert.equal(getIssue(c.id)!.status, "ready");
  assert.equal(getAdmissionStatus().overCap, false);

  releaseToNeedsHuman(b.id);
  assert.equal((await admitNext())?.issueId, c.id);
  assert.equal(getIssue(c.id)!.status, "developing");
});

test("NOT-215: restart recovery observes the persisted setting without duplicate admission", async () => {
  setMaxActiveIssues(2);
  const a = readyIssue("rs-a");
  enqueueIssue(a.id);
  await admitNext();
  assert.equal(getIssue(a.id)!.status, "developing");

  const b = readyIssue("rs-b");
  enqueueIssue(b.id);

  // A restart re-reads everything from the DB: the persisted setting, the occupying
  // issues, and the queue. There is no in-memory admission state to go stale.
  assert.equal(getMaxActiveIssues(), 2);
  assert.equal(getEffectiveMaxActiveIssues(), 2);
  assert.equal((await admitNext())?.issueId, b.id);
  assert.equal(getIssue(b.id)!.status, "developing");
  assert.equal(instanceCount(a.id), 1, "no duplicate admission of the pre-restart issue");
  assert.equal(instanceCount(b.id), 1);
});

test("NOT-215: ungated human resume may exceed the limit; status reports over-cap, admission pauses", async () => {
  const { createHumanAction } = await import("../repository/human-actions.js");
  const { resolveHumanActionAndAdvance } = await import("./commands.js");

  assert.equal(getMaxActiveIssues(), 1);
  const a = readyIssue("oc-a");
  enqueueIssue(a.id);
  await admitNext();
  assert.equal(getIssue(a.id)!.status, "developing");

  const b = readyIssue("oc-b", { acceptanceCriteria: null });
  enqueueIssue(b.id);
  const action = createHumanAction({
    issueId: b.id,
    actionType: "product_scope_decision",
    reason: "no AC",
    question: "Add AC",
    responseOptions: [{ choice: "resume", label: "Start" }]});
  updateIssue(b.id, { acceptanceCriteria: "now has AC" });
  const resolved = resolveHumanActionAndAdvance(action.id, "test", "resume");
  assert.equal(resolved.ok, true);
  assert.equal(getIssue(b.id)!.status, "developing");

  const status = getAdmissionStatus();
  assert.equal(status.active, 2);
  assert.equal(status.limit, 1);
  assert.equal(status.maxActiveIssues, 1);
  assert.equal(status.overCap, true);

  const c = readyIssue("oc-c");
  enqueueIssue(c.id);
  assert.equal(await admitNext(), null);
  assert.equal(getIssue(c.id)!.status, "ready");
  assert.match(getQueuedEntryForIssue(c.id)?.waitReason ?? "", /waiting for slot/);
  assert.equal(getIssue(a.id)!.status, "developing", "over-cap never preempts running work");
  assert.equal(getIssue(b.id)!.status, "developing", "over-cap never preempts running work");
});

// NOT-157: soft probe failure wait_reason must name the probe, not "not authenticated".
test("NOT-157: soft Cursor probe timeout waits with probe-timeout reason, not logged-out copy", async () => {
  const {
    clearAgentHealthCaches,
    setCursorProbeTimingForTests,
  } = await import("../adapters/agent-health.js");

  // Real hang stub (same style as NOT-133) so this file does not share runCommand inject
  // state with agent-health.test.ts when the suite runs files in parallel.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-timeout-"));
  const stub = path.join(stubDir, "cursor-agent");
  fs.writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(stub, 0o755);

  const prev = process.env.CURSOR_CLI;
  const prevSkipHealth = process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
  process.env.CURSOR_CLI = stub;
  delete process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
  setCursorProbeTimingForTests({ timeoutMs: 150, retryBackoffsMs: [20] });
  setAdmissionHealthCheckerForTests(null);
  clearAgentHealthCaches();
  try {
    const issue = readyIssue("cursor-probe-timeout", {
      runtimes: { dev: "cursor_local", rev: "cursor_local" },
    });
    enqueueIssue(issue.id);

    assert.equal(await admitNext(), null);
    const entry = getQueuedEntryForIssue(issue.id);
    assert.equal(entry?.state, "queued");
    assert.match(entry!.waitReason!, /developer unhealthy/);
    assert.match(entry!.waitReason!, /probe timed out/i);
    assert.doesNotMatch(entry!.waitReason!, /not authenticated/i);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_CLI;
    else process.env.CURSOR_CLI = prev;
    if (prevSkipHealth === undefined) delete process.env.AGENT_DEALER_SKIP_AGENT_HEALTH;
    else process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = prevSkipHealth;
    setCursorProbeTimingForTests(null);
    clearAgentHealthCaches();
    setAdmissionHealthCheckerForTests(async () => ({ ok: true }));
  }
});

// ---------------------------------------------------------------------------
// NOT-239: Close issue vs the admission tick — exactly one terminal outcome.
// ---------------------------------------------------------------------------

test("NOT-239: closing the queue head lets the next tick admit the following issue", async () => {
  const { closeReadyIssue } = await import("./commands.js");
  const head = readyIssue("close-head");
  const next = readyIssue("close-next");
  enqueueIssue(head.id);
  enqueueIssue(next.id);

  // Close wins the race: the head retires without ever starting.
  assert.deepEqual(closeReadyIssue(head.id, "web"), {
    ok: true,
    issueStatus: "closed",
    alreadyClosed: false,
  });

  const admitted = await admitNext();
  assert.equal(admitted?.issueId, next.id, "the tick fills the freed slot with the next issue");
  assert.equal(getIssue(next.id)!.status, "developing");
  assert.equal(getIssue(head.id)!.status, "closed");
  assert.equal(instanceCount(head.id), 0, "close created no workflow instance");
  assert.equal(instanceCount(next.id), 1);
});

test("NOT-239: a tick that admitted first makes a late close refuse", async () => {
  const { closeReadyIssue } = await import("./commands.js");
  const issue = readyIssue("close-late");
  enqueueIssue(issue.id);

  const admitted = await admitNext();
  assert.equal(admitted?.issueId, issue.id);

  const late = closeReadyIssue(issue.id, "web");
  assert.equal(late.ok, false);
  if (late.ok) throw new Error("expected the late close to refuse");
  assert.equal(late.code, 409);
  assert.equal(getIssue(issue.id)!.status, "developing");
});
