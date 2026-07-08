import type { ResultQaContent } from "@agent-dealer/shared";
import { ResultQaContent as ResultQaContentSchema, latestQaExchanges } from "@agent-dealer/shared";
import { listArtifacts } from "./runs.js";

/** Collapsed Q&A thread for a run — latest artifact per exchangeId, oldest ask first. */
export function listQaExchanges(runId: string): ResultQaContent[] {
  const parsed: ResultQaContent[] = [];
  for (const art of listArtifacts(runId)) {
    if (art.kind !== "result_qa" || !art.contentJson) continue;
    try {
      parsed.push(ResultQaContentSchema.parse(JSON.parse(art.contentJson)));
    } catch {
      // skip malformed
    }
  }
  return latestQaExchanges(parsed);
}

export function hasPendingQaExchange(runId: string): boolean {
  return listQaExchanges(runId).some((e) => e.status === "pending");
}

/** Session id of the most recent execute phase — what a Q&A resumes into. */
export function latestExecuteSessionId(runId: string): string | null {
  const sessions = listArtifacts(runId).filter((a) => a.kind === "agent_session");
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (!sessions[i].contentJson) continue;
    try {
      const parsed = JSON.parse(sessions[i].contentJson!) as { phase?: string; sessionId?: string };
      if (parsed.phase === "execute" && parsed.sessionId) return parsed.sessionId;
    } catch {
      // skip
    }
  }
  return null;
}
