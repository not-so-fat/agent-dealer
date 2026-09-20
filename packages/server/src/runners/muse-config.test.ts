import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertMuseArgv,
  buildMuseArgv,
  MuseIsolationError,
  prepareMuseAttempt as prepareMuseAttemptPinned,
  unenforceableRestrictions,
  type MuseAttempt,
  type MuseAttemptInput,
  type MuseEnforcementEvidence,
  type MuseRole,
} from "./muse-config.js";
import { pathToFileURL } from "node:url";

// The Muse sandbox leaves temp dirs writable, so the module refuses them: fixtures live under $HOME.
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-config-test-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const ENFORCED: MuseEnforcementEvidence = { mcp_tool_allowlist_enforcement: true, cron_tool_disable: true };

// Production code has no seam that accepts other enforcement evidence. The enforced paths are exercised
// against a hypothetical build by loading a source-rewritten copy of the core with the pinned evidence
// flipped to true. The copy lives in SCRATCH (outside src/ and dist/), so it never ships.
async function loadEnforcedCore(): Promise<{ prepareMuseAttempt: (i: MuseAttemptInput) => MuseAttempt }> {
  const source = fs.readFileSync(path.join(import.meta.dirname, "muse-config-core.ts"), "utf8");
  const literal = /(mcp_tool_allowlist_enforcement|cron_tool_disable): false,/g;
  assert.equal(source.match(literal)?.length, 2, "pinned evidence literal changed; update the test rewrite");
  const copy = path.join(SCRATCH, "muse-config-core.enforced.ts");
  fs.writeFileSync(copy, source.replace(literal, "$1: true,"));
  return import(pathToFileURL(copy).href);
}
const enforcedCore = await loadEnforcedCore();
const prepareMuseAttempt = (i: MuseAttemptInput) => enforcedCore.prepareMuseAttempt(i);
const SESSION = "11111111-2222-4333-8444-555555555555";
const API_KEY = "mk-live-SECRET-0123456789abcdef";
const DECK_URL = "http://127.0.0.1:1110/mcp";

interface Fixture {
  worktree: string;
  baseDir: string;
  operatorAuth: string;
  operatorConfigHome: string;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "case-"));
  const worktree = path.join(dir, "worktree");
  const baseDir = path.join(dir, "attempts");
  const operatorConfigHome = path.join(dir, "operator-config");
  fs.mkdirSync(worktree);
  fs.mkdirSync(baseDir);
  fs.mkdirSync(path.join(operatorConfigHome, "muse"), { recursive: true });
  const operatorAuth = path.join(operatorConfigHome, "muse", "auth.json");
  fs.writeFileSync(operatorAuth, '{"token":"operator-owned"}');
  return { worktree, baseDir, operatorAuth, operatorConfigHome };
}

