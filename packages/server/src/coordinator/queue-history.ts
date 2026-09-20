// packages/server/src/coordinator/queue-history.ts
//
// NOT-168: reconstruct queue wait and admission/dependency wait from durable
// append-only evidence (`workflow_events` queue.* rows) instead of the mutable
// `queue_entries.state` / latest `wait_reason` snapshot.
//
// Contract: docs/EXECUTION_ANALYSIS.md §§1–4, 6, 8. Intervals are half-open
// [start, end) UTC epoch ms; same-millisecond events order by the
// `workflow_events` rowid cursor, never by timestamp alone.

import { getDb } from "../db/index.js";

export const QUEUE_WAIT_CATEGORIES = [
  "capacity",
  "readiness",
  "dependency",
  "runtime_health",
  "runtime_cap",
  "agent_deck",
  "other",
] as const;

export type QueueWaitCategory = (typeof QUEUE_WAIT_CATEGORIES)[number];

export type EvidenceQuality = "exact" | "inferred" | "unavailable";

/**
 * Stable category for a human-readable wait reason. The prose stays verbatim in
 * the event payload (`reason`); this code is the aggregation key. Order is
 * specific-first: capacity and runtime_cap phrases never also match a later
 * class, while deck/dependency/health/readiness share vocabulary ("unhealthy",
 * "missing") and must be tested in this order.
 */
export function classifyQueueWaitReason(reason: string | null | undefined): QueueWaitCategory {
  if (!reason) return "other";
  if (/waiting for slot|no free admission slots/i.test(reason)) return "capacity";
  if (/runtime capped|usage capped/i.test(reason)) return "runtime_cap";
  if (
    /agent deck offline|deck mcp unavailable|deck .*not available|set an agent deck|no agent deck|agent-deck setup|mcp not registered/i.test(
      reason
    )
  )
    return "agent_deck";
  if (/waiting on |dependency state unavailable|\blinear\b/i.test(reason)) return "dependency";
  if (
    /unhealthy|not authenticated|could not confirm|probe (timed out|failed)|cli not found|auth login|missing .*agent|agent not found/i.test(
      reason
    )
  )
    return "runtime_health";
  if (/not startable|missing |acceptance criteria|active workflow/i.test(reason)) return "readiness";
  return "other";
}

export interface QueueHistoryEvent {
  cursor: number;
  ts: string;
  type: string;
  payload: {
    from?: string | null;
    to?: string | null;
    category?: string | null;
    reason?: string | null;
  } | null;
}

export interface QueueHistoryRow {
  enqueuedAt: string;
  state: string;
}

export interface QueueWaitInterval {
  start: string;
  startCursor: number | null;
  end: string | null;
  endCursor: number | null;
  quality: EvidenceQuality;
  reasons: string[];
}

export interface AdmissionWaitInterval extends QueueWaitInterval {
  category: QueueWaitCategory;
  /** Verbatim operator prose at this segment; null before the first reason is recorded. */
  reason: string | null;
}

export interface QueueHistory {
  /** Parent `queue_wait` intervals, one per enqueue episode. */
  queueWaits: QueueWaitInterval[];
  /** Nested per-reason sub-intervals tiling the parent (drill-down only, never additive). */
  admissionWaits: AdmissionWaitInterval[];
}

const QUEUE_EVENT_TYPES = new Set([
  "queue.enqueued",
  "queue.wait_reason_changed",
  "queue.admitted",
  "queue.removed",
]);

function parseTs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function asCategory(value: unknown, fallbackReason: string | null): QueueWaitCategory {
  if (typeof value === "string" && (QUEUE_WAIT_CATEGORIES as readonly string[]).includes(value)) {
    return value as QueueWaitCategory;
  }
  return classifyQueueWaitReason(fallbackReason);
}

function negativeDuration(start: string, end: string): boolean {
  const s = parseTs(start);
  const e = parseTs(end);
  return s !== null && e !== null && e < s;
}

/**
 * Pure derivation over queue events (ascending (ts, cursor)) plus the issue's
 * queue rows for legacy backfill. Never invents a terminal timestamp: episodes
 * without a terminal event stay open-ended, and pre-instrumentation rows
 * without any events yield an inferred open interval (still queued) or an
 * unavailable one (terminal state, end unknown).
 */
