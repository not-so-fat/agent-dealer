// packages/server/src/coordinator/reflect-trigger.test.ts
//
// NOT-305: triggerIssueReflect records completion evidence — actual-use receipts for
// every terminal worker session plus one idempotent `signal_only` Deck report per
// failure/correction trigger. It never proposes a playbook patch (`kind: update`) and
// never appends generic `Notes` items.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReflectDeps } from "./reflect-trigger.js";
import type { AuthorizedDeckCallResult } from "../adapters/reflect-authority.js";
import { DECK_CORRELATION_TOOL, validateSignalOnlyArgs } from "./playbook-feedback.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reflect-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createAgent } = await import("../repository/agents.js");
const { createWorkerSession, completeSession } = await import("../repository/worker-sessions.js");
const { buildProfileSnapshot, serializeProfileSnapshot } = await import("./profile-snapshot.js");
const { createHumanAction, resolveHumanAction } = await import("../repository/human-actions.js");
const { listArtifactsForIssue, listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { triggerIssueReflect, resolveReflectionInteractionAction } = await import("./reflect-trigger.js");

before(() => {
  migrate();
});

const DECK = "11111111-1111-4111-a111-111111111111";

function seedIssue(developerAgentId: string) {
  return createIssue({
    title: "Reflect issue",
    repo: "acme/app",
    developerAgentId,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
}

/** Terminal developer session on a NOT-149 profile: snapshot names the deck, no playbook IDs anywhere. */
function seedTerminalDeveloperSession(issueId: string, agent: ReturnType<typeof createAgent>) {
  assert.equal(agent.playbookIdsJson, null);
  const snapshot = { ...buildProfileSnapshot(agent, "developer"), deckId: DECK };
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: agent.id,
    runtime: agent.runtime,
    profileSnapshotJson: serializeProfileSnapshot(snapshot),
  });
  completeSession(session.id, { status: "done" });
  return session;
}

interface CallRecord {
  toolName: string;
  args: Record<string, unknown>;
}

/** Default deps: healthy deck, correlation succeeds, signal_only succeeds. */
function makeDeps(overrides: {
  fetches?: Array<{ playbook_id: string }>;
  correlationData?: unknown;
  propose?: (args: Record<string, unknown>) => AuthorizedDeckCallResult<{ id: string }>;
  checkHealth?: ReflectDeps["checkHealth"];
} = {}): { deps: ReflectDeps; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const deps: ReflectDeps = {
    checkHealth: overrides.checkHealth ?? (async () => true),
    callTool: (async (opts: { toolName: string; arguments: Record<string, unknown> }) => {
      calls.push({ toolName: opts.toolName, args: opts.arguments });
      if (opts.toolName === DECK_CORRELATION_TOOL) {
        return { ok: true, data: overrides.correlationData ?? { fetches: overrides.fetches ?? [] } };
      }
      if (opts.toolName === "propose_playbook_patch") {
        if (opts.arguments.kind !== "signal_only") {
          throw new Error(`issue-centric reflection must only send signal_only, got ${opts.arguments.kind}`);
        }
        const schemaError = validateSignalOnlyArgs(opts.arguments);
        if (schemaError) {
          throw new Error(`signal payload violates Deck schema: ${schemaError}`);
        }
        return overrides.propose
          ? overrides.propose(opts.arguments)
          : { ok: true, data: { id: `sig-${calls.length}` } };
      }
      throw new Error(`unexpected tool call: ${opts.toolName}`);
    }) as ReflectDeps["callTool"],
  };
  return { deps, calls };
}

function sentSignals(issueId: string): Array<{ status?: unknown }> {
  return listArtifactsForIssueByKind(issueId, "deck_feedback_signal")
    .map((a) => JSON.parse(a.contentJson!))
    .filter((s) => s.status === "sent");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out waiting for predicate");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("skips when the issue has no terminal sessions and no failure triggers", async () => {
  const issue = seedIssue(BUILTIN_AGENT_CLAUDE_ID);
  const { deps, calls } = makeDeps();
  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "skipped");
  assert.deepStrictEqual(calls, []);
});

