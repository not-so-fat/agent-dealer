import type { ReactNode } from "react";

type Props = {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  bordered?: boolean;
};

export default function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
  bordered = true,
}: Props) {
  return (
    <section className={`space-y-2 ${bordered ? "border-t border-white/10 pt-3" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="heading-section">{title}</span>
        <span className="text-xs text-white/40">{open ? "Hide" : "Show"}</span>
      </button>
      {open && children}
    </section>
  );
}
