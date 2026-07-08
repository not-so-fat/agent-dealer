import { spawnSync } from "node:child_process";
import type { Runtime, RuntimeModelOption } from "@agent-dealer/shared";
import { CURSOR_DEFAULT_MODEL, CURSOR_SUBSCRIPTION_MODEL_IDS } from "@agent-dealer/shared";
import { cursorInvokeArgs, resolveCursorBin } from "../cli-env.js";

const CURSOR_PINNED: RuntimeModelOption[] = [
  { id: CURSOR_DEFAULT_MODEL, label: "Auto (subscription pool)" },
  { id: "composer-2.5", label: "Composer 2.5 (subscription pool)" },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast (subscription pool)" },
];

const CURSOR_FALLBACK: RuntimeModelOption[] = [...CURSOR_PINNED];

const CLAUDE_FALLBACK: RuntimeModelOption[] = [
  { id: "sonnet", label: "Sonnet (latest alias)" },
  { id: "opus", label: "Opus (latest alias)" },
  { id: "haiku", label: "Haiku (latest alias)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

type ModelsResult = { models: RuntimeModelOption[]; source: "live" | "fallback" };

type CacheEntry = ModelsResult & { fetchedAt: number };

/** Live CLI/API lists change rarely — default 14d; bust with server restart or GET ?refresh=1. */
const LIVE_CACHE_MS = Number(process.env.RUNTIME_MODELS_CACHE_MS ?? 14 * 24 * 60 * 60 * 1000);
/** Failed/empty fetch — retry sooner; successful lists use LIVE_CACHE_MS. */
const FALLBACK_CACHE_MS = Number(process.env.RUNTIME_MODELS_FALLBACK_CACHE_MS ?? 5 * 60_000);

const cache = new Map<Runtime, CacheEntry>();

function subscriptionPoolLabel(id: string, label: string): string {
  if ((CURSOR_SUBSCRIPTION_MODEL_IDS as readonly string[]).includes(id)) {
    if (label.toLowerCase().includes("subscription")) return label;
    return `${label} (subscription pool)`;
  }
  return label;
}

function mergeCursorModels(live: RuntimeModelOption[]): RuntimeModelOption[] {
  const byId = new Map<string, RuntimeModelOption>();
  for (const pinned of CURSOR_PINNED) {
    byId.set(pinned.id, pinned);
  }
  for (const m of live) {
    if (m.id === CURSOR_DEFAULT_MODEL || (CURSOR_SUBSCRIPTION_MODEL_IDS as readonly string[]).includes(m.id)) {
      byId.set(m.id, { id: m.id, label: subscriptionPoolLabel(m.id, m.label) });
    } else {
      byId.set(m.id, m);
    }
  }
  const pinnedIds = new Set(CURSOR_PINNED.map((m) => m.id));
  const pinned = CURSOR_PINNED.map((m) => byId.get(m.id)!);
  const rest = [...byId.values()].filter((m) => !pinnedIds.has(m.id));
  rest.sort((a, b) => a.label.localeCompare(b.label));
  return [...pinned, ...rest];
}

function parseCursorModelsOutput(text: string): RuntimeModelOption[] {
  const models: RuntimeModelOption[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([^\s]+)\s+-\s+(.+)$/);
    if (!m) continue;
    models.push({ id: m[1]!, label: m[2]!.trim() });
  }
  return mergeCursorModels(models);
}

async function tryAnthropicModelsApi(): Promise<RuntimeModelOption[]> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (json.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
  } catch {
    return [];
  }
}

function listCursorModels(): ModelsResult {
  const bin = resolveCursorBin();
  const result = spawnSync(bin, cursorInvokeArgs(["--list-models"]), {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status === 0 && result.stdout) {
    const models = parseCursorModelsOutput(result.stdout);
    if (models.length > 0) return { models, source: "live" };
  }
  return { models: CURSOR_FALLBACK, source: "fallback" };
}

async function fetchRuntimeModelsFresh(runtime: Runtime): Promise<ModelsResult> {
  if (runtime === "cursor_local") {
    return listCursorModels();
  }

  const fromApi = await tryAnthropicModelsApi();
  if (fromApi.length > 0) {
    const aliasIds = new Set(CLAUDE_FALLBACK.map((m) => m.id));
    return {
      models: [...CLAUDE_FALLBACK, ...fromApi.filter((m) => !aliasIds.has(m.id))],
      source: "live",
    };
  }
  return { models: CLAUDE_FALLBACK, source: "fallback" };
}

function cacheTtl(result: ModelsResult): number {
  return result.source === "live" && result.models.length > 0 ? LIVE_CACHE_MS : FALLBACK_CACHE_MS;
}

function readCache(runtime: Runtime): ModelsResult | null {
  const entry = cache.get(runtime);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= cacheTtl(entry)) return null;
  return { models: entry.models, source: entry.source };
}

function writeCache(runtime: Runtime, result: ModelsResult): void {
  if (result.models.length === 0) return;
  cache.set(runtime, { ...result, fetchedAt: Date.now() });
}

export async function listRuntimeModels(
  runtime: Runtime,
  opts?: { refresh?: boolean }
): Promise<ModelsResult> {
  if (!opts?.refresh) {
    const hit = readCache(runtime);
    if (hit) return hit;
  }

  const fresh = await fetchRuntimeModelsFresh(runtime);
  writeCache(runtime, fresh);

  if (fresh.models.length > 0) return fresh;

  const stale = cache.get(runtime);
  if (stale?.models.length) {
    return { models: stale.models, source: stale.source };
  }

  return fresh;
}
