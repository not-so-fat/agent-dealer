import type { Runtime } from "@agent-dealer/shared";
import claudeLogo from "../../assets/logos/claude.svg";
import cursorLogo from "../../assets/logos/cursor.svg";

type IconProps = {
  className?: string;
};

function LogoTile({ src, className }: { src: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-lg bg-white/[0.04] ${className ?? "h-8 w-8"}`}
    >
      <img src={src} alt="" className="h-[70%] w-[70%] object-contain" draggable={false} />
    </span>
  );
}

export function ClaudeIcon({ className = "h-8 w-8" }: IconProps) {
  return <LogoTile src={claudeLogo} className={className} />;
}

export function CursorIcon({ className = "h-8 w-8" }: IconProps) {
  return <LogoTile src={cursorLogo} className={className} />;
}

export function GenericAgentIcon({ className = "h-8 w-8" }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="white" fillOpacity="0.06" />
      <circle cx="16" cy="13" r="4.5" stroke="#92E4DD" strokeWidth="1.75" />
      <path
        d="M8.5 24.5c1.2-3.5 3.8-5.5 7.5-5.5s6.3 2 7.5 5.5"
        stroke="#92E4DD"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AgentRuntimeLogo({
  runtime,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  runtime: Runtime | null;
  className?: string;
}) {
  if (runtime === "claude_code") {
    return <img src={claudeLogo} alt="" className={`object-contain ${className}`} draggable={false} />;
  }
  if (runtime === "cursor_local") {
    return <img src={cursorLogo} alt="" className={`object-contain ${className}`} draggable={false} />;
  }
  return null;
}

export function AgentRuntimeIcon({
  runtime,
  className = "h-8 w-8 shrink-0",
}: {
  runtime: Runtime;
  className?: string;
}) {
  if (runtime === "claude_code") return <ClaudeIcon className={className} />;
  if (runtime === "cursor_local") return <CursorIcon className={className} />;
  return <GenericAgentIcon className={className} />;
}
