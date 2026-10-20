import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Board, FeedItem, Phase, Run, Status, Task, Worker, WorkerKind } from '../types'

const PANE = 'savvy-progress'
const MAIN = 'main'
const FAST_TICK = 500
const SLOW_TICK = 5000
const FLUSH_MS = 100
const TRAIL = 240
const FEED = 40
const MAX_WORKERS = 80
const BAND_ROWS = 8
const ANIM_MS = 150
const FINISHED_SHOWN = 8

const EMPTY: Board = {
  now: 0,
  turn: null,
  tasks: [],
  workers: [],
  runs: [],
  jobs: [],
  servers: [],
  feed: [],
  usage: null,
  totalTokens: 0,
  totalCost: 0,
  hasAutoOpened: false,
}

const boardState = atom({ plugin: 'savvy-progress', key: 'board' } as const, EMPTY)
const isHidden = atom({ plugin: 'savvy-progress', key: 'isHidden' } as const, false)
const isFinishedShut = atom({ plugin: 'savvy-progress', key: 'isFinishedShut' } as const, false)

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const TOOL_SPIN = '◐◓◑◒'
const LETTER: Record<Phase, string> = { starting: 's', thinking: 't', writing: 'w', tool: 'x', idle: 'i' }
const TRAIL_RGB: Record<string, number> = { s: 0x8a8a8a, t: 0xd97757, w: 0x6aa8ff, x: 0xe5b14a, i: 0x4a4a4a }
const DEFAULT_COLOR = 0x01000000
const NOTICE = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)

  if (h > 0) {
    return `${h}h ${String(m % 60).padStart(2, '0')}m`
  }

  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))

  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

const amount = (n: number) => {
  const short = (x: number) => x.toFixed(x >= 100 ? 0 : 1).replace(/\.0$/, '')

  return n >= 1_000_000 ? `${short(n / 1_000_000)}M` : n >= 1000 ? `${short(n / 1000)}k` : String(n)
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path

const clip = (text: string, size: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > size ? `${flat.slice(0, Math.max(0, size - 1))}…` : flat
}

const fit = (text: string, size: number) => clip(text, size).padEnd(size)

const modelName = (id: string) => {
  const m = /(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?)?/i.exec(id)

  if (!m || m[1] === undefined) {
    return clip(id.replace(/^claude-/, ''), 16)
  }

  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  const version = m[2] === undefined ? '' : m[3] === undefined ? ` ${m[2]}` : ` ${m[2]}.${m[3]}`

  return `${family}${version}${/\[1m\]/i.test(id) ? ' 1M' : ''}`
}

const modelColor = (name: string) =>
  /opus/i.test(name)
    ? '#b48cff'
    : /sonnet/i.test(name)
      ? '#6aa8ff'
      : /haiku/i.test(name)
        ? '#4fd1a5'
        : /fable/i.test(name)
          ? '#f2b84b'
          : 'inactive'

const mcpServer = (tool: string) => /^mcp__(.+?)__.+$/.exec(tool)?.[1]?.replace(/^claude_ai_/, '')

const describe = (e: { tool: string } & Record<string, unknown>) => {
  const text = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  const path = text('file_path') || text('notebook_path')
  const arg =
    (path && basename(path)) ||
    text('description') ||
    text('pattern') ||
    text('command') ||
    text('query') ||
    text('url') ||
    text('skill') ||
    text('subject') ||
    text('prompt')
  const server = mcpServer(e.tool)
  const name = server === undefined ? e.tool : `${server}·${e.tool.replace(/^mcp__.+?__/, '')}`

  return arg ? `${name} ${clip(arg, 60)}` : name
}

const isOver = (status: Status) => status === 'done' || status === 'failed' || status === 'stopped'

const statusOf = (word: string): Status =>
  /fail|error/i.test(word) ? 'failed' : /kill|stop|cancel|abort/i.test(word) ? 'stopped' : 'done'

const workflowName = (script: unknown) =>
  typeof script === 'string' ? /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)?.[1] : undefined

const blank = (id: string, kind: WorkerKind, now: number): Worker => ({
  id,
  kind,
  label: kind === 'main' ? 'Main loop' : 'helper',
  type: kind,
  model: '',
  modelId: '',
  isBackground: false,
  status: 'running',
  phase: 'starting',
  activity: '',
  startedAt: now,
  steps: 0,
  tools: 0,
  tokens: 0,
  inputTokens: 0,
  context: 0,
  costUsd: 0,
  trail: '',
})

// Cost and size: list prices in US dollars per million tokens (input, output, cache read), a 5-minute cache write at 1.25× input.

const PRICES: readonly (readonly [RegExp, number, number, number])[] = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-8])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku/, 0.8, 4, 0.08],
]

type Tokens = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const promptOf = (u: Tokens) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/** One request's cost at list price; 0 for a model the table does not know. Haiku 5.5 bills a prompt over 100k at five times. */
const costOf = (u: Tokens, modelId: string) => {
  const price = PRICES.find(([pattern]) => pattern.test(modelId))
  if (price === undefined) {
    return 0
  }
  const [, input, output, hit] = price
  const scale = /haiku-5/.test(modelId) && promptOf(u) > 100_000 ? 5 : 1

  return (
    (scale *
      (u.input_tokens * input +
        u.cache_creation_input_tokens * input * 1.25 +
        u.cache_read_input_tokens * hit +
        u.output_tokens * output)) /
    1_000_000
  )
}

const ONE_MILLION = /fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5|\[1m\]/i

/** A model's context window: the session's own figure for the main loop's model, else 1M where the model has it. */
const windowOf = (b: Board, modelId: string) => {
  const main = b.workers.find(w => w.id === MAIN)
  if (b.usage !== null && main !== undefined && main.modelId !== '' && main.modelId === modelId) {
    return b.usage.window
  }

  return ONE_MILLION.test(modelId) ? 1_000_000 : 200_000
}

/** Folds one request into a worker and the session's totals. */
const spend = (b: Board, w: Worker, u: Tokens, modelId: string) => {
  const cost = costOf(u, modelId)
  w.tokens += u.output_tokens
  w.inputTokens += promptOf(u)
  w.context = promptOf(u)
  w.costUsd += cost
  b.totalTokens += promptOf(u) + u.output_tokens
  b.totalCost += cost
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60)

  return h > 0 ? `${h}:${mm.padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${mm}:${String(s % 60).padStart(2, '0')}`
}

