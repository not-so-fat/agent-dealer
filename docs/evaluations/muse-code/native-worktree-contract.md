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

109 `muse_code` worker sessions have run across 55 issues since NOT-181 shipped. Dealer never
passes `-w`/`--worktree` in production (`muse-code-args.ts:31`); Muse always receives a
Dealer-created worktree as `cwd`. Error-reason breakdown (`error_json.reason`, 37 of 109 sessions):

| Category | Count | Unique to `muse_code`? |
|---|---|---|
| `Developer session produced no PR.` | 13 | No — task-completion, not worktree |
| **`local and origin/<branch> have diverged` (blocks a plain `git pull`)** | **10** | **Yes — 10/10, vs. 0/142 `claude_code`, 0/91 `codex_local`, 0/21 `cursor_local`** |
| `Developer's PR checks failed.` | 8 | No — CI, not worktree |
| `Developer session timed out.` (2 salvaged as `wip:` commits, 1 not) | 3 | No |
| `aborted_by_user` | 2 | No |
| other (transient GitHub API reset) | 1 | No |

The diverged-history pattern is the only worktree/git-identity-shaped signal in the data, and it's
100% concentrated on `muse_code`, on a code path that never touches `-w`/`--worktree`. It reads as:
Muse commits inside the worktree it's handed across multiple rounds, and at least one of those
rounds' pushes ends up with local and origin both holding commits the other doesn't — divergent,
not just behind, which is what forces "do not `git pull`" rather than a plain fast-forward.
Diagnosing the exact round-boundary mechanism is out of scope for this ticket (it would need
instrumenting a live Dealer run, not a disposable sandbox); see Follow-ups.

Muse's overall session error rate (37/109, 34%) sits between `claude_code` (17/142, 12%) and
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
  (`20260921-2d1b`) is date + short random suffix, chosen by Muse. But the first
  `session.workspace_branch.observed` event arrives at JSONL sequence 4, immediately after
  `run.model.configured` and before any `task.lifecycle.*` (tool call) event — i.e. before the
  first repository mutation, same bootstrap-ordering guarantee the (canceled) NOT-202 dogfood
  ticket wanted for Agent Deck context.
- **A second, independent machine-readable mapping exists on disk**, inside the target repo, not
  in Muse's config: `.muse/worktrees/.session-worktree-reservations/v1/by-session/<session-id>.json`
  and `.../by-leaf/<leaf>.json`, each `{"schema_version":1,"leaf":"20260921-2d1b","session_id":"aabcea85-...","backend":"git","source_binding":"git-storage-root"}`. Dealer could read this file
  directly as a fallback/cross-check without depending on capturing the JSONL stream.

## Probe 3: resume determinism

Four variants, same target worktree/session:

| Command | XDG state | Result |
|---|---|---|
| No `-w` flag, same `--session-id` | **same** attempt dir as probe 1-2 | Silently resumed in the *same* worktree, same branch — but only because the on-disk reservation file was visible from that XDG state. |
| No `-w` flag, same `--session-id` | **fresh** attempt dir | **Silently ran in `cwd` (the main checkout) on `main`, ignoring the prior worktree entirely.** No error, no warning distinguishable from a first run. |
| `-w existing`, **no** `--worktree-existing` | fresh attempt dir | Exit 2: `--worktree existing requires --worktree-existing`. Fails loud and fast. |
| `-w existing --worktree-existing <path>`, same `--session-id` | fresh attempt dir | Exit 0. Reattached correctly: stderr `session worktree retained at <path> (caller-owned worktree retained)`, new commit landed on the existing branch (`84f3a68` on top of `ca399e9`). |

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
about. After removal, `by-leaf/20260921-2d1b.json` (from a separate probe, below) was confirmed
still present and pointing at a leaf that no longer exists — a stale record an adapter would need
to either ignore or explicitly prune.

**Dirty completion** (no crash, session ends normally without committing): not separately
re-run — Muse's own bundled `git` skill, captured verbatim in probe 1-2's JSONL
(`task.lifecycle.output`, `read-skill-result name="bundled:git"`), states the policy directly:
*"never commit, amend, push, tag, rebase, cherry-pick, revert, or reset --hard unless the user
asked for that exact write in this session... Finishing a task without that request is not
authorization, so leave your work uncommitted for review."* So a normal exit with no explicit
commit instruction leaves the tree dirty, same as today. Dealer's existing timeout-salvage path
(`wip:` commit) already handles exactly this case for Dealer-owned worktrees — see Production
evidence above, where it fired twice in the last two days.

## Probe 5: concurrent access and collision

Three variants, all against the leaf created in probe 1-2 (owned by session `aabcea85-...`):

1. **Re-run `-w create --worktree-base main` with the same `--session-id`** (sequential, not
   concurrent): reused the existing worktree unchanged — `-w create` is idempotent per session-id,
   not "always make a new one." No duplicate leaf, no error.
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

| Dealer requirement | Dealer-owned (today) | Muse-owned (`-w create`/`existing`) |
|---|---|---|
| Exact developer tip (path + SHA) | Dealer sets `cwd`, reads git directly | Reported via `session.workspace_branch.observed`, plus the on-disk reservation file — works, but Dealer still has to capture and store it itself (same DB write it already does) |
| Push verification | Dealer's own git calls | Unaffected either way — Muse never pushes (confirmed: no push tool call in any captured transcript) |
| Reviewer checkout at that SHA | Dealer builds the reviewer's own worktree/checkout | **No change, and no option to change**: probe 5.2 shows a second session (the reviewer) cannot attach to the developer's Muse-owned worktree via `-w existing` — ownership is single-session by design. Dealer must keep building the reviewer's checkout independently regardless of which side owns the developer worktree. |
| Dirty-work salvage | Dealer's timeout/crash salvage commit | Same mechanism, same trigger conditions (probe 4) — nothing Muse-owned changes here |
| Safe cleanup | `git worktree remove --force` | Same command, same result (probe 4) — plus a new, Muse-only cruft surface (`.session-worktree-reservations/`) that plain `git worktree remove` doesn't clean up |

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
