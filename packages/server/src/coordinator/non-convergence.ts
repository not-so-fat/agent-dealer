// packages/server/src/coordinator/non-convergence.ts
//
// Structural non-convergence detection for the review loop (NOT-184). A repair loop can
// burn every remaining round while each round reports a fresh, narrower blocking finding
// on the same file — the fingerprints differ every round, so `findings.ts`'s `recurring`
// never fires. This looks only at structure (severity + `file` per round), never at
// finding text: a file with a blocking finding in each of the last N consecutive rounds
// means the fix is not converging, and a human should see the design-level pattern.
import type { WorkflowEvent } from "@agent-dealer/shared";
import type { ReviewerResult } from "./reviewer-result.js";

/** Consecutive rounds with a blocking finding on the same file that count as non-convergent. */
export const NON_CONVERGENCE_ROUNDS = 3;

export interface RoundFinding {
  severity: string;
  title: string;
  file?: string | null;
}

export interface NonConvergedFile {
  file: string;
  rounds: Array<{ round: number; titles: string[] }>;
}

export interface NonConvergence {
  threshold: number;
  /** The round of the review that tripped the rule — later rounds must start fresh past it. */
  throughRound: number;
  files: NonConvergedFile[];
}

/**
 * `history` maps a review round to that round's findings; `currentRound` is the round just
 * recorded. Only rounds strictly after `floorRound` count, so a human resuming past an
 * earlier escalation does not re-trigger on the very rounds they just looked at.
 */
export function detectNonConvergence(
  history: ReadonlyMap<number, readonly RoundFinding[]>,
  currentRound: number,
  floorRound = 0
): NonConvergence | null {
  const first = currentRound - NON_CONVERGENCE_ROUNDS + 1;
  if (first <= floorRound) return null;

  const titlesByFile = new Map<string, Map<number, string[]>>();
  for (let round = first; round <= currentRound; round++) {
    const findings = history.get(round);
    if (!findings) return null;
    for (const f of findings) {
      if (f.severity !== "blocking" || !f.file) continue;
      const byRound = titlesByFile.get(f.file) ?? new Map<number, string[]>();
      byRound.set(round, [...(byRound.get(round) ?? []), f.title]);
      titlesByFile.set(f.file, byRound);
    }
  }

  const files: NonConvergedFile[] = [];
  for (const [file, byRound] of titlesByFile) {
    if (byRound.size !== NON_CONVERGENCE_ROUNDS) continue;
    files.push({
      file,
      rounds: [...byRound].map(([round, titles]) => ({ round, titles })),
    });
  }
  return files.length ? { threshold: NON_CONVERGENCE_ROUNDS, throughRound: currentRound, files } : null;
}

/**
 * Per-round findings from the `review.submitted` events of one workflow instance, with the
 * just-recorded round's result layered on top (its event is not written yet when routing
 * runs). A round reviewed twice (e.g. a reviewer resume) keeps only its latest verdict.
 */
export function reviewHistoryFromEvents(
  events: readonly WorkflowEvent[],
  workflowInstanceId: string,
  current: { round: number; result: ReviewerResult }
): Map<number, RoundFinding[]> {
  const history = new Map<number, RoundFinding[]>();
  for (const e of events) {
    if (e.type !== "review.submitted" || e.round == null || e.workflowInstanceId !== workflowInstanceId) continue;
    if (!e.payloadJson) continue;
    try {
      const payload = JSON.parse(e.payloadJson) as { findings?: RoundFinding[] };
      history.set(e.round, payload.findings ?? []);
    } catch {
      // an unreadable historical payload just breaks the streak — never the routing
    }
  }
  history.set(current.round, current.result.findings);
  return history;
}

export function formatNonConvergenceReason(nc: NonConvergence): string {
  const rounds = nc.files[0].rounds.map((r) => r.round).join(", ");
  const files = nc.files.map((f) => f.file).join(", ");
  return (
    `Review is not converging: blocking findings on ${files} in each of rounds ${rounds}. ` +
    `Another developer round is unlikely to help — review the design-level cause first.`
  );
}
