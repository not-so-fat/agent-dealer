import { useEffect, useState } from "react";
import type { AgentWithHealth, Runtime } from "@agent-dealer/shared";
import { fetchAgentDeckStatus } from "../../api";

type Props = {
  agents: AgentWithHealth[];
  agentDeckOnline: boolean;
};

function runtimeCliStatus(
  agents: AgentWithHealth[],
  runtime: Runtime
): { ok: boolean; detail: string } {
  const sample = agents.find((a) => a.runtime === runtime);
  if (!sample) return { ok: false, detail: "no agent" };
  const blocker = sample.issues.find(
    (i) => i.code === "cli_missing" || i.code === "runtime_auth"
  );
  if (blocker) return { ok: false, detail: blocker.message };
  return { ok: true, detail: "CLI ready" };
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-emerald-400" : "bg-amber-400"}`}
      aria-hidden
    />
  );
}

/** One-line runtime + optional Agent Deck MCP status — no configuration UI. */
export default function AgentConnectionsBar({ agents, agentDeckOnline }: Props) {
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);

  useEffect(() => {
    fetchAgentDeckStatus()
      .then((s) => setMcpUrl(s.mcpUrl))
      .catch(() => setMcpUrl(null));
  }, [agentDeckOnline]);

  const claude = runtimeCliStatus(agents, "claude_code");
  const cursor = runtimeCliStatus(agents, "cursor_local");
  const mcpIssue = agents
    .flatMap((a) => a.issues)
    .find((i) => i.code === "mcp_not_registered");

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 text-xs text-white/45">
      <span className="uppercase tracking-wider text-white/30">Connections</span>
      <span className="inline-flex items-center gap-1.5" title={claude.detail}>
        <StatusDot ok={claude.ok} />
        <span className={claude.ok ? "text-white/55" : "text-amber-200/90"}>Claude</span>
      </span>
      <span className="inline-flex items-center gap-1.5" title={cursor.detail}>
        <StatusDot ok={cursor.ok} />
        <span className={cursor.ok ? "text-white/55" : "text-amber-200/90"}>Cursor</span>
      </span>
      <span
        className="inline-flex items-center gap-1.5"
        title={mcpIssue?.message ?? (mcpUrl ? `MCP ${mcpUrl}` : "Agent Deck optional")}
      >
        <StatusDot ok={agentDeckOnline && !mcpIssue} />
        <span
          className={
            agentDeckOnline && !mcpIssue ? "text-[#92E4DD]/80" : mcpIssue ? "text-amber-200/90" : "text-white/35"
          }
        >
          Agent Deck MCP
          {agentDeckOnline ? (mcpIssue ? " (setup needed)" : "") : " (optional)"}
        </span>
      </span>
    </div>
  );
}
