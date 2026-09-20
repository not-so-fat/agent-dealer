#!/usr/bin/env python3
"""Muse Code PoC run harness (NOT-183 / NOT-187). Operator-run: it starts paid Muse and Claude sessions.

Both arms get: an identical prompt, a history-free export of startingSha (no reference commits in the
repository), the same pre-installed node_modules, the same timeout, no MCP servers and no deck.
See scripts/muse-poc/README.md.
"""
import json, os, re, shutil, signal, subprocess, sys, tempfile, time, uuid

USAGE = """usage: harness.py prepare TASK_ID
       harness.py dry-verify TASK_ID      verify the untouched start tree (must fail; starts no model)
       harness.py run TASK_ID muse|claude one arm of one task (starts a paid model session)

environment:
  MUSE_POC_REPO     checkout holding docs/evaluations/muse-code/tasks.json   (default: git toplevel of cwd)
  MUSE_POC_WORKDIR  where runs are written; never committed                  (default: $TMPDIR/muse-poc)
  MUSE_BIN          Muse Code binary                                          (default: muse on PATH)
  CLAUDE_BIN        Claude Code binary                                        (default: claude on PATH)
"""
if len(sys.argv) < 3 or sys.argv[1] not in ("prepare", "dry-verify", "run"):
    sys.exit(USAGE)

REPO = os.environ.get("MUSE_POC_REPO") or subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
ROOT = os.environ.get("MUSE_POC_WORKDIR") or os.path.join(tempfile.gettempdir(), "muse-poc")
os.makedirs(ROOT, exist_ok=True)
TASKS = json.load(open(f"{REPO}/docs/evaluations/muse-code/tasks.json"))
MUSE_MODEL = "muse-spark-1.3-contributor"
CLAUDE_MODEL = "claude-sonnet-5"
MUSE = os.environ.get("MUSE_BIN") or shutil.which("muse") or os.path.expanduser("~/.local/bin/muse")
CLAUDE = os.environ.get("CLAUDE_BIN") or "claude"
MUSE_STEP_CAP = 300  # high cap; the wall-clock timeout is the real limit (identical for both arms)


def task(tid):
    return next(t for t in TASKS["tasks"] if t["id"] == tid)


def sh(cmd, cwd=None, env=None, timeout=None, log=None):
    p = subprocess.run(cmd, shell=isinstance(cmd, str), cwd=cwd, env=env, timeout=timeout,
                       capture_output=True, text=True)
    if log:
        open(log, "w").write((p.stdout or "") + (p.stderr or ""))
    return p


def prepare(t):
    """One prepared tree per task: history-free export + npm ci, cloned per arm."""
    d = f"{ROOT}/runs/{t['id']}/prepared"
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(d)
    sh(f"git -C {REPO} archive {t['startingSha']} | tar -x -C {d}")
    sh("git init -q && git add -A && git -c user.name=poc -c user.email=poc@example.invalid commit -q -m 'start'", cwd=d)
    r = sh("npm ci --no-audit --no-fund", cwd=d, log=f"{ROOT}/runs/{t['id']}/npm-ci.log", timeout=900)
    print("prepared", t["id"], "npm ci exit", r.returncode)
    return r.returncode


def prompt(t):
    s = t["workerSpec"]
    ac = "\n".join(f"- {a}" for a in s["acceptanceCriteria"])
    return (f"You are working in a git repository (the current directory). Implement this task.\n\n"
            f"# {s['title']}\n\n{s['description']}\n\n## Acceptance criteria\n{ac}\n\n"
            "Make the change in the working tree and commit it with git (do not push, do not open a pull request). "
            "Run the relevant existing tests for the files you change. End with a short summary of what you changed.")


