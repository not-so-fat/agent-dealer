import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GitHubRepoInput,
  looksLikeLocalRepoPath,
  parseGitHubRepoInput,
} from "./github-repo.js";

test("parseGitHubRepoInput normalizes HTTPS URL, SSH, and owner/repo", () => {
  assert.deepEqual(parseGitHubRepoInput("https://github.com/acme/app"), {
    owner: "acme",
    repo: "app",
    identity: "github.com/acme/app",
    cloneUrl: "https://github.com/acme/app.git",
  });
  assert.equal(parseGitHubRepoInput("https://github.com/acme/app.git").identity, "github.com/acme/app");
  assert.equal(parseGitHubRepoInput("git@github.com:acme/app.git").identity, "github.com/acme/app");
  assert.equal(parseGitHubRepoInput("github.com/acme/app").identity, "github.com/acme/app");
  assert.equal(parseGitHubRepoInput("acme/app").identity, "github.com/acme/app");
  assert.equal(parseGitHubRepoInput("  acme/app  ").identity, "github.com/acme/app");
});

test("parseGitHubRepoInput rejects local paths and non-GitHub hosts", () => {
  assert.throws(() => parseGitHubRepoInput("/Users/me/projects/app"), /Local filesystem/);
  assert.throws(() => parseGitHubRepoInput("~/projects/app"), /Local filesystem/);
  assert.throws(() => parseGitHubRepoInput("./relative"), /Local filesystem/);
  assert.throws(() => parseGitHubRepoInput("https://gitlab.com/acme/app"), /Only github.com/);
  assert.throws(() => parseGitHubRepoInput(""), /required/);
});

test("looksLikeLocalRepoPath distinguishes legacy checkouts from portable refs", () => {
  assert.equal(looksLikeLocalRepoPath("/tmp/repo"), true);
  assert.equal(looksLikeLocalRepoPath("github.com/acme/app"), false);
  assert.equal(looksLikeLocalRepoPath("acme/app"), false);
});

test("GitHubRepoInput zod transform stores the canonical identity", () => {
  assert.equal(GitHubRepoInput.parse("acme/app"), "github.com/acme/app");
  assert.throws(() => GitHubRepoInput.parse("/local/path"));
});
