import net from "node:net";
import fs from "node:fs";
import { claudeAvailable } from "./cli-check.js";
import {
  loadProdEnvFile,
  prodEnvFilePath,
  prodHomeDir,
  resolveBundledListenPort,
  shortenHome,
} from "./env.js";
import { resolveServerEntry, resolveUiDist } from "./paths.js";

export async function runDoctor(): Promise<number> {
  let failed = false;

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`✗ Node.js 20+ required (found ${process.versions.node})`);
    return 1;
  }
  console.log(`✓ Node ${process.versions.node}`);

  const claude = await claudeAvailable();
  if (claude.ok) {
    console.log(`✓ Claude Code CLI (${claude.bin})`);
  } else {
    console.error("✗ Claude Code CLI not found — install claude and ensure it is on PATH");
    console.error("  https://docs.anthropic.com/en/docs/claude-code");
    failed = true;
  }

  try {
    resolveServerEntry();
    console.log("✓ @agent-dealer/server entry");
  } catch (err) {
    console.error(`✗ server: ${err instanceof Error ? err.message : err}`);
    failed = true;
  }

  const ui = resolveUiDist();
  if (ui) {
    console.log(`✓ dashboard bundle ${ui}`);
  } else {
    console.warn("⚠ dashboard bundle missing (API-only)");
  }

  const envFile = loadProdEnvFile() ?? prodEnvFilePath();
  if (fs.existsSync(envFile)) {
    console.log(`✓ config ${shortenHome(envFile)}`);
    if (process.env.LINEAR_API_KEY?.trim()) {
      console.log("✓ LINEAR_API_KEY set");
    } else {
      console.warn("⚠ LINEAR_API_KEY not set — Linear inbox disabled");
    }
  } else {
    console.warn(`⚠ no config — run: agent-dealer setup`);
  }

  const home = prodHomeDir();
  if (fs.existsSync(home)) {
    console.log(`✓ data ${shortenHome(home)}`);
  }

  const port = resolveBundledListenPort();
  const free = await isPortFree(port);
  if (free) {
    console.log(`✓ port ${port} available`);
  } else {
    console.warn(`⚠ port ${port} in use`);
  }

  return failed ? 1 : 0;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
