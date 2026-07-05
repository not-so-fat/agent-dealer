type Props = { className?: string };

/** Multiple agents — overlapping profiles for header nav. */
export default function AgentsNavIcon({ className = "w-5 h-5" }: Props) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <circle cx="6.75" cy="6.25" r="3.25" />
      <circle cx="13.5" cy="6.75" r="2.85" opacity="0.85" />
      <path d="M1.75 16v-1.1c0-2.35 1.928-4.25 4.3-4.25 1.16 0 2.21.456 3 1.2.79-.744 1.84-1.2 3-1.2 2.372 0 4.3 1.9 4.3 4.25V16H1.75z" />
    </svg>
  );
}
