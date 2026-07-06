import type {
  Artifact,
  ArtifactKind,
  CreateRunInput,
  Run,
  RunEvent,
  RunStatus,
} from "@agent-dealer/shared";
import { CURSOR_DEFAULT_MODEL } from "@agent-dealer/shared";
import { canTransition } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { resolveAgent, getAgent } from "./agents.js";

interface RunRow {
  id: string;
  source: string;
  external_id: string | null;
  external_label: string | null;
  task_category: string;
  title: string;
  description: string | null;
  repo: string | null;
  artifact_workspace: string | null;
  agent_id: string | null;
  agent_name: string | null;
  deck_id: string | null;
  deck_name: string | null;
  playbook_id: string | null;
  runtime: string | null;
  plan_model: string | null;
  execute_model: string | null;
  status: string;
  lineage_id: string | null;
  acceptance_criteria: string | null;
  approval_gates_json: string | null;
  budget_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    source: row.source as Run["source"],
    externalId: row.external_id,
    externalLabel: row.external_label,
    taskCategory: row.task_category as Run["taskCategory"],
    title: row.title,
    description: row.description,
    repo: row.repo,
    artifactWorkspace: row.artifact_workspace,
    agentId: row.agent_id,
    agentName: row.agent_name,
    deckId: row.deck_id,
    deckName: row.deck_name,
    playbookId: row.playbook_id,
    runtime: row.runtime as Run["runtime"],
    planModel: row.plan_model,
    executeModel: row.execute_model,
    status: row.status as RunStatus,
    lineageId: row.lineage_id,
    acceptanceCriteria: row.acceptance_criteria,
    approvalGatesJson: row.approval_gates_json,
    budgetJson: row.budget_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRun(input: CreateRunInput, opts?: {
  source?: Run["source"];
  externalId?: string;
  externalLabel?: string;
  lineageId?: string;
  deckName?: string | null;
}): Run {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuid();
  const agent = resolveAgent(input.agentId);
  const agentProfile = getAgent(input.agentId);
  const isCursor = agent.runtime === "cursor_local";
  const planModel =
    input.planModel ??
    agentProfile?.defaultPlanModel ??
    (isCursor ? CURSOR_DEFAULT_MODEL : null);
  const executeModel =
    input.executeModel ?? input.planModel ?? agentProfile?.defaultExecuteModel ?? planModel;
  const repo = input.repo ?? agent.workspaceRoot ?? null;
  if (!repo) {
    throw new Error("Agent workspace not configured — set workspace on Agents page or provide repo override");
  }
  const run: RunRow = {
    id,
    source: opts?.source ?? "manual",
    external_id: opts?.externalId ?? null,
    external_label: opts?.externalLabel ?? null,
    task_category: input.taskCategory,
    title: input.title,
    description: input.description ?? null,
    repo,
    artifact_workspace: input.artifactWorkspace ?? null,
    agent_id: agent.agentId,
    agent_name: agent.agentName,
    deck_id: agent.deckId ?? null,
    deck_name: agent.deckName ?? opts?.deckName ?? null,
    playbook_id: agent.playbookId ?? null,
    runtime: agent.runtime,
    plan_model: planModel,
    execute_model: executeModel,
    status: input.status,
    lineage_id: opts?.lineageId ?? null,
    acceptance_criteria: input.acceptanceCriteria ?? null,
    approval_gates_json: JSON.stringify({
      merge_pr: "require_approval",
      send_message: "require_approval",
      send_email: "require_approval",
      update_ticket_status: "require_approval",
      publish_external: "require_approval",
    }),
    budget_json: JSON.stringify({ maxTurns: 30, maxBudgetUsd: 5 }),
    created_at: now,
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO runs (
      id, source, external_id, external_label, task_category, title, description, repo,
      artifact_workspace, agent_id, agent_name, deck_id, deck_name, playbook_id, runtime,
      plan_model, execute_model, status,
      lineage_id, acceptance_criteria, approval_gates_json, budget_json,
      created_at, updated_at
    ) VALUES (
      @id, @source, @external_id, @external_label, @task_category, @title, @description, @repo,
      @artifact_workspace, @agent_id, @agent_name, @deck_id, @deck_name, @playbook_id, @runtime,
      @plan_model, @execute_model, @status,
      @lineage_id, @acceptance_criteria, @approval_gates_json, @budget_json,
      @created_at, @updated_at
    )
  `).run(run);

  appendEvent(id, "run.created", { status: run.status });
  return rowToRun(run);
}

export function getRun(id: string): Run | null {
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(status?: RunStatus | RunStatus[]): Run[] {
  const db = getDb();
  if (!status) {
    const rows = db.prepare("SELECT * FROM runs ORDER BY updated_at DESC").all() as RunRow[];
    return rows.map(rowToRun);
  }
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY updated_at DESC`)
    .all(...statuses) as RunRow[];
  return rows.map(rowToRun);
}

export function countByStatus(status: RunStatus): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as c FROM runs WHERE status = ?")
    .get(status) as { c: number };
  return row.c;
}

