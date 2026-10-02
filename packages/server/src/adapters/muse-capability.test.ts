// packages/server/src/adapters/muse-capability.test.ts
//
// NOT-277: Muse Code developer shell/write capability is re-validated once per newly reported
// version — cached per version, auto-confirmed on success, blocked by name on loss, fail-closed
// when the check cannot complete. The real probe runs against fixtures/fake-muse.mjs (never Meta).
import { describe, test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// NOT-278: the worker MCP config root (the per-attempt base dir) refuses temp dirs, so the
// dealer home for this file is a home scratch root, never OS temp. Removed in `after`
// below so local runs do not clutter $HOME.
process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-capability-"));
after(() => {
  try {
    fs.rmSync(process.env.AGENT_DEALER_HOME!, { recursive: true, force: true });
  } catch {
    // best-effort — a failed rm must not fail the suite
  }
});

const {
  museCapabilityIssues,
  museCapabilityCheckInFlight,
  parseMuseVersion,
  settleMuseCapabilityCheckForTests,
  setMuseCapabilityProbeForTests,
  resetMuseCapabilityStateForTests,
  ageMuseCapabilityCheckForTests,
  ensureMuseCapabilityEscalation,
  recordMuseCapabilityOverride,
  museCapabilitySafetyNetAfterSession,
  countMuseShellToolCalls,
  museCapabilityRequestId,
  defaultMuseCapabilityProbe,
} = await import("./muse-capability.js");
const { migrate, getDb } = await import("../db/index.js");
const { listHumanActionsByRequestId } = await import("../repository/human-actions.js");
migrate();
type ProbeResult = Awaited<ReturnType<typeof defaultMuseCapabilityProbe>>;

const OLD = "1.3.0-R3401.1";
const NEW = "1.4.0-R4161.1";
const STATE = path.join(process.env.AGENT_DEALER_HOME, "muse-capability.json");

/** Probe stub answering from `results` per version and counting calls per version. */
function stubProbe(results: Record<string, ProbeResult | Error>): Map<string, number> {
  const calls = new Map<string, number>();
  setMuseCapabilityProbeForTests(async (version) => {
    calls.set(version, (calls.get(version) ?? 0) + 1);
    const r = results[version];
    if (!r) throw new Error(`no stub result for ${version}`);
    if (r instanceof Error) throw r;
    return r;
  });
  return calls;
}

/** One health read for `version`, letting any check it starts settle. */
async function check(version: string) {
  const first = museCapabilityIssues(version);
  await settleMuseCapabilityCheckForTests();
  return { first, settled: museCapabilityIssues(version) };
}

/** Drive `version` to three consecutive errors (attempts=3, exhausted). */
async function exhaust(version: string) {
  museCapabilityIssues(version);
  await settleMuseCapabilityCheckForTests();
  ageMuseCapabilityCheckForTests(61_000);
  museCapabilityIssues(version);
  await settleMuseCapabilityCheckForTests();
  ageMuseCapabilityCheckForTests(122_000);
  museCapabilityIssues(version);
  await settleMuseCapabilityCheckForTests();
}

/** A `muse --version` stub reporting `version`; returns a restore function. */
function stubMuseVersion(version: string): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-verstub-"));
  const versionFile = path.join(dir, "version");
  fs.writeFileSync(versionFile, `Muse Code ${version.split("-")[0]} (${version})\n`);
  const bin = path.join(dir, "muse");
  fs.writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(versionFile)}\n`);
  fs.chmodSync(bin, 0o755);
  const prev = process.env.MUSE_CLI;
  process.env.MUSE_CLI = bin;
  return () => {
    if (prev === undefined) delete process.env.MUSE_CLI;
    else process.env.MUSE_CLI = prev;
  };
}

/** A real issue row — `muse_capability` escalations are FK-bound to issues. */
function makeIssue(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO issues (id, source, title, repo, base_branch, status, current_owner, created_at, updated_at)
       VALUES (?, 'manual', 'muse capability check', 'dealer-test', 'main', 'ready', 'dealer', ?, ?)`
    )
    .run(id, now, now);
  return id;
}

