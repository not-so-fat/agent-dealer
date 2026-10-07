// NOT-369: host-power status for the dashboard health surface.

import { isHostAwakeHoldActive, getHostAwakeGuard } from "./host-awake.js";
import {
  ensureSleepTimerCheckedAtStartup,
  getSleepTimerNotice,
  type SleepTimerNotice,
} from "./sleep-timer.js";

export type HostPowerStatus = {
  platform: string;
  /** True when a live caffeinate child is held for active Dealer work. */
  holdActive: boolean;
  holdCount: number;
  /** One-line operator status for the health / execution surface. */
  holdStatusLine: string;
  /** Short sleep-timer notice, or null when none applies. */
  sleepTimerNotice: SleepTimerNotice | null;
};

export function hostPowerStatusLine(holdActive: boolean, platform: string = process.platform): string {
  if (platform !== "darwin") {
    return "Host awake hold: n/a (macOS only)";
  }
  return holdActive
    ? "Host awake hold: active (caffeinate -i)"
    : "Host awake hold: idle";
}

/** Snapshot for GET /api/host-power and the Agents health area. */
export function getHostPowerStatus(): HostPowerStatus {
  const guard = getHostAwakeGuard();
  // Prefer the guard's platform so unit tests can inject `darwin` on Linux CI.
  const platform = guard.getPlatform();
  // Ensure the one-time startup check has run even if index.ts forgot.
  ensureSleepTimerCheckedAtStartup();
  const holdActive = isHostAwakeHoldActive();
  const holdCount = guard.holdCount();
  return {
    platform,
    holdActive,
    holdCount,
    holdStatusLine: hostPowerStatusLine(holdActive, platform),
    sleepTimerNotice: getSleepTimerNotice(),
  };
}
