// packages/server/src/coordinator/session-lifecycle.integration.test.ts
//
// The rest of this package's coordinator tests use fakeDeps() for the git-worktree
// boundary (see session-lifecycle.test.ts, dispatcher.test.ts) — good for the DI seam,
// but never proves the real adapter (packages/server/src/adapters/git-worktree.ts)
// actually round-trips with the coordinator. This file exercises the REAL worktree
// adapter (addWorktree/removeWorktree/isWorktreeClean/mergeBase) against a real temp
// git repo. github + spawn stay faked: they need network / a real CLI the test
// environment may not have.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-lifecycle-integration-"));

const { migrate } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listOpenHumanActions } = await import("../repository/human-actions.js");
const { startIssueWorkflow, advanceIssue } = await import("./session-lifecycle.js");
const worktreeAdapter = await import("../adapters/git-worktree.js");

before(() => {
  migrate();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-integration-repo-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function seedIssue(repo: string) {
  return createIssue({
    title: "Integration issue",
    description: "test issue",
    acceptanceCriteria: "works",
    repo,
    baseBranch: "main",
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    maxReviewRounds: 3,
    source: "manual",
  });
}

test("a real git worktree carries a developer commit through to review under the real adapter", async () => {
  const repo = await initRepo();
  const issue = seedIssue(repo);
  const branch = `issue-${issue.id}`;

  // Filled in once the fake "developer" has actually committed inside the real worktree.
  let developerHeadSha = "";

  const deps = {
    worktree: {
      addWorktree: worktreeAdapter.addWorktree,
      removeWorktree: worktreeAdapter.removeWorktree,
      isWorktreeClean: worktreeAdapter.isWorktreeClean,
      mergeBase: worktreeAdapter.mergeBase,
    },
    github: {
      viewPr: async () => ({
        number: 1,
        url: "https://github.com/x/y/pull/1",
        headRefOid: developerHeadSha,
        baseRefName: "main",
        headRefName: branch,
        reviews: [],
      }),
      publishReview: async () => ({ ok: true as const, event: "APPROVE" as const }),
    },
    spawnDeveloper: async (session: { worktreePath: string | null }) => {
      const worktreePath = session.worktreePath!;
      // Prove this is a REAL git worktree: write a file and commit, on disk.
      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "real work\n");
      await git(worktreePath, ["add", "feature.txt"]);
      await git(worktreePath, ["commit", "-m", "add feature"]);
      developerHeadSha = await git(worktreePath, ["rev-parse", "HEAD"]);
      return { exitCode: 0, transcript: "done", logPath: "/tmp/log" };
    },
    spawnReviewer: async () => ({
      exitCode: 0,
      transcript:
        "```json\n" +
        JSON.stringify({
          verdict: "approved",
          baseSha: (await git(repo, ["rev-parse", "HEAD"])),
          headSha: developerHeadSha,
          acceptanceCriteriaAssessment: "met",
          evidenceAssessment: "ok",
          findings: [],
          risks: [],
        }) +
        "\n```",
      logPath: "/tmp/log",
    }),
  };

  await startIssueWorkflow(issue.id, deps);
  await advanceIssue(issue.id, deps); // developer: real worktree add -> real commit -> real merge-base

  const afterDev = listWorkerSessionsForIssue(issue.id);
  assert.equal(afterDev.length, 2);
  assert.equal(afterDev[0].status, "done");
  assert.equal(afterDev[1].role, "reviewer");
  assert.equal(afterDev[1].inputSha, developerHeadSha);
  assert.ok(developerHeadSha, "developer session must have produced a real commit sha");

  const afterDevIssue = getIssue(issue.id);
  assert.equal(afterDevIssue?.status, "reviewing");
  assert.equal(afterDevIssue?.headSha, developerHeadSha);

  // The developer's worktree must have been cleaned up by the real adapter, but the
  // branch it created must survive in the bare repo for the reviewer worktree to check out.
  const branches = await git(repo, ["branch", "--list", branch]);
  assert.ok(branches.includes(branch));

  await advanceIssue(issue.id, deps); // reviewer: real detached worktree checkout at the developer's real commit

  const afterReview = listWorkerSessionsForIssue(issue.id);
  assert.equal(afterReview.length, 2);
  assert.equal(afterReview[1].status, "done");
  assert.equal(getIssue(issue.id)?.status, "final_review");
  assert.ok(listOpenHumanActions().some((a) => a.issueId === issue.id && a.actionType === "final_review"));

  fs.rmSync(repo, { recursive: true, force: true });
});
