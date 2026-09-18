export const DENY_SEND_TOOL = "mcp__agent-deck__call_service_tool";

const DECK_READ_TOOLS =
  "mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace,mcp__agent-deck__list_service_tools";

const REFLECT_TOOLS = `Read,Glob,Grep,Skill,${DECK_READ_TOOLS}`;

/**
 * Build claude -p CLI args for the reflect phase (excluding prompt, mcp-config and budget).
 * NOT-71 removed the plan/execute/qa phases with the run product they belonged to, so the
 * only policy left here is reflect's: read the repo and the playbook, never write, never
 * `call_service_tool` (the deck write path stays denied — reflect proposes a patch through
 * the server's own authority, not the agent's).
 */
export function buildClaudeReflectArgs(): string[] {
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    REFLECT_TOOLS,
    "--disallowedTools",
    DENY_SEND_TOOL,
  ];
}
