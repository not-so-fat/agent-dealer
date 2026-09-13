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
//
// NOT-94: every Deck call now goes through a minted execution authority
// (`deps.mintAuthority`) and an authority-authenticated tool call (`deps.callTool`) instead
// of the legacy bare-REST `fetchPlaybook`/`proposePlaybookPatch`. `deps.callTool` fakes the
// friendly `AuthorizedDeckCallResult` boundary (adapters/reflect-authority.ts), not the raw
// MCP tool result — that raw-envelope parsing is covered by
// adapters/agent-deck-bind.test.ts and is not re-tested here.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReflectDeps } from "./reflect-trigger.js";
import type { MintAuthorityResult } from "../adapters/execution-authority.js";
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
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
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

/** Polls `predicate` instead of a fixed sleep — a `retry` resolution fires
 * `triggerIssueReflect` fire-and-forget (matches the real route), so a test observing its
 * effect can't await it directly. A single fixed-duration sleep flakes under load (PR #21
 * review finding #2); polling every 5ms up to a generous 2s bound does not. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out waiting for predicate");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const MINT_OK = {
  ok: true as const,
  authority: {
    authorityId: "authz_1",
    authoritySecret: "authzs_secret",
    deckId: "11111111-1111-4111-a111-111111111111",
    audience: "dealer-worker" as const,
    allowedServices: [],
    allowedTools: [],
    expiresAt: "2026-01-01T00:30:00Z",
  },
};

/** Default deps: healthy deck, successful mint, get_playbook/propose_playbook_patch both
 * succeed trivially. Individual tests override just the handlers they care about. */
function makeDeps(overrides: {
  mintAuthority?: ReflectDeps["mintAuthority"];
  getPlaybook?: (playbookId: string) => AuthorizedDeckCallResult<{ id: string; title: string; body: string }>;
  proposePatch?: (
    playbookId: string,
    rationale: string
  ) => AuthorizedDeckCallResult<{ id: string; playbookId: string | null }>;
}): ReflectDeps {
  const revokedAuthorityIds: string[] = [];
  return {
    checkHealth: async () => true,
    mintAuthority: overrides.mintAuthority ?? (async () => MINT_OK),
    revokeAuthority: async (authorityId: string) => {
      revokedAuthorityIds.push(authorityId);
    },
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

  const mintedDeckIds: string[] = [];
  const proposed: string[] = [];
  const deps = makeDeps({
    mintAuthority: async (input) => {
      mintedDeckIds.push(input.deckId);
      return MINT_OK;
    },
    proposePatch: (playbookId) => {
      proposed.push(playbookId);
      return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
    },
  });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  // Mint happens once per reflect attempt (not once per playbook), scoped to the frozen
  // session snapshot's deckId — never the live agent's deckId.
  assert.deepStrictEqual(mintedDeckIds, ["11111111-1111-4111-a111-111111111111"]);
  assert.deepStrictEqual(proposed.sort(), ["pb-1", "pb-2"]);
});

test("falls back to the live agent profile when the developer session has no frozen snapshot (legacy row)", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo", deckId: "33333333-3333-4333-a333-333333333333", playbookIds: ["pb-live"] });
  const issue = seedIssue(dev.id);
  // A developer session with no profileSnapshotJson at all — pre-NOT-60 shape.
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

test("the legacy-row fallback also honors a profile with only the singular legacy playbookId (no playbookIdsJson)", async () => {
  // Reviewer repro: an existing profile can legitimately have only `playbookId` set, never
  // migrated to the list-shaped `playbookIds`. buildProfileSnapshot's profilePlaybookIds
  // already falls back list-then-singular; resolveReflectTargets must go through that same
  // function for its no-snapshot fallback rather than reading playbookIdsJson directly.
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo", deckId: "44444444-4444-4444-a444-444444444444", playbookId: "pb-legacy" });
  const issue = seedIssue(dev.id);
  createWorkerSession({ issueId: issue.id, role: "developer", round: 1, agentId: dev.id, runtime: "claude_code" }); // no profileSnapshotJson

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

test("skips when the deck is offline, and records why — never mints an authority", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo", deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps: ReflectDeps = {
    checkHealth: async () => false,
    mintAuthority: async () => {
      throw new Error("should not be called");
    },
    revokeAuthority: async () => {
      throw new Error("should not be called");
    },
    callTool: (async () => {
      throw new Error("should not be called");
    }) as ReflectDeps["callTool"],
  };
  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "skipped");
  const artifacts = listArtifactsForIssue(issue.id);
  assert.ok(artifacts.some((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).reason === "Agent Deck offline"));
});

