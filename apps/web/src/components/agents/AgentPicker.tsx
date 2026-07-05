import type { AgentWithHealth } from "@agent-dealer/shared";
import { runtimeLabel, runtimeTone } from "../../lib/display";
import Badge from "../ui/Badge";
import AlertIcon from "../ui/AlertIcon";
import { AgentRuntimeIcon } from "./AgentIcon";

type Props = {
  agents: AgentWithHealth[];
  selectedId: string;
  onSelect: (id: string) => void;
  onManage?: () => void;
  /** When true, unhealthy agents cannot be selected (no repo override available). */
  requireHealthy?: boolean;
};

export default function AgentPicker({ agents, selectedId, onSelect, onManage, requireHealthy }: Props) {
  if (agents.length === 0) {
    return <p className="text-sm text-white/45">No agents configured.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="heading-section normal-case">Agent</div>
        {onManage && (
          <button type="button" onClick={onManage} className="text-sm text-[#92E4DD] hover:underline">
            Manage
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {agents.map((agent) => {
          const selected = agent.id === selectedId;
          const disabled = requireHealthy && !agent.healthy;
          return (
            <button
              key={agent.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(agent.id)}
              className={`text-left rounded-xl border p-3 transition-colors glass-plate glass-plate-hover ${
                disabled
                  ? "opacity-50 cursor-not-allowed"
                  : selected
                    ? "glass-plate-selected"
                    : ""
              }`}
            >
              <div className="flex items-start gap-2.5">
                <AgentRuntimeIcon runtime={agent.runtime} className="h-7 w-7 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-[#E8F6F4]">{agent.name}</span>
                    {!agent.healthy && (
                      <span title={agent.issues.map((i) => i.message).join("; ")}>
                        <AlertIcon className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge className={runtimeTone(agent.runtime)}>{runtimeLabel(agent.runtime)}</Badge>
                    {agent.deckName && (
                      <Badge className="bg-[#92E4DD]/10 text-[#92E4DD] border-[#92E4DD]/25 normal-case">
                        ◆ {agent.deckName}
                      </Badge>
                    )}
                  </div>
                  {!agent.healthy && (
                    <p className="text-xs text-red-300/90 mt-2 leading-snug">{agent.issues[0]?.message}</p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
