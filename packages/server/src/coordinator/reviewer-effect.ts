// packages/server/src/coordinator/reviewer-effect.ts
//
// The real reviewer effect handler (NOT-62): detached-HEAD worktree at the pinned SHA →
// deck bind → spawn → parse the structured verdict → re-verify the PR is still at that
// SHA (stale check) → publish the review to GitHub → ReviewerOutcome. Registered via
// `registerEffectHandler("reviewer", ...)`.
//
// Unlike the developer effect, the reviewer never writes, pushes, or calls `gh` itself —
// it only returns the JSON verdict `reviewer-result.ts` parses. Diff/checks/findings are
// computed by this coordinator process and embedded in the prompt (see prompts.ts's
// module doc: a read-only claude reviewer has no Bash to run `git diff` itself), and
// publishing happens here, after the worker's session has already ended — the same
// "credentialed effect never runs inside the worker's own process" boundary NOT-61 used
// for push/PR-creation (see profile-snapshot.ts's `PermissionPolicy` doc comment).
//
// `ReviewerOutcome` (routing.ts, accepted in the NOT-59 kernel review) has no separate
// `timed_out` or `adapter_failure` kind the way `DeveloperOutcome` does — routing.ts's own
// doc comment for `session_failed` already covers "failed, timed out, or its worktree
// checkout failed," and "publish_failed" covers both a failed re-verify and a failed
// `gh pr review` call ("Publication or reviewer infrastructure failure," design §5) —
// both route to the same `policy_escalation`, so the split below is for a clearer human-
// facing reason, not different behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProfileSnapshot, roleCeiling } from "@agent-dealer/shared";
import type { EffectContext } from "./effect-registry.js";
import type { ReviewerOutcome } from "./routing.js";
import { getTaskSnapshot } from "./commands.js";
import { buildReviewerPrompt, formatDiffForPrompt, TOTAL_DIFF_LIMIT } from "./prompts.js";
import { guidanceForNextSession } from "./guidance.js";
import { realReviewerSpawn, reviewerSessionLogPath, type ReviewerSpawn } from "./spawn.js";
import { parseReviewerResult, ReviewerResult as ReviewerResultSchema, type ReviewerResult, type ReviewerVerdict } from "./reviewer-result.js";
import {
  createRoleWorktree,
  safeRemoveWorktree,
  isWorktreeClean,
  mergeBase,
  fetchRef,
  diffShas,
} from "../adapters/git-worktree.js";
import { prepareWorkerDeckConnection, releaseWorkerDeckConnection, type DeckToolCaller } from "../adapters/agent-deck-bind.js";
import { realGithubAdapter, type GithubAdapter, type ReviewEvent } from "../adapters/github.js";
import { getWorkerSession, patchRunningSession, recordSessionProcess } from "../repository/worker-sessions.js";
import { COORDINATOR_PROCESS_OWNER } from "./process-liveness.js";
import { getWorkItem } from "../repository/work-items.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { recordUsageEvent } from "../repository/usage-events.js";
import { extractSpawnUsage } from "./usage.js";
import { recordUsageCapFromLog } from "../runners/usage-cap.js";
import {
  emitSessionMilestone,
  setLiveIntent,
  shortWorktreePath,
  startActivitySampler,
  taskBriefIsComplete,
} from "./session-progress.js";
import {
  claimReviewPublication,
  getReviewPublication,
  reclaimFailedReviewPublication,
  recordReviewPublished,
  recordReviewPublishFailed,
  type ReviewPublicationRow,
} from "../repository/review-publications.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export const reviewerEffectConfig = {
  get sessionTimeoutMs(): number {
    return num("REVIEWER_TIMEOUT_MS", 30 * 60_000);
  },
  /** How long a loser waits for an in-flight claimant before giving up as `publish_failed`. */
  get publicationWaitAttempts(): number {
    return num("REVIEWER_PUBLISH_WAIT_ATTEMPTS", 5);
  },
  get publicationWaitIntervalMs(): number {
    return num("REVIEWER_PUBLISH_WAIT_INTERVAL_MS", 200);
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PublicationClaim = { owns: true } | { owns: false; row: ReviewPublicationRow | null };

/**
 * Serializes entry into the actual `gh pr review` call across overlapping attempts on
 * the same work item (round 2/3): a read-only "does a review already exist" lookup
 * alone is a check-then-publish race two such attempts could both pass before either
 * has published. Gated on `leaseToken` (round 4) — only whoever currently holds the
 * work item's one lease token can ever win or reclaim this claim, so a zombie whose
 * lease has already been reclaimed can never win it out from under the actual current
 * holder no matter how the two attempts' wall-clock timing falls (see the module doc
 * on `repository/review-publications.ts`). This loops because a loser may find the
 * winner still `claimed` (in flight) rather than settled yet — it waits, bounded,
 * rather than guessing; if the winner instead already failed, this attempt safely
 * reclaims and becomes the new winner itself.
 */
async function acquireOrAwaitPublication(workItemId: string, leaseToken: string): Promise<PublicationClaim> {
  for (let attempt = 0; attempt < reviewerEffectConfig.publicationWaitAttempts; attempt++) {
    if (claimReviewPublication(workItemId, leaseToken)) return { owns: true };
    const row = getReviewPublication(workItemId);
    if (row?.state === "published") return { owns: false, row };
    if (row?.state === "failed") {
      if (reclaimFailedReviewPublication(workItemId, leaseToken)) return { owns: true };
      continue; // someone else reclaimed it in the same instant — loop and re-check
    }
    // row is null (raced right at the insert boundary) or still 'claimed' (in flight).
    await sleep(reviewerEffectConfig.publicationWaitIntervalMs);
  }
  return { owns: false, row: getReviewPublication(workItemId) };
}

export interface ReviewerEffectDeps {
  spawn: ReviewerSpawn;
  github: GithubAdapter;
  /** Test-only seam: fake `get_bound_deck` so a deckId-bearing profile can exercise the
   * real deck-connection path without a reachable Agent Deck. */
  deckCallTool?: DeckToolCaller;
}

const defaultDeps: ReviewerEffectDeps = { spawn: realReviewerSpawn, github: realGithubAdapter };

const EVENT_FOR_VERDICT: Record<ReviewerVerdict, ReviewEvent> = {
  approved: "APPROVE",
  changes_requested: "REQUEST_CHANGES",
  escalated: "COMMENT",
};

/** Best-effort: the worker never writes, so a non-clean checkout here is unexpected, not valuable work. */
async function bestEffortRemove(repo: string, worktreePath: string): Promise<void> {
  try {
    await safeRemoveWorktree({ repo, path: worktreePath, role: "reviewer" });
  } catch {
    // leave it for crash-recovery inspection — cleanup is a courtesy, not part of the contract
  }
}

function readImplementationConclusion(issueId: string): string | null {
  const artifact = latestIssueArtifact(issueId, "implementation_conclusion");
  if (!artifact?.contentJson) return null;
  try {
    return (JSON.parse(artifact.contentJson) as { text?: string }).text ?? null;
  } catch {
    return null;
  }
}

function readChecksSummary(issueId: string): string | null {
  const artifact = latestIssueArtifact(issueId, "checks_evidence");
  if (!artifact?.contentJson) return null;
  try {
    const data = JSON.parse(artifact.contentJson) as { snapshot?: string; headSha?: string };
    if (!data.snapshot) return null;
    return `${data.snapshot}${data.headSha ? ` (at ${data.headSha.slice(0, 8)})` : ""}`;
  } catch {
    return null;
  }
}

/**
 * Unique per queued reviewer work item — embedded in the published review body purely
 * as a human-readable audit trail back to the exact work item that produced it.
 * Duplicate-publication prevention itself is the `review_publications` DB claim
 * (`acquireOrAwaitPublication`), not this marker; round 3 moved that guarantee off a
 * GitHub-side lookup entirely (see `github.ts`'s `publishReview` doc comment).
 */
function reviewMarker(workItemId: string): string {
  return `<!-- agent-dealer:review:${workItemId} -->`;
}

function renderReviewBody(result: ReviewerResult, marker: string): string {
  const lines = [
    `**Verdict:** ${result.verdict}`,
    ``,
    `**Acceptance criteria assessment**`,
    result.acceptanceCriteriaAssessment,
    ``,
    `**Evidence assessment**`,
    result.evidenceAssessment,
  ];
  if (result.findings.length) {
    lines.push(``, `**Findings**`);
    for (const f of result.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      lines.push(`- [${f.severity}] ${f.title}${loc}: ${f.rationale}`);
    }
  }
  if (result.risks.length) {
    lines.push(``, `**Risks**`, ...result.risks.map((r) => `- ${r}`));
  }
  if (result.productScopeQuestion) {
    lines.push(``, `**Escalation — product scope question**`, result.productScopeQuestion);
  }
  lines.push(``, `_agent-dealer automated review (base ${result.baseSha.slice(0, 8)} → head ${result.headSha.slice(0, 8)})_`, marker);
  return lines.join("\n");
}

export async function runReviewerEffect(
  ctx: EffectContext,
  deps: ReviewerEffectDeps = defaultDeps
): Promise<ReviewerOutcome> {
  const { issue, workItem, instance } = ctx;
  const sessionId = workItem.workerSessionId;
  if (!sessionId) return { kind: "session_failed" };
  const leaseToken = workItem.leaseToken;
  if (!leaseToken) return { kind: "session_failed" };

  const session = getWorkerSession(sessionId);
  const snapshot = parseProfileSnapshot(session?.profileSnapshotJson);
  const taskSnapshot = getTaskSnapshot(issue);
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
      role: "reviewer",
      stage,
      round,
      type,
      intent,
      payload,
    });

  let payload: { inputSha?: string | null } = {};
  try {
    if (workItem.payloadJson) payload = JSON.parse(workItem.payloadJson);
  } catch {
    payload = {};
  }
  // A reviewer work item is always enqueued with an atHeadSha (commands.ts) — the live
  // issue.headSha fallback only covers a legacy item queued before that was carried.
  const headSha = payload.inputSha ?? issue.headSha;
  if (!headSha) return { kind: "session_failed" };

  let worktreePath: string;
  let result: ReviewerResult;
  let workerAuthority: { mcpConfigPath: string; mcpEnv?: Record<string, string> } | null = null;
  try {
   try {
    const worktree = await createRoleWorktree({
      repo: issue.repo,
      role: "reviewer",
      sessionId,
      ref: headSha,
    });
    worktreePath = worktree.path;
    patchRunningSession(sessionId, { worktreePath });
    milestone("worktree.ready", `Reviewer · worktree ready (round ${round})`, {
      worktreePath: shortWorktreePath(worktreePath),
      headSha: headSha.slice(0, 8),
    });

    if (snapshot?.deckId) {
      const prepared = await prepareWorkerDeckConnection({
        deckId: snapshot.deckId,
        worktreePath,
        runtime,
        playbookIds: snapshot.playbookIds,
        verifyCallTool: deps.deckCallTool,
      });
      if (!prepared.ok) {
        await bestEffortRemove(issue.repo, worktreePath);
        return { kind: "session_failed", reason: `deck connection failed: ${prepared.reason}` };
      }
      workerAuthority = {
        mcpConfigPath: prepared.mcpConfigPath,
        mcpEnv: prepared.mcpEnv,
      };
      milestone("deck.connected", `Reviewer · deck connected (round ${round})`, {
        deckId: snapshot.deckId,
      });
    }

    if (taskBriefIsComplete(taskSnapshot)) {
      milestone("brief.resolved", `Reviewer · brief ready (Task/AC complete)`, {
        resolution: "task_complete",
      });
    } else if (snapshot?.deckId) {
      milestone("brief.resolved", `Reviewer · brief via Agent Deck`, {
        resolution: "deferred_to_agent",
      });
    } else {
      milestone("brief.resolved", `Reviewer · brief from Task fields`, {
        resolution: "task_fields_only",
      });
    }

    // Recomputed here rather than trusted off `issue.baseSha`: a retry_reviewer_at_new_head
    // round only re-patches `headSha` (commands.ts's applyReviewer), so the issue's stored
    // baseSha could describe a different head than the one this session is pinned to.
    await fetchRef(worktreePath, issue.baseBranch);
    const baseSha = await mergeBase({ repo: worktreePath, base: `origin/${issue.baseBranch}`, head: headSha });
    const diff = await diffShas({ worktreePath, baseSha, headSha });
    const { truncated: diffTruncated } = formatDiffForPrompt(diff);

    const openFindings = listFindingsForIssue(issue.id).filter(
      (f) => f.status === "open" || f.status === "recurring"
    );
    const guidance = guidanceForNextSession(issue.id, sessionId);
    const prompt = buildReviewerPrompt({
      taskSnapshot,
      round: workItem.round,
      baseSha,
      headSha,
      diff,
      implementationConclusion: readImplementationConclusion(issue.id),
      checksSummary: readChecksSummary(issue.id),
      findings: openFindings.length ? openFindings : undefined,
      worktreePath,
      deckId: snapshot?.deckId ?? null,
      playbookIds: snapshot?.playbookIds,
      guidance: guidance.length ? guidance : undefined,
    });

    // NOT-83 review finding — see developer-effect.ts's identical check for the full
    // rationale: re-verify this item is still leased right before the real spawn, since an
    // abort during worktree/deck-bind setup above can cancel it before ctx.signal's
    // heartbeat-driven abort would ever trip. Never remove the worktree here — nothing has
    // run in it yet.
    if (getWorkItem(workItem.id)?.status !== "leased") {
      return { kind: "session_failed" };
    }

    const logPath = reviewerSessionLogPath(sessionId);
    patchRunningSession(sessionId, { logPath, worktreePath });
    setLiveIntent(issue.id, `Reviewer · session running (round ${round})`);
    const sampler = startActivitySampler({ issueId: issue.id, role: "reviewer", round, logPath });

    const spawnStartedAt = Date.now();
    let spawned;
    try {
      spawned = await deps.spawn({
        sessionId,
        runtime,
        policy: snapshot?.permissionPolicy ?? roleCeiling("reviewer"),
        model: snapshot?.model ?? null,
        prompt,
        cwd: worktreePath,
        timeoutMs: reviewerEffectConfig.sessionTimeoutMs,
        mcpConfigPath: workerAuthority?.mcpConfigPath,
        mcpEnv: workerAuthority?.mcpEnv,
        logPath,
        // NOT-126: without this the abort stops at the handler — the CLI itself keeps
        // running, editing this worktree under a session already marked failed.
        signal: ctx.signal,
        // NOT-124: persist the CLI's pid so recovery can verify this worker is really
        // gone before presuming it dead on an expired lease.
        onSpawn: (pid) => recordSessionProcess(sessionId, pid, COORDINATOR_PROCESS_OWNER),
      });
    } finally {
      sampler.stop();
    }

    // See developer-effect.ts's identical call: recorded before any early return so a
    // failed/timed-out reviewer session still attributes its incurred cost.
    const usage = extractSpawnUsage(spawned.logPath, runtime);
    recordUsageEvent({
      issueId: issue.id,
      workerSessionId: sessionId,
      role: "reviewer",
      runtime,
      durationMs: Date.now() - spawnStartedAt,
      ...usage,
    });

    // See developer-effect.ts's identical release: the worker's own subprocess has
    // exited, so its deck MCP config has no further legitimate use, and (cursor) its
    // worktree-local MCP config must be gone well before this worktree could ever be
    // reused — don't wait for this function's own return to clean it up.
    if (workerAuthority) {
      await releaseWorkerDeckConnection(workerAuthority);
      workerAuthority = null;
    }

    const usageCap = recordUsageCapFromLog(spawned.logPath, runtime);
    if (usageCap) {
      const clean = await isWorktreeClean(worktreePath).catch(() => false);
      if (!clean) return { kind: "session_failed" };
      await bestEffortRemove(issue.repo, worktreePath);
      return {
        kind: "usage_capped",
        until: usageCap.unavailableUntil,
        reason: usageCap.reason,
        evidence: usageCap.evidence,
      };
    }

    if (spawned.timedOut || spawned.exitCode !== 0) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "session_failed" };
    }

    // Persisted as soon as the session itself completes, regardless of how verification/
    // publication subsequently resolves — mirrors developer-effect.ts's evidence timing.
    createIssueArtifact({
      issueId: issue.id,
      workerSessionId: sessionId,
      kind: "reviewer_transcript",
      author: "system",
      blobPath: spawned.logPath,
    });

    const parsed = parseReviewerResult(spawned.transcript);
    if (!parsed) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "session_failed" };
    }
    // The reviewer is told to echo these exact values (prompts.ts's reviewer contract);
    // a result that doesn't cannot be trusted to have actually reviewed the pinned
    // revision — reject it rather than let a wrong-SHA verdict approve or advance the
    // issue (design's exact-SHA protocol applies to the reviewer's output too, not just
    // the developer's handoff).
    if (parsed.baseSha !== baseSha || parsed.headSha !== headSha) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "session_failed" };
    }
    result = parsed;

    // A prompt instruction alone ("don't approve an incomplete diff") is not a structural
    // guarantee — the same reasoning this codebase already applies to tool permissions
    // (args.ts/permissions.ts). If the diff had to be truncated, the reviewer's verdict is
    // overridden to "escalated" in code, regardless of what it actually reported, so a
    // truncated review can never reach final_review or an automatic repair loop.
    if (diffTruncated && result.verdict !== "escalated") {
      createIssueArtifact({
        issueId: issue.id,
        workerSessionId: sessionId,
        kind: "diff_truncated_evidence",
        author: "system",
        content: { reportedVerdict: result.verdict, overriddenTo: "escalated", diffCharLimit: TOTAL_DIFF_LIMIT },
      });
      result = { ...result, verdict: "escalated" };
    }
   } catch {
    return { kind: "session_failed" };
   }

  if (issue.prNumber == null) {
    // Can't identify which PR to re-verify/publish against — the detached worktree has
    // no branch for `gh` to fall back to resolving this from.
    await bestEffortRemove(issue.repo, worktreePath);
    return { kind: "publish_failed" };
  }

  try {
    const prView = await deps.github.viewPr({ cwd: worktreePath, number: issue.prNumber });
    if (!prView) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "publish_failed" };
    }
    if (prView.headRefOid !== headSha) {
      // design §5: stale output is stored as evidence, not discarded and not published.
      createIssueArtifact({
        issueId: issue.id,
        workerSessionId: sessionId,
        kind: "stale_review_evidence",
        author: "agent",
        content: { review: result, staleAtSha: headSha, currentHeadSha: prView.headRefOid },
      });
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "stale", currentHeadSha: prView.headRefOid };
    }

    const requestedEvent = EVENT_FOR_VERDICT[result.verdict];

    const claim = await acquireOrAwaitPublication(workItem.id, leaseToken);
    if (!claim.owns) {
      await bestEffortRemove(issue.repo, worktreePath);
      // The winner's *actual* published result is authoritative here — never this
      // attempt's own independently-parsed `result`, which a review round found could
      // genuinely disagree with the winner's (two separate reviewer sessions are two
      // separate model calls, and can produce different verdicts/findings for the same
      // diff). A `row` with no recorded result (still `claimed` after every wait
      // attempt, or the winner itself failed) has nothing safe to report — escalate.
      if (claim.row?.state === "published" && claim.row.resultJson) {
        const winnerResult = ReviewerResultSchema.parse(JSON.parse(claim.row.resultJson));
        return { kind: "verdict", result: winnerResult };
      }
      return { kind: "publish_failed" };
    }

    const marker = reviewMarker(workItem.id);
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-review-body-"));
    const bodyFilePath = path.join(bodyDir, "body.md");
    fs.writeFileSync(bodyFilePath, renderReviewBody(result, marker));
    const published = await deps.github.publishReview({
      cwd: worktreePath,
      number: issue.prNumber,
      event: requestedEvent,
      bodyFilePath,
    });
    fs.rmSync(bodyDir, { recursive: true, force: true });
    if (!published.ok) {
      recordReviewPublishFailed(workItem.id);
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "publish_failed" };
    }

    recordReviewPublished(workItem.id, {
      resultJson: JSON.stringify(result),
      event: published.event,
      usedCommentFallback: published.usedCommentFallback,
    });
    createIssueArtifact({
      issueId: issue.id,
      workerSessionId: sessionId,
      kind: "review_published",
      author: "system",
      content: { event: published.event, usedCommentFallback: published.usedCommentFallback, verdict: result.verdict },
    });

    await bestEffortRemove(issue.repo, worktreePath);
    return { kind: "verdict", result };
  } catch {
    await bestEffortRemove(issue.repo, worktreePath);
    return { kind: "publish_failed" };
  }
  } finally {
    // See developer-effect.ts's identical finally: the worker's subprocess is done (or
    // never started) by every path through this function, so its per-attempt MCP config
    // is cleaned up here.
    if (workerAuthority) await releaseWorkerDeckConnection(workerAuthority);
  }
}
