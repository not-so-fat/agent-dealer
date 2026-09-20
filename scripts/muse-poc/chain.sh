#!/bin/bash
# Run every task in docs/evaluations/muse-code/tasks.json, both arms, one after another.
# Arm order alternates by task index: even index = candidate (muse) first, odd = baseline (claude) first.
# Starts paid Muse and Claude sessions. Results: $MUSE_POC_WORKDIR/runs/<task>/<arm>/result.json
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="${MUSE_POC_REPO:-$(git rev-parse --show-toplevel)}"
workdir="${MUSE_POC_WORKDIR:-${TMPDIR:-/tmp}/muse-poc}"
mkdir -p "$workdir/runs"; log="$workdir/chain.log"; : > "$log"
i=0
for id in $(python3 -c "import json,sys;print(*[t['id'] for t in json.load(open(sys.argv[1]))['tasks']])" "$repo/docs/evaluations/muse-code/tasks.json"); do
  if [ $((i % 2)) -eq 0 ]; then first=muse; second=claude; else first=claude; second=muse; fi
  i=$((i + 1))
  python3 "$here/harness.py" prepare "$id" > "$workdir/runs/$id.prepare.out" 2>&1 || { echo "prepare failed $id" >> "$log"; continue; }
  for arm in $first $second; do
    python3 "$here/harness.py" run "$id" "$arm" > "$workdir/runs/$id.$arm.out" 2>&1
    echo "done $id $arm exit=$?" >> "$log"
  done
done
echo "CHAIN COMPLETE" >> "$log"
