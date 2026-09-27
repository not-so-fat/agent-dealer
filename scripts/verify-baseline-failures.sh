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
# override with BASELINE_REF=<commit> for manual replays) and then, comparing
# individual failing TEST NAMES per file (not whole-file pass/fail, so a new
# failing test in an already-red file is still caught), normalized without TAP
# ordinals so renumbered pre-existing failures still match:
#   exit 0 — every test failing on HEAD also fails at the baseline
#            (pre-existing confirmed). Prints the baseline commit plus the
#            confirmed test name(s).
#   exit 1 — at least one test failing on HEAD does NOT fail at the baseline:
#            the file passes there, the file is new there (absent at baseline),
#            or the specific test name is new. Prints the failing test name(s)
#            and both commits (HEAD vs baseline).
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

# failing_test_names <output-log> : print normalized failing TEST NAMES, one per line.
# Normalization (so renumbered tests still compare equal across commits):
#   - strip the TAP ordinal ("not ok 3 - " -> ""), which shifts whenever tests
#     are added/removed earlier in the file;
#   - drop trailing "# TODO"/"# SKIP" directives;
#   - reduce absolute *.test.ts(x) paths (whole-file TAP failures) to their
#     basename, since the HEAD and baseline worktree roots always differ.
failing_test_names() {
  grep -E '^[[:space:]]*not ok' "$1" 2>/dev/null \
    | sed -E 's/^[[:space:]]*//' \
    | sed -E 's/^not ok [0-9]+ - //' \
    | sed -E 's/ # (TODO|SKIP).*//' \
    | sed -E 's|/[^ ]*/([^ /]+\.test\.tsx?)|\1|g' \
    | sort -u || true
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
# NOTE: `git worktree add` refuses an existing path (even an empty dir), so
# reserve a not-yet-existing child of a fresh temp dir as the worktree location.
WORKTREE_PARENT="$(mktemp -d)"
WORKTREE="$WORKTREE_PARENT/baseline"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$WORKTREE_PARENT" "$LOG_DIR"
}
trap cleanup EXIT

echo "[verify-baseline] HEAD=$HEAD baseline=$BASE"
# On PRs actions/checkout leaves HEAD on the temporary merge commit
# (refs/pull/N/merge), not the PR head itself — print both when known so
# readers are not confused by an unfamiliar HEAD SHA.
if [[ -n "${PR_HEAD_SHA:-}" ]]; then
  echo "[verify-baseline] PR head=${PR_HEAD_SHA} (HEAD is the merge commit)"
elif [[ -n "${GITHUB_SHA:-}" ]]; then
  echo "[verify-baseline] GITHUB_SHA=${GITHUB_SHA}"
fi
git -C "$ROOT" worktree add --detach --quiet "$WORKTREE" "$BASE"
echo "[verify-baseline] Setting up baseline worktree (npm ci + shared build)..."
(cd "$WORKTREE" && npm ci --no-audit --no-fund --quiet)
(cd "$WORKTREE" && npm run build --quiet -w @agent-dealer/shared)

declare -a PREEXISTING=()
declare -a REGRESSIONS=()
# Per-test comparison: a file that fails at baseline for ANY reason does not
# bless every HEAD failure in it. Only test names failing in BOTH runs are
# pre-existing; a name failing only on HEAD is a regression.
for f in "${FAIL_FILES[@]}"; do
  if [[ ! -f "$WORKTREE/$f" ]]; then
    echo "[verify-baseline] REGRESSION (new file, absent at baseline): $f" >&2
    REGRESSIONS+=("$f")
    continue
  fi
  blog="$(mktemp)"
  if run_suite_file "$WORKTREE" "$f" "$blog"; then
    echo "[verify-baseline] REGRESSION (passes at baseline, fails on HEAD): $f" >&2
    REGRESSIONS+=("$f")
    rm -f "$blog"
    continue
  fi
  head_names="$(failing_test_names "$(log_for "$f")")"
  base_names="$(failing_test_names "$blog")"
  rm -f "$blog"
  if [[ -z "$head_names" && -z "$base_names" ]]; then
    # No parseable TAP "not ok" names on either side (e.g. harness/setup error
    # on both): fall back to file-level verdict — both runs failed, so
    # pre-existing.
    echo "[verify-baseline] pre-existing confirmed (unparseable test names, both runs failed): $f" >&2
    PREEXISTING+=("$f")
    continue
  fi
  if [[ -z "$base_names" ]]; then
    # HEAD has specific failing test names but the baseline run produced none
    # (e.g. import/harness crash at the merge-base): nothing proves these
    # failures pre-date the branch, so fail closed as a regression.
    echo "[verify-baseline] REGRESSION (baseline produced no parseable failing test names to confirm against): $f" >&2
    echo "$head_names" | sed 's/^/[verify-baseline]   /' >&2
    REGRESSIONS+=("$f")
    continue
  fi
  if [[ -z "$head_names" ]]; then
    # HEAD failed without parseable names while the baseline failed with them:
    # no specific HEAD failure to dispute, so file-level pre-existing.
    echo "[verify-baseline] pre-existing confirmed (unparseable HEAD test names, both runs failed): $f" >&2
    PREEXISTING+=("$f")
    continue
  fi
  # Names failing on HEAD but not at the baseline are regressions.
  new_names="$(comm -23 <(printf '%s\n' "$head_names") <(printf '%s\n' "$base_names"))"
  if [[ -n "$new_names" ]]; then
    echo "[verify-baseline] REGRESSION (new failing test(s) not failing at baseline): $f" >&2
    echo "$new_names" | sed 's/^/[verify-baseline]   /' >&2
    REGRESSIONS+=("$f")
  else
    echo "[verify-baseline] pre-existing confirmed: $f" >&2
    PREEXISTING+=("$f")
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
  echo "[verify-baseline] REGRESSIONS (fail on HEAD=$HEAD but not at baseline=$BASE):"
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

echo "[verify-baseline] OK: all failing test name(s) in ${#PREEXISTING[@]} file(s) also fail at baseline $BASE."
