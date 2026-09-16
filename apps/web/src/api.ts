import type {
  AgentDeckConfig,
  AgentDeckConfigPatch,
  AgentDeckStatus,
  AgentWithHealth,
  Artifact,
  DeckAccessErrorCode,
  CreateAgentInput,
  CreateIssueInput,
  DocumentContent,
  ExecutionResultContent,
  Finding,
  HumanAction,
  Issue,
  IssueStatus,
  LinearCandidate,
  LinearConnectionStatus,
  LinearIntakeConfig,
  LinearIntakeConfigPatch,
  LinearIntakeConfigView,
  PhaseBudget,
  QueueSnapshot,
  ResultQaContent,
  RuntimeModelsResponse,
  Run,
  StartIssueResponse,
  StreamTraceContent,
  UpdateAgentInput,
  UpdateIssueInput,
  UsageContent,
  UsageEvent,
  UsageSummary,
  WorkerSession,
  WorkflowEvent,
  WorkflowInstance,
} from "@agent-dealer/shared";
import { clearCachedRuntimeModels, fetchRuntimeModelsDeduped } from "./lib/runtimeModelsCache";

const API = "";

type RunEvent = { type: string; payloadJson?: string | null };

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

export async function fetchSnapshot(): Promise<QueueSnapshot> {
  const res = await fetch(`${API}/api/snapshot`);
  if (!res.ok) throw new Error("Failed to fetch snapshot");
  return res.json();
}