test("posts one patch per playbook, using the implementation conclusion and review history as rationale, and always revokes the minted authority", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1", "pb-2"] });
  createIssueArtifact({ issueId: issue.id, kind: "implementation_conclusion", author: "agent", content: { text: "Implemented the widget using the shared component." } });
  appendWorkflowEvent({ issueId: issue.id, type: "review.submitted", actorType: "reviewer", stage: "reviewing", payload: { verdict: "changes_requested" } });
  appendWorkflowEvent({ issueId: issue.id, type: "review.submitted", actorType: "reviewer", stage: "reviewing", payload: { verdict: "approved" } });

  const proposed: string[] = [];
  const revoked: string[] = [];
  const deps: ReflectDeps = {
    ...makeDeps({
      proposePatch: (playbookId, rationale) => {
        proposed.push(playbookId);
        assert.match(rationale, /2 review round\(s\)/);
        assert.match(rationale, /changes_requested → approved/);
        assert.match(rationale, /Implemented the widget using the shared component\./);
        return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
      },
    }),
    revokeAuthority: async (authorityId) => {
      revoked.push(authorityId);
    },
  };

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered");
  assert.deepStrictEqual(proposed.sort(), ["pb-1", "pb-2"]);
  assert.deepStrictEqual(revoked, [MINT_OK.authority.authorityId]);

  const artifacts = listArtifactsForIssue(issue.id);
  assert.equal(artifacts.filter((a) => a.kind === "playbook_patch").length, 2);
  const status = artifacts.find((a) => a.kind === "reflect_status");
  assert.equal(JSON.parse(status!.contentJson!).status, "completed");
});

test("a failed patch proposal for one playbook is recorded, not thrown, and does not block the others", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-ok", "pb-fail"] });
  const deps = makeDeps({
    proposePatch: (playbookId) => {
      if (playbookId === "pb-fail") return { ok: false, kind: "infra_failure", reason: "deck rejected the patch" };
      return { ok: true, data: { id: "patch-ok", playbookId } };
    },
  });

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "triggered"); // at least one playbook succeeded
  const artifacts = listArtifactsForIssue(issue.id);
  assert.equal(artifacts.filter((a) => a.kind === "playbook_patch").length, 1);
  assert.ok(artifacts.some((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).status === "failed" && JSON.parse(a.contentJson!).error === "deck rejected the patch"));
  const summary = artifacts.find((a) => a.kind === "reflect_status" && JSON.parse(a.contentJson!).playbookCount !== undefined);
  assert.equal(JSON.parse(summary!.contentJson!).status, "partial");
});

test("never throws even if every proposal fails", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps = makeDeps({
    proposePatch: () => ({ ok: false, kind: "infra_failure", reason: "network down" }),
  });
  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "failed");
});

test("a mint-time INTERACTION_REQUIRED parks the attempt: no tool calls, one durable action, issue untouched", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps: ReflectDeps = {
    checkHealth: async () => true,
    mintAuthority: async () => ({ ok: false, code: "INTERACTION_REQUIRED", message: "Approve the coordinator enrollment.", requestId: "req_1" }),
    revokeAuthority: async () => {
      throw new Error("should not be called — nothing was minted");
    },
    callTool: (async () => {
      throw new Error("should not be called — no authority to call with");
    }) as ReflectDeps["callTool"],
  };

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "parked");

  const actions = listHumanActionsForIssue(issue.id).filter((a) => a.actionType === "reflection_interaction_required");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "open");
  assert.equal(actions[0].requestId, "req_1");
  assert.deepStrictEqual(JSON.parse(actions[0].responseOptionsJson!), [
    { choice: "retry", label: "Retry reflection" },
    { choice: "dismiss", label: "Dismiss" },
  ]);
});

