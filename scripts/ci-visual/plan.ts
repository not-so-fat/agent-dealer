// scripts/ci-visual/plan.ts
//
// Pure screenshot-plan builder: expands (route, width) pairs into concrete
// capture entries. No I/O, no browser — unit-testable in the builder sandbox.

import { VisualConfigError, type VisualRoute } from "./route-list.js";

export interface ScreenshotShot {
  /** Config key, e.g. "issues-home". */
  name: string;
  /** Configured route template, e.g. "/issues/{{issueId}}". */
  route: string;
  /** Resolved path with seeds substituted, e.g. "/issues/abc-123". */
  path: string;
  width: number;
  /** Unique per (route, width), e.g. "issues-home-1280px.png". */
  filename: string;
}

/**
 * Expand routes × widths into capture entries. Widths are validated here
 * (not in the loader) so a config carrying duplicate widths fails loudly
 * with the offending value named.
 */
export function buildScreenshotPlan(routes: VisualRoute[], widths: number[]): ScreenshotShot[] {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new VisualConfigError("screenshot plan needs at least one route");
  }
  if (!Array.isArray(widths) || widths.length === 0) {
    throw new VisualConfigError("screenshot plan needs at least one viewport width");
  }
  const seen = new Set<number>();
  for (const width of widths) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new VisualConfigError(
        `invalid viewport width ${JSON.stringify(width)}: must be a positive integer`
      );
    }
    if (seen.has(width)) {
      throw new VisualConfigError(`duplicate viewport width ${width}`);
    }
    seen.add(width);
  }
  return routes.flatMap((route) =>
    widths.map((width) => ({
      name: route.name,
      route: route.path,
      path: route.path,
      width,
      filename: `${route.name}-${width}px.png`,
    }))
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
