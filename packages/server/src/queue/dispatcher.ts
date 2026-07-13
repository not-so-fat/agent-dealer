import type {
  PlanAnswer,
  PlanAnswersInput,
  PlanContent,
  PlanGateDecision,
  PlanTriageContent,
  Run,
  RunStatus,
} from "@agent-dealer/shared";
import { canTransition, planGateDecision } from "@agent-dealer/shared";
import {
  buildPlanEditedReplanPrompt,
  buildPlanFeedbackPrompt,
  buildPlanRevisePrompt,
} from "../runners/prompts.js";
import {
  addArtifact,
  countByStatus,
  getLatestArtifact,
  getRun,
  listArtifacts,
  listRuns,
  markPlanTriageConsumed,
  patchRunPhaseBudget,
  transitionRun,
  updateRunFields,
} from "../repository/runs.js";
import { runAgent, killRunProcess } from "../runners/claude.js";
import { persistRunOutput, seedDeliverableFromParent } from "../runners/persist.js";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { pollLinearIssues } from "../adapters/external.js";
import { syncLinearForRun } from "../adapters/linear-sync.js";
import { pendingSendCount } from "../repository/outbound-drafts.js";
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
  awaitingAnswerRuns: Run[];
  openQuestionCounts: Record<string, number>;
  pendingSendCounts: Record<string, number>;
  sentRunIds: string[];
  autoApprovedRunIds: string[];
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
let healthCache: { at: number; agentDeckOnline: boolean; agents: AgentWithHealth[] } | null = null;

const HEALTH_CACHE_MS = 15_000;
const MAX_PLAN_ATTEMPTS = Number(process.env.MAX_PLAN_ATTEMPTS ?? 3);
const EMPTY_PLAN_ERROR = "Agent did not return a plan";

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

/** Open (unanswered, unconsumed) question count for a plan_pending run. */
function openQuestionCount(runId: string): number {
  const tri = getLatestArtifact(runId, "plan_triage");
  if (!tri?.contentJson) return 0;
  try {
    const c = JSON.parse(tri.contentJson) as { questions?: unknown[]; consumed?: boolean };
    if (c.consumed || !c.questions?.length) return 0;
    const ans = getLatestArtifact(runId, "plan_answers");
    if (ans && ans.createdAt > tri.createdAt) return 0;
    return c.questions.length;
  } catch {
    return 0;
  }
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

  const openQuestionCounts: Record<string, number> = {};
  for (const run of awaitingPlanReview) {
    const n = openQuestionCount(run.id);
    if (n > 0) openQuestionCounts[run.id] = n;
  }
  const awaitingAnswerRuns = awaitingPlanReview.filter((r) => openQuestionCounts[r.id]);
  const pendingSendCounts: Record<string, number> = {};
  for (const run of resultReviewRuns) {
    const n = pendingSendCount(run.id);
    if (n > 0) pendingSendCounts[run.id] = n;
  }
  const autoApprovedRunIds = [...waitingExecution, ...runningRuns]
    .filter((r) => getLatestArtifact(r.id, "approved_plan")?.author === "system")
    .map((r) => r.id);
  const sentRunIds = recentDone
    .filter((r) => getLatestArtifact(r.id, "send_receipt"))
    .map((r) => r.id);

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
    awaitingAnswerRuns,
    openQuestionCounts,
    pendingSendCounts,
    sentRunIds,
    autoApprovedRunIds,
    runs: all,
    agentDeckOnline: false,
    agents: [],
    agentIssueCount: 0,
  };
}

export async function getSnapshotAsync(): Promise<QueueSnapshotInternal> {
  const snap = getSnapshot();
  const now = Date.now();
  if (!healthCache || now - healthCache.at > HEALTH_CACHE_MS) {
    healthCache = {
      at: now,
      agentDeckOnline: await checkAgentDeckHealth(),
      agents: await listAgentsWithHealth(listAgents()),
    };
  }
  snap.agentDeckOnline = healthCache.agentDeckOnline;
  snap.agents = healthCache.agents;
  snap.agentIssueCount = snap.agents.filter((a) => !a.healthy).length;
  return snap;
}

