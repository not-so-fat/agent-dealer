// scripts/ci-visual/width-check.mjs
//
// Pure viewport-width verdict for the CI `visual` job (NOT-383). Plain ESM with
// no dependencies so both the unit tests (via tsx) and visual.spec.mjs (copied
// into the scratch Playwright install, where repo TS sources are unavailable)
// import this exact file — the assertion CI enforces is the assertion tested.

/**
 * @param {object} args
 * @param {number} args.scrollWidth `document.documentElement.scrollWidth` after steps run
 * @param {number} args.viewportWidth viewport width in CSS pixels
 * @param {string} args.route configured route template, e.g. "/issues/{{issueId}}"
 * @param {string} args.viewport viewport label, e.g. "390x800"
 * @returns {{ ok: boolean, scrollWidth: number, viewportWidth: number, route: string, viewport: string, message: string }}
 */
export function checkFitsViewport({ scrollWidth, viewportWidth, route, viewport }) {
  const ok = scrollWidth <= viewportWidth;
  return {
    ok,
    scrollWidth,
    viewportWidth,
    route,
    viewport,
    message: ok
      ? `[width] ${route} at ${viewport}: scrollWidth ${scrollWidth}px fits viewport ${viewportWidth}px`
      : `[width] OVERFLOW on route ${route} at ${viewport}: scrollWidth ${scrollWidth}px exceeds viewport width ${viewportWidth}px`,
  };
}
