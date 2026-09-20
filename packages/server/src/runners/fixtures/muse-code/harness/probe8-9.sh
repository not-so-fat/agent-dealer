#!/usr/bin/env bash
# NOT-177 probe 8 (required MCP fails closed) and probe 9 (cron_create cannot be disabled).
# usage: bash harness/probe8-9.sh <case>
# cases: mcp-required-unreachable mcp-optional-unreachable cron-disable-attempt cron-attempt-1 cron-attempt-2 cron-attempt-3 cron-attempt-4a cron-attempt-4b
set -m
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
setup_workspace
DECK_ID="${DECK_ID:-00000000-0000-0000-0000-000000000000}"

REMINDERS='"runtime_capabilities":{"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":false}}'
OFF='"run":{"workflow_trigger_mode":"off","subagent_delegation_mode":"off"}'
mcp_settings() { # $1 = mode ; port 9 (discard) is not listening, so the server is unreachable
  printf '{"schema_version":1,%s,%s,"mcpServers":{"agent-deck":{"type":"streamable-http","url":"http://127.0.0.1:9/mcp","headers":{"x-agent-deck-deck-id":"%s","x-agent-deck-workspace":"%s"},"mode":"%s"}}}' "$OFF" "$REMINDERS" "$DECK_ID" "$WORKSPACE" "$1"
}
CRON_PROMPT='Use the cron_create tool to schedule a trivial job that echoes hi every minute, then reply with the tool result verbatim.'

case "${1:?case}" in
  mcp-required-unreachable) c=$1; reset_case $c; setup_run $c "$(mcp_settings required)" auth
    run_muse $c -- exec "${POSTURE[@]}" --max-model-steps 4 'Reply ok' ;;
  mcp-optional-unreachable) c=$1; reset_case $c; setup_run $c "$(mcp_settings optional)" auth
    run_muse $c -- exec "${POSTURE[@]}" --max-model-steps 4 'Reply ok' ;;
  cron-disable-attempt) c=$1; reset_case $c
    setup_run $c "{\"schema_version\":1,$OFF,\"runtime_capabilities\":{\"tool:cron_create\":{\"enabled\":false}}}" auth
    run_muse $c -- exec "${POSTURE[@]}" --session-id "$(python3 -c 'import uuid;print(uuid.uuid4())')" --max-model-steps 4 "$CRON_PROMPT"
    db=$(find "$RUN_DATA/muse/sessions" -name cron.db | head -1)
    Q='select cron_expr,prompt,recurring,fire_when_active_run,kind,permanent,(expires_at_ms-created_at_ms)/86400000.0 as ttl_days,fire_count,status from cron_jobs'
    logline $c "sqlite3 -json $db $(qjoin "$Q") > $OUT_DIR/cron-persisted-job.json"
    sqlite3 -json "$db" "$Q" > "$OUT_DIR/cron-persisted-job.json" ;;
  cron-attempt-1) c=$1; reset_case $c
    setup_run $c '{"schema_version":1,"execution":{"tool_rules":{"tool:cron_create":{"decision":"deny"}}}}' auth
    run_muse $c -- exec "${POSTURE[@]}" --max-model-steps 4 "$CRON_PROMPT" ;;
  cron-attempt-2) c=$1; reset_case $c
    setup_run $c '{"schema_version":1,"permissions":{"deny":["tool:cron_create"]}}' auth
    run_muse $c -- exec "${POSTURE[@]}" --max-model-steps 4 "$CRON_PROMPT" ;;
  cron-attempt-3) c=$1; reset_case $c
    setup_run $c '{"schema_version":1,"permissions":{"schema_version":1,"tool_rules":{"tool:cron_create":{"decision":"deny"}}}}' auth
    run_muse $c -- exec "${POSTURE[@]}" --max-model-steps 4 "$CRON_PROMPT" ;;
  cron-attempt-4a|cron-attempt-4b) c=$1; reset_case $c
    setup_run $c '{"schema_version":1,"permissions":{"schema_version":1,"profiles":{"noc":{"tool_rules":{"tool:cron_create":{"decision":"deny"}}}}}}' auth
    if [ "$c" = cron-attempt-4a ]; then   # full unattended posture + the profile
      run_muse $c -- exec "${POSTURE[@]}" --permission-profile noc --max-model-steps 4 "$CRON_PROMPT"
    else                                    # same, with --sandbox-network removed
      run_muse $c -- exec --json --no-foreign-personal-context --model "$MODEL" --approval-mode never --approval-judge off --disable-web-tools --permission-profile noc --max-model-steps 4 "$CRON_PROMPT"
    fi ;;
  *) echo "unknown case" >&2; exit 64 ;;
esac
