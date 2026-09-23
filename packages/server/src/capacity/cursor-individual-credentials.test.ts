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
import {
  CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV,
  CURSOR_INDIVIDUAL_HOME_ENV,
  cursorIndividualAuthHeader,
  cursorIndividualCredentialCandidates,
  cursorIndividualCredentialStatus,
  decodeJwtSubject,
  loadCursorIndividualCredential,
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cursor-indiv-creds-"));
  savedFileEnv = process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  savedHomeEnv = process.env[CURSOR_INDIVIDUAL_HOME_ENV];
});

afterEach(() => {
  if (savedFileEnv === undefined) delete process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV];
  else process.env[CURSOR_INDIVIDUAL_CREDENTIAL_FILE_ENV] = savedFileEnv;
  if (savedHomeEnv === undefined) delete process.env[CURSOR_INDIVIDUAL_HOME_ENV];
  else process.env[CURSOR_INDIVIDUAL_HOME_ENV] = savedHomeEnv;
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
  assert.deepEqual(status, { present: false, path: null, format: null });
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
