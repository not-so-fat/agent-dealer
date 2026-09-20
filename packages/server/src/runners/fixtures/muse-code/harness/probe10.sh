#!/usr/bin/env bash
# NOT-177 probe 10: authentication failure, rate-limit, cancellation, signal exit behaviour.
# usage (from fixtures/muse-code): bash harness/probe10.sh <case>|all
# cases: auth-missing auth-bad-key auth-401-mock auth-401-mock-cold rate-limit-429-mock rate-limit-429-mock-cold
#        sigterm sigint sigterm-process-group sigkill-orphan cancel-resume-after-sigterm
set -m   # every background job gets its own process group (pgid == pid), so `kill -TERM -- -<pid>` signals the group
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
setup_workspace

# per-attempt settings.json used by every case except the two auth cases
SETTINGS='{"schema_version":1,"run":{"workflow_trigger_mode":"off","subagent_delegation_mode":"off"}}'
SLEEP_PROMPT='Run the shell command: sleep 9137. Then reply done.'
SESSION_FILE="$SPIKE_DIR/probe10.session-id"

auth_case() { # $1 = case, $2 = stdin key or empty
  local c=$1 key=$2; reset_case "$c"; setup_run noauth - noauth
  local args=(exec "${POSTURE[@]}" --max-model-steps 4)
  if [ -n "$key" ]; then
    args=(exec --api-key-stdin "${POSTURE[@]}" --max-model-steps 4)
    logline "$c" "( cd $WORKSPACE && printf %s $key | env -u META_API_KEY MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME=$RUN_CFG XDG_DATA_HOME=$RUN_DATA muse $(qjoin "${args[@]}" 'Reply ok') > $OUT_DIR/$c.jsonl 2> $OUT_DIR/$c.err ); echo \$? > $OUT_DIR/$c.rc"
    ( cd "$WORKSPACE" && printf %s "$key" | env -u META_API_KEY MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME="$RUN_CFG" XDG_DATA_HOME="$RUN_DATA" muse "${args[@]}" 'Reply ok' > "$OUT_DIR/$c.jsonl" 2> "$OUT_DIR/$c.err" ); echo $? > "$OUT_DIR/$c.rc"
  else
    logline "$c" "( cd $WORKSPACE && env -u META_API_KEY MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME=$RUN_CFG XDG_DATA_HOME=$RUN_DATA muse $(qjoin "${args[@]}" 'Reply ok') < /dev/null > $OUT_DIR/$c.jsonl 2> $OUT_DIR/$c.err ); echo \$? > $OUT_DIR/$c.rc"
    ( cd "$WORKSPACE" && env -u META_API_KEY MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME="$RUN_CFG" XDG_DATA_HOME="$RUN_DATA" muse "${args[@]}" 'Reply ok' < /dev/null > "$OUT_DIR/$c.jsonl" 2> "$OUT_DIR/$c.err" ); echo $? > "$OUT_DIR/$c.rc"
  fi
}

mock_case() { # $1 = case, $2 = port, $3 = status, $4 = retry-after or "", $5 = watchdog seconds, $6 = warm|cold
  # cold: fresh per-attempt data dir, so muse must fetch the model catalog from --base-url first (the mock answers that too).
  # warm: the catalog is first cached with one real call, so the mock is only hit by the inference request.
  local c=$1 port=$2 status=$3 retry=$4 wd_s=$5 mode=$6; reset_case "$c"; setup_run "$c" "$SETTINGS" auth
  if [ "$mode" = warm ]; then
    run_muse "$c-warmup" -- exec "${POSTURE[@]}" --max-model-steps 1 'Reply ok'
    sed '/^set -m$/d' "$OUT_DIR/$c-warmup.cmdlog" >> "$OUT_DIR/$c.cmdlog"
  fi
  logline "$c" "python3 harness/mock-provider.py $port $status $retry &"
  python3 "$HERE/mock-provider.py" "$port" "$status" $retry & local mock=$!
  logline "$c" "MOCK_PID=$mock"
  logline "$c" "for i in \$(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$port/ && break; sleep 0.25; done"
  local i; for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.25; done   # readiness
  local t0=$SECONDS
  start_muse "$c" -- exec "${POSTURE[@]}" --base-url "http://127.0.0.1:$port" --max-model-steps 4 'Reply ok'
  local pid=$MUSE_PID
  # watchdog: TERM after $wd_s seconds if muse is still running (429 retries do not end on their own)
  logline "$c" "( sleep $wd_s; kill -TERM $pid && echo watchdog TERM sent > $OUT_DIR/$c.watchdog ) &"
  ( sleep "$wd_s"; kill -TERM "$pid" 2>/dev/null && echo "watchdog TERM sent" > "$OUT_DIR/$c.watchdog" ) & local wd=$!
  finish "$c"
  logline "$c" "kill $wd"; kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  fact "$c" elapsed_s $((SECONDS - t0)); [ -f "$OUT_DIR/$c.watchdog" ] && fact "$c" watchdog_fired yes || fact "$c" watchdog_fired no
  logline "$c" "kill $mock"; kill "$mock" 2>/dev/null; wait "$mock" 2>/dev/null
}

