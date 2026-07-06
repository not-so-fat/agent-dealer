import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { resolveServerEntry, resolveUiDist, defaultAgentDealerHome } from "./paths.js";

export async function runDoctor(): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`Node.js 20+ required (found ${process.versions.node})`);
    return 1;
  }
  console.log(`✓ Node ${process.versions.node}`);

  try {
    resolveServerEntry();
    console.log("✓ @agent-dealer/server entry");
  } catch (err) {
    console.error(`✗ server: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const ui = resolveUiDist();
  if (ui) {
    console.log(`✓ dashboard bundle ${ui}`);
  } else {
    console.warn("⚠ dashboard bundle missing (API-only)");
  }

  const home = defaultAgentDealerHome();
  const envFile = path.join(home, ".env");
  if (fs.existsSync(envFile)) {
    console.log(`✓ config ${envFile}`);
  } else {
    console.warn(`⚠ no config — run: agent-dealer setup`);
  }

  const port = Number(process.env.PORT ?? 2221);
  const free = await isPortFree(port);
  if (free) {
    console.log(`✓ port ${port} available`);
  } else {
    console.warn(`⚠ port ${port} in use`);
  }

  return 0;
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
