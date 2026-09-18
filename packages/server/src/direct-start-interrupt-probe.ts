// packages/server/src/direct-start-interrupt-probe.ts
//
// Spawned by direct-start-liveness.integration.test.ts to prove the SIGINT path
// reaps both the detached server group and the tracked temp home (NOT-140).
// Args: <home> <readyFile> <serverEntry> <port>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirectStartLiveCleanup } from "./direct-start-temp-home-cleanup.js";
import { resolveTsxBin } from "./resolve-tsx-bin.js";

const [home, readyFile, serverEntry, portStr] = process.argv.slice(2);
if (!home || !readyFile || !serverEntry || !portStr) {
  console.error("usage: direct-start-interrupt-probe <home> <readyFile> <serverEntry> <port>");
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tsxBin = resolveTsxBin(repoRoot);
const liveCleanup = new DirectStartLiveCleanup();

function signalGroup(child: { pid?: number }, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH — already gone
  }
}

function reapAllLiveCleanup(): void {
  liveCleanup.reapAll(signalGroup);
}

liveCleanup.trackHome(home);

const child = spawn(tsxBin, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AGENT_DEALER_HOME: home,
    AGENT_DEALER_ENV: "development",
    PORT: portStr,
  },
  stdio: "ignore",
  detached: true,
});
child.unref();
liveCleanup.addServer(child);

process.on("exit", reapAllLiveCleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    reapAllLiveCleanup();
    process.exit(1);
  });
}

// Stay alive until the parent interrupts us. The ready file tells the parent the
// home path and that the signal handlers are registered.
fs.writeFileSync(readyFile, JSON.stringify({ home, pid: process.pid, serverLauncherPid: child.pid }));
setInterval(() => {}, 60_000);
