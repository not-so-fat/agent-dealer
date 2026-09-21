#!/usr/bin/env tsx
/**
 * NOT-181 opt-in local smoke: one real `muse exec` developer session through the coordinator's own
 * Muse spawn (per-attempt config under the worktree, session-log usage, cleanup), on a harmless
 * non-sensitive task in a throwaway git repository. No Dealer database, no Agent Deck, no GitHub.
 *
 * STARTS A PAID MODEL SESSION and sends the prompt below to Meta's contributor tier (content may be
 * used for product improvement). CI never runs this; it refuses to run without MUSE_SMOKE=1.
 *
 *   MUSE_SMOKE=1 npm run smoke:muse
 *
 * Needs `muse` installed and logged in (`muse login` or META_API_KEY); MUSE_CLI overrides the binary.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MUSE_CODE_CONTRIBUTOR_MODEL } from "@agent-dealer/shared";
import { MUSE_ATTEMPT_ROOT, runMuseDeveloperSession } from "../packages/server/src/coordinator/muse-spawn.js";

if (process.env.MUSE_SMOKE !== "1") {
  console.error("Refusing to run: this starts a paid Muse Code session. Re-run with MUSE_SMOKE=1 npm run smoke:muse");
  process.exit(2);
}

const PROMPT = [
  "Implement this issue on a fresh branch off main.",
  "",
  "## Task",
  "Add a greeting file",
  "Create hello.txt in the repository root containing exactly the line: hello from muse",
  "",
  "## Acceptance criteria",
  "- hello.txt exists and contains exactly that one line.",
  "",
  "This session has no Agent Deck and no MCP servers. Never call `cron_create`, `cron_list` or `cron_delete`.",
  "Commit your change with git — do NOT push and do NOT open a pull request. End with a one-line conclusion.",
].join("\n");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-smoke-"));
const worktree = path.join(root, "worktree");
fs.mkdirSync(worktree);
git(worktree, "init", "-q", "-b", "main");
git(worktree, "config", "user.email", "smoke@example.com");
git(worktree, "config", "user.name", "Muse smoke");
fs.writeFileSync(path.join(worktree, "README.md"), "smoke\n");
git(worktree, "add", ".");
git(worktree, "commit", "-q", "-m", "init");

const checks: Array<[string, boolean]> = [];
const started = Date.now();
const result = await runMuseDeveloperSession({
  sessionId: "muse-smoke",
  runtime: "muse_code",
  policy: { worktreeWrite: true } as never,
  model: MUSE_CODE_CONTRIBUTOR_MODEL,
  prompt: PROMPT,
  cwd: worktree,
  timeoutMs: Number(process.env.MUSE_SMOKE_TIMEOUT_MS ?? 5 * 60_000),
  logPath: path.join(root, "session.ndjson"),
});
const muse = result.muse!;

const hello = path.join(worktree, "hello.txt");
checks.push(["exit code 0, no failure", result.exitCode === 0 && muse.failure === null]);
checks.push([`server confirmed ${MUSE_CODE_CONTRIBUTOR_MODEL}`, muse.confirmedModel === MUSE_CODE_CONTRIBUTOR_MODEL]);
checks.push(["no cron_* tool call", muse.cronCalls.length === 0]);
checks.push(["hello.txt committed", fs.existsSync(hello) && git(worktree, "ls-files", "hello.txt") === "hello.txt"]);
checks.push(["worktree clean", git(worktree, "status", "--porcelain") === ""]);
checks.push(["per-attempt config removed", !fs.existsSync(path.join(worktree, MUSE_ATTEMPT_ROOT))]);

console.log(`wall ${((Date.now() - started) / 1000).toFixed(1)}s  model ${muse.confirmedModel ?? "unconfirmed"}`);
console.log(`usage ${JSON.stringify(muse.usage)}  (null = Muse did not report it)`);
if (muse.failure) console.log(`failure ${muse.failure.kind}: ${muse.failure.message}`);
console.log(`log ${result.logPath}  raw ${muse.rawLogPath ?? "-"}`);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);

const ok = checks.every(([, pass]) => pass);
if (ok) fs.rmSync(worktree, { recursive: true, force: true });
console.log(ok ? "smoke OK" : `smoke FAILED — kept ${root} for inspection`);
process.exit(ok ? 0 : 1);
