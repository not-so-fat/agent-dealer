// NOT-369: warn once when macOS AC sleep is short (1–29 minutes).
// Read-only — never runs `sudo` or writes pmset settings.

import { spawnSync } from "node:child_process";

export const SLEEP_TIMER_FIX_COMMAND = "sudo pmset -c sleep 0";

export type SleepTimerNotice = {
  /** AC Power `sleep` minutes from `pmset -g custom` (1–29 when present). */
  acSleepMinutes: number;
  message: string;
  fixCommand: typeof SLEEP_TIMER_FIX_COMMAND;
};

export type PmsetRunner = () => string;

export type SleepTimerCheckOptions = {
  platform?: string;
  /** Injectable `pmset -g custom` reader; defaults to a real spawnSync. */
  runPmsetCustom?: PmsetRunner;
};

const SHORT_SLEEP_MIN = 1;
const SHORT_SLEEP_MAX = 29;

/**
 * Parse AC Power `sleep` minutes from `pmset -g custom` output.
 * Returns null when the AC section or sleep line is missing / unparseable.
 */
export function parseAcSleepMinutes(pmsetCustomOutput: string): number | null {
  const lines = pmsetCustomOutput.split(/\r?\n/);
  let inAc = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^AC Power:\s*$/i.test(line.trim())) {
      inAc = true;
      continue;
    }
    if (/^[A-Za-z].*:\s*$/.test(line.trim()) && !/^AC Power:/i.test(line.trim())) {
      inAc = false;
      continue;
    }
    if (!inAc) continue;
    const match = /^\s*sleep\s+(\d+)\s*$/i.exec(line);
    if (match) {
      const value = Number(match[1]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

function defaultRunPmsetCustom(): string {
  const result = spawnSync("pmset", ["-g", "custom"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return "";
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * Returns a notice when AC sleep is 1–29 minutes on darwin; otherwise null.
 * Never mutates system settings.
 */
export function checkSleepTimer(opts: SleepTimerCheckOptions = {}): SleepTimerNotice | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const output = (opts.runPmsetCustom ?? defaultRunPmsetCustom)();
  if (!output.trim()) return null;
  const minutes = parseAcSleepMinutes(output);
  if (minutes == null) return null;
  if (minutes < SHORT_SLEEP_MIN || minutes > SHORT_SLEEP_MAX) return null;
  return {
    acSleepMinutes: minutes,
    message:
      `macOS AC sleep is ${minutes} minute${minutes === 1 ? "" : "s"} — Dealer holds the machine awake only while work is active. ` +
      `To keep the Mac awake between sessions on AC power, run: ${SLEEP_TIMER_FIX_COMMAND}`,
    fixCommand: SLEEP_TIMER_FIX_COMMAND,
  };
}

/** Cached once per process so the dashboard shows one notice per server start. */
let cachedNotice: SleepTimerNotice | null | undefined;

/** Run (or return) the process-lifetime sleep-timer notice. */
export function getSleepTimerNotice(opts: SleepTimerCheckOptions = {}): SleepTimerNotice | null {
  if (cachedNotice !== undefined && opts.runPmsetCustom == null && opts.platform == null) {
    return cachedNotice;
  }
  const notice = checkSleepTimer(opts);
  if (opts.runPmsetCustom == null && opts.platform == null) {
    cachedNotice = notice;
  }
  return notice;
}

/** Ensure the startup check has run (call from server boot / health). */
export function ensureSleepTimerCheckedAtStartup(): SleepTimerNotice | null {
  return getSleepTimerNotice();
}

/** Test hook — clear the process-lifetime cache. */
export function resetSleepTimerNoticeForTests(): void {
  cachedNotice = undefined;
}
