import type { Run, RunStatus } from "@agent-dealer/shared";
import {
  addArtifact,
  countByStatus,
  getLatestArtifact,
  getRun,
  listRuns,
  transitionRun,
} from "../repository/runs.js";
import { runAgent } from "../runners/claude.js";
import { persistRunOutput, seedDeliverableFromParent } from "../runners/persist.js";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { pollLinearIssues } from "../adapters/external.js";
import { syncLinearForRun } from "../adapters/linear-sync.js";
import { listAgentsWithHealth } from "../adapters/agent-health.js";
import { listAgents } from "../repository/agents.js";
import { runReflect, type ReflectOpts } from "../runners/reflect.js";
import type { AgentWithHealth } from "@agent-dealer/shared";

type SnapshotListener = (snapshot: QueueSnapshotInternal) => void;

export interface QueueSnapshotInternal {
  planReviewCount: number;
  resultReviewCount: number;
  maxConcurrent: number;
  planningActiveRuns: Run[];
  planningQueuedRuns: Run[];
  runningRuns: Run[];
  waitingExecution: Run[];
  resultReviewRuns: Run[];
  recentDone: Run[];
  awaitingPlanReview: Run[];
  runs: Run[];
  agentDeckOnline: boolean;
  agents: AgentWithHealth[];
  agentIssueCount: number;
}

