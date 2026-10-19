#!/usr/bin/env python3
"""Live board of the Grok tasks started by scripts/grok-task.sh. Run it in a Claude Terminal tab:
    python3 scripts/grok-watch.py          (refreshes every 5 s; Ctrl-C to stop)
    python3 scripts/grok-watch.py --once   (print once)
Reads ~/.local/state/grok-tasks/<name>/: events.ndjson (Grok's streamed events), exit (written when the run ends), diffstat."""
import json, os, sys, time

ROOT = os.path.expanduser('~/.local/state/grok-tasks')


def last_text(path, limit=110):
    """The tail of Grok's latest streamed text or thought, joined from the last events."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 20000))
            lines = f.read().decode('utf-8', 'replace').splitlines()[1:]
    except OSError:
        return ''
    parts = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        d = e.get('data')
        if isinstance(d, str):
            parts.append(d)
    return ' '.join(''.join(parts).split())[-limit:]


def row(name):
    d = os.path.join(ROOT, name)
    ev = os.path.join(d, 'events.ndjson')
    ex = os.path.join(d, 'exit')
    age = int(time.time() - os.path.getmtime(ev)) if os.path.exists(ev) else -1
    running = not os.path.exists(ex) or (os.path.exists(ev) and os.path.getmtime(ev) > os.path.getmtime(ex))
    state = 'RUNNING' if running else 'exit ' + open(ex).read().strip()
    files = 0
    if not running and os.path.exists(os.path.join(d, 'diffstat')):
        files = sum(1 for l in open(os.path.join(d, 'diffstat')) if l[:2].strip() and '|' not in l)
    n = sum(1 for _ in open(ev, 'rb')) if os.path.exists(ev) else 0
    return f'{name:<18} {state:<9} events {n:>5}  last {age:>4}s  files {files:>2}\n    {last_text(ev)}'


def board():
    names = sorted(os.listdir(ROOT), key=lambda n: -os.path.getmtime(os.path.join(ROOT, n))) if os.path.isdir(ROOT) else []
    out = [time.strftime('Grok tasks  %H:%M:%S'), '']
    out += [row(n) for n in names] or ['(no tasks yet)']
    return '\n'.join(out)


def task_json(name):
    d = os.path.join(ROOT, name)
    ev = os.path.join(d, 'events.ndjson')
    ex = os.path.join(d, 'exit')
    code = open(ex).read().strip() if os.path.exists(ex) else None
    pid = os.path.join(d, 'pid')
    alive = False
    if os.path.exists(pid):
        try:
            os.kill(int(open(pid).read().strip()), 0)
            alive = True
        except (OSError, ValueError):
            pass
    state = 'running' if code is None and (alive or not os.path.exists(pid)) else ('done' if code == '0' else 'failed')
    ds = os.path.join(d, 'diffstat')
    files = sum(1 for l in open(ds) if l[:2].strip() and '|' not in l) if os.path.exists(ds) else 0
    events, tokens = 0, 0
    for line in (open(ev, 'rb') if os.path.exists(ev) else []):
        events += 1
        if line.startswith(b'{"type":"usage"'):
            try:
                u = json.loads(line).get('usage') or {}
                tokens += int(u.get('input_tokens', 0)) + int(u.get('output_tokens', 0))
            except ValueError:
                pass
    err = open(os.path.join(d, 'stderr.log'), errors='replace').read().lower() if os.path.exists(os.path.join(d, 'stderr.log')) else ''
    limited = any(k in err for k in ('rate limit', 'rate_limit', '429', '402', 'quota', 'usage limit', 'balance exhausted'))
    return {'name': name, 'state': state, 'tokens': tokens, 'limited': limited,
            'started': os.path.getmtime(os.path.join(d, 'brief.md')) if os.path.exists(os.path.join(d, 'brief.md')) else 0,
            'events': events,
            'idle': int(time.time() - os.path.getmtime(ev)) if os.path.exists(ev) else 0,
            'files': files, 'last': last_text(ev, 140)}


def tool_summary(e):
    raw = e.get('rawInput') or {}
    arg = raw.get('command') or raw.get('target_file') or raw.get('path') or raw.get('pattern') or raw.get('query') or ''
    return f"{e.get('toolName') or e.get('title') or 'tool'} {str(arg)[:160]}".strip()


def task_detail(name, limit=120):
    """One task's brief, metadata, diffstat and its transcript, with streamed deltas joined into entries."""
    d = os.path.join(ROOT, name)
    rd = lambda f: open(os.path.join(d, f), errors='replace').read() if os.path.exists(os.path.join(d, f)) else ''
    entries, tokens = [], 0
    ev = os.path.join(d, 'events.ndjson')
    for line in (open(ev, errors='replace') if os.path.exists(ev) else []):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = e.get('type')
        if t in ('text', 'thought') and isinstance(e.get('data'), str):
            if entries and entries[-1]['kind'] == t:
                entries[-1]['body'] += e['data']
            else:
                entries.append({'kind': t, 'body': e['data']})
        elif t == 'tool_call':
            entries.append({'kind': 'tool', 'body': tool_summary(e)})
        elif t == 'usage':
            u = e.get('usage') or {}
            tokens += int(u.get('input_tokens', 0)) + int(u.get('output_tokens', 0))
    for x in entries:
        x['body'] = x['body'].strip()
    entries = [x for x in entries if x['body']]
    meta = dict(l.split('=', 1) for l in rd('meta').splitlines() if '=' in l)
    return {**task_json(name), 'brief': rd('brief.md').strip(), 'meta': meta, 'diffstat': rd('diffstat').strip(),
            'stderr': rd('stderr.log').strip()[-600:], 'tokens': tokens, 'total': len(entries),
            'entries': entries[-limit:]}


if '--detail' in sys.argv:
    print(json.dumps(task_detail(sys.argv[sys.argv.index('--detail') + 1])))
elif '--json' in sys.argv:
    names = sorted(os.listdir(ROOT), key=lambda n: -os.path.getmtime(os.path.join(ROOT, n))) if os.path.isdir(ROOT) else []
    print(json.dumps([task_json(n) for n in names]))
elif '--once' in sys.argv:
    print(board())
else:
    while True:
        print('\033[2J\033[H' + board(), flush=True)
        time.sleep(5)
