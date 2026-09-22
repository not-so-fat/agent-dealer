import { spawn } from "node:child_process";

export type BrowserOpenResult =
  | { ok: true; command: string; url: string }
  | { ok: false; command: string; url: string; error: Error };

interface SpawnedBrowserChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref(): unknown;
}

export type BrowserSpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; shell: boolean },
) => SpawnedBrowserChild;

const defaultSpawn: BrowserSpawnFn = (command, args, options) => spawn(command, args, options);

/** Which opener command each platform uses. Unchanged by the NOT-237 fix. */
export function resolveBrowserOpenCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "start";
  return "xdg-open";
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Ask the OS to open `url` in the system browser.
 *
 * Limit, stated up front: on all three platforms the opener returns before
 * the browser finishes launching, so `ok: true` only means the opener
 * command was accepted — not that a window appeared. The fix narrows false
 * positives to detectable spawn failures; it does not guarantee an open.
 */
export function openUrlInSystemBrowser(
  url: string,
  options: { spawnFn?: BrowserSpawnFn; platform?: NodeJS.Platform } = {},
): Promise<BrowserOpenResult> {
  const platform = options.platform ?? process.platform;
  const command = resolveBrowserOpenCommand(platform);
  const spawnFn = options.spawnFn ?? defaultSpawn;
  return new Promise((resolve) => {
    let child: SpawnedBrowserChild;
    try {
      child = spawnFn(command, [url], { stdio: "ignore", shell: platform === "win32" });
    } catch (error) {
      resolve({ ok: false, command, url, error: toError(error) });
      return;
    }
    child.once("error", (error) => {
      resolve({ ok: false, command, url, error });
    });
    child.once("spawn", () => {
      resolve({ ok: true, command, url });
    });
    child.unref();
  });
}

/** Actionable fallback message for a detected opener spawn failure. */
export function formatBrowserOpenFailure(result: Extract<BrowserOpenResult, { ok: false }>): string {
  return (
    `[agent-dealer] Could not open the dashboard in your browser ` +
    `(${result.command} failed: ${result.error.message}). ` +
    `Open this URL manually: ${result.url}`
  );
}
