import type { Runtime } from "@agent-dealer/shared";

export function runtimeLabel(runtime: Runtime | null | undefined): string {
  if (runtime === "claude_code") return "Claude";
  if (runtime === "cursor_local") return "Cursor";
  if (runtime === "codex_local") return "Codex";
  if (runtime === "muse_code") return "Muse Code";
  return "No agent";
}
