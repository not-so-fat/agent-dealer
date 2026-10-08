// scripts/ci-visual/plan.ts
//
// Pure screenshot-plan builder: expands (route, viewport) pairs into concrete
// capture entries. No I/O, no browser — unit-testable in the builder sandbox.

import { VisualConfigError, type VisualRoute, type VisualStep, type VisualViewport } from "./route-list.js";

export interface ScreenshotShot {
  /** Config key, e.g. "issues-home". */
  name: string;
  /** Configured route template, e.g. "/issues/{{issueId}}". */
  route: string;
  /** Resolved path with seeds substituted, e.g. "/issues/abc-123". */
  path: string;
  width: number;
  height: number;
  /** Viewport label, e.g. "1440x900". */
  viewport: string;
  /** Interaction steps to run before the screenshot (may be empty). */
  steps: VisualStep[];
  /** Unique per (route, viewport), e.g. "issues-home-1440x900.png". */
  filename: string;
}

export function formatViewport(viewport: VisualViewport): string {
  return `${viewport.width}x${viewport.height}`;
}

/**
 * Expand routes × viewports into capture entries. Viewports are validated here
 * (not in the loader) so a config carrying a duplicate viewport fails loudly
 * with the offending value named.
 */
export function buildScreenshotPlan(routes: VisualRoute[], viewports: VisualViewport[]): ScreenshotShot[] {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new VisualConfigError("screenshot plan needs at least one route");
  }
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new VisualConfigError("screenshot plan needs at least one viewport");
  }
  const seen = new Set<string>();
  for (const viewport of viewports) {
    if (
      typeof viewport !== "object" ||
      viewport === null ||
      !Number.isInteger(viewport.width) ||
      viewport.width <= 0 ||
      !Number.isInteger(viewport.height) ||
      viewport.height <= 0
    ) {
      throw new VisualConfigError(
        `invalid viewport ${JSON.stringify(viewport)}: must be { "width", "height" } positive integers`
      );
    }
    const label = formatViewport(viewport);
    if (seen.has(label)) {
      throw new VisualConfigError(`duplicate viewport ${label}`);
    }
    seen.add(label);
  }
  return routes.flatMap((route) =>
    viewports.map((viewport) => {
      const label = formatViewport(viewport);
      return {
        name: route.name,
        route: route.path,
        path: route.path,
        width: viewport.width,
        height: viewport.height,
        viewport: label,
        steps: route.steps.map((step) => ({ ...step })),
        filename: `${route.name}-${label}.png`,
      };
    })
  );
}

/**
 * Substitute `{{seed}}` placeholders (e.g. `{{issueId}}` for the seeded
 * fixture issue) in a route path. Throws on any placeholder without a seed
 * value so the job fails fast instead of screenshotting a literal
 * "/issues/%7B%7BissueId%7D%7D" 404.
 */
export function resolveSeededPath(path: string, seeds: Record<string, string>): string {
  return path.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => {
    const value = seeds[key];
    if (value === undefined || value === "") {
      throw new VisualConfigError(
        `route path ${JSON.stringify(path)} needs a seed value for ${JSON.stringify(placeholder)}`
      );
    }
    return value;
  });
}
