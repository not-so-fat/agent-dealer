// packages/server/src/routes/issues.ts
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  CreateIssueInput,
  type CreateIssueResult,
  type ExecuteIssueResponse,
  type ExistingIssueConflict,
  type Issue,
  IssueStatus,
  UpdateIssueInput,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { createIssue, getIssue, listIssues, findActiveIssueByExternalId, listIssuesByExternalId, updateIssue, listRecentRepos } from "../repository/issues.js";
import { listWorkerSessionsForIssue, getActiveWorkerSessionForIssue } from "../repository/worker-sessions.js";
import { getIssueArtifact, listArtifactsForIssue } from "../repository/artifacts-for-issue.js";
import { listUsageEventsForIssue, summarizeIssueUsage } from "../repository/usage-events.js";
import {
  listWorkflowEventsForIssue,
  appendWorkflowEvent,
  listWorkflowInstancesForIssue,
  getActiveWorkflowInstance,
} from "../repository/workflow-events.js";
import { listHumanActionsForIssue, listOpenHumanActions } from "../repository/human-actions.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { abortIssueAsync, canEditParkedIssue, checkIssueReadiness } from "../coordinator/commands.js";
import {
  executeIssueNow,
  isStartable,
  queueStatusForIssue,
  refreshQueueWaitReasonForIssue,
  startIssueViaQueue,
} from "../coordinator/admission.js";
import { computeHumanWaitMs } from "../coordinator/metrics.js";
import { enqueueIssue, enqueueIssueWithOutcome, getQueuedEntryForIssue } from "../repository/queue-entries.js";
import { latestSessionFailureForIssue } from "../coordinator/latest-failure.js";
import { deriveLiveProgressFromLog } from "../coordinator/session-progress.js";
import { branchTipStatusForIssue } from "../coordinator/branch-tip-status.js";

const TRACE_DEFAULT_MAX_CHARS = 50_000;
const TRACE_HARD_MAX_CHARS = 200_000;
/** NOT-185: the only fields PATCH accepts at an open attempts_exhausted park. */
const PARKED_EDITABLE_FIELDS: ReadonlySet<string> = new Set(["title", "description", "acceptanceCriteria"]);

/** Non-numeric, non-finite, zero, or negative all fall back to the default rather than
 * disabling the cap — `Number("not-a-number")` is NaN, and `Math.min(NaN, N)` is NaN,
 * which made the original `.slice(-NaN)` behave as `.slice(0)` (the whole file). */
function parseTraceMaxChars(raw: string | undefined): number {
  const n = raw !== undefined ? Number(raw) : TRACE_DEFAULT_MAX_CHARS;
  if (!Number.isFinite(n) || n <= 0) return TRACE_DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(n), TRACE_HARD_MAX_CHARS);
}

/** Reads at most the last `maxChars` characters of a file without loading the whole
 * file into memory first: seeks to a byte offset sized for the worst case (4 bytes per
 * UTF-8 char) and reads only that tail, so a very large trace file never blocks the
 * event loop or bloats the response regardless of `maxChars`. */
function readTraceTail(filePath: string, maxChars: number): string {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - maxChars * 4);
  const length = size - start;
  if (length <= 0) return "";
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString("utf8").slice(-maxChars);
}