function input(fx: Fixture, role: MuseRole, over: Partial<MuseAttemptInput> = {}): MuseAttemptInput {
  return {
    role,
    worktreePath: fx.worktree,
    baseDir: fx.baseDir,
    agentDeck: { url: DECK_URL, deckId: "deck-123", workspace: fx.worktree },
    credential: { kind: "auth-file", path: fx.operatorAuth },
    sessionId: SESSION,
    prompt: "Implement the ticket",
    maxModelSteps: 300,
    env: { PATH: "/usr/bin", HOME: os.homedir() },
    ...over,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    // The enforced-core copy has its own MuseIsolationError class, so match by name.
    assert.ok(err instanceof Error && err.name === "MuseIsolationError", String(err));
    return (err as MuseIsolationError).code;
  }
  return undefined;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

test("with NOT-177 evidence both roles fail before anything is written", () => {
  for (const role of ["developer", "reviewer"] as const) {
    const fx = fixture();
    let thrown: MuseIsolationError | undefined;
    try {
      prepareMuseAttemptPinned(input(fx, role));
    } catch (err) {
      thrown = err as MuseIsolationError;
    }
    assert.equal(thrown?.code, "unenforceable_restriction", role);
    assert.deepEqual([...thrown!.capabilities], ["mcp_tool_allowlist_enforcement", "cron_tool_disable"]);
    assert.deepEqual(fs.readdirSync(fx.baseDir), []);
  }
  assert.deepEqual(unenforceableRestrictions("developer", ENFORCED), []);
  assert.deepEqual(unenforceableRestrictions("reviewer", { ...ENFORCED, cron_tool_disable: false }), [
    "cron_tool_disable",
  ]);
});

test("developer: only the assigned Agent Deck surface, sandbox on, no unrestricted flags", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "developer"));
  try {
    assert.ok(!attempt.root.startsWith(fx.worktree), "config lives outside the worktree");
    const onDisk = JSON.parse(fs.readFileSync(attempt.settingsPath, "utf8"));
    assert.deepEqual(Object.keys(onDisk).sort(), ["mcpServers", "run", "runtime_capabilities", "schema_version"]);
    assert.deepEqual(Object.keys(onDisk.mcpServers), ["agent-deck"]);
    const server = onDisk.mcpServers["agent-deck"];
    assert.equal(server.mode, "required");
    assert.equal("required" in server, false, "mode and required together drop the MCP block");
    assert.deepEqual(server.headers, {
      "x-agent-deck-deck-id": "deck-123",
      "x-agent-deck-workspace": fs.realpathSync(fx.worktree),
    });
    assert.deepEqual(server.enabled_tools, ["get_bound_deck", "get_playbook", "list_service_tools", "bind_workspace"]);
    assert.deepEqual(server.disabled_tools, ["call_service_tool"]);
    assert.deepEqual(onDisk.run, { workflow_trigger_mode: "off", subagent_delegation_mode: "off" });
    for (const tool of ["cron_create", "cron_list", "cron_delete"]) {
      assert.deepEqual(onDisk.runtime_capabilities[`tool:${tool}`], { enabled: false });
    }

    const flag = (f: string) => attempt.argv[attempt.argv.indexOf(f) + 1];
    assert.equal(attempt.argv[0], "exec");
    assert.equal(flag("--approval-mode"), "never");
    assert.equal(flag("--sandbox-network"), "restricted");
    assert.equal(flag("--model"), "muse-spark-1.3-contributor");
    assert.equal(flag("--session-id"), SESSION);
    assert.equal(attempt.argv.at(-1), "Implement the ticket");
    for (const bad of ["--yolo", "--disable-sandbox", "--disable-approval", "--trust-workspace", "-w", "--worktree", "--disable-write", "--disable-shell"]) {
      assert.equal(attempt.argv.includes(bad), false, bad);
    }
    assert.equal(fs.statSync(attempt.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(attempt.settingsPath).mode & 0o777, 0o600);
    assert.equal(attempt.env.XDG_CONFIG_HOME, path.join(attempt.root, "config"));
    assert.equal(attempt.env.XDG_DATA_HOME, path.join(attempt.root, "data"));
    assert.equal(attempt.env.MUSE_NO_AUTO_UPDATE, "1");
    assert.equal(attempt.stdin, undefined);
    assert.doesNotThrow(() => attempt.verify());
  } finally {
    attempt.cleanup();
  }
});

test("reviewer: read-only flags and the same deck reads, mutation denied", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "reviewer"));
  try {
    assert.ok(attempt.argv.includes("--disable-write"));
    assert.ok(attempt.argv.includes("--disable-shell"));
    const server = attempt.settings.mcpServers["agent-deck"]!;
    assert.equal(server.enabled_tools?.includes("call_service_tool"), false);
    assert.deepEqual(server.disabled_tools, ["call_service_tool"]);
    assert.deepEqual(Object.keys(attempt.settings.mcpServers), ["agent-deck"]);
  } finally {
    attempt.cleanup();
  }
  // A reviewer argv without the read-only flags is refused, as is a developer with them.
  assert.equal(code(() => assertMuseArgv(buildMuseArgv({ role: "developer", sessionId: SESSION, maxModelSteps: 5, prompt: "x" }), "reviewer")), "invalid_argv");
  assert.equal(code(() => assertMuseArgv(buildMuseArgv({ role: "reviewer", sessionId: SESSION, maxModelSteps: 5, prompt: "x" }), "developer")), "invalid_argv");
});

