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
import { realReviewerSpawn, type ReviewerSpawn } from "./spawn.js";
import { parseReviewerResult, type ReviewerResult, type ReviewerVerdict } from "./reviewer-result.js";
import {
  createRoleWorktree,
  safeRemoveWorktree,
  mergeBase,
  fetchRef,
  diffShas,
} from "../adapters/git-worktree.js";
import { bindAndVerify, type DeckToolCaller } from "../adapters/agent-deck-bind.js";
import { realGithubAdapter, type GithubAdapter, type ReviewEvent } from "../adapters/github.js";
import { getWorkerSession } from "../repository/worker-sessions.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { claimReviewPublication } from "../repository/review-publications.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export const reviewerEffectConfig = {
  get sessionTimeoutMs(): number {
    return num("REVIEWER_TIMEOUT_MS", 30 * 60_000);
  },
};

export interface ReviewerEffectDeps {
  spawn: ReviewerSpawn;
  github: GithubAdapter;
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
 * Unique per queued reviewer work item (a retry_reviewer_at_new_head or a repair round
 * always enqueues a fresh work item, never reuses this one) — embedded in the published
 * review body so `findOwnReview`/`publishReview` can recognize agent-dealer's own prior
 * publication for this exact intended review, not just any review by the same identity.
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
  const { issue, workItem } = ctx;
  const sessionId = workItem.workerSessionId;
  if (!sessionId) return { kind: "session_failed" };

  const session = getWorkerSession(sessionId);
  const snapshot = parseProfileSnapshot(session?.profileSnapshotJson);
  const taskSnapshot = getTaskSnapshot(issue);
  const runtime = snapshot?.runtime ?? "claude_code";

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
  try {
    const worktree = await createRoleWorktree({
      repo: issue.repo,
      role: "reviewer",
      sessionId,
      ref: headSha,
    });
    worktreePath = worktree.path;

    if (snapshot?.deckId) {
      const bind = await bindAndVerify({ deckId: snapshot.deckId, worktreePath, callTool: deps.deckCallTool });
      if (!bind.ok) {
        await bestEffortRemove(issue.repo, worktreePath);
        return { kind: "session_failed" };
      }
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
    });

    const spawned = await deps.spawn({
      sessionId,
      runtime,
      policy: snapshot?.permissionPolicy ?? roleCeiling("reviewer"),
      model: snapshot?.model ?? null,
      prompt,
      cwd: worktreePath,
      timeoutMs: reviewerEffectConfig.sessionTimeoutMs,
    });

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

    const marker = reviewMarker(workItem.id);
    const requestedEvent = EVENT_FOR_VERDICT[result.verdict];

    // Serializes entry into the actual `gh` call across overlapping attempts on the same
    // work item (a crash-and-recover, or a genuine zombie still running past its
    // reclaimed lease) — a read-only "does a review already exist" lookup alone is a
    // check-then-publish race that two such attempts could both pass before either has
    // published. Whichever attempt's insert wins is the only one allowed to proceed.
    if (!claimReviewPublication(workItem.id)) {
      const already = await deps.github.findOwnReview({ cwd: worktreePath, number: issue.prNumber, headSha, marker });
      await bestEffortRemove(issue.repo, worktreePath);
      if (!already) return { kind: "publish_failed" };
      createIssueArtifact({
        issueId: issue.id,
        workerSessionId: sessionId,
        kind: "review_published",
        author: "system",
        content: { event: already, usedCommentFallback: already !== requestedEvent, verdict: result.verdict, viaConcurrentAttempt: true },
      });
      return { kind: "verdict", result };
    }

    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-review-body-"));
    const bodyFilePath = path.join(bodyDir, "body.md");
    fs.writeFileSync(bodyFilePath, renderReviewBody(result, marker));
    const published = await deps.github.publishReview({
      cwd: worktreePath,
      number: issue.prNumber,
      headSha,
      marker,
      event: requestedEvent,
      bodyFilePath,
    });
    fs.rmSync(bodyDir, { recursive: true, force: true });
    if (!published.ok) {
      await bestEffortRemove(issue.repo, worktreePath);
      return { kind: "publish_failed" };
    }

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
}
