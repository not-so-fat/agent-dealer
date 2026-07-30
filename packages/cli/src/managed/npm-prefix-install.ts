import { spawn } from "node:child_process";
import fs from "node:fs";

import { cliEntryInVersionDir, partialVersionDir, versionDir, versionsDir } from "./paths.js";

export const PACKAGE_NAME = "agent-dealer";

export type NpmSpawn = (
  args: string[],
  options: { cwd?: string },
) => Promise<{ code: number; stderr: string }>;

const defaultNpmSpawn: NpmSpawn = (args, options) =>
  new Promise((resolve) => {
    const child = spawn("npm", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => resolve({ code: 1, stderr: err.message }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });

export async function installCliVersionToPrefix(
  version: string,
  options: { npmSpawn?: NpmSpawn } = {},
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const npmSpawn = options.npmSpawn ?? defaultNpmSpawn;
  const partial = partialVersionDir(version);
  const finalDir = versionDir(version);

  fs.mkdirSync(versionsDir(), { recursive: true });
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });

  const result = await npmSpawn(["install", "--prefix", partial, `${PACKAGE_NAME}@${version}`], {});
  if (result.code !== 0) {
    fs.rmSync(partial, { recursive: true, force: true });
    return { ok: false, error: result.stderr.trim() || `npm install failed (exit ${result.code})` };
  }

  const entry = cliEntryInVersionDir(partial);
  if (!fs.existsSync(entry)) {
    fs.rmSync(partial, { recursive: true, force: true });
    return { ok: false, error: `Install succeeded but missing CLI entry: ${entry}` };
  }

  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(partial, finalDir);
  return { ok: true, dir: finalDir };
}
