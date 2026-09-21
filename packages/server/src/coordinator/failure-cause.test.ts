// packages/server/src/coordinator/failure-cause.test.ts
//
// NOT-171: table-driven classifier coverage. Every taxonomy code has a positive
// fixture and a near-miss fixture that must remain unknown, plus ordering,
// domain, recovery, and raw-evidence rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FailureCauseCode } from "@agent-dealer/shared";
import {
  classifyAttemptFailure,
  orderAttemptCauses,
  type AttemptFailureInput,
} from "./failure-cause.js";
import { PRESUMED_DEAD_REASON } from "./failure-reason.js";

function writeLog(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-failure-cause-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(logPath, body);
  return logPath;
}

const CURSOR_LOGGED_OUT_STDERR = `Authentication required. Set CURSOR_API_KEY environment variable or run \`cursor-agent login\`.`;

const primary = (causes: ReturnType<typeof classifyAttemptFailure>) =>
  causes.find((c) => c.primary)!;

test("taxonomy fixtures: each code classifies, each near-miss stays unknown", () => {
  const providerLog = () =>
    writeLog(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } })}\n` +
        `\n--- stderr ---\nError: 429 rate limit exceeded, try again later\n`
    );
  const authLog = () =>
    writeLog(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } })}\n` +
        `\n--- stderr ---\n${CURSOR_LOGGED_OUT_STDERR}\n`
    );

  const cases: Array<{
    code: FailureCauseCode;
    positive: AttemptFailureInput;
    nearMiss: AttemptFailureInput;
  }> = [
    {
      code: "authentication_configuration",
      positive: { outcomeKind: "session_failed", logPath: authLog(), runtime: "cursor_local" },
      // Transcript prose quoting auth output is not failure evidence (NOT-133).
      nearMiss: {
        outcomeKind: "session_failed",
        logPath: writeLog(
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: CURSOR_LOGGED_OUT_STDERR }] } })}\n` +
            `${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`
        ),
        runtime: "cursor_local",
      },
    },
    {
      code: "provider_capacity_rate_limit",
      positive: { outcomeKind: "session_failed", logPath: providerLog() },
      // A budget limit is not provider capacity.
      nearMiss: {
        outcomeKind: "session_failed",
        routeReason: "Developer session failed or crashed. (infra-attempt limit reached).",
      },
    },
    {
      code: "agent_cli_crash",
      positive: { outcomeKind: "session_failed", exitCode: 1 },
      nearMiss: { outcomeKind: "session_failed", exitCode: null },
    },
    {
      code: "tool_test_timeout",
      positive: { outcomeKind: "timed_out", toolInFlight: true },
      // Ambiguous timeout stays unknown — never promoted.
      nearMiss: { outcomeKind: "timed_out" },
    },
    {
      code: "coordinator_crash",
      positive: {
        outcomeKind: "session_failed",
        outcomeReason: PRESUMED_DEAD_REASON,
        recovery: "rerun",
      },
      // Looks like a recovery reason but is not the recorded marker.
      nearMiss: { outcomeKind: "session_failed", outcomeReason: "worker process presumed dead" },
    },
    {
      code: "validation_failure",
      positive: { outcomeKind: "checks_failed", outcomeReason: "Developer's PR checks failed." },
      // A checks-poll timeout is a timeout, not a validation verdict.
      nearMiss: { outcomeKind: "timed_out", outcomeReason: "waiting on checks timed out" },
    },
    {
      code: "publish_git_failure",
      positive: {
        outcomeKind: "adapter_failure",
        outcomeReason: "Git/GitHub verification failed: push rejected (non-fast-forward)",
      },
      // Mentioning a PR is not a publish failure.
      nearMiss: { outcomeKind: "no_pr", outcomeReason: "Developer session produced no PR." },
    },
    {
      code: "agent_deck_unavailable",
      positive: { outcomeKind: "deck_unavailable", outcomeReason: "Agent Deck is unreachable — fetch failed" },
      // A Deck mention inside transcript prose is not Deck evidence.
      nearMiss: {
        outcomeKind: "session_failed",
        logPath: writeLog(
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Agent Deck docs say to retry" }] } })}\n` +
            `${JSON.stringify({ type: "result", is_error: false, result: "done" })}\n`
        ),
      },
    },
    {
      code: "host_sleep_liveness",
      positive: {
        outcomeKind: "session_failed",
        outcomeReason: PRESUMED_DEAD_REASON,
        recovery: "rerun",
        hostSuspended: true,
      },
      // Sleep words without any failure linkage are not a liveness verdict.
      nearMiss: { outcomeKind: "session_failed", outcomeReason: "host clock jumped 300s during poll" },
    },
    {
      code: "unknown",
      positive: {},
      nearMiss: { outcomeKind: "timed_out", outcomeReason: "Developer session timed out." },
    },
  ];

  for (const { code, positive, nearMiss } of cases) {
    const got = primary(classifyAttemptFailure({ ...positive, sessionId: `s-${code}` }));
    assert.equal(got.code, code, `positive fixture for ${code}`);
    assert.equal(got.primary, true);
    const miss = classifyAttemptFailure({ ...nearMiss, sessionId: `n-${code}` });
    for (const c of miss) {
      assert.equal(c.code, "unknown", `near-miss for ${code} must remain unknown (got ${c.code})`);
    }
  }
});

