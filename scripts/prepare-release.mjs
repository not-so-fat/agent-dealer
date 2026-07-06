#!/usr/bin/env node
/**
 * Build workspaces, bundle dashboard into @agent-dealer/server/static-ui for npm.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const webDist = path.join(root, "apps/web/dist");
const serverStatic = path.join(root, "packages/server/static-ui");

console.log("[prepare-release] Building workspaces …");
execSync("npm run build -w @agent-dealer/shared && npm run build -w @agent-dealer/server && npm run build -w @agent-dealer/web && npm run build -w agent-dealer", {
  cwd: root,
  stdio: "inherit",
});

if (!fs.existsSync(webDist)) {
  console.error(`[prepare-release] Missing web build at ${webDist}`);
  process.exit(1);
}

console.log(`[prepare-release] Copying UI → ${serverStatic}`);
fs.rmSync(serverStatic, { recursive: true, force: true });
fs.cpSync(webDist, serverStatic, { recursive: true });

console.log("[prepare-release] Done. Publish: npm publish -w agent-dealer --access public");
