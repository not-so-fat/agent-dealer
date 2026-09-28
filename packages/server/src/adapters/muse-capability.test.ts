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
// dealer home for this file is a home scratch root, never OS temp.
process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-capability-"));

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
    assert.match(first[0]!.message, new RegExp(`^Muse Code updated ${NEW} → ${LATER}: verifying`));
    assert.match(settled[0]!.message, new RegExp(`^Muse Code updated ${NEW} → ${LATER}: developer sessions no longer get`));
    assert.doesNotMatch(settled[0]!.message, new RegExp(OLD.replace(/\./g, "\\.")));
    assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).confirmedVersion, OLD);
  });

  test("consecutive could-not-verify updates also name the exact previous version", async () => {
    const LATER = "1.4.0-R4302.1";
    stubProbe({
      [OLD]: { status: "capable" },
      [NEW]: { status: "error", detail: "timed out" },
      [LATER]: { status: "error", detail: "timed out" },
    });
    await check(OLD);
    await check(NEW);
    const { settled } = await check(LATER);
    assert.match(settled[0]!.message, new RegExp(`after version change \\(${NEW} → ${LATER}\\)`));
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

  async function probeWith(
    scenario: string,
    extraEnv: Record<string, string> = {},
    opts: { timeoutMs?: number } = {}
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
      return await defaultMuseCapabilityProbe(NEW, opts);
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