test("worker-auth prose inside a transcript never becomes an auth failure", () => {
  const logPath = writeLog(
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `saw 401 Unauthorized from api.example.com, not logged in?` }] } })}\n` +
      `${JSON.stringify({ type: "result", is_error: true, result: "exit 1" })}\n`
  );
  const causes = classifyAttemptFailure({ outcomeKind: "session_failed", logPath });
  assert.ok(causes.every((c) => c.code !== "authentication_configuration"));
});

test("the same auth prose in a terminal error result IS an auth failure", () => {
  const logPath = writeLog(
    `${JSON.stringify({ type: "result", is_error: true, result: CURSOR_LOGGED_OUT_STDERR })}\n`
  );
  assert.equal(primary(classifyAttemptFailure({ outcomeKind: "session_failed", logPath })).code,
    "authentication_configuration");
});

test("provider error followed by validation/publish fallout keeps provider primary", () => {
  const providerLog = writeLog(`\n--- stderr ---\nError: 429 rate limit exceeded\n`);
  const earlier = classifyAttemptFailure({
    outcomeKind: "session_failed",
    logPath: providerLog,
    occurredAt: "2026-09-20T10:00:00.000Z",
    eventCursor: 5,
    sessionId: "s-1",
  });
  const later = classifyAttemptFailure({
    outcomeKind: "checks_failed",
    outcomeReason: "Developer's PR checks failed.",
    occurredAt: "2026-09-20T10:05:00.000Z",
    eventCursor: 9,
    sessionId: "s-1",
  });
  const ordered = orderAttemptCauses([...later, ...earlier]);
  assert.equal(ordered[0]!.code, "provider_capacity_rate_limit");
  assert.equal(ordered[0]!.primary, true);
  assert.equal(ordered[1]!.code, "validation_failure");
  assert.equal(ordered[1]!.primary, false);
});

test("one observation records both the crash and its validation consequence", () => {
  const authLog = writeLog(`\n--- stderr ---\n${CURSOR_LOGGED_OUT_STDERR}\n`);
  const causes = classifyAttemptFailure({
    outcomeKind: "checks_failed",
    outcomeReason: "Developer's PR checks failed.",
    logPath: authLog,
    runtime: "cursor_local",
    sessionId: "s-1",
  });
  assert.equal(causes[0]!.code, "authentication_configuration");
  assert.equal(causes[0]!.primary, true);
  assert.equal(causes[1]!.code, "validation_failure");
  assert.equal(causes[1]!.primary, false);
});

test("task and infrastructure failures are distinguishable", () => {
  const task = primary(classifyAttemptFailure({ outcomeKind: "checks_failed" }));
  assert.equal(task.code, "validation_failure");
  assert.equal(task.domain, "task");
  const infra = primary(
    classifyAttemptFailure({ outcomeKind: "session_failed", exitCode: 1 })
  );
  assert.equal(infra.code, "agent_cli_crash");
  assert.equal(infra.domain, "infrastructure");
  const ambiguous = classifyAttemptFailure({ outcomeKind: "timed_out" });
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0]!.code, "unknown");
  assert.equal(ambiguous[0]!.domain, "unknown");
});

test("ordering uses durable cursors, not insertion order", () => {
  const late = {
    code: "publish_git_failure" as const,
    domain: "infrastructure" as const,
    primary: false,
    confidence: "high" as const,
    evidenceSource: "outcome_kind" as const,
    occurredAt: "2026-09-20T10:05:00.000Z",
    eventCursor: 9,
    rawReason: "push failed",
    sessionId: "s-1",
    logPath: null,
    eventId: "e-9",
    eventType: "worker.failed",
    quality: "exact" as const,
  };
  const early = { ...late, code: "provider_capacity_rate_limit" as const, eventCursor: 5, eventId: "e-5" };
  const ordered = orderAttemptCauses([late, early]);
  assert.equal(ordered[0]!.code, "provider_capacity_rate_limit");
  assert.equal(ordered[0]!.primary, true);
  assert.equal(ordered[1]!.primary, false);
});

test("recovery, deck, unknown, and incomplete-metadata cases", () => {
  const reclaim = primary(
    classifyAttemptFailure({
      outcomeKind: "session_failed",
      outcomeReason: `${PRESUMED_DEAD_REASON} — nothing on the branch to publish, re-running the developer`,
      recovery: "rerun",
    })
  );
  assert.equal(reclaim.code, "coordinator_crash");
  assert.equal(reclaim.domain, "infrastructure");

  const sleep = primary(
    classifyAttemptFailure({
      outcomeKind: "session_failed",
      outcomeReason: PRESUMED_DEAD_REASON,
      recovery: "rerun",
      hostSuspended: true,
    })
  );
  assert.equal(sleep.code, "host_sleep_liveness");
  assert.equal(sleep.confidence, "high");

  const deck = primary(
    classifyAttemptFailure({ outcomeKind: "deck_failure", outcomeReason: "Agent Deck preflight failed: boom" })
  );
  assert.equal(deck.code, "agent_deck_unavailable");

  const empty = classifyAttemptFailure({});
  assert.equal(empty.length, 1);
  assert.equal(empty[0]!.code, "unknown");
  assert.equal(empty[0]!.domain, "unknown");
  assert.equal(empty[0]!.confidence, "low");
  assert.equal(empty[0]!.primary, true);
  assert.equal(empty[0]!.rawReason, "no failure evidence recorded");
});

test("usage-capped and tool-timeout evidence map to capacity/task", () => {
  const capped = primary(
    classifyAttemptFailure({ outcomeKind: "usage_capped", outcomeReason: "claude_code usage capped — plan limit rejected" })
  );
  assert.equal(capped.code, "provider_capacity_rate_limit");
  assert.equal(capped.domain, "infrastructure");

  const toolTimeout = primary(
    classifyAttemptFailure({
      outcomeKind: "timed_out",
      outcomeReason: "vitest run timed out after 30000ms",
    })
  );
  assert.equal(toolTimeout.code, "tool_test_timeout");
  assert.equal(toolTimeout.domain, "task");
});
