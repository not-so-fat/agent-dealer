import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
};

/** Right-side detail / action panel for Inbox. */
export default function InboxPanel({ title, subtitle, onClose, children }: Props) {
  return (
    <aside className="w-full lg:w-[min(420px,40%)] shrink-0 border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col min-h-0 glass-column">
      <header className="px-4 py-3 border-b border-white/[0.06] flex items-start justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h2 className="heading-panel truncate">{title}</h2>
          {subtitle && <p className="text-caption mt-0.5">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost px-2 py-1 text-sm shrink-0"
          aria-label="Close panel"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">{children}</div>
    </aside>
  );
}
