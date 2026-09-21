// packages/server/src/coordinator/execution-intervals.ts
//
// NOT-169: pure derivation of setup / agent-process / validation-publish intervals from
// durable workflow events (EXECUTION_ANALYSIS.md §2/§4/§8).
//
// Rules:
// - Inputs are ordered by durable insertion cursor (rowid); same-millisecond ties are
//   deterministic and never guessed.
// - `exact` requires both boundaries from the named recorded events.
// - Old sessions may carry an inferred agent duration from `usage_events.duration_ms`
//   (the coordinator-measured spawn envelope), but it is never presented as exact
//   boundaries and never substitutes for wall-clock start/end.
// - Publish-only attempts (no agent process) have no agent interval; their coordinator
//   work is measurable as [worker.started, terminal) and tagged publishOnly.
// - A negative duration is `unavailable` (reason negative_duration), never clamped.

export type IntervalQuality = "exact" | "inferred" | "unavailable";

export interface DerivedInterval {
  phase: "coordinator_setup" | "agent_process" | "coordinator_validation_publish" | "coordinator_work";
  startMs: number | null;
  endMs: number | null;
  /** Half-open [start, end) length, or an inferred envelope length when boundaries are absent. */
  durationMs: number | null;
  quality: IntervalQuality;
  reasons: string[];
}

export interface BoundaryEvent {
  type: string;
  ts: string;
  /** Durable insertion cursor — SQLite rowid of workflow_events. */
  rowid: number;
}

export interface DeriveAttemptIntervalsInput {
  events: BoundaryEvent[];
  /** Coordinator-measured spawn envelope (usage_events.duration_ms); resource evidence only. */
  usageDurationMs?: number | null;
  /** usage_events.ts — upper bound for agent.completed at best. */
  usageTs?: string | null;
  publishOnly?: boolean;
}

export interface AttemptIntervals {
  setup: DerivedInterval;
  agentProcess: DerivedInterval;
  validationPublish: DerivedInterval;
  /** Only set for publishOnly attempts: [worker.started, terminal) coordinator work. */
  coordinatorWork: DerivedInterval | null;
  /** Spawn envelope resource evidence; never an exact wall-clock boundary. */
  spawnEnvelope: { durationMs: number | null; quality: IntervalQuality; reasons: string[] };
}

function msOf(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function unavailable(
  phase: DerivedInterval["phase"],
  reasons: string[]
): DerivedInterval {
  return { phase, startMs: null, endMs: null, durationMs: null, quality: "unavailable", reasons };
}

function ordered(events: BoundaryEvent[], types: Set<string>): BoundaryEvent[] {
  return events
    .filter((e) => types.has(e.type))
    .sort((a, b) => {
      const ta = Date.parse(a.ts);
      const tb = Date.parse(b.ts);
      if (ta !== tb) return ta - tb;
      return a.rowid - b.rowid;
    });
}

function firstOf(events: BoundaryEvent[], type: string): BoundaryEvent | null {
  const found = ordered(events, new Set([type]));
  return found[0] ?? null;
}

function between(
  phase: DerivedInterval["phase"],
  start: BoundaryEvent | null,
  end: BoundaryEvent | null,
  missingReason: string
): DerivedInterval {
  if (!start || !end) return unavailable(phase, [missingReason]);
  const s = msOf(start.ts);
  const e = msOf(end.ts);
  if (s === null || e === null) return unavailable(phase, ["no_defensible_boundary"]);
  if (e < s) return unavailable(phase, ["negative_duration"]);
  return { phase, startMs: s, endMs: e, durationMs: e - s, quality: "exact", reasons: [] };
}

export function deriveAttemptIntervals(input: DeriveAttemptIntervalsInput): AttemptIntervals {
  const { events, publishOnly } = input;
  const workerStarted = firstOf(events, "worker.started");
  const agentStarted = firstOf(events, "agent.started");
  const agentCompleted = firstOf(events, "agent.completed");
  const terminal =
    firstOf(events, "worker.completed") ?? firstOf(events, "worker.failed");

  const usageDuration =
    input.usageDurationMs != null && Number.isFinite(input.usageDurationMs)
      ? input.usageDurationMs
      : null;
  const spawnEnvelope =
    usageDuration != null
      ? {
          durationMs: usageDuration,
          quality: "inferred" as IntervalQuality,
          reasons: ["includes_spawn_slot_wait", "includes_post_exit_work"],
        }
      : { durationMs: null, quality: "unavailable" as IntervalQuality, reasons: ["missing_provider_metadata"] };

  if (publishOnly) {
    const work =
      workerStarted && terminal
        ? (() => {
            const s = msOf(workerStarted.ts);
            const e = msOf(terminal.ts);
            if (s === null || e === null) return unavailable("coordinator_work", ["no_defensible_boundary"]);
            if (e < s) return unavailable("coordinator_work", ["negative_duration"]);
            return {
              phase: "coordinator_work" as const,
              startMs: s,
              endMs: e,
              durationMs: e - s,
              quality: "exact" as IntervalQuality,
              reasons: ["publish_only"],
            };
          })()
        : unavailable("coordinator_work", ["missing_queue_terminal"]);
    return {
      setup: unavailable("coordinator_setup", ["publish_only"]),
      agentProcess: unavailable("agent_process", ["no_agent_process"]),
      validationPublish: unavailable("coordinator_validation_publish", ["publish_only"]),
      coordinatorWork: { ...work, reasons: [...work.reasons.filter((r) => r !== "publish_only"), "publish_only"] },
      spawnEnvelope,
    };
  }

  const setup = between("coordinator_setup", workerStarted, agentStarted, "no_defensible_boundary");

  let agentProcess = between("agent_process", agentStarted, agentCompleted, "no_defensible_boundary");
  if (agentProcess.quality === "unavailable" && usageDuration != null) {
    agentProcess = {
      phase: "agent_process",
      startMs: null,
      endMs: null,
      durationMs: usageDuration,
      quality: "inferred",
      reasons: ["proxy_boundary", "includes_spawn_slot_wait", "includes_post_exit_work", "backfill"],
    };
  }

  let validationPublish = between(
    "coordinator_validation_publish",
    agentCompleted,
    terminal,
    agentCompleted ? "missing_queue_terminal" : "no_defensible_boundary"
  );
  if (validationPublish.quality === "unavailable" && !agentCompleted && agentStarted && terminal && input.usageTs) {
    const u = msOf(input.usageTs);
    const t = msOf(terminal.ts);
    if (u !== null && t !== null && t >= u) {
      validationPublish = {
        phase: "coordinator_validation_publish",
        startMs: u,
        endMs: t,
        durationMs: t - u,
        quality: "inferred",
        reasons: ["proxy_boundary", "upper_bound", "includes_post_exit_work"],
      };
    }
  }

  return { setup, agentProcess, validationPublish, coordinatorWork: null, spawnEnvelope };
}
