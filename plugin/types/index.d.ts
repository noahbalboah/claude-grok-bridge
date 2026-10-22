export type GrokState = 'running' | 'stuck' | 'done' | 'failed' | 'review' | 'shipped'

export type GrokPr = { number?: number; state?: string; url?: string }

export type GrokTask = {
  name: string
  state: GrokState
  running: boolean
  tokens: number
  events: number
  idle: number
  started: number
  elapsed: number
  activity: string
  last: string
  files: number
  added: number
  removed: number
  hit_limit: boolean
  // The run's exit code, null while it runs or when it was stopped from outside; `ended` is when it exited.
  exit_code: string | null
  ended: number
  // Why a stopped task needs review (turn limit, a nonzero exit, an unreviewed diff); '' otherwise.
  why: string
  // The owning session was already told about this run.
  claimed: boolean
  limited: boolean
  pr: GrokPr
  repo: string
  dismissed: boolean
  // The Claude session that started the task; '' for one started outside Claude.
  owner: string
  worktree: string
}

export type GrokEntry = { kind: 'text' | 'thought' | 'tool'; body: string }

export type GrokDetail = GrokTask & {
  brief: string
  meta: { [key: string]: string }
  diffstat: string
  stderr: string
  total: number
  entries: GrokEntry[]
}

export type GrokDraft = {
  name: string
  repo: string
  brief: string
  followup: string
  show: boolean
  model: string
  turns: string
}

declare module 'claude-code' {
  interface PluginState {
    'grok-bridge': {
      board: GrokTask[]
      error: string
      selected: string
      detail: GrokDetail | null
      notice: string
      open: string[]
      draft: GrokDraft
      bandOpen: boolean
      showArchived: boolean
      reviewSent: string[]
    }
  }
}
