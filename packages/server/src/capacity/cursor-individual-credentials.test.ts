// packages/server/src/capacity/cursor-individual-credentials.test.ts
//
// NOT-250: credential lookup is isolated behind an adapter, returns no
// secret on diagnostics surfaces, and degrades on absent/changed formats.
// Every case uses temporary fixture files (or an injected reader) — CI
// never touches the real local Cursor login.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  CURSOR_DESKTOP_ACCESS_TOKEN_KEY,
  CURSOR_DESKTOP_FORMAT,
  CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV,
  CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV,
  CURSOR_INDIVIDUAL_HOME_ENV,
  cursorIndividualAuthHeader,
  cursorIndividualCredentialCandidates,
  cursorIndividualCredentialStatus,
  cursorIndividualDesktopStateCandidates,
  decodeJwtSubject,
  defaultReadDesktopAccessToken,
  desktopTokenToAuthHeader,
  loadCursorIndividualCredential,
  normalizeDesktopTokenValue,
  normalizeWorkosUserId,
} from "./cursor-individual-credentials.js";

const SECRET = "fixture-secret-token-abc123";
const USER_ID = "user_fixture_abc123";

/** header.payload.signature with { sub: USER_ID } — no signature verification, so any value works. */
function fixtureJwt(sub: string): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url({ sub })}.sig`;
}

let dir: string;
let savedFileEnv: string | undefined;
let savedHomeEnv: string | undefined;
let savedDesktopEnv: string | undefined;
let savedAppData: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-indiv-creds-"));
  savedFileEnv = process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  savedHomeEnv = process.env[CURSOR_INDIVIDUAL_HOME_ENV];
  savedDesktopEnv = process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV];
  savedAppData = process.env.APPDATA;
});

afterEach(() => {
  if (savedFileEnv === undefined) delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  else process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = savedFileEnv;
  if (savedHomeEnv === undefined) delete process.env[CURSOR_INDIVIDUAL_HOME_ENV];
  else process.env[CURSOR_INDIVIDUAL_HOME_ENV] = savedHomeEnv;
  if (savedDesktopEnv === undefined) delete process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV];
  else process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = savedDesktopEnv;
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = file;
  return file;
}

test("absent credential file reads absent with no path", () => {
  process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = path.join(dir, "does-not-exist.json");
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "absent");
  assert.equal(credential.path, null);
  assert.equal(credential.format, null);
  assert.equal(credential.authHeader, undefined);
  const status = cursorIndividualCredentialStatus();
  assert.deepEqual(status, { present: false, source: null, path: null, format: null });
});

test("empty home directory reads absent (no real login touched)", () => {
  delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  process.env[CURSOR_INDIVIDUAL_HOME_ENV] = dir;
  assert.deepEqual(cursorIndividualCredentialCandidates(), [
    path.join(dir, ".cursor", "auth.json"),
  ]);
  assert.equal(loadCursorIndividualCredential().status, "absent");
  assert.equal(cursorIndividualCredentialStatus().present, false);
});

test("accepted token shapes load with an in-memory auth header", () => {
  const cases: Array<{ body: unknown; format: string }> = [
    { body: { token: SECRET, userId: USER_ID }, format: "token" },
    { body: { accessToken: SECRET, userId: USER_ID }, format: "accessToken" },
    { body: { access_token: SECRET, user_id: USER_ID }, format: "access_token" },
    { body: { sessionToken: SECRET, userId: USER_ID }, format: "sessionToken" },
    { body: { apiKey: SECRET, userId: USER_ID }, format: "apiKey" },
    { body: { auth: { accessToken: SECRET }, userId: USER_ID }, format: "auth.accessToken" },
  ];
  for (const { body, format } of cases) {
    const file = fixture("auth.json", JSON.stringify(body));
    const credential = loadCursorIndividualCredential();
    assert.equal(credential.status, "found");
    assert.equal(credential.source, "agent");
    assert.equal(credential.path, file);
    assert.equal(credential.format, format);
    assert.equal(credential.authHeader, cursorIndividualAuthHeader(USER_ID, SECRET));
    assert.ok(credential.authHeader!.includes(SECRET), "header carries the token in memory only");
  }
});

test("a user id is derived from the token's own JWT `sub` claim when no explicit field is present", () => {
  const jwt = fixtureJwt(USER_ID);
  assert.equal(decodeJwtSubject(jwt), USER_ID);
  fixture("auth.json", JSON.stringify({ token: jwt }));
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "found");
  assert.equal(credential.authHeader, cursorIndividualAuthHeader(USER_ID, jwt));
});

test("an explicit user-id field wins over the token's own JWT `sub` claim", () => {
  const jwt = fixtureJwt("jwt-subject-should-lose");
  fixture("auth.json", JSON.stringify({ token: jwt, userId: USER_ID }));
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.authHeader, cursorIndividualAuthHeader(USER_ID, jwt));
});

test("a token with no derivable user id reads unparsable — never a Bearer-only guess", () => {
  fixture("auth.json", JSON.stringify({ token: SECRET }));
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "unparsable");
  assert.equal(credential.authHeader, undefined);
});

test("the auth header is the WorkosCursorSessionToken cookie with the :: delimiter percent-encoded", () => {
  const header = cursorIndividualAuthHeader(USER_ID, SECRET);
  assert.equal(header, `WorkosCursorSessionToken=${USER_ID}%3A%3A${SECRET}`);
  // Never the raw, unencoded delimiter the dashboard rejects.
  assert.ok(!header.includes(`${USER_ID}::${SECRET}`));
});

test("normalizeWorkosUserId strips a provider connection-type prefix", () => {
  assert.equal(normalizeWorkosUserId("google-oauth2|user_abc"), "user_abc");
  assert.equal(normalizeWorkosUserId("github|12345"), "12345");
  // A bare id (no prefix) passes through unchanged.
  assert.equal(normalizeWorkosUserId(USER_ID), USER_ID);
  // Only the LAST `|` matters, in case a value itself contains one.
  assert.equal(normalizeWorkosUserId("a|b|c"), "c");
});

test("a provider-prefixed JWT subject is normalized before it reaches the cookie", () => {
  const jwt = fixtureJwt("google-oauth2|user_fixture");
  fixture("auth.json", JSON.stringify({ token: jwt }));
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "found");
  // The cookie carries the bare id, never the provider-qualified subject.
  assert.equal(credential.authHeader, cursorIndividualAuthHeader("user_fixture", jwt));
  assert.ok(!credential.authHeader!.includes("google-oauth2"));
});

test("a provider-prefixed explicit userId field is normalized the same way", () => {
  fixture("auth.json", JSON.stringify({ token: SECRET, userId: "github|user_fixture" }));
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.authHeader, cursorIndividualAuthHeader("user_fixture", SECRET));
});

test("an id that normalizes to empty (nothing after the final |) reads unparsable, never an empty-id cookie", () => {
  // Non-empty before normalization (passes the raw presence check), but
  // normalizeWorkosUserId("github|") === "" — must still degrade, not build
  // WorkosCursorSessionToken=%3A%3A<token>.
  assert.equal(normalizeWorkosUserId("github|"), "");
  // Explicit-field path.
  fixture("auth.json", JSON.stringify({ token: SECRET, userId: "github|" }));
  const fromField = loadCursorIndividualCredential();
  assert.equal(fromField.status, "unparsable");
  assert.equal(fromField.authHeader, undefined);
  // JWT-`sub`-derived path.
  const jwt = fixtureJwt("github|");
  fixture("auth.json", JSON.stringify({ token: jwt }));
  const fromJwt = loadCursorIndividualCredential();
  assert.equal(fromJwt.status, "unparsable");
  assert.equal(fromJwt.authHeader, undefined);
});

test("changed credential formats read unparsable, never a guess", () => {
  const changed: unknown[] = [
    { totallyNewShape: true, session: { id: "abc" } },
    { token: "" },
    { token: "   " },
    { token: 12345 },
    { accessToken: null },
    ["token-array"],
    "just-a-string",
    42,
    null,
  ];
  for (const body of changed) {
    fixture("auth.json", JSON.stringify(body));
    const credential = loadCursorIndividualCredential();
    assert.equal(credential.status, "unparsable", `body ${JSON.stringify(body)} must not parse`);
    assert.equal(credential.authHeader, undefined);
  }
  fixture("auth.json", "{ not valid json{{{");
  assert.equal(loadCursorIndividualCredential().status, "unparsable");
});

test("diagnostics status never carries secret material", () => {
  fixture("auth.json", JSON.stringify({ token: SECRET, userId: USER_ID }));
  const status = cursorIndividualCredentialStatus();
  assert.equal(status.present, true);
  assert.equal(status.format, "token");
  assert.ok(!JSON.stringify(status).includes(SECRET), "raw token must not appear in status output");
});

test("unreadable files degrade to absent without throwing", () => {
  // The default reader swallows read errors (missing file, directory at the
  // candidate path, permissions): none of them throw out of the loader.
  process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = dir;
  assert.equal(loadCursorIndividualCredential().status, "absent");
  process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = path.join(dir, "missing.json");
  assert.equal(loadCursorIndividualCredential().status, "absent");
  const dirAsFile = loadCursorIndividualCredential((_p) => null);
  assert.equal(dirAsFile.status, "absent");
});

// ---------------------------------------------------------------------------
// NOT-267: desktop state.vscdb as the primary credential source.
// ---------------------------------------------------------------------------

/** Build a fixture desktop-state database with exactly the given keys. */
function fixtureStateDb(entries: Record<string, string>, name = "state.vscdb"): string {
  const file = path.join(dir, name);
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const stmt = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(entries)) stmt.run(key, value);
  } finally {
    db.close();
  }
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = file;
  return file;
}

/** Desktop tests use the real resolution order: no pinned credential file. */
function useDefaultSources(): void {
  delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  process.env[CURSOR_INDIVIDUAL_HOME_ENV] = dir;
}

test("desktop state paths resolve per OS without touching the real login", () => {
  const home = path.join(dir, "fake-home");
  assert.deepEqual(cursorIndividualDesktopStateCandidates({ platform: "darwin", home }), [
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
  ]);
  assert.deepEqual(cursorIndividualDesktopStateCandidates({ platform: "linux", home }), [
    path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ]);
  const appData = path.join(dir, "fake-appdata");
  assert.deepEqual(
    cursorIndividualDesktopStateCandidates({ platform: "win32", home, appData }),
    [path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")]
  );
  // Unknown platforms fall back to the Linux-style layout, never to nothing.
  assert.deepEqual(cursorIndividualDesktopStateCandidates({ platform: "freebsd", home }), [
    path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ]);
  // The explicit override wins on every platform.
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = path.join(dir, "custom.vscdb");
  assert.deepEqual(cursorIndividualDesktopStateCandidates({ platform: "darwin", home }), [
    path.join(dir, "custom.vscdb"),
  ]);
});

test("a fixture state.vscdb access token resolves to a desktop credential", () => {
  useDefaultSources();
  const jwt = fixtureJwt(USER_ID);
  // Unrelated state travels alongside the token — including secret-looking
  // values the loader must never select, return, or report.
  const dbFile = fixtureStateDb({
    [CURSOR_DESKTOP_ACCESS_TOKEN_KEY]: jwt,
    "cursorAuth/refreshToken": "fixture-refresh-must-never-leak",
    "cursorAuth/cachedEmail": "someone@example.com",
    "someOtherFeature/state": JSON.stringify({ token: "not-a-cursor-token" }),
  });
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "found");
  assert.equal(credential.source, "desktop");
  assert.equal(credential.path, dbFile);
  assert.equal(credential.format, CURSOR_DESKTOP_FORMAT);
  assert.equal(credential.authHeader, cursorIndividualAuthHeader(USER_ID, jwt));
  const status = cursorIndividualCredentialStatus();
  assert.deepEqual(status, {
    present: true,
    source: "desktop",
    path: dbFile,
    format: CURSOR_DESKTOP_FORMAT,
  });
  const serialized = JSON.stringify({ credential: { ...credential, authHeader: undefined }, status });
  assert.ok(!serialized.includes(jwt), "raw token must not appear outside the in-memory header");
  assert.ok(
    !serialized.includes("fixture-refresh-must-never-leak"),
    "unrelated desktop keys must never be read"
  );
});

test("desktop SQLite wins over Agent auth.json; Agent auth remains the fallback", () => {
  useDefaultSources();
  const desktopJwt = fixtureJwt("desktop-user-wins");
  const agentJwt = fixtureJwt("agent-user-fallback");
  fixtureStateDb({ [CURSOR_DESKTOP_ACCESS_TOKEN_KEY]: desktopJwt });
  const agentFile = path.join(dir, ".cursor", "auth.json");
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.writeFileSync(agentFile, JSON.stringify({ token: agentJwt }));
  // Both sources usable: the desktop login wins.
  let credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "found");
  assert.equal(credential.source, "desktop");
  assert.equal(credential.authHeader, cursorIndividualAuthHeader("desktop-user-wins", desktopJwt));
  // Desktop database gone: the same Agent file now answers as the fallback.
  fs.rmSync(path.join(dir, "state.vscdb"));
  delete process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV];
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = path.join(dir, "missing.vscdb");
  credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "found");
  assert.equal(credential.source, "agent");
  assert.equal(credential.authHeader, cursorIndividualAuthHeader("agent-user-fallback", agentJwt));
});

test("a usable Agent credential still wins over a present-but-unusable desktop token", () => {
  useDefaultSources();
  // Desktop token with no derivable user id (not a JWT): unusable on its
  // own, but it must not sink a working Agent fallback.
  fixtureStateDb({ [CURSOR_DESKTOP_ACCESS_TOKEN_KEY]: "not-a-jwt" });
  const agentFile = path.join(dir, ".cursor", "auth.json");
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.writeFileSync(agentFile, JSON.stringify({ token: SECRET, userId: USER_ID }));
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "found");
  assert.equal(credential.source, "agent");
});

test("no usable source in either login reads absent (desktop missing, Agent missing)", () => {
  useDefaultSources();
  process.env[CURSOR_INDIVIDUAL_DESKTOP_STATE_FILE_ENV] = path.join(dir, "missing.vscdb");
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "absent");
  assert.equal(credential.source, null);
  assert.equal(credential.authHeader, undefined);
});

test("a present-but-unusable desktop login reads unparsable when Agent auth cannot help", () => {
  useDefaultSources();
  const dbFile = fixtureStateDb({ [CURSOR_DESKTOP_ACCESS_TOKEN_KEY]: "not-a-jwt" });
  const credential = loadCursorIndividualCredential();
  assert.equal(credential.status, "unparsable");
  assert.equal(credential.path, dbFile);
  assert.equal(credential.format, CURSOR_DESKTOP_FORMAT);
  assert.equal(credential.authHeader, undefined);
});

test("the desktop reader opens read-only, reads one key, and never throws", () => {
  const jwt = fixtureJwt(USER_ID);
  const dbFile = fixtureStateDb({ [CURSOR_DESKTOP_ACCESS_TOKEN_KEY]: jwt });
  assert.equal(defaultReadDesktopAccessToken(dbFile), jwt);
  // Missing database, directory path, and missing key all read null.
  assert.equal(defaultReadDesktopAccessToken(path.join(dir, "missing.vscdb")), null);
  assert.equal(defaultReadDesktopAccessToken(dir), null);
  const noKey = fixtureStateDb({ "something/else": "x" }, "nokey.vscdb");
  assert.equal(defaultReadDesktopAccessToken(noKey), null);
  // The fixture database is untouched and unlocked after the read.
  const db = new Database(noKey);
  try {
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM ItemTable").get() as { n: number }).n,
      1
    );
  } finally {
    db.close();
  }
});

test("normalizeDesktopTokenValue unwraps a JSON-quoted token; empties and non-strings read null", () => {
  const jwt = fixtureJwt(USER_ID);
  assert.equal(normalizeDesktopTokenValue(jwt), jwt);
  assert.equal(normalizeDesktopTokenValue(`  ${jwt}  `), jwt);
  assert.equal(normalizeDesktopTokenValue(JSON.stringify(jwt)), jwt);
  assert.equal(normalizeDesktopTokenValue(""), null);
  assert.equal(normalizeDesktopTokenValue("   "), null);
  assert.equal(normalizeDesktopTokenValue(42), null);
  assert.equal(normalizeDesktopTokenValue(null), null);
  assert.equal(normalizeDesktopTokenValue('"not-closed'), null);
  // A non-empty unquoted value passes through here — usability (JWT `sub`)
  // is decided downstream by desktopTokenToAuthHeader, never by guessing.
  assert.equal(normalizeDesktopTokenValue("null"), "null");
  assert.equal(desktopTokenToAuthHeader("null"), null);
});

test("desktopTokenToAuthHeader derives the WorkOS id from the JWT sub", () => {
  const jwt = fixtureJwt(USER_ID);
  assert.equal(desktopTokenToAuthHeader(jwt), cursorIndividualAuthHeader(USER_ID, jwt));
  assert.equal(
    desktopTokenToAuthHeader(fixtureJwt("google-oauth2|user_fixture")),
    cursorIndividualAuthHeader("user_fixture", fixtureJwt("google-oauth2|user_fixture"))
  );
  assert.equal(desktopTokenToAuthHeader("not-a-jwt"), null);
  assert.equal(desktopTokenToAuthHeader(""), null);
});
