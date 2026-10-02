// packages/server/src/coordinator/playbook-feedback.test.ts
//
// NOT-305: actual-use receipts and idempotent signal_only failure reports.
// Deck's NOT-304 correlation operation is faked via the injectable `deps` seam.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlaybookFeedbackDeps } from "./playbook-feedback.js";
import type { AuthorizedDeckCallResult } from "../adapters/reflect-authority.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-playbook-feedback-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createAgent } = await import("../repository/agents.js");
const {
  createWorkerSession,
  completeSession,
  getWorkerSession,
  getOrAssignSessionCorrelationId,
} = await import("../repository/worker-sessions.js");
const { buildProfileSnapshot, serializeProfileSnapshot } = await import("./profile-snapshot.js");
const { createHumanAction, resolveHumanAction } = await import("../repository/human-actions.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { reconcileFinding } = await import("../repository/findings.js");
const { listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const {
  collectPlaybookUseReceipt,
  collectPlaybookUseReceiptsForIssue,
  reportDeckFailureSignals,
  parseCorrelatedFetches,
  validateSignalOnlyArgs,
  buildSignalOnlyArgs,
  DECK_CORRELATION_TOOL,
} = await import("./playbook-feedback.js");
const { triggerIssueReflect } = await import("./reflect-trigger.js");

before(() => {
  migrate();
});

const DECK = "11111111-1111-4111-a111-111111111111";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function seedIssue(developerAgentId: string) {
  return createIssue({
    title: "Feedback issue",
    repo: "acme/app",
    developerAgentId,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
}

function seedAgent() {
  // NOT-149 shape: createAgent never stores legacy playbookId(s) — new profiles carry
  // none, and receipts/signals must work from actual use alone.
  const agent = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  assert.equal(agent.playbookId, null);
  assert.equal(agent.playbookIdsJson, null);
  return agent;
}

/** Terminal developer session whose frozen snapshot names the deck (no playbook IDs). */
function seedTerminalSession(issueId: string, agent: ReturnType<typeof createAgent>, status: "done" | "failed" = "done") {
  const snapshot = { ...buildProfileSnapshot(agent, "developer"), deckId: DECK };
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: agent.id,
    runtime: agent.runtime,
    model: "claude-opus",
    profileSnapshotJson: serializeProfileSnapshot(snapshot),
  });
  completeSession(session.id, { status });
  return getWorkerSession(session.id)!;
}

interface CallRecord {
  deckId: string;
  toolName: string;
  args: Record<string, unknown>;
}

function makeDeps(
  opts: {
    fetches?: Array<{ playbook_id: string; first_fetched_at?: string; last_fetched_at?: string }>;
    correlationData?: unknown;
    propose?: (args: Record<string, unknown>) => AuthorizedDeckCallResult<{ id: string }>;
    healthy?: boolean;
  } = {}
): { deps: PlaybookFeedbackDeps; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const deps: PlaybookFeedbackDeps = {
    checkHealth: async () => opts.healthy ?? true,
    callTool: (async (call: { deckId: string; toolName: string; arguments: Record<string, unknown> }) => {
      calls.push({ deckId: call.deckId, toolName: call.toolName, args: call.arguments });
      if (call.toolName === DECK_CORRELATION_TOOL) {
        if (opts.correlationData !== undefined) return { ok: true, data: opts.correlationData };
        return {
          ok: true,
          data: {
            deck_id: DECK,
            correlation_id: call.arguments.correlation_id,
            fetches: opts.fetches ?? [],
          },
        };
      }
      if (call.toolName === "propose_playbook_patch") {
        // Strict stand-in for Deck's schema (additionalProperties:false): reject
        // anything the real Deck would reject, so tests prove schema compliance.
        const schemaError = validateSignalOnlyArgs(call.arguments);
        if (schemaError) {
          return { ok: false, kind: "infra_failure", reason: `Deck rejected signal payload: ${schemaError}` };
        }
        return opts.propose
          ? opts.propose(call.arguments)
          : { ok: true, data: { id: `sig-${calls.length}` } };
      }
      throw new Error(`unexpected tool call: ${call.toolName}`);
    }) as PlaybookFeedbackDeps["callTool"],
  };
  return { deps, calls };
}

function receiptsFor(issueId: string) {
  return listArtifactsForIssueByKind(issueId, "playbook_use_receipt").map((a) => JSON.parse(a.contentJson!));
}

function signalsFor(issueId: string) {
  return listArtifactsForIssueByKind(issueId, "deck_feedback_signal").map((a) => JSON.parse(a.contentJson!));
}

function sentSignalsFor(issueId: string) {
  return signalsFor(issueId).filter((s) => s.status === "sent");
}

function pendingSignalsFor(issueId: string) {
  return signalsFor(issueId).filter((s) => s.status === "pending" || s.status === "sending");
}

function evidenceOf(args: Record<string, unknown>): { failure_summary: string; user_feedback_excerpt?: string } {
  return args.evidence as { failure_summary: string; user_feedback_excerpt?: string };
}

test("every new worker session persists a unique opaque correlation ID before spawn", () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const snapshot = { ...buildProfileSnapshot(agent, "developer"), deckId: DECK };
  const a = createWorkerSession({
    issueId: issue.id, role: "developer", round: 1, agentId: agent.id,
    runtime: agent.runtime, profileSnapshotJson: serializeProfileSnapshot(snapshot),
  });
  const b = createWorkerSession({
    issueId: issue.id, role: "developer", round: 2, agentId: agent.id,
    runtime: agent.runtime, profileSnapshotJson: serializeProfileSnapshot(snapshot),
  });
  assert.match(a.deckCorrelationId!, UUID_RE);
  assert.match(b.deckCorrelationId!, UUID_RE);
  assert.notEqual(a.deckCorrelationId, b.deckCorrelationId);
  // Persisted, not just returned: a fresh read carries the same ID.
  assert.equal(getWorkerSession(a.id)!.deckCorrelationId, a.deckCorrelationId);
  // Pre-feature NULL rows are repaired deterministically on read.
  assert.match(getOrAssignSessionCorrelationId(a.id)!, UUID_RE);
  assert.equal(getOrAssignSessionCorrelationId(a.id), a.deckCorrelationId);
});

test("two fetched playbooks persist one receipt naming exactly those two; an unused card is absent", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const session = seedTerminalSession(issue.id, agent);
  const { deps, calls } = makeDeps({
    fetches: [
      { playbook_id: "pb-used-a", first_fetched_at: "2026-09-01T10:00:00.000Z", last_fetched_at: "2026-09-01T10:05:00.000Z" },
      { playbook_id: "pb-used-b", first_fetched_at: "2026-09-01T10:02:00.000Z", last_fetched_at: "2026-09-01T10:09:00.000Z" },
    ],
  });

  const result = await collectPlaybookUseReceipt(session.id, deps);
  assert.equal(result.collected, true);

  // The correlation call carries the session's own opaque ID under the launch deck.
  const correlationCalls = calls.filter((c) => c.toolName === DECK_CORRELATION_TOOL);
  assert.equal(correlationCalls.length, 1);
  assert.equal(correlationCalls[0]!.deckId, DECK);
  assert.equal(correlationCalls[0]!.args.correlation_id, session.deckCorrelationId);

  const receipts = receiptsFor(issue.id);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.deepStrictEqual(receipt.playbookIds, ["pb-used-a", "pb-used-b"]);
  assert.ok(!receipt.playbookIds.includes("pb-unused"));
  assert.equal(receipt.workerSessionId, session.id);
  assert.equal(receipt.role, "developer");
  assert.equal(receipt.deckId, DECK);
  assert.equal(receipt.correlationId, session.deckCorrelationId);
  assert.equal(receipt.runtime, "claude_code");
  assert.equal(receipt.model, "claude-opus");
  assert.equal(receipt.firstFetchedAt, "2026-09-01T10:00:00.000Z");
  assert.equal(receipt.lastFetchedAt, "2026-09-01T10:09:00.000Z");
  assert.equal(receipt.status, "collected");
  // Non-goal: no prompts, tool I/O, repo names, or issue descriptions in Deck receipts.
  const allowed = new Set([
    "workerSessionId", "role", "deckId", "correlationId", "runtime", "model",
    "playbookIds", "firstFetchedAt", "lastFetchedAt", "status", "reason", "error",
  ]);
  for (const key of Object.keys(receipt)) assert.ok(allowed.has(key), `receipt leaks ${key}`);
});

