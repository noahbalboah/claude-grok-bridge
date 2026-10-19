export type GrokTask = {
  name: string
  state: 'running' | 'done' | 'failed'
  events: number
  idle: number
  files: number
  last: string
  tokens: number
  limited: boolean
  started: number
}

export type GrokEntry = { kind: 'text' | 'thought' | 'tool'; body: string }

export type GrokDetail = GrokTask & {
  brief: string
  meta: { [key: string]: string }
  diffstat: string
  stderr: string
  tokens: number
  total: number
  entries: GrokEntry[]
}

declare module 'claude-code' {
  interface PluginState {
    'grok-bridge': { board: GrokTask[]; error: string; selected: string; detail: GrokDetail | null }
  }
}
