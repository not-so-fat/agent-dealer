import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueArgs, runIssueCommand } from "./issue.js";
import { stubFetch } from "./test-fetch-stub.js";

test("parseIssueArgs: create requires --title and --repo", () => {
  const parsed = parseIssueArgs(["create", "--title", "Fix bug", "--repo", "/repo", "--developer-agent", "a1", "--reviewer-agent", "a2"]);
  assert.equal(parsed.subcommand, "create");
  assert.equal((parsed as { title: string }).title, "Fix bug");
  // NOT-118: queue by default.
  assert.equal((parsed as { enqueue: boolean }).enqueue, true);
});

test("parseIssueArgs: create --no-enqueue asks for a draft outside the queue", () => {
  const parsed = parseIssueArgs(["create", "--title", "Draft", "--repo", "/repo", "--developer-agent", "a1", "--reviewer-agent", "a2", "--no-enqueue"]);
  assert.equal((parsed as { enqueue: boolean }).enqueue, false);
});

test("parseIssueArgs: show requires an id", () => {
  const parsed = parseIssueArgs(["show", "issue-123"]);
  assert.equal(parsed.subcommand, "show");
  assert.equal((parsed as { id: string }).id, "issue-123");
});

test("parseIssueArgs: unknown subcommand throws", () => {
  assert.throws(() => parseIssueArgs(["bogus"]));
});

test("parseIssueArgs: guide requires an id and --message", () => {
  const parsed = parseIssueArgs(["guide", "issue-123", "--message", "prioritize this"]);
  assert.equal(parsed.subcommand, "guide");
  assert.equal((parsed as { id: string; message: string }).message, "prioritize this");
});

test("parseIssueArgs: list accepts an optional --status", () => {
  assert.deepEqual(parseIssueArgs(["list"]), { subcommand: "list", status: undefined });
  assert.deepEqual(parseIssueArgs(["list", "--status", "ready,needs_human"]), {
    subcommand: "list",
    status: "ready,needs_human",
  });
});

test("parseIssueArgs: start requires an id", () => {
  const parsed = parseIssueArgs(["start", "issue-123"]);
  assert.equal(parsed.subcommand, "start");
  assert.equal((parsed as { id: string }).id, "issue-123");
  assert.throws(() => parseIssueArgs(["start"]));
});