test("receipt collection is idempotent: a repeat after restart does not re-call Deck", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const session = seedTerminalSession(issue.id, agent);
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-x" }] });

  const first = await collectPlaybookUseReceipt(session.id, deps);
  assert.equal(first.collected, true);
  const second = await collectPlaybookUseReceipt(session.id, deps);
  assert.equal(second.collected, true);
  assert.equal(second.collected && "duplicate" in second && second.duplicate, true);
  assert.equal(calls.filter((c) => c.toolName === DECK_CORRELATION_TOOL).length, 1);
  assert.equal(receiptsFor(issue.id).length, 1);
});

test("a clean approved run records receipts only — no feedback signal, no playbook patch", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  seedTerminalSession(issue.id, agent);
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-used" }] });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  assert.equal(receiptsFor(issue.id).length, 1);
  assert.deepStrictEqual(
    calls.filter((c) => c.toolName === "propose_playbook_patch"),
    []
  );
  assert.deepStrictEqual(signalsFor(issue.id), []);
});

test("human retry feedback creates one idempotent signal_only report with refs and failure evidence", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const session = seedTerminalSession(issue.id, agent);
  const action = createHumanAction({
    issueId: issue.id,
    actionType: "final_review",
    reason: "The widget drops state on rerender.",
    question: "Repair or close?",
  });
  resolveHumanAction(action.id, "operator", { choice: "repair" });
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-used-a" }, { playbook_id: "pb-used-b" }] });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");

  const proposes = calls.filter((c) => c.toolName === "propose_playbook_patch");
  assert.equal(proposes.length, 1);
  const args = proposes[0]!.args;
  // Only signal_only from this path — never an update proposal, never Notes ops —
  // and only Deck-schema fields (the strict fake above already rejected the call
  // otherwise, proving a real Deck would accept it).
  assert.equal(validateSignalOnlyArgs(args), null);
  assert.equal(args.kind, "signal_only");
  assert.equal("playbook_id" in args, false);
  assert.equal("ops" in args, false);
  for (const banned of ["source_key", "trigger", "issue_ref", "failure", "playbook_ids", "observed_playbook_use"]) {
    assert.equal(banned in args, false, `Dealer-only field ${banned} must not be sent to Deck`);
  }
  // Every Dealer reference lives in Deck-stored fields instead.
  const expectedKey = `dealer:${issue.id}:human_retry:${action.id}`;
  assert.match(args.rationale as string, /Human correction during Dealer review/);
  assert.ok((args.rationale as string).includes(expectedKey), "rationale carries the source key");
  assert.ok((args.rationale as string).includes(issue.id), "rationale carries the issue ref");
  const evidence = evidenceOf(args);
  assert.match(evidence.failure_summary, /repair/);
  assert.match(evidence.failure_summary, /drops state on rerender/);
  assert.ok(evidence.failure_summary.includes(issue.id), "evidence carries the issue ref");
  assert.ok(evidence.failure_summary.includes(session.id), "evidence carries the session ref");
  assert.ok(
    evidence.failure_summary.includes("pb-used-a") && evidence.failure_summary.includes("pb-used-b"),
    "evidence names exactly the two actually used playbooks"
  );
  assert.ok(evidence.failure_summary.includes(expectedKey), "evidence carries the source key");
  assert.equal(evidence.user_feedback_excerpt, "The widget drops state on rerender.");

  // One pending intent row (written before the Deck call) plus one sent row.
  assert.equal(pendingSignalsFor(issue.id).length, 1);
  const signals = sentSignalsFor(issue.id);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.trigger, "human_retry");
  assert.equal(signals[0]!.sourceKey, expectedKey);

  // Simulated restart: same trigger, no duplicate Deck report.
  const again = await triggerIssueReflect(issue.id, deps);
  assert.equal(again, "skipped");
  assert.equal(calls.filter((c) => c.toolName === "propose_playbook_patch").length, 1);
  assert.equal(sentSignalsFor(issue.id).length, 1);
});

