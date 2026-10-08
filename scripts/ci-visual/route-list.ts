// scripts/ci-visual/route-list.ts
//
// Pure loader for ui-screenshots.json: validates the route list the CI `visual`
// job captures. No I/O, no browser — unit-testable in the builder sandbox.

export interface VisualViewport {
  width: number;
  height: number;
}

export type VisualStepAction = "click" | "waitFor";
export type VisualStepBy = "role" | "label" | "testid";

export interface VisualStep {
  action: VisualStepAction;
  /**
   * Stable selector engine only: an ARIA role (`value` is the role name,
   * `name` the accessible name), an ARIA label (`value` is the label text),
   * or a `data-testid` (`value` is the test id). Raw CSS/XPath selectors are
   * rejected — interaction steps must survive restyling.
   */
  by: VisualStepBy;
  value: string;
  /** Accessible name for `by: "role"` (e.g. role `button` named `Close issue`). */
  name?: string;
}

export interface VisualRoute {
  name: string;
  path: string;
  needsSeededIssue: boolean;
  steps: VisualStep[];
}

export interface VisualRouteList {
  viewports: VisualViewport[];
  routes: VisualRoute[];
}

export class VisualConfigError extends Error {
  constructor(message: string) {
    super(`[ci-visual] ${message}`);
    this.name = "VisualConfigError";
  }
}

/** Required evidence viewports (NOT-383) when the config omits `viewports`. */
export const DEFAULT_VIEWPORTS: VisualViewport[] = [
  { width: 1440, height: 900 },
  { width: 390, height: 800 },
];

function parseViewports(raw: unknown): VisualViewport[] {
  if (raw === undefined) return DEFAULT_VIEWPORTS.map((v) => ({ ...v }));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new VisualConfigError(`"viewports" must be a non-empty array of { "width", "height" } objects`);
  }
  return raw.map((entry, index) => {
    const where = `"viewports[${index}]"`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new VisualConfigError(
        `${where} must be an object like { "width": 1440, "height": 900 }, got ${JSON.stringify(entry)}`
      );
    }
    const { width, height } = entry as Record<string, unknown>;
    if (!Number.isInteger(width) || (width as number) <= 0) {
      throw new VisualConfigError(
        `${where} has an invalid "width" ${JSON.stringify(width)}: must be a positive integer`
      );
    }
    if (!Number.isInteger(height) || (height as number) <= 0) {
      throw new VisualConfigError(
        `${where} has an invalid "height" ${JSON.stringify(height)}: must be a positive integer`
      );
    }
    return { width: width as number, height: height as number };
  });
}

const STEP_ACTIONS: VisualStepAction[] = ["click", "waitFor"];
const STEP_BYS: VisualStepBy[] = ["role", "label", "testid"];

function parseSteps(raw: unknown, routeName: string): VisualStep[] {
  if (raw === undefined) return [];
  const where = `route "${routeName}"`;
  if (!Array.isArray(raw)) {
    throw new VisualConfigError(`${where} "steps" must be an array of { "action", "by", "value" } objects`);
  }
  return raw.map((entry, index) => {
    const at = `${where} step ${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new VisualConfigError(`${at} must be an object with "action", "by", and "value"`);
    }
    const step = entry as Record<string, unknown>;
    if (typeof step.action !== "string" || !STEP_ACTIONS.includes(step.action as VisualStepAction)) {
      throw new VisualConfigError(
        `${at} has an unknown action ${JSON.stringify(step.action)}: expected "click" or "waitFor"`
      );
    }
    if (typeof step.by !== "string" || !STEP_BYS.includes(step.by as VisualStepBy)) {
      throw new VisualConfigError(
        `${at} has an unknown selector ${JSON.stringify(step.by)}: expected "role", "label", or "testid"`
      );
    }
    if (typeof step.value !== "string" || step.value.trim() === "") {
      throw new VisualConfigError(`${at} has an empty selector "value"`);
    }
    if (step.name !== undefined && (typeof step.name !== "string" || step.name.trim() === "")) {
      throw new VisualConfigError(`${at} has an empty "name": omit it or give a non-empty accessible name`);
    }
    const parsed: VisualStep = {
      action: step.action as VisualStepAction,
      by: step.by as VisualStepBy,
      value: step.value,
    };
    if (step.name !== undefined) parsed.name = step.name as string;
    return parsed;
  });
}

function parseRoute(entry: unknown, index: number): VisualRoute {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new VisualConfigError(`route at index ${index} must be an object with "name" and "path"`);
  }
  const raw = entry as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new VisualConfigError(`route at index ${index} is missing a non-empty "name"`);
  }
  if (typeof raw.path !== "string" || raw.path === "") {
    throw new VisualConfigError(`route "${raw.name}" is missing a "path"`);
  }
  if (!raw.path.startsWith("/")) {
    throw new VisualConfigError(`route "${raw.name}" path must start with "/", got ${JSON.stringify(raw.path)}`);
  }
  if (raw.needsSeededIssue !== undefined && typeof raw.needsSeededIssue !== "boolean") {
    throw new VisualConfigError(`route "${raw.name}" "needsSeededIssue" must be a boolean`);
  }
  return {
    name: raw.name,
    path: raw.path,
    needsSeededIssue: raw.needsSeededIssue === true,
    steps: parseSteps(raw.steps, raw.name),
  };
}

/** Parse and validate an unknown JSON value as a screenshot route list. */
export function loadRouteList(input: unknown): VisualRouteList {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new VisualConfigError(`route list must be a JSON object with a "routes" array`);
  }
  const raw = input as Record<string, unknown>;
  if (raw.widths !== undefined) {
    throw new VisualConfigError(
      `config uses the removed "widths" key — use "viewports" instead, e.g. "viewports": [{ "width": 1440, "height": 900 }] (NOT-383)`
    );
  }
  const viewports = parseViewports(raw.viewports);
  if (!Array.isArray(raw.routes) || raw.routes.length === 0) {
    throw new VisualConfigError(`route list must contain a non-empty "routes" array`);
  }
  const routes = raw.routes.map((entry, index) => parseRoute(entry, index));
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.name)) {
      throw new VisualConfigError(`duplicate route name ${JSON.stringify(route.name)}`);
    }
    seen.add(route.name);
  }
  return { viewports, routes };
}
