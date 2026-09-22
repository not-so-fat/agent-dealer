import type {
  AdmissionStatus,
  AgentDeckStatus,
  AgentWithHealth,
  CreateAgentInput,
  CreateIssueInput,
  CreateIssueResult,
  DeckAccessErrorCode,
  ExecuteIssueResponse,
  ExecutionReportResponse,
  Finding,
  HumanAction,
  Issue,
  IssueExecutionAnalysis,
  IssueStatus,
  LinearCandidate,
  QueueMoveTarget,
  ReportFilterState,
  RuntimeCapacityResponse,
  RuntimeModelsResponse,
  StartIssueResponse,
  UpdateAgentInput,
  UpdateIssueInput,
  UsageEvent,
  WorkerSession,
  WorkflowEvent,
  WorkflowInstance,
} from "@agent-dealer/shared";
import { ExecutionReportResponse as ExecutionReportSchema, serializeExecutionReportQuery } from "@agent-dealer/shared";
import { clearCachedRuntimeModels, fetchRuntimeModelsDeduped } from "./lib/runtimeModelsCache";

const API = "";

async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { error?: string; message?: string };
    const raw = json.error ?? json.message;
    if (typeof raw === "string" && raw.trim()) {
      return raw.replace(/^Error:\s*/i, "");
    }
  } catch {
    // not json
  }
  return text;
}

export async function fetchLinearInbox(): Promise<LinearCandidate[]> {
  const res = await fetch(`${API}/api/intake/linear`);
  if (!res.ok) throw new Error(await res.text());
  const json = (await res.json()) as { candidates: LinearCandidate[] };
  return json.candidates ?? [];
}

