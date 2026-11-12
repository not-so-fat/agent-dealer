// packages/server/src/coordinator/operator-criteria.ts
//
// NOT-314: `[operator]`-tagged acceptance criteria are a first-class merge gate.
// Some ACs can only be proven by a human with real credentials, a real login, or
// a paid session — the builder discovers this mid-run and today burns rounds
// before raising a product-scope escalation. Instead the tag is deliberate: the
// frozen snapshot's operator criteria block auto-merge until a human records the
// result (verified / waive) or sends the work back (repair).
//
// This module is pure except for the frozen-snapshot + verification-record
// readers at the bottom. The gate itself lives in auto-merge.ts
// (finalizeAutoMergeOnce, after reviewer approve, before the `gh` merge);
// resolution lives in commands.ts's resolveHumanActionAndAdvance.

import type { ExecutionContractV1, Issue } from "@agent-dealer/shared";
import { latestIssueArtifact } from "../repository/artifacts.js";
import { listArtifactsForIssueByKind } from "../repository/artifacts-for-issue.js";
import { listWorkflowEventsForIssue } from "../repository/workflow-events.js";

/** One `[operator]` criterion: the top-level checkbox text plus its indented
 * evidence sub-bullets (the ready-to-run commands for the operator). */
export interface OperatorCriterion {
  /** The checkbox line's text, tag included, trimmed. */
  text: string;
  /** Each indented sub-bullet under the checkbox, trimmed, in order. */
  commands: string[];
}

/** The frozen snapshot artifact kind — same string as commands.ts's
 * TASK_SNAPSHOT_ARTIFACT_KIND, repeated here so this module never imports the
 * coordinator kernel (commands.ts imports auto-merge.ts, which imports this). */
const TASK_SNAPSHOT_KIND = "task_snapshot";

/** Issue artifact kind holding a recorded `verified` result (author human). */
export const OPERATOR_VERIFICATION_ARTIFACT_KIND = "operator_verification";

/**
 * NOT-314: the stored response options for an `operator_verification` action.
 * Shared by auto-merge.ts (which raises it) and commands.ts's responseOptionsFor
 * so the two can never drift apart — same pattern as MERGE_FAILURE_RESPONSE_OPTIONS.
 */
export const OPERATOR_VERIFICATION_RESPONSE_OPTIONS: Array<{ choice: string; label: string }> = [
  { choice: "verified", label: "Verified — merge" },
  { choice: "waive", label: "Waive — merge without it" },
  { choice: "repair", label: "Another repair round" },
];

/** Dedupe key for the gate's action: one open action per issue + head SHA. */
export function operatorVerificationRequestId(headSha: string): string {
  return `operator-verification:${headSha}`;
}

/**
 * NOT-575: the planner deck tags each criterion `[agent]`, `[ci]` or
 * `[operator]` at the END of the criterion line. Only that trailing tag
 * decides — a criterion whose prose merely mentions `[operator]` but ends in
 * `[agent]` is an agent criterion, never a gate. Case-insensitive; trailing
 * whitespace (including a CR from CRLF ticket text) is ignored. Strictly the
 * last token: `[operator].` with trailing punctuation is NOT a tag.
 */
const TRAILING_OPERATOR_TAG_RE = /\[operator\]\s*$/i;

/** True when the criterion text carries a trailing `[operator]` tag (NOT-575). */
export function hasTrailingOperatorTag(criterionText: string): boolean {
  return TRAILING_OPERATOR_TAG_RE.test(criterionText.trim());
}

/** An indented checkbox (a nested sub-task) — never a command, never a gate. */
const INDENTED_CHECKBOX_RE = /^\s+[-*]\s*\[[ xX]?\]/;
/** An indented plain bullet — an evidence/command sub-bullet. */
const INDENTED_BULLET_RE = /^\s+[-*]\s+(.*)$/;
/**
 * NOT-575: the planner contract's indented `Evidence:` line under a criterion
 * (`  Evidence: ...`, or the nested-bullet form `  * Evidence: ...` the
 * contract compiler also accepts). Collected as the criterion's command the
 * same way a sub-bullet is — without this every contract-ticket criterion
 * gates with an empty command list.
 */
const INDENTED_EVIDENCE_RE = /^\s+(?:[-*+]\s+)?Evidence\s*:\s*(.*)$/i;

