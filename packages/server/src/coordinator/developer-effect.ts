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
import { realDeveloperSpawn, developerSessionLogPath, type DeveloperSpawn } from "./spawn.js";
import {
  resolveDeveloperWorktree,
  safeRemoveWorktree,
  isWorktreeClean,
  commitsAhead,
  pushBranch,
  mergeBase,
  branchExists,
  pushBranchRef,
  revParseHead,
  revParseRef,
  fetchRef,
  salvageDirtyWorktree,
  dirtyWorktreeRecoveryCommands,
  withRepoLock,
} from "../adapters/git-worktree.js";
import {
  ensureIssueRepoCheckout,
  roleWorktreePathForResolution,
  resolveCheckoutBaseBranch,
} from "../adapters/managed-repo.js";
import { baseRefCandidates, inspectBranchProgress } from "./branch-progress.js";
import { prepareWorkerDeckConnection, releaseWorkerDeckConnection, type DeckToolCaller } from "../adapters/agent-deck-bind.js";
import { realGithubAdapter, pollPrChecks, type GithubAdapter, type PrView } from "../adapters/github.js";
import { getWorkerSession, patchRunningSession, recordSessionProcess } from "../repository/worker-sessions.js";
import { COORDINATOR_PROCESS_OWNER, readProcessStartTime } from "./process-liveness.js";
import { checkDeveloperWorktreeOwnerLiveness } from "./worktree-owner-liveness.js";
import { developerSessionTimeoutMs } from "./session-timeouts.js";
import { getWorkItem } from "../repository/work-items.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { recordUsageEvent } from "../repository/usage-events.js";
import { extractSpawnUsage } from "./usage.js";
import { syncIssueBaseBranch } from "./sync-issue-base-branch.js";
import { recordUsageCapFromLog } from "../runners/usage-cap.js";
import { reasonForDirtyWorktree, reasonForSessionCrash } from "./failure-reason.js";
import {
  emitSessionMilestone,
  setLiveIntent,
  shortWorktreePath,
  startActivitySampler,
  taskBriefIsComplete,
} from "./session-progress.js";
import {
  VERIFICATION_RECEIPT_KIND,
  extractVerificationReceiptFromLog,
  parseVerificationReceipt,
  receiptForCurrentHead,
  receiptSupersededByFailedChecks,
  shouldCarryVerificationReceipt,
  type VerificationReceipt,
} from "./verification-receipt.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export const developerEffectConfig = {
  get sessionTimeoutMs(): number {
    return developerSessionTimeoutMs();
  },
  get checksPollTimeoutMs(): number {
    return num("CHECKS_POLL_TIMEOUT_MS", 10 * 60_000);
  },
  get checksPollIntervalMs(): number {
    return num("CHECKS_POLL_INTERVAL_MS", 15_000);
  },
  /** NOT-110: bounded window to let a lagging `gh pr view` catch up to a just-pushed HEAD. */
  get headReconcileTimeoutMs(): number {
    return num("HEAD_RECONCILE_TIMEOUT_MS", 30_000);
  },
  get headReconcileIntervalMs(): number {
    return num("HEAD_RECONCILE_INTERVAL_MS", 3_000);
  },
};

