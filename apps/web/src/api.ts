import type {
  AgentDeckConfig,
  AgentDeckConfigPatch,
  AgentDeckStatus,
  AgentWithHealth,
  Artifact,
  CreateAgentInput,
  DocumentContent,
  ExecutionResultContent,
  LinearCandidate,
  LinearConnectionStatus,
  LinearIntakeConfig,
  LinearIntakeConfigPatch,
  LinearIntakeConfigView,
  PhaseBudget,
  QueueSnapshot,
  RuntimeModelsResponse,
  Run,
  StreamTraceContent,
  UpdateAgentInput,
  UsageContent,
  UsageSummary,
} from "@agent-dealer/shared";
import { clearCachedRuntimeModels, fetchRuntimeModelsDeduped } from "./lib/runtimeModelsCache";

const API = "";

export async function fetchSnapshot(): Promise<QueueSnapshot> {
  const res = await fetch(`${API}/api/snapshot`);
  if (!res.ok) throw new Error("Failed to fetch snapshot");
  return res.json();
}

export async function fetchRunDetail(id: string): Promise<{
  run: Run;
  artifacts: Artifact[];
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
  planBudget?: PhaseBudget | null
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/draft-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(planModel !== undefined ? { planModel } : {}),
      ...(planBudget !== undefined ? { planBudget } : {}),
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

export async function approveRun(id: string): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/approve`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function retryRun(
  id: string,
  feedback: string,
  executeModel?: string | null
): Promise<Run> {
  const res = await fetch(`${API}/api/runs/${id}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      feedback,
      ...(executeModel !== undefined ? { executeModel } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function applyPlaybookPatch(id: string): Promise<unknown> {
  const res = await fetch(`${API}/api/runs/${id}/playbook-patch/apply`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function dismissPlaybookPatch(id: string): Promise<unknown> {
  const res = await fetch(`${API}/api/runs/${id}/playbook-patch/dismiss`, { method: "POST" });
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

export async function fetchDecks(): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${API}/api/agent-deck/decks`);
  const json = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  return json.data ?? [];
}

export async function fetchDeckPlaybooks(deckId: string): Promise<Array<{ id: string; title: string }>> {
  const res = await fetch(`${API}/api/agent-deck/decks/${deckId}/playbooks`);
  const json = (await res.json()) as { data?: Array<{ id: string; title: string }> };
  return json.data ?? [];
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

export type { StreamTraceContent, UsageContent, UsageSummary, ExecutionResultContent, DocumentContent, LinearCandidate };