const dollars = (usd: number) => `≈$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

/** Effort as the weight of the work, each with the color its card's bar and word take. */
const TIER: Record<string, { word: string; color: string }> = {
  low: { word: 'light', color: '#4fd1a5' },
  medium: { word: 'medium', color: '#6aa8ff' },
  high: { word: 'careful', color: '#e5b14a' },
  xhigh: { word: 'heavy', color: '#e8825f' },
  max: { word: 'max', color: '#e05d5d' },
}

// The crew: every worker is a small pixel critter in a hat, lit from the upper left. The terminal draws it two pixels
// to a cell with half blocks and repaints it in place; every other surface plays the same frames as an SVG loop.

const SPRITE_W = 12
const SPRITE_ROWS = 4
const SPRITE_H = SPRITE_ROWS * 2
/** Frames in one loop: every motion's period divides it, so a surface can play the loop on repeat. */
const LOOP = 24
const SVG_SCALE = 7
/** The band's critters: a row tall, beside the line each leads. */
const MINI_SCALE = 3
const MINI_COLUMNS = 6
const EYE = 0x1c1c1c
const MOUTH = 0x5e2618
const WOOD = 0x8a5a2b

/** The clay's light, base and shade, by how the work stands. */
const SKIN = {
  live: [0xeb9473, 0xd97757, 0xb5603f],
  failed: [0xab7d74, 0x9b6a62, 0x7d5049],
  stopped: [0x8c8c8c, 0x7a7a7a, 0x5e5e5e],
} as const

const INK = {
  blush: 0xf29a9a,
  tear: 0x8ec5ff,
  thought: 0xc9c3ff,
  idea: 0xffe08a,
  spark: 0xffe08a,
  twinkle: 0xfff4c2,
  page: 0xe8e4d8,
  pencil: 0xf2c14e,
  lead: 0x3a3a3a,
  smoke: [0x8a8a8a, 0xb0b0b0],
  sleep: [0x8fa3c0, 0xb8c6dc],
  confetti: [0xf2c14e, 0x6aa8ff, 0xf29a9a],
} as const

/** The shoes a helper wears, picked by its id, so two in the same hat still tell apart. */
const SHOES = [0x6aa8ff, 0x4fd1a5, 0xe5b14a, 0xc9a8ff, 0x5fc7d8, 0xe8825f]

/** A pixel placed from the spot just right of the critter's head: x, y, color. */
type Pixel = readonly [number, number, number]

/** What a critter swings while a tool runs: raised on one beat, struck on the next. */
const PROPS = {
  hammer: {
    up: [[0, 0, WOOD], [0, -1, 0x8b939c], [1, -1, 0x8b939c]],
    down: [[0, 2, WOOD], [1, 2, 0x8b939c], [1, 3, 0x8b939c], [0, 4, INK.spark]],
  },
  pick: {
    up: [[0, 0, WOOD], [0, -1, 0xc0c8d0], [1, -1, 0xc0c8d0], [1, 0, 0xc0c8d0]],
    down: [[0, 2, WOOD], [1, 1, 0xc0c8d0], [1, 2, 0xc0c8d0], [1, 3, 0xc0c8d0], [0, 4, 0xc9a27a], [1, 5, 0xc9a27a]],
  },
  wand: {
    up: [[0, 0, 0x5a3a2a], [1, -1, 0xf2c14e], [0, -2, 0xc9a8ff]],
    down: [[0, 1, 0x5a3a2a], [1, 1, 0xf2c14e], [1, 3, 0xc9a8ff]],
  },
  scepter: {
    up: [[0, 0, 0xf2b84b], [1, -1, 0xe05d5d], [0, -2, INK.twinkle]],
    down: [[0, 1, 0xf2b84b], [1, 1, 0xe05d5d], [1, 3, INK.twinkle]],
  },
  book: {
    up: [[0, 0, INK.page], [1, 0, INK.page], [0, 1, WOOD], [1, 1, WOOD]],
    down: [[0, 0, INK.page], [1, 0, 0xc8c0aa], [0, 1, WOOD], [1, 1, WOOD]],
  },
} satisfies Record<string, { up: readonly Pixel[]; down: readonly Pixel[] }>

/** Two rows of hat, twelve pixels wide: each letter a color of the hat's, a dot bare. Its `glow` letter pulses while the critter works. */
type Hat = { rows: readonly [string, string]; colors: Record<string, number>; glow?: { key: string; dim: number }; prop: keyof typeof PROPS }

const HATS = {
  crown: {
    rows: ['..y.yy.y....', '..ygrryY....'],
    colors: { y: 0xf2b84b, Y: 0xc9922e, r: 0xe05d5d, g: 0xfff4c2 },
    glow: { key: 'g', dim: 0xf2b84b },
    prop: 'scepter',
  },
  hardhat: { rows: ['..hyyyyy....', '.YYYYYYYYY..'], colors: { h: 0xffe08a, y: 0xf2c14e, Y: 0xd9a62e }, prop: 'hammer' },
  captain: {
    rows: ['.wwwwwwws...', '.bbbobbbbkk.'],
    colors: { w: 0xf0f0f0, s: 0xc8c8c8, b: 0x3b6fd8, o: 0xf2c14e, k: 0x4a5060 },
    prop: 'hammer',
  },
  cap: { rows: ['..ggfggg....', '.gggggggPPP.'], colors: { g: 0x2fa36b, f: 0xf0f0f0, P: 0x1f7a4d }, prop: 'hammer' },
  miner: {
    rows: ['..nnLLnn....', '.NNNNNNNN...'],
    colors: { n: 0x8a5a2b, N: 0x6b4420, L: 0xffe08a },
    glow: { key: 'L', dim: 0x5a4a2a },
    prop: 'pick',
  },
  wizard: {
    rows: ['....pp.*....', '.pppppppP...'],
    colors: { p: 0x8f6ad8, P: 0x6c4cb0, '*': 0xf2c14e },
    glow: { key: '*', dim: 0x7a6a3a },
    prop: 'wand',
  },
  grad: { rows: ['hkkkkkkkkk..', '..KKKKKK.q..'], colors: { h: 0x6a7284, k: 0x4a5060, K: 0x343844, q: 0xf2c14e }, prop: 'book' },
  beanie: { rows: ['....ww......', '.rRrRrRrR...'], colors: { w: 0xf0f0f0, r: 0xd9534f, R: 0xa83b38 }, prop: 'hammer' },
  none: { rows: ['............', '............'], colors: {}, prop: 'hammer' },
} satisfies Record<string, Hat>

const CREW: readonly Hat[] = [HATS.hardhat, HATS.cap, HATS.captain, HATS.miner, HATS.grad, HATS.wizard, HATS.beanie]

const TYPE_HATS: Record<string, Hat> = {
  Explore: HATS.miner,
  Plan: HATS.wizard,
  'general-purpose': HATS.hardhat,
  'claude-code-guide': HATS.grad,
}

const seedOf = (id: string) => {
  let h = 7
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0
  }

  return Math.abs(h)
}

const hatOf = (w: Worker): Hat => {
  switch (w.kind) {
    case 'main':
      return HATS.crown
    case 'teammate':
      return HATS.beanie
    case 'fork':
      return HATS.captain
    case 'engine':
      return HATS.none
    case 'workflow':
      return CREW[((w.index ?? seedOf(w.id)) + CREW.length - 1) % CREW.length] ?? HATS.hardhat
    default:
      return TYPE_HATS[w.type] ?? CREW[seedOf(w.type) % CREW.length] ?? HATS.hardhat
  }
}

/** Where the eyes look while thinking or idle, a quarter loop at a time. */
const LOOK = [0, 0, -1, 0, 0, 1]

/**
 * The critter's pixels for this moment, -1 where bare. A working one moves as its phase does: it bobs under a
 * rising thought while thinking, looks down and scribbles while writing, swings its tool while one runs, and looks
 * about and blinks between. A finished one cheers, a failed one sheds a tear under a puff of smoke, a stopped one sleeps.
 */
const critter = (w: Worker, now: number) => {
  const px = new Int32Array(SPRITE_W * SPRITE_H).fill(-1)
  const set = (x: number, y: number, color: number) => {
    if (x >= 0 && x < SPRITE_W && y >= 0 && y < SPRITE_H) {
      px[y * SPRITE_W + x] = color
    }
  }
  const isWorking = w.status === 'running'
  const f = isWorking ? Math.floor(now / ANIM_MS) + seedOf(w.id) : 0
  const phase: Phase = isWorking ? w.phase : 'idle'
  const beat = (f >> 1) & 1
  const top = 2 + (phase === 'thinking' ? beat : 0)
  const [light, base, shade] = SKIN[w.status === 'failed' ? 'failed' : w.status === 'stopped' ? 'stopped' : 'live']
  const put = (pixels: readonly Pixel[]) => pixels.forEach(([dx, dy, color]) => set(10 + dx, top + dy, color))

  const hat = hatOf(w)
  hat.rows.forEach((row, dy) => {
    for (let x = 0; x < SPRITE_W; x++) {
      const key = row.charAt(x)
      const color = hat.colors[key]
      if (color !== undefined) {
        set(x, top - 2 + dy, isWorking && beat === 1 && hat.glow?.key === key ? hat.glow.dim : color)
      }
    }
  })

  // The body, rounded at the top, lit along its crown and shaded down its right side and underneath.
  for (let y = top; y < top + 4; y++) {
    for (let x = 1; x <= 8; x++) {
      if (y !== top || (x !== 1 && x !== 8)) {
        set(x, y, y === top + 3 || x === 8 ? shade : y === top ? light : base)
      }
    }
  }
  const shoe = w.kind === 'main' ? 0xc9922e : w.kind === 'engine' ? shade : (SHOES[seedOf(w.id) % SHOES.length] ?? shade)

  const look = phase === 'writing' ? ((f >> 2) % 3) - 1 : phase === 'tool' ? 0 : (LOOK[(f >> 2) % LOOK.length] ?? 0)
  if (w.status === 'done') {
    for (const x of [3, 6]) {
      set(x, top + 1, EYE)
      set(x + (x < 4 ? -1 : 1), top + 2, INK.blush)
    }
  } else if (w.status === 'failed') {
    set(3, top + 2, EYE)
    set(6, top + 2, EYE)
    set(3, top + 3, INK.tear)
  } else if (w.status === 'stopped') {
    for (const x of [2, 6]) {
      set(x, top + 2, EYE)
      set(x + 1, top + 2, EYE)
    }
  } else if (isWorking && f % LOOP === LOOP - 1) {
    set(3 + look, top + 2, shade)
    set(6 + look, top + 2, shade)
  } else {
    for (const x of [3 + look, 6 + look]) {
      if (phase !== 'writing') {
        set(x, top + 1, EYE)
      }
      if (phase !== 'thinking') {
        set(x, top + 2, EYE)
      }
    }
  }

  const [left, right] =
    w.status === 'done'
      ? [top - 1, top - 1]
      : w.status === 'failed'
        ? [top + 3, top + 3]
        : phase === 'writing'
          ? f % 2 === 0
            ? [top + 1, top + 2]
            : [top + 2, top + 1]
          : phase === 'tool'
            ? [top + 2, top + 1 + beat]
            : [top + 2, top + 2]
  set(0, left, base)
  set(9, right, shade)
  if (w.status === 'done') {
    set(0, top, base)
    set(9, top, shade)
  }

  // A mouth to smile with when done, and to talk with while writing.
  if (w.status === 'done' || (phase === 'writing' && beat === 0)) {
    set(4, top + 3, MOUTH)
    set(5, top + 3, MOUTH)
  }

  if (w.status === 'done') {
    put([[0, -2, INK.confetti[0]], [1, 0, INK.confetti[1]], [0, 2, INK.confetti[2]]])
  } else if (w.status === 'failed') {
    put([[0, -1, INK.smoke[0]], [1, -2, INK.smoke[1]]])
  } else if (w.status === 'stopped') {
    put([[0, -1, INK.sleep[0]], [1, -2, INK.sleep[1]]])
  } else if (phase === 'thinking') {
    // A thought rises a bubble at a time, lights up, and pops.
    const step = (f >> 2) % 6
    const bubbles: Pixel[] = [[0, 0, INK.thought], [1, -1, INK.thought], [0, -2, step === 4 ? INK.idea : INK.thought]]
    put(bubbles.slice(0, step === 5 ? 0 : Math.min(step, 3)))
  } else if (phase === 'writing') {
    put([[0, 3, INK.page], [1, 3, INK.page], [0, right - top, INK.pencil], [1, right - top + 1, INK.lead]])
  } else if (phase === 'tool') {
    const prop = PROPS[hat.prop]
    put(beat === 0 ? prop.up : prop.down)
  } else if (phase === 'starting') {
    put(beat === 0 ? [[0, -1, INK.twinkle], [1, 2, INK.twinkle]] : [[1, 0, INK.twinkle], [0, 3, INK.twinkle]])
  }

  const stride = phase === 'tool' ? beat : -1
  ;[1, 3, 6, 8].forEach((x, i) => {
    const isLifted = i % 2 === stride
    const sole = SPRITE_H - (isLifted ? 2 : 1)
    for (let y = top + 4; y <= sole; y++) {
      set(x, y, y === sole ? shoe : base)
    }
  })

  return px
}

/** The critter as Raster cells: each cell's upper half block takes the top pixel as its foreground, the lower one as its background. */
const spriteCells = (w: Worker, now: number) => {
  const px = critter(w, now)
  const words = new Uint32Array(SPRITE_W * SPRITE_ROWS * 3)

  for (let r = 0; r < SPRITE_ROWS; r++) {
    for (let c = 0; c < SPRITE_W; c++) {
      const top = px[2 * r * SPRITE_W + c] ?? -1
      const low = px[(2 * r + 1) * SPRITE_W + c] ?? -1
      const at = (r * SPRITE_W + c) * 3
      const [glyph, fg, bg] =
        top < 0 && low < 0
          ? [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
          : low < 0
            ? [0x2580, top, DEFAULT_COLOR]
            : top < 0
              ? [0x2584, low, DEFAULT_COLOR]
              : top === low
                ? [0x2588, top, DEFAULT_COLOR]
                : [0x2580, top, low]
      words[at] = glyph
      words[at + 1] = fg
      words[at + 2] = bg
    }
  }

  return base64(new Uint8Array(words.buffer))
}

/** One frame as SVG paths, one per color, each run of same-colored pixels along a row a rectangle. */
const svgPaths = (px: Int32Array) => {
  const runs = new Map<number, string>()
  for (let y = 0; y < SPRITE_H; y++) {
    let x = 0
    while (x < SPRITE_W) {
      const color = px[y * SPRITE_W + x] ?? -1
      let end = x + 1
      while (end < SPRITE_W && px[y * SPRITE_W + end] === color) {
        end++
      }
      if (color >= 0) {
        runs.set(color, `${runs.get(color) ?? ''}M${x} ${y}h${end - x}v1h-${end - x}z`)
      }
      x = end
    }
  }

  return [...runs].map(([color, d]) => `<path fill="${hex(color)}" d="${d}"/>`).join('')
}

/**
 * The critter as an SVG, for a surface without Raster: a working one plays one loop of its frames, each distinct
 * frame a group shown at its moments. It hangs on the worker's state alone, never the clock, so a redraw leaves a
 * playing loop be until the phase changes.
 */
const spriteSvg = (w: Worker, scale = SVG_SCALE) => {
  const frames = Array.from({ length: w.status === 'running' ? LOOP : 1 }, (_, i) => svgPaths(critter(w, i * ANIM_MS)))
  const distinct = [...new Set(frames)]
  const body = distinct
    .map(paths => {
      if (distinct.length === 1) {
        return paths
      }
      const values: string[] = []
      const times: string[] = []
      frames.forEach((frame, i) => {
        const shown = frame === paths ? 'visible' : 'hidden'
        if (values[values.length - 1] !== shown) {
          values.push(shown)
          times.push(String(Math.round((i / frames.length) * 10_000) / 10_000))
        }
      })

      return (
        `<g visibility="hidden"><animate attributeName="visibility" values="${values.join(';')}" keyTimes="${times.join(';')}"` +
        ` dur="${(frames.length * ANIM_MS) / 1000}s" calcMode="discrete" repeatCount="indefinite"/>${paths}</g>`
      )
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPRITE_W} ${SPRITE_H}" width="${SPRITE_W * scale}"` +
    ` height="${SPRITE_H * scale}" shape-rendering="crispEdges" style="color-scheme:light dark">${body}</svg>`
  )
}