test("attempts exhaustion creates one signal; a retry choice is reported once, not twice", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  seedTerminalSession(issue.id, agent);
  const exhausted = createHumanAction({
    issueId: issue.id,
    actionType: "attempts_exhausted",
    reason: "Review rounds spent with changes still requested.",
    question: "Retry with another round or close?",
  });
  const { deps, calls } = makeDeps({ fetches: [] });

  const result = await reportDeckFailureSignals(issue.id, deps);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0]!.trigger, "attempts_exhausted");
  const args = calls.filter((c) => c.toolName === "propose_playbook_patch")[0]!.args;
  assert.equal(validateSignalOnlyArgs(args), null);
  assert.equal(args.kind, "signal_only");
  const exhaustedEvidence = evidenceOf(args);
  assert.match(exhaustedEvidence.failure_summary, /exhausted/);
  assert.ok(
    exhaustedEvidence.failure_summary.includes("no observed playbook use"),
    "no receipt means the report says no observed playbook use"
  );
  assert.ok(exhaustedEvidence.failure_summary.includes(issue.id));

  // The human then retries: the same action must not produce a second signal.
  resolveHumanAction(exhausted.id, "operator", { choice: "retry" });
  const afterRetry = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(afterRetry.sent, []);
  assert.equal(calls.filter((c) => c.toolName === "propose_playbook_patch").length, 1);
  assert.equal(sentSignalsFor(issue.id).length, 1);

  // And a restart changes nothing.
  const restart = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(restart.sent, []);
  assert.equal(sentSignalsFor(issue.id).length, 1);
});