/**
 * Returns each top-level (unindented) checkbox AC with a trailing `[operator]`
 * tag (NOT-575: the tag at the end of the criterion line only, never a
 * mention inside the criterion text), together with the indented evidence
 * lines directly under it (sub-bullets and `Evidence:` lines — the commands
 * to run).
 *
 * "Top-level" means the checkbox marker starts at column 0; indented
 * checkboxes (sub-tasks) never open the gate. Collection of a criterion's
 * commands stops at the next column-0 checkbox, an indented checkbox, a
 * non-bullet non-evidence line, or EOF — blank lines inside the block are
 * skipped, not terminators.
 */
export function extractOperatorCriteria(acceptanceCriteria: string): OperatorCriterion[] {
  const found: OperatorCriterion[] = [];
  const lines = acceptanceCriteria.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const top = line.match(/^[-*]\s*\[[ xX]?\]\s*(.*)$/);
    if (top && hasTrailingOperatorTag(top[1] ?? "")) {
      const criterion: OperatorCriterion = { text: (top[1] ?? "").trim(), commands: [] };
      i += 1;
      while (i < lines.length) {
        const sub = lines[i]!;
        if (/^\s*$/.test(sub)) {
          i += 1;
          continue;
        }
        // A column-0 checkbox ends this criterion's block (operator or not —
        // the outer loop classifies it).
        if (/^[-*]\s*\[[ xX]?\]\s*/.test(sub)) break;
        // A nested (indented) checkbox is a sub-task, not a command — it ends
        // the block without being collected.
        if (INDENTED_CHECKBOX_RE.test(sub)) break;
        const evidence = sub.match(INDENTED_EVIDENCE_RE);
        if (evidence) {
          criterion.commands.push(`Evidence: ${(evidence[1] ?? "").trim()}`);
          i += 1;
          continue;
        }
        const bullet = sub.match(INDENTED_BULLET_RE);
        if (bullet) {
          criterion.commands.push((bullet[1] ?? "").trim());
          i += 1;
          continue;
        }
        break;
      }
      found.push(criterion);
      continue;
    }
    i += 1;
  }
  return found;
}

/**
 * NOT-575: the same trailing-tag detection over the frozen execution
 * contract's structured criteria. The contract is the authoritative criterion
 * list for contract tickets — when an explicitly-provided acceptance-criteria
 * string diverges from it, a genuine trailing-`[operator]` contract criterion
 * must still gate. Pure (no DB): the caller supplies the frozen contract.
 */
export function extractOperatorCriteriaFromContract(
  contract: ExecutionContractV1 | null | undefined
): OperatorCriterion[] {
  if (!contract) return [];
  const found: OperatorCriterion[] = [];
  for (const criterion of contract.acceptanceCriteria) {
    if (!hasTrailingOperatorTag(criterion.text)) continue;
    found.push({
      text: criterion.text.trim(),
      commands: criterion.evidence?.trim() ? [`Evidence: ${criterion.evidence.trim()}`] : [],
    });
  }
  return found;
}

/**
 * NOT-575: union of the AC-text criteria and the structured-contract
 * criteria, deduped by exact criterion text (contract tickets render their AC
 * text from the contract, so the two lists normally agree — the union only
 * matters when they diverge). Pure: the caller supplies the frozen snapshot
 * fields, so the gate, the developer prompt, and the reviewer prompt all
 * classify identically without each reading the DB.
 */
export function operatorCriteriaForSnapshot(snapshot: {
  acceptanceCriteria: string;
  executionContract?: ExecutionContractV1 | null;
}): OperatorCriterion[] {
  const seen = new Set<string>();
  const merged: OperatorCriterion[] = [];
  for (const criterion of [
    ...extractOperatorCriteria(snapshot.acceptanceCriteria),
    ...extractOperatorCriteriaFromContract(snapshot.executionContract),
  ]) {
    if (seen.has(criterion.text)) continue;
    seen.add(criterion.text);
    merged.push(criterion);
  }
  return merged;
}

/** The frozen snapshot's acceptanceCriteria, falling back to the live issue
 * fields for items queued before snapshots existed (same fallback as
 * commands.ts's getTaskSnapshot). */
export function snapshotAcceptanceCriteria(issue: Issue): string {
  try {
    const artifact = latestIssueArtifact(issue.id, TASK_SNAPSHOT_KIND);
    if (artifact?.contentJson) {
      const parsed = JSON.parse(artifact.contentJson) as { acceptanceCriteria?: unknown };
      if (typeof parsed.acceptanceCriteria === "string") return parsed.acceptanceCriteria;
    }
  } catch {
    // fall through to the live-field fallback below
  }
  return issue.acceptanceCriteria ?? "";
}

