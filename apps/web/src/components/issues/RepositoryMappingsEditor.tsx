import { useEffect, useState } from "react";
import RepositoryPicker from "./RepositoryPicker";
import {
  fetchRepositoryMappings,
  saveRepositoryMappings,
  type RepositoryMapping,
} from "../../api";

// NOT-260: compact inline label → repository mapping editor. Lives directly
// below the New issue Repository control; saving or closing never touches the
// parent form (the New issue repository value is owned by the page, not here).

export function emptyMappingRow(): RepositoryMapping {
  return { label: "", repository: "" };
}

/** Client-side row problems shown inline before any server round-trip. */
export function validateMappingRows(rows: RepositoryMapping[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const label = row.label.trim();
    if (!label) return "Labels must not be empty";
    if (label.length > 100) return `Label "${label}" must be 1–100 characters`;
    const key = label.toLowerCase();
    if (seen.has(key)) return `Duplicate label "${label}"`;
    seen.add(key);
    if (!row.repository.trim()) return `Repository for "${label}" must not be empty`;
  }
  if (rows.length > 100) return "At most 100 mappings are allowed";
  return null;
}

export default function RepositoryMappingsEditor({
  recentRepos = [],
  initialMappings,
  loadMappings = fetchRepositoryMappings,
  saveMappings = saveRepositoryMappings,
  onClose,
}: {
  recentRepos?: string[];
  initialMappings?: RepositoryMapping[];
  loadMappings?: () => Promise<RepositoryMapping[]>;
  saveMappings?: (mappings: RepositoryMapping[]) => Promise<RepositoryMapping[]>;
  onClose?: () => void;
}) {
  const [rows, setRows] = useState<RepositoryMapping[]>(
    initialMappings ?? []
  );
  const [loaded, setLoaded] = useState(initialMappings !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initialMappings !== undefined) return;
    let live = true;
    loadMappings()
      .then((m) => {
        if (live) {
          setRows(m);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          setLoaded(true);
        }
      });
    return () => {
      live = false;
    };
  }, [initialMappings, loadMappings]);

  const setRow = (index: number, patch: Partial<RepositoryMapping>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    setError(null);
    setNotice(null);
    const problem = validateMappingRows(rows);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      // Send trimmed labels; the server normalizes and returns canonical rows.
      const saved = await saveMappings(
        rows.map((r) => ({ label: r.label.trim(), repository: r.repository }))
      );
      setRows(saved);
      setNotice(saved.length === 0 ? "Mappings cleared" : `Saved ${saved.length} mapping${saved.length === 1 ? "" : "s"}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded border border-white/10 bg-black/20 px-3 py-2 space-y-2" aria-label="Repository mappings">
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/60">Repository mappings</p>
        {onClose && (
          <button
            type="button"
            className="text-xs text-white/50 hover:text-white"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </div>
      {!loaded ? (
        <p className="text-xs text-white/40">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-white/40">No mappings yet — add one to prefill the Repository field from a Linear label.</p>
      ) : (
        rows.map((row, i) => (
          <div key={i} className="flex gap-2 items-start" data-testid="mapping-row">
            <input
              className="w-40 shrink-0 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm"
              placeholder="Linear label"
              aria-label={`Linear label for mapping ${i + 1}`}
              value={row.label}
              onChange={(e) => setRow(i, { label: e.target.value })}
            />
            <div className="flex-1 min-w-0">
              <RepositoryPicker
                value={row.repository}
                onChange={(next) => setRow(i, { repository: next })}
                recentRepos={recentRepos}
              />
            </div>
            <button
              type="button"
              className="shrink-0 text-xs text-white/50 hover:text-white px-1 py-1.5"
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))
      )}
      {error && (
        <p className="text-xs text-red-300" data-testid="mappings-error">
          {error}
        </p>
      )}
      {notice && <p className="text-xs text-teal-200/80">{notice}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="text-xs px-2 py-1 rounded border border-white/15 text-white/70 hover:text-white"
          onClick={() => setRows((prev) => [...prev, emptyMappingRow()])}
        >
          Add mapping
        </button>
        <button
          type="button"
          className="text-xs px-2 py-1 rounded border border-teal/40 text-teal disabled:opacity-50"
          disabled={saving || !loaded}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
