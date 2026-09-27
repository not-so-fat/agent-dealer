#!/usr/bin/env bash
# NOT-274: verify "pre-existing failure" claims against the merge-base, don't trust them.
#
# Usage:
#   bash scripts/verify-baseline-failures.sh [test-file ...]
#
# With no args, failing test files are discovered by re-running each suite file
# on the current checkout (mirrors `npm run test:unit`'s file discovery).
# With args, exactly those files are treated as the current-branch failures.
#
# The script re-runs each failing file in a disposable git worktree checked out
# at the baseline commit (default: `git merge-base origin/main HEAD`,
# override with BASELINE_REF=<commit> for manual replays) and then:
#   exit 0 — every failing file also fails at the baseline (pre-existing confirmed).
#            Prints the baseline commit plus the confirmed test name(s).
#   exit 1 — at least one failing file PASSES at the baseline (real regression),
#            or is missing there (new file, so not pre-existing).
#            Prints the failing test name and both commits (HEAD vs baseline).
#
# Fail-closed: if no current-branch failure can be reproduced, the script exits
# non-zero rather than blessing an unknown state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE_REF="${BASELINE_REF:-}"

HEAD="$(git -C "$ROOT" rev-parse HEAD)"

resolve_baseline() {
  if [[ -n "$BASELINE_REF" ]]; then
    git -C "$ROOT" rev-parse --verify "$BASELINE_REF"
    return
  fi
  local base=""
  if base="$(git -C "$ROOT" merge-base origin/main HEAD 2>/dev/null)"; then
    printf '%s\n' "$base"
    return
  fi
  # Shallow CI checkouts have no merge-base; deepen just this failure-path run.
  git -C "$ROOT" fetch --quiet --unshallow origin main 2>/dev/null \
    || git -C "$ROOT" fetch --quiet origin main 2>/dev/null \
    || true
  git -C "$ROOT" merge-base origin/main HEAD
}

BASE="$(resolve_baseline)"

# failing_test_names <output-log> : print TAP "not ok" lines (the specific test names).
failing_test_names() {
  grep -E '^[[:space:]]*not ok' "$1" 2>/dev/null | sed -E 's/^[[:space:]]*//' | sort -u || true
}

# run_suite_file <tree-root> <file-relative-to-root> <output-log> : exit code of the run.
run_suite_file() {
  local tree="$1" rel="$2" log="$3"
  case "$rel" in
    apps/web/*)
      (cd "$tree/apps/web" && node --import tsx --test "${rel#apps/web/}" >"$log" 2>&1) || return $?
      ;;
    *)
      (cd "$tree" && AGENT_DEALER_SKIP_GITHUB_HEALTH=1 AGENT_DEALER_SKIP_AGENT_HEALTH=1 \
        npx tsx --test "$rel" >"$log" 2>&1) || return $?
      ;;
  esac
  return 0
}

discover_failing_files() {
  local f log status
  for f in $(cd "$ROOT" && find packages -name '*.test.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' | sort) \
           $(cd "$ROOT" && find apps/web/src \( -name '*.test.ts' -o -name '*.test.tsx' \) -not -path '*/node_modules/*' | sort); do
    log="$(mktemp)"
    if run_suite_file "$ROOT" "$f" "$log"; then
      rm -f "$log"
    else
      status=$?
      echo "[verify-baseline] FAIL on HEAD: $f (exit $status)" >&2
      echo "$f|$log"
    fi
  done
}

# ---- Current-branch failures (logs keyed by sanitized path; no assoc arrays) ----
LOG_DIR="$(mktemp -d)"
log_for() {
  printf '%s/%s.log' "$LOG_DIR" "$(printf '%s' "$1" | tr '/.' '__')"
}
declare -a FAIL_FILES=()
if [[ $# -gt 0 ]]; then
  for f in "$@"; do
    if [[ ! -f "$ROOT/$f" ]]; then
      echo "[verify-baseline] ERROR: no such file on HEAD: $f" >&2
      exit 2
    fi
    log="$(log_for "$f")"
    if run_suite_file "$ROOT" "$f" "$log"; then
      echo "[verify-baseline] NOTE: $f passes on HEAD; nothing to verify for it." >&2
      rm -f "$log"
    else
      echo "[verify-baseline] FAIL on HEAD: $f" >&2
      FAIL_FILES+=("$f")
    fi
  done
else
  while IFS='|' read -r f _log; do
    FAIL_FILES+=("$f")
    cp "$_log" "$(log_for "$f")"
    rm -f "$_log"
  done < <(discover_failing_files)
fi

if [[ ${#FAIL_FILES[@]} -eq 0 ]]; then
  echo "[verify-baseline] ERROR: could not reproduce any test failure on HEAD ($HEAD)." >&2
  echo "[verify-baseline] Refusing to confirm 'pre-existing'; investigate the original failure." >&2
  exit 2
fi

# ---- Baseline worktree ----
WORKTREE="$(mktemp -d)"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$WORKTREE" "$LOG_DIR"
}
trap cleanup EXIT

echo "[verify-baseline] HEAD=$HEAD baseline=$BASE"
git -C "$ROOT" worktree add --detach --quiet "$WORKTREE" "$BASE"
echo "[verify-baseline] Setting up baseline worktree (npm ci + shared build)..."
(cd "$WORKTREE" && npm ci --no-audit --no-fund --quiet)
(cd "$WORKTREE" && npm run build --quiet -w @agent-dealer/shared)

declare -a PREEXISTING=()
declare -a REGRESSIONS=()
for f in "${FAIL_FILES[@]}"; do
  if [[ ! -f "$WORKTREE/$f" ]]; then
    echo "[verify-baseline] REGRESSION (new file, absent at baseline): $f" >&2
    REGRESSIONS+=("$f")
    continue
  fi
  log="$(mktemp)"
  if run_suite_file "$WORKTREE" "$f" "$log"; then
    echo "[verify-baseline] REGRESSION (passes at baseline, fails on HEAD): $f" >&2
    REGRESSIONS+=("$f")
    rm -f "$log"
  else
    echo "[verify-baseline] pre-existing confirmed: $f" >&2
    PREEXISTING+=("$f")
    rm -f "$log"
  fi
done

echo ""
echo "[verify-baseline] Compared HEAD=$HEAD against baseline=$BASE."
if [[ ${#PREEXISTING[@]} -gt 0 ]]; then
  echo "[verify-baseline] Confirmed pre-existing failures at baseline $BASE:"
  for f in "${PREEXISTING[@]}"; do
    echo "  - $f"
    names="$(failing_test_names "$(log_for "$f")")"
    if [[ -n "$names" ]]; then
      echo "$names" | sed 's/^/      /'
    fi
  done
fi

if [[ ${#REGRESSIONS[@]} -gt 0 ]]; then
  echo "[verify-baseline] REGRESSIONS (fail on HEAD=$HEAD but pass at baseline=$BASE):"
  for f in "${REGRESSIONS[@]}"; do
    echo "  - $f"
    if [[ -f "$(log_for "$f")" ]]; then
      names="$(failing_test_names "$(log_for "$f")")"
      if [[ -n "$names" ]]; then
        echo "$names" | sed 's/^/      /'
      fi
    fi
  done
  exit 1
fi

echo "[verify-baseline] OK: all ${#PREEXISTING[@]} failing file(s) also fail at baseline $BASE."
