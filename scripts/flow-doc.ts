/**
 * End-to-end smoke: simple content document task via API.
 * Plan is auto-drafted on create — no manual draft-plan step.
 */
import { loadAgentDealerEnv } from "./load-env.ts";

loadAgentDealerEnv();
const API = process.env.AGENT_DEALER_API!;
const RUNTIME = (process.env.FLOW_RUNTIME ?? "claude_code") as "claude_code" | "cursor_local";
const POLL_MS = 2000;
const TIMEOUT_MS = Number(process.env.FLOW_TIMEOUT_MS ?? 180_000);

type Run = { id: string; status: string };
type Artifact = { kind: string; contentJson: string | null };

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
    // plain
  }
  return { status: res.status, json };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function waitForArtifact(runId: string, kind: string): Promise<Artifact[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { json } = await req("GET", `/api/runs/${runId}`);
    const arts = (json as { artifacts: Artifact[] }).artifacts;
    if (arts.some((a) => a.kind === kind)) return arts;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timeout waiting for artifact ${kind}`);
}

async function waitForStatus(runId: string, targets: string[]): Promise<Run> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { json } = await req("GET", `/api/runs/${runId}`);
    const run = (json as { run: Run }).run;
    if (targets.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timeout waiting for ${targets.join("|")} on ${runId}`);
}

async function main(): Promise<void> {
  const log: string[] = [];
  const ok = (msg: string) => log.push(`✓ ${msg}`);

  const created = await req("POST", "/api/runs", {
    title: "E2E: random coffee facts doc",
    description: "Write 5 fun facts about coffee in markdown. Keep under 25 lines.",
    taskCategory: "content",
    runtime: RUNTIME,
  });
  assert(created.status === 201, "create run");
  const run = created.json as Run;
  ok(`Created ${run.id.slice(0, 8)} (${RUNTIME}) — auto plan draft started`);

  const planArts = await waitForArtifact(run.id, "draft_plan");
  assert(planArts.some((a) => a.kind === "stream_trace"), "plan stream_trace");
  ok("Agent plan auto-drafted");

  const draftPlan = planArts.find((a) => a.kind === "draft_plan");
  const planMd = JSON.parse(draftPlan!.contentJson!).markdown as string;
  assert(planMd.length > 20, "plan markdown");

  const approved = await req("PATCH", `/api/runs/${run.id}/plan`, { planMarkdown: planMd, approve: true });
  assert(approved.status === 200, "approve plan");
  ok("Plan approved");

  await req("POST", `/api/runs/${run.id}/kick`, {});
  ok("Execution kicked");

  const final = await waitForStatus(run.id, ["review", "failed"]);
  ok(`Final status: ${final.status}`);

  const detail = await req("GET", `/api/runs/${run.id}`);
  const arts = (detail.json as { artifacts: Artifact[] }).artifacts;
  assert(arts.some((a) => a.kind === "execution_result"), "execution_result");

  if (final.status === "review") {
    ok("Ready for human review in dashboard");
  } else {
    log.push("⚠ Run failed — check .temporal/logs");
  }

  console.log(log.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