def muse_env(run_dir):
    cfg, data = f"{run_dir}/xdg-config", f"{run_dir}/xdg-data"
    os.makedirs(f"{cfg}/muse", exist_ok=True); os.makedirs(data, exist_ok=True)
    os.chmod(cfg, 0o700); os.chmod(data, 0o700)
    tpl = json.load(open(f"{REPO}/packages/server/src/runners/fixtures/muse-code/settings/recommended.settings.template.json"))
    tpl.pop("mcpServers", None)  # PoC: no MCP, no deck
    json.dump(tpl, open(f"{cfg}/muse/settings.json", "w"))
    auth = f"{cfg}/muse/auth.json"
    if not os.path.lexists(auth):
        os.symlink(os.path.expanduser("~/.config/muse/auth.json"), auth)  # never read or copied
    env = dict(os.environ, MUSE_NO_AUTO_UPDATE="1", XDG_CONFIG_HOME=cfg, XDG_DATA_HOME=data)
    return env, data


def run_arm(t, arm):
    run_dir = f"{ROOT}/runs/{t['id']}/{arm}"
    if os.path.exists(run_dir):
        shutil.rmtree(run_dir)
    os.makedirs(run_dir)
    wt = f"{run_dir}/wt"
    sh(["cp", "-cR", f"{ROOT}/runs/{t['id']}/prepared", wt])  # APFS clone
    p = prompt(t)
    open(f"{run_dir}/prompt.txt", "w").write(p)
    env = dict(os.environ)
    if arm == "muse":
        env, data = muse_env(run_dir)
        sid = str(uuid.uuid4())
        cmd = [MUSE, "exec", "--json", "--no-foreign-personal-context", "--model", MUSE_MODEL,
               "--approval-mode", "never", "--approval-judge", "off", "--sandbox-network", "restricted",
               "--disable-web-tools", "--session-id", sid, "--max-model-steps", str(MUSE_STEP_CAP), p]
    else:
        cmd = [CLAUDE, "-p", p, "--model", CLAUDE_MODEL, "--effort", "high", "--setting-sources", "project",
               "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
               "--tools", "Read,Write,Edit,Glob,Grep,Bash", "--allowedTools", "Read,Write,Edit,Glob,Grep,Bash",
               "--permission-mode", "dontAsk", "--output-format", "stream-json", "--verbose"]
    shown = ["<prompt>" if a == p else a for a in cmd]
    open(f"{run_dir}/command.txt", "w").write(" ".join(shown))
    out, err = open(f"{run_dir}/stdout.jsonl", "w"), open(f"{run_dir}/stderr.txt", "w")
    t0 = time.time(); timed_out = False
    proc = subprocess.Popen(cmd, cwd=wt, env=env, stdout=out, stderr=err, start_new_session=True)
    try:
        proc.wait(timeout=t["timeoutSeconds"])
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=20)
        except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
    wall = t["timeoutSeconds"] if timed_out else time.time() - t0
    out.close(); err.close()
    rec = {"task": t["id"], "arm": arm, "exit_code": proc.returncode, "timed_out": timed_out, "wall_s": round(wall, 1)}
    rec.update(collect_usage(arm, run_dir, data if arm == "muse" else None))
    rec.update(contamination(t, run_dir, wt))
    rec.update(final_state(wt))
    rec["verification"] = verify(t, wt, run_dir)
    json.dump(rec, open(f"{run_dir}/result.json", "w"), indent=2)
    print(json.dumps(rec, indent=2))


def collect_usage(arm, run_dir, data):
    u = {}
    if arm == "muse":
        models, tot = set(), {}
        for root, _, files in os.walk(data):
            for f in files:
                if f != "session.jsonl": continue
                for line in open(os.path.join(root, f)):
                    if '"model_completed"' not in line: continue
                    ev = json.loads(line).get("payload", {}).get("event", {})
                    if ev.get("kind") != "model_completed": continue
                    if ev.get("model"): models.add(ev["model"])
                    for k, v in (ev.get("usage") or {}).items():
                        if isinstance(v, (int, float)): tot[k] = tot.get(k, 0) + v
        u["models_completed"] = sorted(models)
        u["model_ok"] = models == {MUSE_MODEL}
        u["usage_tokens"] = tot or None
        u["cost_usd"] = None  # Muse reports no cost/credit field (NOT-177)
        term = None
        for line in open(f"{run_dir}/stdout.jsonl"):
            if '"run_terminal"' in line or '"run.terminal' in line: term = line
        u["terminal"] = re.findall(r'"run\.terminal\.[a-z_]+"|"outcome":"[a-z_]+"', term or "")[:2]
    else:
        res, init = None, None
        for line in open(f"{run_dir}/stdout.jsonl"):
            try: d = json.loads(line)
            except Exception: continue
            if d.get("type") == "system" and d.get("subtype") == "init": init = d
            if d.get("type") == "result": res = d
        u["models_completed"] = [init.get("model")] if init else []
        u["model_ok"] = bool(init) and init.get("model") == CLAUDE_MODEL
        if res:
            u["usage_tokens"] = res.get("usage")
            u["cost_usd"] = res.get("total_cost_usd")
            u["terminal"] = [res.get("subtype"), res.get("is_error")]
    return u