// Drawing: every line is a list of styled segments, cut to the room it has.

/**
 * A styled run of text; `isGap` marks the spaces that push a line's right part to its edge. `size` and `tabular` are
 * for a proportional font; the terminal ignores them.
 */
type Seg = {
  text: string
  color?: string
  dim?: boolean
  bold?: boolean
  inverse?: boolean
  isGap?: boolean
  size?: 'caption' | 'footnote' | 'body' | 'heading' | 'title'
  tabular?: boolean
}

/** The elements a line draws with; `isFlex` for a surface whose font is proportional, which lays a line out by flex instead of by spaces. */
type Kit = Pick<ElementTable, 'Box' | 'Text'> & { isFlex?: boolean }

const span = (segs: readonly Seg[]) => segs.reduce((n, s) => n + s.text.length, 0)

const cut = (segs: readonly Seg[], room: number): Seg[] => {
  const out: Seg[] = []
  let left = room

  for (const s of segs) {
    if (left <= 0) {
      break
    }
    if (s.text.length <= left) {
      out.push(s)
      left -= s.text.length
    } else {
      out.push({ ...s, text: left > 1 ? `${s.text.slice(0, left - 1)}…` : '…' })
      left = 0
    }
  }

  return out
}

const spread = (left: readonly Seg[], right: readonly Seg[], room: number): Seg[] => {
  const wide = span(right)

  if (wide + 12 > room) {
    return cut([...left, { text: ' ' }, ...right], room)
  }

  const head = cut(left, room - wide - 1)

  return [...head, { text: ' '.repeat(Math.max(1, room - span(head) - wide)), isGap: true }, ...right]
}

const style = (s: Seg) => ({
  ...(s.color === undefined ? {} : { color: s.color }),
  ...(s.dim === true ? { dimColor: true } : {}),
  ...(s.bold === true ? { bold: true } : {}),
  ...(s.inverse === true ? { inverse: true } : {}),
  ...(s.size === undefined ? {} : { size: s.size }),
  ...(s.tabular === true ? { tabular: true } : {}),
})

const draw = ({ Box, Text, isFlex }: Kit, line: readonly Seg[], room: number) => {
  if (isFlex === true) {
    // A proportional font has no cells to count: each side flows as one Text that truncates at its own edge, the left
    // giving way first, and flex takes the gap.
    const segs = line.filter(s => s.text !== '')
    const flow = (list: readonly Seg[]) => (
      <Text wrap="truncate-end">
        {list.map(s => (
          <Text {...style(s)}>{s.text}</Text>
        ))}
      </Text>
    )
    const gap = segs.findIndex(s => s.isGap === true)
    if (gap < 0) {
      return segs.length === 0 ? <Text> </Text> : flow(segs)
    }

    return (
      <Box justifyContent="space-between" gap={2}>
        <Box flexShrink={1} minWidth={0}>
          {flow(segs.slice(0, gap))}
        </Box>
        <Box flexShrink={0}>{flow(segs.slice(gap + 1))}</Box>
      </Box>
    )
  }

  const segs = cut(line, room).filter(s => s.text !== '')

  return segs.length === 0 ? (
    <Text> </Text>
  ) : (
    <Box>
      {segs.map(s => (
        <Text {...style(s)}>{s.text}</Text>
      ))}
    </Box>
  )
}

const meter = (done: number, total: number, size: number, color: string): Seg[] => {
  const filled = total === 0 ? 0 : Math.min(size, Math.round((done / total) * size))

  return [
    { text: '━'.repeat(filled), color },
    { text: '━'.repeat(size - filled), dim: true },
  ]
}

const chip = (model: string): Seg[] => (model === '' ? [] : [{ text: ` ${model} `, color: modelColor(model), inverse: true }])

const PHASE_COLOR: Record<Phase, string> = {
  starting: 'inactive',
  thinking: 'claude',
  writing: 'suggestion',
  tool: 'warning',
  idle: 'subtle',
}

const glyph = (w: Worker, now: number, seed: number): Seg => {
  const beat = Math.floor(now / FAST_TICK) + seed

  switch (w.status) {
    case 'done':
      return { text: '✓', color: 'success' }
    case 'failed':
      return { text: '✗', color: 'error' }
    case 'stopped':
      return { text: '■', color: 'inactive' }
    case 'idle':
      return { text: '◌', color: 'subtle' }
  }

  switch (w.phase) {
    case 'thinking':
      return { text: SPIN.charAt(beat % SPIN.length), color: PHASE_COLOR.thinking }
    case 'writing':
      return { text: '✎', color: PHASE_COLOR.writing }
    case 'tool':
      return { text: TOOL_SPIN.charAt(beat % TOOL_SPIN.length), color: PHASE_COLOR.tool }
    default:
      return { text: '◌', color: PHASE_COLOR[w.phase] }
  }
}

const doing = (w: Worker): Seg => {
  if (w.status !== 'running') {
    return { text: w.status, color: w.status === 'done' ? 'success' : w.status === 'failed' ? 'error' : 'subtle' }
  }

  const text = w.phase === 'tool' ? w.activity || 'running a tool' : w.phase === 'idle' ? 'waiting' : w.phase

  return { text, color: PHASE_COLOR[w.phase] }
}

const percentColor = (p: number) => (p < 60 ? 'success' : p < 85 ? 'warning' : 'error')

const usageSegs = (b: Board): Seg[] => {
  const u = b.usage
  const out: Seg[] = []

  if (u?.contextPercent !== undefined) {
    out.push({ text: ' · ctx ', dim: true }, { text: `${Math.round(u.contextPercent)}%`, color: percentColor(u.contextPercent) })
  }
  if (u?.costUsd !== undefined) {
    out.push({ text: ` · session $${u.costUsd.toFixed(2)}`, dim: true })
  }

  return out
}

const ran = (w: Worker, now: number) => elapsed((w.endedAt ?? now) - w.startedAt)

/** Helpers arranged as the tree of who spawned whom, each with the prefix that draws its branch. */
const tree = (list: readonly Worker[]) => {
  const ids = new Set(list.map(w => w.id))
  const out: { w: Worker; branch: string; stem: string }[] = []
  const visit = (parent: string | undefined, indent: string) => {
    const kids = list.filter(w =>
      parent === undefined ? !ids.has(w.parentId ?? MAIN) : w.parentId === parent,
    )

    kids.forEach((w, i) => {
      const isLast = i === kids.length - 1
      out.push({ w, branch: `${indent}${isLast ? '└─ ' : '├─ '}`, stem: `${indent}${isLast ? '   ' : '│  '}` })
      if (indent.length < 12) {
        visit(w.id, `${indent}${isLast ? '   ' : '│  '}`)
      }
    })
  }
  visit(undefined, '')

  return out
}

const runAgents = (b: Board, run: Run) =>
  b.workers.filter(w => w.runId === run.id).sort((x, y) => (x.index ?? 0) - (y.index ?? 0))

