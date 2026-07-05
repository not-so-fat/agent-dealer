import type { ReactNode } from "react";

export default function Badge({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide border ${className}`}
    >
      {children}
    </span>
  );
}