test("a recurring blocking finding creates one signal; non-blocking recurrence does not", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  seedTerminalSession(issue.id, agent);
  reconcileFinding({
    issueId: issue.id, fingerprint: "missing-null-check", severity: "blocking",
    title: "Missing null check", rationale: "crashes on empty input", round: 1,
  });
  reconcileFinding({
    issueId: issue.id, fingerprint: "missing-null-check", severity: "blocking",
    title: "Missing null check", rationale: "still crashes", round: 2,
  });
  reconcileFinding({
    issueId: issue.id, fingerprint: "typo-in-comment", severity: "non_blocking",
    title: "Typo", rationale: "cosmetic", round: 1,
  });
  reconcileFinding({
    issueId: issue.id, fingerprint: "typo-in-comment", severity: "non_blocking",
    title: "Typo", rationale: "still cosmetic", round: 2,
  });
  const { deps, calls } = makeDeps({ fetches: [] });

  const result = await reportDeckFailureSignals(issue.id, deps);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0]!.trigger, "recurring_blocking");
  const args = calls.filter((c) => c.toolName === "propose_playbook_patch")[0]!.args;
  assert.equal(validateSignalOnlyArgs(args), null);
  assert.equal(args.kind, "signal_only");
  const recurringEvidence = evidenceOf(args);
  assert.match(recurringEvidence.failure_summary, /missing-null-check/);
  assert.doesNotMatch(recurringEvidence.failure_summary, /typo-in-comment/);
  assert.ok(recurringEvidence.failure_summary.includes("no observed playbook use"));

  const restart = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(restart.sent, []);
  assert.equal(sentSignalsFor(issue.id).length, 1);
});

