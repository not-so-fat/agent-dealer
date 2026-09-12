// packages/server/src/coordinator/reflect-trigger.test.ts
//
// NOT-64: triggerIssueReflect is the lightweight (no agent-spawn) reflect fired on
// final_review:complete. Network calls to Agent Deck are faked via the injectable
// `deps` seam, mirroring developer-effect.test.ts/reviewer-effect.test.ts's convention
// of faking the network boundary while exercising the real DB-reading logic.
//
// PR #11 review: the deck/playbooks reflect targets must come from the issue's final
// developer session's frozen profileSnapshotJson, not the live (possibly since-edited)
// agent profile — these tests seed a session snapshot that deliberately differs from the
// live agent record to prove the frozen value wins.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-reflect-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { createAgent } = await import("../repository/agents.js");
const { createWorkerSession } = await import("../repository/worker-sessions.js");
const { buildProfileSnapshot, serializeProfileSnapshot } = await import("./profile-snapshot.js");
const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
const { createIssueArtifact } = await import("../repository/artifacts.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { triggerIssueReflect } = await import("./reflect-trigger.js");

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

/** Records a completed developer session whose frozen snapshot deliberately overrides
 * deckId/playbookIds away from whatever the live agent record has — the exact repro from
 * the PR review (a profile edit after execution, or a legacy playbookId agent must not
 * redirect reflect at the live profile). `agent` is the real created-agent record so
 * buildProfileSnapshot sees a genuine AgentProfile shape, not a partial stand-in. */
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

test("skips when the developer profile has no deck configured and no session snapshot exists", async () => {
  const issue = seedIssue(BUILTIN_AGENT_CLAUDE_ID); // built-in agent: no deck/playbooks, no session
  const result = await triggerIssueReflect(issue.id);
  assert.equal(result, "skipped");
});

test("uses the frozen session snapshot's deck/playbooks, not the live (possibly edited) agent profile", async () => {
  // The live agent points at a different deck/playbook than what the developer actually
  // ran with — simulating a profile edit made after the session completed.
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo", deckId: "22222222-2222-4222-a222-222222222222", playbookIds: ["pb-live-edited-after-the-fact"] });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1", "pb-2"] });

  const proposed: Array<{ deckId: string; playbookId: string }> = [];
  const deps = {
    checkHealth: async () => true,
    fetchPlaybook: async (playbookId: string) => ({ id: playbookId, title: `Playbook ${playbookId}`, body: "" }),
    proposePatch: async (deckId: string, _sourceRef: string, proposal: { playbook_id: string }) => {
      proposed.push({ deckId, playbookId: proposal.playbook_id });
      return { id: `patch-${proposal.playbook_id}`, playbookId: proposal.playbook_id };
    },
  };

  const result = await triggerIssueReflect(issue.id, deps as never);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(
    proposed.sort((a, b) => a.playbookId.localeCompare(b.playbookId)),
    [
      { deckId: "11111111-1111-4111-a111-111111111111", playbookId: "pb-1" },
      { deckId: "11111111-1111-4111-a111-111111111111", playbookId: "pb-2" },
    ]
  );
});

test("falls back to the live agent profile when the developer session has no frozen snapshot (legacy row)", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo", deckId: "33333333-3333-4333-a333-333333333333", playbookIds: ["pb-live"] });
  const issue = seedIssue(dev.id);
  // A developer session with no profileSnapshotJson at all — pre-NOT-60 shape.
  createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: dev.id, runtime: "claude_code" });

  const proposed: string[] = [];
  const deps = {
    checkHealth: async () => true,
    fetchPlaybook: async (playbookId: string) => ({ id: playbookId, title: playbookId, body: "" }),
    proposePatch: async (_deckId: string, _sourceRef: string, proposal: { playbook_id: string }) => {
      proposed.push(proposal.playbook_id);
      return { id: "patch", playbookId: proposal.playbook_id };
    },
  };

  const result = await triggerIssueReflect(issue.id, deps as never);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(proposed, ["pb-live"]);
});

