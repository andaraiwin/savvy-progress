export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; title: string; status: TaskStatus }

/** What a model loop is doing this moment. */
export type Phase = 'starting' | 'thinking' | 'writing' | 'tool' | 'idle'

export type Status = 'running' | 'idle' | 'done' | 'failed' | 'stopped'

export type WorkerKind = 'main' | 'subagent' | 'fork' | 'teammate' | 'workflow' | 'engine'

/** One model loop at work: the main conversation, a subagent, a teammate, a workflow agent or an engine helper. */
export type Worker = {
  id: string
  kind: WorkerKind
  label: string
  type: string
  /** The model's display name (`Opus 5.5`); `modelId` is the id the API reports, which prices and sizes it. */
  model: string
  modelId: string
  effort?: string
  parentId?: string
  runId?: string
  index?: number
  isBackground: boolean
  status: Status
  phase: Phase
  activity: string
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  /** Output tokens, summed over its requests. */
  tokens: number
  /** Input tokens (uncached, cache-read and cache-written), summed over its requests. */
  inputTokens: number
  /** The last request's input side: how full its context window is. */
  context: number
  /** An estimate at list prices, summed over its requests. */
  costUsd: number
  /** Its own todo list, when it keeps one. */
  todo?: { done: number; total: number; active?: string }
  /** One phase letter per second, newest last: t thinking, w writing, x tool, s starting, i idle, space absent. */
  trail: string
}

/** A Workflow tool run: the orchestrator whose agents are the workers carrying its id as `runId`. */
export type Run = { id: string; taskId?: string; name: string; status: Status; startedAt: number; endedAt?: number }

/** A background shell or monitor. */
export type Job = { id: string; kind: 'shell' | 'monitor'; label: string; status: Status; startedAt: number; endedAt?: number }

export type Server = { name: string; calls: number; active: number }

export type FeedItem = { at: number; who: string; text: string; tone: 'info' | 'good' | 'bad' }

export type Usage = {
  contextPercent?: number
  contextTokens?: number
  window: number
  costUsd?: number
  limits: { kind: string; percent: number }[]
}

export type Turn = { isRunning: boolean; startedAt: number; endedAt?: number; tools: number; files: string[]; outcome?: string }

export type Board = {
  now: number
  turn: Turn | null
  tasks: Task[]
  workers: Worker[]
  runs: Run[]
  jobs: Job[]
  servers: Server[]
  feed: FeedItem[]
  usage: Usage | null
  /** Every request's tokens and estimated cost since the session (or /clear) began, kept through prunes. */
  totalTokens: number
  totalCost: number
  hasAutoOpened: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': { board: Board; isHidden: boolean; isFinishedShut: boolean }
  }
}