/**
 * NOT-575: the frozen snapshot's execution contract, falling back to the
 * live-issue derived contract for items queued before snapshots existed (same
 * fallback shape as snapshotAcceptanceCriteria above). The contract is the
 * authoritative criterion list when AC text and contract diverge.
 */
export function snapshotExecutionContract(issue: Issue): ExecutionContractV1 | null {
  try {
    const artifact = latestIssueArtifact(issue.id, TASK_SNAPSHOT_KIND);
    if (artifact?.contentJson) {
      const parsed = JSON.parse(artifact.contentJson) as { executionContract?: unknown };
      if (parsed.executionContract && typeof parsed.executionContract === "object") {
        return parsed.executionContract as ExecutionContractV1;
      }
      return null;
    }
  } catch {
    // fall through to the live-field fallback below
  }
  return issue.executionContract ?? null;
}

/** The frozen snapshot's `[operator]` criteria for this issue ([] when none). */
export function getOperatorCriteriaForIssue(issue: Issue): OperatorCriterion[] {
  return operatorCriteriaForSnapshot({
    acceptanceCriteria: snapshotAcceptanceCriteria(issue),
    executionContract: snapshotExecutionContract(issue),
  });
}

interface OperatorVerificationRecord {
  headSha?: unknown;
  note?: unknown;
  /** NOT-575: the criterion texts this result covers. Absent on records
   * written before per-criterion coverage existed — those cover the whole head. */
  criteria?: unknown;
}

function recordHeadSha(record: OperatorVerificationRecord | null): string | null {
  return record && typeof record.headSha === "string" && record.headSha ? record.headSha : null;
}

/**
 * NOT-575: the criterion texts a record covers, or null when the record
 * predates per-criterion coverage (absent/non-list `criteria`) — a legacy
 * record covers the whole head it pins, so a verify-then-crash recovery never
 * re-blocks behind a result the operator already recorded.
 */
function recordCoveredCriteria(record: OperatorVerificationRecord | null): string[] | null {
  if (!record || record.criteria === undefined) return null;
  if (!Array.isArray(record.criteria)) return null;
  return record.criteria.filter((c): c is string => typeof c === "string" && !!c);
}

/** Every recorded result (verified artifact or waiver event) for exactly `headSha`. */
function verificationRecordsForHead(issueId: string, headSha: string): OperatorVerificationRecord[] {
  const records: OperatorVerificationRecord[] = [];
  try {
    for (const artifact of listArtifactsForIssueByKind(issueId, OPERATOR_VERIFICATION_ARTIFACT_KIND)) {
      if (!artifact.contentJson) continue;
      try {
        const record = JSON.parse(artifact.contentJson) as OperatorVerificationRecord;
        if (recordHeadSha(record) === headSha) records.push(record);
      } catch {
        // unreadable artifact content cannot prove verification
      }
    }
  } catch {
    // a read failure fails closed below (no verification found → gate blocks)
  }
  try {
    for (const event of listWorkflowEventsForIssue(issueId)) {
      if (event.type !== "operator_verification.waived" || !event.payloadJson) continue;
      try {
        const record = JSON.parse(event.payloadJson) as OperatorVerificationRecord;
        if (recordHeadSha(record) === headSha) records.push(record);
      } catch {
        // unreadable payload cannot prove a waiver
      }
    }
  } catch {
    // same fail-closed reasoning as above
  }
  return records;
}

/**
 * True when the human already recorded a result for exactly `headSha`: either a
 * `verified` artifact (kind `operator_verification`, author human) or a
 * `operator_verification.waived` workflow event. A result pins the head it was
 * recorded at — new commits re-block the gate.
 *
 * Head-level only: the visual-evidence hold (which has no criterion list)
 * releases on this. Criterion gating uses missingOperatorCriteriaForHead so
 * each trailing-`[operator]` criterion needs its own recorded result.
 */
export function hasOperatorVerificationForHead(issueId: string, headSha: string): boolean {
  if (!headSha) return false;
  return verificationRecordsForHead(issueId, headSha).length > 0;
}

/**
 * NOT-575: the subset of `criteria` with no recorded result for exactly
 * `headSha` ([] when every criterion is covered). A `verified` artifact or a
 * `operator_verification.waived` event covers the criterion texts it lists —
 * the resolve path stores the gated action's exact criterion list, so a
 * result recorded for one criterion never releases another. Legacy records
 * without a criterion list cover the whole head (see recordCoveredCriteria).
 */
