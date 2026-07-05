import type { ReactNode } from "react";

type Props = {
  title: string;
  count?: number;
  children: ReactNode;
  empty?: ReactNode;
  isEmpty?: boolean;
  /** Top border accent, e.g. border-t-cyber-violet */
  accent?: string;
  /** Title tint matching column stage */
  titleAccent?: string;
};

/** Autoship / Composio AO-style pipeline column shell. */
export default function KanbanColumn({ title, count, children, empty, isEmpty, accent, titleAccent }: Props) {
  return (
    <section
      className={`flex flex-col min-w-0 h-full glass-column rounded-xl overflow-hidden ${accent ? `border-t-2 ${accent}` : "border-t border-white/[0.06]"}`}
    >
      <header className="px-4 pt-3 pb-2.5 border-b border-white/[0.06] shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className={`heading-column ${titleAccent ?? ""}`}>{title}</h2>
          {count !== undefined && (
            <span className="text-base tabular-nums text-white/45">{count}</span>
          )}
        </div>
      </header>
      <div className="flex-1 min-h-0 p-2 space-y-2 overflow-y-auto">
        {isEmpty ? empty : children}
      </div>
    </section>
  );
}
