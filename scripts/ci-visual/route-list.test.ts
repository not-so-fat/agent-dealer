// scripts/ci-visual/route-list.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WIDTHS, loadRouteList, VisualConfigError } from "./route-list.js";

test("loads a valid config with widths passed through", () => {
  const list = loadRouteList({
    widths: [1280, 320],
    routes: [
      { name: "issues-home", path: "/issues" },
      { name: "issue-detail", path: "/issues/{{issueId}}", needsSeededIssue: true },
    ],
  });
  assert.deepEqual(list.widths, [1280, 320]);
  assert.deepEqual(list.routes, [
    { name: "issues-home", path: "/issues", needsSeededIssue: false },
    { name: "issue-detail", path: "/issues/{{issueId}}", needsSeededIssue: true },
  ]);
});

test("omitted widths fall back to the NOT-312 desktop + 320px defaults", () => {
  const list = loadRouteList({ routes: [{ name: "agents", path: "/agents" }] });
  assert.deepEqual(list.widths, DEFAULT_WIDTHS);
});

test("missing route path fails the load", () => {
  assert.throws(
    () => loadRouteList({ routes: [{ name: "issue-detail" }] }),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes('route "issue-detail" is missing a "path"')
  );
});

test("empty routes array fails the load", () => {
  assert.throws(() => loadRouteList({ routes: [] }), VisualConfigError);
});

test("non-object root fails the load", () => {
  assert.throws(() => loadRouteList([]), VisualConfigError);
  assert.throws(() => loadRouteList(null), VisualConfigError);
  assert.throws(() => loadRouteList("routes"), VisualConfigError);
});

test("duplicate route names fail the load", () => {
  assert.throws(
    () =>
      loadRouteList({
        routes: [
          { name: "agents", path: "/agents" },
          { name: "agents", path: "/agents" },
        ],
      }),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes('duplicate route name "agents"')
  );
});

test("relative path fails the load", () => {
  assert.throws(
    () => loadRouteList({ routes: [{ name: "agents", path: "agents" }] }),
    (err: unknown) => err instanceof VisualConfigError && err.message.includes('must start with "/"')
  );
});
