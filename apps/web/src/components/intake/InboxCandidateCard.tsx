import type { LinearCandidate } from "@agent-dealer/shared";
import Badge from "../ui/Badge";

type Props = {
  candidate: LinearCandidate;
  selected: boolean;
  onSelect: () => void;
};

/** Linear inbox row — issue id + title focus (Cursor delegate / Autoship issue list). */
export default function InboxCandidateCard({ candidate, selected, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`task-card w-full text-left rounded-xl border transition-colors ${
        selected ? "glass-plate-selected" : ""
      }`}
    >
      <div className="p-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Badge className="bg-[#5E6AD2]/15 text-[#AEB4FF] border-[#5E6AD2]/35">{candidate.identifier}</Badge>
          {candidate.state && (
            <span className="text-xs text-white/45 uppercase tracking-wide">{candidate.state}</span>
          )}
        </div>
        <h3 className="text-lg font-semibold text-[#E8F6F4] leading-snug line-clamp-2">{candidate.title}</h3>
        {candidate.description && (
          <p className="text-sm text-white/45 line-clamp-2 leading-relaxed">{candidate.description}</p>
        )}
      </div>
    </button>
  );
}
