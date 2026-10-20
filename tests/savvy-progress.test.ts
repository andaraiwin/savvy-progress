import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

const PLUGIN = 'savvy-progress'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 110, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'savvy-progress',
  props: { title: 'Savvy progress', isFocused: false, bodyColumns: 76, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const spawnOf = (over: Partial<AgentSpawnInput>): AgentSpawnInput => ({
  tool_use_id: 'tu-1',
  prompt: 'Look for it.',
  description: 'Find auth code',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...over,
})

const ending = (agentId: string | undefined, reason: 'answer' | 'aborted' | 'error' = 'answer') => ({
  answer: 'ok',
  durationMs: 1000,
  isAborted: reason === 'aborted',
  turnId: 't-1',
  ...(agentId === undefined ? {} : { agentId }),
  reason,
})

/** The engine beneath the plugin: the session's model and usage, turns, and spawns answered as a session would. */
const world = (on: On) => {
  const clock = mock.clock(on, { now: 10_000 })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
      cost: { usd: 0.42 },
    },
  }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', ($, e) => ({
    model: e.workflow ? 'claude-sonnet-5-5' : 'claude-haiku-4-5-20251001',
    agentId: e.workflow ? `wf-agent-${e.workflow.agentIndex}` : 'agent-1',
  }))

  return clock
}

describe('band', () => {
  test('shows the main loop and a running subagent, each with its model', async ($, on) => {
    const clock = world(on)
    await $.turn.start({ text: 'find the auth code', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    await clock.advance(200)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Haiku 4.5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Find auth code/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('on the desktop the band leads each working line with its critter', async ($, on) => {
    const clock = world(on)
    await $.turn.start({ text: 'find the auth code', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    await clock.advance(200)

    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const critters = await desktop.findAll({ type: 'Svg' })
    expect(critters.length).toBe(2)
    expect(critters.every(c => String(c.props.source).includes('<animate') && c.props.isInteractive === true)).toBe(true)
    expect(critters.every(c => c.props.width === 36 && c.props.height === 24)).toBe(true)
    expect(await desktop.find({ type: 'Text', text: /Find auth code/ })).toBeDefined()
    await desktop.unmount()

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await terminal.findAll({ type: 'Svg' })).length).toBe(0)
    await terminal.unmount()
  })

  test('in the desktop app two helpers at once open the dashboard by itself', async ($, on) => {
    const clock = world(on)
    const opened: string[] = []
    on('ui.open', ($, e) => {
      opened.push(e.id)

      return { value: { isPlaced: true as const } }
    })
    await $.turn.start({ text: 'review it', turnId: 't-1' })
    await clock.advance(200)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    for (const agentIndex of [1, 2]) {
      await $.agent.spawn(spawnOf({ tool_use_id: `tu-${agentIndex}`, workflow: { runId: 'wf_1', agentIndex } }))
    }
    await clock.advance(200)

    expect(opened).toEqual(['savvy-progress'])
    await band.unmount()
  })

  test('a background shell is counted until its notification arrives', async ($, on) => {
    const clock = world(on)
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash-1' } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.turn.start({ text: 'start the dev server', turnId: 't-1' })
    await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start dev server', run_in_background: true })
    await clock.advance(200)

    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '1 background shell' })).toBeDefined()
    await ui.unmount()

    await $.prompt.submit({
      text: '<task-notification><task-id>bash-1</task-id><status>completed</status></task-notification>',
      origin: { kind: 'task-notification' },
      wait: false,
    })
    await clock.advance(200)

    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'background shell' })).toBeUndefined()
    await ui.unmount()
  })

  test("follows a subagent's model request as it streams: its phase, then its tokens", async ($, on) => {
    const clock = world(on)
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    on('turn.step', async function* ($, e) {
      yield { kind: 'text' as const, index: 0, text: 'Here is' }
      await gate

      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'Here is',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: {
          input_tokens: 10,
          output_tokens: 1200,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 0,
          model: 'claude-haiku-4-5-20251001',
        },
      }
    })
    await $.turn.start({ text: 'go', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    const stream = $.turn.step({ turnId: 't-2', index: 0, model: 'claude-haiku-4-5-20251001', messageCount: 2, agentId: 'agent-1' })
    await stream.next()
    await clock.advance(200)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'writing' })).toBeDefined()
    await band.unmount()

    release()
    for await (const chunk of stream) {
      expect(chunk).toBeDefined()
    }
    await clock.advance(200)

    // 40,010 input tokens of Haiku 4.5's 200k window; 10 uncached at $1, 40k cache reads at $0.10, 1,200 out at $5 per million.
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /ctx 20% · 40k ≈\$0\.01/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '41.2k' })).toBeDefined()
    await pane.unmount()
  })

  test('/savvy band hides the band and shows it again', async $ => {
    const run = (args: string) =>
      $.command.run({
        command: 'savvy',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })

    expect((await run('band')).text).toMatch(/hidden/)
    expect((await run('band')).text).toMatch(/shown/)
  })
})