test("a propose_playbook_patch INTERACTION_REQUIRED parks the attempt after a successful playbook read", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const revoked: string[] = [];
  const deps: ReflectDeps = {
    ...makeDeps({
      proposePatch: () => ({ ok: false, kind: "interaction_required", reason: "Playbook mutation needs review.", requestId: "req_2" }),
    }),
    revokeAuthority: async (id) => {
      revoked.push(id);
    },
  };

  const result = await triggerIssueReflect(issue.id, deps);
  assert.equal(result, "parked");
  // Authority is still revoked even when the attempt parks (NOT-94: "revoke authority ...
  // after every reflection attempt").
  assert.deepStrictEqual(revoked, [MINT_OK.authority.authorityId]);

  const issueAfter = (await import("../repository/issues.js")).getIssue(issue.id)!;
  assert.equal(issueAfter.status, issue.status); // reflection never touches issue status

  const actions = listHumanActionsForIssue(issue.id).filter((a) => a.actionType === "reflection_interaction_required");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].reason, "Playbook mutation needs review.");
});

// PR #21 review finding #1: a park after playbooks 1..N-1 already succeeded must not
// re-propose those on retry — that would duplicate their Notes items.
test("a retry after a mid-loop park does not re-propose a playbook that already succeeded", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-ok", "pb-park"] });

  const proposedCalls: string[] = [];
  let parkPbPark = true;
  let revokedCount = 0;
  const deps: ReflectDeps = {
    checkHealth: async () => true,
    mintAuthority: async () => MINT_OK,
    revokeAuthority: async () => {
      revokedCount += 1;
    },
    callTool: (async (opts: { toolName: string; arguments: Record<string, unknown> }) => {
      if (opts.toolName === "get_playbook") {
        return { ok: true, data: { id: opts.arguments.playbook_id, title: "pb", body: "" } };
      }
      const playbookId = opts.arguments.playbook_id as string;
      proposedCalls.push(playbookId);
      if (playbookId === "pb-park" && parkPbPark) {
        return { ok: false, kind: "interaction_required", reason: "Playbook mutation needs review.", requestId: "req_mid_park" };
      }
      return { ok: true, data: { id: `patch-${playbookId}`, playbookId } };
    }) as ReflectDeps["callTool"],
  };

  const first = await triggerIssueReflect(issue.id, deps);
  assert.equal(first, "parked");
  assert.deepStrictEqual(proposedCalls, ["pb-ok", "pb-park"]);
  assert.equal(listArtifactsForIssue(issue.id).filter((a) => a.kind === "playbook_patch").length, 1);

  const parkedAction = listHumanActionsForIssue(issue.id).find((a) => a.actionType === "reflection_interaction_required" && a.status === "open")!;
  parkPbPark = false;
  const resolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "retry", deps);
  assert.ok(resolved.ok);
  await waitFor(() => revokedCount === 2);

  // Retry skips pb-ok (already has a playbook_patch artifact) and only re-attempts pb-park.
  assert.deepStrictEqual(proposedCalls, ["pb-ok", "pb-park", "pb-park"]);
  assert.equal(listArtifactsForIssue(issue.id).filter((a) => a.kind === "playbook_patch").length, 2);
});

test("a repeated INTERACTION_REQUIRED for the same requestId dedupes onto the one open action", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps: ReflectDeps = {
    checkHealth: async () => true,
    mintAuthority: async () => ({ ok: false, code: "INTERACTION_REQUIRED", message: "Approve the coordinator enrollment.", requestId: "req_dupe" }),
    revokeAuthority: async () => {},
    callTool: (async () => {
      throw new Error("should not be called");
    }) as ReflectDeps["callTool"],
  };

  await triggerIssueReflect(issue.id, deps);
  await triggerIssueReflect(issue.id, deps);

  const actions = listHumanActionsForIssue(issue.id).filter((a) => a.actionType === "reflection_interaction_required");
  assert.equal(actions.length, 1);
});

