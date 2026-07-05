import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { monacoFontPlugin } from "./vite-monaco-font";

function loadDealerEnvFile(): void {
  const dealerEnv = process.env.AGENT_DEALER_ENV ?? "development";
  const home =
    dealerEnv === "production"
      ? path.join(os.homedir(), ".agent-dealer")
      : path.join(os.homedir(), ".agent-dealer-dev");
  const envFile = path.join(home, ".env");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const legacy = path.join(repoRoot, ".env");

  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  } else if (dealerEnv !== "production" && fs.existsSync(legacy)) {
    dotenv.config({ path: legacy });
  }
}

loadDealerEnvFile();

export default defineConfig(({ mode }) => {
  const dealerEnv = process.env.AGENT_DEALER_ENV ?? "development";
  const isProd = dealerEnv === "production";
  const apiPort = process.env.PORT ?? (isProd ? "2221" : "3221");
  const webPort = Number(process.env.WEB_PORT ?? (isProd ? "2222" : "3222"));
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [monacoFontPlugin(), react(), tailwindcss()],
    server: {
      port: webPort,
      proxy: {
        "/api": apiTarget,
        "/health": apiTarget,
      },
    },
  };
});
