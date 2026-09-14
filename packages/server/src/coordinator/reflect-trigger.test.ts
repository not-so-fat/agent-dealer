// packages/server/src/coordinator/reflect-trigger.test.ts
//
// NOT-64: triggerIssueReflect is the lightweight (no agent-spawn) reflect fired on
// final_review:complete. Network calls to Agent Deck are faked via the injectable
// `deps` seam.
//
// NOT-106: Deck calls go through launch-fixed deck headers via `deps.callTool`
// (adapters/reflect-authority.ts) — no mint.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReflectDeps } from "./reflect-trigger.js";
import type { AuthorizedDeckCallResult } from "../adapters/reflect-authority.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reflect-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createAgent } = await import("../repository/agents.js");
const { createWorkerSession } = await import("../repository/worker-sessions.js");
const { buildProfileSnapshot, serializeProfileSnapshot } = await import("./profile-snapshot.js");
const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { listArtifactsForIssue, listArtifactsForIssueByKind } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue, createHumanAction } = await import("../repository/human-actions.js");
const { triggerIssueReflect, resolveReflectionInteractionAction } = await import("./reflect-trigger.js");

before(() => {
  migrate();
});

function seedIssue(developerAgentId: string) {
  return createIssue({
    title: "Reflect issue",
    repo: "/repo",
    developerAgentId,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  });
}

function seedFinalDeveloperSession(
  issueId: string,
  agent: ReturnType<typeof createAgent>,
  overrides: { deckId: string | null; playbookIds: string[] }
) {
  const snapshot = { ...buildProfileSnapshot(agent, "developer"), ...overrides };
  return createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: agent.id,
    runtime: agent.runtime,
    profileSnapshotJson: serializeProfileSnapshot(snapshot),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out waiting for predicate");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Default deps: healthy deck, get_playbook/propose_playbook_patch both succeed. */
function makeDeps(overrides: {
  getPlaybook?: (playbookId: string) => AuthorizedDeckCallResult<{ id: string; title: string; body: string }>;
  proposePatch?: (
    playbookId: string,
    rationale: string
  ) => AuthorizedDeckCallResult<{ id: string; playbookId: string | null }>;
  checkHealth?: ReflectDeps["checkHealth"];
}): ReflectDeps {
  return {
    checkHealth: overrides.checkHealth ?? (async () => true),
    callTool: (async (opts: { toolName: string; arguments: Record<string, unknown> }) => {
      if (opts.toolName === "get_playbook") {
        const playbookId = opts.arguments.playbook_id as string;
        return overrides.getPlaybook
          ? overrides.getPlaybook(playbookId)
          : { ok: true, data: { id: playbookId, title: `Playbook ${playbookId}`, body: "" } };
      }
      if (opts.toolName === "propose_playbook_patch") {
        const playbookId = opts.arguments.playbook_id as string;
        const rationale = opts.arguments.rationale as string;
        return overrides.proposePatch
          ? overrides.proposePatch(playbookId, rationale)
          : { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
      }
      throw new Error(`unexpected tool call: ${opts.toolName}`);
    }) as ReflectDeps["callTool"],
  };
}

test("skips when the developer profile has no deck configured and no session snapshot exists", async () => {
  const issue = seedIssue(BUILTIN_AGENT_CLAUDE_ID);
  const result = await triggerIssueReflect(issue.id);
  assert.equal(result, "skipped");
});

test("uses the frozen session snapshot's deck/playbooks, not the live (possibly edited) agent profile", async () => {
  const dev = createAgent({
    name: `dev-${Math.random()}`,
    runtime: "claude_code",
    workspaceRoot: "/repo",
    deckId: "22222222-2222-4222-a222-222222222222",
    playbookIds: ["pb-live-edited-after-the-fact"],
  });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, {
    deckId: "11111111-1111-4111-a111-111111111111",
    playbookIds: ["pb-1", "pb-2"],
  });

  const calledDeckIds: string[] = [];
  const proposed: string[] = [];
  const deps = makeDeps({
    proposePatch: (playbookId) => {
      proposed.push(playbookId);
      return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
    },
  });
  const wrapped: ReflectDeps = {
    ...deps,
    callTool: (async (opts) => {
      calledDeckIds.push(opts.deckId);
      return deps.callTool(opts);
    }) as ReflectDeps["callTool"],
  };

  const result = await triggerIssueReflect(issue.id, wrapped);
  assert.equal(result, "triggered");
  assert.ok(calledDeckIds.every((id) => id === "11111111-1111-4111-a111-111111111111"));
  assert.deepStrictEqual(proposed.sort(), ["pb-1", "pb-2"]);
});

test("falls back to the live agent profile when the developer session has no frozen snapshot (legacy row)", async () => {
  const dev = createAgent({
    name: `dev-${Math.random()}`,
    runtime: "claude_code",
    workspaceRoot: "/repo",
    deckId: "33333333-3333-4333-a333-333333333333",
    playbookIds: ["pb-live"],
  });
  const issue = seedIssue(dev.id);
  createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: dev.id, runtime: "claude_code" });

  const proposed: string[] = [];
  const deps = makeDeps({
    proposePatch: (playbookId) => {
      proposed.push(playbookId);
      return { ok: true, data: { id: "patch", playbookId } };
    },
  });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(proposed, ["pb-live"]);
});

