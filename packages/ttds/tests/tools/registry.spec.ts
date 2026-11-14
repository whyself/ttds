import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTtdsConfig } from '../../src/shared/index.ts'
import { fixture, tool } from './fixture.ts'

const fixtures: ReturnType<typeof fixture>[] = []

function setup() {
  const result = fixture()
  fixtures.push(result)
  return result
}

async function completed(f: ReturnType<typeof fixture>, count = 1) {
  await vi.waitFor(() => { expect(f.state.results).toHaveLength(count) })
  const entry = f.state.results[count - 1]
  if (!entry) throw new Error('Expected completed tool result')
  return entry.result
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.ctx.fiber.dispose()
  vi.useRealTimers()
})

describe('VoiceToolRegistry registration', () => {
  it('rejects duplicate names and missing mutation summaries', () => {
    const f = setup()
    f.registry.register(tool())
    expect(() => f.registry.register(tool())).toThrow('重复')
    for (const category of ['write', 'approval'] as const) {
      const definition = tool({ name: `bad_${category}`, category })
      Reflect.deleteProperty(definition, 'summarizeCall')
      expect(() => f.registry.register(definition)).toThrow('summarizeCall')
    }
  })

  it('rejects automatic approval at registration and again at execution', async () => {
    const f = setup()
    expect(() => f.registry.register(tool({ category: 'approval', resolveConfirmation: () => 'auto' }))).toThrow('自动')
    let mode: 'ui' | 'auto' = 'ui'
    const definition = tool({ category: 'approval', resolveConfirmation: () => mode })
    f.registry.register(definition)
    mode = 'auto'
    f.dispatch()
    expect(await completed(f)).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect(definition.execute).not.toHaveBeenCalled()
  })

  it('refreshes on registration and disposal and filters the live catalog', () => {
    const f = setup()
    const dispose = f.registry.register(tool())
    f.registry.register(tool({ name: 'read', category: 'read', resolveConfirmation: () => 'auto' }))
    f.registry.register(tool({ name: 'search', category: 'search', resolveConfirmation: () => 'auto' }))
    expect(f.registry.listUpstreamSpecs()[0]?.function.parameters.properties).not.toHaveProperty('confirmation_id')
    expect(f.registry.listUpstreamSpecs()[0]?.function.parameters.properties).not.toHaveProperty('confirmed')
    f.state.config = resolveTtdsConfig({ tools: { enableReadTools: false, enableSearchTool: false, writeConfirmation: 'auto' } }, {})
    expect(f.registry.listUpstreamSpecs().map(spec => spec.function.name)).toEqual(['dsh_test'])
    dispose()
    dispose()
    expect(f.registry.listToolNames()).toEqual(['read', 'search'])
    expect(f.refreshTools).toHaveBeenCalledTimes(4)
  })
})

describe('auto and UI confirmation policies', () => {
  it('requires UI approval under default writeConfirmation and executes immediately when set to auto', async () => {
    const f = setup()
    const definition = tool()
    f.registry.register(definition)
    f.dispatch({ target: 'workspace' })
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    const firstCard = f.state.pending[0]
    if (!firstCard) throw new Error('Expected pending confirmation')
    expect(firstCard).toMatchObject({ toolName: 'dsh_test', mode: 'ui' })
    expect(definition.execute).not.toHaveBeenCalled()
    await f.registry.resolveUiConfirmation(firstCard.confirmationId, true)
    expect(await completed(f)).toMatchObject({ ok: true, data: { done: true } })
    expect(definition.execute).toHaveBeenCalledTimes(1)

    f.state.config = resolveTtdsConfig({ tools: { writeConfirmation: 'auto' } }, {})
    f.dispatch({ target: 'workspace' })
    expect(await completed(f, 2)).toMatchObject({ ok: true, data: { done: true } })
    expect(f.state.pending).toEqual([])
    expect(definition.execute).toHaveBeenCalledTimes(2)
  })

  it('rejects execution when confirmation policy upgrades mid-wait from ui to auto or vice versa', async () => {
    const f = setup()
    const definition = tool()
    f.registry.register(definition)
    f.dispatch({ target: 'workspace' })
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    const card = f.state.pending[0]
    if (!card) throw new Error('Expected pending confirmation')
    f.state.config = resolveTtdsConfig({ tools: { writeConfirmation: 'auto' } }, {})
    await f.registry.resolveUiConfirmation(card.confirmationId, true)
    expect(await completed(f)).toMatchObject({ ok: false, error: { code: 'confirmation_policy_changed' } })
    expect(definition.execute).not.toHaveBeenCalled()
  })
})