test("argv guard refuses every trust/sandbox/orchestration widening flag", () => {
  const base = buildMuseArgv({ role: "developer", sessionId: SESSION, maxModelSteps: 5, prompt: "x" });
  for (const bad of ["--yolo", "--disable-sandbox", "--disable-approval", "--trust-workspace", "-w", "--worktree=nested", "--preset", "--agents", "--permission-profile"]) {
    const argv = [...base.slice(0, -1), bad, "x"];
    assert.equal(code(() => assertMuseArgv(argv, "developer")), "invalid_argv", bad);
  }
  const relaxed = base.map((a) => (a === "restricted" ? "proxy-only" : a));
  assert.equal(code(() => assertMuseArgv(relaxed, "developer")), "invalid_argv");
  const prompted = input(fixture(), "developer", { prompt: "--yolo" });
  assert.equal(code(() => prepareMuseAttempt(prompted)), "invalid_input");
});

test("ambient Muse config, env, and workspace files cannot expand the attempt", () => {
  const fx = fixture();
  const ambientSettings = path.join(fx.operatorConfigHome, "muse", "settings.json");
  const ambientBody = JSON.stringify({
    schema_version: 1,
    mcpServers: { evil: { type: "streamable-http", url: "http://evil.invalid/mcp", mode: "optional" } },
    run: { workflow_trigger_mode: "auto", subagent_delegation_mode: "auto" },
  });
  fs.writeFileSync(ambientSettings, ambientBody);
  fs.writeFileSync(path.join(fx.worktree, ".mcp.json"), '{"mcpServers":{"workspace-evil":{"command":"sh"}}}');
  const attempt = prepareMuseAttempt(
    input(fx, "developer", {
      env: {
        PATH: "/usr/bin",
        HOME: os.homedir(),
        XDG_CONFIG_HOME: fx.operatorConfigHome,
        XDG_DATA_HOME: "/operator/data",
        META_API_KEY: API_KEY,
        MUSE_PRESET: "yolo",
        MUSE_NO_AUTO_UPDATE: "0",
        CODEX_HOME: "/operator/codex",
        LC_ALL: "C",
      },
    })
  );
  try {
    assert.deepEqual(Object.keys(attempt.settings.mcpServers), ["agent-deck"]);
    assert.equal(attempt.env.XDG_CONFIG_HOME, path.join(attempt.root, "config"));
    assert.equal(attempt.env.XDG_DATA_HOME, path.join(attempt.root, "data"));
    assert.equal(attempt.env.MUSE_NO_AUTO_UPDATE, "1");
    for (const dropped of ["META_API_KEY", "MUSE_PRESET", "CODEX_HOME"]) assert.equal(dropped in attempt.env, false, dropped);
    assert.equal(attempt.env.LC_ALL, "C");
    assert.equal(attempt.argv.includes("--trust-workspace"), false);
    assert.ok(attempt.argv.includes("--no-foreign-personal-context"));
    assert.ok(!fs.readFileSync(attempt.settingsPath, "utf8").includes("evil"));

    // Someone widening the per-attempt config after the fact is caught before spawn.
    const good = fs.readFileSync(attempt.settingsPath, "utf8");
    const tamper = (mut: (s: any) => void) => {
      const s = JSON.parse(good);
      mut(s);
      fs.writeFileSync(attempt.settingsPath, JSON.stringify(s));
      return code(() => attempt.verify());
    };
    assert.equal(tamper((s) => (s.mcpServers.extra = { type: "streamable-http", url: DECK_URL, mode: "required" })), "invalid_settings");
    assert.equal(tamper((s) => (s.run.subagent_delegation_mode = "auto")), "invalid_settings");
    assert.equal(tamper((s) => (s.mcpServers["agent-deck"].disabled_tools = [])), "invalid_settings");
    assert.equal(tamper((s) => delete s.run), "invalid_settings");
    fs.writeFileSync(attempt.settingsPath, good);
    fs.writeFileSync(path.join(path.dirname(attempt.settingsPath), "config.toml"), "x");
    assert.equal(code(() => attempt.verify()), "invalid_settings");
    fs.rmSync(path.join(path.dirname(attempt.settingsPath), "config.toml"));
    fs.writeFileSync(attempt.settingsPath, "{not json");
    assert.equal(code(() => attempt.verify()), "invalid_settings");
    fs.rmSync(attempt.settingsPath);
    assert.equal(code(() => attempt.verify()), "invalid_settings");
  } finally {
    attempt.cleanup();
  }
  assert.equal(fs.readFileSync(ambientSettings, "utf8"), ambientBody);
});