test("all three triggers together send three signal_only reports, never an update", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  seedTerminalSession(issue.id, agent);
  const repair = createHumanAction({
    issueId: issue.id, actionType: "final_review", reason: "Needs repair.", question: "Repair?",
  });
  resolveHumanAction(repair.id, "operator", { choice: "repair" });
  createHumanAction({
    issueId: issue.id, actionType: "attempts_exhausted", reason: "Rounds spent.", question: "Retry?",
  });
  reconcileFinding({
    issueId: issue.id, fingerprint: "flaky-lock", severity: "blocking",
    title: "Flaky lock", rationale: "deadlocks", round: 1,
  });
  reconcileFinding({
    issueId: issue.id, fingerprint: "flaky-lock", severity: "blocking",
    title: "Flaky lock", rationale: "deadlocks again", round: 2,
  });
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-e" }] });

  const result = await reportDeckFailureSignals(issue.id, deps);
  assert.equal(result.sent.length, 3);
  const proposes = calls.filter((c) => c.toolName === "propose_playbook_patch");
  assert.equal(proposes.length, 3);
  for (const call of proposes) {
    assert.equal(call.args.kind, "signal_only");
    assert.equal(validateSignalOnlyArgs(call.args), null);
    assert.equal("ops" in call.args, false);
    assert.equal("playbook_id" in call.args, false);
  }
  const triggers = result.sent.map((s) => s.trigger).sort();
  assert.deepStrictEqual(triggers, ["attempts_exhausted", "human_retry", "recurring_blocking"]);
  // Deterministic source keys are unique per trigger.
  assert.equal(new Set(result.sent.map((s) => s.sourceKey)).size, 3);
});

test("Deck outage records a visible error and preserves the issue state", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const session = seedTerminalSession(issue.id, agent, "failed");
  const before = (await import("../repository/issues.js")).getIssue(issue.id)!;
  const { deps, calls } = makeDeps({ healthy: false });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "failed");
  // Never touches Deck tools when the health gate fails.
  assert.deepStrictEqual(calls, []);
  // Visible status, retryable on a later trigger.
  const statuses = listArtifactsForIssueByKind(issue.id, "reflect_status").map((a) => JSON.parse(a.contentJson!));
  assert.ok(statuses.some((s) => s.status === "failed" || s.status === "error" || /offline/i.test(s.error ?? s.reason ?? "")));
  const receipts = receiptsFor(issue.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, "error");
  // The already-decided issue state is untouched.
  assert.equal((await import("../repository/issues.js")).getIssue(issue.id)!.status, before.status);
  assert.equal(getWorkerSession(session.id)!.status, "failed");
});

test("a malformed correlation response records an error receipt, keeps state, retries later", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const session = seedTerminalSession(issue.id, agent);
  const first = makeDeps({ correlationData: { unexpected: "shape" } });
  const result = await collectPlaybookUseReceipt(session.id, first.deps);
  assert.equal(result.collected, false);
  const receipts = receiptsFor(issue.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.status, "error");

  // Deck recovers: the next trigger heals the gap with a collected row.
  const healed = makeDeps({ fetches: [{ playbook_id: "pb-late" }] });
  const retry = await collectPlaybookUseReceipt(session.id, healed.deps);
  assert.equal(retry.collected, true);
  assert.deepStrictEqual(
    receiptsFor(issue.id).filter((r) => r.status === "collected").map((r) => r.playbookIds),
    [["pb-late"]]
  );
  // Issue-level collection now reads the latest (collected) row — the healed gap
  // does not count as an error and a later trigger is not stuck on "failed".
  const healedIssue = await collectPlaybookUseReceiptsForIssue(issue.id, healed.deps);
  assert.equal(healedIssue.errors, 0);
});

