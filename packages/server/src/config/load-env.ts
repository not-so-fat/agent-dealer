import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export type AgentDealerEnv = "development" | "production";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

const DEFAULTS: Record<
  AgentDealerEnv,
  {
    home: string;
    port: string;
    webPort: string;
    webUrl: string;
    apiUrl: string;
  }
> = {
  development: {
    home: path.join(os.homedir(), ".agent-dealer-dev"),
    port: "3221",
    webPort: "3222",
    webUrl: "http://localhost:3222",
    apiUrl: "http://127.0.0.1:3221",
  },
  production: {
    home: path.join(os.homedir(), ".agent-dealer"),
    port: "2221",
    webPort: "2222",
    webUrl: "http://localhost:2222",
    apiUrl: "http://127.0.0.1:2221",
  },
};

export function getRepoRoot(): string {
  return repoRoot;
}

export function resolveAgentDealerEnv(): AgentDealerEnv {
  const raw = process.env.AGENT_DEALER_ENV ?? process.env.NODE_ENV;
  return raw === "production" ? "production" : "development";
}

function homeDirForMode(mode: AgentDealerEnv): string {
  return DEFAULTS[mode].home;
}

export function resolveEnvFilePath(mode: AgentDealerEnv): string {
  return path.join(homeDirForMode(mode), ".env");
}

function envFileForMode(mode: AgentDealerEnv): string {
  return resolveEnvFilePath(mode);
}

function setDefault(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === "") {
    process.env[key] = value;
  }
}

function applyDefaults(mode: AgentDealerEnv): void {
  const d = DEFAULTS[mode];
  setDefault("AGENT_DEALER_HOME", d.home);
  setDefault("PORT", d.port);
  setDefault("WEB_PORT", d.webPort);
  setDefault("AGENT_DEALER_WEB_URL", d.webUrl);
  setDefault("AGENT_DEALER_API", d.apiUrl);
}

function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatEnvStartupLine(mode: AgentDealerEnv, envFile: string): string {
  const home = process.env.AGENT_DEALER_HOME ?? DEFAULTS[mode].home;
  const port = process.env.PORT ?? DEFAULTS[mode].port;
  const envLabel = fs.existsSync(envFile) ? envFile : `${envFile} (missing)`;
  return `agent-dealer [${mode}] env=${envLabel} home=${shortenHome(home)} port=${port}`;
}

export function loadAgentDealerEnv(): { mode: AgentDealerEnv; envFile: string } {
  const mode = resolveAgentDealerEnv();
  const envFile = envFileForMode(mode);

  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  } else if (mode === "development") {
    const legacy = path.resolve(repoRoot, ".env");
    if (fs.existsSync(legacy)) {
      dotenv.config({ path: legacy });
      console.warn(
        `agent-dealer: loaded legacy ${legacy} — move to ${envFile} (see scripts/templates/dev.env.example)`
      );
    }
  }

  applyDefaults(mode);

  return { mode, envFile };
}