test("required Agent Deck server: optional mode, bad url, and missing identity fail before spawn", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "developer"));
  try {
    const s = JSON.parse(fs.readFileSync(attempt.settingsPath, "utf8"));
    s.mcpServers["agent-deck"].mode = "optional";
    fs.writeFileSync(attempt.settingsPath, JSON.stringify(s));
    assert.equal(code(() => attempt.verify()), "invalid_settings");
    s.mcpServers["agent-deck"].mode = "required";
    s.mcpServers["agent-deck"].required = true;
    fs.writeFileSync(attempt.settingsPath, JSON.stringify(s));
    assert.equal(code(() => attempt.verify()), "invalid_settings");
  } finally {
    attempt.cleanup();
  }
  const bad: Partial<MuseAttemptInput>[] = [
    { agentDeck: { url: "not a url", deckId: "d", workspace: fx.worktree } },
    { agentDeck: { url: "file:///etc/passwd", deckId: "d", workspace: fx.worktree } },
    { agentDeck: { url: "http://u:p@127.0.0.1:1110/mcp", deckId: "d", workspace: fx.worktree } },
    { agentDeck: { url: DECK_URL, deckId: " ", workspace: fx.worktree } },
    { agentDeck: { url: DECK_URL, deckId: "d", workspace: SCRATCH } },
    { sessionId: "not-a-uuid" },
    { maxModelSteps: 0 },
    { credential: { kind: "auth-file", path: path.join(fx.baseDir, "missing.json") } },
    { credential: { kind: "api-key", apiKey: "  " } },
  ];
  for (const over of bad) {
    assert.equal(code(() => prepareMuseAttempt(input(fx, "developer", over))), "invalid_input", JSON.stringify(over));
  }
  assert.deepEqual(fs.readdirSync(fx.baseDir), [], "nothing is written when validation fails");
});

test("worktree and config must be separate, and neither may sit under a temp dir", () => {
  const fx = fixture();
  assert.equal(code(() => prepareMuseAttempt(input(fx, "developer", { baseDir: fx.worktree }))), "unsafe_path");
  const inside = path.join(fx.worktree, "attempts");
  fs.mkdirSync(inside);
  assert.equal(code(() => prepareMuseAttempt(input(fx, "developer", { baseDir: inside }))), "unsafe_path");
  const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "muse-config-tmp-"));
  try {
    const agentDeck = { url: DECK_URL, deckId: "d", workspace: tmpWorktree };
    assert.equal(code(() => prepareMuseAttempt(input(fx, "developer", { worktreePath: tmpWorktree, agentDeck }))), "unsafe_path");
    assert.equal(code(() => prepareMuseAttempt(input(fx, "developer", { baseDir: tmpWorktree }))), "unsafe_path");
  } finally {
    fs.rmSync(tmpWorktree, { recursive: true, force: true });
  }
});

test("cleanup removes ephemeral config and auth link but never operator-owned state", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "developer"));
  const link = path.join(path.dirname(attempt.settingsPath), "auth.json");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(link, "utf8"), '{"token":"operator-owned"}');
  fs.writeFileSync(path.join(attempt.root, "data", "session.jsonl"), "muse wrote this");
  const other = path.join(fx.baseDir, "someone-elses-dir");
  fs.mkdirSync(other);
  attempt.cleanup();
  attempt.cleanup();
  assert.equal(fs.existsSync(attempt.root), false);
  assert.equal(fs.readFileSync(fx.operatorAuth, "utf8"), '{"token":"operator-owned"}');
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(fx.worktree));
  assert.deepEqual(fs.readdirSync(fx.worktree), [], "nothing is written into the worktree");

  // Without the sentinel the dir is not ours to delete.
  const foreign = prepareMuseAttempt(input(fx, "reviewer"));
  fs.rmSync(path.join(foreign.root, ".dealer-muse-attempt"));
  foreign.cleanup();
  assert.ok(fs.existsSync(foreign.root));
});