test("parseCorrelatedFetches rejects identity-less entries instead of guessing IDs", () => {
  assert.deepStrictEqual(parseCorrelatedFetches({ fetches: [] }), []);
  assert.equal(parseCorrelatedFetches({ nope: 1 }), null);
  assert.equal(parseCorrelatedFetches({ fetches: [{ playbook_id: " " }] }), null);
  assert.equal(parseCorrelatedFetches({ fetches: [{ title: "no id" }] }), null);
  assert.deepStrictEqual(parseCorrelatedFetches({ usage: [{ playbookId: "pb-camel" }] }), [
    { playbookId: "pb-camel", firstFetchedAt: null, lastFetchedAt: null },
  ]);
});

test("issue-level collection covers every terminal session and ignores running ones", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const done = seedTerminalSession(issue.id, agent, "done");
  const failed = seedTerminalSession(issue.id, agent, "failed");
  const snapshot = { ...buildProfileSnapshot(agent, "developer"), deckId: DECK };
  // Still running — no receipt yet.
  createWorkerSession({
    issueId: issue.id, role: "reviewer", round: 1, agentId: agent.id,
    runtime: agent.runtime, profileSnapshotJson: serializeProfileSnapshot(snapshot),
  });
  const { deps } = makeDeps({ fetches: [{ playbook_id: "pb-s" }] });
  const result = await collectPlaybookUseReceiptsForIssue(issue.id, deps);
  assert.equal(result.collected, 2);
  const ids = receiptsFor(issue.id).map((r) => r.workerSessionId).sort();
  assert.deepStrictEqual(ids, [done.id, failed.id].sort());
});

test("buildSignalOnlyArgs emits only Deck-schema fields with refs in Deck-stored fields", () => {
  const args = buildSignalOnlyArgs(
    {
      trigger: "human_retry" as "human_retry",
      sourceKey: "dealer:issue-1:human_retry:act-1",
      humanActionId: "act-1",
      failure: "Human repair on final_review (action act-1). Stated reason: broken.",
      userFeedback: "broken",
    },
    { issueId: "issue-1", workerSessionIds: ["ws-1"], playbookIds: ["pb-a", "pb-b"] }
  );
  assert.equal(validateSignalOnlyArgs(args), null);
  assert.ok((args.rationale as string).includes("dealer:issue-1:human_retry:act-1"));
  const evidence = evidenceOf(args);
  assert.ok(evidence.failure_summary.includes("Dealer issue: issue-1"));
  assert.ok(evidence.failure_summary.includes("Worker sessions: ws-1"));
  assert.ok(evidence.failure_summary.includes("pb-a") && evidence.failure_summary.includes("pb-b"));
  assert.equal(evidence.user_feedback_excerpt, "broken");

  // No observed use is explicit, never a legacy fallback.
  const noneArgs = buildSignalOnlyArgs(
    {
      trigger: "attempts_exhausted" as "attempts_exhausted",
      sourceKey: "dealer:issue-1:attempts_exhausted:act-2",
      humanActionId: "act-2",
      failure: "Review attempts were exhausted.",
      userFeedback: null,
    },
    { issueId: "issue-1", workerSessionIds: [], playbookIds: [] }
  );
  assert.equal(validateSignalOnlyArgs(noneArgs), null);
  assert.match(evidenceOf(noneArgs).failure_summary, /no observed playbook use/);
  assert.equal("user_feedback_excerpt" in evidenceOf(noneArgs), false);

  // The validator rejects every Dealer-only smuggled field a real Deck would drop.
  for (const extra of ["source_key", "trigger", "issue_ref", "failure", "playbook_ids", "observed_playbook_use"]) {
    const rejected = validateSignalOnlyArgs({
      kind: "signal_only",
      rationale: "r",
      evidence: { failure_summary: "f" },
      [extra]: "x",
    });
    assert.match(rejected!, /unknown top-level field/, `${extra} must be rejected`);
  }
  assert.equal(
    validateSignalOnlyArgs({ kind: "signal_only", rationale: "r", evidence: { nope: 1 } }),
    "unknown evidence field: nope"
  );
});