export async function registerIssueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/issues", async (req) => {
    const status = (req.query as { status?: string }).status;
    const issues = status ? listIssues(status.split(",") as IssueStatus[]) : listIssues();
    const openActionIssueIds = new Set(listOpenHumanActions().map((a) => a.issueId));
    return issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      currentOwner: issue.currentOwner,
      currentIntent: issue.currentIntent,
      updatedAt: issue.updatedAt,
      hasOpenHumanAction: openActionIssueIds.has(issue.id),
    }));
  });

  /** Recent portable GitHub repo identities (legacy local paths excluded from create UI). */
  app.get("/api/issues/recent-repos", async () => {
    return { repos: listRecentRepos() };
  });

  app.get("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const humanActions = listHumanActionsForIssue(id);
    const instances = listWorkflowInstancesForIssue(id);
    const activeWorkerSession = getActiveWorkerSessionForIssue(id);
    const latestSessionFailure = latestSessionFailureForIssue(issue);
    // NOT-148: commits-ahead / restart-risk / dirty-preserve next to live progress while developing/retrying.
    const branchTipStatus = await branchTipStatusForIssue(issue, {
      hadFailedAttempt: issue.infraAttempts > 0 || latestSessionFailure != null,
      activeWorktreePath:
        activeWorkerSession?.status === "running" ? activeWorkerSession.worktreePath : null,
    });
    return {
      issue,
      timeline: listWorkflowEventsForIssue(id),
      humanActions,
      findings: listFindingsForIssue(id),
      usageSummary: summarizeIssueUsage(id),
      readiness: checkIssueReadiness(issue),
      humanWaitMs: computeHumanWaitMs(humanActions),
      interventionCount: humanActions.length,
      // Last element, not the active one: a completed/closed issue's duration is still
      // wall-clock start→completion of its (now-finished) workflow instance.
      latestWorkflowInstance: instances.length ? instances[instances.length - 1] : null,
      // NOT-109: live session strip while developing/reviewing.
      activeWorkerSession,
      // NOT-120: concrete log-tail progress for the live strip (null when idle / unparseable).
      liveProgress:
        activeWorkerSession?.status === "running" && activeWorkerSession.logPath
          ? deriveLiveProgressFromLog(activeWorkerSession.logPath)
          : null,
      // NOT-113: latest session failure reason without opening evidence JSON.
      latestSessionFailure,
      // NOT-148: tip progress + restart risk for the live / failure strip.
      branchTipStatus,
      // NOT-103: whether this issue is in the admission queue.
      queued: getQueuedEntryForIssue(id) != null,
      // NOT-118: position + current wait reason so a queued `ready` issue never reads as idle.
      queueEntry: queueStatusForIssue(id),
    };
  });

  app.get("/api/issues/:id/evidence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const { limit, before } = req.query as { limit?: string; before?: string };
    return {
      workerSessions: listWorkerSessionsForIssue(id),
      artifacts: listArtifactsForIssue(id, { limit: limit ? Number(limit) : undefined, before }),
      usageEvents: listUsageEventsForIssue(id),
    };
  });

  /** Tail an artifact's raw trace file (developer/reviewer transcript, etc.) — the
   * issue-scoped analog of GET /api/runs/:id/log-tail, which only serves legacy run ids.
   * The blobPath is never client-supplied: it's looked up from the artifact row, which
   * this codebase's own runner/effect code writes (paths under the temporal logs dir),
   * so this cannot be used to read an arbitrary file off the caller's request. */
  app.get("/api/issues/:id/artifacts/:artifactId/trace", async (req, reply) => {
    const { id, artifactId } = req.params as { id: string; artifactId: string };
    const artifact = getIssueArtifact(id, artifactId);
    if (!artifact) return reply.status(404).send({ error: "Not found" });
    if (!artifact.blobPath) return reply.status(404).send({ error: "This artifact has no raw trace" });
    if (!fs.existsSync(artifact.blobPath)) return reply.status(404).send({ error: "Trace file missing on disk" });
    const max = parseTraceMaxChars((req.query as { max?: string }).max);
    return { content: readTraceTail(artifact.blobPath, max), path: artifact.blobPath, kind: artifact.kind };
  });

  app.post("/api/issues", async (req, reply) => {
    const parsed = CreateIssueInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const input = parsed.data;
    // Terminal passes already on record for this ticket — 0 for a manual create. Reported
    // back so "this is the second pass on NOT-128" never reads like a first import.
    let priorPasses = 0;
    if (input.externalId) {
      // NOT-141: the guard is scoped to *live* issues, mirroring runs' findActiveByExternalId.
      // A terminal (`done`/`closed`) row falls through to create a second, independent issue
      // for the same ticket — a regression, a follow-up, or a retry of an abandoned pass —
      // rather than making the ticket single-use for the lifetime of the database.
      const existing = findActiveIssueByExternalId(input.source, input.externalId);
      priorPasses = listIssuesByExternalId(input.source, input.externalId).length;
      if (existing) {
        // Re-import of a ticket already in flight: never a duplicate row, and never a bare
        // 200 the caller cannot interpret. A still-startable issue goes back in the queue, so
        // a repeated "kick from Linear" is not a silent no-op; `isStartable` is admission's
        // own predicate — enqueueing anything it would reject (a running issue, a
        // `final_review` one awaiting a merge call) parks a row that can never be admitted.
        if (input.enqueue && isStartable(existing)) {
          // `queue` is the mutation, not the request: enqueue is idempotent, so an issue that
          // was already waiting is reported as `already_queued`. Saying "enqueued" there is
          // the same lie the CLI used to tell off the request flag.
          const { created: queued } = enqueueIssueWithOutcome(existing.id);
          return {
            ...existing,
            created: false,
            queue: queued ? "enqueued" : "already_queued",
            priorPasses,
          } satisfies CreateIssueResult;
        }
        // Anything else is a real conflict: say which issue holds the ticket and in what
        // state, the way POST /api/intake/linear/:issueId/promote answers with its run id.
        return reply.status(409).send({
          error: `Issue ${existing.id} is already tracking ${input.source} ${input.externalId} (${existing.status})`,
          existingIssueId: existing.id,
          existingIssueStatus: existing.status,
        } satisfies ExistingIssueConflict);
      }
    }
    const issue = createIssue(input);
    appendWorkflowEvent({ issueId: issue.id, type: "issue.created", actorType: "human", stage: issue.status });
    // NOT-118: create enqueues, it never starts. Server-side so the UI, CLI and agents all
    // behave the same — callers hold no workflow logic. `enqueue: false` creates a draft.
    // A row this request just wrote cannot already be queued, so the outcome is decided by
    // the directive alone.
    if (input.enqueue) enqueueIssue(issue.id);
    return {
      ...issue,
      created: true,
      queue: input.enqueue ? "enqueued" : "not_queued",
      priorPasses,
    } satisfies CreateIssueResult;
  });

  app.patch("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const parsed = UpdateIssueInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    // Editable only pre-start or parked back on needs_human — the same statuses
    // startWorkflow itself accepts (commands.ts). A running workflow owns the frozen
    // task snapshot (freezeTaskSnapshot), so an edit must never race or diverge from
    // what a queued/running session already saw — and "no active instance" alone isn't
    // enough to allow it: a completed/closed issue also has none, but its history must
    // stay immutable too.
    //
    // NOT-217: the guard runs twice — once here for the fast path, once inside the
    // write transaction below. An admission between the two (the editor open while the
    // issue starts elsewhere) must answer 409 and never mutate the frozen snapshot.
    const guardConflict = (fresh: Issue): string | null => {
      if (fresh.status !== "ready" && fresh.status !== "needs_human") {
        return `Cannot edit an issue that is ${fresh.status}`;
      }
      // NOT-185: the one active-workflow exception — parked at an open attempts_exhausted
      // action with nothing pending/leased. Retry re-freezes the snapshot from these fields.
      if (getActiveWorkflowInstance(id)) {
        if (!canEditParkedIssue(fresh)) {
          return "Cannot edit an issue with an active workflow";
        }
        // Only the fields the snapshot is frozen from may change at the park: the review budget,
        // repo/base branch, agents and autoMerge stay as the running workflow saw them.
        const blocked = Object.keys(parsed.data).filter((k) => !PARKED_EDITABLE_FIELDS.has(k));
        if (blocked.length > 0) {
          return `Only title, description and acceptanceCriteria can be edited while parked at attempts_exhausted (got: ${blocked.join(", ")})`;
        }
      }
      return null;
    };
    const fastPath = guardConflict(issue);
    if (fastPath) return reply.status(409).send({ error: fastPath });

    // Guard re-check + row write + `issue.reassigned` audit in one transaction, so an
    // edit that races admission fails closed instead of landing on a live snapshot.
    // Queue order is untouched (updateIssue never writes queue_entries) — position is
    // preserved by construction.
    let updated: Issue;
    try {
      updated = getDb().transaction((): Issue => {
        const fresh = getIssue(id);
        if (!fresh) throw Object.assign(new Error("Not found"), { code: 404 });
        const conflict = guardConflict(fresh);
        if (conflict) throw Object.assign(new Error(conflict), { code: 409 });
        const next = updateIssue(id, parsed.data);
        // NOT-217: durable reassignment audit — only when an assignment actually changed,
        // comparing against the freshly read row so a concurrent edit is attributed exactly.
        if (
          fresh.developerAgentId !== next.developerAgentId ||
          fresh.reviewerAgentId !== next.reviewerAgentId
        ) {
          appendWorkflowEvent({
            issueId: id,
            type: "issue.reassigned",
            actorType: "human",
            stage: next.status,
            payload: {
              fromDeveloperAgentId: fresh.developerAgentId,
              toDeveloperAgentId: next.developerAgentId,
              fromReviewerAgentId: fresh.reviewerAgentId,
              toReviewerAgentId: next.reviewerAgentId,
            },
          });
        }
        return next;
      })();
    } catch (err) {
      const code = (err as { code?: number }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 404) return reply.status(404).send({ error: message });
      if (code === 409) return reply.status(409).send({ error: message });
      throw err;
    }
    // NOT-217: a queued issue keeps its position; re-derive the visible wait reason now
    // that admission may see a different (e.g. healthy) agent.
    await refreshQueueWaitReasonForIssue(id);
    return updated;
  });

  /**
   * NOT-118: Start = move to front of the admission queue, then admit if a slot is free.
   * No bypass — a busy or not-yet-eligible issue answers `{ state: "queued", ... }` and is
   * the next one admitted, instead of piling up as another "in progress" issue.
   */
  app.post("/api/issues/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await startIssueViaQueue(id);
    if (result.state === "error") return reply.status(result.code).send({ error: result.error });
    return result;
  });

  /**
   * NOT-217 Execute now: strict direct admission — bypasses queue order only, never
   * capacity, readiness, blockers, agent health, or the frozen-snapshot guard. Refuses
   * with the reason (and the untouched queue state) instead of degrading into Run next:
   * no enqueue, no move, no reorder on any failure path.
   */
  app.post("/api/issues/:id/execute", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await executeIssueNow(id);
    if (result.state === "error") return reply.status(result.code).send({ error: result.error });
    if (result.state === "admitted") {
      return {
        state: "admitted",
        instance: result.instance,
        workItem: result.workItem,
      } satisfies ExecuteIssueResponse;
    }
    const queued = queueStatusForIssue(id);
    return reply.status(409).send({
      error: result.reason,
      state: "refused",
      reason: result.reason,
      queued: queued != null,
      position: queued?.position ?? null,
      waitReason: queued?.waitReason ?? null,
    } satisfies ExecuteIssueResponse & { error: string });
  });

  app.post("/api/issues/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolvedBy?: string } | undefined;
    const result = await abortIssueAsync(id, body?.resolvedBy?.trim() || "human");
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { issueStatus: result.issueStatus, alreadyClosed: result.alreadyClosed };
  });

  app.post("/api/issues/:id/guidance", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const { markdown } = req.body as { markdown: string };
    if (!markdown?.trim()) return reply.status(400).send({ error: "markdown is required" });
    const event = appendWorkflowEvent({ issueId: id, type: "guidance.added", actorType: "human", stage: issue.status, payload: { markdown } });
    return event;
  });
}
