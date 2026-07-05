import { useEffect, useState } from "react";
import type { Runtime } from "@agent-dealer/shared";
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

  const defaultLabel = defaultModelId
    ? (models.find((m) => m.id === defaultModelId)?.label ?? defaultModelId)
    : "runtime default";

  return (
    <label className="block space-y-1">
      <span className="text-xs text-[#A8C4C0] uppercase">{label}</span>
      <select
        className="field text-sm"
        disabled={disabled || loading}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{loading ? "Loading models…" : `Default (${defaultLabel})`}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {source === "fallback" && models.length > 0 && !loading && (
        <p className="text-xs text-white/40">Curated list — could not fetch live models.</p>
      )}
    </label>
  );
}
