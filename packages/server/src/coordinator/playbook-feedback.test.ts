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
const { reconcileFinding } = await import("../repository/findings.js");
const { listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const {
  collectPlaybookUseReceipt,
  collectPlaybookUseReceiptsForIssue,
  reportDeckFailureSignals,
  parseCorrelatedFetches,
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
  // Only signal_only from this path — never an update proposal, never Notes ops.
  assert.equal(args.kind, "signal_only");
  assert.equal("playbook_id" in args, false);
  assert.equal("ops" in args, false);
  assert.ok(typeof args.source_key === "string" && args.source_key.startsWith(`dealer:${issue.id}:human_retry:`));
  assert.deepStrictEqual((args.issue_ref as { worker_session_ids: string[] }).worker_session_ids, [session.id]);
  assert.equal((args.issue_ref as { dealer_issue_id: string }).dealer_issue_id, issue.id);
  assert.deepStrictEqual(args.playbook_ids, ["pb-used-a", "pb-used-b"]);
  assert.equal(args.observed_playbook_use, "observed");
  assert.match(args.failure as string, /repair/);
  assert.match(args.failure as string, /drops state on rerender/);

  const signals = signalsFor(issue.id);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.trigger, "human_retry");

  // Simulated restart: same trigger, no duplicate Deck report.
  const again = await triggerIssueReflect(issue.id, deps);
  assert.equal(again, "skipped");
  assert.equal(calls.filter((c) => c.toolName === "propose_playbook_patch").length, 1);
  assert.equal(signalsFor(issue.id).length, 1);
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
  assert.equal(args.kind, "signal_only");
  assert.deepStrictEqual(args.playbook_ids, []);
  assert.equal(args.observed_playbook_use, "none");
  assert.match(args.failure as string, /exhausted/);

  // The human then retries: the same action must not produce a second signal.
  resolveHumanAction(exhausted.id, "operator", { choice: "retry" });
  const afterRetry = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(afterRetry.sent, []);
  assert.equal(calls.filter((c) => c.toolName === "propose_playbook_patch").length, 1);
  assert.equal(signalsFor(issue.id).length, 1);

  // And a restart changes nothing.
  const restart = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(restart.sent, []);
  assert.equal(signalsFor(issue.id).length, 1);
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
  assert.equal(args.kind, "signal_only");
  assert.match(args.failure as string, /missing-null-check/);
  assert.doesNotMatch(args.failure as string, /typo-in-comment/);

  const restart = await reportDeckFailureSignals(issue.id, deps);
  assert.deepStrictEqual(restart.sent, []);
  assert.equal(signalsFor(issue.id).length, 1);
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
    assert.equal("ops" in call.args, false);
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