const runLine = (b: Board, run: Run, room: number): Seg[] => {
  const agents = runAgents(b, run)
  const done = agents.filter(w => isOver(w.status)).length
  const busy = agents.filter(w => w.status === 'running').length
  const mark: Seg =
    run.status === 'running'
      ? { text: '◈', color: 'autoAccept' }
      : run.status === 'done'
        ? { text: '✓', color: 'success' }
        : { text: '✗', color: 'error' }

  return spread(
    [
      mark,
      { text: ` ${run.name} `, bold: true },
      ...meter(done, agents.length, 12, 'autoAccept'),
      { text: ` ${done}/${agents.length} agents`, dim: true },
      ...(busy > 0 ? [{ text: ` · ${busy} running`, color: 'claude' }] : []),
    ],
    [{ text: elapsed((run.endedAt ?? b.now) - run.startedAt), dim: true }],
    room,
  )
}

/** A bar of `room` cells: filled to `share`, or, for work with no measure of its own, a pulse that sweeps along it. */
const bar = (share: number | undefined, room: number, color: string, now: number): Seg[] => {
  if (share !== undefined) {
    return meter(share * 1000, 1000, room, color)
  }
  const size = Math.min(8, Math.max(2, Math.floor(room / 6)))
  const at = ((Math.floor(now / FAST_TICK) * 2) % (room + size)) - size
  const head = Math.max(0, at)
  const lit = Math.max(0, Math.min(room, at + size) - head)

  return [
    { text: '━'.repeat(head), dim: true },
    { text: '━'.repeat(lit), color },
    { text: '━'.repeat(Math.max(0, room - head - lit)), dim: true },
  ]
}

/**
 * A worker's card, the lines beside its critter: title and state; effort and model; progress, context, cost and time.
 * Its bar under them is filled to `share`, unknown while it works without a todo list, in `tint`.
 */
const cardLines = (b: Board, w: Worker, room: number, viewed: string | undefined) => {
  const now = b.now
  const turn = b.turn
  const isMain = w.id === MAIN
  const isWorking = isMain ? turn?.isRunning === true : w.status === 'running'
  const tier = w.effort === undefined ? undefined : TIER[w.effort]
  const color = tier?.color ?? (w.model === '' ? 'claude' : modelColor(w.model))
  const run = w.runId === undefined ? undefined : b.runs.find(r => r.id === w.runId)
  const parent = w.parentId === undefined || w.parentId === MAIN ? undefined : b.workers.find(p => p.id === w.parentId)
  const outcome = isMain ? (turn?.outcome === undefined || turn.outcome === 'answer' ? 'done' : turn.outcome === 'aborted' ? 'stopped' : 'failed') : w.status
  const marker: Seg = isWorking
    ? { text: '●', color: 'claude' }
    : outcome === 'done'
      ? { text: '✓', color: 'success' }
      : outcome === 'failed'
        ? { text: '✗', color: 'error' }
        : outcome === 'idle'
          ? { text: '◌', color: 'subtle' }
          : { text: '■', color: 'inactive' }

  const tasks = b.tasks
  const current = tasks.find(t => t.status === 'in_progress')
  const todo = isMain
    ? tasks.length === 0
      ? undefined
      : { done: tasks.filter(t => t.status === 'completed').length, total: tasks.length, active: current?.title }
    : w.todo
  const progress: Seg[] =
    todo !== undefined && todo.total > 0
      ? [{ text: `${todo.done}/${todo.total}` }, ...(isWorking && todo.active ? [{ text: ` · ${todo.active}`, dim: true }] : [])]
      : isWorking
        ? [...(w.steps > 0 ? [{ text: `step ${w.steps} · `, dim: true }] : []), doing(w)]
        : [
            { text: `${w.tools} tool${w.tools === 1 ? '' : 's'}`, dim: true },
            ...(outcome === 'failed' || outcome === 'stopped' ? [{ text: ` · ${outcome}`, color: outcome === 'failed' ? 'error' : 'subtle' }] : []),
          ]

  const context = isMain ? (b.usage?.contextTokens ?? w.context) : w.context
  const percent = isMain && b.usage?.contextPercent !== undefined ? b.usage.contextPercent : (context / windowOf(b, w.modelId)) * 100
  const took = isMain
    ? turn === null
      ? 0
      : (turn.isRunning ? now : (turn.endedAt ?? now)) - turn.startedAt
    : (w.endedAt ?? now) - w.startedAt
  const stats = [context > 0 ? `ctx ${Math.round(percent)}% · ${amount(context)}` : '', w.costUsd > 0 ? dollars(w.costUsd) : '', clock(took)]

  const share =
    todo !== undefined && todo.total > 0 ? todo.done / todo.total : isWorking ? undefined : outcome === 'done' ? 1 : 0

  const tint = outcome === 'failed' ? 'error' : outcome === 'stopped' ? 'inactive' : color
  const lines: Seg[][] = [
    spread(
      [{ text: isMain ? 'Main loop' : w.label, bold: true }, ...(w.id === viewed ? [{ text: ' ◂ viewing', color: 'suggestion' }] : [])],
      [marker],
      room,
    ),
    cut(
      [
        ...(tier === undefined ? [] : [{ text: `${tier.word} `, color: tier.color }]),
        w.model === '' ? { text: 'model pending', dim: true } : { text: w.model, color: modelColor(w.model) },
        {
          text: [
            w.effort ?? '',
            !isMain && w.label !== w.type ? w.type : '',
            w.isBackground ? 'background' : '',
            run === undefined ? '' : `${run.name} #${w.index ?? '?'}`,
            parent === undefined ? '' : `from ${parent.label}`,
          ]
            .filter(Boolean)
            .map(part => ` · ${part}`)
            .join(''),
          dim: true,
        },
      ],
      room,
    ),
    spread(progress, [{ text: stats.filter(Boolean).join(' '), dim: true }], room),
  ]

  return { lines, share, tint }
}

/** One line of the band; a worker's own line carries it, for a surface that draws its critter in front. */
type BandRow = { segs: Seg[]; who?: Worker }

