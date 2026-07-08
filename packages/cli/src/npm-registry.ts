const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

export async function fetchLatestPublishedVersion(
  packageName: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { version?: string };
    return json.version;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

