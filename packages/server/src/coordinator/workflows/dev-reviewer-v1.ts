// packages/server/src/coordinator/workflows/dev-reviewer-v1.ts
//
// Existing Dev-review product behavior, registered as one workflow template.
// Transition logic stays in commands/routing; this module owns the version id
// and the roles/effects this template uses.
import type { WorkflowTemplate } from "./types.js";
import { registerWorkflow } from "./registry.js";

export const DEV_REVIEWER_V1_VERSION = "dev_reviewer_v1";

export const devReviewerV1: WorkflowTemplate = {
  version: DEV_REVIEWER_V1_VERSION,
  roles: ["developer", "reviewer"],
  effectKinds: ["developer", "reviewer"],
};

registerWorkflow(devReviewerV1);
