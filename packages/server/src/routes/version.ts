// packages/server/src/routes/version.ts
//
// NOT-279: the running backend reports its own version. The CLI's installed version (and
// the managed `current` symlink) can move ahead of a server that is still serving the old
// build, so `agent-dealer status` must ask the live process instead of inferring from disk.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/** Read once at module load: the package this process was started from, not whatever is on
 * disk later (a managed update may replace sibling install dirs while we keep running). */
function readServerPackageVersion(): string | null {
  try {
    // src/routes/version.ts and dist/routes/version.js both sit two levels below package.json.
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

const RUNNING_VERSION = readServerPackageVersion();
const STARTED_AT = new Date().toISOString();

export function registerVersionRoute(app: FastifyInstance): void {
  app.get("/api/version", async () => ({
    version: RUNNING_VERSION,
    pid: process.pid,
    startedAt: STARTED_AT,
  }));
}