test("skips when the deck is offline, and records why", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo", deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps = {
    checkHealth: async () => false,
    fetchPlaybook: async () => {
      throw new Error("should not be called");
    },
    proposePatch: async () => {
      throw new Error("should not be called");
    },
  };
  const result = await triggerIssueReflect(issue.id, deps as never);
  assert.equal(result, "skipped");
  const artifacts = listArtifactsForIssue(issue.id);
  assert.ok(artifacts.some((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).reason === "Agent Deck offline"));
});

test("posts one patch per playbook, using the implementation conclusion and review history as rationale", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1", "pb-2"] });
  createIssueArtifact({ issueId: issue.id, kind: "implementation_conclusion", author: "agent", content: { text: "Implemented the widget using the shared component." } });
  appendWorkflowEvent({ issueId: issue.id, type: "review.submitted", actorType: "reviewer", stage: "reviewing", payload: { verdict: "changes_requested" } });
  appendWorkflowEvent({ issueId: issue.id, type: "review.submitted", actorType: "reviewer", stage: "reviewing", payload: { verdict: "approved" } });

  const proposed: Array<{ deckId: string; playbookId: string }> = [];
  const deps = {
    checkHealth: async () => true,
    fetchPlaybook: async (playbookId: string) => ({ id: playbookId, title: `Playbook ${playbookId}`, body: "" }),
    proposePatch: async (deckId: string, _sourceRef: string, proposal: { playbook_id: string; rationale: string }) => {
      proposed.push({ deckId, playbookId: proposal.playbook_id });
      assert.match(proposal.rationale, /2 review round\(s\)/);
      assert.match(proposal.rationale, /changes_requested → approved/);
      assert.match(proposal.rationale, /Implemented the widget using the shared component\./);
      return { id: `patch-${proposal.playbook_id}`, playbookId: proposal.playbook_id };
    },
  };

  const result = await triggerIssueReflect(issue.id, deps as never);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(
    proposed.sort((a, b) => a.playbookId.localeCompare(b.playbookId)),
    [
      { deckId: "11111111-1111-4111-a111-111111111111", playbookId: "pb-1" },
      { deckId: "11111111-1111-4111-a111-111111111111", playbookId: "pb-2" },
    ]
  );

  const artifacts = listArtifactsForIssue(issue.id);
  assert.equal(artifacts.filter((a) => a.kind === "playbook_patch").length, 2);
  const status = artifacts.find((a) => a.kind === "reflect_status");
  assert.equal(JSON.parse(status!.contentJson!).status, "completed");
});

test("a failed patch proposal for one playbook is recorded, not thrown, and does not block the others", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-ok", "pb-fail"] });
  const deps = {
    checkHealth: async () => true,
    fetchPlaybook: async (playbookId: string) => ({ id: playbookId, title: playbookId, body: "" }),
    proposePatch: async (_deckId: string, _sourceRef: string, proposal: { playbook_id: string }) => {
      if (proposal.playbook_id === "pb-fail") throw new Error("deck rejected the patch");
      return { id: "patch-ok", playbookId: proposal.playbook_id };
    },
  };

  const result = await triggerIssueReflect(issue.id, deps as never);
  assert.equal(result, "triggered"); // at least one playbook succeeded
  const artifacts = listArtifactsForIssue(issue.id);
  assert.equal(artifacts.filter((a) => a.kind === "playbook_patch").length, 1);
  assert.ok(artifacts.some((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).status === "failed" && JSON.parse(a.contentJson!).playbookId === "pb-fail"));
  const summary = artifacts.find((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).playbookCount !== undefined);
  assert.equal(JSON.parse(summary!.contentJson!).status, "partial");
});

test("never throws even if every proposal fails", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps = {
    checkHealth: async () => true,
    fetchPlaybook: async () => ({ id: "pb-1", title: "pb", body: "" }),
    proposePatch: async () => {
      throw new Error("network down");
    },
  };
  const result = await triggerIssueReflect(issue.id, deps as never);
  assert.equal(result, "failed");
});
