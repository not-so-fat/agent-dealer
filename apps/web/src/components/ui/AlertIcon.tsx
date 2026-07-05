type Props = { className?: string };

/** Small alert triangle — agent health / attention indicator. */
export default function AlertIcon({ className = "w-3.5 h-3.5" }: Props) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M8.982 1.566a1.13 1.13 0 0 0-1.964 0L.165 13.233c-.457.778.091 1.767.982 1.767h13.706c.891 0 1.439-.99.982-1.767L8.982 1.566zM8 5.697a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 5.697zm0 7.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"
      />
    </svg>
  );
}
