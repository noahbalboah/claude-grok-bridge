#!/usr/bin/env python3
"""The Grok task board and its actions, for the grok-bridge pane and a terminal.
    grok-watch.py                    live board in a terminal (Ctrl-C to stop); --once prints it once
    grok-watch.py --json             every task, for the pane
    grok-watch.py --detail NAME      one task with its brief and transcript
    grok-watch.py --start NAME REPO BRIEF [TURNS] [MODEL]   start a task (BRIEF is the text)
    grok-watch.py --followup NAME TEXT         one more run on the same worktree with a correction
    grok-watch.py --stop NAME                  stop a running task
    grok-watch.py --cleanup NAME               remove a task's worktree and branch once its PR merged
    grok-watch.py --dismiss NAME / --restore NAME   hide a finished task from the board, or bring it back
Reads ~/.local/state/grok-tasks/<name>/ (written by grok-task.sh): brief.md, meta, pid, events.ndjson, stderr.log,
exit, diffstat; caches the task's PR in pr.json."""
import json, os, re, signal, subprocess, sys, time

ROOT = os.path.expanduser('~/.local/state/grok-tasks')
HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.join(HERE, 'grok-task.sh')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,40}$')
STUCK_S = 300      # a running task silent this long is shown as stuck
PR_TTL_S = 60      # how often a task's PR is looked up again


def rd(d, f):
    p = os.path.join(d, f)
    return open(p, errors='replace').read() if os.path.exists(p) else ''


def meta_of(d):
    return dict(l.split('=', 1) for l in rd(d, 'meta').splitlines() if '=' in l)


def alive(d):
    pid = rd(d, 'pid').strip()
    if not pid.isdigit():
        return None
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def tool_summary(e, wt=''):
    """A tool call as a person would write it: `$ cargo test`, `read src/x.rs`, `edit src/x.rs`."""
    raw = e.get('rawInput') or {}
    tool = e.get('toolName') or e.get('title') or 'tool'
    rel = lambda p: str(p)[len(wt) + 1:] if wt and str(p).startswith(wt + '/') else str(p)
    if tool == 'run_terminal_command':
        return '$ ' + ' '.join(str(raw.get('command', '')).split())[:160]
    if tool in ('read_file', 'search_replace', 'list_dir', 'write_file'):
        verb = {'read_file': 'read', 'search_replace': 'edit', 'list_dir': 'ls', 'write_file': 'write'}[tool]
        return f"{verb} {rel(raw.get('target_file') or raw.get('path') or '')}"[:160]
    if tool == 'grep':
        return f"grep {raw.get('pattern') or raw.get('query') or ''}"[:160]
    if tool == 'get_command_or_subagent_output':
        return 'waiting on a command'
    arg = raw.get('command') or raw.get('target_file') or raw.get('path') or raw.get('pattern') or raw.get('query') or ''
    return f"{tool} {' '.join(rel(arg).split())[:140]}".strip()


def scan(ev, wt=''):
    """One pass over the events: count, tokens, the last tool call, and the tail of Grok's words."""
    events, tokens, activity, words, block, kind = 0, 0, '', [], [], ''
    for line in (open(ev, 'rb') if os.path.exists(ev) else []):
        events += 1
        head = line[:24]
        try:
            if head.startswith(b'{"type":"usage"'):
                u = json.loads(line).get('usage') or {}
                tokens += int(u.get('input_tokens', 0)) + int(u.get('output_tokens', 0))
            elif head.startswith(b'{"type":"tool_call"'):
                activity = tool_summary(json.loads(line), wt)
                kind = 'tool'
            elif head.startswith(b'{"type":"text"'):
                d = json.loads(line).get('data')
                if isinstance(d, str):
                    if kind != 'text':
                        block = []
                    block.append(d)
                    kind = 'text'
            elif head.startswith(b'{"type":"thought"'):
                kind = 'thought'
        except ValueError:
            pass
    # The start of Grok's latest message, which is where its summary begins, not the tail of a stream.
    text = ' '.join(''.join(block).split())
    return events, tokens, activity, (text[:157] + '…') if len(text) > 160 else text


def numstat(wt):
    """Lines added and removed in the worktree, tracked changes plus new files."""
    if not wt or not os.path.isdir(wt):
        return 0, 0
    add = rem = 0
    out = subprocess.run(['git', '-C', wt, 'diff', '--numstat', 'HEAD'], capture_output=True, text=True).stdout
    for l in out.splitlines():
        a, r, _ = (l.split('\t') + ['', ''])[:3]
        add += int(a) if a.isdigit() else 0
        rem += int(r) if r.isdigit() else 0
    new = subprocess.run(['git', '-C', wt, 'ls-files', '--others', '--exclude-standard'], capture_output=True, text=True).stdout
    for f in new.splitlines():
        try:
            add += sum(1 for _ in open(os.path.join(wt, f), 'rb'))
        except OSError:
            pass
    return add, rem


