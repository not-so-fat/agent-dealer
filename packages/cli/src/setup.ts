import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultAgentDealerHome,
  resolveEnvTemplatePath,
} from "./paths.js";

export interface SetupOptions {
  home?: string;
  force?: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const home = options.home ?? defaultAgentDealerHome();
  const envFile = path.join(home, ".env");
  const template = resolveEnvTemplatePath();

  if (!fs.existsSync(template)) {
    console.error(`Missing env template at ${template}`);
    return 1;
  }

  fs.mkdirSync(home, { recursive: true });

  if (fs.existsSync(envFile) && !options.force) {
    console.log(`Config already exists: ${envFile}`);
    console.log("Edit it for Linear / Agent Deck keys, or re-run with --force.");
    return 0;
  }

  fs.copyFileSync(template, envFile);
  console.log(`Created ${envFile}`);
  console.log(`Data directory: ${home}`);
  console.log("Next: agent-dealer start");
  return 0;
}

export function printSetupHelp(): void {
  console.log(`Usage:
  agent-dealer setup [--home DIR] [--force]

Creates ~/.agent-dealer/.env from the bundled template.`);
}
