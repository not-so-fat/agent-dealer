#!/usr/bin/env python3
"""Rebuild the sanitized fixtures and the computed parts of manifest.json from RAW captures (NOT-177).

usage: DECK_NAME=<agent deck deck name> build-fixtures.py --round1 <dir of p*.jsonl/.err/.rc> --harness <OUT_DIR of probe8-9.sh/probe10.sh>

`manifest.json` is both input and output: hand-written metadata (command, notes, exact, settings profile,
`round1_raw` = the raw capture name of a round-1 probe) is read from the existing manifest; sanitized
commands for harness entries come from the harness's own cmdlog; every count (raw / committed / dropped
lines, per type), stderr and exit code is computed here from the files actually read and written and is
re-verified against the committed files by `muse-code-fixtures.test.ts`.

Sanitization works on PARSED JSON values only, so field names (`call_id`, ...) are never rewritten.
Placeholders: ids -> <id-N> / <call-N> / <resp-N> (stable within one entry, shared by its command, stderr and
events), timestamps -> <ts>, paths -> <WORKSPACE> <PROBE_HOME> <SPIKE_DIR> <CFG> <DATA> <HOME> <SPIKE_TMP>.
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.dirname(HERE)
HOME = os.path.expanduser('~')
E = re.escape(HOME)
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
CALL = re.compile(r'call_[0-9a-f]{32}')
RESP = re.compile(r'resp_[0-9a-f]{24}')
NOT_WORD = r'(?![A-Za-z0-9_-])'   # a suffix such as `9` must not be left dangling after a placeholder
PATHS = [   # most specific first
    (re.compile(r'(?:/private)?/tmp/muse-spike/cfg[A-Za-z0-9_-]*' + NOT_WORD), '<CFG>'),
    (re.compile(r'(?:/private)?/tmp/muse-spike/data[A-Za-z0-9_-]*' + NOT_WORD), '<DATA>'),
    (re.compile(r'(?:/private)?/tmp/muse-spike/ws' + NOT_WORD), '<WORKSPACE>'),
    (re.compile(E + r'/muse-spike-probe/(?:wt|mcp-ws)' + NOT_WORD), '<WORKSPACE>'),
    (re.compile(E + r'/muse-spike-run/wt' + NOT_WORD), '<WORKSPACE>'),
    (re.compile(E + r'/muse-spike-run/((?:cfg|data)-[a-z0-9-]+)'), r'<SPIKE_DIR>/\1'),
    (re.compile(E + r'/muse-spike-run' + NOT_WORD), '<SPIKE_DIR>'),
    (re.compile(E + r'/muse-spike-probe' + NOT_WORD), '<PROBE_HOME>'),
    (re.compile(r'~/muse-spike-probe' + NOT_WORD), '<PROBE_HOME>'),
    (re.compile(r'(?:/private)?/tmp/muse-spike' + NOT_WORD), '<SPIKE_TMP>'),
    (re.compile(E + NOT_WORD), '<HOME>'),
]
DECK_NAME = os.environ.get('DECK_NAME')   # the operator's deck name; set it so replies that echo it are redacted
NIL_DECK = '00000000-0000-0000-0000-000000000000'   # stand-in deck id used by probe8-9.sh
LIMIT = 400   # longer string values are cut (marked) so fixtures stay reviewable
KEEP = {'run.terminal.completed', 'run.terminal.failed', 'tool.result', 'task.lifecycle.failed'}
KEEP_FULL = {'01-exec-success'}   # one full-envelope example, nothing dropped


class Ctx:
    def __init__(self):
        self.ids = {}

    def _id(self, prefix, m):
        return self.ids.setdefault(m.group(0), f'<{prefix}-{len(self.ids) + 1}>')

    def text(self, s):
        s = s.replace(NIL_DECK, '<DECK_ID>')
        for rx, rep in PATHS:
            s = rx.sub(rep, s)
        s = CALL.sub(lambda m: self._id('call', m), s)
        s = RESP.sub(lambda m: self._id('resp', m), s)
        s = UUID.sub(lambda m: self._id('id', m), s)
        return s.replace(DECK_NAME, '<deck-name>') if DECK_NAME else s


def walk(o, fn):
    if isinstance(o, dict):
        return {k: walk(v, fn) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(v, fn) for v in o]
    return fn(o) if isinstance(o, str) else o


def read(path):
    return open(path).read() if os.path.exists(path) else None


def keep_event(o, name, has_terminal, state):
    t = o.get('payload_type')
    if name in KEEP_FULL or t in KEEP:
        return True
    ev = o['payload'].get('event', {}) if isinstance(o.get('payload'), dict) else {}
    if t == 'task.lifecycle.status':
        return 'rate_limited' in json.dumps(o)
    if t == 'task.lifecycle.side_effect_intent':
        return str(ev.get('operation', '')).startswith('tool:')
    if t == 'runtime.session':   # session-log excerpt: usage / server-confirmed model only
        return ev.get('kind') == 'model_completed'
    if t == 'run.model.configured':
        first = not state.get('model')
        state['model'] = True
        return first
    if t == 'run.output.delta':   # partial output only matters if the run never reached a terminal event
        return not has_terminal
    return False


def sanitize_stream(raw_path, name, ctx):
    events = []
    for n, line in enumerate(open(raw_path), 1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as e:
            sys.exit(f'{raw_path}:{n}: non-JSON stdout line ({e}); stdout must be pure JSONL')
    # Agent Deck MCP results embed real deck contents: replace each such payload, wherever echoed, by a size marker.
    payloads = {}
    for o in events:
        if o.get('payload_type') == 'tool.result':
            p = o['payload']
            if p.get('correlation_facts', {}).get('tool_name', '').startswith('mcp__') and len(p.get('text', '')) > 40:
                payloads[p['text']] = f"<redacted MCP payload: {len(p['text'])} bytes>"

    def clean(s):
        for full, rep in payloads.items():
            s = s.replace(full, rep)
        s = ctx.text(s)
        return s if len(s) <= LIMIT else s[:LIMIT] + f'…[truncated {len(s) - LIMIT} chars]'
    has_terminal = any(str(o.get('payload_type', '')).startswith('run.terminal.') for o in events)
    kept, dropped, state = [], {}, {}
    for o in events:
        if not keep_event(o, name, has_terminal, state):
            t = o.get('payload_type')
            dropped[t] = dropped.get(t, 0) + 1
            continue
        o = walk(o, clean)
        if 'recorded_at' in o:
            o['recorded_at'] = '<ts>'
        kept.append(o)
    return len(events), kept, dropped


def write_stream(name, kept):
    with open(os.path.join(FIX, name + '.jsonl'), 'w') as f:
        for o in kept:
            f.write(json.dumps(o, separators=(',', ':'), ensure_ascii=False) + '\n')


def parse_facts(text):
    d = {}
    for l in (text or '').splitlines():
        k, _, v = l.partition('=')
        d[k] = int(v) if v.isdigit() else v
    return d


def dump_manifest(m, path):
    """indent=1 for structure, but leaf containers on one line to keep the file reviewable."""
    def leaf(v):
        return json.dumps(v, ensure_ascii=False, separators=(', ', ': '))
    lines = ['{']
    top = list(m.items())
    for i, (k, v) in enumerate(top):
        comma = ',' if i < len(top) - 1 else ''
        if k in ('probes', 'cron_disable_attempts'):
            lines.append(f' "{k}": [')
            for j, e in enumerate(v):
                lines.append('  {')
                items = list(e.items())
                for n, (ek, ev) in enumerate(items):
                    c = ',' if n < len(items) - 1 else ''
                    if ek == 'commands':
                        lines.append('   "commands": [')
                        lines += [f'    {leaf(x)}' + (',' if q < len(ev) - 1 else '') for q, x in enumerate(ev)]
                        lines.append('   ]' + c)
                    else:
                        lines.append(f'   "{ek}": {leaf(ev)}{c}')
                lines.append('  }' + (',' if j < len(v) - 1 else ''))
            lines.append(' ]' + comma)
        elif k in ('conventions', 'settings_profiles'):
            lines.append(f' "{k}": {{')
            its = list(v.items())
            lines += [f'  "{a}": {leaf(b)}' + (',' if q < len(its) - 1 else '') for q, (a, b) in enumerate(its)]
            lines.append(' }' + comma)
        else:
            lines.append(f' "{k}": {leaf(v)}{comma}')
    lines.append('}')
    open(path, 'w').write('\n'.join(lines) + '\n')
    json.load(open(path))   # must round-trip


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--round1', required=True)
    ap.add_argument('--harness', required=True)
    a = ap.parse_args()
    old = json.load(open(os.path.join(FIX, 'manifest.json')))
    profiles = dict(old['settings_profiles'])
    entries = []
    for prev in old['probes']:
        name = prev['fixture'].rsplit('.', 1)[0]
        ctx = Ctx()
        e = {'fixture': prev['fixture'], 'probe': prev['probe']}
        if 'round1_raw' in prev:
            base = os.path.join(a.round1, prev['round1_raw'])
            e['round1_raw'] = prev['round1_raw']
            e['command'] = ctx.text(prev['command'])
            e['exact'] = prev['exact']
            if 'exact_reason' in prev:
                e['exact_reason'] = prev['exact_reason']
            e['settings_profile'] = prev['settings_profile']
            err = read(base + '.err')
            m = re.search(r'workspace root: (\S+)', err or '')
            e['workspace_root'] = 'tmp' if m and m.group(1).startswith(('/tmp/', '/private/tmp/')) else 'home'
        else:
            script, case = prev['harness'].split()[1:]
            base = os.path.join(a.harness, case)
            cmdlog = read(base + '.cmdlog')
            if cmdlog is None:
                sys.exit(f'missing harness capture {base}.cmdlog (run: {prev["harness"]})')
            e['harness'] = prev['harness']
            e['commands'] = [ctx.text(l) for l in cmdlog.splitlines()]
            e['exact'] = True
            e['facts'] = parse_facts(read(base + '.facts'))
            e['workspace_root'] = 'home'   # lib.sh refuses a SPIKE_DIR outside $HOME
            sfile = os.path.join(a.harness, {'cancel-resume-after-sigterm': 'sigterm'}.get(case, case) + '.settings.json')
            st = read(sfile)
            e['settings_profile'] = None
            if st is not None:
                obj = walk(json.loads(st), ctx.text)
                obj = walk(obj, lambda s: '<WORKTREE>' if s.startswith('<WORKSPACE>') else s)
                for k, v in profiles.items():
                    if v == obj:
                        e['settings_profile'] = k
                        break
                else:
                    sys.exit(f'{sfile}: settings match no profile in manifest.json settings_profiles; add one and name it')
            err = read(base + '.err')
        rc = read(base + '.rc')
        src = base + '.jsonl'
        raw_count, kept, dropped = sanitize_stream(src, name, ctx)
        write_stream(name, kept)
        e['exit_code'] = rc.strip() if rc is not None else 'n/a'
        e['stderr'] = '\n'.join(l for l in ctx.text(err or '').splitlines() if 'unsafe_registry_root' not in l).strip()
        e['stdout_lines_raw'] = raw_count
        e['stdout_lines_committed'] = len(kept)
        e['dropped_by_type'] = dropped
        e['notes'] = prev['notes']
        entries.append(e)
    cron_job = json.load(open(os.path.join(a.harness, 'cron-persisted-job.json')))
    with open(os.path.join(FIX, '09-cron-persisted-job.json'), 'w') as f:
        f.write(json.dumps(cron_job, separators=(',', ':')) + '\n')
    attempts = []
    for prev in old['cron_disable_attempts']:
        case = prev['harness'].split()[-1]
        ctx = Ctx()
        base = os.path.join(a.harness, case)
        name = prev['fixture'].rsplit('.', 1)[0]
        raw_count, kept, dropped = sanitize_stream(base + '.jsonl', name, ctx)
        write_stream(name, kept)
        st = read(base + '.settings.json')
        attempts.append({
            'fixture': prev['fixture'], 'harness': prev['harness'], 'attempt': prev['attempt'], 'exact': True,
            'commands': [ctx.text(l) for l in read(base + '.cmdlog').splitlines()],
            'settings': walk(json.loads(st), ctx.text) if st else None,
            'exit_code': read(base + '.rc').strip(),
            'stderr': '\n'.join(l for l in ctx.text(read(base + '.err') or '').splitlines() if 'unsafe_registry_root' not in l).strip(),
            'tool_results_in_fixture': [{'tool': o['payload']['correlation_facts']['tool_name'], 'outcome': o['payload']['correlation_facts']['outcome']}
                                        for o in kept if o.get('payload_type') == 'tool.result'],
            'stdout_lines_raw': raw_count, 'stdout_lines_committed': len(kept), 'dropped_by_type': dropped})
    manifest = {k: old[k] for k in ('muse_version', 'binary_sha256', 'model', 'conventions', 'settings_profiles')}
    manifest['probes'] = entries
    manifest['cron_disable_attempts'] = attempts
    dump_manifest(manifest, os.path.join(FIX, 'manifest.json'))
    print(len(entries) + len(attempts), 'captures rebuilt')


if __name__ == '__main__':
    main()
