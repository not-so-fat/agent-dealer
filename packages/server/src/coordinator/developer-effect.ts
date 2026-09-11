// packages/server/src/coordinator/developer-effect.ts
//
// The real developer effect handler (NOT-61): worktree → deck bind → spawn → verify
// (clean worktree, pushed branch, draft PR identity, base/head SHA, CI checks) → evidence
// artifacts → DeveloperOutcome. Registered via `registerEffectHandler("developer", ...)`.
//
// The developer worker never pushes or opens the PR itself — its prompt (prompts.ts)
// explicitly tells it not to. The coordinator does both, from this process, only after the
// worker's session has already ended, closing the enforcement gap NOT-60's review left
// open (see profile-snapshot.ts's `PermissionPolicy` doc comment: a credentialed push/PR
// effect can only be a real boundary from outside the worker's own process).
//
// Deps are an injectable seam so tests exercise real git/verification logic against a
// temp repo while faking the two pieces that would otherwise cost money or need network:
// the agent session itself (`spawn`) and GitHub (`github`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProfileSnapshot, roleCeiling } from "@agent-dealer/shared";
import type { EffectContext } from "./effect-registry.js";
import type { DeveloperOutcome } from "./routing.js";
import { getTaskSnapshot } from "./commands.js";
import { buildDeveloperPrompt } from "./prompts.js";
import { realDeveloperSpawn, type DeveloperSpawn } from "./spawn.js";
import {
  createRoleWorktree,
  safeRemoveWorktree,
  isWorktreeClean,
  commitsAhead,
  pushBranch,
  mergeBase,
} from "../adapters/git-worktree.js";
import { bindAndVerify, type DeckToolCaller } from "../adapters/agent-deck-bind.js";
import { realGithubAdapter, pollPrChecks, type GithubAdapter } from "../adapters/github.js";
import { getWorkerSession } from "../repository/worker-sessions.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { createIssueArtifact } from "../repository/artifacts.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export const developerEffectConfig = {
  get sessionTimeoutMs(): number {
    return num("DEVELOPER_TIMEOUT_MS", 60 * 60_000);
  },
  get checksPollTimeoutMs(): number {
    return num("CHECKS_POLL_TIMEOUT_MS", 10 * 60_000);
  },
  get checksPollIntervalMs(): number {
    return num("CHECKS_POLL_INTERVAL_MS", 15_000);
  },
};

export interface DeveloperEffectDeps {
  spawn: DeveloperSpawn;
  github: GithubAdapter;
  deckCallTool?: DeckToolCaller;
}

const defaultDeps: DeveloperEffectDeps = { spawn: realDeveloperSpawn, github: realGithubAdapter };

/** Best-effort: the worker's session has already ended and the checkout is known-clean-and-pushed. */
async function bestEffortRemove(repo: string, worktreePath: string): Promise<void> {
  try {
    await safeRemoveWorktree({ repo, path: worktreePath, role: "developer", branchPushed: true });
  } catch {
    // leave it for crash-recovery inspection — cleanup is a courtesy, not part of the contract
  }
}

/** Last non-empty chunk of the transcript, per the prompt's "end with a conclusion" instruction. */
function extractConclusion(transcript: string): string {
  const trimmed = transcript.trim();
  if (!trimmed) return "";
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
}

