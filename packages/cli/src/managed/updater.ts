import fs from "node:fs";
import path from "node:path";

import { activateVersion } from "./activate.js";
import { detectInstallKind } from "./install-kind.js";
import { installCliVersionToPrefix } from "./npm-prefix-install.js";
import { cliEntryInVersionDir, resolveCurrentVersionDir, versionDir } from "./paths.js";
import { compareSemver } from "./semver.js";
import { readUpdateState, writeUpdateState } from "./update-state.js";
import { fetchLatestPublishedVersion } from "../npm-registry.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PACKAGE_NAME = "agent-dealer";

export function isAutoupdaterDisabled(): boolean {
  const v = process.env.AGENT_DEALER_DISABLE_AUTOUPDATER?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export async function fetchLatestVersion(): Promise<string | null> {
  const v = await fetchLatestPublishedVersion(PACKAGE_NAME);
  return v ?? null;
}

export function readCurrentManagedVersion(): string | null {
  const real = resolveCurrentVersionDir();
  if (!real) return null;
  return path.basename(real);
}

export function maybeActivatePendingVersion(): { activated: string | null } {
  if (isAutoupdaterDisabled()) return { activated: null };
  if (detectInstallKind() !== "managed") return { activated: null };

  const state = readUpdateState();
  const pending = state?.pendingVersion;
  if (!pending) return { activated: null };

  const dir = versionDir(pending);
  if (!fs.existsSync(cliEntryInVersionDir(dir))) return { activated: null };

  activateVersion(pending);
  writeUpdateState({
    checkedAt: state?.checkedAt ?? new Date().toISOString(),
    latest: state?.latest ?? pending,
    pendingVersion: null,
  });
  return { activated: pending };
}

export async function ensurePendingDownload(
  latest: string,
  options: { installVersion?: typeof installCliVersionToPrefix } = {},
): Promise<void> {
  if (isAutoupdaterDisabled()) return;

  const dir = versionDir(latest);
  if (fs.existsSync(cliEntryInVersionDir(dir))) {
    const prev = readUpdateState();
    writeUpdateState({
      checkedAt: prev?.checkedAt ?? new Date().toISOString(),
      latest,
      pendingVersion: latest,
    });
    return;
  }

  const install = options.installVersion ?? installCliVersionToPrefix;
  const result = await install(latest);
  if (!result.ok) return;

  const prev = readUpdateState();
  writeUpdateState({
    checkedAt: prev?.checkedAt ?? new Date().toISOString(),
    latest,
    pendingVersion: latest,
  });
}

export function scheduleBackgroundUpdateCheck(
  options: {
    fetchLatest?: () => Promise<string | null>;
    installVersion?: typeof installCliVersionToPrefix;
  } = {},
): void {
  if (isAutoupdaterDisabled() || detectInstallKind() !== "managed") return;

  const state = readUpdateState();
  if (state?.checkedAt) {
    const age = Date.now() - Date.parse(state.checkedAt);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) return;
  }

  const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
  void (async () => {
    try {
      const latest = await fetchLatest();
      writeUpdateState({
        checkedAt: new Date().toISOString(),
        latest,
        pendingVersion: readUpdateState()?.pendingVersion ?? null,
      });
      if (!latest) return;
      const current = readCurrentManagedVersion();
      if (current && compareSemver(latest, current) <= 0) return;
      await ensurePendingDownload(latest, { installVersion: options.installVersion });
    } catch {
      // background only
    }
  })();
}

export function runManagedCliEntryHooks(options: {
  allowActivate: boolean;
  fetchLatest?: () => Promise<string | null>;
  installVersion?: typeof installCliVersionToPrefix;
}): { activated: string | null } {
  const activated = options.allowActivate ? maybeActivatePendingVersion().activated : null;
  scheduleBackgroundUpdateCheck({
    fetchLatest: options.fetchLatest,
    installVersion: options.installVersion,
  });
  return { activated };
}
