#!/usr/bin/env bash
# Shared helpers for the NOT-177 probe harness (sourced by probe8-9.sh and probe10.sh).
# Run the scripts from packages/server/src/runners/fixtures/muse-code (paths such as harness/mock-provider.py are relative to it).
#
# Environment (all optional):
#   SPIKE_DIR    scratch root, MUST be under $HOME (the sandbox treats /tmp as writable). Default: $HOME/muse-spike-run
#   MUSE_AUTH    operator auth.json to symlink into each per-run config dir. Default: $HOME/.config/muse/auth.json
#   OUT_DIR      where raw captures are written. Default: $SPIKE_DIR/out
#   DECK_ID      Agent Deck deck id for the MCP settings (only probes that need Agent Deck)
#
# For every case <name> the harness writes into $OUT_DIR:
#   <name>.jsonl   raw stdout of muse   <name>.err  raw stderr   <name>.rc  exit status
#   <name>.settings.json  the exact per-attempt settings.json (absent = no settings file)
#   <name>.cmdlog  the commands the case executed, in order, one shell line each (see logline): background launches with their
#                  redirections, readiness loops, timeouts/watchdogs, signals, waits, exit-status capture, child-process checks
#   <name>.facts   key=value observations taken by the harness (muse pid, child process counts, timings)
set -u
SPIKE_DIR="${SPIKE_DIR:-$HOME/muse-spike-run}"
MUSE_AUTH="${MUSE_AUTH:-$HOME/.config/muse/auth.json}"
OUT_DIR="${OUT_DIR:-$SPIKE_DIR/out}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL=muse-spark-1.3-contributor
case "$SPIKE_DIR" in "$HOME"/*) ;; *) echo "SPIKE_DIR must be under \$HOME" >&2; exit 64;; esac
mkdir -p "$OUT_DIR"

# Common flags of the recommended posture minus --session-id / --max-model-steps / prompt (added per case).
POSTURE=(--json --no-foreign-personal-context --model "$MODEL" --approval-mode never --approval-judge off --sandbox-network restricted --disable-web-tools)

# logline <case> <shell text>   append one line to the case's cmdlog
logline() { printf '%s\n' "$2" >> "$OUT_DIR/$1.cmdlog"; }
# qjoin args...   shell-quote args so a logged line can be pasted back into a shell
qjoin() { local o; o=$(printf '%q ' "$@"); printf '%s' "${o% }"; }
fact() { printf '%s=%s\n' "$2" "$3" >> "$OUT_DIR/$1.facts"; }
reset_case() { rm -f "$OUT_DIR/$1".{jsonl,err,rc,cmdlog,facts,watchdog,settings.json}; logline "$1" "set -m"; }

# setup_workspace: a git repo with one commit and a linked worktree $SPIKE_DIR/wt (the real Dealer layout)
setup_workspace() {
  if [ ! -d "$SPIKE_DIR/wt" ]; then
    mkdir -p "$SPIKE_DIR/repo"
    git -C "$SPIKE_DIR/repo" init -q -b main
    printf 'alpha\nbeta\ngamma\n' > "$SPIKE_DIR/repo/hello.txt"
    git -C "$SPIKE_DIR/repo" add hello.txt
    git -C "$SPIKE_DIR/repo" -c user.name=spike -c user.email=spike@example.invalid commit -q -m init
    git -C "$SPIKE_DIR/repo" worktree add -q -b spike-wt "$SPIKE_DIR/wt"
  fi
  WORKSPACE="$SPIKE_DIR/wt"
}

# setup_run <run> <settings.json|-> <auth|noauth>   creates CFG/DATA (0700) and exports RUN_CFG / RUN_DATA
setup_run() {
  local run=$1 settings=$2 auth=$3
  RUN_CFG="$SPIKE_DIR/cfg-$run"; RUN_DATA="$SPIKE_DIR/data-$run"
  rm -rf "$RUN_CFG" "$RUN_DATA"
  mkdir -p "$RUN_CFG/muse" "$RUN_DATA"; chmod 0700 "$RUN_CFG" "$RUN_DATA"
  [ "$auth" = auth ] && ln -s "$MUSE_AUTH" "$RUN_CFG/muse/auth.json"
  rm -f "$OUT_DIR/$run.settings.json"
  if [ "$settings" != - ]; then
    printf '%s\n' "$settings" > "$RUN_CFG/muse/settings.json"; chmod 0600 "$RUN_CFG/muse/settings.json"
    cp "$RUN_CFG/muse/settings.json" "$OUT_DIR/$run.settings.json"   # the exact settings file this run used
  fi
}

# start_muse <case> <extra env assignments...> -- <muse args...>
# Runs muse in the background in its OWN process group (the caller has `set -m`), stdin closed, stdout/stderr captured.
# Sets MUSE_PID (== process-group id).
start_muse() {
  local c=$1; shift
  local envs=(); while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  local envstr=""; [ ${#envs[@]} -gt 0 ] && envstr="${envs[*]} "
  logline "$c" "( cd $WORKSPACE && exec env ${envstr}MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME=$RUN_CFG XDG_DATA_HOME=$RUN_DATA muse $(qjoin "$@") ) < /dev/null > $OUT_DIR/$c.jsonl 2> $OUT_DIR/$c.err &"
  ( cd "$WORKSPACE" && exec env ${envs[@]+"${envs[@]}"} MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME="$RUN_CFG" XDG_DATA_HOME="$RUN_DATA" muse "$@" ) \
    < /dev/null > "$OUT_DIR/$c.jsonl" 2> "$OUT_DIR/$c.err" &
  MUSE_PID=$!
  logline "$c" "MUSE_PID=$MUSE_PID"
  fact "$c" muse_pid "$MUSE_PID"
}

# finish <case>  waits for MUSE_PID and records its exit status in <case>.rc
finish() {
  logline "$1" "wait $MUSE_PID; echo \$? > $OUT_DIR/$1.rc"
  wait "$MUSE_PID"; echo $? > "$OUT_DIR/$1.rc"
}

# run_muse <case> <extra env...> -- <muse args...>   start + finish with a watchdog (SIGTERM after RUN_TIMEOUT seconds)
run_muse() {
  local c=$1; shift
  start_muse "$c" "$@"
  local t0=$SECONDS t=${RUN_TIMEOUT:-300}
  logline "$c" "( sleep $t; kill -TERM $MUSE_PID ) &"
  ( sleep "$t"; kill -TERM "$MUSE_PID" 2>/dev/null ) & local wd=$!
  finish "$c"
  logline "$c" "kill $wd"
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  fact "$c" elapsed_s $((SECONDS - t0))
}

# wait_for_sleep_child <case> <marker>  blocks until the JSONL shows tool:bash AND the shell child exists
wait_for_sleep_child() {
  local c=$1 marker=$2 i
  logline "$c" "for i in \$(seq 1 240); do grep -q '\"operation\":\"tool:bash\"' $OUT_DIR/$c.jsonl && pgrep -f '$marker' > /dev/null && break; sleep 0.5; done"
  for i in $(seq 1 240); do
    if grep -q '"operation":"tool:bash"' "$OUT_DIR/$c.jsonl" 2>/dev/null && pgrep -f "$marker" > /dev/null; then
      logline "$c" "pgrep -f '$marker' | wc -l"
      fact "$c" child_processes_before_signal "$(pgrep -f "$marker" | wc -l | tr -d ' ')"
      return 0
    fi
    sleep 0.5
  done
  echo "shell child never appeared for $c" >&2; return 1
}
