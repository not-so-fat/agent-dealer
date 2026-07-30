import { resolveCurrentVersionDir } from "./paths.js";

export type InstallKind = "managed" | "npm-global" | "unknown";

export function detectInstallKind(options?: {
  whichPath?: string;
  npmGlobalPrefix?: string;
}): InstallKind {
  if (resolveCurrentVersionDir()) return "managed";

  const whichPath = options?.whichPath;
  const prefix = options?.npmGlobalPrefix;
  if (whichPath && prefix) {
    const normalizedWhich = whichPath.replace(/\\/g, "/");
    const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/\/$/, "");
    if (
      normalizedWhich === normalizedPrefix ||
      normalizedWhich.startsWith(`${normalizedPrefix}/`)
    ) {
      return "npm-global";
    }
  }

  return "unknown";
}
