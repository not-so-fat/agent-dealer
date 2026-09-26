// packages/cli/src/doctor.test.ts
//
// NOT-267: doctor reports which local login the experimental Cursor
// Individual adapter would use — desktop, Agent fallback, or none — using
// static lines only. Tests never touch the real local login: every case
// points the resolution at temporary fixtures.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
// Local mirror of the server module's env/key contract
// (packages/server/src/capacity/cursor-individual-credentials.ts). A static
// import is impossible — CLI `rootDir` cannot include server sources — so
// the mirror is pinned against the live server module by the contract test
// below: a rename there fails that test loudly instead of letting these
// fixtures silently stop applying (and probe the real local login).
const CURSOR_DESKTOP_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV = "CURSOR_INDIVIDUAL_CREDENTIAL_FILE";
const CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV = "CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE";
const CURSOR_INDIVIDUAL_HOME_ENV = "CURSOR_INDIVIDUAL_HOME";

test("fixture env/key names match the server module's live contract", async () => {
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "server", "src", "capacity", "cursor-individual-credentials.ts"),
    path.resolve(here, "..", "..", "server", "dist", "capacity", "cursor-individual-credentials.js"),
  ];
  let mod: Record<string, unknown> | null = null;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      break;
    } catch {
      continue;
    }
  }
  assert.ok(mod, "the server credentials module must be loadable for the contract pin");
  assert.equal(mod.CURSOR_DESKTOP_ACCESS_TOKEN_KEY, CURSOR_DESKTOP_ACCESS_TOKEN_KEY);
  assert.equal(mod.CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV, CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV);
  assert.equal(mod.CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV, CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV);
  assert.equal(mod.CURSOR_INDIVIDUAL_HOME_ENV, CURSOR_INDIVIDUAL_HOME_ENV);
});
import {
  CURSOR_INDIVIDUAL_LOGIN_LINES,
  checkCursorIndividualLogin,
  describeCursorIndividualLogin,
} from "./doctor.js";

const SECRET = "doctor-fixture-secret-must-never-print";
const USER_ID = "user_doctor_fixture";

function fixtureJwt(sub: string): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url({ sub })}.sig`;
}

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-doctor-indiv-"));
  for (const key of [
    CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV,
    CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV,
    CURSOR_INDIVIDUAL_HOME_ENV,
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("describe maps each credential state to its static line", () => {
  assert.deepEqual(describeCursorIndividualLogin({ present: true, source: "desktop" }), {
    kind: "desktop",
    line: CURSOR_INDIVIDUAL_LOGIN_LINES.desktop,
  });
  assert.deepEqual(describeCursorIndividualLogin({ present: true, source: "agent" }), {
    kind: "agent",
    line: CURSOR_INDIVIDUAL_LOGIN_LINES.agent,
  });
  const degraded: Array<{ present: boolean; source: "desktop" | "agent" | null } | null | undefined> = [
    { present: false, source: null },
    { present: false, source: "desktop" },
    { present: true, source: null },
    null,
    undefined,
  ];
  for (const state of degraded) {
    assert.deepEqual(describeCursorIndividualLogin(state), {
      kind: "none",
      line: CURSOR_INDIVIDUAL_LOGIN_LINES.none,
    });
  }
});

test("the three lines name the three states and carry no paths or secrets", () => {
  assert.match(CURSOR_INDIVIDUAL_LOGIN_LINES.desktop, /desktop login found/);
  assert.match(CURSOR_INDIVIDUAL_LOGIN_LINES.agent, /Agent login found/);
  assert.match(CURSOR_INDIVIDUAL_LOGIN_LINES.none, /no usable local login/);
  for (const line of Object.values(CURSOR_INDIVIDUAL_LOGIN_LINES)) {
    assert.ok(!line.includes("/"), "no filesystem paths in doctor output");
    assert.ok(!line.includes(SECRET));
  }
});

function fixtureDesktopDb(token: string): string {
  const file = path.join(dir, "state.vscdb");
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      CURSOR_DESKTOP_ACCESS_TOKEN_KEY,
      token
    );
  } finally {
    db.close();
  }
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = file;
  return file;
}

test("check reports desktop login found for a fixture state.vscdb", async () => {
  process.env[CURSOR_INDIVIDUAL_HOME_ENV] = dir;
  const jwt = fixtureJwt(USER_ID);
  const dbFile = fixtureDesktopDb(jwt);
  const report = await checkCursorIndividualLogin();
  assert.equal(report.kind, "desktop");
  assert.equal(report.line, CURSOR_INDIVIDUAL_LOGIN_LINES.desktop);
  assert.ok(!report.line.includes(jwt), "token material must not print");
  assert.ok(!report.line.includes(dbFile), "database paths must not print");
});

test("check reports Agent login found when only the Agent auth file answers", async () => {
  process.env[CURSOR_INDIVIDUAL_HOME_ENV] = dir;
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = path.join(dir, "missing.vscdb");
  const agentFile = path.join(dir, ".cursor", "auth.json");
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.writeFileSync(agentFile, JSON.stringify({ token: SECRET, userId: USER_ID }));
  const report = await checkCursorIndividualLogin();
  assert.equal(report.kind, "agent");
  assert.equal(report.line, CURSOR_INDIVIDUAL_LOGIN_LINES.agent);
  assert.ok(!report.line.includes(SECRET), "token material must not print");
  assert.ok(!report.line.includes(agentFile), "credential paths must not print");
});

test("check reports no usable local login when neither source answers", async () => {
  process.env[CURSOR_INDIVIDUAL_HOME_ENV] = dir;
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = path.join(dir, "missing.vscdb");
  const report = await checkCursorIndividualLogin();
  assert.equal(report.kind, "none");
  assert.equal(report.line, CURSOR_INDIVIDUAL_LOGIN_LINES.none);
});
