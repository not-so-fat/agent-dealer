import type { RuntimeModelsResponse } from "@agent-dealer/shared";

/** Session cache only — server holds the long-lived list; reload page or ?refresh=1 to update. */
const store = new Map<string, RuntimeModelsResponse>();
const inflight = new Map<string, Promise<RuntimeModelsResponse>>();

export function getCachedRuntimeModels(runtime: string): RuntimeModelsResponse | null {
  return store.get(runtime) ?? null;
}

export function setCachedRuntimeModels(runtime: string, data: RuntimeModelsResponse): void {
  if (data.models.length === 0) return;
  store.set(runtime, data);
}

export function clearCachedRuntimeModels(runtime?: string): void {
  if (runtime) store.delete(runtime);
  else store.clear();
}

export function fetchRuntimeModelsDeduped(
  runtime: string,
  fetcher: () => Promise<RuntimeModelsResponse>
): Promise<RuntimeModelsResponse> {
  const cached = getCachedRuntimeModels(runtime);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(runtime);
  if (pending) return pending;

  const job = fetcher()
    .then((data) => {
      setCachedRuntimeModels(runtime, data);
      return data;
    })
    .finally(() => inflight.delete(runtime));

  inflight.set(runtime, job);
  return job;
}
