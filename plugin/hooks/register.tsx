import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GrokDetail, GrokDraft, GrokEntry, GrokState, GrokTask } from '../types'

const PANE = 'grok-board'
const board = atom({ plugin: 'grok-bridge', key: 'board' } as const, [] as GrokTask[])
const error = atom({ plugin: 'grok-bridge', key: 'error' } as const, '')
const selected = atom({ plugin: 'grok-bridge', key: 'selected' } as const, '')
const detail = atom({ plugin: 'grok-bridge', key: 'detail' } as const, null as GrokDetail | null)
const notice = atom({ plugin: 'grok-bridge', key: 'notice' } as const, '')
// Tool-call groups the person expanded in a transcript, by `<task>:<index>`.
const open = atom({ plugin: 'grok-bridge', key: 'open' } as const, [] as string[])
const draft = atom(
  { plugin: 'grok-bridge', key: 'draft' } as const,
  { name: '', repo: '', brief: '', followup: '', show: false, model: 'grok-4.7', turns: '60' } as GrokDraft,
)
// The pane's new-task view, selected like a task.
const NEW = '+new'
const bandOpen = atom({ plugin: 'grok-bridge', key: 'bandOpen' } as const, false)
const showArchived = atom({ plugin: 'grok-bridge', key: 'showArchived' } as const, false)
// Tasks this session already asked Claude to review, until they run again: the buttons say Sent and do nothing.
const reviewSent = atom({ plugin: 'grok-bridge', key: 'reviewSent' } as const, [] as string[])

const COLOR: Record<GrokState, string> = {
  running: '#4a8cf7',
  stuck: '#e3a008',
  done: '#2fa36b',
  failed: '#e0662f',
  review: '#3fb6c8',
  shipped: '#8b5cf6',
}
const LABEL: Record<GrokState, string> = {
  running: 'Running',
  stuck: 'Needs a look',
  done: 'Ready to review',
  failed: 'Failed',
  review: 'PR open',
  shipped: 'Shipped',
}
// The band shows running tasks and ones that changed in the last half hour.
const RECENT_S = 1800