test("the legacy-row fallback also honors a profile with only the singular legacy playbookId", async () => {
  const dev = createAgent({
    name: `dev-${Math.random()}`,
    runtime: "claude_code",
    workspaceRoot: "/repo",
    deckId: "44444444-4444-4444-a444-444444444444",
    playbookId: "pb-legacy",
  });
  const issue = seedIssue(dev.id);
  createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: dev.id, runtime: "claude_code" });

  const proposed: string[] = [];
  const deps = makeDeps({
    proposePatch: (playbookId) => {
      proposed.push(playbookId);
      return { ok: true, data: { id: "patch", playbookId } };
    },
  });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(proposed, ["pb-legacy"]);
});

test("skips when the deck is offline, and records why — never calls Deck tools", async () => {
  const dev = createAgent({
    name: `dev-${Math.random()}`,
    runtime: "claude_code",
    workspaceRoot: "/repo",
    deckId: "11111111-1111-4111-a111-111111111111",
    playbookIds: ["pb-1"],
  });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, {
    deckId: "11111111-1111-4111-a111-111111111111",
    playbookIds: ["pb-1"],
  });
  const deps: ReflectDeps = {
    checkHealth: async () => false,
    callTool: (async () => {
      throw new Error("should not be called");
    }) as ReflectDeps["callTool"],
  };
  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "skipped");
  const artifacts = listArtifactsForIssue(issue.id);
  assert.ok(
    artifacts.some((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).reason === "Agent Deck offline")
  );
});

test("posts one patch per playbook, using the implementation conclusion and review history as rationale", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, {
    deckId: "11111111-1111-4111-a111-111111111111",
    playbookIds: ["pb-1", "pb-2"],
  });
  createIssueArtifact({
    issueId: issue.id,
    kind: "implementation_conclusion",
    author: "agent",
    content: { text: "Implemented the widget using the shared component." },
  });
  appendWorkflowEvent({
    issueId: issue.id,
    type: "review.submitted",
    actorType: "reviewer",
    stage: "reviewing",
    payload: { verdict: "changes_requested" },
  });
  appendWorkflowEvent({
    issueId: issue.id,
    type: "review.submitted",
    actorType: "reviewer",
    stage: "reviewing",
    payload: { verdict: "approved" },
  });

  const proposed: string[] = [];
  const deps = makeDeps({
    proposePatch: (playbookId, rationale) => {
      proposed.push(playbookId);
      assert.match(rationale, /2 review round\(s\)/);
      assert.match(rationale, /changes_requested → approved/);
      assert.match(rationale, /Implemented the widget using the shared component\./);
      return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
    },
  });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(proposed.sort(), ["pb-1", "pb-2"]);

  const artifacts = listArtifactsForIssue(issue.id);
  assert.equal(artifacts.filter((a) => a.kind === "playbook_patch").length, 2);
});

test("a retry after a mid-loop failure does not re-propose a playbook that already succeeded", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, {
    deckId: "11111111-1111-4111-a111-111111111111",
    playbookIds: ["pb-ok", "pb-fail"],
  });

  let failPbFail = true;
  const proposedCalls: string[] = [];
  const deps = makeDeps({
    proposePatch: (playbookId) => {
      proposedCalls.push(playbookId);
      if (playbookId === "pb-fail" && failPbFail) {
        return { ok: false, kind: "infra_failure", reason: "temporary deck error" };
      }
      return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
    },
  });

  const first = await triggerIssueReflect(issue.id, deps);
  assert.equal(first, "triggered");
  assert.deepStrictEqual(proposedCalls, ["pb-ok", "pb-fail"]);

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
  failPbFail = false;
  const resolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "retry", deps);
  assert.equal(resolved.ok, true);
  await waitFor(() => proposedCalls.length >= 3);
  assert.deepStrictEqual(proposedCalls, ["pb-ok", "pb-fail", "pb-fail"]);
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

test("already-proposed playbook ids are skipped even behind a flood of other artifacts", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, {
    deckId: "11111111-1111-4111-a111-111111111111",
    playbookIds: ["pb-ok", "pb-next"],
  });
  createIssueArtifact({
    issueId: issue.id,
    kind: "playbook_patch",
    author: "system",
    content: { patchId: "existing", playbookId: "pb-ok", status: "proposed" },
  });
  for (let i = 0; i < 30; i++) {
    createIssueArtifact({
      issueId: issue.id,
      kind: "developer_transcript",
      author: "system",
      content: { n: i },
    });
  }

  const proposed: string[] = [];
  const deps = makeDeps({
    proposePatch: (playbookId) => {
      proposed.push(playbookId);
      return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
    },
  });
  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(proposed, ["pb-next"]);
  assert.equal(listArtifactsForIssueByKind(issue.id, "playbook_patch").length, 2);
});