describe('UI confirmation and lifecycle', () => {
  it.each([true, false])('settles an explicit UI decision: %s', async (approved) => {
    const f = setup()
    const definition = tool({ resolveConfirmation: () => 'ui' })
    f.registry.register(definition)
    f.dispatch({ target: 'workspace' })
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    expect(f.state.results).toHaveLength(0)
    const pendingCard = f.state.pending[0]
    if (!pendingCard) throw new Error('Expected pending confirmation')
    const id = pendingCard.confirmationId
    expect(await f.registry.resolveUiConfirmation(id, approved)).toBe(true)
    expect(await f.registry.resolveUiConfirmation(id, true)).toBe(false)
    expect((await completed(f)).ok).toBe(approved)
    expect(definition.execute).toHaveBeenCalledTimes(approved ? 1 : 0)
    expect(f.state.pending).toEqual([])
    expect(f.state.journal).toContainEqual(expect.objectContaining({ kind: 'tool.confirmation' }))
  })

  it('cancelAll removes pending cards, releases leases, and allows a new session call', async () => {
    const f = setup()
    const definition = tool({ resolveConfirmation: () => 'ui' })
    f.registry.register(definition)
    f.dispatch()
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    await f.registry.cancelAll('rotate')
    expect(f.state.pending).toEqual([])
    expect(f.state.results[0]?.result.ok).toBe(false)
    expect(f.state.released).toBe(1)
    expect(definition.execute).not.toHaveBeenCalled()
    f.dispatch()
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
  })

  it('unregistering a tool rejects its pending UI card without executing', async () => {
    const f = setup()
    const definition = tool({ resolveConfirmation: () => 'ui' })
    const dispose = f.registry.register(definition)
    f.dispatch()
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    dispose()
    expect(await completed(f)).toMatchObject({ ok: false })
    expect(f.state.pending).toEqual([])
    expect(f.registry.listToolNames()).toEqual([])
    expect(definition.execute).not.toHaveBeenCalled()
  })

  it('aborts execution on lease cancellation and waits for asynchronous cleanup', async () => {
    const f = setup()
    let signal: AbortSignal | undefined
    let finish: (() => void) | undefined
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    const definition = tool({ resolveConfirmation: () => 'auto', execute: (_args, context) => {
      signal = context.signal
      entered!()
      return new Promise((resolve) => {
        finish = () => { resolve({ ok: false, error: { code: 'aborted', message: 'cancelled' } }) }
      })
    } })
    f.registry.register(definition)
    f.dispatch()
    await started
    f.sessionAbort.abort()
    expect(signal?.aborted).toBe(true)
    let cancelled = false
    const cancellation = f.registry.cancelAll('dispose').then(() => { cancelled = true })
    await Promise.resolve()
    expect(cancelled).toBe(false)
    finish!()
    await cancellation
    expect(f.state.released).toBe(1)
  })

  it('keeps independent work running across new foreground user inputs', async () => {
    const f = setup()
    const handlers: ((value: { ok: boolean }) => void)[] = []
    const signals: AbortSignal[] = []
    const definition = tool({ resolveConfirmation: () => 'auto', execute: (_args, context) => {
      signals.push(context.signal)
      return new Promise((resolve) => { handlers.push(resolve) })
    } })
    f.registry.register(definition)
    f.dispatch()
    f.dispatch()
    await vi.waitFor(() => { expect(handlers).toHaveLength(2) })
    f.state.cursors = { ...f.state.cursors, inputAdmissionSeq: 5 }
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    handlers[1]?.({ ok: true })
    await completed(f)
    handlers[0]?.({ ok: true })
    await completed(f, 2)
    await vi.waitFor(() => { expect(f.state.released).toBe(2) })
    expect(f.state.hooks).toHaveLength(2)
  })

  it('expires UI waits and never executes after timeout', async () => {
    const f = setup()
    f.state.config = { ...f.state.config, tools: { ...f.state.config.tools, toolTimeoutMs: 20 } }
    const definition = tool({ resolveConfirmation: () => 'ui' })
    f.registry.register(definition)
    f.dispatch()
    expect(await completed(f)).toMatchObject({ ok: false, error: { code: 'tool_cancelled' } })
    expect(f.state.pending).toEqual([])
    expect(definition.execute).not.toHaveBeenCalled()
  })

  it.each(['{', '[]', '{"target":1}', '{"unexpected":true}', '{"confirmed":"true"}'])(
    'rejects malformed or schema-invalid arguments: %s',
    async (argumentsJson) => {
      const f = setup()
      const definition = tool({ resolveConfirmation: () => 'auto' })
      f.registry.register(definition)
      f.registry.dispatchToolCalls([{ callId: 'invalid', itemId: 'invalid', name: definition.name, argumentsJson }])
      expect(await completed(f)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
      expect(definition.execute).not.toHaveBeenCalled()
    },
  )
})