/** A session-log file from JSON lines (plain strings pass through verbatim). */
function writeLog(lines: unknown[]): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-log-")), "session.ndjson");
  fs.writeFileSync(p, `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
  return p;
}

describe("muse-capability", { concurrency: false }, () => {
  beforeEach(() => {
    resetMuseCapabilityStateForTests();
    setMuseCapabilityProbeForTests(null);
    getDb().exec("DELETE FROM human_actions");
  });

  test("parseMuseVersion reads the build id from `muse --version`", () => {
    assert.equal(parseMuseVersion("Muse Code 1.3.0 (1.3.0-R3401.1)\n"), OLD);
    assert.equal(parseMuseVersion("1.4.0-R4161.1\n"), NEW);
    assert.equal(parseMuseVersion("  \n"), null);
  });

  // NOT-308: with no confirmed baseline at all (fresh install) the unknown still
  // blocks — fail closed until the first version is confirmed.
  test("a version not yet checked blocks while its one-time check runs (never assumed capable)", async () => {
    let release!: () => void;
    setMuseCapabilityProbeForTests(
      () => new Promise((resolve) => (release = () => resolve({ status: "capable" })))
    );
    const issues = museCapabilityIssues(NEW);
    assert.deepEqual(issues.map((i) => i.code), ["runtime_capability"]);
    assert.match(issues[0]!.message, /verifying developer shell\/write access/);
    assert.equal(museCapabilityCheckInFlight(), true);
    // A second read while in flight does not start a second probe.
    museCapabilityIssues(NEW);
    release();
    await settleMuseCapabilityCheckForTests();
    assert.equal(museCapabilityCheckInFlight(), false);
    assert.deepEqual(museCapabilityIssues(NEW), []);
  });

  // NOT-308: with a confirmed baseline, an unchecked version never blocks — the
  // one-time check runs in the background while admission proceeds on the baseline.
  test("a version not yet checked does NOT block while a confirmed baseline exists", async () => {
    stubProbe({ [OLD]: { status: "capable" } });
    await check(OLD);
    let release!: () => void;
    setMuseCapabilityProbeForTests(
      () => new Promise((resolve) => (release = () => resolve({ status: "capable" })))
    );
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(museCapabilityCheckInFlight(), true);
    // Repeated polls while in flight stay unblocked and start no second probe.
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(museCapabilityCheckInFlight(), true);
    release();
    await settleMuseCapabilityCheckForTests();
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, NEW);
  });

  // (a) same version as last check → no re-probe, cached result reused.
  test("the same version is checked once; later reads reuse the cached result", async () => {
    const calls = stubProbe({ [OLD]: { status: "capable" } });
    assert.deepEqual((await check(OLD)).settled, []);
    for (let i = 0; i < 5; i++) assert.deepEqual(museCapabilityIssues(OLD), []);
    assert.equal(museCapabilityCheckInFlight(), false);
    assert.equal(calls.get(OLD), 1);
  });

  test("the cached result survives a restart (persisted), so a restart does not re-probe", async () => {
    const calls = stubProbe({ [OLD]: { status: "capable" } });
    await check(OLD);
    // Drop in-memory state only, as a fresh process would start.
    const persisted = fs.readFileSync(STATE, "utf8");
    resetMuseCapabilityStateForTests();
    fs.writeFileSync(STATE, persisted);
    assert.deepEqual(museCapabilityIssues(OLD), []);
    assert.equal(museCapabilityCheckInFlight(), false);
    assert.equal(calls.get(OLD), 1);
  });

  // (b) new version, capability confirmed → recorded capable, admission proceeds, no manual step.
  test("a new version that passes the check is recorded as the confirmed baseline automatically", async () => {
    const calls = stubProbe({ [OLD]: { status: "capable" }, [NEW]: { status: "capable" } });
    await check(OLD);
    const { first, settled } = await check(NEW);
    assert.deepEqual(first, [], "the in-flight check does not block on a baseline");
    assert.deepEqual(settled, []);
    assert.equal(calls.get(NEW), 1);
    const saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
    assert.equal(saved.confirmedVersion, NEW);
    assert.equal(saved.lastChecked.version, NEW);
    assert.equal(saved.lastChecked.status, "capable");
  });

  // (c) new version, capability missing → blocked with the named versions + capability.
  test("a new version that lost shell/write is blocked with both versions and the capability named", async () => {
    const calls = stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "missing", detail: "probe session completed without running its shell command" },
    });
    await check(OLD);
    const { settled } = await check(NEW);
    assert.deepEqual(settled.map((i) => i.code), ["runtime_capability"]);
    assert.match(
      settled[0]!.message,
      new RegExp(`^Muse Code updated ${OLD} → ${NEW}: developer sessions no longer get shell/write access`)
    );
    assert.match(settled[0]!.message, /developer admission blocked/);
    // Stays blocked on this version without re-probing; the baseline is still the old version.
    assert.deepEqual(museCapabilityIssues(NEW), settled);
    assert.equal(calls.get(NEW), 1);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, OLD);
  });

  test("a later update that restores the capability unblocks by itself", async () => {
    const FIXED = "1.4.0-R4302.1";
    stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "missing", detail: "no shell" },
      [FIXED]: { status: "capable" },
    });
    await check(OLD);
    await check(NEW);
    assert.deepEqual((await check(FIXED)).settled, []);
  });

  // NOT-308 (d): an inconclusive check (throws / times out) with a confirmed baseline
  // never blocks — admission proceeds on the baseline while the retry runs out.
  for (const [label, result] of [
    ["throws", new Error("spawn EACCES")],
    ["times out", { status: "error", detail: `probe session on ${NEW} timed out` }],
  ] as const) {
    test(`a check that ${label} does NOT block while a confirmed baseline exists`, async () => {
      const calls = stubProbe({ [OLD]: { status: "capable" }, [NEW]: result });
      await check(OLD);
      const { first, settled } = await check(NEW);
      assert.deepEqual(first, [], "the in-flight check does not block on a baseline");
      assert.deepEqual(settled, [], "an inconclusive result does not block on a baseline");
      // Not re-probed before the retry backoff.
      assert.deepEqual(museCapabilityIssues(NEW), []);
      assert.equal(calls.get(NEW), 1);
      assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, OLD);
    });
  }

  // NOT-308: inconclusive results retry at 1 min, then 2 min — then the version is
  // exhausted (3 attempts), escalates, and is never re-probed (not even past 4 min,
  // and never on the old 10-minute flat timer). Admission stays unblocked throughout.
  test("inconclusive results back off 1 min, then 2 min, then stop after 3 attempts", async () => {
    const calls = stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "error", detail: "timed out" },
    });
    await check(OLD);
    assert.equal(calls.get(OLD), 1);

    // Attempt 1 settles inconclusive; admission stays open.
    museCapabilityIssues(NEW);
    await settleMuseCapabilityCheckForTests();
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(calls.get(NEW), 1);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).lastChecked.attempts, 1);

    // No retry before 1 min, retry once it elapses (never the old 10 min flat wait —
    // 61s must already re-probe).
    ageMuseCapabilityCheckForTests(59_000);
    museCapabilityIssues(NEW);
    assert.equal(calls.get(NEW), 1);
    ageMuseCapabilityCheckForTests(2_000);
    museCapabilityIssues(NEW);
    await settleMuseCapabilityCheckForTests();
    assert.equal(calls.get(NEW), 2);
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).lastChecked.attempts, 2);

    // Attempt 2 backs off 2 min: 1 more minute is not enough, 2 are.
    ageMuseCapabilityCheckForTests(61_000);
    museCapabilityIssues(NEW);
    assert.equal(calls.get(NEW), 2);
    ageMuseCapabilityCheckForTests(61_000);
    museCapabilityIssues(NEW);
    await settleMuseCapabilityCheckForTests();
    assert.equal(calls.get(NEW), 3);
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).lastChecked.attempts, 3);

    // Exhausted: no fourth probe ever — not after 4 min, not after 10.
    ageMuseCapabilityCheckForTests(10 * 60_000);
    assert.deepEqual(museCapabilityIssues(NEW), []);
    assert.equal(calls.get(NEW), 3, "no further automatic probes after exhaustion");
  });

  test("consecutive updates name the exact previous version, not the last confirmed baseline", async () => {
    const LATER = "1.4.0-R4302.1";
    stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "missing", detail: "no shell" },
      [LATER]: { status: "missing", detail: "no shell" },
    });
    await check(OLD);
    await check(NEW);
    const { first, settled } = await check(LATER);
    assert.deepEqual(first, [], "the in-flight check does not block on a baseline");
    assert.match(settled[0]!.message, new RegExp(`^Muse Code updated ${NEW} → ${LATER}: developer sessions no longer get`));
    assert.doesNotMatch(settled[0]!.message, new RegExp(OLD.replace(/\./g, "\\.")));
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, OLD);
  });

  // NOT-308: without a baseline the inconclusive block still names the exact previous
  // version (with one it never blocks, so there is no message to name it).
  test("consecutive could-not-verify updates also name the exact previous version", async () => {
    const LATER = "1.4.0-R4302.1";
    stubProbe({
      [NEW]: { status: "error", detail: "timed out" },
      [LATER]: { status: "error", detail: "timed out" },
    });
    await check(NEW);
    const { settled } = await check(LATER);
    assert.deepEqual(settled.map((i) => i.code), ["runtime_capability"]);
    assert.match(settled[0]!.message, new RegExp(`after version change \\(${NEW} → ${LATER}\\)`));
  });

  // NOT-308: fresh-install inconclusive results fail closed until the first version is
  // confirmed — and an exhausted one says it will not retry, since nothing will.
  test("with no confirmed baseline, in-flight and errored checks keep admission blocked", async () => {
    let release!: () => void;
    setMuseCapabilityProbeForTests(
      () => new Promise((resolve) => (release = () => resolve({ status: "capable" })))
    );
    assert.deepEqual(museCapabilityIssues(NEW).map((i) => i.code), ["runtime_capability"]);
    release();
    await settleMuseCapabilityCheckForTests();
    assert.deepEqual(museCapabilityIssues(NEW), []);

    resetMuseCapabilityStateForTests();
    stubProbe({ [NEW]: { status: "error", detail: "timed out" } });
    const { settled } = await check(NEW);
    assert.deepEqual(settled.map((i) => i.code), ["runtime_capability"]);
    assert.match(settled[0]!.message, /Could not verify Muse Code developer shell\/write access/);
    assert.match(settled[0]!.message, /the check retries automatically/);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, null);
  });

  // NOT-308: three consecutive errors escalate exactly one "could not verify" action
  // (dedupe asserted by polling twice, from two issues); admission stays unblocked.
  test("an exhausted version escalates exactly one 'could not verify' action", async () => {
    stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "error", detail: "timed out" },
    });
    await check(OLD);
    await exhaust(NEW);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).lastChecked.attempts, 3);

    const issueId = makeIssue();
    const first = ensureMuseCapabilityEscalation(issueId);
    assert.ok(first, "exhaustion raises an action");
    assert.equal(first.actionType, "muse_capability");
    assert.equal(first.issueId, issueId);
    assert.equal(first.requestId, museCapabilityRequestId(NEW, "unverified"));
    assert.match(
      first.reason,
      new RegExp(`^Could not verify Muse Code developer shell/write access for ${NEW} after 3 inconclusive checks`)
    );
    assert.match(first.reason, /last probe ran \d+s/);
    assert.match(first.reason, new RegExp(`continues on the last confirmed baseline ${OLD}`));
    assert.match(first.reason, /no further automatic checks/);
    assert.deepEqual(JSON.parse(first.responseOptionsJson!), [
      { choice: "acknowledge", label: "Acknowledge — keep working on baseline" },
    ]);
    // A second poll — even from another issue — finds the open action, never a copy.
    assert.equal(ensureMuseCapabilityEscalation(issueId)?.id, first.id);
    assert.equal(ensureMuseCapabilityEscalation(randomUUID())?.id, first.id);
    assert.equal(
      listHumanActionsByRequestId("muse_capability", museCapabilityRequestId(NEW, "unverified")).filter(
        (a) => a.status === "open"
      ).length,
      1
    );
    assert.deepEqual(museCapabilityIssues(NEW), [], "admission stays on the baseline");
  });

  // NOT-308: a confirmed loss escalates exactly one action naming from → to plus the
  // capability; the block lifts once the operator acknowledges that version.
  test("a missing version escalates once with both versions named; acknowledge lifts the block", async () => {
    const calls = stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "missing", detail: "probe session completed without running its shell command" },
    });
    await check(OLD);
    const { settled } = await check(NEW);
    assert.deepEqual(settled.map((i) => i.code), ["runtime_capability"]);

    const issueId = makeIssue();
    const action = ensureMuseCapabilityEscalation(issueId);
    assert.ok(action, "a missing verdict raises an action");
    assert.equal(action.actionType, "muse_capability");
    assert.match(
      action.reason,
      new RegExp(`^Muse Code updated ${OLD} → ${NEW}: developer sessions no longer get shell/write access`)
    );
    assert.match(action.reason, /Last probe ran \d+s/);
    assert.match(action.reason, new RegExp(`admission is blocked for ${NEW}`));
    assert.match(action.question, new RegExp(`Acknowledge to admit developers on ${NEW} anyway`));
    assert.match(action.question, new RegExp(`pin/roll back Muse to ${OLD}`));
    assert.deepEqual(JSON.parse(action.responseOptionsJson!), [
      { choice: "acknowledge", label: `Acknowledge — admit on ${NEW}` },
    ]);
    const evidence = JSON.parse(action.evidenceJson!);
    assert.equal(evidence.kind, "missing");
    assert.equal(evidence.version, NEW);
    // Deduped per version, not per poll.
    assert.equal(ensureMuseCapabilityEscalation(issueId)?.id, action.id);
    assert.equal(ensureMuseCapabilityEscalation(randomUUID())?.id, action.id);
    assert.equal(calls.get(NEW), 1, "a missing verdict is conclusive: never re-probed");

    // The block stands until the operator acknowledges this version.
    assert.deepEqual(museCapabilityIssues(NEW).map((i) => i.code), ["runtime_capability"]);
    recordMuseCapabilityOverride(NEW);
    assert.deepEqual(museCapabilityIssues(NEW), [], "acknowledge lifts the block");
    assert.equal(ensureMuseCapabilityEscalation(issueId), null, "no re-raise after acknowledge");
  });

  // NOT-308 repair round 2: one version can produce both verdicts — an exhausted error
  // escalates "unverified", then a safety-net probe past exhaustion returns `missing`.
  // The missing verdict must raise its own action naming from → to and the lost
  // capability; dismissing the unverified action must never override the missing block.
  test("a missing verdict after an unverified one raises its own action; dismissing unverified never lifts missing", async () => {
    let verdict: ProbeResult = { status: "error", detail: "timed out" };
    const calls = new Map<string, number>();
    setMuseCapabilityProbeForTests(async (version) => {
      calls.set(version, (calls.get(version) ?? 0) + 1);
      if (version === OLD) return { status: "capable" };
      return verdict;
    });
    await check(OLD);
    await exhaust(NEW);
    assert.equal(calls.get(NEW), 3);
    const issueId = makeIssue();
    const unverified = ensureMuseCapabilityEscalation(issueId);
    assert.ok(unverified, "exhaustion raises the unverified action");
    assert.equal(unverified.requestId, museCapabilityRequestId(NEW, "unverified"));

    // The operator dismisses "could not verify" — records no override (dedicated path).
    const { resolveHumanActionAndAdvance } = await import("../coordinator/commands.js");
    assert.equal(resolveHumanActionAndAdvance(unverified.id, "test", "acknowledge").ok, true);

    // Fresh evidence: a dirty, shell-less session forces a probe past exhaustion, which
    // now returns `missing`.
    verdict = { status: "missing", detail: "probe session completed without running its shell command" };
    const restore = stubMuseVersion(NEW);
    try {
      const log = writeLog([{ type: "tool_call", name: "read_file" }]);
      assert.equal(
        museCapabilitySafetyNetAfterSession({ issueId, runtime: "muse_code", logPath: log, dirty: true }),
        "probed"
      );
      await settleMuseCapabilityCheckForTests();
      const missing = listHumanActionsByRequestId(
        "muse_capability",
        museCapabilityRequestId(NEW, "missing")
      );
      assert.equal(missing.length, 1, "the missing verdict raises its own action");
      assert.equal(missing[0]!.status, "open");
      assert.match(
        missing[0]!.reason,
        new RegExp(`^Muse Code updated ${OLD} → ${NEW}: developer sessions no longer get shell/write access`)
      );
      assert.match(missing[0]!.reason, new RegExp(`admission is blocked for ${NEW}`));
      // The gate blocks, and the earlier dismissal did not override this verdict.
      assert.deepEqual(museCapabilityIssues(NEW).map((i) => i.code), ["runtime_capability"]);
      assert.ok(!JSON.parse(fs.readFileSync(STATE, "utf8")).overriddenVersions.includes(NEW));
      // Polling finds the missing action — never the dismissed unverified one, and the
      // resolved unverified row does not suppress the missing escalation.
      assert.equal(ensureMuseCapabilityEscalation(issueId)?.id, missing[0]!.id);
    } finally {
      restore();
    }
  });

  // NOT-308 repair round 2: with no confirmed baseline, an exhausted version keeps
  // retrying at the maximum backoff — stopping would block admission permanently with
  // no path to unblock — and the escalation says blocked, never "continues on none".
  test("with no baseline, an exhausted version keeps retrying and says blocked", async () => {
    const calls = stubProbe({ [NEW]: { status: "error", detail: "timed out" } });
    await exhaust(NEW);
    assert.equal(calls.get(NEW), 3);
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).lastChecked.attempts, 3);

    // Still blocked, but the message promises a retry — not "no further checks".
    const blocked = museCapabilityIssues(NEW);
    assert.deepEqual(blocked.map((i) => i.code), ["runtime_capability"]);
    assert.match(blocked[0]!.message, /the check retries automatically/);
    assert.doesNotMatch(blocked[0]!.message, /no further automatic checks/);

    // Past exhaustion the check still re-fires once the maximum backoff elapses.
    ageMuseCapabilityCheckForTests(241_000);
    museCapabilityIssues(NEW);
    await settleMuseCapabilityCheckForTests();
    assert.equal(calls.get(NEW), 4, "no-baseline exhaustion keeps retrying at the maximum backoff");
    assert.deepEqual(museCapabilityIssues(NEW).map((i) => i.code), ["runtime_capability"]);

    const issueId = makeIssue();
    const action = ensureMuseCapabilityEscalation(issueId);
    assert.ok(action, "exhaustion still escalates for a human decision");
    assert.equal(action.requestId, museCapabilityRequestId(NEW, "unverified"));
    assert.match(action.reason, /admission is blocked \(no confirmed baseline yet\)/);
    assert.doesNotMatch(action.reason, /continues on the last confirmed baseline/);
    assert.doesNotMatch(action.question, /roll back to none/);
    // Dedupe still holds: a second poll finds the open action, never a copy.
    assert.equal(ensureMuseCapabilityEscalation(issueId)?.id, action.id);
  });

  // NOT-308 repair round 2: a fresh-install `missing` names no "none" rollback target.
  test("a fresh-install missing escalation never suggests rolling back to none", async () => {
    stubProbe({ [NEW]: { status: "missing", detail: "no shell" } });
    const { settled } = await check(NEW);
    assert.deepEqual(settled.map((i) => i.code), ["runtime_capability"]);
    const action = ensureMuseCapabilityEscalation(makeIssue());
    assert.ok(action);
    assert.doesNotMatch(action.question, /to none/);
    assert.match(action.question, /Pin\/roll back Muse outside Dealer to a working build/);
  });

  // NOT-308: the override is version-scoped — a later regression still blocks and
  // escalates on its own.
  test("an acknowledged version stays overridden while a later regressed version still blocks", async () => {
    const LATER = "1.4.0-R4302.1";
    stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "missing", detail: "no shell" },
      [LATER]: { status: "missing", detail: "no shell" },
    });
    await check(OLD);
    await check(NEW);
    const issueId = makeIssue();
    ensureMuseCapabilityEscalation(issueId);
    recordMuseCapabilityOverride(NEW);
    assert.deepEqual(museCapabilityIssues(NEW), []);

    const { settled } = await check(LATER);
    assert.match(
      settled[0]!.message,
      new RegExp(`^Muse Code updated ${NEW} → ${LATER}: developer sessions no longer get`)
    );
    const later = ensureMuseCapabilityEscalation(issueId);
    assert.ok(later, "the later regression raises its own action");
    assert.equal(later.requestId, museCapabilityRequestId(LATER, "missing"));
    assert.match(later.reason, new RegExp(`admission is blocked for ${LATER}`));
  });

  test("countMuseShellToolCalls counts normalized and raw shell calls, null when unknown", () => {
    assert.equal(
      countMuseShellToolCalls(
        writeLog([
          { type: "system", subtype: "init" },
          { type: "tool_call", name: "read_file" },
          { type: "tool_call", name: "bash" },
          { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
          { type: "result", result: "done" },
        ])
      ),
      1
    );
    assert.equal(
      countMuseShellToolCalls(
        writeLog([
          {
            payload_type: "task.lifecycle.side_effect_intent",
            payload: { event: { operation: "tool:bash" } },
          },
          { payload_type: "tool.result", payload: { call_id: "c" } },
        ])
      ),
      1
    );
    assert.equal(countMuseShellToolCalls(writeLog([{ type: "tool_call", name: "write_file" }])), 0);
    assert.equal(countMuseShellToolCalls(writeLog(["not json", ""])), null);
    assert.equal(countMuseShellToolCalls(path.join(os.tmpdir(), `dealer-muse-nope-${randomUUID()}`)), null);
  });

  // NOT-308 safety net: a dirty, shell-less session ending on an unconfirmed version
  // probes immediately (no backoff wait) and a `missing` verdict escalates on the issue.
  test("safety net: dirty + zero-shell on an unconfirmed version probes immediately, missing escalates", async () => {
    const calls = stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "missing", detail: "probe session completed without running its shell command" },
    });
    await check(OLD);
    const restore = stubMuseVersion(NEW);
    try {
      const issueId = makeIssue();
      const log = writeLog([
        { type: "tool_call", name: "read_file" },
        { type: "assistant", message: { content: [{ type: "text", text: "edited" }] } },
      ]);
      const result = museCapabilitySafetyNetAfterSession({
        issueId,
        runtime: "muse_code",
        logPath: log,
        dirty: true,
      });
      assert.equal(result, "probed");
      assert.equal(calls.get(NEW), 1, "probes immediately — never waits out a backoff");
      await settleMuseCapabilityCheckForTests();
      const actions = listHumanActionsByRequestId("muse_capability", museCapabilityRequestId(NEW, "missing"));
      assert.equal(actions.length, 1, "the missing verdict escalates on the watched issue");
      assert.equal(actions[0]!.issueId, issueId);
      assert.equal(JSON.parse(actions[0]!.evidenceJson!).kind, "missing");
      assert.deepEqual(museCapabilityIssues(NEW).map((i) => i.code), ["runtime_capability"]);
    } finally {
      restore();
    }
  });

  test("safety net bypasses the error backoff", async () => {
    const calls = stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "error", detail: "timed out" },
    });
    await check(OLD);
    await check(NEW);
    assert.equal(calls.get(NEW), 1, "attempt 1 done, backoff unelapsed");
    const restore = stubMuseVersion(NEW);
    try {
      const log = writeLog([{ type: "tool_call", name: "read_file" }]);
      assert.equal(
        museCapabilitySafetyNetAfterSession({
          issueId: randomUUID(),
          runtime: "muse_code",
          logPath: log,
          dirty: true,
        }),
        "probed"
      );
      assert.equal(calls.get(NEW), 2, "probes now instead of waiting out the backoff");
      await settleMuseCapabilityCheckForTests();
      assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).lastChecked.attempts, 2);
    } finally {
      restore();
    }
  });

  test("safety net skips clean trees, shell-using sessions, other runtimes, and confirmed versions", async () => {
    const calls = stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "capable" },
    });
    await check(OLD);
    await check(NEW);
    const restore = stubMuseVersion(NEW);
    try {
      const shellLog = writeLog([{ type: "tool_call", name: "bash" }]);
      const bareLog = writeLog([{ type: "tool_call", name: "read_file" }]);
      assert.equal(
        museCapabilitySafetyNetAfterSession({
          issueId: randomUUID(),
          runtime: "muse_code",
          logPath: bareLog,
          dirty: false,
        }),
        "skipped"
      );
      assert.equal(
        museCapabilitySafetyNetAfterSession({
          issueId: randomUUID(),
          runtime: "muse_code",
          logPath: shellLog,
          dirty: true,
        }),
        "skipped"
      );
      assert.equal(
        museCapabilitySafetyNetAfterSession({
          issueId: randomUUID(),
          runtime: "codex_local",
          logPath: bareLog,
          dirty: true,
        }),
        "skipped"
      );
      assert.equal(
        museCapabilitySafetyNetAfterSession({
          issueId: randomUUID(),
          runtime: "muse_code",
          logPath: bareLog,
          dirty: true,
        }),
        "skipped",
        "the confirmed version needs no verification"
      );
      assert.equal(
        museCapabilitySafetyNetAfterSession({
          issueId: randomUUID(),
          runtime: "muse_code",
          logPath: "/nonexistent/session.ndjson",
          dirty: true,
        }),
        "skipped"
      );
      assert.equal(calls.get(NEW), 1, "no safety-net probe fired");
      assert.equal(listHumanActionsByRequestId("muse_capability", museCapabilityRequestId(NEW, "missing")).length, 0);
      assert.equal(listHumanActionsByRequestId("muse_capability", museCapabilityRequestId(NEW, "unverified")).length, 0);
    } finally {
      restore();
    }
  });

  test("a version reported mid-probe is checked once, after the running probe, and the stale verdict is discarded", async () => {
    const LATER = "1.4.0-R4302.1";
    const calls: string[] = [];
    const release = new Map<string, () => void>();
    setMuseCapabilityProbeForTests(
      (version) =>
        new Promise((resolve) => {
          calls.push(version);
          release.set(version, () => resolve(version === NEW ? { status: "capable" } : { status: "missing", detail: "no shell" }));
        })
    );
    museCapabilityIssues(NEW);
    assert.deepEqual(calls, [NEW]);
    // Muse updates again while NEW is still being probed: no second concurrent probe.
    const during = museCapabilityIssues(LATER);
    assert.match(during[0]!.message, new RegExp(`^Muse Code updated ${NEW} → ${LATER}: verifying`));
    museCapabilityIssues(LATER);
    assert.deepEqual(calls, [NEW]);
    // NEW's verdict lands after Muse moved on: discarded, and LATER is probed next (once).
    release.get(NEW)!();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [NEW, LATER]);
    let saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
    assert.equal(saved.confirmedVersion, null);
    assert.equal(saved.lastChecked, null);
    assert.equal(saved.current.version, LATER);
    release.get(LATER)!();
    await settleMuseCapabilityCheckForTests();
    const settled = museCapabilityIssues(LATER);
    assert.match(settled[0]!.message, new RegExp(`^Muse Code updated ${NEW} → ${LATER}: developer sessions no longer get`));
    for (let i = 0; i < 3; i++) museCapabilityIssues(LATER);
    assert.equal(museCapabilityCheckInFlight(), false);
    assert.deepEqual(calls, [NEW, LATER]);
    saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
    assert.equal(saved.lastChecked.version, LATER);
  });

  test("onSettled fires once the check lands so the caller can drop its health cache", async () => {
    stubProbe({ [NEW]: { status: "capable" } });
    let settled = 0;
    museCapabilityIssues(NEW, () => (settled += 1));
    await settleMuseCapabilityCheckForTests();
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, 1);
  });
});

// The real probe: one developer-posture session against the fake Muse, always a fresh `muse exec`.
describe("defaultMuseCapabilityProbe (fake muse)", { concurrency: false }, () => {
  const FAKE_MUSE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../coordinator/fixtures/fake-muse.mjs"
  );

  // A stub Agent Deck API: only `/health` matters to the probe's cheap pre-spawn gate
  // (the fake muse never dials the deck). Started once for this block on an ephemeral port.
  let deckApiUrl = "";
  let deckServer: http.Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        deckServer = http
          .createServer((req, res) => {
            if (req.url === "/health") {
              res.writeHead(200, { "content-type": "text/plain" });
              res.end("ok");
            } else {
              res.writeHead(404);
              res.end();
            }
          })
          .listen(0, "127.0.0.1", () => {
            deckApiUrl = `http://127.0.0.1:${(deckServer!.address() as net.AddressInfo).port}`;
            resolve();
          });
      })
  );
  // `closeAllConnections` first: fetch keep-alive sockets would otherwise hold the
  // stub open and the runner would never exit.
  after(
    () =>
      new Promise<void>((resolve) => {
        if (!deckServer) return resolve();
        deckServer.closeAllConnections();
        deckServer.close(() => resolve());
      })
  );

  /** A surely-closed loopback port: nothing answers, so the deck reads as unreachable. */
  async function deadDeckApiUrl(): Promise<string> {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return `http://127.0.0.1:${port}`;
  }

  // The probe binds a real listed deck and preflights it before spawning; there is no
  // live deck/MCP here, so tests substitute both steps (production defaults hit the live
  // `fetchDecks` + `verifyWorkerDeckConnection`). Overrides exercise the fail-closed paths.
  const PROBE_DECK_ID = "11111111-1111-4111-8111-111111111111";
  async function probeWith(
    scenario: string,
    extraEnv: Record<string, string> = {},
    opts: {
      timeoutMs?: number;
      listDecks?: () => Promise<
        | { ok: true; decks: Array<{ id: string; name: string }> }
        | { ok: false; code: string; message: string }
      >;
      verifyDeck?: (args: { deckId: string; worktreePath: string }) => Promise<
        | { ok: true }
        | { ok: false; kind: "infra_failure" | "deck_unavailable"; reason: string }
      >;
    } = {}
  ): Promise<ProbeResult> {
    const env: Record<string, string> = {
      MUSE_CLI: FAKE_MUSE,
      FAKE_MUSE_SCENARIO: scenario,
      FAKE_MUSE_VERSION: NEW,
      // NOT-278: the probe runs the deck-required exec lane without a database — the endpoint
      // comes from the env override and the credential from a fake API key on stdin. The
      // stub above answers `/health`, so the cheap pre-spawn gate passes and the fake runs.
      AGENT_DECK_API_URL: deckApiUrl,
      META_API_KEY: "mk-test-fake-key-0123456789abcdef",
      ...extraEnv,
    };
    const keys = [...Object.keys(env)];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      return await defaultMuseCapabilityProbe(NEW, {
        timeoutMs: opts.timeoutMs,
        listDecks: opts.listDecks ?? (async () => ({ ok: true as const, decks: [{ id: PROBE_DECK_ID, name: "probe" }] })),
        verifyDeck: opts.verifyDeck ?? (async () => ({ ok: true as const })),
      });
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  test("a session that runs its shell command is capable", async () => {
    assert.deepEqual(await probeWith("capability-shell"), { status: "capable" });
  });

  test("a session that completes without a shell call is missing shell/write", async () => {
    const result = await probeWith("capability-no-shell");
    assert.equal(result.status, "missing");
  });

  test("a session that fails to run at all is an error (could not verify), not missing", async () => {
    const result = await probeWith("auth");
    assert.equal(result.status, "error");
  });

  test("an unreachable deck fails closed before any model session is spent", async () => {
    // The fixture would succeed and record under this scenario — an absent record proves no
    // child ever spawned, so the deck outage cost a cheap health check, never a paid turn.
    const record = path.join(process.env.AGENT_DEALER_HOME!, `no-spawn-${randomUUID()}.json`);
    const result = await probeWith("capability-shell", {
      AGENT_DECK_API_URL: await deadDeckApiUrl(),
      FAKE_MUSE_RECORD: record,
    });
    assert.equal(result.status, "error");
    assert.match((result as { detail: string }).detail, /Agent Deck is unreachable/);
    assert.match((result as { detail: string }).detail, /no model session spent/);
    assert.equal(fs.existsSync(record), false, "no child spawned, so the fixture never recorded");
  });

  test("the probe binds the listed real deck id, never a synthetic one", async () => {
    const record = path.join(process.env.AGENT_DEALER_HOME!, `deck-id-${randomUUID()}.json`);
    const result = await probeWith("capability-shell", { FAKE_MUSE_RECORD: record });
    assert.deepEqual(result, { status: "capable" });
    const seen = JSON.parse(fs.readFileSync(record, "utf8")) as { settings: string };
    assert.match(seen.settings, new RegExp(PROBE_DECK_ID));
    assert.doesNotMatch(seen.settings, /00000000-0000-4000-a000-000000000000/);
  });

  test("a deck that responds but rejects the probe deck fails closed without a model session", async () => {
    const record = path.join(process.env.AGENT_DEALER_HOME!, `rejected-${randomUUID()}.json`);
    const result = await probeWith(
      "capability-shell",
      { FAKE_MUSE_RECORD: record },
      { verifyDeck: async () => ({ ok: false, kind: "infra_failure", reason: "get_bound_deck returned deck other, expected probe" }) }
    );
    assert.equal(result.status, "error");
    assert.match((result as { detail: string }).detail, /rejected probe deck/);
    assert.match((result as { detail: string }).detail, /no model session spent/);
    assert.equal(fs.existsSync(record), false, "no child spawned, so the fixture never recorded");
  });

  test("an empty deck list fails closed without a model session", async () => {
    const record = path.join(process.env.AGENT_DEALER_HOME!, `no-decks-${randomUUID()}.json`);
    const result = await probeWith(
      "capability-shell",
      { FAKE_MUSE_RECORD: record },
      { listDecks: async () => ({ ok: true, decks: [] }) }
    );
    assert.equal(result.status, "error");
    assert.match((result as { detail: string }).detail, /no decks/);
    assert.match((result as { detail: string }).detail, /no model session spent/);
    assert.equal(fs.existsSync(record), false, "no child spawned, so the fixture never recorded");
  });

  test("a session that ran the shell but then timed out is could-not-verify, never capable", async () => {
    const result = await probeWith("capability-shell-then-hang", {}, { timeoutMs: 1500 });
    assert.equal(result.status, "error");
    assert.match((result as { detail: string }).detail, /timed out/);
  });

  test("a session that ran the shell but then failed is could-not-verify, never capable", async () => {
    const result = await probeWith("capability-shell-then-fail");
    assert.equal(result.status, "error");
    assert.match((result as { detail: string }).detail, /probe session (failed|exited)/);
  });

  test("the probe never runs on the shared serve host (deck-enabled turns are always isolated exec)", async () => {
    const { getMuseCapacityHost, resetMuseCapacityHostForTests } = await import("../capacity/muse-host.js");
    await resetMuseCapacityHostForTests();
    let serveSpawns = 0;
    getMuseCapacityHost({
      spawnImpl: (() => {
        serveSpawns += 1;
        throw new Error("serve host must not be used by the capability probe");
      }) as never,
    });
    try {
      assert.deepEqual(await probeWith("capability-shell"), { status: "capable" });
      assert.equal(serveSpawns, 0);
    } finally {
      await resetMuseCapacityHostForTests();
    }
  });

  test("a binary that changes version during the probe is could-not-verify, not capable", async () => {
    const versionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-ver-")), "version");
    fs.writeFileSync(versionFile, NEW);
    const result = await probeWith("capability-shell", {
      FAKE_MUSE_VERSION_FILE: versionFile,
      FAKE_MUSE_UPDATE_TO: "1.5.0-R5000.1",
    });
    assert.equal(result.status, "error");
    assert.match((result as { detail: string }).detail, /1\.5\.0-R5000\.1 after probing 1\.4\.0-R4161\.1/);
  });
});