const bandLines = (b: Board, room: number, rows: number, face = (w: Worker, seed: number) => glyph(w, b.now, seed)): BandRow[] => {
  const now = b.now
  const turn = b.turn
  const main = b.workers.find(w => w.id === MAIN)
  const head: BandRow[] = []
  const body: BandRow[] = []

  if (b.tasks.length > 0) {
    const done = b.tasks.filter(t => t.status === 'completed').length
    const current = b.tasks.find(t => t.status === 'in_progress')
    head.push({
      segs: cut(
        [
          { text: 'Tasks ', dim: true },
          ...meter(done, b.tasks.length, 20, 'success'),
          { text: ` ${done}/${b.tasks.length}`, bold: true },
          ...(current ? [{ text: `  ▸ ${current.title}`, color: 'claude' }] : []),
        ],
        room,
      ),
    })
  }

  if (turn !== null && main !== undefined) {
    if (turn.isRunning) {
      head.push({
        who: main,
        segs: spread(
          [
            face(main, 0),
            { text: ' ' },
            ...chip(main.model),
            ...(main.effort === undefined ? [] : [{ text: ` ${main.effort}`, dim: true }]),
            { text: '  ' },
            doing(main),
            { text: ` · step ${main.steps} · ${turn.tools} tool${turn.tools === 1 ? '' : 's'}`, dim: true },
          ],
          [{ text: elapsed(now - turn.startedAt), dim: true }, ...usageSegs(b)],
          room,
        ),
      })
    } else {
      const helpers = b.workers.filter(w => w.id !== MAIN).length
      const files = turn.files.map(basename)
      const verdict: Seg =
        turn.outcome === undefined || turn.outcome === 'answer'
          ? { text: '✓ Done', color: 'success' }
          : turn.outcome === 'aborted'
            ? { text: '■ Interrupted', color: 'warning' }
            : { text: `✗ Stopped (${turn.outcome})`, color: 'error' }
      head.push({
        segs: spread(
          [
            verdict,
            { text: ` in ${elapsed((turn.endedAt ?? now) - turn.startedAt)}` },
            {
              text: [
                ` · ${turn.tools} tool${turn.tools === 1 ? '' : 's'}`,
                helpers > 0 ? ` · ${helpers} helper${helpers === 1 ? '' : 's'}` : '',
                files.length > 0
                  ? ` · edited ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`
                  : '',
              ].join(''),
              dim: true,
            },
          ],
          usageSegs(b),
          room,
        ),
      })
    }
  }

  for (const run of b.runs.filter(r => r.status === 'running')) {
    body.push({ segs: runLine(b, run, room) })
  }

  const live = b.workers.filter(w => w.id !== MAIN && w.runId === undefined && w.status === 'running')
  tree(live).forEach(({ w, branch }, i) => {
    body.push({
      who: w,
      segs: spread(
        [
          { text: branch, dim: true },
          face(w, i + 1),
          { text: ` ${w.type}`, bold: true },
          { text: ' ' },
          ...chip(w.model),
          ...(w.label === w.type ? [] : [{ text: ` ${clip(w.label, 32)}` }]),
          { text: ' · ', dim: true },
          doing(w),
        ],
        [{ text: `${w.tools} tools${w.costUsd > 0 ? ` · ${dollars(w.costUsd)}` : ''} · ${ran(w, now)}`, dim: true }],
        room,
      ),
    })
  })

  const jobs = b.jobs.filter(j => j.status === 'running')
  const tail: BandRow[] = []
  if (jobs.length > 0) {
    const shells = jobs.filter(j => j.kind === 'shell').length
    const monitors = jobs.length - shells
    tail.push({
      segs: [
        {
          text: [
            shells > 0 ? `$ ${shells} background shell${shells === 1 ? '' : 's'}` : '',
            monitors > 0 ? `◉ ${monitors} monitor${monitors === 1 ? '' : 's'}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          dim: true,
        },
      ],
    })
  }

  const budget = Math.max(1, rows - head.length - tail.length)
  if (body.length > budget) {
    const shown = body.slice(0, Math.max(0, budget - 1))
    shown.push({ segs: [{ text: `   +${body.length - shown.length} more · /savvy opens the dashboard`, dim: true }] })

    return [...head, ...shown, ...tail]
  }

  return [...head, ...body, ...tail]
}

const legend: Seg[] = [
  { text: '▆', color: '#d97757' },
  { text: ' thinking  ', dim: true },
  { text: '▆', color: '#6aa8ff' },
  { text: ' writing  ', dim: true },
  { text: '▆', color: '#e5b14a' },
  { text: ' tool  ', dim: true },
  { text: '▁', color: '#8a8a8a' },
  { text: ' idle', dim: true },
]

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

const base64 = (bytes: Uint8Array) => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(text)
}

/** The trails as Raster cells: one row per worker, one column per sampled second, newest at the right. */
const trailCells = (trails: readonly string[], columns: number) => {
  const words = new Uint32Array(trails.length * columns * 3)

  trails.forEach((trail, row) => {
    const tail = trail.slice(-columns).padStart(columns)
    for (let col = 0; col < columns; col++) {
      const letter = tail.charAt(col)
      const rgb = TRAIL_RGB[letter]
      const at = (row * columns + col) * 3
      words[at] = rgb === undefined ? 0x20 : letter === 'i' ? 0x2581 : 0x2586
      words[at + 1] = rgb ?? DEFAULT_COLOR
      words[at + 2] = DEFAULT_COLOR
    }
  })

  return base64(new Uint8Array(words.buffer))
}

/** The same trail as text runs, for a surface without Raster. */
const trailSegs = (trail: string, columns: number): Seg[] => {
  const tail = trail.slice(-columns).padStart(columns)
  const out: Seg[] = []

  for (const letter of tail) {
    const rgb = TRAIL_RGB[letter]
    const text = rgb === undefined ? ' ' : letter === 'i' ? '▁' : '▆'
    const last = out[out.length - 1]
    const color = rgb === undefined ? undefined : hex(rgb)
    if (last !== undefined && last.color === color) {
      last.text += text
    } else {
      out.push(color === undefined ? { text } : { text, color })
    }
  }

  return out
}

/** Theme colors as the hex an SVG paints with. */
const PAINT: Record<string, string> = {
  claude: '#d97757',
  success: '#4fd1a5',
  error: '#e05d5d',
  warning: '#e5b14a',
  inactive: '#7a7a7a',
  subtle: '#8a8a8a',
  suggestion: '#6aa8ff',
}

const paint = (color: string) => (color.startsWith('#') ? color : (PAINT[color] ?? '#8a8a8a'))

const TRACK = '<rect width="100" height="2" fill="#8a8a8a" fill-opacity="0.25"/>'

/**
 * A card's bar as an SVG, for a surface whose font would wrap a row of rules: filled to its share, or a pulse
 * sweeping across while the share is unknown. It stretches to the width it is given.
 */
const barSvg = (share: number | undefined, tint: string) => {
  const fill = paint(tint)
  const lit =
    share === undefined
      ? `<rect width="18" height="2" fill="${fill}"><animate attributeName="x" values="-18;100" dur="1.8s" repeatCount="indefinite"/></rect>`
      : `<rect width="${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}" height="2" fill="${fill}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 2" width="1000" height="4" preserveAspectRatio="none" style="color-scheme:light dark">${TRACK}${lit}</svg>`
}

/** One worker's trail as an SVG strip, for a surface without Raster: a bar per sampled second, a low one while idle. */
const trailSvg = (trail: string, columns: number) => {
  const tail = trail.slice(-columns).padStart(columns)
  let bars = ''
  let at = 0
  while (at < columns) {
    const letter = tail.charAt(at)
    let end = at + 1
    while (end < columns && tail.charAt(end) === letter) {
      end++
    }
    const rgb = TRAIL_RGB[letter]
    if (rgb !== undefined) {
      const [y, height] = letter === 'i' ? [8, 2] : [1, 9]
      bars += `<rect x="${at}" y="${y}" width="${end - at}" height="${height}" fill="${hex(rgb)}"/>`
    }
    at = end
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${columns} 10" width="1000" height="12" preserveAspectRatio="none" shape-rendering="crispEdges" style="color-scheme:light dark">${bars}</svg>`
}

// The module's copy of the board is the truth; $.state holds a snapshot of it for drawing, written at most every FLUSH_MS.
let autoOpen = true
let livePhase = true
let board: Board = clone(EMPTY)
let loading: Promise<void> | undefined
let ticker: Timer | undefined
let tickMs = 0
let flushTimer: Timer | undefined
let lastSample = 0
let lastUsage = 0
let isFullscreen = false
// Whether a surface other than the terminal has drawn the board: the desktop app has room for the dashboard.
let isRemote = false
const inflight = new Map<string, Map<string, string>>()
// The working critters the terminal's dashboard last drew, by Raster key: the animation repaints them between redraws.
const sprites = new Map<string, string>()
let anim: Timer | undefined

const load = ($: EngineInterface) => {
  loading ??= read($, boardState)
    .then(saved => {
      // A board an earlier version saved may lack fields this one counts on: each worker takes a blank's where it has none.
      board = { ...clone(EMPTY), ...clone(saved) }
      board.workers = board.workers.map(w => ({ ...blank(w.id, w.kind, w.startedAt), ...w }))
    })
    .catch(() => undefined)

  return loading
}

const flush = async ($: EngineInterface) => {
  flushTimer = undefined
  const snapshot = clone(board)
  await update($, boardState, () => snapshot)
}

const touch = ($: EngineInterface) => {
  flushTimer ??= $.clock.after(FLUSH_MS, () => void flush($).catch(() => undefined))
}

const isBusy = () =>
  board.turn?.isRunning === true || board.workers.some(w => w.id !== MAIN && w.status === 'running')

const hasBackground = () =>
  board.jobs.some(j => j.status === 'running') || board.runs.some(r => r.status === 'running')

const refreshUsage = async ($: EngineInterface) => {
  try {
    const u = await $.session.usage()
    board.usage = {
      contextPercent: u.context.percent,
      contextTokens: u.context.tokens,
      window: u.context.window,
      costUsd: u.cost?.usd,
      limits: u.rateLimits.map(l => ({ kind: l.kind, percent: l.percentUsed })),
    }
  } catch {
    // The figures are a nicety; the board draws without them.
  }
}

const sample = () => {
  for (const w of board.workers) {
    const letter = w.status === 'running' ? LETTER[w.phase] : w.status === 'idle' ? 'i' : ' '
    w.trail = (w.trail + letter).slice(-TRAIL)
  }
}

const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  board.now = now
  if (isBusy() && now - lastSample >= 1000) {
    lastSample = now
    sample()
  }
  if (now - lastUsage >= 5000) {
    lastUsage = now
    await refreshUsage($)
  }
  touch($)
  pace($)
}

const stopAnim = () => {
  anim?.cancel()
  anim = undefined
  sprites.clear()
}

/** Repaints each working critter's next frame in place; once none is mounted (the pane closed), stops until the pane draws again. */
const animate = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const live = [...sprites].flatMap(([key, id]) => {
    const w = find(id)

    return w !== undefined && w.status === 'running' ? [{ key, w }] : []
  })
  if (live.length === 0) {
    stopAnim()

    return
  }
  const results = await Promise.all(live.map(({ key, w }) => $.ui.blit({ requestId: PANE, key, cells: spriteCells(w, now) })))
  if (results.every(r => r.deny !== undefined)) {
    stopAnim()
  }
}

// Ticks fast while a model loop works (spinners, the timeline), slowly while only background jobs run, not at all when idle.
const pace = ($: EngineInterface) => {
  if (anim === undefined && sprites.size > 0 && isBusy()) {
    anim = $.clock.every(ANIM_MS, () => void animate($).catch(stopAnim))
  }
  const want = isBusy() ? FAST_TICK : hasBackground() ? SLOW_TICK : 0
  if (want === tickMs) {
    return
  }
  ticker?.cancel()
  ticker = want > 0 ? $.clock.every(want, () => void tick($).catch(() => undefined)) : undefined
  tickMs = want
}

const find = (id: string) => board.workers.find(w => w.id === id)

const ensure = (id: string, now: number) => {
  const found = find(id)
  if (found !== undefined) {
    return found
  }
  const w = blank(id, id === MAIN ? 'main' : 'engine', now)
  board.workers.push(w)

  return w
}

const nameOf = (id: string | undefined) => {
  const w = id === undefined ? undefined : find(id)

  return w === undefined || w.id === MAIN ? 'main' : w.label
}

const note = (at: number, who: string, text: string, tone: FeedItem['tone'] = 'info') => {
  board.feed = [...board.feed, { at, who, text, tone }].slice(-FEED)
}

const end = (w: Worker, status: Status, now: number) => {
  w.status = status
  w.phase = 'idle'
  w.activity = ''
  w.endedAt = now
  inflight.delete(w.id)
  note(now, w.label, status === 'done' ? `finished in ${ran(w, now)}` : status, status === 'done' ? 'good' : 'bad')
}

const ensureRun = (id: string, now: number, name?: string, taskId?: string) => {
  let run = board.runs.find(r => r.id === id)
  if (run === undefined) {
    run = { id, name: name ?? 'workflow', status: 'running', startedAt: now }
    board.runs.push(run)
  }
  if (name !== undefined) {
    run.name = name
  }
  if (taskId !== undefined) {
    run.taskId = taskId
  }

  return run
}

const closeRun = (run: Run, status: Status, now: number) => {
  run.status = status
  run.endedAt = now
  for (const w of board.workers) {
    if (w.runId === run.id && w.status === 'running') {
      end(w, status === 'done' ? 'done' : 'stopped', now)
    }
  }
  note(now, run.name, status === 'done' ? `workflow finished in ${elapsed(now - run.startedAt)}` : `workflow ${status}`, status === 'done' ? 'good' : 'bad')
}

/** Marks whatever carries this id (a background job, a workflow run, an agent) as ended. */
const settle = (id: string, status: Status, now: number) => {
  for (const job of board.jobs) {
    if (job.id === id && job.status === 'running') {
      job.status = status
      job.endedAt = now
      note(now, job.label, status === 'done' ? `finished after ${elapsed(now - job.startedAt)}` : status, status === 'done' ? 'good' : 'bad')
    }
  }
  for (const run of board.runs) {
    if ((run.id === id || run.taskId === id) && run.status === 'running') {
      closeRun(run, status, now)
    }
  }
  const w = find(id)
  if (w !== undefined && w.id !== MAIN && !isOver(w.status)) {
    end(w, status, now)
  }
}

const prune = () => {
  board.runs = board.runs.filter(r => !isOver(r.status))
  const runs = new Set(board.runs.map(r => r.id))
  board.workers = board.workers.filter(w =>
    w.id === MAIN || (w.runId === undefined ? !isOver(w.status) : runs.has(w.runId)),
  )
  board.jobs = board.jobs.filter(j => !isOver(j.status))
  board.servers = board.servers.filter(s => s.active > 0)
}

const bound = () => {
  while (board.workers.length > MAX_WORKERS) {
    const oldest = board.workers.findIndex(w => w.id !== MAIN && isOver(w.status))
    if (oldest < 0) {
      break
    }
    board.workers.splice(oldest, 1)
  }
}

const bumpServer = (name: string, delta: number) => {
  let server = board.servers.find(s => s.name === name)
  if (server === undefined) {
    server = { name, calls: 0, active: 0 }
    board.servers.push(server)
  }
  server.calls += delta > 0 ? 1 : 0
  server.active = Math.max(0, server.active + delta)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Savvy progress', columns: 76, rows: 28 })

// A workflow, or two helpers at once, opens the dashboard by itself, once a session, where it has room: docked beside
// the transcript of a fullscreen terminal, or in the desktop app.
const maybeAutoOpen = ($: EngineInterface) => {
  if (!autoOpen || board.hasAutoOpened || !(isFullscreen || isRemote)) {
    return
  }
  const helpers = board.workers.filter(w => w.id !== MAIN && w.status === 'running').length
  if (helpers < 2 && !board.runs.some(r => r.status === 'running')) {
    return
  }
  board.hasAutoOpened = true
  void openPane($).catch(() => undefined)
}

/** Without the per-request stream, a turn's summed usage is all there is to count; its context is no single request's, so it is left out. */
const settleSpend = (w: Worker, usage: (Tokens & { model: string }) | undefined) => {
  if (!livePhase && usage !== undefined) {
    spend(board, w, usage, usage.model || w.modelId)
    w.context = 0
  }
}

const mainModel = async ($: EngineInterface) => {
  try {
    return await $.session.model()
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  autoOpen = options.autoOpenPane !== false
  livePhase = options.liveModelPhase !== false

  on('session.start', async ($, e, next) => {
    await load($)
    await $.command.register({
      name: 'savvy',
      description: 'Open or close the savvy-progress dashboard of every helper at work (`band` toggles the band, `clear` drops finished helpers)',
      argumentHint: '[band|clear]',
      immediate: true,
    })
    await refreshUsage($)
    touch($)
    pace($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    tickMs = 0
    stopAnim()
    if (e.reason === 'clear') {
      board = clone(EMPTY)
      inflight.clear()
      await update($, boardState, () => clone(EMPTY))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await load($)
    const now = await $.clock.now()

    if (e.origin.kind === 'task-notification') {
      for (const m of e.text.matchAll(NOTICE)) {
        settle((m[1] ?? '').trim(), statusOf(m[2] ?? ''), now)
      }
    } else if (e.command === undefined && e.isMeta !== true) {
      // A new request from the person: what finished before it leaves the board.
      prune()
    }
    touch($)
    pace($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await load($)
    const now = await $.clock.now()
    board.now = now

    if (e.agentId === undefined) {
      board.turn = { isRunning: true, startedAt: now, tools: 0, files: [] }
      const main = ensure(MAIN, now)
      Object.assign(main, { status: 'running', phase: 'thinking', activity: '', startedAt: now, steps: 0, tools: 0 })
      if (!livePhase || main.model === '') {
        const id = await mainModel($)
        if (id !== '') {
          main.modelId = id
          main.model = modelName(id)
        }
      }
    } else {
      const w = ensure(e.agentId, now)
      if (w.kind === 'engine' && w.label === 'helper' && e.text !== '') {
        w.label = clip(e.text, 40)
      }
      w.status = 'running'
      w.phase = 'thinking'
    }
    touch($)
    pace($)

    return next(e)
  })

  if (livePhase) {
    on('turn.step', async function* ($, e, next) {
      await load($)
      const w = find(e.agentId ?? MAIN) ?? ensure(e.agentId ?? MAIN, await $.clock.now())
      w.model = modelName(e.model)
      w.modelId = e.model
      w.effort = e.effort === undefined ? undefined : String(e.effort)
      w.steps += 1
      w.phase = 'thinking'
      w.activity = ''
      touch($)

      const stream = next(e)
      for await (const chunk of stream) {
        if (chunk.kind === 'thinking' || chunk.kind === 'text' || chunk.kind === 'tool') {
          const phase: Phase = chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'text' ? 'writing' : 'tool'
          const activity = chunk.kind === 'tool' ? `calling ${chunk.name}` : ''
          if (phase !== w.phase || activity !== w.activity) {
            w.phase = phase
            w.activity = activity
            touch($)
          }
        }
        yield chunk
      }

      const result = await stream.result
      if (result.usage !== null) {
        spend(board, w, result.usage, result.usage.model || e.model)
      }
      touch($)

      return result
    })
  }

  on('agent.spawn', async ($, e, next) => {
    await load($)
    const answer = await next(e)
    const now = await $.clock.now()

    if (answer.deny !== undefined) {
      note(now, nameOf(e.parentAgentId), `could not start ${e.subagentType}: ${clip(answer.deny, 60)}`, 'bad')
      touch($)

      return answer
    }

    const id = answer.agentId ?? e.resume?.agentId ?? `${e.tool_use_id}:${e.workflow?.agentIndex ?? board.workers.length}`
    const kind: WorkerKind = e.workflow ? 'workflow' : e.isTeammate ? 'teammate' : e.fork ? 'fork' : 'subagent'
    const w = ensure(id, now)
    Object.assign(w, {
      kind,
      label: e.description || e.name || e.subagentType,
      type: e.subagentType,
      model: modelName(answer.model),
      modelId: answer.model,
      parentId: e.parentAgentId ?? MAIN,
      runId: e.workflow?.runId,
      index: e.workflow?.agentIndex,
      isBackground: e.background,
      status: 'running',
      endedAt: undefined,
    })
    if (w.phase === 'idle') {
      w.phase = 'starting'
    }
    const run = e.workflow === undefined ? undefined : ensureRun(e.workflow.runId, now)
    note(
      now,
      run?.name ?? nameOf(e.parentAgentId),
      [e.resume ? 'resumed' : 'started', w.label, run === undefined && w.label !== w.type ? `· ${w.type}` : '', `· ${w.model}`]
        .filter(Boolean)
        .join(' '),
    )
    bound()
    maybeAutoOpen($)
    touch($)
    pace($)

    return answer
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await load($)
    const now = await $.clock.now()
    board.now = now

    if (e.agentId === undefined) {
      const main = find(MAIN)
      if (board.turn !== null) {
        board.turn.isRunning = false
        board.turn.endedAt = now
        board.turn.outcome = e.reason
      }
      if (main !== undefined) {
        main.status = 'idle'
        main.phase = 'idle'
        main.activity = ''
        settleSpend(main, e.usage)
      }
      inflight.delete(MAIN)
      await refreshUsage($)
    } else {
      const w = find(e.agentId)
      if (w !== undefined) {
        settleSpend(w, e.usage)
        if (w.kind === 'teammate' && e.reason === 'answer') {
          w.status = 'idle'
          w.phase = 'idle'
          w.activity = ''
        } else if (!isOver(w.status)) {
          end(w, e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed', now)
        }
      }
    }
    touch($)
    pace($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await load($)
    const now = await $.clock.now()
    const id = e.agentId ?? MAIN
    const w = ensure(id, now)
    const label = describe(e)
    const callId = e.tool_use_id ?? `${e.tool}@${now}`
    const calls = inflight.get(id) ?? new Map<string, string>()
    const server = mcpServer(e.tool)

    inflight.set(id, calls)
    calls.set(callId, label)
    w.tools += 1
    w.phase = 'tool'
    w.activity = label
    if (id === MAIN && board.turn !== null) {
      board.turn.tools += 1
    }
    if (server !== undefined) {
      bumpServer(server, 1)
    }
    touch($)
    pace($)

    const answer = await next(e)

    const done = await $.clock.now()
    calls.delete(callId)
    if (server !== undefined) {
      bumpServer(server, -1)
    }
    if (w.status === 'running') {
      const still = [...calls.values()].pop()
      w.phase = still === undefined ? 'thinking' : 'tool'
      w.activity = still ?? ''
    }

    if (answer.deny === undefined && answer.isError !== true) {
      const result = (answer.result ?? {}) as Record<string, unknown>
      const text = (key: string) => (typeof result[key] === 'string' ? (result[key] as string) : undefined)

      if (e.tool === 'TodoWrite' && id === MAIN) {
        board.tasks = e.todos.map(
          (t, i): Task => ({ id: String(i), title: t.status === 'in_progress' ? t.activeForm : t.content, status: t.status }),
        )
      } else if (e.tool === 'TodoWrite') {
        const active = e.todos.find(t => t.status === 'in_progress')
        w.todo = {
          done: e.todos.filter(t => t.status === 'completed').length,
          total: e.todos.length,
          ...(active === undefined ? {} : { active: active.activeForm }),
        }
      } else if (e.tool === 'TaskCreate') {
        const task = (result as { task?: { id: string } }).task
        if (task !== undefined) {
          board.tasks = [...board.tasks, { id: task.id, title: e.subject, status: 'pending' }]
        }
      } else if (e.tool === 'TaskUpdate' && e.status !== undefined) {
        const status = e.status
        board.tasks =
          status === 'deleted'
            ? board.tasks.filter(t => t.id !== e.taskId)
            : board.tasks.map(t =>
                t.id === e.taskId ? { ...t, status, title: e.activeForm ?? e.subject ?? t.title } : t,
              )
      } else if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : ''
        if (typeof path === 'string' && path !== '' && board.turn !== null && !board.turn.files.includes(path)) {
          board.turn.files = [...board.turn.files, path]
        }
      } else if (e.tool === 'Workflow') {
        const runId = text('runId')
        const taskId = text('taskId')
        const name = text('workflowName') ?? workflowName(e.script) ?? e.name ?? 'workflow'
        if (runId !== undefined || taskId !== undefined) {
          ensureRun(runId ?? taskId ?? '', done, runId === undefined ? `${name} (cloud)` : name, taskId)
          note(done, nameOf(e.agentId), `launched workflow ${name}`)
          maybeAutoOpen($)
        }
      } else if (e.tool === 'Agent') {
        const agentId = text('agentId')
        const helper = agentId === undefined ? undefined : find(agentId)
        const model = text('resolvedModel')
        if (helper !== undefined) {
          if (model !== undefined && helper.model === '') {
            helper.model = modelName(model)
          }
          if (text('status') === 'async_launched') {
            helper.isBackground = true
          } else if (text('status') === 'completed' && !isOver(helper.status)) {
            end(helper, 'done', done)
          }
        } else if (text('status') === 'remote_launched') {
          const taskId = text('taskId') ?? callId
          Object.assign(ensure(taskId, done), {
            kind: 'subagent',
            label: `${e.description} (cloud)`,
            type: e.subagent_type ?? 'agent',
            parentId: id,
            isBackground: true,
          })
          note(done, nameOf(e.agentId), `sent "${clip(e.description, 40)}" to the cloud`)
        }
      } else if ((e.tool === 'Bash' || e.tool === 'PowerShell') && text('backgroundTaskId') !== undefined) {
        const jobId = text('backgroundTaskId') ?? callId
        board.jobs = [
          ...board.jobs.filter(j => j.id !== jobId),
          { id: jobId, kind: 'shell', label: clip(e.description ?? e.command, 60), status: 'running', startedAt: done },
        ]
        note(done, nameOf(e.agentId), `started background shell: ${clip(e.description ?? e.command, 50)}`)
      } else if (e.tool === 'Monitor' && text('taskId') !== undefined) {
        const jobId = text('taskId') ?? callId
        board.jobs = [
          ...board.jobs.filter(j => j.id !== jobId),
          { id: jobId, kind: 'monitor', label: clip(e.description, 60), status: 'running', startedAt: done },
        ]
        note(done, nameOf(e.agentId), `started monitor: ${clip(e.description, 50)}`)
      } else if (e.tool === 'TaskStop') {
        const target = e.task_id ?? e.shell_id
        if (target !== undefined) {
          settle(target, 'stopped', done)
        }
      } else if (e.tool === 'Skill') {
        note(done, nameOf(e.agentId), `used skill ${e.skill}`)
      }
    } else if (id !== MAIN && answer.deny !== undefined) {
      note(done, w.label, `${e.tool} refused`, 'bad')
    }

    bound()
    touch($)
    pace($)

    return answer
  }).catch(($, e, next) => next(e))

  // At each stop the engine lists the background work still in flight: anything of ours not on it has ended.
  on('classic.Stop', async ($, e, next) => {
    await load($)
    const live = e.background_tasks
    if (live !== undefined) {
      const ids = new Set(live.map(t => t.id))
      const now = await $.clock.now()
      for (const job of board.jobs) {
        if (job.status === 'running' && !ids.has(job.id)) {
          job.status = 'done'
          job.endedAt = now
        }
      }
      for (const run of board.runs) {
        if (run.status === 'running' && run.taskId !== undefined && !ids.has(run.taskId)) {
          closeRun(run, 'done', now)
        }
      }
      touch($)
      pace($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'savvy' }, async ($, e) => {
    await load($)
    const arg = e.args.trim().toLowerCase()

    if (arg === 'band') {
      const hidden = await update($, isHidden, h => !h)

      return { text: hidden ? 'Progress band hidden. Run /savvy band to show it.' : 'Progress band shown.' }
    }
    if (arg === 'clear') {
      prune()
      board.feed = []
      touch($)

      return { text: 'Cleared finished helpers from the savvy-progress board.' }
    }

    isFullscreen = e.presentation.isFullscreen
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })

      return { text: 'Savvy progress dashboard closed.' }
    }
    const opened = await openPane($)

    return {
      text: opened.isPlaced
        ? 'Savvy progress dashboard opened. Run /savvy again to close it.'
        : 'Savvy progress dashboard opened; it shows once the terminal has room for it.',
    }
  }).catch(() => ({ text: 'savvy-progress: the command failed.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    isFullscreen = e.viewport?.isFullscreen ?? isFullscreen
    isRemote = isRemote || e.surface !== 'terminal'
    const b = await read($, boardState)

    if (e.props.hasSurvey || b.turn === null || (await read($, isHidden))) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const room = e.props.bodyColumns
    // The terminal leads each worker's line with a spinner; a surface that draws SVG, with the critter itself.
    const hasCritters = e.surface !== 'terminal'
    const kit: Kit = { Box: ui.Box, Text: ui.Text, isFlex: hasCritters }
    const rows = bandLines(b, room, Math.min(BAND_ROWS, e.props.maxRows), hasCritters ? () => ({ text: '' }) : undefined)

    return (
      <ui.Box flexDirection="column">
        {rows.map(({ segs, who }) =>
          who !== undefined && hasCritters && 'Svg' in ui ? (
            <ui.Box key={`mini:${who.id}`} alignItems="center" gap={1}>
              <ui.Box flexShrink={0}>
                <ui.Svg
                  source={spriteSvg(who, MINI_SCALE)}
                  alt={`${who.label}, ${who.phase}`}
                  width={SPRITE_W * MINI_SCALE}
                  height={SPRITE_H * MINI_SCALE}
                  isInteractive={who.status === 'running'}
                />
              </ui.Box>
              <ui.Box flexGrow={1} minWidth={0}>
                {draw(kit, segs, room - MINI_COLUMNS)}
              </ui.Box>
            </ui.Box>
          ) : (
            draw(kit, segs, room)
          ),
        )}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isFullscreen = e.viewport?.isFullscreen ?? isFullscreen
    const b = await read($, boardState)
    const ui = $.ui.resolve(e)
    // A table names every element, the ones its surface lacks drawing nothing: the surface says which it draws.
    const isTerminal = e.surface === 'terminal'
    // Off the terminal the font is proportional: lines lay out by flex, and rules of box-drawing characters would wrap.
    const kit: Kit = { Box: ui.Box, Text: ui.Text, isFlex: !isTerminal }
    const { Box } = ui
    const room = Math.max(20, e.props.bodyColumns)
    const now = b.now
    const viewed = e.props.view.agentId
    const out: RenderChildren[] = []
    const line = (segs: readonly Seg[]) => out.push(draw(kit, segs, room))
    const rule = (title: string, extra: Seg[] = []) => {
      const head: Seg[] = [{ text: title, bold: true }, ...(extra.length > 0 ? [{ text: ' ' }, ...extra] : [])]
      line(isTerminal ? [...head, { text: ` ${'─'.repeat(Math.max(0, room - span(head) - 1))}`, dim: true }] : head)
    }

    const turn = b.turn
    const main = b.workers.find(w => w.id === MAIN)
    const helpers = b.workers.filter(w => w.id !== MAIN)

    line(
      spread(
        [{ text: '◆ ', color: 'claude' }, { text: 'SAVVY PROGRESS', bold: true }],
        turn === null
          ? [{ text: 'idle', dim: true }]
          : [
              turn.isRunning ? { text: SPIN.charAt(Math.floor(now / FAST_TICK) % SPIN.length), color: 'claude' } : { text: '○', dim: true },
              { text: ` ${elapsed((turn.isRunning ? now : turn.endedAt ?? now) - turn.startedAt)}`, dim: true },
            ],
        room,
      ),
    )

    const u = b.usage
    const isWorking = turn?.isRunning === true || helpers.some(w => w.status === 'running')
    const begun = Math.min(turn?.startedAt ?? Infinity, ...b.workers.map(w => w.startedAt))
    const ended = Math.max(turn?.endedAt ?? 0, ...b.workers.map(w => w.endedAt ?? 0))
    const tileWidth = Math.max(12, Math.floor((room - 2) / 3))
    const tile = (label: string, value: string) => (
      <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1} width={tileWidth}>
        {draw(kit, [{ text: label, dim: true, size: 'footnote' }], tileWidth - 4)}
        {draw(kit, [{ text: value, bold: true, size: 'heading', tabular: true }], tileWidth - 4)}
      </Box>
    )
    out.push(
      <Box gap={1}>
        {tile('Cost', u?.costUsd === undefined ? dollars(b.totalCost) : `$${u.costUsd.toFixed(2)}`)}
        {tile('Tokens', b.totalTokens > 0 ? amount(b.totalTokens) : '—')}
        {tile('Time', Number.isFinite(begun) ? clock((isWorking ? now : Math.max(ended, begun)) - begun) : '0:00')}
      </Box>,
    )

    if (u !== null) {
      const percent = u.contextPercent ?? 0
      const fill: Seg[] = [
        { text: ` ${Math.round(percent)}%`, color: percentColor(percent), tabular: true },
        { text: ` of ${amount(u.window)}`, dim: true },
        ...u.limits.flatMap((l): Seg[] => [
          { text: ` · ${l.kind.replace('_hour', 'h').replace('seven_day', '7d').replace('five', '5')} `, dim: true },
          { text: `${Math.round(l.percent)}%`, color: percentColor(l.percent), tabular: true },
        ]),
      ]
      if ('Svg' in ui && !isTerminal) {
        // The context as the same bar the cards wear, between its label and its figures.
        const { Svg } = ui
        out.push(
          <Box alignItems="center" gap={1} marginTop={1}>
            {draw(kit, [{ text: 'Context', dim: true, size: 'footnote' }], room)}
            <Box flexGrow={1}>
              <Svg source={barSvg(percent / 100, percentColor(percent))} alt={`context ${Math.round(percent)}% full`} height={4} />
            </Box>
            {draw(kit, fill.map(s => ({ ...s, size: 'footnote' as const })), room)}
          </Box>,
        )
      } else {
        line([{ text: 'context ', dim: true }, ...meter(percent, 100, 16, percentColor(percent)), ...fill])
      }
    }

    if (turn === null && helpers.length === 0) {
      line([{ text: ' ' }])
      line([{ text: 'Nothing has run yet. Agents, workflows, background shells and MCP calls show here as they start.', dim: true }])

      return <Box flexDirection="column">{out}</Box>
    }

    // Each worker a card beside its critter. On the terminal the critter is a Raster the animation repaints between
    // redraws, the card ruled off under it; elsewhere the card is a framed box, its critter and bar SVGs that play
    // their own loops.
    const frame = await $.clock.now()
    const textWidth = Math.max(16, room - SPRITE_W - 2)
    if ('Raster' in ui && isTerminal) {
      sprites.clear()
    }
    const separator = () => line([{ text: '─'.repeat(room), dim: true }])
    const card = (w: Worker) => {
      const { lines, share, tint } = cardLines(b, w, textWidth, viewed)
      if ('Svg' in ui && !isTerminal) {
        const { Svg } = ui
        const isLive = w.status === 'running'
        out.push(
          <Box borderStyle="round" borderDimColor paddingX={1} gap={2} alignItems="center" marginBottom={1}>
            <Box key={`sprite:${w.id}`} flexShrink={0}>
              <Svg
                source={spriteSvg(w)}
                alt={`${w.label}, ${isLive ? w.phase : w.status}`}
                width={SPRITE_W * SVG_SCALE}
                height={SPRITE_H * SVG_SCALE}
                isInteractive={isLive}
              />
            </Box>
            <Box flexDirection="column" flexGrow={1} minWidth={0}>
              {lines.map((l, i) => draw(kit, i === 0 ? l : l.map(s => ({ ...s, size: 'footnote' as const })), textWidth))}
              <Svg
                source={barSvg(share, tint)}
                alt={share === undefined ? 'working' : `${Math.round(share * 100)}% done`}
                height={4}
                isInteractive={share === undefined}
              />
            </Box>
          </Box>,
        )

        return
      }

      let face: RenderChildren
      if ('Raster' in ui && isTerminal) {
        const { Raster } = ui
        const key = `sprite:${w.id}`
        if (w.status === 'running') {
          sprites.set(key, w.id)
        }
        face = <Raster key={key} columns={SPRITE_W} rows={SPRITE_ROWS} cells={spriteCells(w, frame)} />
      } else {
        face = <Box width={SPRITE_W}>{draw(kit, [{ text: '  ' }, glyph(w, now, 0)], SPRITE_W)}</Box>
      }
      out.push(
        <Box>
          {face}
          <Box flexDirection="column" marginLeft={2} width={textWidth}>
            {[...lines, bar(share, textWidth, tint, now)].map(l => draw(kit, l, textWidth))}
          </Box>
        </Box>,
      )
      separator()
    }

    if (main !== undefined && turn !== null) {
      line([{ text: ' ' }])
      card(main)
    }

    const loose = helpers.filter(w => w.runId === undefined && !isOver(w.status))
    const live = b.runs.filter(r => r.status === 'running')
    const working = loose.length + live.flatMap(r => runAgents(b, r)).filter(w => !isOver(w.status)).length
    if (working > 0 || live.length > 0) {
      line([{ text: ' ' }])
      rule(`Running · ${working}`)
      tree(loose).forEach(({ w }) => card(w))
      for (const run of live) {
        line(runLine(b, run, room))
        runAgents(b, run)
          .filter(w => !isOver(w.status))
          .forEach(card)
      }
    }

    const finished = helpers.filter(w => isOver(w.status)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
    if (finished.length > 0) {
      const shut = await read($, isFinishedShut)
      const { Button } = ui
      line([{ text: ' ' }])
      out.push(
        <Box>
          <Button plain hotkey="f" key="finished" onPress={() => void update($, isFinishedShut, v => !v).catch(() => undefined)}>
            {`${shut ? '▸' : '▾'} Finished · ${finished.length}`}
          </Button>
        </Box>,
      )
      if (!shut) {
        for (const run of b.runs.filter(r => r.status !== 'running')) {
          line(runLine(b, run, room))
        }
        finished.slice(0, FINISHED_SHOWN).forEach(card)
        if (finished.length > FINISHED_SHOWN) {
          line([{ text: `+${finished.length - FINISHED_SHOWN} more · /savvy clear drops finished helpers`, dim: true }])
        }
      }
    }

    if (b.tasks.length > 0) {
      const done = b.tasks.filter(t => t.status === 'completed').length
      line([{ text: ' ' }])
      rule('Tasks', [...meter(done, b.tasks.length, 16, 'success'), { text: ` ${done}/${b.tasks.length}` }])
      for (const t of b.tasks.slice(0, 12)) {
        line([
          t.status === 'completed'
            ? { text: ' ✓ ', color: 'success' }
            : t.status === 'in_progress'
              ? { text: ` ${SPIN.charAt(Math.floor(now / FAST_TICK) % SPIN.length)} `, color: 'claude' }
              : { text: ' ○ ', dim: true },
          t.status === 'completed' ? { text: t.title, dim: true } : { text: t.title, bold: t.status === 'in_progress' },
        ])
      }
      if (b.tasks.length > 12) {
        line([{ text: `   +${b.tasks.length - 12} more`, dim: true }])
      }
    }

    if (b.jobs.length > 0) {
      line([{ text: ' ' }])
      rule('Background')
      for (const job of b.jobs) {
        line(
          spread(
            [
              { text: job.kind === 'shell' ? ' $ ' : ' ◉ ', color: job.status === 'running' ? 'warning' : 'subtle' },
              { text: job.label, dim: job.status !== 'running' },
            ],
            [
              job.status === 'running'
                ? { text: `running ${elapsed(now - job.startedAt)}`, color: 'warning' }
                : { text: job.status, color: job.status === 'done' ? 'success' : 'error' },
            ],
            room,
          ),
        )
      }
    }

    if (b.servers.length > 0) {
      line([{ text: ' ' }])
      rule('MCP servers')
      line(
        b.servers.flatMap((s): Seg[] => [
          { text: s.active > 0 ? ' ● ' : ' ○ ', color: s.active > 0 ? 'warning' : 'subtle' },
          { text: s.name, bold: s.active > 0 },
          { text: ` ×${s.calls}`, dim: true },
        ]),
      )
    }

    const trails = [...b.workers]
      .filter(w => w.trail.trim() !== '')
      .sort((x, y) => (x.id === MAIN ? -1 : y.id === MAIN ? 1 : x.startedAt - y.startedAt))
      .slice(-14)
    if (trails.length > 0) {
      const labelWidth = 14
      const columns = Math.max(10, Math.min(TRAIL, room - labelWidth - 1))
      const seconds = Math.min(columns, Math.max(...trails.map(w => w.trail.length)))
      line([{ text: ' ' }])
      rule('Timeline', [{ text: `last ${elapsed(seconds * 1000)} of work`, dim: true }])
      const label = (w: Worker) =>
        draw(kit, [{ text: fit(w.id === MAIN ? 'main' : w.label, labelWidth), color: w.status === 'running' ? 'text' : 'subtle' }], labelWidth + 1)
      const labels = (
        <Box flexDirection="column" width={labelWidth + 1}>
          {trails.map(label)}
        </Box>
      )
      if ('Raster' in ui && isTerminal) {
        const { Raster } = ui
        out.push(
          <Box>
            {labels}
            <Raster key="timeline" columns={columns} rows={trails.length} cells={trailCells(trails.map(w => w.trail), columns)} />
          </Box>,
        )
      } else if ('Svg' in ui) {
        // Each strip beside its own label, so a proportional font's line height cannot drift them apart.
        const { Svg } = ui
        out.push(
          <Box flexDirection="column">
            {trails.map(w => (
              <Box alignItems="center" gap={1}>
                <Box width={labelWidth + 1}>{label(w)}</Box>
                <Box flexGrow={1}>
                  <Svg source={trailSvg(w.trail, columns)} alt={`${w.id === MAIN ? 'main' : w.label}: its last ${elapsed(seconds * 1000)}`} height={12} />
                </Box>
              </Box>
            ))}
          </Box>,
        )
      } else {
        out.push(
          <Box>
            {labels}
            <Box flexDirection="column">{trails.map(w => draw(kit, trailSegs(w.trail, columns), columns))}</Box>
          </Box>,
        )
      }
      line(legend)
    }

    if (b.feed.length > 0) {
      line([{ text: ' ' }])
      rule('Activity')
      for (const item of b.feed.slice(-10).reverse()) {
        line([
          { text: ago(now - item.at).padStart(4), dim: true },
          { text: '  ' },
          { text: fit(item.who, 16), bold: true },
          { text: ' ' },
          {
            text: item.text,
            ...(item.tone === 'good' ? { color: 'success' } : item.tone === 'bad' ? { color: 'error' } : { dim: true }),
          },
        ])
      }
    }

    line([{ text: ' ' }])
    line([{ text: '/savvy closes · /savvy band toggles the band · /savvy clear', dim: true, size: 'caption' }])

    return <Box flexDirection="column">{out}</Box>
  })
}
