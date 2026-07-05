import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./db/index.js";

export function getTemporalDir(): string {
  return path.join(getDataDir(), ".temporal");
}

export function getTemporalOutputDir(): string {
  const dir = path.join(getTemporalDir(), "output");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTemporalLogsDir(): string {
  const dir = path.join(getTemporalDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
