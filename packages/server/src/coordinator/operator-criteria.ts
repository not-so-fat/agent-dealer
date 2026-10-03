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

import type { Issue } from "@agent-dealer/shared";
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

const OPERATOR_TAG_RE = /\[operator\]/i;
/** An indented checkbox (a nested sub-task) — never a command, never a gate. */
const INDENTED_CHECKBOX_RE = /^\s+[-*]\s*\[[ xX]?\]/;
/** An indented plain bullet — an evidence/command sub-bullet. */
const INDENTED_BULLET_RE = /^\s+[-*]\s+(.*)$/;

/**
 * Returns each top-level (unindented) checkbox AC whose text contains the token
 * `[operator]` (case-insensitive, anywhere in the line), together with the
 * indented bullet lines directly under it (the command to run).
 *
 * "Top-level" means the checkbox marker starts at column 0; indented
 * checkboxes (sub-tasks) never open the gate. Collection of a criterion's
 * commands stops at the next column-0 checkbox, a non-bullet line, or EOF —
 * blank lines inside the sub-bullet block are skipped, not terminators.
 */
export function extractOperatorCriteria(acceptanceCriteria: string): OperatorCriterion[] {
  const found: OperatorCriterion[] = [];
  const lines = acceptanceCriteria.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const top = line.match(/^[-*]\s*\[[ xX]?\]\s*(.*)$/);
    if (top && OPERATOR_TAG_RE.test(top[1] ?? "")) {
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

/** The frozen snapshot's `[operator]` criteria for this issue ([] when none). */
export function getOperatorCriteriaForIssue(issue: Issue): OperatorCriterion[] {
  return extractOperatorCriteria(snapshotAcceptanceCriteria(issue));
}

interface OperatorVerificationRecord {
  headSha?: unknown;
  note?: unknown;
}

function recordHeadSha(record: OperatorVerificationRecord | null): string | null {
  return record && typeof record.headSha === "string" && record.headSha ? record.headSha : null;
}

/**
 * True when the human already recorded a result for exactly `headSha`: either a
 * `verified` artifact (kind `operator_verification`, author human) or a
 * `operator_verification.waived` workflow event. A result pins the head it was
 * recorded at — new commits re-block the gate.
 */
export function hasOperatorVerificationForHead(issueId: string, headSha: string): boolean {
  if (!headSha) return false;
  try {
    for (const artifact of listArtifactsForIssueByKind(issueId, OPERATOR_VERIFICATION_ARTIFACT_KIND)) {
      if (!artifact.contentJson) continue;
      try {
        const record = JSON.parse(artifact.contentJson) as OperatorVerificationRecord;
        if (recordHeadSha(record) === headSha) return true;
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
        if (recordHeadSha(record) === headSha) return true;
      } catch {
        // unreadable payload cannot prove a waiver
      }
    }
  } catch {
    // same fail-closed reasoning as above
  }
  return false;
}

/** One numbered criterion + its commands, for the gate's reason/question. */
export function formatOperatorCriteria(criteria: OperatorCriterion[]): string[] {
  return criteria.flatMap((criterion, index) => {
    const lines = [`${index + 1}. ${criterion.text}`];
    for (const command of criterion.commands) lines.push(`   - ${command}`);
    return lines;
  });
}
