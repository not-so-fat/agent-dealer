# NOT-198: Muse-native worktree ownership evaluation

Evidence spike for one question (parent epic NOT-164): can Dealer stop owning the developer
worktree and let native Muse Code's own `-w`/`--worktree` mode own it instead, without losing
deterministic branch ownership, recovery, and reviewer handoff? No production runtime code was
changed. All CLI probes ran against a disposable local git repo, never against `agent-dealer` or
`agent-deck` itself.

## Conclusion

**`keep_dealer_owned`**, with one named unblock path recorded for a future ticket (Follow-ups).

Muse's `-w`/`--worktree` mode does report a stable, machine-readable worktree path and git
identity — probes 1-2 pass, correcting NOT-177's shallower "omit it, startup flag only" read of
the same flag. But every remaining probe shows Muse's ownership model asks Dealer to keep doing
exactly what it already does (track the path externally, detect crashes, decide salvage vs.
discard, build the reviewer's own checkout) while adding two new failure surfaces Dealer doesn't
have today: silent misattachment when the caller under-specifies `-w`, and worktree data loss
under same-session concurrent access. Nothing currently owned by Dealer's worktree lifecycle code
can be safely removed.

The one open, real production issue (git-history divergence, below) is **not** a worktree-ownership
problem — it happens entirely under the current Dealer-owned posture, where `-w` is never passed.
It should not be used as evidence for switching ownership models; it needs its own ticket.

## Production evidence (2026-09-20 → 2026-09-22, `dealer.db`, this machine)

This is not one of the six CLI probes below; it's the "do we already have data" question asked
before this ticket started, answered from the live `worker_sessions` table (read-only queries,
paths/branch names only — no prompt or code content extracted).

```sql
SELECT COUNT(*), COUNT(DISTINCT issue_id) FROM worker_sessions WHERE runtime='muse_code';
```
```
110|56
```

110 `muse_code` worker sessions have run across 56 issues since NOT-181 shipped (queried
2026-09-22 against `~/.agent-dealer/dealer.db`, read-only, paths/branch names only — no prompt or
code content extracted). Dealer never passes `-w`/`--worktree` in production
(`muse-code-args.ts:31`); Muse always receives a Dealer-created worktree as `cwd`.

```sql
SELECT
  CASE
    WHEN error_json LIKE '%have diverged%' THEN 'diverged_history'
    WHEN error_json LIKE '%produced no PR%' THEN 'no_pr'
    WHEN error_json LIKE '%PR checks failed%' THEN 'pr_checks_failed'
    WHEN error_json LIKE '%timed out%' THEN 'timed_out'
    WHEN error_json LIKE '%aborted_by_user%' THEN 'aborted'
    ELSE 'other'
  END as category, COUNT(*) as n
FROM worker_sessions WHERE runtime='muse_code' AND error_json IS NOT NULL AND error_json != ''
GROUP BY category ORDER BY n DESC;
```
```
category          n
----------------  --
no_pr             13
diverged_history  10
pr_checks_failed  8
timed_out         3
aborted           2
other             1
```

```sql
SELECT runtime, COUNT(*) as total,
  SUM(CASE WHEN error_json IS NOT NULL AND error_json != '' THEN 1 ELSE 0 END) as with_error,
  SUM(CASE WHEN error_json LIKE '%have diverged%' THEN 1 ELSE 0 END) as diverged
FROM worker_sessions GROUP BY runtime ORDER BY runtime;
```
```
runtime       total  with_error  diverged
------------  -----  ----------  --------
claude_code   143    17          0
codex_local   91     46          0
cursor_local  21     1           0
muse_code     110    37          10
```

The diverged-history pattern (exact text: `"local and origin/<branch> have diverged: local <sha>
is N commit(s) ahead, remote <sha> is M commit(s) ahead. Do not git pull — that integrates the
wrong history for a rewritten branch."`) is the only worktree/git-identity-shaped signal in the
data, and it's 100% concentrated on `muse_code` (10/10), zero on the other three runtimes across
255 combined sessions (143 + 91 + 21, from the per-runtime table above) — on a code path that never touches `-w`/`--worktree`. Both local and
remote hold commits the other doesn't (not just "behind"), which is what forces "do not `git
pull`" rather than a plain fast-forward. This report does not know the round-by-round mechanism
that produces that divergence — no push-timing or per-round transcript data was pulled, only the
final stored `error_json.reason` string per session — so no causal claim is made here beyond "it's
muse-specific and it's a real, recurring, already-encountered cost of the current design, not a
hypothetical." Diagnosing the mechanism needs instrumenting a live Dealer run, not a disposable
sandbox; see Follow-ups.

Muse's overall session error rate (37/110, 34%) sits between `claude_code` (17/143, 12%) and
`codex_local` (46/91, 51%) — Muse is not uniquely unreliable overall, only uniquely affected by
this one divergence pattern.

## Pins

Same posture as NOT-177/NOT-183: Muse Code `1.3.0 (1.3.0-R3401.1)`, `MUSE_NO_AUTO_UPDATE=1`,
model `muse-spark-1.3-contributor`, per-attempt `XDG_CONFIG_HOME`/`XDG_DATA_HOME` (`0700`) with
`auth.json` symlinked in (never read), sandbox on, `--approval-mode never --approval-judge off
--disable-web-tools --no-foreign-personal-context`, no MCP servers, no Agent Deck. Target: a
disposable local repo at `$SCRATCH/not198/sandbox-repo` (one commit, `main`), never the operator's
real repositories.

## Probe 1-2: worktree path, git identity, base-ref selection

```
cd sandbox-repo && MUSE_NO_AUTO_UPDATE=1 XDG_CONFIG_HOME=... XDG_DATA_HOME=... \
  muse exec --json --no-foreign-personal-context --model muse-spark-1.3-contributor \
  --approval-mode never --approval-judge off --disable-web-tools \
  --session-id <UUID> --max-model-steps 6 \
  -w create --worktree-base main \
  "Change the single line in app.txt from 'value = 1' to 'value = 2'. Make exactly one commit..."
```

Exit 0. Two `session.workspace_branch.observed` JSONL events (start and end of run, `payload_type`
field, not assistant text):

```json
{"workspace_root": ".../sandbox-repo/.muse/worktrees/20260921-2d1b",
 "reference": {"kind": "branch", "name": "muse/session-aabcea85-db8d-4bd0-8c47-a3c77a541407"},
 "vcs": "git", "commit": "f4b43e7f3488"}
...
{"workspace_root": ".../sandbox-repo/.muse/worktrees/20260921-2d1b",
 "reference": {"kind": "branch", "name": "muse/session-aabcea85-db8d-4bd0-8c47-a3c77a541407"},
 "vcs": "git", "commit": "ca399e94e406"}
```

This is a real machine-readable event, not the model's final text (the final text also happens to
mention the path in a markdown link — the two agree here, but only the `payload_type:
"session.workspace_branch.observed"` event is a contract Dealer could parse). It gives absolute
path, branch name, VCS kind, and commit SHA at both the start and end of the run.

Findings:

- **Base ref selection works.** `--worktree-base main` resolved to `main`'s HEAD
  (`f4b43e7f3488`, the exported repo's only commit) as the first-observed commit.
- **Branch name is deterministic and caller-computable.** It's always
  `muse/session-<session-id, lowercased>` — the caller can predict it from the `--session-id` it
  already chose, without reading any event.
- **Worktree path is not predictable, but is discoverable before first mutation.** The leaf
  (`20260921-2d1b`) is date + short random suffix, chosen by Muse. The first
  `session.workspace_branch.observed` event arrives before any `task.lifecycle.*` (tool call)
  event — i.e. before the first repository mutation, same bootstrap-ordering guarantee the
  (canceled) NOT-202 dogfood ticket wanted for Agent Deck context. `payload_type` per JSONL
  `sequence` for this run's first six records:

  ```
  1 runtime.command.accepted
  2 session.run.linked
  3 run.model.configured
  4 session.workspace_branch.observed   <- worktree path/branch/commit, before run.lifecycle.started
  5 turn.input.user
  6 run.lifecycle.started
  ```
- **A second, independent machine-readable mapping exists on disk**, inside the target repo, not
  in Muse's config: `.muse/worktrees/.session-worktree-reservations/v1/by-session/<session-id>.json`
  and `.../by-leaf/<leaf>.json`, each `{"schema_version":1,"leaf":"20260921-2d1b","session_id":"aabcea85-...","backend":"git","source_binding":"git-storage-root"}`. Dealer could read this file
  directly as a fallback/cross-check without depending on capturing the JSONL stream.

## Probe 3: resume determinism

Four variants, same target worktree/session (`--session-id aabcea85-...`, prompt: `"Run 'pwd &&
git log --oneline -3 && git branch --show-current' and report the output verbatim. Do not edit any
files."`):

| # | Command | XDG state | Verdict |
|---|---|---|---|
| 1 | No `-w` flag, same `--session-id` | same attempt dir as probe 1-2 | Resumed correctly |
| 2 | No `-w` flag, same `--session-id` | fresh attempt dir | **Silently wrong** — ran in `cwd` on `main` |
| 3 | `-w existing`, no `--worktree-existing` | fresh attempt dir | Exit 2, fails loud |
| 4 | `-w existing --worktree-existing <path>`, same `--session-id` | fresh attempt dir | Reattached correctly |

1. Same XDG state as probe 1-2: stderr `muse: workspace root: .../20260921-2d1b (explicit)` ...
   `session worktree retained at .../20260921-2d1b (caller-owned worktree retained)`. Final answer:
   `.../20260921-2d1b`, `ca399e9 probe-a: bump value`, `f4b43e7 initial commit`,
   `muse/session-aabcea85-...`. Resumed the *same* worktree/branch — but only because the on-disk
   reservation file was visible from that XDG state.
2. Fresh XDG state, same command otherwise: stderr `muse: workspace root: .../sandbox-repo (cwd
   default)`. Final answer: `.../sandbox-repo`, `f4b43e7 initial commit`, `main`. **Silently ran in
   `cwd` (the main checkout) on `main`, ignoring the prior worktree entirely** — same command, same
   `--session-id`, only the XDG state differs, and the `(cwd default)` vs. `(explicit)` stderr tag
   is the only distinguishing signal, not an error or warning.
3. Exit 2: `--worktree existing requires --worktree-existing`. Fails loud and fast.
4. Exit 0. Reattached correctly: stderr `session worktree retained at <path> (caller-owned
   worktree retained)`, new commit landed on the existing branch (`84f3a68` on top of `ca399e9`).

Resume is deterministic **only** when the caller explicitly re-supplies `-w existing
--worktree-existing <path>` with the original `--session-id`. Session-id alone is not sufficient
across the per-attempt isolated `XDG_DATA_HOME`/`XDG_CONFIG_HOME` that NOT-177's own recommended
posture requires — and the failure mode when it's insufficient is silent misattachment to `cwd`,
not an error. Any adapter that assumed "pass the same `--session-id` and Muse remembers" would be
wrong in exactly the isolated-per-attempt setup Dealer is pinned to use.

## Probe 4: clean, crash, and dirty-completion ownership

**Clean completion** (probe 1-2, probe 3 row 4): worktree left registered in `git worktree list`,
working tree clean, on-disk state matches the reported commit exactly.

**Process crash** (`SIGKILL` mid-run, own PID only — verified no other process on the machine was
touched): the run was killed 8s into a deliberate `sleep 25` before it had made any edit.

```
kill -9 <own pid>
```

Result: the worktree directory and its `git worktree` registration both survive on disk untouched
(`git worktree list` still lists it, `git status` reports clean — nothing was mid-write). Dealer's
**existing** recovery primitive works unmodified on a Muse-created worktree:

```
git worktree remove --force .muse/worktrees/20260921-8e5f   # exit 0, cleanly deregistered
```

The branch (`muse/session-7f9f1f49-...`) survives the removal, as normal for `git worktree
remove`. What does **not** get cleaned up by that command: the
`.session-worktree-reservations/v1/by-session/*.json` and `by-leaf/*.json` files — those are a
Muse-internal bookkeeping layer inside the repo tree that plain `git worktree remove` doesn't know
about. Checked directly against this same removed leaf, after the `git worktree remove --force`
above and confirming `git worktree list` no longer showed it:

```
$ cat .muse/worktrees/.session-worktree-reservations/v1/by-leaf/20260921-8e5f.json
{"schema_version":1,"leaf":"20260921-8e5f","session_id":"7f9f1f49-...","backend":"git","source_binding":"git-storage-root"}
$ cat .muse/worktrees/.session-worktree-reservations/v1/by-session/7f9f1f49-14cc-4b37-89bb-3d7af827309f.json
{"schema_version":1,"leaf":"20260921-8e5f","session_id":"7f9f1f49-...","backend":"git","source_binding":"git-storage-root"}
```

Both files are still there, still pointing at a leaf `git worktree list` no longer knows about — a
stale record an adapter would need to either ignore or explicitly prune. (Probe 5.3 independently
hits the same kind of stale record through a different, non-clean removal path — a worktree
destroyed by concurrent access rather than an explicit `remove`; that is separate evidence for the
same class of gap, not a substitute for it.)

**Dirty completion** (no crash, session ends normally without committing): not separately
re-run — Muse's own bundled `git` skill, captured verbatim in probe 1-2's JSONL
(`task.lifecycle.output`, `read-skill-result name="bundled:git"`), states the policy directly:
*"never commit, amend, push, tag, rebase, cherry-pick, revert, or reset --hard unless the user
asked for that exact write in this session... Finishing a task without that request is not
authorization, so leave your work uncommitted for review."* So a normal exit with no explicit
commit instruction leaves the tree dirty, same as today. Dealer's existing timeout-salvage path
already handles exactly this case for Dealer-owned worktrees — of the 3 `timed_out` `muse_code`
sessions in Production evidence above, 2 carry `error_json.reason` `"Developer session timed out.
Salvaged uncommitted work as wip: timeout salvage (<sha>)."` (session ids `e4499b9f-...` and
`4b97c9c8-...`); the third (`4946f385-...`) has no salvage suffix, i.e. nothing uncommitted was
left to salvage.

## Probe 5: concurrent access and collision

Three variants, all against the leaf created in probe 1-2 (owned by session `aabcea85-...`):

1. **Re-run `-w create --worktree-base main` with the same `--session-id`** (sequential, not
   concurrent): exit 0, stderr `muse: workspace root: .../20260921-2d1b (cwd default)`, and the
   `session.workspace_branch.observed` event reports `{"workspace_root": ".../20260921-2d1b",
   "reference": {"name": "muse/session-aabcea85-..."}, "commit": "84f3a6890ccf"}` — `84f3a68` is
   the same commit probe 3's row 4 had already landed there, not a new one. Reused the existing
   worktree unchanged — `-w create` is idempotent per session-id, not "always make a new one." No
   duplicate leaf, no error.
2. **`-w existing --worktree-existing <path>` with a *different* `--session-id`** (the leaf's
   owner is `aabcea85-...`; tried `a1a2388c-...`): exit 1, `session worktree requires a Git source
   repository: <path>`. Ownership is enforced by session-id, not just by path — a session cannot
   attach to a worktree it didn't create. The error text is misleading (it reads like a missing-repo
   error, not an ownership-mismatch error), which would make this failure mode hard to diagnose
   from logs alone.