export interface DeveloperEffectDeps {
  spawn: DeveloperSpawn;
  github: GithubAdapter;
  /** Test-only seam: fake `get_bound_deck` so a deckId-bearing profile can exercise the
   * real deck-connection path without a reachable Agent Deck. */
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

/** NOT-130: mine + persist a SHA-scoped suite receipt while the worktree still exists.
 * Tip-tree equivalence: only vouch for HEAD when the tree is clean — a green suite on a
 * dirty checkout must not be reloaded as tip evidence after a later clean/revert. */
async function persistVerificationReceiptIfAny(opts: {
  issueId: string;
  sessionId: string;
  logPath: string;
  worktreePath: string;
}): Promise<void> {
  const clean = await isWorktreeClean(opts.worktreePath).catch(() => false);
  if (!clean) return;
  const headShaHint = await revParseHead(opts.worktreePath).catch(() => null);
  const receipt = extractVerificationReceiptFromLog(opts.logPath, { headShaHint });
  if (!receipt) return;
  createIssueArtifact({
    issueId: opts.issueId,
    workerSessionId: opts.sessionId,
    kind: VERIFICATION_RECEIPT_KIND,
    author: "system",
    content: receipt,
  });
}

function loadPriorVerificationReceipt(
  issueId: string,
  currentHeadSha: string | null
): VerificationReceipt | undefined {
  const art = latestIssueArtifact(issueId, VERIFICATION_RECEIPT_KIND);
  if (!art?.contentJson) return undefined;
  try {
    const parsed = parseVerificationReceipt(JSON.parse(art.contentJson));
    const atHead = receiptForCurrentHead(parsed, currentHeadSha);
    if (!atHead) return undefined;
    const checksArt = latestIssueArtifact(issueId, "checks_evidence");
    if (checksArt?.contentJson) {
      try {
        const evidence = JSON.parse(checksArt.contentJson) as {
          snapshot?: unknown;
          headSha?: unknown;
        };
        if (receiptSupersededByFailedChecks(atHead, evidence)) return undefined;
      } catch {
        // ignore malformed checks evidence
      }
    }
    return atHead;
  } catch {
    return undefined;
  }
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

/**
 * NOT-110: right after a successful `git push`, `gh pr view`'s GraphQL-backed head can
 * briefly lag the real remote tip — the commit is already on `origin`, but the PR view
 * hasn't caught up yet. A one-shot mismatch there was indistinguishable from "the push
 * never actually happened" and got treated as an `adapter_failure` (burning an infra
 * retry) even though nothing was wrong. Poll `gh pr view` (by the already-identity-
 * validated PR number, same reason `pollPrChecks` prefers number over branch) until its
 * headRefOid catches up to `localHead`, or give up at the deadline — the caller's
 * `validatePrIdentity` then reports a real, persistent mismatch exactly as before. Both
 * `number` and `branch` are forwarded on every re-read, same selector the caller already
 * resolved `prView` with (NOT-82: never let a re-fetch regress to bare current-branch
 * inference).
 */
async function reconcilePrHead(
  github: GithubAdapter,
  opts: { cwd: string; number: number; branch: string; localHead: string; timeoutMs: number; intervalMs: number }
): Promise<PrView | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const fetch = () => github.viewPr({ cwd: opts.cwd, number: opts.number, branch: opts.branch });
  let view = await fetch();
  while (view && view.headRefOid !== opts.localHead && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.intervalMs, Math.max(deadline - Date.now(), 0))));
    view = await fetch();
  }
  return view;
}

/**
 * Infra retry that skips the agent: publish whatever the branch already carries. Uses the
 * issue repo as `gh` cwd and `origin/<branch>` as the verified head (any worktree was
 * already removed on the prior failure path).
 *
 * Two callers reach here. The post-push `adapter_failure` retry (routing.ts) arrives with
 * the branch already on origin and only the gh/PR/checks stage left to redo. A presumed-dead
 * reclaim (NOT-129) may instead arrive with commits that exist ONLY locally — the attempt
 * died between `git commit` and the coordinator's push — so this also pushes when, and only
 * when, the local branch is strictly ahead of its remote-tracking ref.
 */