export function findByExternalId(source: string, externalId: string): Run | null {
  const row = getDb()
    .prepare("SELECT * FROM runs WHERE source = ? AND external_id = ?")
    .get(source, externalId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function findActiveByExternalId(source: string, externalId: string): Run | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM runs WHERE source = ? AND external_id = ? AND status NOT IN ('done', 'cancelled')`
    )
    .get(source, externalId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

/** plan_pending runs where the agent (or human) has written a plan — ready for review. */
export function listRunsReadyForPlanReview(): Run[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT r.* FROM runs r
       INNER JOIN artifacts a ON a.run_id = r.id AND a.kind = 'draft_plan'
       WHERE r.status = 'plan_pending'
       ORDER BY r.updated_at ASC`
    )
    .all() as RunRow[];
  return rows.map(rowToRun);
}

export function resolveModelForPhase(run: Run, phase: "plan" | "execute"): string | undefined {
  const agent = run.agentId ? getAgent(run.agentId) : null;
  const isCursor = run.runtime === "cursor_local";
  const raw =
    phase === "plan"
      ? (run.planModel ?? agent?.defaultPlanModel ?? null)
      : (run.executeModel ?? agent?.defaultExecuteModel ?? run.planModel ?? agent?.defaultPlanModel ?? null);
  const trimmed = raw?.trim();
  if (trimmed) return trimmed;
  if (isCursor) return CURSOR_DEFAULT_MODEL;
  return undefined;
}

type RunFieldPatch = Partial<{
  deck_id: string | null;
  deck_name: string | null;
  playbook_id: string | null;
  runtime: string | null;
  plan_model: string | null;
  execute_model: string | null;
}>;

function applyRunFieldPatch(current: RunRow, patch: RunFieldPatch): RunRow {
  return {
    ...current,
    deck_id: patch.deck_id !== undefined ? patch.deck_id : current.deck_id,
    deck_name: patch.deck_name !== undefined ? patch.deck_name : current.deck_name,
    playbook_id: patch.playbook_id !== undefined ? patch.playbook_id : current.playbook_id,
    runtime: patch.runtime !== undefined ? patch.runtime : current.runtime,
    plan_model: patch.plan_model !== undefined ? patch.plan_model : current.plan_model,
    execute_model: patch.execute_model !== undefined ? patch.execute_model : current.execute_model,
  };
}

