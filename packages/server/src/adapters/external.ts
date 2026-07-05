import { listLinearCandidates } from "./linear-inbox.js";

export async function pollLinearIssues(): Promise<number> {
  if (process.env.LINEAR_AUTO_ENQUEUE === "1") {
    console.warn("[linear] LINEAR_AUTO_ENQUEUE=1 is deprecated — use Intake promote");
    return 0;
  }
  // Optional: warm cache / log candidate count
  if (!process.env.LINEAR_API_KEY) return 0;
  try {
    const candidates = await listLinearCandidates();
    if (candidates.length > 0) {
      console.log(`[linear] ${candidates.length} inbox candidate(s) — promote via Intake`);
    }
    return 0;
  } catch (e) {
    console.error("[linear]", e);
    return 0;
  }
}

export async function checkAgentDeckHealth(): Promise<boolean> {
  const base = process.env.AGENT_DECK_API_URL ?? "http://127.0.0.1:11111";
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchAgentDeckDecks(): Promise<unknown> {
  const base = process.env.AGENT_DECK_API_URL ?? "http://127.0.0.1:11111";
  const res = await fetch(`${base}/api/decks`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Agent Deck API error: ${res.status}`);
  return res.json();
}
