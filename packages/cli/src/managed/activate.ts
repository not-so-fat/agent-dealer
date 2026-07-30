import fs from "node:fs";
import path from "node:path";

import { writeLocalBinLauncher } from "./launcher.js";
import {
  cliEntryInVersionDir,
  currentLinkPath,
  resolveCurrentVersionDir,
  versionDir,
  versionsDir,
} from "./paths.js";
import { compareSemver } from "./semver.js";

export function activateVersion(version: string): void {
  const target = versionDir(version);
  const entry = cliEntryInVersionDir(target);
  if (!fs.existsSync(entry)) {
    throw new Error(`Cannot activate ${version}: missing ${entry}`);
  }

  const link = currentLinkPath();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isFile()) {
      fs.unlinkSync(link);
    } else {
      fs.rmSync(link, { recursive: true, force: true });
    }
  } catch {
    // missing
  }
  fs.symlinkSync(target, link, "dir");
  writeLocalBinLauncher();
  pruneOldVersions(3);
}

export function pruneOldVersions(keep: number): void {
  const root = versionsDir();
  if (!fs.existsSync(root)) return;

  const currentReal = resolveCurrentVersionDir();
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => compareSemver(b, a));

  const retained = names.slice(0, Math.max(keep, 0));
  for (const name of names) {
    const full = path.join(root, name);
    if (retained.includes(name)) continue;
    if (currentReal && fs.existsSync(full) && fs.realpathSync(full) === currentReal) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }
}