3. **Two processes, the *same*, correctly-owning `--session-id`, both `-w existing
   --worktree-existing <same path>`, launched concurrently:**

   ```
   ( muse exec ... --session-id aabcea85-... -w existing --worktree-existing <path> "...append + commit g1" ) &
   ( muse exec ... --session-id aabcea85-... -w existing --worktree-existing <path> "...append + commit g2" ) &
   wait
   ```

   Both processes exited 1 with the same `session worktree requires a Git source repository`
   error — but this time it wasn't an ownership rejection, it was real damage: **the worktree
   directory itself was gone afterward.** `git worktree list` in the main repo no longer listed it
   at all (its sibling leaf from the crash probe still did), and the directory was physically
   removed (`cd` into it failed, "no such file or directory"). The branch and its prior commits
   (`f4b43e7` → `ca399e9` → `84f3a68`) survived intact in `git branch -a`, so no committed work
   was lost — but nothing prevented the two processes from tearing down a worktree that one of them
   was still using. The stale `by-leaf/20260921-2d1b.json` reservation record survived the
   deletion, still claiming a leaf that no longer exists.

Same-session concurrent access to an existing Muse worktree is **not safe**: Muse provides no
locking beyond session-id ownership, and ownership alone doesn't prevent two processes holding the
same session-id from racing each other into worktree removal. This is exactly the "retry launched
before the coordinator has confirmed the previous attempt is truly dead" scenario Dealer's own
`process_pid`/`process_owner`/`process_started_at` liveness check (NOT-124/131) exists to prevent —
and that check would still be entirely Dealer's job under Muse ownership, because Muse doesn't do
it itself.

