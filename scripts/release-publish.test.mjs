import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  baseRefExists,
  changelogSection,
  checkConsistency,
  decidePublish,
  isTagOnBase,
  parseTagVersion,
} from "./release-publish.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "scripts/release-publish.mjs");
const CHANGELOG = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const ROOT_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const runCli = (args, env = {}) =>
  spawnSync("node", [SCRIPT, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });

// --- tag parsing ---

test("parseTagVersion accepts vX.Y.Z only", () => {
  assert.equal(parseTagVersion("v1.4.4"), "1.4.4");
  assert.equal(parseTagVersion("1.4.4"), null);
  assert.equal(parseTagVersion("v1.4"), null);
  assert.equal(parseTagVersion("v1.4.4-beta"), null);
  assert.equal(parseTagVersion(""), null);
});

// --- CHANGELOG section ---

test("changelogSection finds the shipped 1.4.4 section", () => {
  const section = changelogSection(CHANGELOG, "1.4.4");
  assert.ok(section, "expected a 1.4.4 section");
  assert.match(section, /## 1\.4\.4/);
});

test("changelogSection returns null for a missing version", () => {
  assert.equal(changelogSection(CHANGELOG, "9.9.9"), null);
});

// --- guard: consistency ---

test("guard passes for a consistent release", () => {
  const { version, problems } = checkConsistency({
    tag: `v${ROOT_VERSION}`,
    rootVersion: ROOT_VERSION,
    changelogText: CHANGELOG,
  });
  assert.equal(version, ROOT_VERSION);
  assert.deepEqual(problems, []);
});

test("guard fails for a tag that does not match the root version", () => {
  const { problems } = checkConsistency({ tag: "v9.9.9", rootVersion: ROOT_VERSION, changelogText: CHANGELOG });
  assert.match(problems.join("\n"), /does not match root package\.json/);
});

test("guard fails for a missing CHANGELOG section", () => {
  const stripped = CHANGELOG.replace(`## ${ROOT_VERSION} `, "## 0.0.0-removed ");
  const { problems } = checkConsistency({ tag: `v${ROOT_VERSION}`, rootVersion: ROOT_VERSION, changelogText: stripped });
  assert.match(problems.join("\n"), /no section for/);
});

test("guard fails for a malformed tag", () => {
  const { problems } = checkConsistency({ tag: "1.4.4", rootVersion: ROOT_VERSION, changelogText: CHANGELOG });
  assert.match(problems.join("\n"), /not vX\.Y\.Z/);
});

// --- guard: on-main check (injected git) ---

test("isTagOnBase reports the merge-base answer", () => {
  assert.equal(isTagOnBase("v1.4.4", "origin/main", () => ({ status: 0 })), true);
  assert.equal(isTagOnBase("v9.9.9", "origin/main", () => ({ status: 1 })), false);
});

test("baseRefExists reports the rev-parse answer", () => {
  assert.equal(baseRefExists("origin/main", () => ({ status: 0 })), true);
  assert.equal(baseRefExists("origin/main", () => ({ status: 1 })), false);
});

test("guard CLI fails for a tag that does not match the root version", () => {
  const r = runCli(["guard", "v9.9.9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match root package\.json/);
});

// --- registry decision: pure function ---

test("version already published -> skip", () => {
  assert.equal(decidePublish({ status: 0, stdout: '"1.4.4"\n', stderr: "" }, "1.4.4"), "skip");
});

test("registry 404 -> publish", () => {
  const e404 = { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 'agent-dealer@9.9.9' is not in this registry." };
  assert.equal(decidePublish(e404, "9.9.9"), "publish");
});

test("any other registry error -> fail closed (throws, no publish)", () => {
  assert.throws(() => decidePublish({ status: 1, stdout: "", stderr: "npm error code ENEEDAUTH" }, "1.4.4"), /failed closed/);
  assert.throws(() => decidePublish({ status: 1, stdout: "", stderr: "npm error code ECONNREFUSED" }, "1.4.4"), /failed closed/);
  assert.throws(() => decidePublish({ status: 0, stdout: '"9.9.9"\n', stderr: "" }, "1.4.4"), /did not show/);
  assert.throws(() => decidePublish({ status: 1, stdout: "", stderr: "", error: new Error("spawn ENOENT") }, "1.4.4"), /failed/);
});

// --- registry decision: CLI with a stub npm (offline dry run) ---

function stubNpm(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stub-npm-"));
  const file = path.join(dir, "npm");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

test("should-publish CLI reports skip when the stub registry has the version", () => {
  const stub = stubNpm('echo \'"1.4.4"\'');
  try {
    const r = runCli(["should-publish", "agent-dealer", "1.4.4"], { NPM_BIN: stub.file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "skip");
  } finally {
    fs.rmSync(stub.dir, { recursive: true });
  }
});

test("should-publish CLI reports publish on a stub registry 404", () => {
  const stub = stubNpm('echo "npm error code E404" >&2; echo "npm error 404 not in this registry." >&2; exit 1');
  try {
    const r = runCli(["should-publish", "agent-dealer", "9.9.9"], { NPM_BIN: stub.file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "publish");
  } finally {
    fs.rmSync(stub.dir, { recursive: true });
  }
});

test("should-publish CLI fails closed on a stub registry error", () => {
  const stub = stubNpm('echo "npm error code ECONNREFUSED" >&2; exit 1');
  try {
    const r = runCli(["should-publish", "agent-dealer", "1.4.4"], { NPM_BIN: stub.file });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /failed closed/);
  } finally {
    fs.rmSync(stub.dir, { recursive: true });
  }
});

// --- notes ---

test("notes CLI prints the CHANGELOG section for the version", () => {
  const r = runCli(["notes", "1.4.4"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## 1\.4\.4/);
});

test("notes CLI fails for a missing CHANGELOG section", () => {
  const r = runCli(["notes", "9.9.9"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no section for/);
});