test("a failed Deck send leaves the pending intent; the retry reuses the same key", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  seedTerminalSession(issue.id, agent);
  const action = createHumanAction({
    issueId: issue.id, actionType: "final_review", reason: "Flaky on retry.", question: "Repair?",
  });
  resolveHumanAction(action.id, "operator", { choice: "repair" });
  const expectedKey = `dealer:${issue.id}:human_retry:${action.id}`;

  const failing = makeDeps({
    fetches: [],
    propose: () => ({ ok: false, kind: "infra_failure", reason: "temporary deck error" }),
  });
  const first = await reportDeckFailureSignals(issue.id, failing.deps);
  assert.deepStrictEqual(first.sent, []);
  assert.equal(failing.calls.filter((c) => c.toolName === "propose_playbook_patch").length, 1);
  // No sent row, but the pending intent survives the failure for the retry.
  assert.equal(sentSignalsFor(issue.id).length, 0);
  assert.equal(pendingSignalsFor(issue.id).length, 1);
  assert.equal(pendingSignalsFor(issue.id)[0]!.sourceKey, expectedKey);

  const succeeding = makeDeps({ fetches: [] });
  const second = await reportDeckFailureSignals(issue.id, succeeding.deps);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0]!.sourceKey, expectedKey);
  // No second pending row: the retry reconciled to the same intent.
  assert.equal(pendingSignalsFor(issue.id).length, 1);
  assert.equal(sentSignalsFor(issue.id).length, 1);
  const retryEvidence = evidenceOf(
    succeeding.calls.filter((c) => c.toolName === "propose_playbook_patch")[0]!.args
  );
  assert.ok(retryEvidence.failure_summary.includes(expectedKey));
  const failedEvidence = evidenceOf(
    failing.calls.filter((c) => c.toolName === "propose_playbook_patch")[0]!.args
  );
  assert.equal(retryEvidence.failure_summary, failedEvidence.failure_summary);
});

test("a crash between the Deck send and the sent-write reconciles to the same key", async () => {
  const agent = seedAgent();
  const issue = seedIssue(agent.id);
  const session = seedTerminalSession(issue.id, agent);
  const action = createHumanAction({
    issueId: issue.id, actionType: "final_review", reason: "Drops state.", question: "Repair?",
  });
  resolveHumanAction(action.id, "operator", { choice: "repair" });
  const expectedKey = `dealer:${issue.id}:human_retry:${action.id}`;

  // Simulate the crash window: a first attempt wrote its pending intent and
  // reached Deck, but the process died before writing the sent row.
  createIssueArtifact({
    issueId: issue.id,
    kind: "deck_feedback_signal",
    author: "system",
    content: {
      sourceKey: expectedKey,
      trigger: "human_retry",
      humanActionId: action.id,
      signalId: null,
      deckId: DECK,
      workerSessionIds: [session.id],
      playbookIds: [],
      observedPlaybookUse: "none",
      failure: "Human repair on final_review (action placeholder).",
      status: "pending",
    },
  });

  const { deps, calls } = makeDeps({ fetches: [] });
  const result = await reportDeckFailureSignals(issue.id, deps);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0]!.sourceKey, expectedKey);
  // Exactly one send, carrying the identical Deck-visible key, and no second
  // pending row — Deck can recognize the repeat as the same report.
  const proposes = calls.filter((c) => c.toolName === "propose_playbook_patch");
  assert.equal(proposes.length, 1);
  assert.ok(evidenceOf(proposes[0]!.args).failure_summary.includes(expectedKey));
  assert.equal(pendingSignalsFor(issue.id).length, 1);
  assert.equal(sentSignalsFor(issue.id).length, 1);

  // A further restart sends nothing more.
  const restart = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(restart.sent, []);
  assert.equal(calls.filter((c) => c.toolName === "propose_playbook_patch").length, 1);
});