test("cleanup is retryable: a transient rmSync failure does not strand the attempt dir", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "developer"));
  const link = path.join(path.dirname(attempt.settingsPath), "auth.json");
  const realRm = fs.rmSync;
  const rm = mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("EBUSY: transient"), { code: "EBUSY" });
  });
  try {
    assert.throws(() => attempt.cleanup(), /EBUSY/);
    assert.throws(() => attempt.cleanup(), /EBUSY/, "a failed cleanup is not terminal");
    assert.ok(fs.existsSync(attempt.settingsPath));
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  } finally {
    rm.mock.restore();
  }
  assert.equal(fs.rmSync, realRm);
  attempt.cleanup();
  assert.equal(fs.existsSync(attempt.root), false);
  assert.equal(fs.readFileSync(fx.operatorAuth, "utf8"), '{"token":"operator-owned"}');
  assert.doesNotThrow(() => attempt.cleanup());
});

test("cleanup treats an already-removed dir as done", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "developer"));
  fs.rmSync(attempt.root, { recursive: true });
  assert.doesNotThrow(() => attempt.cleanup());
  assert.doesNotThrow(() => attempt.cleanup());
});

test("a failure before the sentinel is written still removes the new attempt dir", () => {
  const fx = fixture();
  const realWrite = fs.writeFileSync;
  const write = mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).endsWith(".dealer-muse-attempt")) throw new Error("ENOSPC: injected");
    return (realWrite as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync);
  try {
    assert.throws(() => prepareMuseAttempt(input(fx, "developer")), /ENOSPC: injected/);
  } finally {
    write.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(fx.baseDir), [], "no sentinel-less attempt dir is left behind");
  assert.equal(fs.readFileSync(fx.operatorAuth, "utf8"), '{"token":"operator-owned"}');
});

test("if setup fails and the new dir cannot be removed, the failure names the stranded dir", () => {
  const fx = fixture();
  const realWrite = fs.writeFileSync;
  const write = mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).endsWith("settings.json")) throw new Error("EIO: injected");
    return (realWrite as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync);
  const rm = mock.method(fs, "rmSync", () => {
    throw new Error("EBUSY: transient");
  });
  let thrown: unknown;
  try {
    try {
      prepareMuseAttempt(input(fx, "developer", { credential: { kind: "api-key", apiKey: API_KEY } }));
    } catch (err) {
      thrown = err;
    }
  } finally {
    write.mock.restore();
    rm.mock.restore();
  }
  assert.equal((thrown as MuseIsolationError | undefined)?.code, "cleanup_failed");
  const [stranded] = fs.readdirSync(fx.baseDir);
  assert.ok(stranded);
  assert.ok((thrown as Error).message.includes(stranded!));
  assert.ok(!(thrown as Error).message.includes(API_KEY));
  // Nothing tracks it any more, so the operator removes it; the sentinel makes it identifiable.
  assert.ok(fs.existsSync(path.join(fx.baseDir, stranded!, ".dealer-muse-attempt")));
});

test("an unwritable base dir fails without leaving a partial attempt", () => {
  const fx = fixture();
  fs.chmodSync(fx.baseDir, 0o500);
  try {
    assert.throws(() => prepareMuseAttempt(input(fx, "developer")));
  } finally {
    fs.chmodSync(fx.baseDir, 0o700);
  }
  assert.deepEqual(fs.readdirSync(fx.baseDir), []);
});