async function runPublishOnlyHandoff(
  ctx: EffectContext,
  deps: DeveloperEffectDeps,
  branchName: string
): Promise<DeveloperOutcome> {
  const { issue, workItem, instance } = ctx;
  const sessionId = workItem.workerSessionId!;
  const taskSnapshot = getTaskSnapshot(issue);
  const round = workItem.round;
  const stage = issue.status;
  const checkout = await ensureIssueRepoCheckout(issue.repo);
  const cwd = checkout.repoPath;
  const baseBranch = resolveCheckoutBaseBranch(issue.baseBranch, checkout);
  syncIssueBaseBranch(issue, baseBranch);

  const milestone = (
    type: Parameters<typeof emitSessionMilestone>[0]["type"],
    intent: string,
    payload?: unknown
  ) =>
    emitSessionMilestone({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      workerSessionId: sessionId,
      role: "developer",
      stage,
      round,
      type,
      intent,
      payload,
    });

  try {
    setLiveIntent(issue.id, `Developer · retrying GitHub publish (round ${round})`);

    // Serialize fetch/push against the shared managed clone (same withRepoLock as
    // ensureIssueRepoCheckout / createRoleWorktree) so concurrent issues on one repo
    // cannot race repo-root git metadata.
    const publishGit = await withRepoLock(cwd, async (): Promise<
      | { kind: "early"; outcome: DeveloperOutcome }
      | { kind: "ok"; remoteHead: string }
    > => {
      // Only a branch strictly ahead of origin is pushed here: the post-push retry path must
      // keep touching the remote not at all, and a local ref that has somehow fallen BEHIND
      // origin (someone pushed outside the coordinator) must not be turned into a rejected
      // push and a spurious escalation — origin is the better artifact in that case.
      const progress = await inspectBranchProgress({
        repo: cwd,
        branch: branchName,
        baseRefs: baseRefCandidates(issue),
        fetch: true,
      });
      if (progress.state === "unpushed") {
        setLiveIntent(
          issue.id,
          `Developer · pushing ${progress.unpushed} recovered commit${progress.unpushed === 1 ? "" : "s"} (round ${round})`
        );
        const recovered = await pushBranchRef({ repo: cwd, branch: branchName });
        if (!recovered.ok) {
          // Same policy as a live attempt's push: a clean rejection is a human decision, a
          // tooling error is a bounded infra retry. Either way the commits stay on the branch.
          //
          // The retry must stay publish-only. A transient remote failure (DNS, a dropped
          // connection) says nothing about whether the work exists — it plainly still does, on
          // this branch — so dropping the marker here would spend the very ~40-minute agent
          // rerun this path was built to avoid, on the one failure most likely to be gone by
          // the next attempt.
          return {
            kind: "early",
            outcome: recovered.rejected
              ? {
                  kind: "unpushed_commit",
                  reason: recovered.reason,
                  recoveryCommands: recovered.facts?.recoveryCommands,
                }
              : {
                  kind: "adapter_failure",
                  reason: `push of recovered branch ${branchName} failed: ${recovered.reason}`,
                  publishable: { branch: branchName },
                },
          };
        }
        milestone(
          "branch.pushed",
          `Developer · recovered branch pushed (${progress.unpushed} commit${progress.unpushed === 1 ? "" : "s"})`,
          { branch: branchName, commitsAhead: progress.ahead, recoveredCommits: progress.unpushed }
        );
      }

      await fetchRef(cwd, branchName);
      const remoteHead = await revParseRef(cwd, `origin/${branchName}`);
      return { kind: "ok", remoteHead };
    });
    if (publishGit.kind === "early") return publishGit.outcome;
    const remoteHead = publishGit.remoteHead;

    let prView = await deps.github.viewPr({ cwd, branch: branchName });
    if (!prView) {
      setLiveIntent(issue.id, `Developer · opening draft PR (publish retry, round ${round})`);
      const prior = latestIssueArtifact(issue.id, "implementation_conclusion");
      let body = taskSnapshot.description;
      if (prior?.contentJson) {
        try {
          const parsed = JSON.parse(prior.contentJson) as { text?: string };
          if (typeof parsed.text === "string" && parsed.text.trim()) body = parsed.text.trim();
        } catch {
          // keep description
        }
      }
      const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-pr-body-"));
      const bodyFilePath = path.join(bodyDir, "body.md");
      fs.writeFileSync(bodyFilePath, body);
      const created = await deps.github.createDraftPr({
        cwd,
        base: baseBranch,
        head: branchName,
        title: taskSnapshot.title,
        bodyFilePath,
      });
      fs.rmSync(bodyDir, { recursive: true, force: true });
      if (!created.ok) {
        return created.noCommits
          ? { kind: "no_pr" }
          : {
              kind: "adapter_failure",
              reason: `Branch already pushed (${branchName}); only draft PR create failed: ${created.reason}`,
              publishable: { branch: branchName },
            };
      }
      prView = await deps.github.viewPr({ cwd, branch: branchName });
      if (!prView) {
        return {
          kind: "adapter_failure",
          reason: `Branch already pushed (${branchName}); PR created but could not be re-verified via gh pr view`,
          publishable: { branch: branchName },
        };
      }
    }

    if (prView.headRefOid !== remoteHead) {
      prView =
        (await reconcilePrHead(deps.github, {
          cwd,
          number: prView.number,
          branch: branchName,
          localHead: remoteHead,
          timeoutMs: developerEffectConfig.headReconcileTimeoutMs,
          intervalMs: developerEffectConfig.headReconcileIntervalMs,
        })) ?? prView;
    }
    const identityOpts = {
      branchName,
      baseBranch,
      priorPrNumber: issue.prNumber,
      localHead: remoteHead,
    };
    const identity = await validatePrIdentity(prView, identityOpts);
    if (!identity.ok) {
      return {
        kind: "adapter_failure",
        reason: `Branch already pushed (${branchName}); ${identity.reason}`,
        publishable: { branch: branchName },
      };
    }

    milestone("checks.started", `Developer · waiting on checks (publish retry, round ${round})`, {
      prNumber: prView.number,
      headSha: prView.headRefOid,
    });
    const checks = await pollPrChecks(deps.github, {
      cwd,
      timeoutMs: developerEffectConfig.checksPollTimeoutMs,
      intervalMs: developerEffectConfig.checksPollIntervalMs,
      signal: ctx.signal,
      number: prView.number,
    });
    milestone("checks.completed", `Developer · checks ${checks}`, {
      snapshot: checks,
      prNumber: prView.number,
      headSha: prView.headRefOid,
    });

    const postPollView = await deps.github.viewPr({ cwd, branch: branchName });
    if (!postPollView) {
      return {
        kind: "adapter_failure",
        reason: `Branch already pushed (${branchName}); PR could not be re-verified after the checks poll`,
        publishable: { branch: branchName },
      };
    }
    const postPollIdentity = await validatePrIdentity(postPollView, identityOpts);
    if (!postPollIdentity.ok) {
      return {
        kind: "adapter_failure",
        reason: `Branch already pushed (${branchName}); PR changed while waiting on checks: ${postPollIdentity.reason}`,
        publishable: { branch: branchName },
      };
    }
    prView = postPollView;

    createIssueArtifact({
      issueId: issue.id,
      workerSessionId: sessionId,
      kind: "checks_evidence",
      author: "system",
      content: { snapshot: checks, prNumber: prView.number, headSha: prView.headRefOid },
    });
    if (checks === "failure") return { kind: "checks_failed" };
    if (checks === "timeout") return { kind: "timed_out" };

    await fetchRef(cwd, prView.baseRefName);
    const baseSha = await mergeBase({
      repo: cwd,
      base: `origin/${prView.baseRefName}`,
      head: prView.headRefOid,
    });

    return {
      kind: "clean_handoff",
      branch: branchName,
      headSha: prView.headRefOid,
      baseSha,
      prNumber: prView.number,
      prUrl: prView.url,
    };
  } catch (err) {
    return {
      kind: "adapter_failure",
      reason: String(err),
      publishable: { branch: branchName },
    };
  }
}

