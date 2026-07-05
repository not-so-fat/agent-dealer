import { z } from "zod";
import { Runtime } from "./runtime.js";
import { AgentWithHealth } from "./agents.js";

export * from "./runtime.js";
export * from "./agents.js";
export * from "./execution.js";

export const RunStatus = z.enum([
  "queued",
  "plan_pending",
  "plan_approved",
  "running",
  "review",
  "done",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const TaskCategory = z.enum([
  "code",
  "communication",
  "email",
  "research",
  "content",
  "other",
]);
export type TaskCategory = z.infer<typeof TaskCategory>;

export const ArtifactKind = z.enum([
  "task_snapshot",
  "draft_plan",
  "approved_plan",
  "acceptance_criteria",
  "transcript",
  "stream_trace",
  "usage",
  "agent_session",
  "execution_result",
  "diff",
  "pr",
  "email_draft",
  "slack_draft",
  "document",
  "research_brief",
  "deliverable",
  "feedback",
  "playbook_patch",
  "linear_sync",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const RunPhase = z.enum(["plan", "execute"]);
export type RunPhase = z.infer<typeof RunPhase>;

/** Human-readable timeline derived from NDJSON (thinking, tools, assistant text). */
export const StreamTraceEntry = z.object({
  type: z.enum(["system", "thinking", "assistant", "tool", "rate_limit", "result"]),
  text: z.string(),
  toolName: z.string().optional(),
});
export type StreamTraceEntry = z.infer<typeof StreamTraceEntry>;

export const StreamTraceContent = z.object({
  phase: RunPhase,
  runtime: Runtime,
  entries: z.array(StreamTraceEntry),
});
export type StreamTraceContent = z.infer<typeof StreamTraceContent>;

export const UsageContent = z.object({
  phase: RunPhase,
  runtime: Runtime,
  totalCostUsd: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  durationMs: z.number().optional(),
  model: z.string().optional(),
  numTurns: z.number().optional(),
});
export type UsageContent = z.infer<typeof UsageContent>;

export const AgentSessionContent = z.object({
  phase: RunPhase,
  runtime: Runtime,
  sessionId: z.string(),
});
export type AgentSessionContent = z.infer<typeof AgentSessionContent>;

export const ExecutionResultContent = z.object({
  phase: RunPhase,
  exitCode: z.number(),
  resultText: z.string().optional(),
  isError: z.boolean().optional(),
  blocker: z.object({ summary: z.string().optional() }).optional(),
});
export type ExecutionResultContent = z.infer<typeof ExecutionResultContent>;

export const DocumentContent = z.object({
  path: z.string(),
  title: z.string(),
  markdown: z.string(),
});
export type DocumentContent = z.infer<typeof DocumentContent>;

export const PlanContent = z.object({
  markdown: z.string(),
  sessionId: z.string().optional(),
});
export type PlanContent = z.infer<typeof PlanContent>;

export const RunSource = z.enum(["manual", "linear"]);
export type RunSource = z.infer<typeof RunSource>;

export const IssueSnapshot = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  url: z.string().optional(),
});
export type IssueSnapshot = z.infer<typeof IssueSnapshot>;

export const Run = z.object({
  id: z.string().uuid(),
  source: RunSource,
  externalId: z.string().nullable(),
  /** Human-readable external id, e.g. ENG-123 for Linear */
  externalLabel: z.string().nullable(),
  taskCategory: TaskCategory,
  title: z.string(),
  description: z.string().nullable(),
  repo: z.string().nullable(),
  artifactWorkspace: z.string().nullable(),
  agentId: z.string().uuid().nullable(),
  agentName: z.string().nullable(),
  deckId: z.string().nullable(),
  deckName: z.string().nullable(),
  playbookId: z.string().nullable(),
  runtime: Runtime.nullable(),
  status: RunStatus,
  lineageId: z.string().uuid().nullable(),
  acceptanceCriteria: z.string().nullable(),
  approvalGatesJson: z.string().nullable(),
  budgetJson: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Run = z.infer<typeof Run>;

export const Artifact = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  kind: ArtifactKind,
  contentJson: z.string().nullable(),
  blobPath: z.string().nullable(),
  author: z.enum(["human", "agent", "system"]),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

export const RunEvent = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  type: z.string(),
  payloadJson: z.string().nullable(),
  ts: z.string(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const CreateRunInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  taskCategory: TaskCategory.default("other"),
  repo: z.string().optional(),
  artifactWorkspace: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  status: z.enum(["queued", "plan_pending"]).default("plan_pending"),
  /** Saved agent profile — runtime/deck/playbook resolved from agent record. */
  agentId: z.string().uuid(),
});
export type CreateRunInput = z.infer<typeof CreateRunInput>;

export const AgentConfigInput = z.object({
  runtime: Runtime,
  deckId: z.string().uuid().optional(),
  playbookId: z.string().optional(),
});
export type AgentConfigInput = z.infer<typeof AgentConfigInput>;

export const UpdatePlanInput = z.object({
  planMarkdown: z.string(),
  approve: z.boolean().default(false),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInput>;

export const KickRunInput = z.object({
  /** Uses run record when omitted at kick time. */
  runtime: Runtime.optional(),
  deckId: z.string().uuid().optional(),
  playbookId: z.string().optional(),
});
export type KickRunInput = z.infer<typeof KickRunInput>;

export const RetryRunInput = z.object({
  feedback: z.string().min(1),
});
export type RetryRunInput = z.infer<typeof RetryRunInput>;

export const LinearCandidate = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().optional(),
  url: z.string(),
  state: z.string().optional(),
  labels: z.array(z.string()).optional(),
  teamId: z.string().optional(),
});
export type LinearCandidate = z.infer<typeof LinearCandidate>;

export const LinearRoutingRule = z.object({
  label: z.string().min(1),
  agentId: z.string().uuid(),
});
export type LinearRoutingRule = z.infer<typeof LinearRoutingRule>;

export const LinearIntakeConfig = z.object({
  stateFilter: z.array(z.string()),
  teamId: z.string().nullable(),
  assigneeMe: z.boolean(),
  defaultAgentId: z.string().uuid().nullable(),
  syncEnabled: z.boolean(),
  routingRules: z.array(LinearRoutingRule),
});
export type LinearIntakeConfig = z.infer<typeof LinearIntakeConfig>;

export const LinearIntakeConfigPatch = LinearIntakeConfig.partial();
export type LinearIntakeConfigPatch = z.infer<typeof LinearIntakeConfigPatch>;

export const LinearConnectionStatus = z.object({
  connected: z.boolean(),
  viewer: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});
export type LinearConnectionStatus = z.infer<typeof LinearConnectionStatus>;

export const ResolveAgentResult = z.object({
  agentId: z.string().uuid(),
  reason: z.string(),
});
export type ResolveAgentResult = z.infer<typeof ResolveAgentResult>;

export const PromoteLinearInput = z
  .object({
    agentId: z.string().uuid().optional(),
    autoAgent: z.boolean().optional(),
  })
  .refine((v) => v.agentId !== undefined || v.autoAgent === true, {
    message: "Provide agentId or autoAgent: true",
  });
export type PromoteLinearInput = z.infer<typeof PromoteLinearInput>;

export const QueueSnapshot = z.object({
  running: z.number(),
  queued: z.number(),
  planPending: z.number(),
  review: z.number(),
  runningCount: z.number(),
  maxConcurrent: z.number(),
  runningRuns: z.array(Run),
  waitingExecution: z.array(Run),
  resultReviewRuns: z.array(Run),
  recentDone: z.array(Run),
  awaitingPlanReview: z.array(Run),
  runs: z.array(Run),
  agentDeckOnline: z.boolean(),
  agents: z.array(AgentWithHealth),
  agentIssueCount: z.number(),
});
export type QueueSnapshot = z.infer<typeof QueueSnapshot>;

export const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["plan_pending", "cancelled"],
  plan_pending: ["plan_approved", "queued", "cancelled"],
  plan_approved: ["running", "plan_pending", "cancelled"],
  running: ["review", "failed", "cancelled"],
  review: ["done", "plan_pending", "failed", "cancelled"],
  done: [],
  failed: ["plan_pending", "cancelled"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
