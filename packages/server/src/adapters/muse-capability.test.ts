// packages/server/src/adapters/muse-capability.test.ts
//
// NOT-277: Muse Code developer shell/write capability is re-validated once per newly reported
// version — cached per version, auto-confirmed on success, blocked by name on loss, fail-closed
// when the check cannot complete. The real probe runs against fixtures/fake-muse.mjs (never Meta).
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-capability-"));

const {
  museCapabilityIssues,
  museCapabilityCheckInFlight,
  parseMuseVersion,
  settleMuseCapabilityCheckForTests,
  setMuseCapabilityProbeForTests,
  resetMuseCapabilityStateForTests,
  ageMuseCapabilityCheckForTests,
  defaultMuseCapabilityProbe,
} = await import("./muse-capability.js");
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

describe("muse-capability", { concurrency: false }, () => {
  beforeEach(() => {
    resetMuseCapabilityStateForTests();
    setMuseCapabilityProbeForTests(null);
  });

  test("parseMuseVersion reads the build id from `muse --version`", () => {
    assert.equal(parseMuseVersion("Muse Code 1.3.0 (1.3.0-R3401.1)\n"), OLD);
    assert.equal(parseMuseVersion("1.4.0-R4161.1\n"), NEW);
    assert.equal(parseMuseVersion("  \n"), null);
  });

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
    assert.match(first[0]!.message, new RegExp(`Muse Code updated ${OLD} → ${NEW}: verifying`));
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

  // (d) the check itself errors / times out → blocked with a distinct "could not verify" message.
  for (const [label, result] of [
    ["throws", new Error("spawn EACCES")],
    ["times out", { status: "error", detail: `probe session on ${NEW} timed out` }],
  ] as const) {
    test(`a check that ${label} fails closed with a distinct "could not verify" message`, async () => {
      const calls = stubProbe({ [OLD]: { status: "capable" }, [NEW]: result });
      await check(OLD);
      const { settled } = await check(NEW);
      assert.deepEqual(settled.map((i) => i.code), ["runtime_capability"]);
      assert.match(
        settled[0]!.message,
        new RegExp(`^Could not verify Muse Code developer shell/write access after version change \\(${OLD} → ${NEW}\\)`)
      );
      assert.doesNotMatch(settled[0]!.message, /no longer get/);
      // Not re-probed before the retry backoff, and the block stays up meanwhile.
      assert.deepEqual(museCapabilityIssues(NEW), settled);
      assert.equal(calls.get(NEW), 1);
      assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, OLD);
    });
  }

  test("a could-not-verify result is retried after the backoff, staying blocked until it passes", async () => {
    let next: ProbeResult = { status: "error", detail: "timed out" };
    let calls = 0;
    setMuseCapabilityProbeForTests(async () => {
      calls += 1;
      return next;
    });
    await check(NEW);
    next = { status: "capable" };
    ageMuseCapabilityCheckForTests(11 * 60_000);
    const retrying = museCapabilityIssues(NEW);
    assert.match(retrying[0]!.message, /Could not verify/);
    await settleMuseCapabilityCheckForTests();
    assert.equal(calls, 2);
    assert.deepEqual(museCapabilityIssues(NEW), []);
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

// The real probe: one developer-posture session through the exec lane against the fake Muse.
describe("defaultMuseCapabilityProbe (fake muse)", { concurrency: false }, () => {
  const FAKE_MUSE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../coordinator/fixtures/fake-muse.mjs"
  );

  async function probeWith(scenario: string): Promise<ProbeResult> {
    const keys = ["MUSE_CLI", "FAKE_MUSE_SCENARIO", "AGENT_DEALER_MUSE_RUNNER"] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.MUSE_CLI = FAKE_MUSE;
    process.env.FAKE_MUSE_SCENARIO = scenario;
    process.env.AGENT_DEALER_MUSE_RUNNER = "exec";
    try {
      return await defaultMuseCapabilityProbe(NEW);
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
});
