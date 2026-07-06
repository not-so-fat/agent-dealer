import type { ReactNode } from "react";
import ReviewDrawer from "../drawer/ReviewDrawer";

type Props = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
};

/** Centered overlay for inbox import / manual forms — same shell as issue detail. */
export default function InboxPanel({ title, subtitle, onClose, children }: Props) {
  return (
    <ReviewDrawer
      onClose={onClose}
      header={
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="font-semibold text-2xl leading-snug">{title}</h2>
            {subtitle && <p className="text-sm text-white/55 leading-snug">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/60 hover:text-white px-1 shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      }
    >
      <div className="space-y-4">{children}</div>
    </ReviewDrawer>
  );
}
