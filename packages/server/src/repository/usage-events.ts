import type { UsageEvent } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface UsageEventRow {
  id: string;
  issue_id: string;
  worker_session_id: string;
  role: string;
  runtime: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  ts: string;
}

function rowToUsageEvent(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    workerSessionId: row.worker_session_id,
    role: row.role as UsageEvent["role"],
    runtime: row.runtime,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    ts: row.ts,
  };
}

export interface RecordUsageEventInput {
  issueId: string;
  workerSessionId: string;
  role: UsageEvent["role"];
  runtime?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

export function recordUsageEvent(input: RecordUsageEventInput): UsageEvent {
  const row: UsageEventRow = {
    id: uuid(),
    issue_id: input.issueId,
    worker_session_id: input.workerSessionId,
    role: input.role,
    runtime: input.runtime ?? null,
    tokens_in: input.tokensIn ?? null,
    tokens_out: input.tokensOut ?? null,
    cost_usd: input.costUsd ?? null,
    duration_ms: input.durationMs ?? null,
    ts: new Date().toISOString(),
  };
  getDb().prepare(`
    INSERT INTO usage_events (
      id, issue_id, worker_session_id, role, runtime, tokens_in, tokens_out, cost_usd, duration_ms, ts
    ) VALUES (
      @id, @issue_id, @worker_session_id, @role, @runtime, @tokens_in, @tokens_out, @cost_usd, @duration_ms, @ts
    )
  `).run(row);
  return rowToUsageEvent(row);
}

export interface IssueUsageSummary {
  totalCostUsd: number;
  totalDurationMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export function summarizeIssueUsage(issueId: string): IssueUsageSummary {
  const row = getDb()
    .prepare(
      `SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(duration_ms), 0) as total_duration,
        COALESCE(SUM(tokens_in), 0) as total_in,
        COALESCE(SUM(tokens_out), 0) as total_out
       FROM usage_events WHERE issue_id = ?`
    )
    .get(issueId) as { total_cost: number; total_duration: number; total_in: number; total_out: number };
  return {
    totalCostUsd: row.total_cost,
    totalDurationMs: row.total_duration,
    totalTokensIn: row.total_in,
    totalTokensOut: row.total_out,
  };
}