export function deriveQueueHistory(
  events: QueueHistoryEvent[],
  queueRows: QueueHistoryRow[]
): QueueHistory {
  const ordered = [...events]
    .filter((e) => QUEUE_EVENT_TYPES.has(e.type))
    .sort((a, b) => {
      const ta = parseTs(a.ts) ?? 0;
      const tb = parseTs(b.ts) ?? 0;
      return ta - tb || a.cursor - b.cursor;
    });

  // No durable evidence: every legacy row stands on its own enqueued_at.
  if (ordered.length === 0) {
    return {
      queueWaits: queueRows.map((row) =>
        row.state === "queued"
          ? {
              start: row.enqueuedAt,
              startCursor: null,
              end: null,
              endCursor: null,
              quality: "inferred" as const,
              reasons: ["backfill", "open_interval"],
            }
          : {
              start: row.enqueuedAt,
              startCursor: null,
              end: null,
              endCursor: null,
              quality: "unavailable" as const,
              reasons: ["backfill", "missing_queue_terminal"],
            }
      ),
      admissionWaits: [],
    };
  }

  // Split into enqueue episodes. A leading run of non-enqueued events (row
  // written before this instrumentation, reasons recorded after) attaches to a
  // backfilled episode starting at the earliest known enqueued_at.
  const episodes: QueueHistoryEvent[][] = [];
  for (const event of ordered) {
    // A second `queue.enqueued` starts a new episode; the previous one stays
    // open (its end is unknown, never fabricated).
    if (event.type === "queue.enqueued" || episodes.length === 0) {
      episodes.push([]);
    }
    episodes[episodes.length - 1]!.push(event);
  }

  const earliestEnqueuedAt =
    queueRows.length > 0
      ? [...queueRows].sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : 1))[0]!.enqueuedAt
      : null;

  const queueWaits: QueueWaitInterval[] = [];
  const admissionWaits: AdmissionWaitInterval[] = [];

  for (const episode of episodes) {
    const enqueued = episode.find((e) => e.type === "queue.enqueued");
    const terminal = [...episode]
      .reverse()
      .find((e) => e.type === "queue.admitted" || e.type === "queue.removed");
    const backfilledStart = !enqueued && earliestEnqueuedAt !== null;
    const start = enqueued ? enqueued.ts : (earliestEnqueuedAt ?? episode[0]!.ts);
    const startCursor = enqueued ? enqueued.cursor : null;
    const end = terminal ? terminal.ts : null;
    const endCursor = terminal ? terminal.cursor : null;

    let quality: EvidenceQuality;
    let reasons: string[];
    if (terminal) {
      if (negativeDuration(start, terminal.ts)) {
        quality = "unavailable";
        reasons = ["negative_duration"];
      } else {
        quality = backfilledStart ? "inferred" : "exact";
        reasons = backfilledStart ? ["backfill"] : [];
      }
    } else {
      quality = "inferred";
      reasons = backfilledStart ? ["backfill", "open_interval"] : ["open_interval"];
    }
    queueWaits.push({ start, startCursor, end, endCursor, quality, reasons });

    // Tile the episode with per-reason segments. The stretch before the first
    // recorded reason has no prose — category `other`, reason null.
    let segStart = start;
    let segCursor = startCursor;
    let segBackfilled = backfilledStart;
    let segCategory: QueueWaitCategory = "other";
    let segReason: string | null = null;
    const closeSegment = (segEnd: string | null, segEndCursor: number | null): void => {
      if (segEnd !== null && negativeDuration(segStart, segEnd)) {
        admissionWaits.push({
          start: segStart,
          startCursor: segCursor,
          end: segEnd,
          endCursor: segEndCursor,
          quality: "unavailable",
          reasons: ["negative_duration"],
          category: segCategory,
          reason: segReason,
        });
        return;
      }
      if (segEnd === null) {
        admissionWaits.push({
          start: segStart,
          startCursor: segCursor,
          end: null,
          endCursor: null,
          quality: "inferred",
          reasons: segBackfilled ? ["backfill", "open_interval"] : ["open_interval"],
          category: segCategory,
          reason: segReason,
        });
        return;
      }
      // A change event with the same ts as the segment start is an empty
      // [t, t) interval — contributes 0, still recorded for contiguity.
      admissionWaits.push({
        start: segStart,
        startCursor: segCursor,
        end: segEnd,
        endCursor: segEndCursor,
        quality: segBackfilled ? "inferred" : "exact",
        reasons: segBackfilled ? ["backfill"] : [],
        category: segCategory,
        reason: segReason,
      });
    };

    for (const event of episode) {
      if (event.type !== "queue.wait_reason_changed") continue;
      const to = event.payload?.to ?? event.payload?.reason ?? null;
      const toText = typeof to === "string" ? to : null;
      // No-op guard: a duplicated change event never splits a segment.
      if (toText === segReason) continue;
      closeSegment(event.ts, event.cursor);
      segStart = event.ts;
      segCursor = event.cursor;
      segBackfilled = false;
      segReason = toText;
      segCategory = asCategory(event.payload?.category, toText);
    }
    closeSegment(end, endCursor);
  }

  return { queueWaits, admissionWaits };
}

interface QueueEventRow {
  cursor: number;
  ts: string;
  type: string;
  payload_json: string | null;
}

/** DB-backed loader: queue.* events by (ts, rowid) plus all queue rows for the issue. */
export function getQueueHistoryForIssue(issueId: string): QueueHistory {
  const db = getDb();
  const eventRows = db
    .prepare(
      `SELECT rowid AS cursor, ts, type, payload_json FROM workflow_events
       WHERE issue_id = ? AND type IN ('queue.enqueued','queue.wait_reason_changed','queue.admitted','queue.removed')
       ORDER BY ts ASC, rowid ASC`
    )
    .all(issueId) as QueueEventRow[];
  const rows = db
    .prepare("SELECT enqueued_at AS enqueuedAt, state FROM queue_entries WHERE issue_id = ? ORDER BY enqueued_at ASC")
    .all(issueId) as QueueHistoryRow[];
  return deriveQueueHistory(
    eventRows.map((row) => {
      let payload: QueueHistoryEvent["payload"] = null;
      if (row.payload_json) {
        try {
          payload = JSON.parse(row.payload_json) as QueueHistoryEvent["payload"];
        } catch {
          payload = null;
        }
      }
      return { cursor: row.cursor, ts: row.ts, type: row.type, payload };
    }),
    rows
  );
}
