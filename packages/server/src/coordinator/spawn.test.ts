import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { roleCeiling } from "@agent-dealer/shared";
import { assertReviewerReadOnly } from "./permissions.js";
import { realDeveloperSpawn, realReviewerSpawn } from "./spawn.js";

const BIN_ENV = {
  codex_local: "CODEX_CLI",
  claude_code: "CLAUDE_CLI",
  cursor_local: "CURSOR_CLI",
  muse_code: "MUSE_CLI",
} as const;

for (const runtime of Object.keys(BIN_ENV) as Array<keyof typeof BIN_ENV>) {
  for (const role of runtime === "muse_code" ? ["developer"] as const : ["developer", "reviewer"] as const) {
    test(`${runtime} ${role} launches with the full large prompt`, async (t) => {
      // Muse refuses attempts under system temp directories.
      const scratch = runtime === "muse_code" ? path.resolve(import.meta.dirname, "../../../..") : os.tmpdir();
      const dir = fs.mkdtempSync(path.join(scratch, ".dealer-worker-spawn-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const sessionId = "00000000-0000-4000-8000-000000000635";
      const cwd = path.join(dir, "worktrees", `${sessionId}-${role}`);
      fs.mkdirSync(cwd, { recursive: true });
      const bin = path.join(dir, "worker.cjs");
      fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const input = fs.readFileSync(0);
const muse = argv.includes("--prompt-file");
const pathMatch = argv.at(-1)?.match(/from (".*") and follow/);
const promptFile = muse ? argv[argv.indexOf("--prompt-file") + 1] : pathMatch && JSON.parse(pathMatch[1]);
const prompt = promptFile ? fs.readFileSync(promptFile) : input;
const mode = promptFile ? fs.statSync(promptFile).mode & 0o777 : null;
const digest = require("node:crypto").createHash("sha256").update(prompt).digest("hex");
const receipt = { argv, digest, bytes: prompt.length, promptFile, mode, inputBytes: input.length };
fs.writeFileSync("receipt.json", JSON.stringify(receipt));
`, { mode: 0o700 });
      const env = {
        [BIN_ENV[runtime]]: bin,
        AGENT_DEALER_HOME: dir,
        XDG_CONFIG_HOME: path.join(dir, "operator-config"),
        META_API_KEY: "test-key",
      };
      for (const [key, value] of Object.entries(env)) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        });
      }

      const prompt = "sentinel worker prompt\n" + "é".repeat(100 * 1024) + "\n";
      const spawn = role === "reviewer" ? realReviewerSpawn : realDeveloperSpawn;
      const result = await spawn({
        runtime, cwd, sessionId, prompt, policy: roleCeiling(role), model: null,
        logPath: path.join(dir, "worker.ndjson"), timeoutMs: 5000,
        deckId: "test-deck", agentDeckUrl: "http://127.0.0.1:1111/mcp",
      });
      assert.equal(result.timedOut, false);
      // The Muse stub records transport only. Muse's parser requires model events for a successful turn.
      if (runtime !== "muse_code") assert.equal(result.exitCode, 0);
      const receipt = JSON.parse(fs.readFileSync(path.join(cwd, "receipt.json"), "utf8"));
      assert.equal(receipt.bytes, Buffer.byteLength(prompt));
      assert.equal(receipt.digest, createHash("sha256").update(prompt).digest("hex"));
      assert.ok(receipt.argv.every((arg: string) => !arg.includes("sentinel worker prompt")));
      if (role === "reviewer") assertReviewerReadOnly(receipt.argv, {});
      if (runtime === "codex_local") assert.equal(receipt.argv.at(-1), "-");
      if (runtime === "claude_code") assert.equal(receipt.argv[receipt.argv.indexOf("-p") + 1], "--output-format");
      if (runtime === "cursor_local" || runtime === "muse_code") {
        assert.equal(receipt.mode, 0o600);
        assert.equal(fs.existsSync(receipt.promptFile), false);
        assert.equal(receipt.inputBytes, runtime === "muse_code" ? Buffer.byteLength("test-key\n") : 0);
      }
    });
  }
}
