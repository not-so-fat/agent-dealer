#!/usr/bin/env python3
"""Run one Muse Code task in a fresh git worktree, in the posture NOT-177 found safest.

Operator-run trial helper: it starts a paid contributor-tier Muse session and sends the prompt to
Meta's contributor tier. Use it only on non-sensitive work, and read the transcript afterwards.
See scripts/muse-poc/README.md.

  muse-task.py "<prompt>" [--repo DIR] [--timeout SECONDS] [--max-steps N] [--base REF]

Nothing is committed or merged for you. The worktree is left in place for review.
"""
import argparse, json, os, re, shutil, signal, subprocess, sys, tempfile, time, uuid

MODEL = "muse-spark-1.3-contributor"
HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompt")
    ap.add_argument("--repo", default=".", help="git repository to work in (default: current directory)")
    ap.add_argument("--base", default="HEAD", help="ref the worktree starts from (default: HEAD)")
    ap.add_argument("--timeout", type=int, default=3600, help="wall-clock limit in seconds (default: 3600)")
    ap.add_argument("--max-steps", type=int, default=300, help="--max-model-steps (default: 300)")
    a = ap.parse_args()

    repo = run(["git", "-C", a.repo, "rev-parse", "--show-toplevel"]).stdout.strip()
    if not repo:
        sys.exit(f"{a.repo} is not a git repository")
    muse = os.environ.get("MUSE_BIN") or shutil.which("muse")
    if not muse:
        sys.exit("muse not found on PATH (set MUSE_BIN)")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    root = os.path.join(os.environ.get("MUSE_TASK_DIR") or os.path.join(tempfile.gettempdir(), "muse-task"), stamp)
    wt, cfg, data = f"{root}/wt", f"{root}/xdg-config", f"{root}/xdg-data"
    os.makedirs(f"{cfg}/muse"); os.makedirs(data); os.chmod(cfg, 0o700); os.chmod(data, 0o700)
    branch = f"muse/{stamp}"
    r = run(["git", "-C", repo, "worktree", "add", "-b", branch, wt, a.base])
    if r.returncode:
        sys.exit(r.stderr.strip())

    # NOT-177 recommended settings, minus the MCP server: workflows, subagents and reminder plugins off.
    tpl = json.load(open(f"{repo}/packages/server/src/runners/fixtures/muse-code/settings/recommended.settings.template.json"))
    tpl.pop("mcpServers", None)
    json.dump(tpl, open(f"{cfg}/muse/settings.json", "w"))
    os.symlink(os.path.expanduser("~/.config/muse/auth.json"), f"{cfg}/muse/auth.json")  # never read or copied

    env = dict(os.environ, MUSE_NO_AUTO_UPDATE="1", XDG_CONFIG_HOME=cfg, XDG_DATA_HOME=data)
    cmd = [muse, "exec", "--json", "--no-foreign-personal-context", "--model", MODEL, "--approval-mode", "never",
           "--approval-judge", "off", "--sandbox-network", "restricted", "--disable-web-tools",
           "--session-id", str(uuid.uuid4()), "--max-model-steps", str(a.max_steps), a.prompt]
    print(f"worktree: {wt}\nbranch:   {branch}\nrunning Muse ({MODEL}); timeout {a.timeout}s ...", flush=True)
    out = open(f"{root}/stdout.jsonl", "w"); err = open(f"{root}/stderr.txt", "w")
    t0 = time.time(); timed_out = False
    p = subprocess.Popen(cmd, cwd=wt, env=env, stdout=out, stderr=err, start_new_session=True)
    try:
        p.wait(timeout=a.timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(p.pid, signal.SIGTERM)
        try: p.wait(timeout=20)
        except subprocess.TimeoutExpired: os.killpg(p.pid, signal.SIGKILL); p.wait()
    wall = time.time() - t0
    out.close(); err.close()

    models, tokens, cron = set(), {}, False
    for dirpath, _, files in os.walk(data):
        for f in files:
            if f != "session.jsonl": continue
            for line in open(os.path.join(dirpath, f), errors="ignore"):
                if '"model_completed"' in line:
                    ev = json.loads(line).get("payload", {}).get("event", {})
                    if ev.get("kind") == "model_completed":
                        if ev.get("model"): models.add(ev["model"])
                        for k, v in (ev.get("usage") or {}).items():
                            if isinstance(v, (int, float)): tokens[k] = tokens.get(k, 0) + v
    stdout_text = open(f"{root}/stdout.jsonl", errors="ignore").read()
    cron = bool(re.search(r"cron_(create|list|delete)", stdout_text))
    stat = run(["git", "-C", wt, "status", "--short"]).stdout.strip().splitlines()
    ok_model = models == {MODEL}

    print(f"\nexit code:  {p.returncode}{'  (TIMED OUT)' if timed_out else ''}")
    print(f"wall time:  {wall:.0f} s")
    print(f"model:      {sorted(models)}  -> {'OK, contributor only' if ok_model else 'NOT the contributor model, do not trust this run'}")
    print(f"tokens:     {tokens or 'unreported'}   cost: unreported (Muse reports none)")
    print(f"cron_ use:  {'YES - read the transcript before trusting this run' if cron else 'none seen'}")
    print(f"changes:    {len(stat)} file(s) changed in the worktree" + ("" if not stat else "\n            " + "\n            ".join(stat[:10])))
    print(f"transcript: {root}/stdout.jsonl")
    print(f"\nReview: git -C {wt} diff\nClean up: git -C {repo} worktree remove --force {wt} && git -C {repo} branch -D {branch}")
    sys.exit(0 if ok_model and p.returncode == 0 and not timed_out else 1)


if __name__ == "__main__":
    main()
