// packages/server/src/coordinator/workflows/types.ts
//
// Pluggable workflow template definition. The coordinator kernel owns leases,
// events, and dispatch; each template module registers one of these shapes.
import type { WorkItemKind } from "../../repository/work-items.js";

export interface WorkflowTemplate {
  /** Immutable version id stored on workflow_instances (e.g. "dev_reviewer_v1"). */
  version: string;
  /** Roles this template schedules as currentOwner. */
  roles: readonly ("developer" | "reviewer")[];
  /** Effect kinds the kernel may enqueue/dispatch for this template. */
  effectKinds: readonly WorkItemKind[];
}
