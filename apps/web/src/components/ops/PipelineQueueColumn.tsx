import type { Run } from "@agent-dealer/shared";
import { NixieDisplay } from "../ui/NixieNumber";

type Props = {
  title: string;
  total: number;
  open: boolean;
  onToggle: () => void;
  accent: string;
  titleAccent: string;
  openRing?: string;
};

/** Narrow observability strip — total nixie count; click opens ticket panel. */
export default function PipelineQueueColumn({
  title,
  total,
  open,
  onToggle,
  accent,
  titleAccent,
  openRing = "ring-[#92E4DD]/25",
}: Props) {
  return (
    <section
      className={`flex flex-col self-start glass-column rounded-xl overflow-hidden border-t-2 ${accent} ${
        open ? `ring-1 ${openRing}` : ""
      }`}
    >
      <header className="px-2 pt-2 pb-2 border-b border-white/[0.06] shrink-0 w-full">
        <h2 className={`text-xs font-semibold leading-tight text-center ${titleAccent}`}>{title}</h2>

        <button
          type="button"
          onClick={onToggle}
          className="nixie-stack-toggle w-full rounded mt-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#92E4DD]/45"
          aria-expanded={open}
          aria-label={`${total} in ${title.toLowerCase()}. Click to ${open ? "close" : "show"} tickets.`}
        >
          <div className="nixie-display-wrap">
            <NixieDisplay value={total} />
          </div>
        </button>
      </header>
    </section>
  );
}
