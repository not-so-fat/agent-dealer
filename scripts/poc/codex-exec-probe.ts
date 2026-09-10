/**
 * Manual smoke for Codex non-interactive exec.
 * Usage:
 *   npx tsx scripts/poc/codex-exec-probe.ts          # print argv only
 *   RUN_POC=1 npx tsx scripts/poc/codex-exec-probe.ts # actually spawn
 */
import { spawnSync } from "node:child_process";
import { buildCodexExecArgs } from "../../packages/server/src/runners/codex-args.js";
import { resolveCodexBin } from "../../packages/server/src/cli-env.js";

const workspace = process.cwd();
const args = buildCodexExecArgs({
  mode: "plan",
  workspaceRoot: workspace,
  prompt: "Reply with exactly: ok",
});

console.log("bin:", resolveCodexBin());
console.log("argv:", args.join(" "));

if (process.env.RUN_POC === "1") {
  const result = spawnSync(resolveCodexBin(), args, {
    encoding: "utf8",
    cwd: workspace,
    timeout: 120_000,
  });
  console.log("exit:", result.status);
  console.log("stdout:\n", result.stdout?.slice(0, 4000));
  if (result.stderr) console.log("stderr:\n", result.stderr.slice(0, 2000));
}