export async function fetchRunDetail(id: string): Promise<{
  run: Run;
  artifacts: Artifact[];
  events?: RunEvent[];
  usageSummary?: UsageSummary;
  traceSummary?: StreamTraceContent;
}> {
  const res = await fetch(`${API}/api/runs/${id}`);
  if (!res.ok) throw new Error("Not found");
  return res.json();
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

export async function fetchLinearStatus(): Promise<LinearConnectionStatus> {
  const res = await fetch(`${API}/api/intake/linear/status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchLinearConfig(): Promise<LinearIntakeConfigView> {
  const res = await fetch(`${API}/api/intake/linear/config`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function patchLinearConfig(patch: LinearIntakeConfigPatch): Promise<LinearIntakeConfigView> {
  const res = await fetch(`${API}/api/intake/linear/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function promoteLinearIssue(
  issueId: string,
  body: { agentId?: string; autoAgent?: boolean; planModel?: string | null }
): Promise<Run> {
  const res = await fetch(`${API}/api/intake/linear/${issueId}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function resolveLinearAgent(issueId: string): Promise<{ agentId: string; reason: string }> {
  const res = await fetch(`${API}/api/intake/linear/${issueId}/resolve-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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

export async function cancelRun(id: string): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createRun(body: {
  title: string;
  description?: string;
  taskCategory?: string;
  repo?: string;
  artifactWorkspace?: string;
  acceptanceCriteria?: string;
  agentId: string;
  planModel?: string | null;
  executeModel?: string | null;
}): Promise<Run> {
  const res = await fetch(`${API}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updatePlan(
  id: string,
  planMarkdown: string,
  approve: boolean,
  opts?: {
    executeModel?: string | null;
    planModel?: string | null;
    planBudget?: PhaseBudget | null;
    executeBudget?: PhaseBudget | null;
  }
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/plan`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planMarkdown,
      approve,
      ...(opts?.planModel !== undefined ? { planModel: opts.planModel } : {}),
      ...(opts?.executeModel !== undefined ? { executeModel: opts.executeModel } : {}),
      ...(opts?.planBudget !== undefined ? { planBudget: opts.planBudget } : {}),
      ...(opts?.executeBudget !== undefined ? { executeBudget: opts.executeBudget } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function draftPlan(
  id: string,
  planModel?: string | null,
  planBudget?: PhaseBudget | null,
  opts?: { feedback?: string; editedMarkdown?: string }
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/draft-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(planModel !== undefined ? { planModel } : {}),
      ...(planBudget !== undefined ? { planBudget } : {}),
      ...(opts?.feedback !== undefined ? { feedback: opts.feedback } : {}),
      ...(opts?.editedMarkdown !== undefined ? { editedMarkdown: opts.editedMarkdown } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function configureAgent(
  id: string,
  body: { runtime: string; deckId?: string; playbookId?: string }
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/agent`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function kickRun(
  id: string,
  executeModel?: string | null,
  executeBudget?: PhaseBudget | null
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/kick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(executeModel?.trim() ? { executeModel: executeModel.trim() } : {}),
      ...(executeBudget !== undefined ? { executeBudget } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitPlanAnswers(
  id: string,
  answers: Array<{ questionId: string; selectedLabel?: string; freeText?: string }>,
  opts?: { executeModel?: string | null; executeBudget?: PhaseBudget | null }
): Promise<{ run: Run; outcome: "approved" | "redraft" }> {
  const res = await fetch(`${API}/api/runs/${id}/plan/answers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answers,
      ...(opts?.executeModel !== undefined ? { executeModel: opts.executeModel } : {}),
      ...(opts?.executeBudget !== undefined ? { executeBudget: opts.executeBudget } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function approveRun(id: string, outboundBody?: string): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(outboundBody ? { outboundBody } : {}),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function askResultQuestion(
  id: string,
  question: string
): Promise<{ exchange: ResultQaContent }> {
  const res = await fetch(`${API}/api/runs/${id}/qa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function retryRun(
  id: string,
  feedback: string,
  executeModel?: string | null,
  executeBudget?: PhaseBudget | null
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      feedback,
      ...(executeModel !== undefined ? { executeModel } : {}),
      ...(executeBudget !== undefined ? { executeBudget } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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

export async function fetchAgentDeckStatus(): Promise<AgentDeckStatus> {
  const res = await fetch(`${API}/api/agent-deck/status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAgentDeckConfig(): Promise<AgentDeckConfig> {
  const res = await fetch(`${API}/api/agent-deck/config`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function patchAgentDeckConfig(patch: AgentDeckConfigPatch): Promise<AgentDeckConfig> {
  const res = await fetch(`${API}/api/agent-deck/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
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

export type PlaybookListResult =
  | { ok: true; playbooks: Array<{ id: string; title: string }> }
  | { ok: false; message: string };

export async function fetchDeckPlaybooks(deckId: string): Promise<PlaybookListResult> {
  try {
    const res = await fetch(`${API}/api/agent-deck/decks/${deckId}/playbooks`);
    const json = (await res.json().catch(() => null)) as
      | { data?: Array<{ id: string; title: string }>; error?: string }
      | null;
    if (!res.ok) {
      return { ok: false, message: json?.error ?? `Agent Deck error (${res.status})` };
    }
    return { ok: true, playbooks: json?.data ?? [] };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function subscribeEvents(onSnapshot: (s: QueueSnapshot) => void): () => void {
  const es = new EventSource(`${API}/api/events`);
  es.onmessage = (ev) => {
    try {
      onSnapshot(JSON.parse(ev.data));
    } catch {
      // ignore
    }
  };
  es.onerror = () => {
    es.close();
  };
  return () => es.close();
}

export async function fetchLogTail(runId: string, kind = "transcript"): Promise<string> {
  const res = await fetch(`${API}/api/runs/${runId}/log-tail?kind=${kind}`);
  if (!res.ok) throw new Error(await res.text());
  const json = (await res.json()) as { content: string };
  return json.content;
}

export function parseArtifact<T>(a: Artifact): T | null {
  if (!a.contentJson) return null;
  try {
    return JSON.parse(a.contentJson) as T;
  } catch {
    return null;
  }
}

export function artifactMarkdown(a: Artifact): string {
  if (!a.contentJson) return a.blobPath ?? "";
  try {
    const parsed = JSON.parse(a.contentJson) as {
      markdown?: string;
      excerpt?: string;
      resultText?: string;
    };
    return parsed.markdown ?? parsed.resultText ?? parsed.excerpt ?? a.contentJson;
  } catch {
    return a.contentJson;
  }
}

export function latestArtifact(artifacts: Artifact[], kind: Artifact["kind"]): Artifact | undefined {
  return [...artifacts].reverse().find((a) => a.kind === kind);
}

/** Linear issue URL from task_snapshot (set at promote). */
export function linearUrlFromArtifacts(artifacts: Artifact[]): string | null {
  const snap = latestArtifact(artifacts, "task_snapshot");
  if (!snap?.contentJson) return null;
  try {
    const parsed = JSON.parse(snap.contentJson) as { url?: string };
    const url = parsed.url?.trim();
    return url?.startsWith("http") ? url : null;
  } catch {
    return null;
  }
}

export function latestByPhase<T extends { phase?: string }>(
  artifacts: Artifact[],
  kind: Artifact["kind"],
  phase: "plan" | "execute"
): T | null {
  const matches = artifacts.filter((a) => a.kind === kind);
  for (let i = matches.length - 1; i >= 0; i--) {
    const parsed = parseArtifact<T>(matches[i]);
    if (parsed && (parsed as { phase?: string }).phase === phase) return parsed;
  }
  const last = matches[matches.length - 1];
  return last ? parseArtifact<T>(last) : null;
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

export async function createIssue(input: CreateIssueInput): Promise<Issue> {
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

export async function guideIssue(id: string, markdown: string): Promise<WorkflowEvent> {
  const res = await fetch(`${API}/api/issues/${id}/guidance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
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

export type { StreamTraceContent, UsageContent, UsageSummary, ExecutionResultContent, DocumentContent, LinearCandidate, ResultQaContent };
