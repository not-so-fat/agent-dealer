// scripts/ci-visual/route-list.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEWPORTS, loadRouteList, VisualConfigError } from "./route-list.js";

test("loads a valid config with viewports and steps passed through", () => {
  const list = loadRouteList({
    viewports: [
      { width: 1440, height: 900 },
      { width: 390, height: 800 },
    ],
    routes: [
      { name: "issues-home", path: "/issues" },
      {
        name: "issue-detail",
        path: "/issues/{{issueId}}",
        needsSeededIssue: true,
        steps: [
          { action: "click", by: "testid", value: "more-actions-toggle" },
          { action: "waitFor", by: "role", value: "button", name: "Close issue" },
        ],
      },
    ],
  });
  assert.deepEqual(list.viewports, [
    { width: 1440, height: 900 },
    { width: 390, height: 800 },
  ]);
  assert.deepEqual(list.routes, [
    { name: "issues-home", path: "/issues", needsSeededIssue: false, steps: [] },
    {
      name: "issue-detail",
      path: "/issues/{{issueId}}",
      needsSeededIssue: true,
      steps: [
        { action: "click", by: "testid", value: "more-actions-toggle" },
        { action: "waitFor", by: "role", value: "button", name: "Close issue" },
      ],
    },
  ]);
});

test("omitted viewports fall back to the NOT-383 required viewports", () => {
  const list = loadRouteList({ routes: [{ name: "agents", path: "/agents" }] });
  assert.deepEqual(list.viewports, DEFAULT_VIEWPORTS);
  assert.deepEqual(DEFAULT_VIEWPORTS, [
    { width: 1440, height: 900 },
    { width: 390, height: 800 },
  ]);
});

test("legacy widths key fails with a migration hint", () => {
  assert.throws(
    () => loadRouteList({ widths: [1280, 320], routes: [{ name: "agents", path: "/agents" }] }),
    (err: unknown) =>
      err instanceof VisualConfigError &&
      err.message.includes('removed "widths"') &&
      err.message.includes('"viewports"')
  );
});

test("malformed viewports fail the load", () => {
  const routes = [{ name: "agents", path: "/agents" }];
  assert.throws(() => loadRouteList({ viewports: [], routes }), VisualConfigError);
  assert.throws(() => loadRouteList({ viewports: "1440x900", routes }), VisualConfigError);
  assert.throws(
    () => loadRouteList({ viewports: [{ width: 1440 }], routes }),
    (err: unknown) => err instanceof VisualConfigError && err.message.includes('"viewports[0]"')
  );
  assert.throws(() => loadRouteList({ viewports: [{ height: 900 }], routes }), VisualConfigError);
  assert.throws(() => loadRouteList({ viewports: [{ width: 0, height: 900 }], routes }), VisualConfigError);
  assert.throws(() => loadRouteList({ viewports: [{ width: 1440, height: -1 }], routes }), VisualConfigError);
  assert.throws(
    () => loadRouteList({ viewports: [{ width: 1439.5, height: 900 }], routes }),
    VisualConfigError
  );
  assert.throws(() => loadRouteList({ viewports: [null], routes }), VisualConfigError);
  assert.throws(() => loadRouteList({ viewports: ["1440x900"], routes }), VisualConfigError);
});

test("unknown step actions fail the load", () => {
  assert.throws(
    () =>
      loadRouteList({
        routes: [{ name: "agents", path: "/agents", steps: [{ action: "hover", by: "role", value: "button" }] }],
      }),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes('unknown action "hover"')
  );
});

test("unknown step selector engines fail the load", () => {
  assert.throws(
    () =>
      loadRouteList({
        routes: [{ name: "agents", path: "/agents", steps: [{ action: "click", by: "css", value: ".btn" }] }],
      }),
    (err: unknown) =>
      err instanceof VisualConfigError && err.message.includes('unknown selector "css"')
  );
});

test("empty step selectors fail the load", () => {
  assert.throws(
    () =>
      loadRouteList({
        routes: [{ name: "agents", path: "/agents", steps: [{ action: "click", by: "testid", value: "  " }] }],
      }),
    (err: unknown) => err instanceof VisualConfigError && err.message.includes('empty selector "value"')
  );
  assert.throws(
    () => loadRouteList({ routes: [{ name: "agents", path: "/agents", steps: [{ action: "click" }] }] }),
    VisualConfigError
  );
});

test("non-array steps fail the load", () => {
  assert.throws(
    () => loadRouteList({ routes: [{ name: "agents", path: "/agents", steps: "click" }] }),
    VisualConfigError
  );
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