test("api key never reaches argv, env, disk, or error text; redact scrubs it", () => {
  const fx = fixture();
  const attempt = prepareMuseAttempt(input(fx, "developer", { credential: { kind: "api-key", apiKey: API_KEY } }));
  try {
    assert.equal(attempt.stdin, `${API_KEY}\n`);
    assert.ok(attempt.argv.includes("--api-key-stdin"));
    assert.ok(!JSON.stringify(attempt.argv).includes(API_KEY));
    assert.ok(!JSON.stringify(attempt.env).includes(API_KEY));
    for (const file of walk(attempt.root)) assert.ok(!fs.readFileSync(file, "utf8").includes(API_KEY), file);
    assert.ok(!fs.existsSync(path.join(path.dirname(attempt.settingsPath), "auth.json")));
    assert.doesNotThrow(() => attempt.verify());
    const leaked = `fatal: key ${API_KEY} rejected; META_API_KEY=other-secret-value; Authorization: Bearer abcdef1234567890`;
    const scrubbed = attempt.redact(leaked);
    assert.ok(!scrubbed.includes(API_KEY));
    assert.ok(!scrubbed.includes("other-secret-value"));
    assert.ok(!scrubbed.includes("abcdef1234567890"));
  } finally {
    attempt.cleanup();
  }
  for (const over of [{ sessionId: "bad" }, { prompt: "-x" }, {}] as Partial<MuseAttemptInput>[]) {
    try {
      // The `{}` case goes through the pinned entry point, which refuses on NOT-177 evidence.
      const prepare = Object.keys(over).length === 0 ? prepareMuseAttemptPinned : prepareMuseAttempt;
      prepare(input(fx, "developer", { credential: { kind: "api-key", apiKey: API_KEY }, ...over }));
      assert.fail("expected refusal");
    } catch (err) {
      assert.ok(err instanceof Error && err.name === "MuseIsolationError");
      assert.ok(!err.message.includes(API_KEY));
      assert.ok(!String(err.stack).includes(API_KEY));
    }
  }
  assert.deepEqual(fs.readdirSync(fx.baseDir), []);
});

test("callers cannot supply enforcement evidence: an injected evidence field is ignored", () => {
  for (const role of ["developer", "reviewer"] as const) {
    const fx = fixture();
    const forged = { ...input(fx, role), evidence: ENFORCED } as MuseAttemptInput;
    assert.equal(code(() => prepareMuseAttemptPinned(forged)), "unenforceable_restriction", role);
    assert.deepEqual(fs.readdirSync(fx.baseDir), []);
  }
});

test("launch contract: cwd is the real worktree and argv/env/cwd/stdin must match exactly", () => {
  const fx = fixture();
  const link = path.join(fx.baseDir, "worktree-link");
  fs.symlinkSync(fx.worktree, link);
  const attempt = prepareMuseAttempt(input(fx, "developer", { worktreePath: link }));
  try {
    assert.equal(attempt.cwd, fs.realpathSync(fx.worktree));
    assert.doesNotThrow(() => attempt.verify());
    assert.doesNotThrow(() => attempt.verify({ cwd: attempt.cwd, argv: [...attempt.argv], env: { ...attempt.env }, stdin: attempt.stdin }));

    // Returned data is immutable.
    assert.throws(() => (attempt.argv as string[]).push("--yolo"));
    assert.throws(() => ((attempt.env as Record<string, string>).XDG_CONFIG_HOME = "/ambient"));
    assert.throws(() => ((attempt as { cwd: string }).cwd = "/"));
    assert.throws(() => ((attempt.settings.mcpServers as Record<string, unknown>).extra = {}));

    // A consumer that builds its own launch is checked against the approved one.
    const launch = { cwd: attempt.cwd, argv: [...attempt.argv], env: { ...attempt.env }, stdin: attempt.stdin };
    const without = (flag: string, n = 1) => {
      const i = launch.argv.indexOf(flag);
      return [...launch.argv.slice(0, i), ...launch.argv.slice(i + n)];
    };
    const widened: Record<string, typeof launch> = {
      "spawn from server dir": { ...launch, cwd: process.cwd() },
      "spawn from parent dir": { ...launch, cwd: path.dirname(fx.worktree) },
      "drop --disable-web-tools": { ...launch, argv: without("--disable-web-tools") },
      "drop --approval-judge off": { ...launch, argv: without("--approval-judge", 2) },
      "add --base-url": { ...launch, argv: [...launch.argv.slice(0, -1), "--base-url", "http://evil.invalid", launch.argv.at(-1)!] },
      "duplicate flag": { ...launch, argv: [...launch.argv.slice(0, -1), "--json", launch.argv.at(-1)!] },
      "change prompt": { ...launch, argv: [...launch.argv.slice(0, -1), "other prompt"] },
      "ambient XDG_CONFIG_HOME": { ...launch, env: { ...launch.env, XDG_CONFIG_HOME: fx.operatorConfigHome } },
      "ambient XDG_DATA_HOME": { ...launch, env: { ...launch.env, XDG_DATA_HOME: "/operator/data" } },
      "extra env": { ...launch, env: { ...launch.env, META_API_KEY: API_KEY } },
      "dropped env": { ...launch, env: Object.fromEntries(Object.entries(launch.env).filter(([k]) => k !== "MUSE_NO_AUTO_UPDATE")) },
      "injected stdin": { ...launch, stdin: "key\n" },
    };
    for (const [name, bad] of Object.entries(widened)) {
      assert.equal(code(() => attempt.verify(bad)), "invalid_argv", name);
    }
  } finally {
    attempt.cleanup();
  }
});