test("issue list calls GET /api/issues and exits 0", async () => {
  const stub = stubFetch("/api/issues", "GET", [{ id: "i1", status: "ready" }]);
  try {
    const code = await runIssueCommand(["list"]);
    assert.equal(code, 0);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("issue list forwards --status as a query param", async () => {
  const stub = stubFetch(/\/api\/issues\?status=ready%2Cneeds_human$/, "GET", []);
  try {
    await runIssueCommand(["list", "--status", "ready,needs_human"]);
    stub.assertCalled();
  } finally {
    stub.restore();
  }
});

test("issue create sends enqueue:true by default and enqueue:false with --no-enqueue", async () => {
  const enqueued = stubFetch("/api/issues", "POST", { id: "i1", status: "ready" });
  try {
    assert.equal(
      await runIssueCommand(["create", "--title", "T", "--repo", "/r", "--developer-agent", "a1", "--reviewer-agent", "a2"]),
      0,
    );
    assert.equal((enqueued.assertCalled() as { enqueue: boolean }).enqueue, true);
  } finally {
    enqueued.restore();
  }

  const draft = stubFetch("/api/issues", "POST", { id: "i2", status: "ready" });
  try {
    await runIssueCommand(["create", "--title", "T", "--repo", "/r", "--developer-agent", "a1", "--reviewer-agent", "a2", "--no-enqueue"]);
    assert.equal((draft.assertCalled() as { enqueue: boolean }).enqueue, false);
  } finally {
    draft.restore();
  }
});

/** Runs the command with stderr captured — the hints go to stderr, stdout stays JSON. */
async function captureStderr(args: string[]): Promise<{ code: number; err: string; out: string }> {
  const errs: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (message?: unknown) => errs.push(String(message));
  console.log = (message?: unknown) => logs.push(String(message));
  try {
    const code = await runIssueCommand(args);
    return { code, err: errs.join("\n"), out: logs.join("\n") };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

const createArgs = ["--title", "T", "--repo", "/r", "--developer-agent", "a1", "--reviewer-agent", "a2"];

test("NOT-141: the create hint reports what the server did, not what was requested", async () => {
  const matched = stubFetch("/api/issues", "POST", { id: "i1", status: "developing", created: false, queue: "not_queued" });
  try {
    const { code, err } = await captureStderr(["create", ...createArgs]);
    assert.equal(code, 0);
    assert.doesNotMatch(err, /Queued for admission/);
    assert.match(err, /Matched existing issue i1 \(developing\)/);
    assert.match(err, /nothing was queued/);
  } finally {
    matched.restore();
  }

  // The issue was already waiting: enqueue changed nothing, so the hint must not report a
  // queue action of any kind — the bug this ticket is about, one step down the line.
  const alreadyQueued = stubFetch("/api/issues", "POST", { id: "i2", status: "ready", created: false, queue: "already_queued" });
  try {
    const { err } = await captureStderr(["create", ...createArgs]);
    assert.doesNotMatch(err, /Queued for admission/);
    assert.doesNotMatch(err, /re-queued|was put back/);
    assert.match(err, /already in the admission queue — nothing was queued/);
  } finally {
    alreadyQueued.restore();
  }

  const requeued = stubFetch("/api/issues", "POST", { id: "i6", status: "ready", created: false, queue: "enqueued" });
  try {
    const { err } = await captureStderr(["create", ...createArgs]);
    assert.doesNotMatch(err, /Queued for admission/);
    assert.match(err, /it was put back in the admission queue/);
  } finally {
    requeued.restore();
  }

  const fresh = stubFetch("/api/issues", "POST", { id: "i3", status: "ready", created: true, queue: "enqueued", priorPasses: 0 });
  try {
    const { err } = await captureStderr(["create", ...createArgs]);
    assert.match(err, /Queued for admission/);
    assert.doesNotMatch(err, /pass/);
  } finally {
    fresh.restore();
  }
});

test("NOT-141: a second pass on a ticket is named as such, not printed like a first import", async () => {
  const secondPass = stubFetch("/api/issues", "POST", {
    id: "i5",
    status: "ready",
    created: true,
    queue: "enqueued",
    priorPasses: 1,
    externalId: "lin-uuid",
    externalLabel: "NOT-128",
  });
  try {
    const { err } = await captureStderr(["import", "--external-id", "lin-uuid", ...createArgs]);
    assert.match(err, /Queued for admission/);
    assert.match(err, /This is pass 2 on NOT-128 — 1 earlier pass\(es\) already finished\./);
  } finally {
    secondPass.restore();
  }
});

test("NOT-141: import reports a fresh row, and surfaces the 409 conflict instead of exiting 0", async () => {
  const created = stubFetch("/api/issues", "POST", { id: "i4", status: "ready", created: true, queue: "enqueued" });
  try {
    const { code, err } = await captureStderr(["import", "--external-id", "NOT-1", ...createArgs]);
    assert.equal(code, 0);
    assert.match(err, /Queued for admission/);
  } finally {
    created.restore();
  }

  const conflict = stubFetch(
    "/api/issues",
    "POST",
    { error: "Issue i4 is already tracking linear NOT-1 (developing)", existingIssueId: "i4", existingIssueStatus: "developing" },
    409
  );
  try {
    const { code, err } = await captureStderr(["import", "--external-id", "NOT-1", ...createArgs]);
    assert.equal(code, 1);
    assert.match(err, /already tracking linear NOT-1/);
    assert.doesNotMatch(err, /Queued for admission/);
  } finally {
    conflict.restore();
  }
});

test("issue start prints the admitted response shape and exits 0", async () => {
  const stub = stubFetch("/api/issues/issue-123/start", "POST", {
    state: "admitted",
    instance: { id: "wf-1" },
    workItem: { id: "work-1", kind: "developer" },
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => logs.push(String(message));
  try {
    const code = await runIssueCommand(["start", "issue-123"]);
    assert.equal(code, 0);
    stub.assertCalled();
    const printed = JSON.parse(logs.join("\n")) as { state: string; instance: { id: string } };
    assert.equal(printed.state, "admitted");
    assert.equal(printed.instance.id, "wf-1");
  } finally {
    console.log = originalLog;
    stub.restore();
  }
});

test("issue start prints the queued response shape (position + wait reason) and still exits 0", async () => {
  const stub = stubFetch("/api/issues/issue-123/start", "POST", {
    state: "queued",
    position: 1,
    waitReason: "waiting for slot — running: Other issue",
  });
  const logs: string[] = [];
  const errs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message));
  console.error = (message?: unknown) => errs.push(String(message));
  try {
    const code = await runIssueCommand(["start", "issue-123"]);
    assert.equal(code, 0);
    const printed = JSON.parse(logs.join("\n")) as { state: string; position: number; waitReason: string };
    assert.equal(printed.state, "queued");
    assert.equal(printed.position, 1);
    assert.match(printed.waitReason, /waiting for slot/);
    assert.match(errs.join("\n"), /Queued at position 1 — waiting for slot/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    stub.restore();
  }
});

test("issue start returns nonzero on API failure", async () => {
  const stub = stubFetch("/api/issues/issue-123/start", "POST", { error: "not ready" }, 400);
  try {
    const code = await runIssueCommand(["start", "issue-123"]);
    assert.equal(code, 1);
  } finally {
    stub.restore();
  }
});
