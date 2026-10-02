// scripts/ci-visual/route-list.ts
//
// Pure loader for ui-screenshots.json: validates the route list the CI `visual`
// job captures. No I/O, no browser — unit-testable in the builder sandbox.

export interface VisualRoute {
  name: string;
  path: string;
  needsSeededIssue: boolean;
}

export interface VisualRouteList {
  widths: number[];
  routes: VisualRoute[];
}

export class VisualConfigError extends Error {
  constructor(message: string) {
    super(`[ci-visual] ${message}`);
    this.name = "VisualConfigError";
  }
}

/** Desktop + narrow widths from NOT-312 when the config omits `widths`. */
export const DEFAULT_WIDTHS: number[] = [1280, 320];

function parseWidths(raw: unknown): number[] {
  if (raw === undefined) return [...DEFAULT_WIDTHS];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new VisualConfigError(`"widths" must be a non-empty array of viewport widths`);
  }
  for (const w of raw) {
    if (!Number.isInteger(w) || (w as number) <= 0) {
      throw new VisualConfigError(
        `invalid viewport width ${JSON.stringify(w)}: must be a positive integer`
      );
    }
  }
  return [...(raw as number[])];
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
  };
}

/** Parse and validate an unknown JSON value as a screenshot route list. */
export function loadRouteList(input: unknown): VisualRouteList {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new VisualConfigError(`route list must be a JSON object with a "routes" array`);
  }
  const raw = input as Record<string, unknown>;
  const widths = parseWidths(raw.widths);
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
  return { widths, routes };
}
