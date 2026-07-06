import { useEffect, useMemo, useState } from "react";
import { CURSOR_DEFAULT_MODEL, type Runtime } from "@agent-dealer/shared";
import { fetchRuntimeModels } from "../../api";
import { getCachedRuntimeModels } from "../../lib/runtimeModelsCache";

type Props = {
  runtime: Runtime;
  label: string;
  value: string;
  onChange: (v: string) => void;
  defaultModelId?: string | null;
  disabled?: boolean;
};

function cursorDefaultLabel(defaultModelId?: string | null): string {
  if (defaultModelId) return defaultModelId;
  return CURSOR_DEFAULT_MODEL;
}

export default function ModelSelect({
  runtime,
  label,
  value,
  onChange,
  defaultModelId,
  disabled,
}: Props) {
  const cached = getCachedRuntimeModels(runtime);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>(cached?.models ?? []);
  const [source, setSource] = useState<"live" | "fallback">(cached?.source ?? "fallback");
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    const warm = getCachedRuntimeModels(runtime);
    if (warm) {
      setModels(warm.models);
      setSource(warm.source);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchRuntimeModels(runtime)
      .then((res) => {
        setModels(res.models);
        setSource(res.source);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [runtime]);

  const defaultLabel = useMemo(() => {
    if (runtime === "cursor_local") {
      const id = cursorDefaultLabel(defaultModelId);
      return models.find((m) => m.id === id)?.label ?? "Auto (subscription pool)";
    }
    if (defaultModelId) {
      return models.find((m) => m.id === defaultModelId)?.label ?? defaultModelId;
    }
    return "runtime default";
  }, [runtime, defaultModelId, models]);

  const emptyOptionLabel =
    runtime === "cursor_local"
      ? loading
        ? "Loading models…"
        : `Agent default (${defaultLabel})`
      : loading
        ? "Loading models…"
        : `Default (${defaultLabel})`;

  return (
    <label className="block space-y-1">
      <span className="text-xs text-[#A8C4C0] uppercase">{label}</span>
      <select
        className="field text-sm"
        disabled={disabled || loading}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{emptyOptionLabel}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {runtime === "cursor_local" && !loading && (
        <p className="text-xs text-white/40">
          Auto and Composer use your Cursor subscription pool. Other models draw API credits.
        </p>
      )}
      {source === "fallback" && models.length > 0 && !loading && runtime === "cursor_local" && (
        <p className="text-xs text-white/40">Run cursor agent login to load the full model list.</p>
      )}
    </label>
  );
}