test("a clean completed run records the actual-use receipt and sends no signal", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  const session = seedTerminalDeveloperSession(issue.id, dev);
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-1" }, { playbook_id: "pb-2" }] });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");

  const receipts = listArtifactsForIssueByKind(issue.id, "playbook_use_receipt").map((a) =>
    JSON.parse(a.contentJson!)
  );
  assert.equal(receipts.length, 1);
  assert.deepStrictEqual(receipts[0].playbookIds, ["pb-1", "pb-2"]);
  assert.equal(receipts[0].workerSessionId, session.id);

  assert.deepStrictEqual(
    calls.filter((c) => c.toolName === "propose_playbook_patch"),
    []
  );
  assert.deepStrictEqual(listArtifactsForIssueByKind(issue.id, "deck_feedback_signal"), []);
  assert.deepStrictEqual(sentSignals(issue.id), []);
});

test("a human correction produces one signal_only report; a restart sends nothing more", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  seedTerminalDeveloperSession(issue.id, dev);
  const action = createHumanAction({
    issueId: issue.id,
    actionType: "final_review",
    reason: "Needs a repair round.",
    question: "Repair?",
  });
  resolveHumanAction(action.id, "operator", { choice: "repair" });
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-1" }] });

  assert.equal(await triggerIssueReflect(issue.id, deps), "triggered");
  const proposes = () => calls.filter((c) => c.toolName === "propose_playbook_patch");
  assert.equal(proposes().length, 1);
  assert.equal(proposes()[0]!.args.kind, "signal_only");

  // Simulated restart: idempotent, no duplicate Deck report.
  assert.equal(await triggerIssueReflect(issue.id, deps), "skipped");
  assert.equal(proposes().length, 1);
  assert.equal(sentSignals(issue.id).length, 1);
});

test("records a visible failure and preserves state when the deck is offline", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  seedTerminalDeveloperSession(issue.id, dev);
  const { deps, calls } = makeDeps({ checkHealth: async () => false });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "failed");
  assert.deepStrictEqual(calls, []);
  const artifacts = listArtifactsForIssue(issue.id);
  assert.ok(
    artifacts.some(
      (a) =>
        a.kind === "reflect_status" || (a.kind === "playbook_use_receipt" && JSON.parse(a.contentJson!).status === "error")
    )
  );
});

test("a retry after a failed signal send re-sends exactly once, never duplicating", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  seedTerminalDeveloperSession(issue.id, dev);
  const action = createHumanAction({
    issueId: issue.id,
    actionType: "final_review",
    reason: "Needs a repair round.",
    question: "Repair?",
  });
  resolveHumanAction(action.id, "operator", { choice: "repair" });

  let failPropose = true;
  const { deps, calls } = makeDeps({
    propose: () =>
      failPropose
        ? { ok: false, kind: "infra_failure", reason: "temporary deck error" }
        : { ok: true, data: { id: "sig-1" } },
  });
  const proposes = () => calls.filter((c) => c.toolName === "propose_playbook_patch");

  const first = await triggerIssueReflect(issue.id, deps);
  assert.equal(first, "triggered"); // the receipt still recorded
  assert.equal(proposes().length, 1);
  assert.equal(sentSignals(issue.id).length, 0);

  createHumanAction({
    issueId: issue.id,
    actionType: "reflection_interaction_required",
    reason: "legacy park for retry coverage",
    question: "Retry?",
    responseOptions: [
      { choice: "retry", label: "Retry" },
      { choice: "dismiss", label: "Dismiss" },
    ],
  });
  const parkedAction = listHumanActionsForIssue(issue.id).find(
    (a) => a.actionType === "reflection_interaction_required" && a.status === "open"
  )!;
  failPropose = false;
  const resolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "retry", deps);
  assert.equal(resolved.ok, true);
  await waitFor(() => sentSignals(issue.id).length >= 1);
  assert.equal(proposes().length, 2);
  assert.equal(sentSignals(issue.id).length, 1);
});

