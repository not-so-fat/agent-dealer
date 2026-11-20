#!/usr/bin/env node
/**
 * Helpers for .github/workflows/release.yml — npm trusted publishing (OIDC, no token).
 *
 *   node scripts/release-publish.mjs guard <tag> [--base origin/main]
 *   node scripts/release-publish.mjs should-publish <name> <version>
 *   node scripts/release-publish.mjs wait-published <name> <version> [--timeout-ms N] [--interval-ms N]
 *   node scripts/release-publish.mjs notes <version> [--out FILE]
 *
 * `guard` fails before publishing when the tag is not vX.Y.Z matching the root
 * package.json version, the tagged commit is not on the base ref, or CHANGELOG.md
 * has no section for the version. It uses the repo's existing refs (the workflow
 * checks out with fetch-depth 0, so origin/main is current); it never fetches.
 *
 * `should-publish` prints "skip" when name@version is already on the registry,
 * "publish" on a registry 404, and fails closed on any other registry outcome.
 * The npm executable is `$NPM_BIN` when set, else `npm`, so tests can stub the
 * registry offline with a fake npm on PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM_BIN = process.env.NPM_BIN || "npm";

const die = (msg) => {
  console.error(`[release-publish] ${msg}`);
  process.exit(1);
};

/** "v1.2.3" -> "1.2.3"; anything else -> null. */
export function parseTagVersion(tag) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec((tag ?? "").trim());
  return m ? m[1] : null;
}

/** Extract the "## <version> ..." CHANGELOG section, or null when missing. */
export function changelogSection(text, version) {
  const start = text.indexOf(`## ${version} `);
  if (start < 0) return null;
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next).trim();
}

/**
 * Pure consistency checks: tag shape, tag == root version, CHANGELOG section.
 * Returns { version, problems }; empty problems means consistent.
 */
export function checkConsistency({ tag, rootVersion, changelogText }) {
  const problems = [];
  const version = parseTagVersion(tag);
  if (!version) {
    problems.push(`tag "${tag}" is not vX.Y.Z`);
  } else {
    if (version !== rootVersion) problems.push(`tag v${version} does not match root package.json version ${rootVersion}`);
    if (!changelogSection(changelogText, version)) problems.push(`CHANGELOG.md has no section for ${version}`);
  }
  return { version, problems };
}

const defaultSpawn = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8" });

/** True when `tag` is an ancestor of `base` (default origin/main). */
export function isTagOnBase(tag, base = "origin/main", spawn = defaultSpawn) {
  return spawn("git", ["merge-base", "--is-ancestor", tag, base]).status === 0;
}

export function baseRefExists(base = "origin/main", spawn = defaultSpawn) {
  return spawn("git", ["rev-parse", "--verify", "--quiet", base]).status === 0;
}

/** Run `npm view name@version version`; injectable runner keeps this offline-testable. */
export function runNpmView(npmBin, name, version, spawn = defaultSpawn) {
  const r = spawn(npmBin, ["view", `${name}@${version}`, "version", "--json"]);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

/**
 * "skip" when the registry already has the version, "publish" on registry 404.
 * Throws (fail closed, no publish) on anything else, including spawn errors and
 * a 0-exit whose output does not name the version.
 */
export function decidePublish(view, version) {
  if (view.error) throw new Error(`registry check failed: ${view.error.message ?? view.error}`);
  if (view.status === 0) {
    if (view.stdout.includes(version)) return "skip";
    throw new Error(`registry answered 0 but did not show ${version}:\n${view.stdout}${view.stderr}`);
  }
  const blob = `${view.stdout}\n${view.stderr}`;
  if (/E404|404 Not Found|is not in (this|the) registry/i.test(blob)) return "publish";
  throw new Error(`registry check failed closed (no publish):\n${blob.trim()}`);
}

function cmdGuard(tag, base) {
  if (!tag) die("usage: release-publish.mjs guard <tag> [--base <ref>]");
  const rootVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const changelogText = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const { version, problems } = checkConsistency({ tag, rootVersion, changelogText });
  if (!baseRefExists(base)) die(`base ref "${base}" is missing; fetch it first (workflow checks out with fetch-depth 0)`);
  if (!isTagOnBase(tag, base)) problems.push(`tag ${tag} is not on ${base}`);
  if (problems.length) die(`pre-publish guard failed:\n  ${problems.join("\n  ")}`);
  console.log(`[release-publish] guard ok: ${tag} == ${rootVersion}, on ${base}, CHANGELOG section present (v${version})`);
}

function cmdShouldPublish(name, version) {
  if (!name || !version) die("usage: release-publish.mjs should-publish <name> <version>");
  let decision;
  try {
    decision = decidePublish(runNpmView(NPM_BIN, name, version), version);
  } catch (err) {
    die(err.message);
  }
  console.log(decision);
}

async function cmdWaitPublished(name, version, timeoutMs, intervalMs) {
  if (!name || !version) die("usage: release-publish.mjs wait-published <name> <version>");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let view;
    try {
      view = runNpmView(NPM_BIN, name, version);
    } catch (err) {
      die(`registry check failed: ${err.message}`);
    }
    if (view.status === 0 && view.stdout.includes(version)) {
      console.log(`[release-publish] ${name}@${version} is on npm`);
      return;
    }
    if (Date.now() >= deadline) die(`${name}@${version} not on npm after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function cmdNotes(version, outFile) {
  if (!version) die("usage: release-publish.mjs notes <version> [--out FILE]");
  const text = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const section = changelogSection(text, version);
  if (!section) die(`CHANGELOG.md has no section for ${version}`);
  if (outFile) fs.writeFileSync(outFile, `${section}\n`);
  else console.log(section);
}

const flag = (argv, name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith("--"));
  if (cmd === "guard") cmdGuard(positional[0], flag(rest, "--base", "origin/main"));
  else if (cmd === "should-publish") cmdShouldPublish(positional[0], positional[1]);
  else if (cmd === "wait-published") {
    await cmdWaitPublished(
      positional[0],
      positional[1],
      Number(flag(rest, "--timeout-ms", "600000")),
      Number(flag(rest, "--interval-ms", "15000")),
    );
  } else if (cmd === "notes") cmdNotes(positional[0], flag(rest, "--out", undefined));
  else die("usage: release-publish.mjs guard|should-publish|wait-published|notes ...");
}
