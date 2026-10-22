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
    grok-watch.py --claim NAME SESSION         win the right to tell that session about this run's outcome, once
    grok-watch.py --notice NAME                the message the owning session gets when a run stops
Reads ~/.local/state/grok-tasks/<name>/ (written by grok-task.sh): brief.md, meta, pid, events.ndjson, stderr.log,
exit, diffstat; caches the task's PR in pr.json. One `gh pr list` per repo is cached beside the board snapshot,
and each task's event summary is reused until its events.ndjson changes size or mtime."""
import fcntl, json, os, re, signal, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.expanduser('~/.local/state/grok-tasks')
HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.join(HERE, 'grok-task.sh')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,40}$')
STUCK_S = 300      # a running task silent this long is shown as stuck
PR_TTL_S = 60      # how often a repo's PR list is looked up again
SETTLED_TTL_S = 60       # how often a finished task's diff size is counted again
ARCHIVED_TTL_S = 3600    # the same for an archived task's diff size and PR
# Named per format: sessions on an older plugin version keep writing their own snapshot, not this one.
BOARD = os.path.expanduser('~/.local/state/grok-board-v2.json')
BOARD_TTL_S = 4    # every open Claude session polls --json every 5 s; they share one snapshot this fresh
# Beside the board snapshot: one PR list per repo, and one event summary per task.
PRMAP = os.path.join(os.path.dirname(BOARD), 'grok-prs-v2.json')
SCAN = os.path.join(os.path.dirname(BOARD), 'grok-scan-v2.json')


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


def cached(path, ttl):
    """The JSON at `path` when it was written less than `ttl` seconds ago, else None."""
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < ttl:
        try:
            return json.load(open(path))
        except ValueError:
            pass
    return None


def numstat_of(d, wt, running, dismissed):
    """numstat for the board: a running task's every read, a settled one's at most every SETTLED_TTL_S (an archived
    one's every ARCHIVED_TTL_S), since each read is two git processes per task."""
    cache = os.path.join(d, 'numstat.json')
    hit = None if running else cached(cache, ARCHIVED_TTL_S if dismissed else SETTLED_TTL_S)
    if hit is not None:
        return tuple(hit)
    add, rem = numstat(wt)
    with open(cache, 'w') as f:
        json.dump([add, rem], f)
    return add, rem


_prmap = None
_scan = None
_scan_dirty = False


def load_json(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return None


def dump_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}'
    with open(tmp, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def prmap():
    global _prmap
    if _prmap is None:
        _prmap = load_json(PRMAP) or {}
    return _prmap


def gh_prs(repo):
    """One `gh pr list` for `repo`: heads that start with grok/, or (False, {}) when gh fails.

    `--search head:grok/` is not used. That qualifier is the whole branch name, not a prefix, so it would miss
    `grok/<task>` and the board would forget open PRs."""
    if not repo or not os.path.isdir(repo):
        return False, {}
    try:
        r = subprocess.run(
            ['gh', 'pr', 'list', '--state', 'all', '--limit', '300', '--json', 'number,state,url,headRefName'],
            cwd=repo, capture_output=True, text=True, timeout=20)
        if r.returncode != 0:
            return False, {}
        rows = json.loads(r.stdout or '[]')
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return False, {}
    got = {}
    for row in rows:
        head = row.get('headRefName') or ''
        if head.startswith('grok/'):
            got[head] = {'number': row.get('number'), 'state': row.get('state'), 'url': row.get('url')}
    return True, got


def store_repo(repo, ok, prs):
    """Remember a fetch. A failure keeps the previous list and is not retried until the ttl."""
    mp = prmap()
    entry = mp.get(repo) or {}
    kept = prs if ok else (entry.get('prs') or {})
    mp[repo] = {'at': time.time(), 'ok': ok, 'prs': kept}
    return None if not ok else kept


def repo_due(repo, ttl, force=False):
    """True when this repo's list is missing or older than `ttl`. A remembered failure counts as fresh."""
    if force:
        return True
    entry = prmap().get(repo) or {}
    return not (entry.get('at') and time.time() - entry['at'] < ttl)


def repo_prs(repo, ttl, force=False):
    """PRs whose head starts with grok/, from one `gh pr list` per repo per `ttl`.

    None when that call fails: the caller keeps the last answer it stored. `force` asks again."""
    entry = prmap().get(repo) or {}
    if not repo_due(repo, ttl, force):
        return None if entry.get('ok') is False else (entry.get('prs') or {})
    ok, prs = gh_prs(repo)
    found = store_repo(repo, ok, prs)
    dump_json(PRMAP, prmap())
    return found


def task_needs_pr(name):
    """(repo, ttl) when this task would ask gh, else None. MERGED and a fresh pr.json do not."""
    d = os.path.join(ROOT, name)
    repo = meta_of(d).get('repo', '')
    dismissed = os.path.exists(os.path.join(d, 'dismissed'))
    cache = os.path.join(d, 'pr.json')
    old = cached(cache, float('inf')) or {}
    bf = os.path.join(d, 'brief.md')
    merged = old.get('state') == 'MERGED' and os.path.exists(cache) and os.path.getmtime(cache) > (os.path.getmtime(bf) if os.path.exists(bf) else 0)
    if merged:
        return None
    ttl = ARCHIVED_TTL_S if dismissed else PR_TTL_S
    if cached(cache, ttl) is not None:
        return None
    return repo, ttl


def prefetch_prs(ns):
    """Fetch every repo a task still needs, one call each, at the same time. The per-task read then hits the map."""
    need = {}
    for name in ns:
        due = task_needs_pr(name)
        if not due:
            continue
        repo, ttl = due
        if repo not in need or ttl < need[repo]:
            need[repo] = ttl
    stale = [repo for repo, ttl in need.items() if repo_due(repo, ttl)]
    if not stale:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(stale))) as ex:
        got = list(ex.map(lambda repo: (repo, *gh_prs(repo)), stale))
    for repo, ok, prs in got:
        store_repo(repo, ok, prs)
    dump_json(PRMAP, prmap())


