import type { PlanTriageContent } from "@agent-dealer/shared";
import { addArtifact, getLatestArtifact } from "../repository/runs.js";

/**
 * Human approved a plan whose triage questions are still open.
 * Record the delegation so the executor sees the questions it must decide itself.
 * Call BEFORE markPlanTriageConsumed — a consumed triage has nothing to delegate.
 */
export function recordPlanDelegation(runId: string): boolean {
  const triageArt = getLatestArtifact(runId, "plan_triage");
  if (!triageArt?.contentJson) return false;

  let triage: PlanTriageContent;
  try {
    triage = JSON.parse(triageArt.contentJson) as PlanTriageContent;
  } catch {
    return false;
  }
  if (triage.consumed || triage.questions.length === 0) return false;

  // >= not >: createdAt has millisecond precision, and answers for this triage
  // round can tie with it. Answers can never legitimately predate their triage.
  const answers = getLatestArtifact(runId, "plan_answers");
  if (answers && answers.createdAt >= triageArt.createdAt) return false;

  addArtifact(runId, "plan_answers", { answers: [], outcome: "delegated", answeredAt: new Date().toISOString() }, "human");
  return true;
}
