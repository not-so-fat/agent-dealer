/**
 * API-level flow verification — 8-step lifecycle gates.
 * Usage: npm run flow:verify
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDealerEnv } from "./load-env.ts";

loadAgentDealerEnv();
const API = process.env.AGENT_DEALER_API!;
const BUILTIN_AGENT_CLAUDE_ID = "00000000-0000-4000-a000-000000000001";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Run = {
  id: string;
  status: string;
  runtime: string | null;
  deckId?: string | null;
  playbookId?: string | null;
};
type Snapshot = {
  runningRuns: Run[];
  maxConcurrent: number;
  awaitingPlanReview: Run[];
  resultReviewRuns: Run[];
};

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // plain text error
  }
  return { status: res.status, json };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main(): Promise<void> {
  const log: string[] = [];
  const ok = (msg: string) => log.push(`✓ ${msg}`);

  const snap = await req("GET", "/api/snapshot");
  assert(snap.status === 200, "snapshot");
  const snapshot = snap.json as Snapshot;
  assert(Array.isArray(snapshot.runningRuns), "snapshot.runningRuns");
  assert(Array.isArray(snapshot.awaitingPlanReview), "snapshot.awaitingPlanReview");
  assert(Array.isArray(snapshot.resultReviewRuns), "snapshot.resultReviewRuns");
  ok("Snapshot has Operations fields");

  const inbox = await req("GET", "/api/intake/linear");
  assert(inbox.status === 200, "intake linear");
  ok("GET /api/intake/linear");

  const linearStatus = await req("GET", "/api/intake/linear/status");
  assert(linearStatus.status === 200, "linear status");
  ok("GET /api/intake/linear/status");

  const linearConfig = await req("GET", "/api/intake/linear/config");
  assert(linearConfig.status === 200, "linear config");
  const cfg = linearConfig.json as { stateFilter: string[]; assigneeMe: boolean };
  assert(Array.isArray(cfg.stateFilter), "linear config stateFilter");
  ok("GET /api/intake/linear/config");

  const bad = await req("POST", "/api/runs", { title: "Should fail", taskCategory: "other" });
  assert(bad.status >= 400, "create without agentId should fail");
  ok("Rejects task without agentId");

  const patched = await req("PATCH", `/api/agents/${BUILTIN_AGENT_CLAUDE_ID}`, {
    workspaceRoot: REPO_ROOT,
  });
  assert(patched.status === 200, "patch agent workspace");
  ok("Configured built-in agent workspace");

  const created = await req("POST", "/api/runs", {
    title: "Flow verify task",
    description: "Automated smoke",
    taskCategory: "research",
    agentId: BUILTIN_AGENT_CLAUDE_ID,
  });
  assert(created.status === 201, `create with agentId: ${JSON.stringify(created.json)}`);
  const run = created.json as Run;
  assert(run.runtime === "claude_code", "runtime persisted");
  assert(run.status === "plan_pending", "starts plan_pending");
  ok(`Step 2 kick plan: run ${run.id.slice(0, 8)}`);

  const testDeckId = "00000000-0000-4000-a000-000000000101";
  const testPlaybookId = "pb_flow_verify";
  const bound = await req("PATCH", `/api/runs/${run.id}/agent`, {
    runtime: "claude_code",
    deckId: testDeckId,
    playbookId: testPlaybookId,
  });
  assert(bound.status === 200, `bind deck/playbook on run: ${JSON.stringify(bound.json)}`);
  ok("Run deck/playbook binding");

  const earlyKick = await req("POST", `/api/runs/${run.id}/kick`, {});
  assert(earlyKick.status === 400, "kick before plan approve blocked");
  ok("Blocks execution before plan approval (step 4 gate)");

  const plan = await req("PATCH", `/api/runs/${run.id}/plan`, {
    planMarkdown: "# Plan\n1. Say hello\n2. Stop",
    approve: true,
  });
  assert(plan.status === 200, "approve plan");
  const approved = plan.json as Run;
  assert(["plan_approved", "running"].includes(approved.status), "plan_approved or running");
  ok("Step 4 approve → execute queue");

  const after = await req("GET", `/api/runs/${run.id}`);
  const current = (after.json as { run: Run }).run;
  if (current.status === "plan_approved") {
    const kick = await req("POST", `/api/runs/${run.id}/kick`, {});
    assert(kick.status === 200, `kick returned ${kick.status}: ${JSON.stringify(kick.json)}`);
    ok("Step 5 dispatch accepted");
  } else {
    assert(current.status === "running", "auto-dispatched to running");
    ok("Step 5 auto-dispatched (already running)");
  }

  const noPatch = await req("POST", `/api/runs/${run.id}/playbook-patch/apply`, {});
  assert(noPatch.status === 404, "apply without patch returns 404");
  ok("Playbook patch apply gate (no patch)");

  const retryBlocked = await req("POST", `/api/runs/${run.id}/retry`, {
    feedback: "Flow verify — should block outside review",
  });
  assert(retryBlocked.status === 400, "retry outside review blocked");
  ok("Retry gate requires review/failed (execution retry path)");

  await req("POST", `/api/runs/${run.id}/cancel`, {});
  ok("Cancelled flow verify run");

  console.log(log.join("\n"));
  console.log("\nFlow gates verified (steps 1–5 API). Full agent path: npm run flow:doc");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