signal_case() { # $1 = case, $2 = signal, $3 = pid|group
  local c=$1 sig=$2 scope=$3; reset_case "$c"
  logline "$c" "pkill -f 'sleep 9137'"; pkill -f 'sleep 9137' 2>/dev/null   # start from a clean process table
  local sid; sid=$(python3 -c 'import uuid;print(uuid.uuid4())')
  [ "$c" = sigterm ] && printf '%s' "$sid" > "$SESSION_FILE"
  setup_run "$c" "$SETTINGS" auth
  start_muse "$c" -- exec "${POSTURE[@]}" --session-id "$sid" --max-model-steps 10 "$SLEEP_PROMPT"
  local pid=$MUSE_PID
  wait_for_sleep_child "$c" 'sleep 9137' || { kill -KILL "-$pid" 2>/dev/null; finish "$c"; return 1; }
  local t0=$SECONDS target=$pid
  [ "$scope" = group ] && target="-$pid"
  logline "$c" "kill -$sig -- $target"           # the signal exactly as delivered (the muse pid, or -pid = the whole process group)
  kill "-$sig" -- "$target"
  finish "$c"
  fact "$c" signal_to_exit_s $((SECONDS - t0))
  logline "$c" "sleep 1"; sleep 1
  logline "$c" "pgrep -f 'sleep 9137' | wc -l"
  fact "$c" child_processes_after_exit "$(pgrep -f 'sleep 9137' | wc -l | tr -d ' ')"
  logline "$c" "pkill -KILL -f 'sleep 9137'"; pkill -KILL -f 'sleep 9137' 2>/dev/null; true   # cleanup only, after the observation
}

resume_case() {
  local c=cancel-resume-after-sigterm; reset_case "$c"
  local sid; sid=$(cat "$SESSION_FILE")
  # same XDG dirs and session id as the cancelled `sigterm` run (setup_run is deliberately NOT called again)
  RUN_CFG="$SPIKE_DIR/cfg-sigterm"; RUN_DATA="$SPIKE_DIR/data-sigterm"
  run_muse "$c" -- exec "${POSTURE[@]}" --session-id "$sid" --max-model-steps 4 'Reply with the single word: resumed'
}

case "${1:-all}" in
  auth-missing) auth_case auth-missing "" ;;
  auth-bad-key) auth_case auth-bad-key not-a-real-key ;;
  auth-401-mock) mock_case auth-401-mock 18401 401 "" 60 warm ;;
  auth-401-mock-cold) mock_case auth-401-mock-cold 18401 401 "" 60 cold ;;
  rate-limit-429-mock) mock_case rate-limit-429-mock 18429 429 30 100 warm ;;
  rate-limit-429-mock-cold) mock_case rate-limit-429-mock-cold 18429 429 30 100 cold ;;
  sigterm) signal_case sigterm TERM pid ;;
  sigint) signal_case sigint INT pid ;;
  sigterm-process-group) signal_case sigterm-process-group TERM group ;;
  sigkill-orphan) signal_case sigkill-orphan KILL pid ;;
  cancel-resume-after-sigterm) resume_case ;;
  all) for x in auth-missing auth-bad-key auth-401-mock auth-401-mock-cold rate-limit-429-mock rate-limit-429-mock-cold sigterm sigint sigterm-process-group sigkill-orphan cancel-resume-after-sigterm; do bash "$0" "$x"; done ;;
  *) echo "unknown case" >&2; exit 64 ;;
esac
