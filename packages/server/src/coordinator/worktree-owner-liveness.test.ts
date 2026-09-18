// packages/server/src/coordinator/worktree-owner-liveness.test.ts
//
// NOT-127: session + pid lookup that feeds resolveDeveloperWorktree's ownerLiveness hook.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-wt-owner-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const {
  createWorkerSession,
  startSession,
  completeSession,
  recordSessionProcess,
  patchRunningSession} = await import("../repository/worker-sessions.js");
const { COORDINATOR_PROCESS_OWNER, readProcessStartTime } = await import("./process-liveness.js");
const { checkDeveloperWorktreeOwnerLiveness, findWorkerSessionOwningWorktree } = await import(
  "./worktree-owner-liveness.js"
);

let issueId: string;

before(() => {
  migrate();
  issueId = createIssue({
    title: "owner-liveness host",
    repo: "acme/app",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual"}).id;
});

beforeEach(() => {
  getDb().exec("DELETE FROM worker_sessions");
});

function spawnLiveChild(): { pid: number; kill: () => void; startTime: string } {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const startTime = readProcessStartTime(child.pid!) ?? "unknown";
  return {
    pid: child.pid!,
    startTime,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }};
}

test("findWorkerSessionOwningWorktree resolves the session id encoded in the path basename", () => {
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code"});
  startSession(session.id);
  const wt = `/repo/.agent-dealer-worktrees/${session.id}-developer`;
  patchRunningSession(session.id, { worktreePath: wt });
  assert.equal(findWorkerSessionOwningWorktree(wt)?.id, session.id);
});

test("checkDeveloperWorktreeOwnerLiveness: running session with live pid is alive", () => {
  const child = spawnLiveChild();
  try {
    const session = createWorkerSession({
      issueId,
      role: "developer",
      round: 1,
      agentId: BUILTIN_AGENT_CLAUDE_ID,
      runtime: "claude_code"});
    startSession(session.id);
    const wt = `/repo/.agent-dealer-worktrees/${session.id}-developer`;
    patchRunningSession(session.id, { worktreePath: wt });
    recordSessionProcess(session.id, child.pid, COORDINATOR_PROCESS_OWNER, child.startTime);

    assert.deepEqual(checkDeveloperWorktreeOwnerLiveness(wt), {
      state: "alive",
      sessionId: session.id});
  } finally {
    child.kill();
  }
});

test("checkDeveloperWorktreeOwnerLiveness: terminal session whose pid is still alive is alive (NOT-127)", () => {
  const child = spawnLiveChild();
  try {
    const session = createWorkerSession({
      issueId,
      role: "developer",
      round: 1,
      agentId: BUILTIN_AGENT_CLAUDE_ID,
      runtime: "claude_code"});
    startSession(session.id);
    const wt = `/repo/.agent-dealer-worktrees/${session.id}-developer`;
    patchRunningSession(session.id, { worktreePath: wt });
    recordSessionProcess(session.id, child.pid, COORDINATOR_PROCESS_OWNER, child.startTime);
    // Recovery wrongly marked it failed while the CLI kept running.
    completeSession(session.id, {
      status: "failed",
      errorJson: JSON.stringify({ reason: "recovered — worker process presumed dead" })});

    assert.deepEqual(checkDeveloperWorktreeOwnerLiveness(wt), {
      state: "alive",
      sessionId: session.id});
  } finally {
    child.kill();
  }
});

test("checkDeveloperWorktreeOwnerLiveness: terminal session with a dead pid is dead", async () => {
  const child = spawnLiveChild();
  const { pid, startTime } = child;
  child.kill();
  // Wait until the OS reaps it so kill(pid, 0) fails.
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 20));
    } catch {
      break;
    }
  }

  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code"});
  startSession(session.id);
  const wt = `/repo/.agent-dealer-worktrees/${session.id}-developer`;
  patchRunningSession(session.id, { worktreePath: wt });
  recordSessionProcess(session.id, pid, COORDINATOR_PROCESS_OWNER, startTime);
  completeSession(session.id, { status: "failed", errorJson: JSON.stringify({ reason: "gone" }) });

  assert.deepEqual(checkDeveloperWorktreeOwnerLiveness(wt), { state: "dead" });
});

test("checkDeveloperWorktreeOwnerLiveness: unknown path with no session is dead", () => {
  assert.deepEqual(
    checkDeveloperWorktreeOwnerLiveness("/repo/.agent-dealer-worktrees/no-such-session-developer"),
    { state: "dead" }
  );
});

test("checkDeveloperWorktreeOwnerLiveness: running session with no pid yet still owns the worktree", () => {
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: BUILTIN_AGENT_CLAUDE_ID,
    runtime: "claude_code"});
  startSession(session.id);
  const wt = `/repo/.agent-dealer-worktrees/${session.id}-developer`;
  patchRunningSession(session.id, { worktreePath: wt });
  // No recordSessionProcess yet — worktree.ready before spawn.
  assert.deepEqual(checkDeveloperWorktreeOwnerLiveness(wt), {
    state: "alive",
    sessionId: session.id});
});

test("checkDeveloperWorktreeOwnerLiveness: after clean reuse, live successor on predecessor's path basename is still detected (Lens stale-basename-owner)", () => {
  const child = spawnLiveChild();
  try {
    const predecessor = createWorkerSession({
      issueId,
      role: "developer",
      round: 1,
      agentId: BUILTIN_AGENT_CLAUDE_ID,
      runtime: "claude_code"});
    startSession(predecessor.id);
    const wt = `/repo/.agent-dealer-worktrees/${predecessor.id}-developer`;
    patchRunningSession(predecessor.id, { worktreePath: wt });
    completeSession(predecessor.id, {
      status: "failed",
      errorJson: JSON.stringify({ reason: "presumed dead" })});

    // Successor reused the leftover path in place — directory still named for predecessor.
    const successor = createWorkerSession({
      issueId,
      role: "developer",
      round: 1,
      agentId: BUILTIN_AGENT_CLAUDE_ID,
      runtime: "claude_code"});
    startSession(successor.id);
    patchRunningSession(successor.id, { worktreePath: wt });
    recordSessionProcess(successor.id, child.pid, COORDINATOR_PROCESS_OWNER, child.startTime);

    const verdict = checkDeveloperWorktreeOwnerLiveness(wt);
    assert.equal(verdict.state, "alive");
    if (verdict.state === "alive") {
      assert.equal(verdict.sessionId, successor.id, "must prefer the live successor over the dead basename predecessor");
    }
  } finally {
    child.kill();
  }
});
