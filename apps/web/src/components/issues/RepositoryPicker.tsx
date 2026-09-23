// NOT-260: shared repository entry block — the single repository input
// pattern for New issue and every mapping editor row.
export default function RepositoryPicker({
  value,
  onChange,
  recentRepos = [],
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  recentRepos?: string[];
  id?: string;
}) {
  return (
    <div className="space-y-1">
      {recentRepos.length > 0 && (
        <select
          className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          value={recentRepos.includes(value) ? value : ""}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
          }}
          aria-label="Recent repositories"
        >
          <option value="">Recent repositories…</option>
          {recentRepos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
      <input
        id={id}
        className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
        placeholder="GitHub URL or owner/repo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
