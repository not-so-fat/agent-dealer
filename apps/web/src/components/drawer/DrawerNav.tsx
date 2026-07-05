type Props = {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  label?: string;
};

export default function DrawerNav({ index, total, onPrev, onNext, label = "In Queue" }: Props) {
  if (total <= 1) return null;

  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-xs uppercase tracking-wide text-white/45 hidden sm:inline">{label}</span>
      <button
        type="button"
        onClick={onPrev}
        disabled={index <= 0}
        className="btn-ghost px-2.5 py-1.5 disabled:opacity-30"
        title="Previous"
        aria-label="Previous in queue"
      >
        ←
      </button>
      <span className="text-sm tabular-nums text-white/60 min-w-[3.5rem] text-center">
        {index + 1} / {total}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={index >= total - 1}
        className="btn-ghost px-2.5 py-1.5 disabled:opacity-30"
        title="Next"
        aria-label="Next in queue"
      >
        →
      </button>
    </div>
  );
}