const dur = (s: number) =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
const kilo = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`)
const today = (tasks: GrokTask[], now: number) =>
  tasks.filter(t => now - t.started < 86400).reduce((sum, t) => sum + t.tokens, 0)
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Sizes on a Box are cells; an Svg is measured in CSS pixels, so every glyph is an Svg. SMIL (the spinner) plays only
// in an interactive Svg.
function glyph(state: GrokState): string {
  const c = COLOR[state]
  const body =
    state === 'running'
      ? `<circle cx="10" cy="10" r="7" fill="none" stroke="${c}" stroke-opacity="0.25" stroke-width="3"/><path d="M10 3 a7 7 0 0 1 7 7" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.9s" repeatCount="indefinite"/></path>`
      : state === 'stuck'
        ? `<path d="M10 2 L19 18 L1 18 Z" fill="${c}" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 7.5 V12" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="10" cy="15" r="1.3" fill="#fff"/>`
        : state === 'failed'
          ? `<circle cx="10" cy="10" r="9" fill="${c}"/><path d="M6.5 6.5 L13.5 13.5 M13.5 6.5 L6.5 13.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`
          : state === 'shipped' || state === 'review'
            ? `<circle cx="10" cy="10" r="9" fill="${c}"/><circle cx="7" cy="6" r="1.6" fill="#fff"/><circle cx="7" cy="14" r="1.6" fill="#fff"/><circle cx="13.5" cy="11" r="1.6" fill="#fff"/><path d="M7 7.5 V12.5 M7 9 C7 11 13.5 9 13.5 9.5" fill="none" stroke="#fff" stroke-width="1.5"/>`
            : `<circle cx="10" cy="10" r="9" fill="${c}"/><path d="M5.5 10.5 L8.5 13.5 L14.5 6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${body}</svg>`
}
// Lines added (green) against removed (red), as Conductor shows them.
function diffBar(add: number, rem: number): string {
  const total = Math.max(1, add + rem)
  const g = Math.round((add / total) * 40)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="6" viewBox="0 0 40 6"><rect width="40" height="6" rx="3" fill="#3a3a3a"/><rect width="${g}" height="6" rx="3" fill="#2fa36b"/><rect x="${g}" width="${40 - g}" height="6" rx="3" fill="#e0662f" opacity="${rem ? 1 : 0}"/></svg>`
}

const reviewPrompt = (name: string, state: GrokState) =>
  `Grok task ${name} is ${LABEL[state].toLowerCase()}. Review it the grok-delegate way: grok_status for its summary, ` +
  `grok_diff for what really changed, run the checks in its worktree, then commit, push grok/${name} and open the PR ` +
  `if it holds up, or send one follow-up or grok_archive it if not. Tell me the outcome in two lines.`

async function askReview($: EngineInterface, name: string, state: GrokState) {
  let first = false
  await update($, reviewSent, x => {
    first = !x.includes(name)
    return first ? [...x, name] : x
  })
  if (!first) {
    $.ui.toast(`Already sent ${name} to Claude`)
    return
  }
  $.ui.toast(`Sent ${name} to Claude for review`)
  await $.prompt.submit({ text: reviewPrompt(name, state) })
}

async function run($: EngineInterface, args: string[]) {
  return $.process.run(['python3', `${$.plugin.root}/bin/grok-watch.py`, ...args])
}

// What each task was at the last read, so a toast fires once per change, never on every refresh.
const seen = new Map<string, { running: boolean; state: GrokState }>()

async function refresh($: EngineInterface) {
  const r = await run($, ['--json'])
  if (r.exitCode !== 0) {
    await update($, error, () => r.stderr.slice(0, 200) || 'grok-watch failed')
    return
  }
  const tasks = JSON.parse(r.stdout) as GrokTask[]
  // A toast when a task this session saw running settles; the first read only learns the states.
  for (const t of tasks) {
    const was = seen.get(t.name)
    const settled = was?.running === true && !t.running
    const quiet = was?.running === true && t.running && was.state === 'running' && t.state === 'stuck'
    if (settled) $.ui.toast(`Grok ${t.name}: ${LABEL[t.state].toLowerCase()}`)
    else if (quiet) $.ui.toast(`Grok ${t.name} has gone quiet`)
    seen.set(t.name, { running: t.running, state: t.state })
    if (t.running) await update($, reviewSent, x => (x.includes(t.name) ? x.filter(n => n !== t.name) : x))
    // Claude reviews a finished run without being asked; the claim makes it one session, once per run.
    if (settled && t.state !== 'shipped' && t.state !== 'review') {
      const c = await run($, ['--claim', t.name, await $.session.id()])
      if (c.exitCode === 0) await askReview($, t.name, t.state)
    }
  }
  await update($, board, () => tasks)
  // The new-task form starts on the repo of the latest task that recorded one.
  const wt = tasks.find(t => t.worktree !== '')?.worktree ?? ''
  const repo = wt.includes('/.worktrees/') ? wt.slice(0, wt.indexOf('/.worktrees/')) : ''
  if (repo !== '') await update($, draft, x => (x.repo === '' ? { ...x, repo } : x))
  await update($, error, () => '')
  const running = tasks.filter(t => t.running).length
  $.ui.status(running > 0 ? `Grok: ${running} running` : undefined)
  const name = await read($, selected)
  if (name !== '') {
    const d = await run($, ['--detail', name])
    if (d.exitCode === 0) await update($, detail, () => JSON.parse(d.stdout) as GrokDetail)
  }
}

async function pick($: EngineInterface, name: string) {
  await update($, selected, () => name)
  await update($, detail, () => null)
  await refresh($)
}

async function action($: EngineInterface, args: string[]) {
  const r = await run($, args)
  const line = (r.exitCode === 0 ? r.stdout : r.stderr).trim().split('\n').pop() || 'done'
  await update($, notice, () => line)
  $.ui.toast(`Grok: ${line}`)
  await refresh($)
}

// Consecutive tool calls fold into one group, so Grok's own words stand out.
type Block = { kind: 'text' | 'thought'; body: string } | { kind: 'tools'; items: string[]; at: number }
function blocks(entries: GrokEntry[]): Block[] {
  const out: Block[] = []
  entries.forEach((x, i) => {
    const last = out[out.length - 1]
    if (x.kind === 'tool') {
      if (last && last.kind === 'tools') last.items.push(x.body)
      else out.push({ kind: 'tools', items: [x.body], at: i })
    } else out.push({ kind: x.kind, body: x.body })
  })
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'grok', description: 'Open the Grok pane' })
    await $.command.register({ name: 'grok-board', description: 'Open the Grok pane' })
    await update($, selected, () => '')
    void refresh($)
    $.clock.every(5000, () => void refresh($))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Svg, Button, Code, Input, Link, Select } = $.ui.resolve(e)
    const tasks = await read($, board)
    const err = await read($, error)
    const name = await read($, selected)
    const note = await read($, notice)
    const dr = await read($, draft)
    const sent = await read($, reviewSent)
    const icon = (s: GrokState, px: number) => (
      <Svg source={glyph(s)} alt={LABEL[s]} width={px} height={px} isInteractive={s === 'running' ? true : undefined} />
    )
    const prChip = (t: GrokTask) =>
      t.pr.url ? (
        <Link href={t.pr.url} label={`PR #${t.pr.number} · ${(t.pr.state ?? '').toLowerCase()}`} />
      ) : null

    if (name === NEW) {
      const repos = [...new Set(tasks.map(t => t.repo).filter(r => r !== ''))]
      const repoChoice = repos.includes(dr.repo) ? dr.repo : dr.repo === '' && repos.length > 0 ? repos[0] : 'other'
      const slug = (b: string) =>
        b
          .toLowerCase()
          .replace(/[^a-z0-9 ]+/g, ' ')
          .split(' ')
          .filter(w => w.length > 2)
          .slice(0, 4)
          .join('-')
          .slice(0, 40)
      const suggested = slug(dr.brief)
      const finalName = (dr.name.trim() || suggested).replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '')
      const finalRepo = repoChoice === 'other' ? dr.repo.trim() : repoChoice
      const ready = finalName !== '' && finalRepo !== '' && dr.brief.trim().length >= 20
      const start = () => {
        if (!ready) {
          void update($, notice, () => 'Write a brief of at least a sentence, and pick a repo.')
          return
        }
        void update($, draft, x => ({ ...x, name: '', brief: '' }))
        void pick($, '')
        void action($, ['--start', finalName, finalRepo, dr.brief.trim(), dr.turns, dr.model])
      }
      const field = (title: string, hint: string, child: unknown) => (
        <Box flexDirection="column" gap="xs" key={`f-${title}`}>
          <Text weight="semibold">{title}</Text>
          <Text dimColor size="footnote">
            {hint}
          </Text>
          {child}
        </Box>
      )
      const card = { borderStyle: 'round', borderColor: '#2e2e2e', backgroundColor: '#202020', paddingX: 'sm', paddingY: 'sm' } as const
      return (
        <Box flexDirection="column" gap="md" padding="sm">
          <Button key="back" plain dimColor onPress={() => void pick($, '')}>
            ‹ All tasks
          </Button>
          <Box flexDirection="column" gap="xs">
            <Text size="title" weight="semibold">
              New Grok task
            </Text>
            <Text dimColor size="footnote">
              Grok works in its own worktree and never commits. When it finishes, review the diff and land it.
            </Text>
          </Box>
          <Box flexDirection="column" gap="md" {...card}>
            {field(
              'What should Grok do?',
              'The problem and its evidence, the files or area, what done looks like, and the checks to run.',
              <Input
                key="new-brief"
                autoFocus
                placeholder="e.g. The Options window's language list overflows at 1280x720 in pt-BR; fit it and run cargo test -p co-ui"
                submitLabel="Start"
                value={dr.brief}
                onInput={v => void update($, draft, x => ({ ...x, brief: v }))}
                onSubmit={() => start()}
              />,
            )}
            {dr.brief.trim() !== '' && (
              <Box flexDirection="column" borderStyle="round" borderColor="#2a2a2a" paddingX="sm" paddingY="xs">
                <Text dimColor size="caption" weight="semibold">
                  BRIEF
                </Text>
                <Text size="footnote">{dr.brief}</Text>
              </Box>
            )}
            {field(
              'Repo',
              'The checkout Grok branches from; its worktree goes in <repo>/.worktrees.',
              <Box flexDirection="column" gap="xs">
                <Select
                  key="new-repo"
                  options={[...repos.map(r => ({ value: r, label: r.split('/').slice(-2).join('/') })), { value: 'other', label: 'Other path…' }]}
                  value={repoChoice}
                  onSelect={v => void update($, draft, x => ({ ...x, repo: v === 'other' ? '' : v }))}
                />
                {repoChoice === 'other' && (
                  <Input
                    key="new-repo-path"
                    placeholder="/absolute/path/to/a/git/checkout"
                    value={dr.repo}
                    onInput={v => void update($, draft, x => ({ ...x, repo: v }))}
                    onSubmit={v => void update($, draft, x => ({ ...x, repo: v }))}
                  />
                )}
              </Box>,
            )}
            <Box flexDirection="row" gap="md" flexWrap="wrap">
              {field(
                'Name',
                suggested ? `Leave empty for ${suggested}` : 'Lowercase words with dashes',
                <Input
                  key="new-name"
                  placeholder={suggested || 'fix-login-overflow'}
                  value={dr.name}
                  onInput={v => void update($, draft, x => ({ ...x, name: v }))}
                  onSubmit={v => void update($, draft, x => ({ ...x, name: v }))}
                />,
              )}
              {field(
                'Model',
                'Flat subscription: 4.7 unless it misbehaves',
                <Select
                  key="new-model"
                  options={[
                    { value: 'grok-4.7', label: 'grok-4.7' },
                    { value: 'grok-4.6', label: 'grok-4.6' },
                    { value: 'grok-4.5', label: 'grok-4.5' },
                  ]}
                  value={dr.model}
                  onSelect={v => void update($, draft, x => ({ ...x, model: v }))}
                />,
              )}
              {field(
                'Turn limit',
                'Lower keeps it bounded',
                <Select
                  key="new-turns"
                  options={[
                    { value: '40', label: '40 turns' },
                    { value: '60', label: '60 turns' },
                    { value: '100', label: '100 turns' },
                  ]}
                  value={dr.turns}
                  onSelect={v => void update($, draft, x => ({ ...x, turns: v }))}
                />,
              )}
            </Box>
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Button key="new-start" label={`Start ${finalName || 'task'}`} variant="primary" onPress={() => start()} />
            <Text dimColor size="footnote">
              {ready ? `in ${finalRepo.split('/').slice(-1)[0]} · ${dr.model} · ${dr.turns} turns` : 'needs a brief and a repo'}
            </Text>
          </Box>
          {note !== '' && (
            <Text dimColor size="footnote">
              {note}
            </Text>
          )}
        </Box>
      )
    }

    if (name !== '') {
      const d = await read($, detail)
      const t = d ?? tasks.find(x => x.name === name)
      const opened = await read($, open)
      return (
        <Box flexDirection="column" gap="sm" padding="sm">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Button key="back" plain dimColor onPress={() => void pick($, '')}>
              ‹ All tasks
            </Button>
            {t && (
              <Text dimColor tabular>
                {LABEL[t.state]} · {dur(t.elapsed)}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {t && icon(t.state, 16)}
            <Text weight="semibold">{name}</Text>
            {t && prChip(t)}
          </Box>
          {d === null && <Text dimColor>Loading…</Text>}
          {d && (
            <Box flexDirection="column" gap="sm">
              <Box flexDirection="row" alignItems="center" gap="sm">
                <Svg source={diffBar(d.added, d.removed)} alt={`+${d.added} −${d.removed}`} width={40} height={6} />
                <Text dimColor size="footnote" tabular>
                  +{d.added} −{d.removed} · {d.meta.model ?? 'grok'} · {kilo(d.tokens)} tokens · {d.total} steps
                  {d.meta.started ? ` · started ${d.meta.started.replace('T', ' ').replace('Z', ' UTC')}` : ''}
                </Text>
              </Box>
              {d.running && d.activity !== '' && (
                <Text mono size="footnote" wrap="truncate-end">
                  ▸ {d.activity}
                </Text>
              )}
              {d.hit_limit && <Text color={COLOR.stuck}>It hit its turn limit before finishing; check the diff, then follow up.</Text>}
              <Box flexDirection="row" gap="sm" flexWrap="wrap">
                {d.running && (
                  <Button key="stop" label="Stop" onPress={() => void action($, ['--stop', name])} />
                )}
                {!d.running && d.state !== 'shipped' && d.state !== 'review' && (
                  <Button
                    key="review"
                    label={sent.includes(name) ? 'Sent to Claude ✓' : 'Ask Claude to review'}
                    variant="primary"
                    onPress={() => void askReview($, name, d.state)}
                  />
                )}
                {!d.running && !d.dismissed && (
                  <Button
                    key="archive"
                    label="Archive"
                    onPress={async () => {
                      await action($, ['--dismiss', name])
                      await pick($, '')
                    }}
                  />
                )}
                {d.dismissed && <Button key="restore" label="Restore" onPress={() => void action($, ['--restore', name])} />}
                {d.state === 'shipped' && d.worktree !== '' && (
                  <Button key="cleanup" label="Clean up worktree" onPress={() => void action($, ['--cleanup', name])} />
                )}
              </Box>
              {!d.running && d.state !== 'shipped' && (
                <Input
                  key="followup"
                  placeholder="Follow up: tell Grok what to change, then press Enter"
                  submitLabel="Send"
                  value={dr.followup}
                  onInput={v => void update($, draft, x => ({ ...x, followup: v }))}
                  onSubmit={v => {
                    if (v.trim() === '') return
                    void update($, draft, x => ({ ...x, followup: '' }))
                    void action($, ['--followup', name, v.trim()])
                  }}
                />
              )}
              {note !== '' && (
                <Text dimColor size="footnote">
                  {note}
                </Text>
              )}
              <Text weight="medium">Brief</Text>
              <Text dimColor size="footnote">
                {d.brief}
              </Text>
              {d.diffstat !== '' && (
                <Box flexDirection="column" gap="xs">
                  <Text weight="medium">Changes</Text>
                  <Code>{d.diffstat}</Code>
                </Box>
              )}
              {d.stderr !== '' && <Text color={COLOR.failed}>{d.stderr}</Text>}
              <Text weight="medium">
                Transcript{d.total > d.entries.length ? ` (last ${d.entries.length} of ${d.total})` : ''}
              </Text>
              {blocks(d.entries).map((b, i) => {
                if (b.kind !== 'tools')
                  return b.kind === 'thought' ? (
                    <Text key={`b${i}`} italic dimColor size="footnote">
                      {b.body}
                    </Text>
                  ) : (
                    <Text key={`b${i}`}>{b.body}</Text>
                  )
                const id = `${name}:${b.at}`
                const isOpen = opened.includes(id)
                return (
                  <Box key={`b${i}`} flexDirection="column">
                    <Button
                      key={`tools-${b.at}`}
                      plain
                      dimColor
                      onPress={() =>
                        void update($, open, xs => (isOpen ? xs.filter(x => x !== id) : [...xs, id].slice(-50)))
                      }
                    >
                      {isOpen ? '▾' : '▸'} {b.items.length} tool call{b.items.length === 1 ? '' : 's'}
                      {isOpen ? '' : ` · ${short(b.items[b.items.length - 1], 70)}`}
                    </Button>
                    {isOpen &&
                      b.items.map((it, j) => (
                        <Text key={`t${b.at}-${j}`} mono size="footnote" dimColor wrap="truncate-end">
                          {'  '}▸ {it}
                        </Text>
                      ))}
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    const now = Date.now() / 1000
    const archivedOn = await read($, showArchived)
    const live = tasks.filter(t => !t.dismissed)
    const archived = tasks.filter(t => t.dismissed)
    const running = live.filter(t => t.running)
    const review = live.filter(t => !t.running && (t.state === 'done' || t.state === 'failed' || t.state === 'stuck'))
    const prOpen = live.filter(t => !t.running && t.state === 'review')
    const shipped = live.filter(t => t.state === 'shipped')
    const card = (t: GrokTask) => {
      const changed = t.added > 0 || t.removed > 0
      const sub = t.running && t.activity !== '' ? t.activity : t.state !== 'shipped' ? t.last : ''
      return (
        <Box
          flexDirection="column"
          key={t.name}
          borderStyle="round"
          borderColor="#2e2e2e"
          backgroundColor="#202020"
          paddingX="sm"
          paddingY="xs"
          gap="xs"
          hover={{ borderColor: COLOR[t.state] }}
        >
          <Box flexDirection="row" alignItems="center" gap="sm">
            {icon(t.state, 16)}
            <Box flexGrow={1}>
              <Button key={`open-${t.name}`} plain onPress={() => void pick($, t.name)}>
                {t.name}
              </Button>
            </Box>
            {prChip(t)}
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text size="footnote" color={COLOR[t.state]}>
              {LABEL[t.state]}
            </Text>
            {changed && <Svg source={diffBar(t.added, t.removed)} alt={`+${t.added} −${t.removed}`} width={40} height={6} />}
            <Text dimColor size="footnote" tabular>
              {changed ? `+${t.added} −${t.removed} · ` : ''}
              {t.elapsed > 0 ? `${dur(t.elapsed)} · ` : ''}
              {kilo(t.tokens)} tokens
            </Text>
          </Box>
          {sub !== '' && (
            <Text dimColor size="footnote" mono={t.running ? true : undefined} wrap="truncate-end">
              {sub}
            </Text>
          )}
          {!t.running && !t.dismissed && t.state !== 'shipped' && t.state !== 'review' && (
            <Box flexDirection="row" gap="sm">
              <Button key={`rv-${t.name}`} label={sent.includes(t.name) ? 'Sent ✓' : 'Review'} variant={sent.includes(t.name) ? undefined : 'primary'} onPress={() => void askReview($, t.name, t.state)} />
              <Button key={`ar-${t.name}`} label="Archive" onPress={() => void action($, ['--dismiss', t.name])} />
            </Box>
          )}
        </Box>
      )
    }
    const section = (title: string, list: GrokTask[]) =>
      list.length === 0 ? null : (
        <Box flexDirection="column" gap="xs" key={`s-${title}`}>
          <Text dimColor size="caption" weight="semibold">
            {title.toUpperCase()} · {list.length}
          </Text>
          {list.map(card)}
        </Box>
      )
    return (
      <Box flexDirection="column" gap="md" padding="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold">
            {running.length > 0 ? `${running.length} running` : 'All quiet'}
          </Text>
          <Text dimColor size="footnote" tabular>
            {tasks.length} task{tasks.length === 1 ? '' : 's'} · {kilo(today(tasks, now))} tokens today
          </Text>
        </Box>
        {err !== '' && <Text color={COLOR.failed}>{err}</Text>}
        {tasks.some(t => t.limited) && (
          <Text color={COLOR.failed}>Grok reported a rate or usage limit; new tasks may wait or fail.</Text>
        )}
        {tasks.length === 0 && err === '' && <Text dimColor>No Grok tasks yet.</Text>}
        {section('Running', running)}
        {section('Needs review', review)}
        {section('PR open', prOpen)}
        {section('Shipped', shipped)}
        {archived.length > 0 && (
          <Box flexDirection="column" gap="xs">
            <Button key="archived-toggle" plain dimColor onPress={() => void update($, showArchived, x => !x)}>
              {archivedOn ? '▾' : '▸'} {archived.length} archived
            </Button>
            {archivedOn && archived.map(card)}
          </Box>
        )}
        <Button key="new-open" label="+ New Grok task" variant="primary" onPress={() => void pick($, NEW)} />
        {note !== '' && (
          <Text dimColor size="footnote">
            {note}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, board)
    const sent = await read($, reviewSent)
    const tasks = all.filter(t => !t.dismissed && (t.running || t.idle < RECENT_S))
    if (e.props.hasSurvey || tasks.length === 0) return next(e)
    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const expanded = await read($, bandOpen)
    const openTask = async (n: string) => {
      await pick($, n)
      await $.ui.open({ id: PANE, title: 'Grok' })
    }
    // The pane's look in one strip: a quiet card, and each task a pill outlined in its state's colour.
    const pill = (t: GrokTask) => (
      <Box
        key={`band-${t.name}`}
        flexDirection="row"
        alignItems="center"
        gap="xs"
        flexShrink={0}
        borderStyle="round"
        borderColor="#333333"
        backgroundColor="#262626"
        paddingX="xs"
        hover={{ borderColor: COLOR[t.state] }}
      >
        <Svg
          source={glyph(t.state)}
          alt={LABEL[t.state]}
          width={12}
          height={12}
          isInteractive={t.state === 'running' ? true : undefined}
        />
        <Button key={`band-open-${t.name}`} plain onPress={() => void openTask(t.name)}>
          {t.name}
          {t.running ? <Text dimColor> {dur(t.elapsed)}</Text> : ''}
        </Button>
      </Box>
    )
    const head = (
      <Box flexDirection="row" alignItems="center" gap="xs" flexShrink={0}>
        <Text weight="semibold">Grok</Text>
        {all.some(t => t.limited) && (
          <Text color={COLOR.failed} size="footnote">
            rate-limited
          </Text>
        )}
      </Box>
    )
    const controls = (
      <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
        <Button key="band-toggle" plain dimColor onPress={() => void update($, bandOpen, x => !x)}>
          {expanded ? 'Less' : 'More'}
        </Button>
        <Button key="band-all" plain dimColor onPress={() => void openTask('')}>
          Open ›
        </Button>
      </Box>
    )
    const frame = { borderStyle: 'round', borderColor: '#2e2e2e', backgroundColor: '#1e1e1e', paddingX: 'sm' } as const
    if (!expanded) {
      const shown = tasks.slice(0, 4)
      return (
        <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="nowrap" overflow="hidden" {...frame}>
          {head}
          {shown.map(pill)}
          {tasks.length > shown.length && <Text dimColor>+{tasks.length - shown.length}</Text>}
          <Box flexGrow={1} />
          {controls}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap="xs" paddingY="xs" {...frame}>
        <Box flexDirection="row" alignItems="center" gap="sm">
          {head}
          <Box flexGrow={1} />
          {controls}
        </Box>
        {tasks.map(t => (
          <Box flexDirection="row" alignItems="center" gap="sm" key={`band-row-${t.name}`}>
            {pill(t)}
            <Text size="footnote" color={COLOR[t.state]} wrap="truncate-end">
              {LABEL[t.state]}
            </Text>
            <Box flexGrow={1}>
              <Text dimColor size="footnote" mono={t.running ? true : undefined} wrap="truncate-end">
                {t.running ? t.activity : t.last}
              </Text>
            </Box>
            {!t.running && t.state !== 'shipped' && t.state !== 'review' && (
              <Box flexDirection="row" gap="xs" flexShrink={0}>
                <Button key={`band-rv-${t.name}`} plain dimColor={sent.includes(t.name) ? true : undefined} onPress={() => void askReview($, t.name, t.state)}>
                  {sent.includes(t.name) ? 'Sent ✓' : 'Review'}
                </Button>
                <Button key={`band-ar-${t.name}`} plain dimColor onPress={() => void action($, ['--dismiss', t.name])}>
                  Archive
                </Button>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })

  on('command.run', { command: 'grok' }, async $ => {
    await pick($, '')
    await $.ui.open({ id: PANE, title: 'Grok' })

    return { text: 'Grok pane opened.' }
  })

  on('command.run', { command: 'grok-board' }, async $ => {
    await pick($, '')
    await $.ui.open({ id: PANE, title: 'Grok' })

    return { text: 'Grok pane opened.' }
  })
}