describe('dashboard', () => {
  test('draws a workflow run with its agents, the timeline and the activity feed', async ($, on) => {
    const clock = world(on)
    on('tool.call', () => ({
      result: { status: 'async_launched', taskId: 'w-task', runId: 'wf_1', workflowName: 'review-changes' },
    }))
    await $.turn.start({ text: 'review it', turnId: 't-1' })
    await $.tool.call({ tool: 'Workflow', script: "export const meta = { name: 'review-changes', description: 'x' }" })
    for (const agentIndex of [1, 2]) {
      await $.agent.spawn(
        spawnOf({
          tool_use_id: 'tu-wf',
          description: agentIndex === 1 ? 'review:bugs' : 'review:perf',
          subagentType: 'general-purpose',
          workflow: { runId: 'wf_1', agentIndex },
        }),
      )
    }
    await clock.advance(2600)
    await $.turn.complete(ending('wf-agent-1'))
    await clock.advance(200)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: 'review-changes' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1/2 agents' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'review:perf' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /finished in/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
      const raster = await ui.find({ type: 'Raster', key: 'timeline' })
      if (surface === 'terminal') {
        expect(raster).toBeDefined()
      } else {
        expect(raster).toBeUndefined()
      }
      await ui.unmount()
    }
  })

  test("each working agent's critter is repainted in place until it finishes", async ($, on) => {
    const clock = world(on)
    const blits: { requestId: string; key: string; cells: string }[] = []
    on('ui.blit', ($, e) => {
      if ('cells' in e) {
        blits.push({ requestId: e.requestId, key: e.key, cells: e.cells })
      }

      return { value: {} }
    })
    await $.turn.start({ text: 'find it', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    await clock.advance(200)

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await desktop.find({ type: 'Raster', key: 'sprite:agent-1' })).toBeUndefined()
    expect(await desktop.find({ type: 'Text', text: 'Find auth code' })).toBeDefined()
    await desktop.unmount()

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Raster', key: 'sprite:agent-1' })).toBeDefined()
    expect(await pane.find({ type: 'Raster', key: 'sprite:main' })).toBeDefined()
    await clock.advance(1500)

    const mine = blits.filter(b => b.key === 'sprite:agent-1')
    expect(mine.length).toBeGreaterThan(3)
    expect(mine.every(b => b.requestId === 'savvy-progress')).toBe(true)
    expect(new Set(mine.map(b => b.cells)).size).toBeGreaterThan(1)

    await $.turn.complete(ending('agent-1'))
    await clock.advance(400)
    const settled = blits.filter(b => b.key === 'sprite:agent-1').length
    await clock.advance(1000)
    expect(blits.filter(b => b.key === 'sprite:agent-1').length).toBe(settled)
    await pane.unmount()
  })

  test("on the desktop each working agent's critter plays its own loop, which a redraw leaves be", async ($, on) => {
    const clock = world(on)
    const svgOf = async (ui: { find: (q: { type: string; key: string }) => Promise<{ children: unknown[] } | undefined> }) => {
      const face = (await ui.find({ type: 'Box', key: 'sprite:agent-1' }))?.children[0] as
        | { type: string; props: { source: string; alt: string; isInteractive?: boolean } }
        | undefined

      return face?.type === 'Svg' ? face.props : undefined
    }
    await $.turn.start({ text: 'find it', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    await clock.advance(200)

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const playing = await svgOf(desktop)
    expect(playing?.isInteractive).toBe(true)
    expect(playing?.alt).toContain('Find auth code')
    expect(playing?.source).toContain('<animate attributeName="visibility"')
    expect(playing?.source.length ?? Infinity).toBeLessThan(131_072)

    await clock.advance(1500)
    expect((await svgOf(desktop))?.source).toBe(playing?.source)

    await $.turn.complete(ending('agent-1'))
    await clock.advance(400)
    const still = await svgOf(desktop)
    expect(still?.isInteractive).toBe(false)
    expect(still?.source).not.toContain('<animate')
    await desktop.unmount()
  })

  test('on the desktop the dashboard lays out by flex, with no rules a proportional font would wrap', async ($, on) => {
    const clock = world(on)
    await $.turn.start({ text: 'find it', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    await clock.advance(3000)

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await desktop.find({ type: 'Text', text: /─/ })).toBeUndefined()
    const svgs = await desktop.findAll({ type: 'Svg' })
    const bars = svgs.filter(s => s.props.height === 4)
    expect(bars.length).toBe(3)
    expect(bars.some(s => String(s.props.alt).startsWith('context'))).toBe(true)
    expect(svgs.some(s => s.props.height === 12)).toBe(true)
    const critters = svgs.filter(s => String(s.props.source).includes('shape-rendering="crispEdges"') && s.props.height !== 12)
    expect(critters.length).toBe(2)
    expect(critters.every(s => s.props.width === 84 && s.props.height === 56)).toBe(true)
    expect((await desktop.findAll({ type: 'Box' })).some(b => b.props.justifyContent === 'space-between')).toBe(true)
    await desktop.unmount()

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: /─{10}/ })).toBeDefined()
    expect((await terminal.findAll({ type: 'Box' })).some(b => b.props.justifyContent === 'space-between')).toBe(false)
    await terminal.unmount()
  })

  test('finished agents fold under a toggle', async ($, on) => {
    const clock = world(on)
    await $.turn.start({ text: 'find it', turnId: 't-1' })
    await $.agent.spawn(spawnOf({}))
    await $.turn.complete(ending('agent-1'))
    await clock.advance(200)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Button', text: '▾ Finished · 1' })).toBeDefined()
    expect(await pane.find({ type: 'Raster', key: 'sprite:agent-1' })).toBeDefined()

    await pane.press({ key: 'finished' })
    expect(await pane.find({ type: 'Button', text: '▸ Finished · 1' })).toBeDefined()
    expect(await pane.find({ type: 'Raster', key: 'sprite:agent-1' })).toBeUndefined()
    await pane.unmount()
  })

  test('a board an earlier version saved gains the fields this one counts', async ($, on) => {
    const clock = world(on)
    const old = { id: 'agent-1', kind: 'subagent', label: 'Old helper', type: 'Explore', model: 'Haiku 4.5', isBackground: false,
      status: 'running', phase: 'thinking', activity: '', startedAt: 9_000, steps: 1, tools: 2, tokens: 50, context: 0, trail: '' }
    const saved = {
      now: 9_000, turn: { isRunning: true, startedAt: 9_000, tools: 0, files: [] }, tasks: [], workers: [old],
      runs: [], jobs: [], servers: [], feed: [], usage: null, hasAutoOpened: false,
    }
    let isSeeded = false
    on('state.get', ($, e, next) => {
      if (isSeeded || e.key !== 'board') {
        return next(e)
      }
      isSeeded = true

      return { value: { value: saved as never, version: 1 } }
    })
    on('turn.step', async function* ($, e) {
      yield { kind: 'text' as const, index: 0, text: 'ok' }

      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const,
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-4-5' } }
    })
    for await (const chunk of $.turn.step({ turnId: 't-2', index: 0, model: 'claude-haiku-4-5', messageCount: 2, agentId: 'agent-1' })) {
      expect(chunk).toBeDefined()
    }
    await clock.advance(200)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /ctx 1% · 1k ≈\$0\.00/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /NaN/ })).toBeUndefined()
    await pane.unmount()
  })

  test('/savvy opens the dashboard and closes it again', async ($, on) => {
    world(on)
    const panes: string[] = []
    on('ui.open', ($, e) => {
      panes.push(e.id)

      return { value: { isPlaced: true as const } }
    })
    on('ui.panes', () => ({
      value: panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
    }))
    on('ui.close', ($, e) => {
      panes.splice(panes.indexOf(e.id), 1)

      return { value: undefined }
    })
    const run = () =>
      $.command.run({
        command: 'savvy',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 160 },
      })

    expect((await run()).text).toMatch(/opened/)
    expect(panes).toEqual(['savvy-progress'])
    expect((await run()).text).toMatch(/closed/)
    expect(panes).toEqual([])
  })
})
