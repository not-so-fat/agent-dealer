import { useEffect, type ReactNode } from "react";
import { isEditableKeyboardTarget } from "../../lib/keyboard";

type Props = {
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  onKeyDown?: (e: KeyboardEvent) => void;
};

/** Centered overlay shell shared by run review and inbox issue detail. */
export default function ReviewDrawer({ onClose, header, children, onKeyDown }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Queue Left/Right must not steal caret movement inside form fields.
      if (isEditableKeyboardTarget(e.target)) return;
      onKeyDown?.(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onKeyDown]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-[min(1200px,96vw)] h-[min(92vh,960px)] panel-surface flex flex-col text-[#E8F6F4] rounded-2xl overflow-hidden"
      >
        <div className="p-4 border-b border-white/10 space-y-3 shrink-0">{header}</div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
