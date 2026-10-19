import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GrokDetail, GrokTask } from '../types'

const PANE = 'grok-board'
const board = atom({ plugin: 'grok-bridge', key: 'board' } as const, [] as GrokTask[])
const error = atom({ plugin: 'grok-bridge', key: 'error' } as const, '')
const selected = atom({ plugin: 'grok-bridge', key: 'selected' } as const, '')
const detail = atom({ plugin: 'grok-bridge', key: 'detail' } as const, null as GrokDetail | null)

// The same quiet palette as the app's Context card: one colour per state.
const COLOR = { running: '#4a8cf7', done: '#2fa36b', failed: '#e0662f' } as const
const LABEL = { running: 'Running', done: 'Done', failed: 'Failed' } as const

const ago = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`)
const kilo = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`)
// Tokens Grok processed for tasks started in the last 24 hours. Grok exposes no remaining-quota figure, only usage.
const today = (tasks: GrokTask[], now: number) =>
  tasks.filter(t => now - t.started < 86400).reduce((sum, t) => sum + t.tokens, 0)
// Sizes on a Box are cells; an Svg is measured in CSS pixels, so the thin bar and the swatches are drawn as Svg.
// A running task gets a spinning arc. SMIL animation plays only in an interactive Svg, so `mark` sets that for it.
const spinner = (c: string, px: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="${c}" stroke-opacity="0.25" stroke-width="3"/><path d="M10 3 a7 7 0 0 1 7 7" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.9s" repeatCount="indefinite"/></path></svg>`
const swatch = (c: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" rx="2" fill="${c}"/></svg>`

const seen = new Map<string, GrokTask['state']>()
// The band shows running tasks and ones that finished in the last half hour.
const RECENT_S = 1800

async function refresh($: EngineInterface) {
  const r = await $.process.run(['python3', `${$.plugin.root}/bin/grok-watch.py`, '--json'])
  if (r.exitCode !== 0) {
    await update($, error, () => r.stderr.slice(0, 200) || 'grok-watch failed')
    return
  }
  const tasks = JSON.parse(r.stdout) as GrokTask[]
  // A toast when a task this session saw running finishes; the first read only learns the states.
  for (const t of tasks) {
    const was = seen.get(t.name)
    if (was === 'running' && t.state !== 'running') $.ui.toast(`Grok ${t.name}: ${LABEL[t.state].toLowerCase()}`)
    seen.set(t.name, t.state)
  }
  await update($, board, () => tasks)
  const running = tasks.filter(t => t.state === 'running').length
  $.ui.status(running > 0 ? `Grok: ${running} running` : undefined)
  await update($, error, () => '')
  const name = await read($, selected)
  if (name !== '') {
    const d = await $.process.run(['python3', `${$.plugin.root}/bin/grok-watch.py`, '--detail', name])
    if (d.exitCode === 0) await update($, detail, () => JSON.parse(d.stdout) as GrokDetail)
  }
}
async function pick($: EngineInterface, name: string) {
  await update($, selected, () => name)
  await update($, detail, () => null)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'grok-board', description: 'Show the Grok tasks in a pane' })
    await $.command.register({ name: 'grok', description: 'Open the Grok pane' })
    await update($, selected, () => '')
    void refresh($)
    $.clock.every(5000, () => void refresh($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Svg, Button, Code } = $.ui.resolve(e)
    const tasks = await read($, board)
    const err = await read($, error)
    const name = await read($, selected)

    if (name !== '') {
      const d = await read($, detail)
      const t = d ?? tasks.find(x => x.name === name)
      return (
        <Box flexDirection="column" gap="sm" padding="sm">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Button key="back" plain dimColor onPress={() => void pick($, '')}>
              ‹ All tasks
            </Button>
            {t && (
              <Text dimColor tabular>
                {LABEL[t.state]} · {ago(t.idle)} ago
              </Text>
            )}
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {t && (t.state === 'running' ? <Svg source={spinner(COLOR.running, 14)} alt="Running" width={14} height={14} isInteractive /> : <Svg source={swatch(COLOR[t.state])} alt={LABEL[t.state]} width={10} height={10} />)}
            <Text weight="semibold">{name}</Text>
          </Box>
          {d === null && <Text dimColor>Loading...</Text>}
          {d && (
            <Box flexDirection="column" gap="sm">
              <Text dimColor size="footnote">
                {d.meta.model ?? 'grok'} · {kilo(d.tokens)} tokens · {d.total} steps · {d.files} file
                {d.files === 1 ? '' : 's'} changed{d.meta.started ? ` · started ${d.meta.started}` : ''}
              </Text>
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
              {d.entries.map((x, i) =>
                x.kind === 'tool' ? (
                  <Text key={`e${i}`} mono size="footnote" dimColor wrap="truncate-end">
                    ▸ {x.body}
                  </Text>
                ) : x.kind === 'thought' ? (
                  <Text key={`e${i}`} italic dimColor size="footnote">
                    {x.body}
                  </Text>
                ) : (
                  <Text key={`e${i}`}>{x.body}</Text>
                ),
              )}
            </Box>
          )}
        </Box>
      )
    }

    const count = (s: GrokTask['state']) => tasks.filter(x => x.state === s).length
    const states = (['running', 'done', 'failed'] as const).filter(s => count(s) > 0)
    let x = 0
    const segs = states
      .map(s => {
        const w = (count(s) / Math.max(1, tasks.length)) * 100
        const r = `<rect x="${x}" y="0" width="${w}" height="4" fill="${COLOR[s]}"/>`
        x += w
        return r
      })
      .join('')
    const bar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 4" preserveAspectRatio="none" width="100%" height="4"><rect width="100" height="4" rx="2" fill="#3a3a3a"/>${segs}</svg>`

    return (
      <Box flexDirection="column" gap="sm" padding="sm">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>{count('running')} running</Text>
          <Text dimColor tabular>
            {tasks.length} task{tasks.length === 1 ? '' : 's'} · {kilo(today(tasks, Date.now() / 1000))} tokens today
          </Text>
        </Box>
        {tasks.length > 0 && <Svg source={bar} alt={`${count('running')} of ${tasks.length} running`} height={4} />}
        {err !== '' && <Text color={COLOR.failed}>{err}</Text>}
        {tasks.some(t => t.limited) && (
          <Text color={COLOR.failed}>Grok reported a rate or usage limit; new tasks may wait or fail.</Text>
        )}
        {tasks.length === 0 && err === '' && <Text dimColor>No Grok tasks yet.</Text>}
        {tasks.map(t => (
          <Box flexDirection="column" key={t.name}>
            <Box flexDirection="row" alignItems="center" gap="sm">
              {t.state === 'running' ? <Svg source={spinner(COLOR.running, 14)} alt="Running" width={14} height={14} isInteractive /> : <Svg source={swatch(COLOR[t.state])} alt={LABEL[t.state]} width={10} height={10} />}
              <Box flexGrow={1}>
                <Button key={`open-${t.name}`} plain onPress={() => void pick($, t.name)}>
                  {t.name}
                </Button>
              </Box>
              <Text dimColor tabular>
                {LABEL[t.state]} · {t.files} file{t.files === 1 ? '' : 's'} · {ago(t.idle)}
              </Text>
            </Box>
            {t.last !== '' && (
              <Text dimColor size="footnote" wrap="truncate-end">
                {t.last}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, board)
    const tasks = all.filter(t => t.state === 'running' || t.idle < RECENT_S)
    if (e.props.hasSurvey || tasks.length === 0) return next(e)
    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const running = tasks.filter(t => t.state === 'running').length

    return (
      <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
        <Text dimColor>Grok</Text>
        <Text dimColor tabular>
          {running} running · {kilo(today(all, Date.now() / 1000))} tokens today
        </Text>
        {all.some(t => t.limited) && <Text color={COLOR.failed}>rate-limited</Text>}
        {tasks.slice(0, 4).map(t => (
          <Box flexDirection="row" alignItems="center" gap="xs" key={`band-${t.name}`}>
            {t.state === 'running' ? <Svg source={spinner(COLOR.running, 12)} alt="Running" width={12} height={12} isInteractive /> : <Svg source={swatch(COLOR[t.state])} alt={LABEL[t.state]} width={8} height={8} />}
            <Button
              key={`band-open-${t.name}`}
              plain
              dimColor
              onPress={async () => {
                await pick($, t.name)
                await $.ui.open({ id: PANE, title: 'Grok' })
              }}
            >
              {t.name} <Text dimColor>{LABEL[t.state].toLowerCase()}</Text>
            </Button>
          </Box>
        ))}
        {tasks.length > 4 && <Text dimColor>+{tasks.length - 4}</Text>}
        <Button key="band-all" plain dimColor onPress={async () => { await pick($, ''); await $.ui.open({ id: PANE, title: 'Grok' }) }}>
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
    await $.ui.open({ id: PANE, title: 'Grok' })

    return { text: 'Grok pane opened.' }
  })
}