const activeRuns = new Map<string, Promise<void>>();
const activePlanDrafts = new Set<string>();
const activeReflects = new Set<string>();
let listeners: SnapshotListener[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchTimer: ReturnType<typeof setInterval> | null = null;

function maxConcurrent(): number {
  return Number(process.env.MAX_CONCURRENT_RUNS ?? 2);
}

function runtimeFor(run: Run): "claude_code" | "cursor_local" {
  return run.runtime ?? "claude_code";
}

function needsPlanDraft(run: Run): boolean {
  if (run.status !== "plan_pending" && run.status !== "queued") return false;
  if (!run.runtime) return false;
  if (getLatestArtifact(run.id, "draft_plan")) return false;
  if (activePlanDrafts.has(run.id)) return false;
  return true;
}

function sortQueueFifo(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function listPlanningPhaseRuns(): Run[] {
  return sortQueueFifo(
    listRuns("queued" as RunStatus).concat(listRuns("plan_pending" as RunStatus))
  );
}

/** Plan written and idle — human review lane (excludes active re-draft). */
function isReadyForPlanReview(run: Run): boolean {
  return (
    run.status === "plan_pending" &&
    !!getLatestArtifact(run.id, "draft_plan") &&
    !activePlanDrafts.has(run.id)
  );
}

export function getSnapshot(): QueueSnapshotInternal {
  const all = listRuns();
  const runningRuns = all.filter((r) => r.status === "running");
  const waitingExecution = sortQueueFifo(all.filter((r) => r.status === "plan_approved"));
  const resultReviewRuns = all
    .filter((r) => r.status === "review" || r.status === "failed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recentDone = all
    .filter((r) => r.status === "done")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);

  const planningPhase = listPlanningPhaseRuns();
  const awaitingPlanReview = planningPhase.filter(isReadyForPlanReview);
  const planningActiveRuns = planningPhase.filter((r) => activePlanDrafts.has(r.id));
  const planningQueuedRuns = planningPhase.filter(
    (r) => !activePlanDrafts.has(r.id) && !isReadyForPlanReview(r)
  );

  return {
    planReviewCount: awaitingPlanReview.length,
    resultReviewCount: resultReviewRuns.length,
    maxConcurrent: maxConcurrent(),
    planningActiveRuns,
    planningQueuedRuns,
    runningRuns,
    waitingExecution,
    resultReviewRuns,
    recentDone,
    awaitingPlanReview,
    runs: all,
    agentDeckOnline: false,
    agents: [],
    agentIssueCount: 0,
  };
}

export async function getSnapshotAsync(): Promise<QueueSnapshotInternal> {
  const snap = getSnapshot();
  snap.agentDeckOnline = await checkAgentDeckHealth();
  snap.agents = await listAgentsWithHealth(listAgents());
  snap.agentIssueCount = snap.agents.filter((a) => !a.healthy).length;
  return snap;
}

export function subscribe(listener: SnapshotListener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

async function notify(): Promise<void> {
  const snap = await getSnapshotAsync();
  for (const l of listeners) l(snap);
}

export function startQueue(): void {
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

  if (!pollTimer) {
    pollTimer = setInterval(() => {
      pollLinearIssues().catch((e) => console.error("[linear]", e));
    }, pollMs);
    pollLinearIssues().catch((e) => console.error("[linear]", e));
  }

  if (!dispatchTimer) {
    dispatchTimer = setInterval(() => {
      dispatch().catch((e) => console.error("[queue]", e));
    }, 3000);
    dispatch().catch((e) => console.error("[queue]", e));
  }
}

export function stopQueue(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (dispatchTimer) clearInterval(dispatchTimer);
  pollTimer = null;
  dispatchTimer = null;
}

/** Fire-and-forget: agent drafts plan after task intake. */
export function schedulePlanDraft(run: Run): void {
  if (!needsPlanDraft(run)) return;
  if (activePlanDrafts.has(run.id)) return;
  activePlanDrafts.add(run.id);
  void draftPlan(run)
    .catch((e) => console.error("[plan-draft]", run.id, e))
    .finally(() => {
      activePlanDrafts.delete(run.id);
      notify().catch(console.error);
    });
}

/** Fire-and-forget: post-review playbook reflect (D3 learning loop). */
export function scheduleReflect(run: Run, opts: ReflectOpts): void {
  if (!run.playbookId || !run.deckId) return;
  if (activeReflects.has(run.id)) return;
  void (async () => {
    const online = await checkAgentDeckHealth();
    if (!online) return;
    activeReflects.add(run.id);
    try {
      await runReflect(run, opts);
    } catch (e) {
      console.error("[reflect]", run.id, e);
    } finally {
      activeReflects.delete(run.id);
      notify().catch(console.error);
    }
  })();
}

async function dispatchPlanDrafts(): Promise<void> {
  const pending = listRuns("plan_pending" as RunStatus).concat(listRuns("queued" as RunStatus));
  const slots = maxConcurrent() - activePlanDrafts.size;
  if (slots <= 0) return;

  for (const run of pending) {
    if (!needsPlanDraft(run)) continue;
    if (activePlanDrafts.size >= maxConcurrent()) break;
    activePlanDrafts.add(run.id);
    void draftPlan(run)
      .catch((e) => console.error("[plan-draft]", run.id, e))
      .finally(() => {
        activePlanDrafts.delete(run.id);
        notify().catch(console.error);
      });
  }
}

async function dispatch(): Promise<void> {
  await dispatchPlanDrafts();

  const running = countByStatus("running");
  const slots = maxConcurrent() - running;
  if (slots <= 0) return;

  const approved = sortQueueFifo(listRuns("plan_approved" as RunStatus));
  for (const run of approved.slice(0, slots)) {
    if (activeRuns.has(run.id)) continue;
    const job = executeRun(run).finally(() => {
      activeRuns.delete(run.id);
      notify().catch(console.error);
    });
    activeRuns.set(run.id, job);
  }
  await notify();
}

export async function kickRun(run: Run): Promise<void> {
  if (run.status !== "plan_approved") {
    throw new Error(`Run must be plan_approved to kick, got ${run.status}`);
  }
  await dispatch();
}

export async function draftPlan(run: Run, opts?: { replace?: boolean }): Promise<Run> {
  if (run.status === "queued") {
    transitionRun(run.id, "plan_pending");
  }
  const updated = getRun(run.id)!;
  if (!updated.runtime) {
    throw new Error("Select an agent runtime before planning");
  }

  if (!opts?.replace) {
    syncLinearForRun(updated, "planning_started").catch((e) =>
      console.error("[linear-sync] planning_started:", e)
    );
  }

  const rt = runtimeFor(updated);

  try {
    const result = await runAgent(updated, "plan");
    const persisted = persistRunOutput({
      run: updated,
      phase: "plan",
      runtime: rt,
      exitCode: result.exitCode,
      logPath: result.logPath,
      rawTranscript: result.transcript,
    });

    const after = getRun(run.id);
    if (!after || (after.status !== "plan_pending" && after.status !== "queued")) {
      // Human approved or run moved on while agent was still planning — ignore late result.
      await notify();
      return after ?? updated;
    }

    if (persisted.planMarkdown) {
      addArtifact(
        updated.id,
        "draft_plan",
        { markdown: persisted.planMarkdown, sessionId: persisted.sessionId },
        "agent",
        result.logPath
      );
    } else if (!opts?.replace) {
      addArtifact(updated.id, "feedback", { error: "Agent did not return a plan" }, "system");
    }

    const planFailed = !persisted.planMarkdown && result.exitCode !== 0;
    if (planFailed) {
      transitionRun(run.id, "failed");
      addArtifact(run.id, "feedback", { error: "Planning failed", exitCode: result.exitCode }, "system");
    }
  } catch (err) {
    const after = getRun(run.id);
    if (after && (after.status === "plan_pending" || after.status === "queued")) {
      transitionRun(run.id, "failed");
      addArtifact(run.id, "feedback", { error: String(err) }, "system");
    }
  }

  await notify();
  return getRun(run.id)!;
}

/** Fire-and-forget: human requested a new agent plan (replaces draft). */
export function scheduleRedraft(run: Run): boolean {
  if (activePlanDrafts.has(run.id)) return false;
  if (run.status !== "plan_pending" && run.status !== "queued") return false;
  if (!run.runtime) return false;

  activePlanDrafts.add(run.id);
  void draftPlan(run, { replace: true })
    .catch((e) => console.error("[plan-redraft]", run.id, e))
    .finally(() => {
      activePlanDrafts.delete(run.id);
      notify().catch(console.error);
    });
  return true;
}

/** Human requested a new agent plan (replaces draft). @deprecated prefer scheduleRedraft */
export async function redraftPlan(run: Run): Promise<Run> {
  return draftPlan(run, { replace: true });
}

async function executeRun(run: Run): Promise<void> {
  const rt = runtimeFor(run);
  try {
    seedDeliverableFromParent(run);
    transitionRun(run.id, "running");
    await notify();

    const result = await runAgent(run, "execute");
    const persisted = persistRunOutput({
      run,
      phase: "execute",
      runtime: rt,
      exitCode: result.exitCode,
      logPath: result.logPath,
      rawTranscript: result.transcript,
    });

    if (result.exitCode === 0 && !persisted.blocked) {
      const updated = transitionRun(run.id, "review");
      syncLinearForRun(updated, "review").catch((e) => console.error("[linear-sync] review:", e));
    } else {
      transitionRun(run.id, "failed");
      addArtifact(
        run.id,
        "feedback",
        {
          error: persisted.blocked ? "Execution blocked" : "Execution failed",
          exitCode: result.exitCode,
          blocker: persisted.blockerSummary,
        },
        "system"
      );
    }
  } catch (err) {
    transitionRun(run.id, "failed");
    addArtifact(run.id, "feedback", { error: String(err) }, "system");
  }
  await notify();
}

export async function forceDispatch(): Promise<void> {
  await dispatch();
}
