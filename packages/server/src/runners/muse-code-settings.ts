// NOT-181: the per-attempt Muse `settings.json` for a developer session. From the NOT-177
// recommended posture (docs/evaluations/muse-code/headless-contract.md, "Command contract") with
// the `mcpServers` block omitted: Muse workers get no MCP servers and no Agent Deck.
//
// Muse cannot disable `cron_*` (NOT-177), so this file cannot either; the coordinator detects cron
// use after the fact (coordinator/muse-spawn.ts).

const REMINDERS = [
  "skill-reminder",
  "verify-reminder",
  "memory-reminder",
  "todo-reminder",
  "goal-reminder",
  "scope-reminder",
] as const;

export function buildMuseDeveloperSettings(): Record<string, unknown> {
  return {
    schema_version: 1,
    // Workflows and subagents are switched off so Dealer stays the only orchestrator.
    run: { workflow_trigger_mode: "off", subagent_delegation_mode: "off" },
    // Reminder children are extra hidden model runs per turn (~15 s and extra calls each).
    runtime_capabilities: Object.fromEntries(
      REMINDERS.map((name) => [`plugin:tbh-reminders:reminder:${name}`, { enabled: false }])
    ),
  };
}
