/**
 * PoC: Linear poll → inbox candidates only (no run creation).
 */
import { loadAgentDealerEnv } from "../load-env.ts";

loadAgentDealerEnv();

const LINEAR_API = "https://api.linear.app/graphql";

interface Issue {
  identifier: string;
  title: string;
  url: string;
}

async function linearQuery(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main(): Promise<void> {
  if (!process.env.LINEAR_API_KEY) {
    console.log("SKIP linear-inbox: LINEAR_API_KEY not set");
    process.exit(0);
  }

  const stateFilter = (process.env.LINEAR_STATE_FILTER ?? "Todo").split(",").map((s) => s.trim());
  const filter: Record<string, unknown> = { state: { name: { in: stateFilter } } };
  if (process.env.LINEAR_TEAM_ID) {
    filter.team = { id: { eq: process.env.LINEAR_TEAM_ID } };
  }

  const data = (await linearQuery(
    `query PollIssues($filter: IssueFilter) {
      issues(filter: $filter, first: 10) {
        nodes { identifier title url }
      }
    }`,
    { filter }
  )) as { issues: { nodes: Issue[] } };

  const nodes = data.issues.nodes;
  console.log(`OK linear-inbox: ${nodes.length} candidate(s)`);
  for (const i of nodes) {
    console.log(`  - ${i.identifier}: ${i.title}`);
    console.log(`    ${i.url}`);
  }
  if (nodes.length === 0) console.log("  (empty inbox — adjust LINEAR_STATE_FILTER or create issues)");
}

main().catch((e) => {
  console.error("FAIL linear-inbox:", e);
  process.exit(1);
});