test("verification is snapshotted: mutating the original input cannot retarget the MCP server", () => {
  const fx = fixture();
  const original = input(fx, "developer");
  const attempt = prepareMuseAttempt(original);
  try {
    // Attacker rewrites the caller's objects and settings.json to a different deck / URL.
    original.agentDeck.url = "http://evil.invalid/mcp";
    original.agentDeck.deckId = "deck-evil";
    (original as { credential: unknown }).credential = { kind: "api-key", apiKey: API_KEY };
    original.role = "reviewer";
    const evil = JSON.parse(fs.readFileSync(attempt.settingsPath, "utf8"));
    evil.mcpServers["agent-deck"].url = "http://evil.invalid/mcp";
    evil.mcpServers["agent-deck"].headers["x-agent-deck-deck-id"] = "deck-evil";
    fs.writeFileSync(attempt.settingsPath, JSON.stringify(evil));
    assert.equal(code(() => attempt.verify()), "invalid_settings");

    // Restoring the approved settings passes again, so verify compares against the snapshot.
    evil.mcpServers["agent-deck"].url = DECK_URL;
    evil.mcpServers["agent-deck"].headers["x-agent-deck-deck-id"] = "deck-123";
    fs.writeFileSync(attempt.settingsPath, JSON.stringify(evil));
    assert.doesNotThrow(() => attempt.verify());
  } finally {
    attempt.cleanup();
  }
});

test("no runtime export can produce a launchable attempt from caller-supplied evidence", async () => {
  for (const mod of ["./muse-config.js", "./muse-config-core.js"]) {
    const exported = (await import(mod)) as Record<string, unknown>;
    assert.equal("prepareWithEvidence" in exported, false, mod);
    assert.equal("museConfigTesting" in exported, false, mod);
    // Only the pinned preparer returns a MuseAttempt-producing function; it takes exactly one argument.
    for (const [name, value] of Object.entries(exported)) {
      if (typeof value === "function" && /^prepare/.test(name)) assert.equal(value.length, 1, `${mod}#${name}`);
    }
  }
  // The pinned core cannot be talked into success with a forged evidence argument or field.
  const core = (await import("./muse-config-core.js")) as { prepareMuseAttempt: (...a: unknown[]) => unknown };
  const fx = fixture();
  const forged = () => core.prepareMuseAttempt(input(fx, "developer"), ENFORCED);
  assert.equal(code(forged), "unenforceable_restriction");
  assert.deepEqual(fs.readdirSync(fx.baseDir), []);
});

test("only muse-config.ts and tests import muse-config-core", () => {
  const srcRoot = path.resolve(import.meta.dirname, "..");
  const offenders = walk(srcRoot).filter((f) => {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) return false;
    if (path.basename(f) === "muse-config.ts" || path.basename(f) === "muse-config-core.ts") return false;
    return /muse-config-core/.test(fs.readFileSync(f, "utf8"));
  });
  assert.deepEqual(offenders, []);
});