/** Fail runs left in `running` after a server restart or crash. */
export function recoverOrphanedRuns(): number {
  let count = 0;
  for (const run of listRuns("running" as RunStatus)) {
    transitionRun(run.id, "failed");
    addArtifact(
      run.id,
      "feedback",
      { error: "Server restarted mid-run — retry from failed", recoverable: true },
      "system"
    );
    count++;
  }
  return count;
}

function reconcileOrphanedRunning(): void {
  for (const run of listRuns("running" as RunStatus)) {
    if (activeRuns.has(run.id)) continue;
    transitionRun(run.id, "failed");
    addArtifact(
      run.id,
      "feedback",
      { error: "Run lost active worker — marked failed", recoverable: true },
      "system"
    );
  }
}

function priorEmptyPlanAttempts(runId: string): number {
  return listArtifacts(runId).filter((a) => {
    if (a.kind !== "feedback" || !a.contentJson) return false;
    try {
      const c = JSON.parse(a.contentJson) as { error?: string };
      return c.error === EMPTY_PLAN_ERROR;
    } catch {
      return false;
    }
  }).length;
}

export function cancelActiveRun(runId: string): void {
  killRunProcess(runId);
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
  reconcileOrphanedRunning();
  await dispatchPlanDrafts();

  const running = countByStatus("running");
  const slots = maxConcurrent() - running;
  if (slots <= 0) return;

  const approved = sortQueueFifo(listRuns("plan_approved" as RunStatus));
  for (const run of approved.slice(0, slots)) {
    if (activeRuns.has(run.id)) continue;
    const job = executeRun(run)
      .catch((e) => console.error("[execute]", run.id, e))
      .finally(() => {
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

function priorQuestionRounds(runId: string, currentTriageArtifactId: string): number {
  return listArtifacts(runId).filter((a) => {
    if (a.kind !== "plan_triage" || a.id === currentTriageArtifactId || !a.contentJson) return false;
    try {
      const c = JSON.parse(a.contentJson) as { questions?: unknown[] };
      return (c.questions?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }).length;
}

/** Self-triage gate after a plan draft persists (PRD F2). Exported for tests. */
export function applyPlanGate(run: Run): PlanGateDecision {
  const art = getLatestArtifact(run.id, "plan_triage");
  if (!art?.contentJson) return "await_review";
  let triage: PlanTriageContent;
  try {
    triage = JSON.parse(art.contentJson) as PlanTriageContent;
  } catch {
    return "await_review";
  }
  const decision = planGateDecision({
    triage,
    priorQuestionRounds: priorQuestionRounds(run.id, art.id),
  });
  if (decision !== "auto_approve") return decision;

  const fresh = getRun(run.id);
  if (!fresh || fresh.status !== "plan_pending") return "await_review";
  const draft = getLatestArtifact(run.id, "draft_plan");
  if (!draft?.contentJson) return "await_review";

  let plan: PlanContent;
  try {
    plan = JSON.parse(draft.contentJson) as PlanContent;
  } catch {
    return "await_review";
  }
  addArtifact(run.id, "approved_plan", { ...plan, autoApproved: true, rationale: triage.rationale }, "system");
  transitionRun(run.id, "plan_approved");
  void forceDispatch();
  return "auto_approve";
}

export async function draftPlan(
  run: Run,
  opts?: { replace?: boolean; revise?: { resumeSessionId?: string; prompt: string } }
): Promise<Run> {
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
    const result = await runAgent(updated, "plan", opts?.revise);
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
      const triage = persisted.planTriage;
      if (triage) {
        addArtifact(
          updated.id,
          "plan_triage",
          {
            verdict: triage.verdict,
            rationale: triage.rationale,
            questions: triage.questions,
            sessionId: persisted.sessionId,
            parseFallback: triage.parseFallback,
            consumed: false,
          },
          "agent"
        );
        applyPlanGate(getRun(run.id)!);
      }
    } else if (!opts?.replace) {
      addArtifact(updated.id, "feedback", { error: EMPTY_PLAN_ERROR }, "system");
    }

    const emptyPlanExhausted =
      !persisted.planMarkdown &&
      !opts?.replace &&
      priorEmptyPlanAttempts(updated.id) >= MAX_PLAN_ATTEMPTS;
    const planFailed =
      result.timedOut ||
      emptyPlanExhausted ||
      (!persisted.planMarkdown && result.exitCode !== 0);
    if (planFailed) {
      const stillActive = getRun(run.id);
      if (stillActive && (stillActive.status === "plan_pending" || stillActive.status === "queued")) {
        transitionRun(run.id, "failed");
        addArtifact(
          run.id,
          "feedback",
          {
            error: result.timedOut
              ? "Planning timed out"
              : emptyPlanExhausted
                ? `Planning failed after ${MAX_PLAN_ATTEMPTS} empty results`
                : "Planning failed",
            exitCode: result.exitCode,
          },
          "system"
        );
      }
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

export type SubmitAnswersResult =
  | { ok: true; outcome: "approved" | "redraft"; run: Run }
  | { ok: false; code: 400 | 404 | 409; error: string };

/** Answer open plan questions (PRD F3). Structured answers approve + dispatch; free-form revises the plan. */
export function submitPlanAnswers(
  runId: string,
  input: PlanAnswersInput,
  opts?: { onRedraft?: (run: Run, triage: PlanTriageContent, answers: PlanAnswer[]) => void }
): SubmitAnswersResult {
  const run = getRun(runId);
  if (!run) return { ok: false, code: 404, error: "Not found" };
  if (run.status !== "plan_pending") {
    return { ok: false, code: 409, error: `No open questions — run is ${run.status}` };
  }

  const triageArt = getLatestArtifact(runId, "plan_triage");
  if (!triageArt?.contentJson) return { ok: false, code: 409, error: "No open questions" };
  let triage: PlanTriageContent;
  try {
    triage = JSON.parse(triageArt.contentJson) as PlanTriageContent;
  } catch {
    return { ok: false, code: 409, error: "No open questions" };
  }
  if (triage.consumed || triage.questions.length === 0) {
    return { ok: false, code: 409, error: "No open questions" };
  }
  const priorAnswers = getLatestArtifact(runId, "plan_answers");
  if (priorAnswers && priorAnswers.createdAt > triageArt.createdAt) {
    return { ok: false, code: 409, error: "Questions already answered" };
  }

  const expected = triage.questions.map((q) => q.id).sort().join(",");
  const got = input.answers.map((a) => a.questionId).sort().join(",");
  if (expected !== got) {
    return { ok: false, code: 400, error: "Answers must cover every open question exactly once" };
  }

  const freeForm = input.answers.some((a) => a.freeText);
  const outcome = freeForm ? ("redraft" as const) : ("approved" as const);

  addArtifact(
    runId,
    "plan_answers",
    { answers: input.answers, outcome, answeredAt: new Date().toISOString() },
    "human"
  );

  if (!freeForm) {
    // null/empty = "Default" — do not wipe a seeded execute_model; only set explicit picks
    if (input.executeModel?.trim()) {
      updateRunFields(runId, { execute_model: input.executeModel.trim() });
    }
    if (input.executeBudget !== undefined) {
      patchRunPhaseBudget(runId, "execute", input.executeBudget);
    }

    markPlanTriageConsumed(runId);
    try {
      transitionRun(runId, "plan_approved");
    } catch (e) {
      return { ok: false, code: 409, error: String(e) };
    }
    const draft = getLatestArtifact(runId, "draft_plan");
    let plan: PlanContent = { markdown: "" };
    if (draft?.contentJson) {
      try {
        plan = JSON.parse(draft.contentJson) as PlanContent;
      } catch {
        return { ok: false, code: 409, error: "Draft plan is unreadable — request a re-draft" };
      }
    }
    addArtifact(runId, "approved_plan", plan, "human");
    void forceDispatch();
    return { ok: true, outcome, run: getRun(runId)! };
  }

  (opts?.onRedraft ?? scheduleRevisePlan)(getRun(runId)!, triage, input.answers);
  return { ok: true, outcome, run: getRun(runId)! };
}

function scheduleRevisePlan(run: Run, triage: PlanTriageContent, answers: PlanAnswer[]): void {
  if (activePlanDrafts.has(run.id)) return;
  activePlanDrafts.add(run.id);
  void draftPlan(run, {
    replace: true,
    revise: {
      resumeSessionId: triage.sessionId,
      prompt: buildPlanRevisePrompt(run, triage.questions, answers),
    },
  })
    .catch((e) => console.error("[plan-revise]", run.id, e))
    .finally(() => {
      activePlanDrafts.delete(run.id);
      notify().catch(console.error);
    });
}

/** Fire-and-forget: human requested a new agent plan (replaces draft). */
export function scheduleRedraft(
  run: Run,
  opts?: { feedback?: string; editedMarkdown?: string }
): boolean {
  if (activePlanDrafts.has(run.id)) return false;
  if (run.status !== "plan_pending" && run.status !== "queued") return false;
  if (!run.runtime) return false;

  const feedback = opts?.feedback?.trim();
  const editedMarkdown = opts?.editedMarkdown?.trim();
  let revise: { resumeSessionId?: string; prompt: string } | undefined;
  if (editedMarkdown) {
    const draft = getLatestArtifact(run.id, "draft_plan");
    const sessionId = draft?.contentJson
      ? (JSON.parse(draft.contentJson) as PlanContent).sessionId
      : undefined;
    revise = {
      resumeSessionId: sessionId,
      prompt: buildPlanEditedReplanPrompt(run, editedMarkdown),
    };
  } else if (feedback) {
    const draft = getLatestArtifact(run.id, "draft_plan");
    const sessionId = draft?.contentJson
      ? (JSON.parse(draft.contentJson) as PlanContent).sessionId
      : undefined;
    revise = {
      resumeSessionId: sessionId,
      prompt: buildPlanFeedbackPrompt(run, feedback),
    };
  }

  activePlanDrafts.add(run.id);
  void draftPlan(run, { replace: true, ...(revise ? { revise } : {}) })
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

    const after = getRun(run.id);
    if (!after || after.status === "cancelled") {
      await notify();
      return;
    }

    const persisted = persistRunOutput({
      run,
      phase: "execute",
      runtime: rt,
      exitCode: result.exitCode,
      logPath: result.logPath,
      rawTranscript: result.transcript,
    });

    const current = getRun(run.id);
    if (!current || current.status === "cancelled") {
      await notify();
      return;
    }

    if (result.timedOut) {
      transitionRun(run.id, "failed");
      addArtifact(
        run.id,
        "feedback",
        { error: "Execution timed out", exitCode: result.exitCode, logPath: result.logPath },
        "system"
      );
    } else if (result.exitCode === 0 && !persisted.blocked) {
      const updated = transitionRun(run.id, "review");
      syncLinearForRun(updated, "review").catch((e) => console.error("[linear-sync] review:", e));
    } else if (canTransition(current.status, "failed")) {
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
    const after = getRun(run.id);
    if (after && after.status !== "cancelled" && canTransition(after.status, "failed")) {
      transitionRun(run.id, "failed");
      addArtifact(run.id, "feedback", { error: String(err) }, "system");
    }
  }
  await notify();
}

export async function forceDispatch(): Promise<void> {
  await dispatch();
}