## Probe 6: mapping to Dealer's required handoff

| Dealer requirement | Dealer-owned (today) | Muse-owned (`-w create`/`existing`) | Changes? |
|---|---|---|---|
| Exact developer tip (path + SHA) | Reads git directly | Reported via `session.workspace_branch.observed` + reservation file | No — Dealer still stores it itself |
| Push verification | Dealer's own git calls | Muse never pushes (grep, below) | No |
| Reviewer checkout at that SHA | Dealer builds it | Can't reuse dev's worktree — cross-session attach is rejected (probe 5.2) | No — still Dealer's job |
| Dirty-work salvage | Timeout/crash salvage commit | Same trigger conditions (probe 4) | No |
| Safe cleanup | `git worktree remove --force` | Same command + new `.session-worktree-reservations/` cruft (probe 4) | **Worse** |

Push verification: `grep -o '"command":"[^"]*"' attempts/*.jsonl | grep -i push` across every
captured transcript (probes 1-2 through 5) returns no match — no session ran a push.

No line in this table is something Dealer could delete from its worktree lifecycle code if it
adopted `-w`/`--worktree`. Every Dealer responsibility today stays a Dealer responsibility; the
only thing that would change is trading Dealer's own `git worktree add` call for a `-w create`
flag, while taking on two new failure modes (probe 3's silent-misattachment footgun, probe 5.3's
concurrent-access data loss) that don't exist in the current design.

## Follow-ups

1. **File a separate ticket for the git-divergence pattern** (Production evidence section): 10
   occurrences, 100% on `muse_code`, 0% on any other runtime, all under the current Dealer-owned
   posture where `-w` is never passed. Root cause needs instrumenting a real multi-round Dealer
   run (which round's push stops matching the next round's fresh checkout), not a disposable
   sandbox — out of scope here.
2. **Unblock path for a future revisit, not adopted now:** Dealer keeps creating and owning the
   worktree exactly as today (`git worktree add`, `cwd` handoff), but additionally invokes Muse
   with `-w existing --worktree-existing <dealer-owned-path>` instead of omitting `-w`. This adds
   Muse's own `session.workspace_branch.observed` events as a non-load-bearing cross-check against
   Dealer's own bookkeeping — no ownership transfer, no new failure surface, strictly additive
   observability. Worth its own small ticket if the divergence investigation above turns up a case
   where an independent git-identity signal from Muse would have caught the problem earlier.