test("acceptance: final-review completion → authorized playbook read → control-plane response → parked action → retry with a new attempt", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });

  const mintedAttemptIds: string[] = [];
  let revokedCount = 0;
  let proposeShouldPark = true;
  const deps: ReflectDeps = {
    checkHealth: async () => true,
    mintAuthority: async (input) => {
      mintedAttemptIds.push(input.attemptId);
      return MINT_OK;
    },
    // revokeAuthority runs in triggerIssueReflect's `finally`, after every artifact for the
    // attempt has already been written — waiting for it (rather than mintedAttemptIds
    // alone) guarantees the whole fire-and-forget retry attempt has settled.
    revokeAuthority: async () => {
      revokedCount += 1;
    },
    callTool: (async (opts: { toolName: string; arguments: Record<string, unknown> }) => {
      if (opts.toolName === "get_playbook") {
        return { ok: true, data: { id: opts.arguments.playbook_id, title: "pb", body: "" } };
      }
      if (proposeShouldPark) {
        return { ok: false, kind: "interaction_required", reason: "Playbook mutation needs review.", requestId: "req_retry" };
      }
      return { ok: true, data: { id: "patch-ok", playbookId: opts.arguments.playbook_id } };
    }) as ReflectDeps["callTool"],
  };

  // final_review:complete → reflect fires → authorized read succeeds → propose parks.
  const first = await triggerIssueReflect(issue.id, deps);
  assert.equal(first, "parked");
  assert.equal(mintedAttemptIds.length, 1);

  const parkedAction = listHumanActionsForIssue(issue.id).find((a) => a.actionType === "reflection_interaction_required" && a.status === "open")!;
  assert.ok(parkedAction);

  // The issue itself is untouched by the park.
  const { getIssue } = await import("../repository/issues.js");
  const issueAfterPark = getIssue(issue.id)!;
  assert.equal(issueAfterPark.status, issue.status);

  // Retry: a brand new correlated attempt with a new mint, this time Deck allows the patch.
  proposeShouldPark = false;
  const resolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "retry", deps);
  assert.ok(resolved.ok);
  await waitFor(() => revokedCount === 2); // triggerIssueReflect runs fire-and-forget

  assert.equal(mintedAttemptIds.length, 2);
  assert.notEqual(mintedAttemptIds[0], mintedAttemptIds[1]);

  const actionsAfterRetry = listHumanActionsForIssue(issue.id);
  const originalAction = actionsAfterRetry.find((a) => a.id === parkedAction.id)!;
  assert.equal(originalAction.status, "resolved");

  const artifacts = listArtifactsForIssue(issue.id);
  assert.ok(artifacts.some((a) => a.kind === "playbook_patch"));
});

test("resolveReflectionInteractionAction: dismiss resolves the action and never calls Deck again", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps: ReflectDeps = {
    checkHealth: async () => true,
    mintAuthority: async () => ({ ok: false, code: "INTERACTION_REQUIRED", message: "Approve.", requestId: "req_dismiss" }),
    revokeAuthority: async () => {},
    callTool: (async () => {
      throw new Error("should not be called");
    }) as ReflectDeps["callTool"],
  };
  await triggerIssueReflect(issue.id, deps);
  const parkedAction = listHumanActionsForIssue(issue.id).find((a) => a.actionType === "reflection_interaction_required" && a.status === "open")!;

  const resolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "dismiss");
  assert.ok(resolved.ok);

  const after = listHumanActionsForIssue(issue.id).find((a) => a.id === parkedAction.id)!;
  assert.equal(after.status, "resolved");
  assert.deepStrictEqual(JSON.parse(after.resolutionJson!), { choice: "dismiss" });
});

test("resolveReflectionInteractionAction rejects an unknown choice and an already-resolved action", async () => {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: "/repo" });
  const issue = seedIssue(dev.id);
  seedFinalDeveloperSession(issue.id, dev, { deckId: "11111111-1111-4111-a111-111111111111", playbookIds: ["pb-1"] });
  const deps: ReflectDeps = {
    checkHealth: async () => true,
    mintAuthority: async () => ({ ok: false, code: "INTERACTION_REQUIRED", message: "Approve.", requestId: "req_bad_choice" }),
    revokeAuthority: async () => {},
    callTool: (async () => {
      throw new Error("should not be called");
    }) as ReflectDeps["callTool"],
  };
  await triggerIssueReflect(issue.id, deps);
  const parkedAction = listHumanActionsForIssue(issue.id).find((a) => a.actionType === "reflection_interaction_required" && a.status === "open")!;

  const badChoice = resolveReflectionInteractionAction(parkedAction.id, "operator", "close");
  assert.equal(badChoice.ok, false);

  const dismissed = resolveReflectionInteractionAction(parkedAction.id, "operator", "dismiss");
  assert.ok(dismissed.ok);

  const alreadyResolved = resolveReflectionInteractionAction(parkedAction.id, "operator", "retry");
  assert.equal(alreadyResolved.ok, false);
});
