// packages/server/src/adapters/base-conflict-probe.test.ts
//
// NOT-355: the pre-publish base-conflict probe against real git — two branches
// editing the same line of one file report `conflict` with that path; non-
// overlapping edits report `clean`; neither touches the working tree or any ref.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-probe-home-"));

const { probeBaseConflict } = await import("./git-worktree.js");

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(file: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-probe-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commitFile("shared.txt", "line one\nline two\nline three\n", "init");
  commitFile("other.txt", "other\n", "other");
});

after(() => fs.rmSync(repo, { recursive: true, force: true }));

/** Branch `name` off the init commits and give both it and a fresh `base-<name>` one edit each. */
function divergedPair(name: string, feature: [string, string], base: [string, string]): string {
  git(repo, "checkout", "-q", "-b", `base-${name}`, "main");
  commitFile(base[0], base[1], `base ${name}`);
  git(repo, "checkout", "-q", "-b", name, "main");
  commitFile(feature[0], feature[1], `feature ${name}`);
  return `base-${name}`;
}

test("NOT-355: the same line edited on both sides reports conflict with that path, and changes nothing", async () => {
  const baseRef = divergedPair(
    "same-line",
    ["shared.txt", "line one\nfeature edit\nline three\n"],
    ["shared.txt", "line one\nbase edit\nline three\n"]
  );
  const headBefore = git(repo, "rev-parse", "HEAD");
  const refsBefore = git(repo, "for-each-ref");

  const probe = await probeBaseConflict({ worktreePath: repo, baseRef });

  assert.deepEqual(probe, { state: "conflict", files: ["shared.txt"] });
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore, "HEAD unchanged");
  assert.equal(git(repo, "for-each-ref"), refsBefore, "no ref moved");
  assert.equal(git(repo, "status", "--porcelain"), "", "working tree untouched");
});

test("NOT-355: non-overlapping edits report clean", async () => {
  const baseRef = divergedPair(
    "disjoint",
    ["shared.txt", "line one\nline two\nfeature edit\n"],
    ["other.txt", "other, edited on base\n"]
  );
  const probe = await probeBaseConflict({ worktreePath: repo, baseRef });
  assert.deepEqual(probe, { state: "clean" });
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("NOT-355: a git without merge-tree --write-tree is skipped (fail open)", async () => {
  const calls: string[][] = [];
  const probe = await probeBaseConflict({
    worktreePath: repo,
    baseRef: "main",
    exec: async (args) => {
      calls.push(args);
      throw Object.assign(new Error("git merge-tree failed"), {
        code: 129,
        stdout: "",
        stderr: "error: unknown option `write-tree'\nusage: git merge-tree <base-tree> <branch1> <branch2>",
      });
    },
  });
  assert.equal(probe.state, "skipped");
  assert.match((probe as { reason: string }).reason, /not supported/);
  assert.deepEqual(calls, [["merge-tree", "--write-tree", "--name-only", "--no-messages", "main", "HEAD"]]);
});

test("NOT-355: any other merge-tree failure is skipped with its detail, never reported as conflict", async () => {
  const probe = await probeBaseConflict({ worktreePath: repo, baseRef: "no-such-ref" });
  assert.equal(probe.state, "skipped");
});