def contamination(t, run_dir, wt):
    blob = ""
    for f in ("stdout.jsonl", "stderr.txt"):
        blob += open(f"{run_dir}/{f}", errors="ignore").read()
    pats = [t["referenceSha"], t["referenceSha"][:8], "docs/evaluations/muse-code", "github.com/not-so-fat/agent-dealer", "api.github.com", "raw.githubusercontent"]
    hits = [p for p in pats if p in blob]
    # the worker's own prompt never contains these, so any hit is worth a look
    return {"contamination_hits": hits}


def final_state(wt):
    g = lambda *a: sh(["git", *a], cwd=wt).stdout.strip()
    return {"commits_after_start": int(g("rev-list", "--count", "HEAD") or 0) - 1,
            "dirty_files": len([l for l in g("status", "--porcelain").splitlines() if l]),
            "diffstat_vs_start": g("diff", "--shortstat", "HEAD~1" if int(g("rev-list", "--count", "HEAD") or 0) > 1 else "HEAD")}


def verify(t, wt, run_dir):
    v = t["verification"]; results = []
    for p in v["heldOutPaths"]:  # held-out tests replace whatever the worker wrote there
        src = sh(["git", "-C", REPO, "show", f"{t['referenceSha']}:{p}"])
        os.makedirs(os.path.dirname(f"{wt}/{p}"), exist_ok=True)
        open(f"{wt}/{p}", "w").write(src.stdout)
    for c in v["commands"]:
        rest = c["run"].split(" && ", 1)[1]
        try:
            r = sh(rest, cwd=wt, timeout=TASKS["controls"]["verificationTimeoutSeconds"], log=f"{run_dir}/verify-{c['id']}.log")
            rc, hang = r.returncode, False
        except subprocess.TimeoutExpired:
            rc, hang = None, True
        txt = open(f"{run_dir}/verify-{c['id']}.log", errors="ignore").read() if os.path.exists(f"{run_dir}/verify-{c['id']}.log") else ""
        fail0 = re.search(r"fail 0\b", txt) is not None
        m = re.search(r"pass (\d+)", txt)
        exp = re.search(r"pass (\d+)", c["expectedResult"])
        ok = (rc == c["expectedExitCode"]) and fail0 and not hang
        results.append({"id": c["id"], "exit": rc, "hang": hang, "fail0": fail0, "pass": int(m.group(1)) if m else None,
                        "expected_pass": int(exp.group(1)) if exp else None, "ok": ok})
    return {"commands": results, "verified": all(r["ok"] for r in results)}


def dry_verify(t):
    """Verify the untouched start tree in a copy: it must fail, proving verification tests the change."""
    d = f"{ROOT}/runs/{t['id']}/dry"
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    sh(["cp", "-cR", f"{ROOT}/runs/{t['id']}/prepared", f"{d}/wt"])
    r = verify(t, f"{d}/wt", d)
    print(json.dumps(r, indent=2))
    return 0 if not r["verified"] else 1  # a start tree that verifies means the task tests nothing


if __name__ == "__main__":
    mode, tid = sys.argv[1], sys.argv[2]
    t = task(tid)
    if mode == "prepare":
        sys.exit(prepare(t))
    if mode == "dry-verify":
        sys.exit(dry_verify(t))
    if len(sys.argv) < 4 or sys.argv[3] not in ("muse", "claude"):
        sys.exit(USAGE)
    run_arm(t, sys.argv[3])