export function updateRunFields(id: string, patch: RunFieldPatch): Run {
  const run = getRun(id);
  if (!run) throw new Error(`Run not found: ${id}`);
  const now = new Date().toISOString();
  const db = getDb();
  const current = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
  const next = applyRunFieldPatch(current, patch);
  db.prepare(`
    UPDATE runs SET
      updated_at = @updated_at,
      deck_id = @deck_id,
      deck_name = @deck_name,
      playbook_id = @playbook_id,
      runtime = @runtime,
      plan_model = @plan_model,
      execute_model = @execute_model
    WHERE id = @id
  `).run({
    id,
    updated_at: now,
    deck_id: next.deck_id,
    deck_name: next.deck_name,
    playbook_id: next.playbook_id,
    runtime: next.runtime,
    plan_model: next.plan_model,
    execute_model: next.execute_model,
  });
  const updated = getRun(id);
  if (!updated) throw new Error(`Run vanished: ${id}`);
  return updated;
}

export function transitionRun(
  id: string,
  to: RunStatus,
  patch?: RunFieldPatch
): Run {
  const run = getRun(id);
  if (!run) throw new Error(`Run not found: ${id}`);
  if (!canTransition(run.status, to)) {
    throw new Error(`Invalid transition: ${run.status} → ${to}`);
  }
  const now = new Date().toISOString();
  const db = getDb();
  const current = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
  const next = applyRunFieldPatch(current, patch ?? {});
  db.prepare(`
    UPDATE runs SET
      status = @status,
      updated_at = @updated_at,
      deck_id = @deck_id,
      deck_name = @deck_name,
      playbook_id = @playbook_id,
      runtime = @runtime,
      plan_model = @plan_model,
      execute_model = @execute_model
    WHERE id = @id
  `).run({
    id,
    status: to,
    updated_at: now,
    deck_id: next.deck_id,
    deck_name: next.deck_name,
    playbook_id: next.playbook_id,
    runtime: next.runtime,
    plan_model: next.plan_model,
    execute_model: next.execute_model,
  });
  appendEvent(id, "run.status_changed", { from: run.status, to });
  const updated = getRun(id);
  if (!updated) throw new Error(`Run vanished: ${id}`);
  return updated;
}

export function addArtifact(
  runId: string,
  kind: ArtifactKind,
  content: unknown,
  author: "human" | "agent" | "system" = "system",
  blobPath?: string
): Artifact {
  const id = uuid();
  const now = new Date().toISOString();
  const contentJson = content !== undefined ? JSON.stringify(content) : null;
  getDb()
    .prepare(`
      INSERT INTO artifacts (id, run_id, kind, content_json, blob_path, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(id, runId, kind, contentJson, blobPath ?? null, author, now);
  appendEvent(runId, "artifact.added", { kind, artifactId: id });
  return {
    id,
    runId,
    kind,
    contentJson,
    blobPath: blobPath ?? null,
    author,
    createdAt: now,
  };
}

export function listArtifacts(runId: string): Artifact[] {
  const rows = getDb()
    .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC")
    .all(runId) as Array<{
    id: string;
    run_id: string;
    kind: string;
    content_json: string | null;
    blob_path: string | null;
    author: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    kind: r.kind as ArtifactKind,
    contentJson: r.content_json,
    blobPath: r.blob_path,
    author: r.author as Artifact["author"],
    createdAt: r.created_at,
  }));
}

export function appendEvent(runId: string, type: string, payload?: unknown): RunEvent {
  const id = uuid();
  const ts = new Date().toISOString();
  const payloadJson = payload !== undefined ? JSON.stringify(payload) : null;
  getDb()
    .prepare(`
      INSERT INTO events (id, run_id, type, payload_json, ts)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(id, runId, type, payloadJson, ts);
  return { id, runId, type, payloadJson, ts };
}

export function listEvents(runId: string): RunEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY ts ASC")
    .all(runId) as Array<{
    id: string;
    run_id: string;
    type: string;
    payload_json: string | null;
    ts: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    type: r.type,
    payloadJson: r.payload_json,
    ts: r.ts,
  }));
}