def pr_of(d, name, repo, fresh=False):
    """The PR whose head is grok/<name>, cached for PR_TTL_S (`fresh` asks again). {} when there is none or gh is unavailable."""
    cache = os.path.join(d, 'pr.json')
    if not fresh and os.path.exists(cache) and time.time() - os.path.getmtime(cache) < PR_TTL_S:
        try:
            return json.load(open(cache))
        except ValueError:
            pass
    pr = {}
    if repo and os.path.isdir(repo):
        try:
            r = subprocess.run(['gh', 'pr', 'list', '--head', f'grok/{name}', '--state', 'all', '--limit', '1',
                                '--json', 'number,state,url'], cwd=repo, capture_output=True, text=True, timeout=15)
            rows = json.loads(r.stdout or '[]') if r.returncode == 0 else []
            pr = rows[0] if rows else {}
        except (subprocess.TimeoutExpired, ValueError, OSError):
            pr = {}
    with open(cache, 'w') as f:
        json.dump(pr, f)
    return pr


def task_json(name):
    d = os.path.join(ROOT, name)
    ev = os.path.join(d, 'events.ndjson')
    code = rd(d, 'exit').strip() or None
    up = alive(d)
    running = code is None and up is not False
    err = rd(d, 'stderr.log')
    low = err.lower()
    m = meta_of(d)
    wt = m.get('worktree', '')
    events, tokens, activity, last = scan(ev, wt)
    started = os.path.getmtime(os.path.join(d, 'brief.md')) if os.path.exists(os.path.join(d, 'brief.md')) else 0
    ended = os.path.getmtime(os.path.join(d, 'exit')) if code is not None else time.time()
    idle = int(time.time() - os.path.getmtime(ev)) if os.path.exists(ev) else 0
    add, rem = numstat(wt)
    pr = pr_of(d, name, m.get('repo', ''))
    hit_limit = 'max turns' in low
    if running:
        state = 'stuck' if idle > STUCK_S else 'running'
    elif pr.get('state') == 'MERGED':
        state = 'shipped'
    elif pr.get('state') == 'OPEN':
        state = 'review'
    elif code == '0' or (code is None and last):
        # A run stopped from outside (grok_stop, or its process killed) leaves no exit file. When Grok had already
        # said its piece, the orchestrator stopped an idle run: a finished task, not a failure.
        state = 'done'
    else:
        state = 'stuck' if hit_limit else 'failed'
    ds = rd(d, 'diffstat')
    files = sum(1 for l in ds.splitlines() if l[:2].strip() and '|' not in l)
    return {'name': name, 'state': state, 'running': running, 'tokens': tokens, 'events': events, 'idle': idle,
            'started': started, 'elapsed': int(max(0, ended - started)) if started else 0,
            'activity': activity, 'last': last, 'files': files, 'added': add, 'removed': rem,
            'hit_limit': hit_limit, 'pr': pr, 'repo': m.get('repo', ''), 'dismissed': os.path.exists(os.path.join(d, 'dismissed')), 'worktree': wt if wt and os.path.isdir(wt) else '',
            'limited': any(k in low for k in ('rate limit', 'rate_limit', '429', '402', 'quota', 'usage limit',
                                              'balance exhausted'))}


def task_detail(name, limit=160):
    """One task with its brief, metadata, diffstat and transcript, streamed deltas joined into entries."""
    d = os.path.join(ROOT, name)
    entries = []
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
            entries.append({'kind': 'tool', 'body': tool_summary(e, meta_of(d).get('worktree', ''))})
    for x in entries:
        x['body'] = x['body'].strip()
    entries = [x for x in entries if x['body']]
    return {**task_json(name), 'brief': rd(d, 'brief.md').strip(), 'meta': meta_of(d), 'diffstat': rd(d, 'diffstat').strip(),
            'stderr': rd(d, 'stderr.log').strip()[-600:], 'total': len(entries), 'entries': entries[-limit:]}


def names():
    if not os.path.isdir(ROOT):
        return []
    return sorted(os.listdir(ROOT), key=lambda n: -os.path.getmtime(os.path.join(ROOT, n)))


def spawn(name, repo, brief_text, turns='150', model=''):
    d = os.path.join(ROOT, name)
    os.makedirs(d, exist_ok=True)
    bf = os.path.join(d, 'brief.in.md')
    with open(bf, 'w') as f:
        f.write(brief_text)
    subprocess.Popen(['sh', TASK, repo, name, bf, turns] + ([model] if model else []), stdin=subprocess.DEVNULL,
                     stdout=open(os.path.join(d, 'runner.log'), 'w'), stderr=subprocess.STDOUT, start_new_session=True)


