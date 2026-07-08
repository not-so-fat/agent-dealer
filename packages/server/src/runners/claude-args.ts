import type { Run, TaskCategory } from "@agent-dealer/shared";
import { getTemporalOutputDir } from "../paths.js";

export const DENY_SEND_TOOL = "mcp__agent-deck__call_service_tool";

const DECK_READ_TOOLS =
  "mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace,mcp__agent-deck__list_service_tools";

const PLAN_REFLECT_TOOLS = `Read,Glob,Grep,Skill,${DECK_READ_TOOLS}`;

function executeToolsForCategory(category: TaskCategory): string {
  const base = ["Read", "Write", "Edit", "Glob", "Grep", "Skill", DECK_READ_TOOLS];
  if (category !== "communication" && category !== "email") {
    base.splice(5, 0, "Bash");
  }
  return base.join(",");
}

/** Build claude -p CLI args for a phase (excluding prompt, model, resume, mcp-config, budget). */
export function buildClaudePhaseArgs(
  run: Run,
  mode: "execute" | "plan" | "reflect"
): string[] {
  const args: string[] = ["--output-format", "stream-json", "--verbose"];

  if (mode === "plan" || mode === "reflect") {
    args.push("--allowedTools", PLAN_REFLECT_TOOLS);
  } else {
    args.push("--add-dir", getTemporalOutputDir());
    args.push("--allowedTools", executeToolsForCategory(run.taskCategory));
  }

  args.push("--disallowedTools", DENY_SEND_TOOL);
  return args;
}