// NOT-278: deck-enabled developer turns always run the isolated `muse exec` lane — the shared
// serve host cannot carry per-session deck/workspace identity, so no version check can route a
// session onto it. The capability gate still admits (or blocks) the on-disk binary; the lane is
// always exec.
describe("deck-enabled developer sessions always use the isolated exec lane", { concurrency: false }, () => {
  const FAKE_MUSE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../coordinator/fixtures/fake-muse.mjs"
  );

  /** One deck-enabled developer session while a serve host exists; returns host spawn attempts. */
  async function sessionBesideServeHost(): Promise<{ exitCode: number; serveSpawns: number }> {
    const { getMuseCapacityHost, resetMuseCapacityHostForTests } = await import("../capacity/muse-host.js");
    const { runMuseDeveloperSession } = await import("../coordinator/muse-spawn.js");
    await resetMuseCapacityHostForTests();
    let serveSpawns = 0;
    getMuseCapacityHost({
      spawnImpl: (() => {
        serveSpawns += 1;
        throw new Error("serve host must not be used by a deck-enabled developer session");
      }) as never,
    });
    // NOT-278: home scratch, never OS temp (the attempt rejects temp dirs).
    const dir = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-exec-"));
    const configHome = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-exec-cfg-"));
    const keys = ["MUSE_CLI", "FAKE_MUSE_SCENARIO", "META_API_KEY", "XDG_CONFIG_HOME"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      MUSE_CLI: FAKE_MUSE,
      FAKE_MUSE_SCENARIO: "success",
      META_API_KEY: "mk-test-fake-key-0123456789abcdef",
      XDG_CONFIG_HOME: configHome,
    });
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const run = await runMuseDeveloperSession({
        sessionId: randomUUID(),
        runtime: "muse_code",
        policy: {} as never,
        model: null,
        deckId: "00000000-0000-4000-a000-000000000099",
        agentDeckUrl: "http://127.0.0.1:1110/mcp",
        prompt: "implement",
        cwd: dir,
        timeoutMs: 30_000,
        logPath: path.join(dir, "session.ndjson"),
      });
      return { exitCode: run.exitCode, serveSpawns };
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await resetMuseCapacityHostForTests();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  }

  test("the session runs on the exec lane and never touches the serve host", async () => {
    const { exitCode, serveSpawns } = await sessionBesideServeHost();
    assert.equal(exitCode, 0);
    assert.equal(serveSpawns, 0, "no serve-host spawn for a deck-enabled developer turn");
  });
});