export async function lookupLinearIssue(q: string): Promise<LinearCandidate> {
  const res = await fetch(`${API}/api/intake/linear/lookup?q=${encodeURIComponent(q)}`);
  const body = (await res.json().catch(() => ({}))) as { candidate?: LinearCandidate; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Lookup failed (${res.status})`);
  if (!body.candidate) throw new Error("Linear issue not found");
  return body.candidate;
}

export async function fetchAgents(): Promise<{ agents: AgentWithHealth[]; issueCount: number }> {
  const res = await fetch(`${API}/api/agents`);
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function createAgent(body: CreateAgentInput): Promise<AgentWithHealth> {
  const res = await fetch(`${API}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateAgent(id: string, body: UpdateAgentInput): Promise<AgentWithHealth> {
  const res = await fetch(`${API}/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${API}/api/agents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function fetchRuntimeModels(
  runtime: string,
  opts?: { refresh?: boolean }
): Promise<RuntimeModelsResponse> {
  const qs = opts?.refresh ? "?refresh=1" : "";
  if (opts?.refresh) clearCachedRuntimeModels(runtime);
  return fetchRuntimeModelsDeduped(runtime, async () => {
    const res = await fetch(`${API}/api/runtimes/${runtime}/models${qs}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  });
}

/** NOT-245: normalized per-runtime capacity (windows, freshness, N/A reasons). */
export async function fetchRuntimeCapacity(): Promise<RuntimeCapacityResponse> {
  const res = await fetch(`${API}/api/runtime-capacity`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAgentDeckStatus(): Promise<AgentDeckStatus> {
  const res = await fetch(`${API}/api/agent-deck/status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type DeckListResult =
  | { ok: true; decks: Array<{ id: string; name: string }> }
  | { ok: false; code?: DeckAccessErrorCode; message: string };

export async function fetchDecks(): Promise<DeckListResult> {
  try {
    const res = await fetch(`${API}/api/agent-deck/decks`);
    const json = (await res.json().catch(() => null)) as
      | { data?: Array<{ id: string; name: string }>; error?: string; code?: DeckAccessErrorCode }
      | null;
    if (!res.ok) {
      return { ok: false, code: json?.code, message: json?.error ?? `Agent Deck error (${res.status})` };
    }
    return { ok: true, decks: json?.data ?? [] };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export interface IssueListRow {
  id: string;
  title: string;
  status: IssueStatus;
  currentOwner: string;
  currentIntent: string | null;
  updatedAt: string;
  hasOpenHumanAction: boolean;
}

export interface IssueDetail {
  issue: Issue;
  timeline: WorkflowEvent[];
  humanActions: HumanAction[];
  findings: Finding[];
  usageSummary: { totalCostUsd: number; totalDurationMs: number; totalTokensIn: number; totalTokensOut: number };
  readiness: { ok: boolean; missing: string[] };
  humanWaitMs: number;
  interventionCount: number;
  latestWorkflowInstance: WorkflowInstance | null;
  /** Running worker session for the live strip (NOT-109); null when idle. */
  activeWorkerSession?: WorkerSession | null;
  /** NOT-120: concrete recent work from the session log tail; null when none yet. */
  liveProgress?: string | null;
  /** NOT-113: latest session failure reason for the detail strip. */
  latestSessionFailure?: {
    reason: string;
    when: string;
    role: string | null;
    outcome: string | null;
    sessionId: string | null;
    logPath: string | null;
    infraAttempts: number;
    maxInfraAttempts: number;
  } | null;
  /**
   * NOT-148: tip progress for Issue Detail live / failure strips.
   * - `tipLabel` / `commitsAhead`: commits past base, or "no tip yet" when empty/absent.
   * - `restartRisk`: true when a prior failure left an empty tip (cold-start retry).
   * - `worktree`: dirty/preserved leftover checkout when present (not live-session WIP).
   */
  branchTipStatus?: {
    branch: string;
    state: string;
    commitsAhead: number | null;
    tipLabel: string;
    restartRisk: boolean;
    worktree?: {
      path: string;
      dirty: boolean;
      preserved: boolean;
    } | null;
  } | null;
  /** NOT-103: whether this issue is in the admission queue. */
  queued?: boolean;
  /** NOT-118: queue position (1-based) and current wait reason while it is queued. */
  queueEntry?: { position: number; waitReason: string | null } | null;
}

export interface IssueEvidence {
  workerSessions: WorkerSession[];
  artifacts: Array<{
    id: string;
    kind: string;
    workerSessionId: string | null;
    contentJson: string | null;
    blobPath: string | null;
    author: string;
    createdAt: string;
  }>;
  usageEvents: UsageEvent[];
}

export async function fetchIssues(status?: IssueStatus[]): Promise<IssueListRow[]> {
  const qs = status?.length ? `?status=${status.join(",")}` : "";
  const res = await fetch(`${API}/api/issues${qs}`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** NOT-228: paginated Issues list fetch — applied filters plus `{ page, limit, total, totalPages }`. */
export interface IssuesListPageResult {
  issues: IssueListRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface IssuesListQuery {
  q?: string;
  status?: string;
  repo?: string;
  needsAttention?: boolean;
  page?: number;
}

export async function fetchIssuesPage(query: IssuesListQuery): Promise<IssuesListPageResult> {
  const qs = new URLSearchParams();
  if (query.q?.trim()) qs.set("q", query.q.trim());
  if (query.status?.trim()) qs.set("status", query.status.trim());
  if (query.repo?.trim()) qs.set("repo", query.repo.trim());
  if (query.needsAttention) qs.set("needsAttention", "1");
  // Always send the page so the server answers the paginated shape; page 1 is
  // still canonicalized out of the browser URL by the view-model.
  qs.set("page", String(query.page && query.page > 1 ? Math.floor(query.page) : 1));
  qs.sort();
  const res = await fetch(`${API}/api/issues?${qs.toString()}`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** Recent local repo paths from prior issues for the kick picker (NOT-102). */
export async function fetchRecentRepos(): Promise<string[]> {
  const res = await fetch(`${API}/api/issues/recent-repos`);
  if (!res.ok) throw new Error(await readApiError(res));
  const json = (await res.json()) as { repos: string[] };
  return json.repos ?? [];
}

export async function fetchIssueDetail(id: string): Promise<IssueDetail> {
  const res = await fetch(`${API}/api/issues/${id}`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchIssueExecutionAnalysis(id: string): Promise<IssueExecutionAnalysis> {
  const res = await fetch(`${API}/api/issues/${id}/execution-analysis`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchIssueEvidence(id: string): Promise<IssueEvidence> {
  const res = await fetch(`${API}/api/issues/${id}/evidence`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function fetchIssueArtifactTrace(
  issueId: string,
  artifactId: string
): Promise<{ content: string; path: string; kind: string }> {
  const res = await fetch(`${API}/api/issues/${issueId}/artifacts/${artifactId}/trace`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/**
 * NOT-141: the result carries `created` plus the `queue` outcome — a re-import that matched a
 * live issue re-queues it (`created: false`) instead of writing a second row, and reports
 * `already_queued` when the issue was waiting already and nothing changed. A match admission
 * cannot re-queue answers 409 naming the issue that holds the ticket, so `createIssue` throws.
 */
export async function createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
  const res = await fetch(`${API}/api/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function patchIssue(id: string, patch: UpdateIssueInput): Promise<Issue> {
  const res = await fetch(`${API}/api/issues/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** NOT-118: Start moves the issue to the front of the admission queue — there is no bypass,
 * so it either admits immediately or reports where it is waiting and why. */
export type StartIssueResult = StartIssueResponse;

export async function startIssue(id: string): Promise<StartIssueResult> {
  const res = await fetch(`${API}/api/issues/${id}/start`, { method: "POST" });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/**
 * NOT-217 Execute now: strict direct admission — bypasses queue order only. Resolves
 * when the workflow starts immediately; throws the server's refusal reason (capacity,
 * readiness, blockers, agent health) when it cannot run — the queue is never touched.
 */
export type ExecuteIssueResult = ExecuteIssueResponse;

export async function executeIssue(id: string): Promise<ExecuteIssueResult> {
  const res = await fetch(`${API}/api/issues/${id}/execute`, { method: "POST" });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export interface AbortIssueResult {
  issueStatus: IssueStatus;
  alreadyClosed: boolean;
}

export async function abortIssue(id: string, resolvedBy = "web"): Promise<AbortIssueResult> {
  const res = await fetch(`${API}/api/issues/${id}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolvedBy }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/**
 * NOT-239: intentionally retire a `ready` issue that should never run. Only
 * Issue Detail offers this (never list/queue rows or bulk actions): the server
 * closes it atomically (status → `closed`, queue entry removed, one
 * human-authored `issue.closed` event) and refuses anything in-flight.
 */
export interface CloseIssueResult {
  issueStatus: IssueStatus;
  alreadyClosed: boolean;
}

export async function closeIssue(id: string, closedBy = "web"): Promise<CloseIssueResult> {
  const res = await fetch(`${API}/api/issues/${id}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ closedBy }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function enqueueIssue(issueId: string): Promise<{
  id: string;
  issueId: string;
  position: number;
  state: string;
  waitReason: string | null;
}> {
  const res = await fetch(`${API}/api/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issueId }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function dequeueIssue(issueId: string): Promise<{ id: string; state: string }> {
  const res = await fetch(`${API}/api/queue/${issueId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** NOT-112: relative reorder — server computes positions. */
export async function moveQueueEntry(
  issueId: string,
  to: QueueMoveTarget
): Promise<QueueEntryRow> {
  const res = await fetch(`${API}/api/queue/${issueId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export interface QueueEntryRow {
  id: string;
  issueId: string;
  position: number;
  enqueuedAt: string;
  state: string;
  waitReason: string | null;
  waitReasonAt: string | null;
  title?: string | null;
  issueStatus?: string | null;
}

export async function fetchQueue(): Promise<QueueEntryRow[]> {
  const res = await fetch(`${API}/api/queue`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** NOT-215: truthful Admission read model — `N active · M waiting · limit X`. */
export type { AdmissionStatus };

export async function fetchQueueStatus(): Promise<AdmissionStatus> {
  const res = await fetch(`${API}/api/queue/status`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** NOT-215: operator-chosen active-issue limit (persisted server-side). */
export async function updateAdmissionSettings(maxActiveIssues: number): Promise<AdmissionStatus> {
  const res = await fetch(`${API}/api/queue/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxActiveIssues }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function guideIssue(id: string, markdown: string): Promise<WorkflowEvent> {
  const res = await fetch(`${API}/api/issues/${id}/guidance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** NOT-175: fleet execution-comparison report. Filters serialize with shared
 * defaults — an empty filter object requests the API's conservative window.
 * Served by GET /api/execution-report (NOT-173 owns /api/execution-analysis). */
export async function fetchExecutionAnalysis(filters: ReportFilterState): Promise<ExecutionReportResponse> {
  const qs = serializeExecutionReportQuery(filters);
  const res = await fetch(`${API}/api/execution-report${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await readApiError(res));
  const json = await res.json();
  const parsed = ExecutionReportSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Unexpected report shape: ${parsed.error.message}`);
  return parsed.data;
}

export async function fetchHumanActions(): Promise<HumanAction[]> {
  const res = await fetch(`${API}/api/human-actions`);
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export interface ResolveHumanActionResult {
  issueStatus: IssueStatus;
  nextWorkItemId: string | null;
  instanceCompleted: boolean;
  restarted: boolean;
}

export async function resolveHumanAction(
  id: string,
  resolvedBy: string,
  choice: string
): Promise<ResolveHumanActionResult> {
  const res = await fetch(`${API}/api/human-actions/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolvedBy, choice }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

