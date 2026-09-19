// packages/server/src/coordinator/workflows/registry.ts
//
// Mirror of effect-registry.ts: kernel looks up a template by version string;
// template modules call registerWorkflow at load/startup. Unknown versions fail
// loudly — never silently fall back to Dev-review.
import type { WorkflowTemplate } from "./types.js";

const registry = new Map<string, WorkflowTemplate>();

export function registerWorkflow(template: WorkflowTemplate): void {
  registry.set(template.version, template);
}

export function getWorkflow(version: string): WorkflowTemplate {
  const template = registry.get(version);
  if (!template) {
    throw new Error(`Unknown workflow template: ${version}`);
  }
  return template;
}

export function listWorkflows(): WorkflowTemplate[] {
  return [...registry.values()];
}
