export {
  agentDealerHome,
  cliEntryInVersionDir,
  currentLinkPath,
  localBinDir,
  localBinLauncherPath,
  partialVersionDir,
  resolveCurrentVersionDir,
  updateStatePath,
  versionDir,
  versionsDir,
} from "./paths.js";
export { detectInstallKind, type InstallKind } from "./install-kind.js";
export { activateVersion, pruneOldVersions } from "./activate.js";
export { writeLocalBinLauncher } from "./launcher.js";
export { installCliVersionToPrefix, PACKAGE_NAME } from "./npm-prefix-install.js";
export { compareSemver } from "./semver.js";
export { readUpdateState, writeUpdateState, type UpdateState } from "./update-state.js";
export {
  ensurePendingDownload,
  fetchLatestVersion,
  isAutoupdaterDisabled,
  maybeActivatePendingVersion,
  readCurrentManagedVersion,
  runManagedCliEntryHooks,
  scheduleBackgroundUpdateCheck,
} from "./updater.js";
