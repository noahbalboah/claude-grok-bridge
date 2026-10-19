#!/usr/bin/env python3
"""grok-bridge MCP server (stdio, no dependencies). Tools to start, list, watch, diff and stop Grok Build tasks.
Task state lives in ~/.local/state/grok-tasks/<name>/ (written by ../bin/grok-task.sh)."""
import json, os, re, signal, subprocess, sys, time

ROOT = os.path.expanduser('~/.local/state/grok-tasks')
HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.join(HERE, '..', 'bin', 'grok-task.sh')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,40}$')


def rd(p, default=''):
    try:
        with open(p, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return default


def meta(name):
    out = {}
    for line in rd(os.path.join(ROOT, name, 'meta')).splitlines():
        k, _, v = line.partition('=')
        out[k] = v
    return out


def alive(name):
    pid = rd(os.path.join(ROOT, name, 'pid')).strip()
    if not pid.isdigit():
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def text_tail(name, chars):
    """Grok's streamed text/thought joined from the end of events.ndjson."""
    p = os.path.join(ROOT, name, 'events.ndjson')
    try:
        with open(p, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - max(chars * 40, 40000)))
            lines = f.read().decode('utf-8', 'replace').splitlines()[1:]
    except OSError:
        return ''
    parts = []
    for line in lines:
        try:
            d = json.loads(line).get('data')
        except ValueError:
            continue
        if isinstance(d, str):
            parts.append(d)
    return ''.join(parts)[-chars:]


def status(name):
    d = os.path.join(ROOT, name)
    ev = os.path.join(d, 'events.ndjson')
    ex = rd(os.path.join(d, 'exit')).strip()
    has_pid = os.path.exists(os.path.join(d, 'pid'))
    st = 'exit ' + ex if ex else ('running' if alive(name) or not has_pid else 'stopped')
    return {
        'name': name, 'state': st, **meta(name),
        'events': sum(1 for _ in open(ev, 'rb')) if os.path.exists(ev) else 0,
        'idle_s': int(time.time() - os.path.getmtime(ev)) if os.path.exists(ev) else None,
        'diffstat': rd(os.path.join(d, 'diffstat')).strip(),
    }


def tasks():
    if not os.path.isdir(ROOT):
        return []
    return sorted(os.listdir(ROOT), key=lambda n: -os.path.getmtime(os.path.join(ROOT, n)))


def need(args, key):
    v = args.get(key)
    if not v:
        raise ValueError(f'missing {key}')
    return v


def t_list(a):
    return '\n'.join(f"{s['name']:<20} {s['state']:<9} events {s['events']:>5} idle {s['idle_s']}s"
                     for s in map(status, tasks())) or '(no grok tasks)'


def t_status(a):
    name = need(a, 'name')
    s = status(name)
    s['last_text'] = text_tail(name, int(a.get('tail_chars', 1500)))
    s['stderr'] = rd(os.path.join(ROOT, name, 'stderr.log'))[-800:]
    return json.dumps(s, indent=1)


def t_diff(a):
    name = need(a, 'name')
    wt = meta(name).get('worktree')
    if not wt or not os.path.isdir(wt):
        return 'no worktree for ' + name
    stat = subprocess.run(['git', '-C', wt, 'status', '--short'], capture_output=True, text=True).stdout
    diff = subprocess.run(['git', '-C', wt, 'diff'], capture_output=True, text=True).stdout
    limit = int(a.get('max_chars', 20000))
    return stat + '\n' + (diff[:limit] + ('\n... (truncated)' if len(diff) > limit else ''))


def t_start(a):
    name, repo, brief = need(a, 'name'), need(a, 'repo'), need(a, 'brief')
    if not NAME.match(name):
        raise ValueError('name must be lowercase letters, digits and dashes')
    if name in tasks() and alive(name):
        raise ValueError(f'{name} is already running')
    if not os.path.isdir(os.path.join(repo, '.git')) and not os.path.isfile(os.path.join(repo, '.git')):
        raise ValueError('repo is not a git checkout: ' + repo)
    os.makedirs(os.path.join(ROOT, name), exist_ok=True)
    bf = os.path.join(ROOT, name, 'brief.in.md')
    with open(bf, 'w') as f:
        f.write(brief)
    cmd = ['sh', TASK, repo, name, bf, str(int(a.get('max_turns', 60))), a.get('model', os.environ.get('GROK_MODEL', 'grok-4.7'))]
    subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=open(os.path.join(ROOT, name, 'runner.log'), 'w'),
                     stderr=subprocess.STDOUT, start_new_session=True)
    return f'started grok task {name} in {repo}/.worktrees/grok-{name}; check it with grok_status'


def t_stop(a):
    name = need(a, 'name')
    pid = rd(os.path.join(ROOT, name, 'pid')).strip()
    if not pid.isdigit() or not alive(name):
        return f'{name} is not running'
    os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
    return f'stopped {name}'


S = {'type': 'string'}
TOOLS = {
    'grok_list': (t_list, 'List Grok tasks with state, event count and idle time.', {}, []),
    'grok_status': (t_status, "One task's state, metadata, diffstat, stderr tail and the end of Grok's own words.",
                    {'name': S, 'tail_chars': {'type': 'integer'}}, ['name']),
    'grok_diff': (t_diff, 'The uncommitted diff Grok left in its worktree (review this; never trust the summary).',
                  {'name': S, 'max_chars': {'type': 'integer'}}, ['name']),
    'grok_start': (t_start, 'Start a bounded task: new worktree <repo>/.worktrees/grok-<name> from the remote default branch '
                   '(or $GROK_BASE), workspace sandbox, no commits. The brief is the whole instruction.',
                   {'name': S, 'repo': S, 'brief': S, 'max_turns': {'type': 'integer'}, 'model': S},
                   ['name', 'repo', 'brief']),
    'grok_stop': (t_stop, 'Stop a running Grok task.', {'name': S}, ['name']),
}


def reply(i, result=None, error=None):
    msg = {'jsonrpc': '2.0', 'id': i}
    msg['error' if error else 'result'] = error or result
    sys.stdout.write(json.dumps(msg) + '\n')
    sys.stdout.flush()


for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    i, m, p = req.get('id'), req.get('method'), req.get('params') or {}
    if i is None:
        continue  # notifications
    if m == 'initialize':
        reply(i, {'protocolVersion': p.get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'grok-bridge', 'version': '0.1.0'}})
    elif m == 'ping':
        reply(i, {})
    elif m == 'tools/list':
        reply(i, {'tools': [{'name': n, 'description': d,
                             'inputSchema': {'type': 'object', 'properties': props, 'required': req_}}
                            for n, (_, d, props, req_) in TOOLS.items()]})
    elif m == 'tools/call':
        fn = TOOLS.get(p.get('name'), (None,))[0]
        if not fn:
            reply(i, error={'code': -32602, 'message': 'unknown tool'})
            continue
        try:
            reply(i, {'content': [{'type': 'text', 'text': fn(p.get('arguments') or {})}]})
        except Exception as e:  # report to the caller as a tool error, keep serving
            reply(i, {'content': [{'type': 'text', 'text': f'error: {e}'}], 'isError': True})
    else:
        reply(i, error={'code': -32601, 'message': 'method not found'})