export async function runDeveloperEffect(
  ctx: EffectContext,
  deps: DeveloperEffectDeps = defaultDeps
): Promise<DeveloperOutcome> {
  const { issue, workItem } = ctx;
  const sessionId = workItem.workerSessionId;
  if (!sessionId) return { kind: "session_failed" };

  const session = getWorkerSession(sessionId);
  const snapshot = parseProfileSnapshot(session?.profileSnapshotJson);
  const taskSnapshot = getTaskSnapshot(issue);
  const runtime = snapshot?.runtime ?? "claude_code";

  const isRepair = Boolean(issue.branch);
  const newBranchName = isRepair ? undefined : `issue-${issue.id}`;
  const branchName = issue.branch ?? newBranchName!;

  let worktreePath: string;
  try {
    const worktree = await createRoleWorktree({
      repo: issue.repo,
      role: "developer",
      sessionId,
      ref: isRepair ? issue.branch! : issue.baseBranch,
      newBranch: newBranchName,
    });
    worktreePath = worktree.path;
  } catch (err) {
    return { kind: "adapter_failure", reason: `worktree setup failed: ${String(err)}` };
  }

  try {
    if (snapshot?.deckId) {
      const bind = await bindAndVerify({
        deckId: snapshot.deckId,
        worktreePath,
        callTool: deps.deckCallTool,
      });
      if (!bind.ok) {
        await bestEffortRemove(issue.repo, worktreePath);
        return { kind: "adapter_failure", reason: `deck bind failed: ${bind.reason}` };
      }
    }

    const openFindings = listFindingsForIssue(issue.id).filter(
      (f) => f.status === "open" || f.status === "recurring"
    );
    const prompt = buildDeveloperPrompt({
      taskSnapshot,
      round: workItem.round,
      findings: openFindings.length ? openFindings : undefined,
      worktreePath,
      deckId: snapshot?.deckId ?? null,
      playbookIds: snapshot?.playbookIds,
    });

    const spawned = await deps.spawn({
      sessionId,
      runtime,
      policy: snapshot?.permissionPolicy ?? roleCeiling("developer"),
      model: snapshot?.model ?? null,
      prompt,
      cwd: worktreePath,
      timeoutMs: developerEffectConfig.sessionTimeoutMs,
    });

    if (spawned.timedOut) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "timed_out" };
    }
    if (spawned.exitCode !== 0) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "session_failed" };
    }

    if (!(await isWorktreeClean(worktreePath))) {
      return { kind: "dirty_worktree" };
    }

    const ahead = await commitsAhead({ worktreePath, baseRef: `origin/${issue.baseBranch}` });
    if (ahead === 0) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "no_pr" };
    }

    const pushed = await pushBranch({ worktreePath, branch: branchName });
    if (!pushed.ok) {
      // Local commits preserved either way — never discarded, never force-retried.
      return pushed.rejected
        ? { kind: "unpushed_commit", reason: pushed.reason }
        : { kind: "adapter_failure", reason: pushed.reason };
    }

    let prView = await deps.github.viewPr({ cwd: worktreePath });
    if (!prView) {
      const bodyFilePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-pr-body-")), "body.md");
      fs.writeFileSync(bodyFilePath, extractConclusion(spawned.transcript) || taskSnapshot.description);
      const created = await deps.github.createDraftPr({
        cwd: worktreePath,
        base: issue.baseBranch,
        title: taskSnapshot.title,
        bodyFilePath,
      });
      fs.rmSync(path.dirname(bodyFilePath), { recursive: true, force: true });
      if (!created.ok) {
        return created.noCommits
          ? { kind: "no_pr" }
          : { kind: "adapter_failure", reason: created.reason };
      }
      prView = await deps.github.viewPr({ cwd: worktreePath });
      if (!prView) {
        return { kind: "adapter_failure", reason: "PR created but could not be re-verified via gh pr view" };
      }
    }

    const baseSha = await mergeBase({ repo: worktreePath, base: prView.baseRefName, head: prView.headRefOid });

    const checks = await pollPrChecks(deps.github, {
      cwd: worktreePath,
      timeoutMs: developerEffectConfig.checksPollTimeoutMs,
      intervalMs: developerEffectConfig.checksPollIntervalMs,
      signal: ctx.signal,
    });
    createIssueArtifact({
      issueId: issue.id,
      workerSessionId: sessionId,
      kind: "checks_evidence",
      author: "system",
      content: { snapshot: checks, prNumber: prView.number, headSha: prView.headRefOid },
    });
    if (checks === "failure") {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "checks_failed" };
    }
    if (checks === "timeout") {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "timed_out" };
    }

    createIssueArtifact({
      issueId: issue.id,
      workerSessionId: sessionId,
      kind: "implementation_conclusion",
      author: "agent",
      content: { text: extractConclusion(spawned.transcript) },
    });
    createIssueArtifact({
      issueId: issue.id,
      workerSessionId: sessionId,
      kind: "developer_transcript",
      author: "system",
      blobPath: spawned.logPath,
    });

    await bestEffortRemove(issue.repo, worktreePath);
    return {
      kind: "clean_handoff",
      branch: branchName,
      headSha: prView.headRefOid,
      baseSha,
      prNumber: prView.number,
      prUrl: prView.url,
    };
  } catch (err) {
    return { kind: "adapter_failure", reason: String(err) };
  }
}
