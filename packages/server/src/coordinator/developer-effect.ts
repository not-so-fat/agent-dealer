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
import { guidanceForNextSession } from "./guidance.js";
import { realDeveloperSpawn, type DeveloperSpawn } from "./spawn.js";
import {
  createRoleWorktree,
  safeRemoveWorktree,
  isWorktreeClean,
  commitsAhead,
  pushBranch,
  mergeBase,
  branchExists,
  revParseHead,
  fetchRef,
} from "../adapters/git-worktree.js";
import { bindAndVerify, type DeckToolCaller } from "../adapters/agent-deck-bind.js";
import { realGithubAdapter, pollPrChecks, type GithubAdapter, type PrView } from "../adapters/github.js";
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

/**
 * The ticket requires verifying "draft PR identity, base SHA, and current head SHA" —
 * not just accepting whatever `gh pr view` returns. A review round found the original
 * code took `prView` on faith: wrong base, a non-draft PR, a PR number that silently
 * changed between rounds, or a stale `headRefOid` would all have been accepted as a
 * clean handoff. `localHead` is this process's own `git rev-parse HEAD` right after the
 * push it just performed — the actual ground truth `gh`'s view is checked against.
 */
async function validatePrIdentity(
  prView: PrView,
  opts: { branchName: string; baseBranch: string; priorPrNumber: number | null; localHead: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!prView.isDraft) {
    return { ok: false, reason: `PR #${prView.number} is not a draft PR` };
  }
  if (prView.headRefName !== opts.branchName) {
    return { ok: false, reason: `PR head branch ${prView.headRefName} does not match the issue branch ${opts.branchName}` };
  }
  if (prView.baseRefName !== opts.baseBranch) {
    return { ok: false, reason: `PR base ${prView.baseRefName} does not match the issue base branch ${opts.baseBranch}` };
  }
  if (opts.priorPrNumber != null && opts.priorPrNumber !== prView.number) {
    return { ok: false, reason: `PR number changed from #${opts.priorPrNumber} to #${prView.number}` };
  }
  if (prView.headRefOid !== opts.localHead) {
    return { ok: false, reason: `gh reports head ${prView.headRefOid}, but the locally pushed HEAD is ${opts.localHead}` };
  }
  return { ok: true };
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

  // issue.branch is only ever written on a verified clean_handoff (design: it's ground
  // truth, not agent self-report), so a first-round attempt after an earlier retryable
  // failure in the SAME round (no_pr/session_failed/timed_out/checks_failed all remove
  // their worktree but leave the local branch ref behind) would otherwise re-run
  // `git worktree add -b <same name>` and fail with "branch already exists" — a review
  // round reproduced this directly. Check the branch itself, not just issue.branch, and
  // reuse it (preserving whatever local commits it already carries) when it's there.
  const branchName = issue.branch ?? `issue-${issue.id}`;
  const reuseBranch = issue.branch != null || (await branchExists(issue.repo, branchName));

  let worktreePath: string;
  try {
    const worktree = await createRoleWorktree({
      repo: issue.repo,
      role: "developer",
      sessionId,
      ref: reuseBranch ? branchName : issue.baseBranch,
      newBranch: reuseBranch ? undefined : branchName,
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

    let payload: { retryReason?: string | null } = {};
    try {
      if (workItem.payloadJson) payload = JSON.parse(workItem.payloadJson);
    } catch {
      payload = {};
    }

    const openFindings = listFindingsForIssue(issue.id).filter(
      (f) => f.status === "open" || f.status === "recurring"
    );
    const guidance = guidanceForNextSession(issue.id, sessionId);
    const prompt = buildDeveloperPrompt({
      taskSnapshot,
      round: workItem.round,
      findings: openFindings.length ? openFindings : undefined,
      retryReason: payload.retryReason ?? undefined,
      worktreePath,
      deckId: snapshot?.deckId ?? null,
      playbookIds: snapshot?.playbookIds,
      guidance: guidance.length ? guidance : undefined,
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

    if (spawned.timedOut || spawned.exitCode !== 0) {
      // A crash/timeout must not be routed as a blind retry without checking the
      // worktree first: a review round found that when the agent left it dirty, the
      // preserved checkout kept the branch checked out, so the *next* round's retry
      // could never `git worktree add` that same branch — it burned a round and then
      // failed as a confusing adapter_failure two rounds later. dirty_worktree (which
      // preserves the checkout and escalates without consuming a round) must win here,
      // exactly as it does when the agent exits 0 but leaves the worktree dirty below.
      const clean = await isWorktreeClean(worktreePath).catch(() => false);
      if (!clean) return { kind: "dirty_worktree" };
      await bestEffortRemove(issue.repo, worktreePath);
      return spawned.timedOut ? { kind: "timed_out" } : { kind: "session_failed" };
    }

    // Persisted as soon as the session itself completes — a review round found these
    // dropped on any later verification failure (checks failing, a gh error), even though
    // NOT-61 requires the conclusion/raw trace to stay available through the evidence API
    // regardless of how the handoff subsequently resolves.
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
    // From here on the branch is safely on the remote — a worktree removal on any
    // subsequent failure path loses nothing (bestEffortRemove is safe to call).

    let prView = await deps.github.viewPr({ cwd: worktreePath });
    if (!prView) {
      const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-pr-body-"));
      const bodyFilePath = path.join(bodyDir, "body.md");
      fs.writeFileSync(bodyFilePath, extractConclusion(spawned.transcript) || taskSnapshot.description);
      const created = await deps.github.createDraftPr({
        cwd: worktreePath,
        base: issue.baseBranch,
        title: taskSnapshot.title,
        bodyFilePath,
      });
      fs.rmSync(bodyDir, { recursive: true, force: true });
      if (!created.ok) {
        await bestEffortRemove(issue.repo, worktreePath);
        return created.noCommits
          ? { kind: "no_pr" }
          : { kind: "adapter_failure", reason: created.reason };
      }
      prView = await deps.github.viewPr({ cwd: worktreePath });
      if (!prView) {
        await bestEffortRemove(issue.repo, worktreePath);
        return { kind: "adapter_failure", reason: "PR created but could not be re-verified via gh pr view" };
      }
    }

    const localHead = await revParseHead(worktreePath);
    const identityOpts = { branchName, baseBranch: issue.baseBranch, priorPrNumber: issue.prNumber, localHead };
    const identity = await validatePrIdentity(prView, identityOpts);
    if (!identity.ok) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "adapter_failure", reason: identity.reason };
    }

    const checks = await pollPrChecks(deps.github, {
      cwd: worktreePath,
      timeoutMs: developerEffectConfig.checksPollTimeoutMs,
      intervalMs: developerEffectConfig.checksPollIntervalMs,
      signal: ctx.signal,
    });

    // The poll can run for up to checksPollTimeoutMs (default 10 minutes) — re-fetch and
    // re-validate identity against the SAME localHead before trusting either the checks
    // or the SHA about to be handed to the reviewer. A review round found the original
    // code reused the pre-poll `prView` unconditionally: if the branch moved while this
    // process was waiting (another push, a zombie retry from a reclaimed lease), the
    // checks queried could describe a different commit than the one about to be recorded
    // as the verified handoff, breaking the exact-current-SHA contract.
    const postPollView = await deps.github.viewPr({ cwd: worktreePath });
    if (!postPollView) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "adapter_failure", reason: "PR could not be re-verified after the checks poll" };
    }
    const postPollIdentity = await validatePrIdentity(postPollView, identityOpts);
    if (!postPollIdentity.ok) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "adapter_failure", reason: `PR changed while waiting on checks: ${postPollIdentity.reason}` };
    }
    prView = postPollView;

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

    // Resolve the base SHA against the *fetched* base ref (design §"Verify handoff"), not
    // whatever the local branch happened to point to before this session ran — a review
    // round found a stale local base could record the wrong merge-base if origin's base
    // branch had moved.
    await fetchRef(worktreePath, prView.baseRefName);
    const baseSha = await mergeBase({ repo: worktreePath, base: `origin/${prView.baseRefName}`, head: prView.headRefOid });

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