def act(argv):
    """The pane's buttons. Each prints one line for the pane and exits 0 on success."""
    cmd, name = argv[0], argv[1]
    if not NAME.match(name):
        sys.exit(f'bad task name: {name}')
    d = os.path.join(ROOT, name)
    if cmd == '--start':
        repo, brief = argv[2], argv[3]
        turns = argv[4] if len(argv) > 4 and argv[4].isdigit() else '150'
        model = argv[5] if len(argv) > 5 and re.match(r'^grok-[a-z0-9.-]+$', argv[5]) else ''
        if os.path.isdir(d) and alive(d):
            sys.exit(f'{name} is already running')
        if not os.path.exists(os.path.join(repo, '.git')):
            sys.exit(f'not a git checkout: {repo}')
        spawn(name, repo, brief, turns, model)
        print(f'started {name}')
    elif cmd == '--followup':
        m = meta_of(d)
        if alive(d):
            sys.exit(f'{name} is still running')
        if not m.get('repo'):
            sys.exit(f'{name} has no recorded repo')
        text = (f"{rd(d, 'brief.md').strip()}\n\n---\nFollow-up from the reviewer, on top of the changes already in this "
                f"worktree:\n{argv[2]}")
        spawn(name, m['repo'], text, str(max(int(m.get('max_turns') or 0), 150)))
        print(f'follow-up started for {name}')
    elif cmd == '--claim':
        # One session wins the right to ask Claude for a review of this run's outcome: an exclusive create.
        if os.environ.get('GROK_AUTO_REVIEW', '1') == '0':
            sys.exit('auto review is off (GROK_AUTO_REVIEW=0)')
        owner = meta_of(d).get('owner', '')
        if owner and len(argv) > 2 and argv[2] and argv[2] != owner:
            sys.exit('another session started this task')
        # Someone is already handling this outcome, and asking Claude again only repeats that work: the task was
        # archived, its run was stopped from outside (no exit file), or a PR from grok/<name> already exists.
        if os.path.exists(os.path.join(d, 'dismissed')):
            sys.exit('archived')
        if not rd(d, 'exit').strip():
            sys.exit('stopped from outside; whoever stopped it is handling it')
        if pr_of(d, name, meta_of(d).get('repo', ''), fresh=True):
            sys.exit('a PR already exists')
        bf =os.path.join(d, 'brief.md')
        run_id = int(os.path.getmtime(bf)) if os.path.exists(bf) else 0
        try:
            os.close(os.open(os.path.join(d, f'claimed-{run_id}'), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            sys.exit('already claimed')
        print('claimed')
    elif cmd == '--dismiss':
        if alive(d):
            sys.exit(f'{name} is still running; stop it first')
        open(os.path.join(d, 'dismissed'), 'w').close()
        print(f'archived {name}')
    elif cmd == '--restore':
        p = os.path.join(d, 'dismissed')
        if os.path.exists(p):
            os.unlink(p)
        print(f'restored {name}')
    elif cmd == '--stop':
        pid = rd(d, 'pid').strip()
        if not pid.isdigit() or not alive(d):
            sys.exit(f'{name} is not running')
        os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
        print(f'stopped {name}')
    elif cmd == '--cleanup':
        m = meta_of(d)
        wt, repo = m.get('worktree', ''), m.get('repo', '')
        if alive(d):
            sys.exit(f'{name} is still running')
        if pr_of(d, name, repo).get('state') != 'MERGED':
            sys.exit(f'{name}: its PR is not merged; nothing removed')
        if wt and os.path.isdir(wt):
            # A run may have pointed the worktree's .git at a copy elsewhere, and `worktree remove` then refuses
            # ("does not point back"); git's own repair rewrites it from the admin dir's record first.
            subprocess.run(['git', '-C', repo, 'worktree', 'repair', wt], capture_output=True)
            r = subprocess.run(['git', '-C', repo, 'worktree', 'remove', wt], capture_output=True, text=True)
            if r.returncode != 0:
                sys.exit(f'worktree not removed: {r.stderr.strip()[:200]}')
        subprocess.run(['git', '-C', repo, 'branch', '-D', f'grok/{name}'], capture_output=True)
        print(f'cleaned up {name}')


def row(t):
    return (f"{t['name']:<18} {t['state']:<8} {t['elapsed'] // 60:>3}m  +{t['added']} -{t['removed']}  "
            f"{t['tokens'] // 1000}k tok\n    {t['activity'] if t['running'] else t['last']}")


def board():
    out = [time.strftime('Grok tasks  %H:%M:%S'), '']
    out += [row(task_json(n)) for n in names()] or ['(no tasks yet)']
    return '\n'.join(out)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] in ('--start', '--followup', '--stop', '--cleanup', '--dismiss', '--restore', '--claim'):
        act(a)
    elif '--detail' in a:
        print(json.dumps(task_detail(a[a.index('--detail') + 1])))
    elif '--json' in a:
        print(json.dumps([task_json(n) for n in names()]))
    elif '--once' in a:
        print(board())
    else:
        while True:
            print('\033[2J\033[H' + board(), flush=True)
            time.sleep(5)
