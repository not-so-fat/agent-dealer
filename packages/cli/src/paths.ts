import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getCliPackageRoot(): string {
  return path.join(__dirname, "..");
}

export function resolveServerRoot(): string {
  const entry = require.resolve("@agent-dealer/server", {
    paths: [getCliPackageRoot()],
  });
  return path.join(path.dirname(entry), "..");
}

export function resolveServerEntry(): string {
  const distPath = path.join(resolveServerRoot(), "dist", "index.js");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Server build not found at ${distPath}`);
  }
  return distPath;
}

export function resolveUiDist(): string | undefined {
  if (process.env.AGENT_DEALER_UI_DIST?.trim()) {
    const custom = path.resolve(process.env.AGENT_DEALER_UI_DIST);
    return fs.existsSync(custom) ? custom : undefined;
  }

  const bundled = path.join(resolveServerRoot(), "static-ui");
  return fs.existsSync(bundled) ? bundled : undefined;
}

export function resolveEnvTemplatePath(): string {
  return path.join(getCliPackageRoot(), "templates", "prod.env.example");
}

export function defaultAgentDealerHome(): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".agent-dealer");
}
