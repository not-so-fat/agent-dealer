// packages/server/src/routes/issues.ts
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { CreateIssueInput, IssueStatus, UpdateIssueInput } from "@agent-dealer/shared";
import { createIssue, getIssue, listIssues, findIssueByExternalId, updateIssue, listRecentRepos } from "../repository/issues.js";
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
import { abortIssue, checkIssueReadiness } from "../coordinator/commands.js";
import { queueStatusForIssue, startIssueViaQueue } from "../coordinator/admission.js";
import { computeHumanWaitMs } from "../coordinator/metrics.js";
import { enqueueIssue, getQueuedEntryForIssue } from "../repository/queue-entries.js";
import { latestSessionFailureForIssue } from "../coordinator/latest-failure.js";
import { deriveLiveProgressFromLog } from "../coordinator/session-progress.js";

const TRACE_DEFAULT_MAX_CHARS = 50_000;
const TRACE_HARD_MAX_CHARS = 200_000;

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

  /** Recent local filesystem repo paths from prior issues (NOT-102 kick picker). */
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
      latestSessionFailure: latestSessionFailureForIssue(issue),
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
    if (input.externalId) {
      const existing = findIssueByExternalId(input.source, input.externalId);
      if (existing) {
        // Idempotent re-create of an already-imported issue: re-enqueue it when it is still
        // startable, so a repeated "kick from Linear" lands it back in the queue instead of
        // being a silent no-op. A terminal or already-running issue is left alone.
        const startable =
          existing.status !== "done" &&
          existing.status !== "closed" &&
          !getActiveWorkflowInstance(existing.id);
        if (input.enqueue && startable) enqueueIssue(existing.id);
        return existing;
      }
    }
    const issue = createIssue(input);
    appendWorkflowEvent({ issueId: issue.id, type: "issue.created", actorType: "human", stage: issue.status });
    // NOT-118: create enqueues, it never starts. Server-side so the UI, CLI and agents all
    // behave the same — callers hold no workflow logic. `enqueue: false` creates a draft.
    if (input.enqueue) enqueueIssue(issue.id);
    return issue;
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
    if (issue.status !== "ready" && issue.status !== "needs_human") {
      return reply.status(409).send({ error: `Cannot edit an issue that is ${issue.status}` });
    }
    if (getActiveWorkflowInstance(id)) {
      return reply.status(409).send({ error: "Cannot edit an issue with an active workflow" });
    }
    return updateIssue(id, parsed.data);
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

  app.post("/api/issues/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolvedBy?: string } | undefined;
    const result = abortIssue(id, body?.resolvedBy?.trim() || "human");
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