def pr_of(d, name, repo, fresh=False, dismissed=False):
    """The PR whose head is grok/<name>. Read from the per-repo list, which is fetched once per PR_TTL_S
    (ARCHIVED_TTL_S for an archived task; `fresh` asks again). MERGED is kept until a follow-up rewrites brief.md.
    {} when there is none; the last answer when gh fails, so a timeout never wipes it."""
    cache = os.path.join(d, 'pr.json')
    old = cached(cache, float('inf')) or {}
    bf = os.path.join(d, 'brief.md')
    # A merge stays a merge until another run (a follow-up rewrites brief.md) could open a new PR.
    merged = old.get('state') == 'MERGED' and os.path.exists(cache) and os.path.getmtime(cache) > (os.path.getmtime(bf) if os.path.exists(bf) else 0)
    if not fresh and merged:
        return old
    ttl = ARCHIVED_TTL_S if dismissed else PR_TTL_S
    if not fresh and cached(cache, ttl) is not None:
        return old
    found = repo_prs(repo, ttl, force=fresh)
    if found is None:
        pr = old
    else:
        pr = found.get(f'grok/{name}') or {}
        if merged and not pr:
            pr = old
    with open(cache, 'w') as f:
        json.dump(pr, f)
    return pr


def scan_of(name, ev, wt):
    """scan(), reused until events.ndjson changes size or mtime. A running task appends, so it is read again."""
    global _scan, _scan_dirty
    if _scan is None:
        _scan = load_json(SCAN) or {}
    try:
        st = os.stat(ev)
        size, mtime_ns = st.st_size, st.st_mtime_ns
    except OSError:
        size, mtime_ns = -1, 0
    hit = _scan.get(name)
    if isinstance(hit, dict) and hit.get('size') == size and hit.get('mtime_ns') == mtime_ns:
        return hit['events'], hit['tokens'], hit['activity'], hit['last']
    events, tokens, activity, last = scan(ev, wt)
    _scan[name] = {'size': size, 'mtime_ns': mtime_ns, 'events': events, 'tokens': tokens,
                   'activity': activity, 'last': last}
    _scan_dirty = True
    return events, tokens, activity, last


def flush_scan(keep):
    """Write the event summaries once per rebuild, and drop tasks that are gone."""
    global _scan_dirty
    if _scan is None:
        return
    for k in list(_scan):
        if k not in keep:
            del _scan[k]
            _scan_dirty = True
    if _scan_dirty:
        dump_json(SCAN, _scan)
        _scan_dirty = False


def run_id(d):
    """One run of a task: a follow-up rewrites brief.md, so its mtime names the run."""
    bf = os.path.join(d, 'brief.md')
    return int(os.path.getmtime(bf)) if os.path.exists(bf) else 0


