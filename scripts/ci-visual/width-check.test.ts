// scripts/ci-visual/width-check.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFitsViewport } from "./width-check.mjs";

test("equal width fits the viewport", () => {
  const verdict = checkFitsViewport({
    scrollWidth: 390,
    viewportWidth: 390,
    route: "/issues",
    viewport: "390x800",
  });
  assert.equal(verdict.ok, true);
  assert.match(verdict.message, /fits viewport/);
});

test("narrower content fits the viewport", () => {
  const verdict = checkFitsViewport({
    scrollWidth: 320,
    viewportWidth: 390,
    route: "/issues",
    viewport: "390x800",
  });
  assert.equal(verdict.ok, true);
});

test("wider content fails, naming the route and viewport", () => {
  const verdict = checkFitsViewport({
    scrollWidth: 406,
    viewportWidth: 390,
    route: "/issues/{{issueId}}",
    viewport: "390x800",
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /OVERFLOW/);
  assert.match(verdict.message, /\/issues\/\{\{issueId\}\}/);
  assert.match(verdict.message, /390x800/);
  assert.match(verdict.message, /406px/);
});
