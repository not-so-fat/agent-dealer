import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertMuseArgv,
  buildMuseArgv,
  MuseIsolationError,
  prepareMuseAttempt,
  unenforceableRestrictions,
  type MuseAttemptInput,
  type MuseEnforcementEvidence,
  type MuseRole,
} from "./muse-config.js";

// The Muse sandbox leaves temp dirs writable, so the module refuses them: fixtures live under $HOME.
const SCRATCH = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-config-test-"));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const ENFORCED: MuseEnforcementEvidence = { mcp_tool_allowlist_enforcement: true, cron_tool_disable: true };
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
    evidence: ENFORCED,
    env: { PATH: "/usr/bin", HOME: os.homedir() },
    ...over,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof MuseIsolationError, String(err));
    return err.code;
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
      prepareMuseAttempt(input(fx, role, { evidence: undefined }));
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
  for (const over of [{ sessionId: "bad" }, { prompt: "-x" }, { evidence: undefined }] as Partial<MuseAttemptInput>[]) {
    try {
      prepareMuseAttempt(input(fx, "developer", { credential: { kind: "api-key", apiKey: API_KEY }, ...over }));
      assert.fail("expected refusal");
    } catch (err) {
      assert.ok(err instanceof MuseIsolationError);
      assert.ok(!err.message.includes(API_KEY));
      assert.ok(!String(err.stack).includes(API_KEY));
    }
  }
  assert.deepEqual(fs.readdirSync(fx.baseDir), []);
});