def why_of(state, code, err, hit_limit, max_turns, add, rem):
    """Why a stopped task sits in Needs review, in words for the board and the notice."""
    if state in ('running', 'shipped', 'review'):
        return ''
    if hit_limit:
        return f'hit its {max_turns}-turn limit before finishing' if max_turns else 'hit its turn limit before finishing'
    if 'watchdog:' in err:
        return 'went silent and was stopped by the watchdog'
    if code is None:
        return 'stopped before it exited'
    if code != '0':
        return f'exited with code {code}'
    return f'finished; +{add} \u2212{rem} not reviewed yet' if add or rem else 'finished with no changes'


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
    events, tokens, activity, last = scan_of(name, ev, wt)
    started = os.path.getmtime(os.path.join(d, 'brief.md')) if os.path.exists(os.path.join(d, 'brief.md')) else 0
    ended = os.path.getmtime(os.path.join(d, 'exit')) if code is not None else time.time()
    idle = int(time.time() - os.path.getmtime(ev)) if os.path.exists(ev) else 0
    dismissed = os.path.exists(os.path.join(d, 'dismissed'))
    add, rem = numstat_of(d, wt, running, dismissed)
    pr = pr_of(d, name, m.get('repo', ''), dismissed=dismissed)
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
    why = why_of(state, code, low, hit_limit, m.get('max_turns', ''), add, rem)
    claimed = os.path.exists(os.path.join(d, f'claimed-{run_id(d)}'))
    return {'name': name, 'state': state, 'running': running, 'tokens': tokens, 'events': events, 'idle': idle,
            'exit_code': code, 'ended': ended if code is not None else 0, 'why': why, 'claimed': claimed,
            'started': started, 'elapsed': int(max(0, ended - started)) if started else 0,
            'activity': activity, 'last': last, 'files': files, 'added': add, 'removed': rem,
            'hit_limit': hit_limit, 'pr': pr, 'repo': m.get('repo', ''), 'dismissed': dismissed, 'owner': m.get('owner', ''), 'worktree': wt if wt and os.path.isdir(wt) else '',
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


def notice(name, lines=8, chars=900):
    """What the owning session reads when a run stops: the outcome and why, the end of Grok's own words, the
    diffstat, and what to do next."""
    t = task_detail(name)
    words = next((x['body'] for x in reversed(t['entries']) if x['kind'] == 'text'), '')
    tail = '\n'.join([l for l in words.splitlines() if l.strip()][-lines:])[-chars:]
    ds = '\n'.join(t['diffstat'].splitlines()[-25:])
    return '\n'.join([
        f"Grok task {name} stopped: {t['why'] or t['state']}.",
        '',
        "Grok's last words:",
        '\n'.join('> ' + l for l in tail.splitlines()) if tail else '> (nothing)',
        '',
        f"Changes: +{t['added']} \u2212{t['removed']}" + (f"\n{ds}" if ds else ' (none)'),
        '',
        f"Review it the grok-delegate way: grok_diff for what really changed, run the checks in its worktree, then "
        f"commit, push grok/{name} and open the PR if it holds up, or send one follow-up or grok_archive it if not. "
        f"If it is running again by now, a follow-up already went out: leave it. Tell me the outcome in two lines.",
    ])


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
        try:
            os.close(os.open(os.path.join(d, f'claimed-{run_id(d)}'), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            sys.exit('already claimed')
        print('claimed')
    elif cmd == '--notice':
        print(notice(name))
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


def board_json():
    """--json for every polling session at once: whoever finds the snapshot stale rebuilds it under a lock, and the
    others wait for that and read it, so N sessions cost one board build, not N."""
    def fresh():
        return os.path.exists(BOARD) and time.time() - os.path.getmtime(BOARD) < BOARD_TTL_S
    if not fresh():
        os.makedirs(os.path.dirname(BOARD), exist_ok=True)
        with open(BOARD + '.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not fresh():
                ns = names()
                prefetch_prs(ns)
                out = json.dumps([task_json(n) for n in ns])
                flush_scan(set(ns))
                tmp = f'{BOARD}.{os.getpid()}'
                with open(tmp, 'w') as f:
                    f.write(out)
                os.replace(tmp, BOARD)
                return out
    return open(BOARD).read()


def row(t):
    return (f"{t['name']:<18} {t['state']:<8} {t['elapsed'] // 60:>3}m  +{t['added']} -{t['removed']}  "
            f"{t['tokens'] // 1000}k tok\n    {t['activity'] if t['running'] else t['last']}")


def board():
    ns = names()
    prefetch_prs(ns)
    out = [time.strftime('Grok tasks  %H:%M:%S'), '']
    out += [row(task_json(n)) for n in ns] or ['(no tasks yet)']
    flush_scan(set(ns))
    return '\n'.join(out)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] in ('--start', '--followup', '--stop', '--cleanup', '--dismiss', '--restore', '--claim', '--notice'):
        act(a)
        # The pane refreshes right after a button and should see what it did: age the shared snapshot out.
        if os.path.exists(BOARD):
            os.utime(BOARD, (0, 0))
    elif '--detail' in a:
        print(json.dumps(task_detail(a[a.index('--detail') + 1])))
    elif '--json' in a:
        print(board_json())
    elif '--once' in a:
        print(board())
    else:
        while True:
            print('\033[2J\033[H' + board(), flush=True)
            time.sleep(5)
