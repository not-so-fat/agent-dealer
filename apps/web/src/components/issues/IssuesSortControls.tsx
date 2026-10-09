import { ISSUES_SORT_OPTIONS, type IssuesSortDirection, type IssuesSortKey } from "../../lib/issuesList";

type Props = {
  sort: IssuesSortKey;
  direction: IssuesSortDirection;
  onSortChange: (sort: IssuesSortKey) => void;
  onToggleDirection: () => void;
};

function sortLabel(key: IssuesSortKey): string {
  return key === "latest" ? "Latest" : key;
}

/**
 * NOT-385: the Issues history sort control plus its one adjacent order
 * control. Latest (updatedAt) is the only sort key; the compact toggle flips
 * newest-first ↔ oldest-first for that key. The active direction is visible
 * (arrow + words) and exposed through the accessible name and pressed state.
 */
export default function IssuesSortControls({ sort, direction, onSortChange, onToggleDirection }: Props) {
  const oldestFirst = direction === "asc";
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs text-white/50">
        Sort
        <select
          aria-label="Sort issues"
          className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-white/80"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as IssuesSortKey)}
        >
          {ISSUES_SORT_OPTIONS.map((key) => (
            <option key={key} value={key}>
              {sortLabel(key)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={onToggleDirection}
        aria-label={oldestFirst ? "Sort order: oldest first" : "Sort order: newest first"}
        aria-pressed={oldestFirst}
        title={oldestFirst ? "Show newest first" : "Show oldest first"}
        className="font-ui-display px-2 py-1 text-xs rounded border border-white/15 text-white/70 hover:text-white"
      >
        <span aria-hidden="true">{oldestFirst ? "↑" : "↓"}</span>{" "}
        {oldestFirst ? "Oldest first" : "Newest first"}
      </button>
    </div>
  );
}
