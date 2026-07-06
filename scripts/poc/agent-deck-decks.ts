/**
 * PoC: Agent Deck API returns decks (proxy path agent-dealer uses).
 */
import { loadAgentDealerEnv } from "../load-env.ts";

loadAgentDealerEnv();

const BASE = process.env.AGENT_DECK_API_URL ?? "http://127.0.0.1:1111";

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error(`health ${health.status}`);

  const res = await fetch(`${BASE}/api/decks`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`decks ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  const decks = json.data ?? [];
  console.log(`OK agent-deck-decks: ${decks.length} deck(s), health=${(await health.json()).status ?? "ok"}`);
  for (const d of decks) console.log(`  - ◆ ${d.name} (${d.id})`);
}

main().catch((e) => {
  console.error("FAIL agent-deck-decks:", e);
  process.exit(1);
});