export function missingOperatorCriteriaForHead(
  issueId: string,
  headSha: string,
  criteria: OperatorCriterion[]
): OperatorCriterion[] {
  if (criteria.length === 0 || !headSha) return [];
  const records = verificationRecordsForHead(issueId, headSha);
  if (records.length === 0) return [...criteria];
  return criteria.filter((criterion) => {
    for (const record of records) {
      const covered = recordCoveredCriteria(record);
      if (covered === null) return false;
      if (covered.includes(criterion.text)) return false;
    }
    return true;
  });
}

/**
 * NOT-575: one recorded operator attestation for the reviewer prompt — a
 * `verified` result or a `waive`, newest last. The reviewer's sandbox cannot
 * read the PR body, so pasted probe output that only lives there is
 * invisible; a recorded attestation's note carries the same result in the DB
 * and counts as that evidence without a further escalation.
 */
export interface OperatorAttestation {
  kind: "verified" | "waived";
  headSha: string;
  note: string;
  by: string | null;
  at: string | null;
  criteria: string[];
}

function attestationNote(record: Record<string, unknown>): string {
  return typeof record.note === "string" ? record.note : "";
}

/** Every recorded operator attestation for the issue, oldest first ([] when none). */
export function listOperatorAttestations(issueId: string): OperatorAttestation[] {
  const attestations: OperatorAttestation[] = [];
  try {
    for (const artifact of listArtifactsForIssueByKind(issueId, OPERATOR_VERIFICATION_ARTIFACT_KIND)) {
      if (!artifact.contentJson) continue;
      try {
        const record = JSON.parse(artifact.contentJson) as Record<string, unknown> & OperatorVerificationRecord;
        const headSha = recordHeadSha(record);
        if (!headSha) continue;
        attestations.push({
          kind: "verified",
          headSha,
          note: attestationNote(record),
          by: typeof record.verifiedBy === "string" ? record.verifiedBy : null,
          at: typeof record.verifiedAt === "string" ? record.verifiedAt : (artifact.createdAt ?? null),
          criteria: recordCoveredCriteria(record) ?? [],
        });
      } catch {
        // unreadable content is not an attestation
      }
    }
  } catch {
    // a read failure yields no attestations (the reviewer judges without them)
  }
  try {
    for (const event of listWorkflowEventsForIssue(issueId)) {
      if (event.type !== "operator_verification.waived" || !event.payloadJson) continue;
      try {
        const record = JSON.parse(event.payloadJson) as Record<string, unknown> & OperatorVerificationRecord;
        const headSha = recordHeadSha(record);
        if (!headSha) continue;
        attestations.push({
          kind: "waived",
          headSha,
          note: attestationNote(record),
          by: typeof record.waivedBy === "string" ? record.waivedBy : null,
          at: event.ts ?? null,
          criteria: recordCoveredCriteria(record) ?? [],
        });
      } catch {
        // unreadable payload is not an attestation
      }
    }
  } catch {
    // same leniency as above
  }
  return attestations;
}

/**
 * NOT-575: the criterion texts an `operator_verification` action gates (its
 * stored `evidence.operatorVerification.criteria`), or null when the action
 * predates that evidence shape or is unreadable. The resolve path stores
 * exactly this list on the recorded result, so the result covers the gated
 * criteria — that exact criterion set — and nothing else.
 */
export function criteriaTextsFromActionEvidence(action: {
  evidenceJson: string | null;
}): string[] | null {
  if (!action.evidenceJson) return null;
  try {
    const evidence = JSON.parse(action.evidenceJson) as {
      operatorVerification?: { criteria?: unknown };
    };
    const criteria = evidence.operatorVerification?.criteria;
    if (!Array.isArray(criteria)) return null;
    return criteria
      .map((c) => (c && typeof c === "object" ? (c as { text?: unknown }).text : null))
      .filter((t): t is string => typeof t === "string" && !!t);
  } catch {
    return null;
  }
}

/** One numbered criterion + its commands, for the gate's reason/question. */
export function formatOperatorCriteria(criteria: OperatorCriterion[]): string[] {
  return criteria.flatMap((criterion, index) => {
    const lines = [`${index + 1}. ${criterion.text}`];
    for (const command of criterion.commands) lines.push(`   - ${command}`);
    return lines;
  });
}
