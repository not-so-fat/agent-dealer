import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// NOT-177: mechanical consistency check for the sanitized Muse Code captures and their manifest.
const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "muse-code");

interface Entry {
  fixture: string;
  probe?: number;
  command?: string;
  commands?: string[];
  harness?: string;
  exact?: boolean;
  exact_reason?: string;
  settings_profile?: string | null;
  exit_code: string;
  stdout_lines_raw: number;
  stdout_lines_committed: number;
  dropped_by_type: Record<string, number>;
}
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
  settings_profiles: Record<string, unknown>;
  probes: Entry[];
  cron_disable_attempts: (Entry & { attempt: string })[];
};
const entries: Entry[] = [...manifest.probes, ...manifest.cron_disable_attempts];

function lines(file: string): string[] {
  return readFileSync(join(DIR, file), "utf8").split("\n").filter((l) => l.length > 0);
}
function keysOf(o: unknown, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((v) => keysOf(v, out));
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

test("manifest line counts equal the committed files and raw = committed + dropped", () => {
  for (const e of entries) {
    const n = lines(e.fixture).length;
    assert.equal(e.stdout_lines_committed, n, `${e.fixture}: manifest says ${e.stdout_lines_committed} committed lines, file has ${n}`);
    const dropped = Object.values(e.dropped_by_type).reduce((a, b) => a + b, 0);
    assert.equal(e.stdout_lines_raw, n + dropped, `${e.fixture}: raw ${e.stdout_lines_raw} != committed ${n} + dropped ${dropped}`);
  }
});

test("every committed capture is indexed in the manifest and vice versa", () => {
  const indexed = new Set(entries.map((e) => e.fixture));
  indexed.add("09-cron-persisted-job.json");
  const onDisk = readdirSync(DIR).filter((f) => /^(\d\d.*|session-log.*)\.jsonl?$/.test(f));
  assert.deepEqual([...onDisk].sort(), [...indexed].sort());
});

test("captures are pure JSONL with the documented envelope and preserved field names", () => {
  for (const e of entries.filter((x) => x.fixture.endsWith(".jsonl"))) {
    for (const [i, l] of lines(e.fixture).entries()) {
      const o = JSON.parse(l) as Record<string, any>;
      const at = `${e.fixture}:${i + 1}`;
      for (const k of ["schema_version", "id", "stream", "sequence", "payload_type", "payload"]) assert.ok(k in o, `${at}: missing envelope key ${k}`);
      assert.equal(o.stream.kind, "session", at);
      assert.ok(!keysOf(o).some((k) => k.includes("<")), `${at}: a placeholder replaced a field name`);
      if (o.payload_type === "tool.result") {
        assert.equal(typeof o.payload.call_id, "string", `${at}: tool.result lost payload.call_id`);
        assert.equal(typeof o.payload.correlation_facts?.tool_name, "string", at);
        assert.match(o.payload.correlation_facts?.outcome, /^(success|failure)$/, at);
      }
    }
  }
});

test("tool results and tool intents share the same sanitized call id", () => {
  for (const e of entries.filter((x) => x.fixture.endsWith(".jsonl"))) {
    const objs = lines(e.fixture).map((l) => JSON.parse(l));
    const intents = new Set(objs.filter((o) => o.payload_type === "task.lifecycle.side_effect_intent").map((o) => o.payload.event?.idempotency_key));
    for (const o of objs.filter((x) => x.payload_type === "tool.result")) {
      // the read-only `work_status` tool emits a result without an intent (observed in 09-workflow-default)
      if (intents.size === 0 || o.payload.correlation_facts.tool_name === "work_status") continue;
      assert.ok(intents.has(`tool:${o.payload.call_id}`), `${e.fixture}: tool.result ${o.payload.call_id} has no matching side_effect_intent`);
    }
  }
});

test("no credentials, user data, machine paths, or malformed placeholders", () => {
  const forbidden: [string, RegExp][] = [
    ["absolute user path", /\/Users\/|\/home\/[a-z]|\/private\/|\/var\/folders/],
    ["raw scratch path", /\/tmp\/muse-spike/],
    ["uuid", /(?!0{8}-0{4}-0{4}-0{4}-0{12})[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
    ["provider call id", /call_[0-9a-f]{16,}|resp_[0-9a-f]{16,}/],
    ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/],
    ["token-looking", /\b(?:sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}/],
    ["operator identity", /not_so_fat|not-so-fat|yusuke|personal-dev/i],
    ["malformed placeholder", /<(?:WORKSPACE|HOME|CFG|DATA|PROBE_HOME|SPIKE_DIR)>[0-9A-Za-z](?![A-Za-z0-9_-]*\/)/],
  ];
  const files = [...entries.map((e) => e.fixture), "manifest.json", "README.md", ...readdirSync(join(DIR, "harness")).map((f) => `harness/${f}`)];
  for (const f of files) {
    const text = readFileSync(join(DIR, f), "utf8");
    for (const [what, rx] of forbidden) {
      // harness scripts legitimately mention $HOME and the scratch default; only scan them for secrets/identity
      if (f.startsWith("harness/") && !["token-looking", "operator identity", "uuid"].includes(what)) continue;
      assert.ok(!rx.test(text), `${f}: contains ${what}: ${rx.exec(text)?.[0]}`);
    }
  }
});

test("recorded commands are complete: no elisions, no trailing comments pretending to be actions", () => {
  for (const e of entries) {
    const cmds = e.commands ?? (e.command ? [e.command] : []);
    if (e.fixture === "session-log-usage-excerpt.jsonl") continue;
    assert.ok(cmds.length > 0, `${e.fixture}: no command recorded`);
    if (e.exact === false) assert.ok(e.exact_reason, `${e.fixture}: exact=false needs an exact_reason`);
    for (const c of cmds) {
      assert.ok(!/(^|\s)\.\.\.(\s|$|")/.test(c), `${e.fixture}: elided command: ${c}`);
      if (e.exact !== false) assert.ok(!/<prompt/.test(c), `${e.fixture}: placeholder prompt: ${c}`);
      assert.ok(!/#\s*then:/.test(c), `${e.fixture}: comment-only action: ${c}`);
      assert.ok(!/<muse pid>/.test(c), `${e.fixture}: unresolved pid placeholder: ${c}`);
    }
    if (e.harness) {
      const script = e.harness.split(" ")[1]!;
      assert.ok(existsSync(join(DIR, script)), `${e.fixture}: harness script ${script} missing`);
    }
  }
});

test("signal and cancellation entries record the executed kill and wait", () => {
  for (const e of manifest.probes.filter((p) => /^10-(sigterm|sigint|sigkill)/.test(p.fixture))) {
    const cmds = e.commands ?? [];
    assert.ok(cmds.some((c) => /^kill -(TERM|INT|KILL) -- -?\d*|^kill -(TERM|INT|KILL) --/.test(c)), `${e.fixture}: no executed kill command`);
    assert.ok(cmds.some((c) => c.startsWith("pgrep")), `${e.fixture}: no child-process check`);
    assert.ok(cmds.some((c) => c.startsWith("wait")), `${e.fixture}: no wait`);
  }
});

test("settings profiles referenced by entries exist", () => {
  for (const e of entries) {
    if (e.settings_profile == null) continue;
    assert.ok(e.settings_profile in manifest.settings_profiles, `${e.fixture}: unknown settings profile ${e.settings_profile}`);
  }
});

test("harness scripts are valid shell/python", () => {
  for (const s of ["lib.sh", "probe8-9.sh", "probe10.sh"]) execFileSync("bash", ["-n", join(DIR, "harness", s)]);
  for (const s of ["build-fixtures.py", "mock-provider.py"]) {
    execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", join(DIR, "harness", s)]);
  }
});