test("resolveReflectionInteractionAction:dismiss closes the action without further Deck calls", async () => {
  const issue = seedIssue(BUILTIN_AGENT_CLAUDE_ID);
  createHumanAction({
    issueId: issue.id,
    actionType: "reflection_interaction_required",
    reason: "Approve.",
    question: "Retry?",
    responseOptions: [
      { choice: "retry", label: "Retry" },
      { choice: "dismiss", label: "Dismiss" },
    ],
    requestId: "req_dismiss",
  });
  const parkedAction = listHumanActionsForIssue(issue.id).find(
    (a) => a.actionType === "reflection_interaction_required" && a.status === "open"
  )!;
  const resolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "dismiss");
  assert.equal(resolved.ok, true);
  const after = listHumanActionsForIssue(issue.id).find((a) => a.id === parkedAction.id)!;
  assert.equal(after.status, "resolved");
});

test("resolveReflectionInteractionAction rejects an invalid choice and already-resolved actions", async () => {
  const issue = seedIssue(BUILTIN_AGENT_CLAUDE_ID);
  createHumanAction({
    issueId: issue.id,
    actionType: "reflection_interaction_required",
    reason: "Approve.",
    question: "Retry?",
    responseOptions: [
      { choice: "retry", label: "Retry" },
      { choice: "dismiss", label: "Dismiss" },
    ],
    requestId: "req_bad_choice",
  });
  const parkedAction = listHumanActionsForIssue(issue.id).find(
    (a) => a.actionType === "reflection_interaction_required" && a.status === "open"
  )!;
  const badChoice = resolveReflectionInteractionAction(parkedAction.id, "operator", "close");
  assert.equal(badChoice.ok, false);
  const dismissed = resolveReflectionInteractionAction(parkedAction.id, "operator", "dismiss");
  assert.equal(dismissed.ok, true);
  const alreadyResolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "retry");
  assert.equal(alreadyResolved.ok, false);
});

test("reflect_status names a malformed correlation response instead of blaming an offline Deck", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  seedTerminalDeveloperSession(issue.id, dev);
  const { deps } = makeDeps({ correlationData: { unexpected: "shape" } });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "failed");
  const statuses = listArtifactsForIssueByKind(issue.id, "reflect_status").map((a) =>
    JSON.parse(a.contentJson!)
  );
  assert.ok(statuses.length > 0);
  const text = statuses.map((s) => `${s.reason ?? ""} ${s.error ?? ""}`).join("\n");
  assert.match(text, /malformed/i);
  assert.doesNotMatch(text, /offline/i);
});

test("reflect_status still says offline when the receipt error really is a Deck outage", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  seedTerminalDeveloperSession(issue.id, dev);
  const { deps } = makeDeps({ checkHealth: async () => false });

  assert.equal(await triggerIssueReflect(issue.id, deps), "failed");
  const statuses = listArtifactsForIssueByKind(issue.id, "reflect_status").map((a) =>
    JSON.parse(a.contentJson!)
  );
  assert.ok(statuses.some((s) => /offline/i.test(`${s.reason ?? ""} ${s.error ?? ""}`)));
});

test("never calls propose_playbook_patch with kind:update and never writes Notes items", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: DECK });
  const issue = seedIssue(dev.id);
  seedTerminalDeveloperSession(issue.id, dev);
  const action = createHumanAction({
    issueId: issue.id,
    actionType: "attempts_exhausted",
    reason: "Rounds spent.",
    question: "Close?",
  });
  resolveHumanAction(action.id, "operator", { choice: "close" });
  const { deps, calls } = makeDeps({ fetches: [{ playbook_id: "pb-9" }] });

  await triggerIssueReflect(issue.id, deps);
  for (const call of calls) {
    if (call.toolName !== "propose_playbook_patch") continue;
    assert.notEqual(call.args.kind, "update");
    assert.equal(call.args.kind, "signal_only");
    const ops = call.args.ops as Array<{ section?: string }> | undefined;
    assert.ok(!ops || !ops.some((op) => op.section === "Notes"));
  }
  assert.equal(listArtifactsForIssueByKind(issue.id, "playbook_patch").length, 0);
});