export async function runDeveloperEffect(
  ctx: EffectContext,
  deps: DeveloperEffectDeps = defaultDeps
): Promise<DeveloperOutcome> {
  const { issue, workItem, instance } = ctx;
  const sessionId = workItem.workerSessionId;
  if (!sessionId) return { kind: "session_failed" };

  let payload: {
    retryReason?: string | null;
    publishOnly?: boolean;
    branch?: string;
  } = {};
  try {
    if (workItem.payloadJson) payload = JSON.parse(workItem.payloadJson);
  } catch {
    payload = {};
  }

  // No-agent infra retry: the branch already carries the work, so publish it — push only if
  // origin is behind (NOT-129's reclaim), then gh/PR/checks.
  if (payload.publishOnly) {
    const branchName = payload.branch?.trim() || issue.branch || `issue-${issue.id}`;
    return runPublishOnlyHandoff(ctx, deps, branchName);
  }

  const session = getWorkerSession(sessionId);
  const snapshot = parseProfileSnapshot(session?.profileSnapshotJson);
  let taskSnapshot = getTaskSnapshot(issue);
  const runtime = snapshot?.runtime ?? "claude_code";
  const round = workItem.round;
  const stage = issue.status;

  const milestone = (
    type: Parameters<typeof emitSessionMilestone>[0]["type"],
    intent: string,
    payload?: unknown
  ) =>
    emitSessionMilestone({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      workerSessionId: sessionId,
      role: "developer",
      stage,
      round,
      type,
      intent,
      payload,
    });

  // issue.branch is only ever written on a verified clean_handoff (design: it's ground
  // truth, not agent self-report), so a first-round attempt after an earlier retryable
  // failure in the SAME round (no_pr/session_failed/timed_out/checks_failed all remove
  // their worktree but leave the local branch ref behind) would otherwise re-run
  // `git worktree add -b <same name>` and fail with "branch already exists" — a review
  // round reproduced this directly. Check the branch itself, not just issue.branch, and
  // reuse it (preserving whatever local commits it already carries) when it's there.
  const branchName = issue.branch ?? `issue-${issue.id}`;
  let repoPath: string;
  let desiredWorktreePath: string;
  let baseBranch: string;
  try {
    const checkout = await ensureIssueRepoCheckout(issue.repo);
    repoPath = checkout.repoPath;
    desiredWorktreePath = roleWorktreePathForResolution(checkout, sessionId, "developer");
    baseBranch = resolveCheckoutBaseBranch(issue.baseBranch, checkout);
    syncIssueBaseBranch(issue, baseBranch);
    taskSnapshot = getTaskSnapshot(issue);
    if (checkout.kind === "managed" && checkout.defaultBranch) {
      try {
        await fetchRef(repoPath, checkout.defaultBranch);
      } catch {
        /* local objects may still suffice */
      }
    }
  } catch (err) {
    return { kind: "adapter_failure", reason: `repository checkout failed: ${String(err)}` };
  }

  const reuseBranch = issue.branch != null || (await branchExists(repoPath, branchName));

  let worktreePath: string;
  try {
    // Detects a leftover worktree from an earlier round/escalation that still holds this
    // branch (a plain `git worktree add` would collide with it and surface as an opaque
    // adapter_failure — the exact loop this ticket fixes). A clean leftover is reused in
    // place; a dirty/unpushed one is reported as a worktree_conflict escalation instead.
    // NOT-127: a leftover whose owning session still has a live process is neither adopted
    // nor escalated as a conflict — that is the same-worker case.
    const resolved = await resolveDeveloperWorktree({
      repo: repoPath,
      sessionId,
      branchName,
      baseBranch,
      reuseBranch,
      worktreePath: desiredWorktreePath,
      ownerLiveness: checkDeveloperWorktreeOwnerLiveness,
    });
    if (resolved.kind === "conflict") {
      return { kind: "worktree_conflict", path: resolved.path, reason: resolved.reason, recoveryCommands: resolved.recoveryCommands };
    }
    if (resolved.kind === "live_owner") {
      return {
        kind: "live_owner",
        path: resolved.path,
        ownerSessionId: resolved.ownerSessionId,
        reason: resolved.reason,
      };
    }
    worktreePath = resolved.path;
  } catch (err) {
    return { kind: "adapter_failure", reason: `worktree setup failed: ${String(err)}` };
  }

  patchRunningSession(sessionId, { worktreePath });
  milestone("worktree.ready", `Developer · worktree ready (round ${round})`, {
    worktreePath: shortWorktreePath(worktreePath),
  });

  // One resolution, two consumers: the materialized MCP config's tool surface below and
  // the spawn args' tool surface further down. They were resolved separately and had to
  // agree by inspection — the exact shape this stack exists to remove (NOT-134 review).
  const policy = snapshot?.permissionPolicy ?? roleCeiling("developer");

  let workerAuthority: { mcpConfigPath: string; mcpEnv?: Record<string, string> } | null = null;
  try {
    if (!snapshot?.deckId) {
      await bestEffortRemove(repoPath, worktreePath);
      return {
        kind: "deck_failure",
        reason: "Agent profile has no Agent Deck — workers never start without one",
      };
    }
    {
      const prepared = await prepareWorkerDeckConnection({
        deckId: snapshot.deckId,
        worktreePath,
        runtime,
        policy,
        verifyCallTool: deps.deckCallTool,
      });
      if (!prepared.ok) {
        await bestEffortRemove(repoPath, worktreePath);
        // NOT-136: an unreachable deck is a wait, not a failed attempt — nothing spawned.
        return prepared.kind === "deck_unavailable"
          ? { kind: "deck_unavailable", reason: prepared.reason }
          : { kind: "deck_failure", reason: prepared.reason };
      }
      workerAuthority = {
        mcpConfigPath: prepared.mcpConfigPath,
        mcpEnv: prepared.mcpEnv,
      };
      milestone("deck.connected", `Developer · deck connected (round ${round})`, {
        deckId: snapshot.deckId,
      });
    }

    if (taskBriefIsComplete(taskSnapshot)) {
      milestone("brief.resolved", `Developer · brief ready (Task/AC complete)`, {
        resolution: "task_complete",
      });
    } else {
      milestone("brief.resolved", `Developer · brief via Agent Deck (Linear fetch)`, {
        resolution: "deferred_to_agent",
      });
    }

    const openFindings = listFindingsForIssue(issue.id).filter(
      (f) => f.status === "open" || f.status === "recurring"
    );
    const guidance = guidanceForNextSession(issue.id, sessionId);
    const retryReason = payload.retryReason ?? undefined;
    let priorConclusion: string | undefined;
    let priorVerificationReceipt: VerificationReceipt | undefined;
    if (retryReason) {
      const prior = latestIssueArtifact(issue.id, "implementation_conclusion");
      if (prior?.contentJson) {
        try {
          const parsed = JSON.parse(prior.contentJson) as { text?: string };
          if (typeof parsed.text === "string" && parsed.text.trim()) {
            priorConclusion = parsed.text.trim();
          }
        } catch {
          // ignore malformed prior conclusion
        }
      }
      // SHA gate + reason gate: only carry when tip still matches AND this retry is not
      // checks_failed (local green at this SHA is what CI just rejected — do not tell the
      // agent to skip re-running).
      if (shouldCarryVerificationReceipt(retryReason)) {
        const currentHead = await revParseHead(worktreePath).catch(() => null);
        priorVerificationReceipt = loadPriorVerificationReceipt(issue.id, currentHead);
      }
    }
    const prompt = buildDeveloperPrompt({
      taskSnapshot,
      round: workItem.round,
      findings: openFindings.length ? openFindings : undefined,
      retryReason,
      priorConclusion,
      priorVerificationReceipt,
      worktreePath,
      deckId: snapshot?.deckId ?? null,
      
      guidance: guidance.length ? guidance : undefined,
    });

    // NOT-83 review finding: the session is marked `running` (worker-loop.ts) before this
    // handler ever runs, so an abort landing during worktree setup/deck-bind above already
    // cancelled this item in the DB while nothing here had noticed yet — the heartbeat-
    // driven ctx.signal only trips on its next tick (up to COORDINATOR_HEARTBEAT_MS later),
    // which is too slow to reliably catch this before the real spawn. Re-check the item's
    // live status right before incurring that cost, and never remove the worktree here —
    // nothing has run in it yet, so leaving it is always safe, and force-removing it is
    // exactly what the abort contract (NOT-83) says never to do.
    if (getWorkItem(workItem.id)?.status !== "leased") {
      return { kind: "session_failed" };
    }

    const logPath = developerSessionLogPath(sessionId);
    patchRunningSession(sessionId, { logPath, worktreePath });
    setLiveIntent(issue.id, `Developer · session running (round ${round})`);
    const sampler = startActivitySampler({ issueId: issue.id, role: "developer", round, logPath });

    const spawnStartedAt = Date.now();
    let spawned;
    try {
      spawned = await deps.spawn({
        sessionId,
        runtime,
        policy,
        model: snapshot?.model ?? null,
        effort: snapshot?.effort ?? null,
        prompt,
        cwd: worktreePath,
        timeoutMs: developerEffectConfig.sessionTimeoutMs,
        mcpConfigPath: workerAuthority?.mcpConfigPath,
        mcpEnv: workerAuthority?.mcpEnv,
        logPath,
        // NOT-126: without this the abort stops at the handler — the CLI itself keeps
        // running, editing this worktree under a session already marked failed.
        signal: ctx.signal,
        // NOT-124: persist the CLI's pid so recovery can verify this worker is really
        // gone before presuming it dead on an expired lease.
        // NOT-131: the start time is read here, while the process is known to be this
        // spawn's child, so a successor coordinator can still identify it after a restart.
        onSpawn: (pid) =>
          recordSessionProcess(sessionId, pid, COORDINATOR_PROCESS_OWNER, readProcessStartTime(pid)),
      });
    } finally {
      sampler.stop();
    }

    // NOT-130: record suite evidence even when the session later fails/times out — an
    // interrupted-but-verified tip must carry the receipt into the retry prompt.
    await persistVerificationReceiptIfAny({
      issueId: issue.id,
      sessionId,
      logPath: spawned.logPath,
      worktreePath,
    });

    // Recorded unconditionally, before any early return below: cost is incurred the
    // moment the process runs, whether or not the session subsequently timed out,
    // exited non-zero, or failed later-stage verification.
    const usage = extractSpawnUsage(spawned.logPath, runtime);
    recordUsageEvent({
      issueId: issue.id,
      workerSessionId: sessionId,
      role: "developer",
      runtime,
      durationMs: Date.now() - spawnStartedAt,
      ...usage,
    });

    // Released here, right after the worker's own subprocess has exited, rather than
    // waiting for this function to return: the deck MCP config has no legitimate further
    // use once the worker session is done, and everything below this point (push, PR
    // creation) is coordinator-side git/gh, not a deck call. This is also load-bearing
    // for cursor specifically — its per-attempt MCP config is a file *inside* the
    // worktree (agent-deck-bind.ts), so it must be gone before that worktree is ever
    // pushed, not merely by the time this function eventually returns.
    if (workerAuthority) {
      await releaseWorkerDeckConnection(workerAuthority);
      workerAuthority = null;
    }

    const usageCap = recordUsageCapFromLog(spawned.logPath, runtime);
    if (usageCap) {
      const clean = await isWorktreeClean(worktreePath).catch(() => false);
      if (!clean) {
        return {
          kind: "dirty_worktree",
          reason: reasonForDirtyWorktree(spawned.logPath, runtime),
          path: worktreePath,
          recoveryCommands: dirtyWorktreeRecoveryCommands(repoPath, worktreePath),
        };
      }

      const sessionOk = !spawned.timedOut && spawned.exitCode === 0;
      const ahead = await commitsAhead({
        worktreePath,
        baseRef: `origin/${baseBranch}`,
      }).catch(() => 0);

      // NOT-117: a successful clean tip must continue to push/PR. Cap is already recorded
      // for future agent spawns; deferring here discarded the tip and the resume prompt
      // looked like a blank round-1 rebuild.
      if (!(sessionOk && ahead > 0)) {
        await bestEffortRemove(repoPath, worktreePath);
        return {
          kind: "usage_capped",
          until: usageCap.unavailableUntil,
          reason: usageCap.reason,
          evidence: usageCap.evidence,
          ...(ahead > 0
            ? {
                resume: {
                  retryReason:
                    "Prior developer session was deferred for a usage cap after local commits existed. Continue from the existing branch — do not re-implement from scratch.",
                },
              }
            : {}),
        };
      }
    }

    if (spawned.timedOut || spawned.exitCode !== 0) {
      // NOT-145: on infra death, never wipe uncommitted WIP. Prefer a salvage tip on the
      // issue branch (durable checkpoint — parent NOT-143) so retry_developer can continue;
      // only when auto-commit fails do we preserve the dirty checkout and escalate with
      // path + recovery (same actionability as worktree_conflict / NOT-137).
      //
      // Pre-NOT-145 this returned dirty_worktree immediately when dirty (preserving the
      // checkout so the next add wouldn't collide). Salvage is strictly better: the tip is
      // reusable, and the worktree can be removed cleanly for the retry.
      const clean = await isWorktreeClean(worktreePath).catch(() => false);
      if (!clean) {
        const salvageKind = spawned.timedOut ? "timeout" : "crash";
        const salvaged = await salvageDirtyWorktree(worktreePath, salvageKind);
        if (salvaged.ok) {
          // Lens (NOT-145 class post-salvage-remove-unchecked): only route infra retry when
          // the checkout is actually gone. If remove preserves (or throws), escalate with
          // path+recovery instead of retrying into a branch still held by a leftover tree.
          let removed = false;
          try {
            const removal = await safeRemoveWorktree({
              repo: repoPath,
              path: worktreePath,
              role: "developer",
              branchPushed: true,
            });
            removed = removal.removed === true;
          } catch {
            removed = false;
          }
          if (!removed) {
            const dirtyReason = reasonForDirtyWorktree(spawned.logPath, runtime);
            return {
              kind: "dirty_worktree",
              reason: `${dirtyReason} Salvage tip ${salvaged.message} (${salvaged.commitSha.slice(0, 7)}) landed but the worktree could not be removed for retry.`,
              path: worktreePath,
              recoveryCommands: dirtyWorktreeRecoveryCommands(repoPath, worktreePath),
            };
          }
          const crashReason = reasonForSessionCrash({
            timedOut: Boolean(spawned.timedOut),
            logPath: spawned.logPath,
            runtime,
          });
          const salvageNote = `Salvaged uncommitted work as ${salvaged.message} (${salvaged.commitSha.slice(0, 7)}).`;
          return spawned.timedOut
            ? { kind: "timed_out", reason: `${crashReason} ${salvageNote}` }
            : { kind: "session_failed", reason: `${crashReason} ${salvageNote}` };
        }
        // Salvage failed — do not remove. Escalate with actionable recovery.
        const dirtyReason = reasonForDirtyWorktree(spawned.logPath, runtime);
        return {
          kind: "dirty_worktree",
          reason: `${dirtyReason} Auto-commit salvage failed: ${salvaged.reason}`,
          path: worktreePath,
          recoveryCommands: dirtyWorktreeRecoveryCommands(repoPath, worktreePath),
        };
      }
      await bestEffortRemove(repoPath, worktreePath);
      return spawned.timedOut
        ? { kind: "timed_out", reason: reasonForSessionCrash({ timedOut: true, logPath: spawned.logPath, runtime }) }
        : { kind: "session_failed", reason: reasonForSessionCrash({ timedOut: false, logPath: spawned.logPath, runtime }) };
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
      return {
        kind: "dirty_worktree",
        reason: reasonForDirtyWorktree(spawned.logPath, runtime),
        path: worktreePath,
        recoveryCommands: dirtyWorktreeRecoveryCommands(repoPath, worktreePath),
      };
    }

    const ahead = await commitsAhead({ worktreePath, baseRef: `origin/${baseBranch}` });
    if (ahead === 0) {
      await bestEffortRemove(repoPath, worktreePath);
      return { kind: "no_pr" };
    }

    setLiveIntent(issue.id, `Developer · pushing branch (round ${round})`);
    const pushed = await pushBranch({ worktreePath, branch: branchName });
    if (!pushed.ok) {
      // Local commits preserved either way — never discarded, never force-retried.
      return pushed.rejected
        ? {
            kind: "unpushed_commit",
            reason: pushed.reason,
            recoveryCommands: pushed.facts?.recoveryCommands,
          }
        : { kind: "adapter_failure", reason: pushed.reason };
    }
    milestone("branch.pushed", `Developer · branch pushed (${ahead} commit${ahead === 1 ? "" : "s"})`, {
      branch: branchName,
      commitsAhead: ahead,
    });
    // From here on the branch is safely on the remote — a worktree removal on any
    // subsequent failure path loses nothing (bestEffortRemove is safe to call).

    // The coordinator already knows the exact generated branch — pass it explicitly
    // rather than asking `gh` to infer "the current branch" from upstream tracking, which
    // pushBranch's push does not reliably leave configured (NOT-82).
    let prView = await deps.github.viewPr({ cwd: worktreePath, branch: branchName });
    if (!prView) {
      setLiveIntent(issue.id, `Developer · opening draft PR (round ${round})`);
      const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-pr-body-"));
      const bodyFilePath = path.join(bodyDir, "body.md");
      fs.writeFileSync(bodyFilePath, extractConclusion(spawned.transcript) || taskSnapshot.description);
      const created = await deps.github.createDraftPr({
        cwd: worktreePath,
        base: baseBranch,
        head: branchName,
        title: taskSnapshot.title,
        bodyFilePath,
      });
      fs.rmSync(bodyDir, { recursive: true, force: true });
      if (!created.ok) {
        await bestEffortRemove(repoPath, worktreePath);
        return created.noCommits
          ? { kind: "no_pr" }
          : {
              kind: "adapter_failure",
              reason: `Branch already pushed (${branchName}); only draft PR create failed: ${created.reason}`,
              publishable: { branch: branchName },
            };
      }
      prView = await deps.github.viewPr({ cwd: worktreePath, branch: branchName });
      if (!prView) {
        await bestEffortRemove(repoPath, worktreePath);
        return {
          kind: "adapter_failure",
          reason: `Branch already pushed (${branchName}); PR created but could not be re-verified via gh pr view`,
          publishable: { branch: branchName },
        };
      }
    }

    const localHead = await revParseHead(worktreePath);
    if (prView.headRefOid !== localHead) {
      prView =
        (await reconcilePrHead(deps.github, {
          cwd: worktreePath,
          number: prView.number,
          branch: branchName,
          localHead,
          timeoutMs: developerEffectConfig.headReconcileTimeoutMs,
          intervalMs: developerEffectConfig.headReconcileIntervalMs,
        })) ?? prView;
    }
    const identityOpts = { branchName, baseBranch, priorPrNumber: issue.prNumber, localHead };
    const identity = await validatePrIdentity(prView, identityOpts);
    if (!identity.ok) {
      await bestEffortRemove(repoPath, worktreePath);
      return {
        kind: "adapter_failure",
        reason: `Branch already pushed (${branchName}); ${identity.reason}`,
        publishable: { branch: branchName },
      };
    }

    milestone("checks.started", `Developer · waiting on checks (round ${round})`, {
      prNumber: prView.number,
      headSha: prView.headRefOid,
    });
    const checks = await pollPrChecks(deps.github, {
      cwd: worktreePath,
      timeoutMs: developerEffectConfig.checksPollTimeoutMs,
      intervalMs: developerEffectConfig.checksPollIntervalMs,
      signal: ctx.signal,
      // prView.number is already identity-validated above — prefer it over branch (same
      // reviewer blocker as NOT-82's original fix: never let the checks-poll stage fall
      // back to a bare `gh pr view` either).
      number: prView.number,
    });
    milestone("checks.completed", `Developer · checks ${checks}`, {
      snapshot: checks,
      prNumber: prView.number,
      headSha: prView.headRefOid,
    });

    // The poll can run for up to checksPollTimeoutMs (default 10 minutes) — re-fetch and
    // re-validate identity against the SAME localHead before trusting either the checks
    // or the SHA about to be handed to the reviewer. A review round found the original
    // code reused the pre-poll `prView` unconditionally: if the branch moved while this
    // process was waiting (another push, a zombie retry from a reclaimed lease), the
    // checks queried could describe a different commit than the one about to be recorded
    // as the verified handoff, breaking the exact-current-SHA contract.
    const postPollView = await deps.github.viewPr({ cwd: worktreePath, branch: branchName });
    if (!postPollView) {
      await bestEffortRemove(repoPath, worktreePath);
      return {
        kind: "adapter_failure",
        reason: `Branch already pushed (${branchName}); PR could not be re-verified after the checks poll`,
        publishable: { branch: branchName },
      };
    }
    const postPollIdentity = await validatePrIdentity(postPollView, identityOpts);
    if (!postPollIdentity.ok) {
      await bestEffortRemove(repoPath, worktreePath);
      return {
        kind: "adapter_failure",
        reason: `Branch already pushed (${branchName}); PR changed while waiting on checks: ${postPollIdentity.reason}`,
        publishable: { branch: branchName },
      };
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
      await bestEffortRemove(repoPath, worktreePath);
      return { kind: "checks_failed" };
    }
    if (checks === "timeout") {
      await bestEffortRemove(repoPath, worktreePath);
      return { kind: "timed_out" };
    }

    // Resolve the base SHA against the *fetched* base ref (design §"Verify handoff"), not
    // whatever the local branch happened to point to before this session ran — a review
    // round found a stale local base could record the wrong merge-base if origin's base
    // branch had moved.
    await fetchRef(worktreePath, prView.baseRefName);
    const baseSha = await mergeBase({ repo: worktreePath, base: `origin/${prView.baseRefName}`, head: prView.headRefOid });

    await bestEffortRemove(repoPath, worktreePath);
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
  } finally {
    // The worker's own subprocess is done (or never started) by every path through this
    // try block — its per-attempt MCP config has no further legitimate use.
    if (workerAuthority) await releaseWorkerDeckConnection(workerAuthority);
  }
}
