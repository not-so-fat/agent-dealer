// packages/server/src/coordinator/effect-registry.ts
//
// The kernel owns durable dispatch, transitions, and recovery; the *work* a leased item
// performs is a pluggable effect. NOT-59 ships placeholder developer/reviewer handlers
// that always report a failed session — real worktree + spawn + gh verification land in
// NOT-60/61/62 by calling registerEffectHandler at server startup. Tests register fakes.
import type { Issue } from "@agent-dealer/shared";
import type { WorkflowInstance } from "@agent-dealer/shared";
import type { DeveloperOutcome, ReviewerOutcome } from "./routing.js";
import type { WorkItem, WorkItemKind } from "../repository/work-items.js";

export interface EffectContext {
  workItem: WorkItem;
  issue: Issue;
  instance: WorkflowInstance;
  /** Aborted when the lease is lost (heartbeat rejected) — a handler should stop work. */
  signal: AbortSignal;
}

export type EffectHandler = (
  ctx: EffectContext
) => Promise<DeveloperOutcome | ReviewerOutcome>;

const NOT_IMPLEMENTED_REASON =
  "effect handler not implemented — lands in NOT-61 (developer) / NOT-62 (reviewer)";

const defaultHandlers: Record<WorkItemKind, EffectHandler> = {
  developer: async () => ({ kind: "session_failed" }),
  reviewer: async () => ({ kind: "session_failed" }),
};

const registry = new Map<WorkItemKind, EffectHandler>();

export function registerEffectHandler(kind: WorkItemKind, handler: EffectHandler): void {
  registry.set(kind, handler);
}

/** Test hook — restores the placeholder handlers. */
export function resetEffectHandlers(): void {
  registry.clear();
}

export function getEffectHandler(kind: WorkItemKind): EffectHandler {
  return registry.get(kind) ?? defaultHandlers[kind];
}

export { NOT_IMPLEMENTED_REASON };
