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
const draft = atom({ plugin: 'grok-bridge', key: 'draft' } as const, { name: '', repo: '', brief: '', followup: '' } as GrokDraft)

const COLOR: Record<GrokState, string> = {
  running: '#4a8cf7',
  stuck: '#e3a008',
  done: '#2fa36b',
  failed: '#e0662f',
  shipped: '#8b5cf6',
}
const LABEL: Record<GrokState, string> = {
  running: 'Running',
  stuck: 'Needs a look',
  done: 'Ready to review',
  failed: 'Failed',
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
          : state === 'shipped'
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

async function run($: EngineInterface, args: string[]) {
  return $.process.run(['python3', `${$.plugin.root}/bin/grok-watch.py`, ...args])
}

const seen = new Map<string, GrokState>()

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
    if ((was === 'running' || was === 'stuck') && !t.running) $.ui.toast(`Grok ${t.name}: ${LABEL[t.state].toLowerCase()}`)
    else if (was === 'running' && t.state === 'stuck') $.ui.toast(`Grok ${t.name} has gone quiet`)
    seen.set(t.name, t.state)
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
    const { Box, Text, Svg, Button, Code, Input, Link } = $.ui.resolve(e)
    const tasks = await read($, board)
    const err = await read($, error)
    const name = await read($, selected)
    const note = await read($, notice)
    const dr = await read($, draft)
    const icon = (s: GrokState, px: number) => (
      <Svg source={glyph(s)} alt={LABEL[s]} width={px} height={px} isInteractive={s === 'running' ? true : undefined} />
    )
    const prChip = (t: GrokTask) =>
      t.pr.url ? (
        <Link href={t.pr.url} label={`PR #${t.pr.number} · ${(t.pr.state ?? '').toLowerCase()}`} />
      ) : null

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
                {!d.running && d.state !== 'shipped' && (
                  <Button
                    key="review"
                    label="Ask Claude to review"
                    variant="primary"
                    onPress={() =>
                      void $.prompt.submit({
                        text: `Review Grok task ${name}: read its diff with grok_diff and its summary with grok_status, run the checks, and if it holds up commit it and open the PR; otherwise tell me what is wrong.`,
                      })
                    }
                  />
                )}
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
    const running = tasks.filter(t => t.running)
    const review = tasks.filter(t => !t.running && t.state !== 'shipped')
    const shipped = tasks.filter(t => t.state === 'shipped')
    const row = (t: GrokTask) => (
      <Box flexDirection="column" key={t.name}>
        <Box flexDirection="row" alignItems="center" gap="sm">
          {icon(t.state, 14)}
          <Box flexGrow={1}>
            <Button key={`open-${t.name}`} plain dimColor={t.state === 'shipped' ? true : undefined} onPress={() => void pick($, t.name)}>
              {t.name}
            </Button>
          </Box>
          {(t.added > 0 || t.removed > 0) && (
            <Svg source={diffBar(t.added, t.removed)} alt={`+${t.added} −${t.removed}`} width={40} height={6} />
          )}
          <Text dimColor tabular>
            {t.added > 0 || t.removed > 0 ? `+${t.added} −${t.removed} · ` : ''}
            {dur(t.elapsed)} · {kilo(t.tokens)} tok
          </Text>
        </Box>
        {t.running && t.activity !== '' ? (
          <Text mono dimColor size="footnote" wrap="truncate-end">
            ▸ {t.activity}
          </Text>
        ) : t.last !== '' && t.state !== 'shipped' ? (
          <Text dimColor size="footnote" wrap="truncate-end">
            {t.last}
          </Text>
        ) : null}
        {prChip(t)}
      </Box>
    )
    const section = (title: string, list: GrokTask[]) =>
      list.length === 0 ? null : (
        <Box flexDirection="column" gap="xs" key={`s-${title}`}>
          <Text dimColor size="footnote" weight="medium">
            {title.toUpperCase()} · {list.length}
          </Text>
          {list.map(row)}
        </Box>
      )
    const lastRepo = dr.repo
    return (
      <Box flexDirection="column" gap="sm" padding="sm">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>{running.length} running</Text>
          <Text dimColor tabular>
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
        {section('Shipped', shipped)}
        <Box flexDirection="column" gap="xs">
          <Text dimColor size="footnote" weight="medium">
            NEW TASK
          </Text>
          <Input
            key="new-name"
            placeholder="name (lowercase-with-dashes)"
            value={dr.name}
            onInput={v => void update($, draft, x => ({ ...x, name: v }))}
            onSubmit={v => void update($, draft, x => ({ ...x, name: v }))}
          />
          <Input
            key="new-repo"
            placeholder="repo path (an absolute git checkout)"
            value={lastRepo}
            onInput={v => void update($, draft, x => ({ ...x, repo: v }))}
            onSubmit={v => void update($, draft, x => ({ ...x, repo: v }))}
          />
          <Input
            key="new-brief"
            placeholder="brief: what to do, where, and what done looks like"
            submitLabel="Start"
            value={dr.brief}
            onInput={v => void update($, draft, x => ({ ...x, brief: v }))}
            onSubmit={v => {
              const n = dr.name.trim()
              const repo = dr.repo.trim()
              if (n === '' || repo === '' || v.trim() === '') {
                void update($, notice, () => 'A new task needs a name, a repo and a brief.')
                return
              }
              void update($, draft, x => ({ ...x, name: '', brief: '' }))
              void action($, ['--start', n, repo, v.trim()])
            }}
          />
          {note !== '' && (
            <Text dimColor size="footnote">
              {note}
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, board)
    const tasks = all.filter(t => t.running || t.idle < RECENT_S)
    if (e.props.hasSurvey || tasks.length === 0) return next(e)
    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const running = tasks.filter(t => t.running).length

    return (
      <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
        <Text dimColor>Grok</Text>
        <Text dimColor tabular>
          {running} running
        </Text>
        {all.some(t => t.limited) && <Text color={COLOR.failed}>rate-limited</Text>}
        {tasks.slice(0, 3).map(t => (
          <Box flexDirection="row" alignItems="center" gap="xs" key={`band-${t.name}`}>
            <Svg
              source={glyph(t.state)}
              alt={LABEL[t.state]}
              width={12}
              height={12}
              isInteractive={t.state === 'running' ? true : undefined}
            />
            <Button
              key={`band-open-${t.name}`}
              plain
              dimColor
              onPress={async () => {
                await pick($, t.name)
                await $.ui.open({ id: PANE, title: 'Grok' })
              }}
            >
              {t.name}{' '}
              <Text dimColor>
                {t.running
                  ? `${dur(t.elapsed)}${t.activity ? ` · ${short(t.activity, 40)}` : ''}`
                  : LABEL[t.state].toLowerCase()}
              </Text>
            </Button>
          </Box>
        ))}
        {tasks.length > 3 && <Text dimColor>+{tasks.length - 3}</Text>}
        <Button
          key="band-all"
          plain
          dimColor
          onPress={async () => {
            await pick($, '')
            await $.ui.open({ id: PANE, title: 'Grok' })
          }}
        >
          All
        </Button>
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
