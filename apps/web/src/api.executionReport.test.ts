// NOT-175: API-client tests for fetchExecutionAnalysis — filter serialization
// into the request URL, server error status, and zod rejection of unexpected
// shapes. fetch is stubbed; no network, no DOM.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchExecutionAnalysis } from "./api.js";
import { fixtureReport } from "./lib/executionReport.fixture.js";

let lastUrl: string | null = null;

function seen(): string {
  assert.ok(lastUrl !== null, "fetch was called");
  return lastUrl;
}

type StubMode =
  | { kind: "ok"; body: unknown }
  | { kind: "error"; status: number; body: unknown };

let mode: StubMode = { kind: "ok", body: fixtureReport() };

function stubFetch() {
  (globalThis as { fetch?: unknown }).fetch = async (url: unknown) => {
    lastUrl = String(url);
    if (mode.kind === "error") {
      return {
        ok: false,
        status: mode.status,
        text: async () => JSON.stringify(mode.kind === "error" ? mode.body : {}),
        json: async () => (mode.kind === "error" ? mode.body : {}),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mode.kind === "ok" ? mode.body : {}),
      json: async () => (mode.kind === "ok" ? mode.body : {}),
    };
  };
}

beforeEach(() => {
  lastUrl = null;
  mode = { kind: "ok", body: fixtureReport() };
  stubFetch();
});

test("filters serialize into the report URL; defaults stay out", async () => {
  await fetchExecutionAnalysis({ runtime: "cursor_local", role: "reviewer", page: 1 });
  assert.ok(seen().startsWith("/api/execution-report"), seen());
  assert.ok(seen().includes("runtime=cursor_local"), seen());
  assert.ok(seen().includes("role=reviewer"), seen());
  assert.ok(!seen().includes("page="), seen());
});

test("empty filters request the bare report path (API default window)", async () => {
  await fetchExecutionAnalysis({});
  assert.equal(seen(), "/api/execution-report");
});

test("explicit dates and pagination survive into the query string", async () => {
  await fetchExecutionAnalysis({ from: "2026-09-01T00:00:00.000Z", repo: "github.com/acme/app", page: 3 });
  assert.ok(seen().includes("from=2026-09-01T00%3A00%3A00.000Z"), seen());
  assert.ok(seen().includes("repo=github.com%2Facme%2Fapp"), seen());
  assert.ok(seen().includes("page=3"), seen());
});

test("server error status throws the server message", async () => {
  mode = { kind: "error", status: 400, body: { error: "Invalid `from` date" } };
  await assert.rejects(fetchExecutionAnalysis({}), /Invalid `from` date/);
});

test("unexpected shapes throw instead of rendering garbage", async () => {
  mode = { kind: "ok", body: { window: {}, nope: true } };
  await assert.rejects(fetchExecutionAnalysis({}), /Unexpected report shape/);
});

test("valid payloads pass through with values intact", async () => {
  const report = await fetchExecutionAnalysis({ model: "opus" });
  assert.ok(seen().includes("model=opus"), seen());
  assert.equal(report.summary.issues, 2);
  assert.equal(report.byRuntime[0]!.failedCostUsd.sum, 1.5);
});
