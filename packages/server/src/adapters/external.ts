import { listLinearCandidates } from "./linear-inbox.js";

export { checkAgentDeckHealth, fetchAgentDeckDecks } from "./agent-deck.js";

export async function pollLinearIssues(): Promise<number> {
  if (process.env.LINEAR_AUTO_ENQUEUE === "1") {
    console.warn("[linear] LINEAR_AUTO_ENQUEUE=1 is deprecated — use Intake promote");
    return 0;
  }
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