export function updateArtifactContent(artifactId: string, content: unknown): Artifact {
  const contentJson = JSON.stringify(content);
  getDb()
    .prepare("UPDATE artifacts SET content_json = ? WHERE id = ?")
    .run(contentJson, artifactId);
  const row = getDb()
    .prepare("SELECT * FROM artifacts WHERE id = ?")
    .get(artifactId) as {
    id: string;
    run_id: string;
    kind: string;
    content_json: string | null;
    blob_path: string | null;
    author: string;
    created_at: string;
  };
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ArtifactKind,
    contentJson: row.content_json,
    blobPath: row.blob_path,
    author: row.author as Artifact["author"],
    createdAt: row.created_at,
  };
}

/** Most recent run in the same lineage before `run` (retry parent). */
export function getLineageParentRun(run: Run): Run | null {
  const lineageId = run.lineageId;
  if (!lineageId) return null;

  const row = getDb()
    .prepare(
      `
      SELECT * FROM runs
      WHERE (lineage_id = @lineage_id OR id = @lineage_id)
        AND id != @run_id
      ORDER BY created_at DESC
      LIMIT 1
    `
    )
    .get({ lineage_id: lineageId, run_id: run.id }) as RunRow | undefined;

  return row ? rowToRun(row) : null;
}

/** All runs in a lineage (root first), including cancelled retries. */
export function listLineageRuns(run: Run): Run[] {
  const lineageId = run.lineageId ?? run.id;
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM runs
      WHERE lineage_id = @lineage_id OR id = @lineage_id
      ORDER BY created_at ASC
    `
    )
    .all({ lineage_id: lineageId }) as RunRow[];
  return rows.map(rowToRun);
}

export function getLatestArtifact(runId: string, kind: ArtifactKind): Artifact | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM artifacts WHERE run_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(runId, kind) as {
    id: string;
    run_id: string;
    kind: string;
    content_json: string | null;
    blob_path: string | null;
    author: string;
    created_at: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ArtifactKind,
    contentJson: row.content_json,
    blobPath: row.blob_path,
    author: row.author as Artifact["author"],
    createdAt: row.created_at,
  };
}

const OPS_BOARD_STATUSES: RunStatus[] = [
  "queued",
  "plan_pending",
  "plan_approved",
  "running",
  "review",
  "failed",
];

function inferOpsStatusFromArtifacts(runId: string): RunStatus {
  const exec = getLatestArtifact(runId, "execution_result");
  if (exec?.contentJson) {
    try {
      const content = JSON.parse(exec.contentJson) as { exitCode?: number; isError?: boolean };
      if (content.isError || (content.exitCode !== undefined && content.exitCode !== 0)) {
        return "failed";
      }
      return "review";
    } catch {
      return "review";
    }
  }
  if (getLatestArtifact(runId, "approved_plan")) return "plan_approved";
  return "plan_pending";
}

export function statusBeforeCancel(runId: string): RunStatus {
  const events = listEvents(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "run.status_changed" || !e.payloadJson) continue;
    try {
      const payload = JSON.parse(e.payloadJson) as { from?: RunStatus; to?: RunStatus };
      if (payload.to === "cancelled" && payload.from && OPS_BOARD_STATUSES.includes(payload.from)) {
        return payload.from;
      }
    } catch {
      // skip malformed event
    }
  }
  return inferOpsStatusFromArtifacts(runId);
}

/** Return a given-up run to the Operations board at its prior stage. */
export function restoreRun(id: string): Run {
  const run = getRun(id);
  if (!run) throw new Error(`Run not found: ${id}`);
  if (run.status !== "cancelled") {
    throw new Error(`Run is not given up (status: ${run.status})`);
  }
  const to = statusBeforeCancel(id);
  const now = new Date().toISOString();
  getDb().prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(to, now, id);
  appendEvent(id, "run.restored", { to });
  const updated = getRun(id);
  if (!updated) throw new Error(`Run vanished: ${id}`);
  return updated;
}
