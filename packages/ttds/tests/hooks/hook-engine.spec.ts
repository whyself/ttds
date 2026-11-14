import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventHookEngine, VoiceHookRegistry } from '../../src/hooks/index.ts'
import { createFixture, event, toolReady } from './fixture.ts'

let fixture: ReturnType<typeof createFixture>

beforeEach(() => {
  vi.useFakeTimers()
  fixture = createFixture()
})

afterEach(async () => {
  await fixture.ctx.fiber.dispose()
  vi.useRealTimers()
})

describe('EventHookEngine quiet-turn delivery', () => {
  it('provides the registry and delivers at exactly the default 1800 ms boundary after quiet start', async () => {
    expect(VoiceHookRegistry).toBe(EventHookEngine)
    expect(fixture.ctx.ttdsHooks.getBufferedEvents()).toEqual([])
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1799)
    expect(fixture.notifications).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.notifications).toHaveLength(1)
    expect(fixture.notifications[0]?.text).toBe('后台任务已完成')
    expect(fixture.feed[0]?.kind).toBe('hook_event')
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('delivers after a 350 ms coalesce debounce when the channel has already been quiet past quietGraceMs', async () => {
    await vi.advanceTimersByTimeAsync(2000)
    fixture.engine.enqueue(event({ summary: '长期静默后到达的审批' }))
    await vi.advanceTimersByTimeAsync(349)
    expect(fixture.notifications).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.notifications).toHaveLength(1)
    expect(fixture.notifications[0]?.text).toBe('长期静默后到达的审批')
  })

  it.each(['connecting', 'speaking', 'thinking', 'error'] as const)(
    'pauses on %s and starts a complete new grace window on listening',
    async (phase) => {
      fixture.engine.enqueue(event())
      await vi.advanceTimersByTimeAsync(1400)
      fixture.setState({ phase })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fixture.notifications).toEqual([])
      fixture.setState({ phase: 'listening' })
      await vi.advanceTimersByTimeAsync(1799)
      expect(fixture.notifications).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(fixture.notifications).toHaveLength(1)
    },
  )

  it('restarts grace after admitted input and quiet phase transitions', async () => {
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1400)
    fixture.setState({ inputAdmissionSeq: 1 })
    await vi.advanceTimersByTimeAsync(1400)
    fixture.setState({ phase: 'idle' })
    await vi.advanceTimersByTimeAsync(1799)
    expect(fixture.notifications).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.notifications).toHaveLength(1)
  })

  it('does not postpone delivery for unrelated snapshot updates or same-window events', async () => {
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1400)
    fixture.setState({ pendingToolCount: 2 })
    fixture.engine.enqueue(event({ summary: '另一个后台任务已完成' }))
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.notifications).toHaveLength(1)
    expect(fixture.notifications[0]?.text).toContain('另一个后台任务已完成')
  })

  it('rechecks the current snapshot before invoking the runtime', async () => {
    fixture.engine.enqueue(event())
    fixture.setState({ supervisorSessionId: null, phase: 'idle' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixture.notifications).toEqual([])
    fixture.setState({ supervisorSessionId: 'voice-2' })
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications).toHaveLength(1)
  })

  it('bounds disconnected buffering to the latest 20 highest-priority events without timers', async () => {
    fixture.setState({ supervisorSessionId: null, phase: 'idle' })
    for (let index = 0; index < 25; index++) {
      fixture.engine.enqueue(event({ priority: 'critical', summary: `高优事件 ${index}` }))
    }
    for (let index = 0; index < 25; index++) {
      fixture.engine.enqueue(event({ priority: 'low', summary: `低优事件 ${index}` }))
    }
    expect(fixture.engine.getBufferedEvents()).toHaveLength(20)
    expect(fixture.engine.getBufferedEvents()[0]?.summary).toBe('高优事件 5')
    expect(fixture.engine.getBufferedEvents().every(item => item.priority === 'critical')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixture.notifications).toEqual([])
  })

  it('replaces a matching dedupe key in place and retains only the latest summary', async () => {
    fixture.engine.enqueue(event({ dedupeKey: 'turn:1', summary: '旧进展' }))
    fixture.engine.enqueue(event({ dedupeKey: 'turn:2', summary: '另一进展' }))
    fixture.engine.enqueue(event({ dedupeKey: 'turn:1', summary: '最新进展' }))
    expect(fixture.engine.getBufferedEvents().map(item => item.summary)).toEqual(['最新进展', '另一进展'])
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications[0]?.text).toBe('最新进展；另一进展')
  })

  it('packs three highest-priority events, folds the count, then delivers the remaining batch', async () => {
    for (const [priority, summary] of [
      ['low', '低优先级'],
      ['normal', '普通一'],
      ['critical', '等待授权'],
      ['high', '执行失败'],
      ['normal', '普通二'],
    ] as const) fixture.engine.enqueue(event({ priority, summary }))
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications[0]?.text).toBe('等待授权；执行失败；普通一（另有 2 条后台会话进展待查看）')
    expect(fixture.engine.getBufferedEvents()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications[1]?.text).toBe('普通二；低优先级')
  })

  it('wakes after the short debounce window for tool outputs without reinjecting their payloads', async () => {
    fixture.engine.enqueue(toolReady('a'))
    fixture.engine.enqueue(toolReady('b'))
    await vi.advanceTimersByTimeAsync(119)
    expect(fixture.spokenTurns).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.spokenTurns).toBe(1)
    expect(fixture.notifications).toEqual([])
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('coalesces lifecycle and ready-tool events into one notification at full quietGraceMs', async () => {
    fixture.engine.enqueue(toolReady('a'))
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1799)
    expect(fixture.notifications).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.notifications).toHaveLength(1)
    expect(fixture.notifications[0]?.metadata.events).toHaveLength(2)
    expect(fixture.spokenTurns).toBe(0)
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('naturally consumes selected call IDs and cancels the timer when all tools are consumed', async () => {
    fixture.engine.enqueue(toolReady('a'))
    fixture.engine.enqueue(toolReady('b'))
    await vi.advanceTimersByTimeAsync(100)
    fixture.engine.markToolOutputsNaturallyConsumed(['a'])
    expect(fixture.engine.getBufferedEvents().map(item => item.metadata?.callId)).toEqual(['b'])
    fixture.engine.markToolOutputsNaturallyConsumed()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.spokenTurns).toBe(0)
  })

  it('preserves lifecycle notifications when naturally consuming tool outputs', async () => {
    fixture.engine.enqueue(toolReady('a'))
    fixture.engine.enqueue(event())
    fixture.engine.markToolOutputsNaturallyConsumed()
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications).toHaveLength(1)
    expect(fixture.spokenTurns).toBe(0)
  })

  it('suppresses overlapping self-actions and immediate release echoes for the exact session', async () => {
    const first = fixture.engine.beginSelfAction('target', 'cancel')
    const second = fixture.engine.beginSelfAction('target', 'submit')
    fixture.engine.enqueue(event({ sessionId: 'target' }))
    fixture.engine.enqueue(event({ sessionId: 'other' }))
    first.release()
    first.release()
    await vi.advanceTimersByTimeAsync(500)
    fixture.engine.enqueue(event({ sessionId: 'target' }))
    expect(fixture.engine.getBufferedEvents()).toHaveLength(1)
    second.release()
    await vi.advanceTimersByTimeAsync(249)
    fixture.engine.enqueue(event({ sessionId: 'target' }))
    expect(fixture.engine.getBufferedEvents()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    fixture.engine.enqueue(event({ sessionId: 'target' }))
    expect(fixture.engine.getBufferedEvents()).toHaveLength(2)
  })

  it('honors dynamic enablement at admission and again before flushing', async () => {
    fixture.setConfig({ onShellExitError: false })
    const shell = event({ hookId: 'shell/exit-error', priority: 'high' })
    fixture.engine.enqueue(shell)
    fixture.engine.enqueue(event({ hookId: 'missing' }))
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    fixture.setConfig({ onShellExitError: true })
    fixture.engine.enqueue(shell)
    fixture.setConfig({ onShellExitError: false }, false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fixture.notifications).toEqual([])
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('restarts the grace window when its live configuration changes', async () => {
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1000)
    fixture.setConfig({ quietGraceMs: 2000 })
    await vi.advanceTimersByTimeAsync(1999)
    expect(fixture.notifications).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.notifications).toHaveLength(1)
  })

  it('rejects duplicates and removes queued events on registration disposal', () => {
    expect(() => fixture.engine.register({
      id: 'agent/error', priority: 'high', isEnabled: () => true,
    })).toThrow('duplicate hook')
    const remove = fixture.engine.register({ id: 'extension', priority: 'low', isEnabled: () => true })
    fixture.engine.enqueue(event({ hookId: 'extension' }))
    remove()
    remove()
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains refused deliveries and retries only after another quiet window', async () => {
    fixture.setDelivery(() => Promise.resolve(false))
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.engine.getBufferedEvents()).toHaveLength(1)
    expect(fixture.feed).toEqual([])
    fixture.setDelivery(() => Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(349)
    expect(fixture.notifications).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.notifications).toHaveLength(2)
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('preserves a newer deduped event arriving during delivery and serializes batches', async () => {
    let finish: (accepted: boolean) => void = () => {}
    fixture.setDelivery(() => new Promise<boolean>((resolve) => { finish = resolve }))
    fixture.engine.enqueue(event({ dedupeKey: 'turn:1', summary: '旧进展' }))
    await vi.advanceTimersByTimeAsync(1800)
    fixture.engine.enqueue(event({ dedupeKey: 'turn:1', summary: '新进展' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.notifications).toHaveLength(1)
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.engine.getBufferedEvents()[0]?.summary).toBe('新进展')
    fixture.setDelivery(() => Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(350)
    expect(fixture.notifications[1]?.text).toBe('新进展')
  })

  it('reports failed delivery and keeps the event available for retry', async () => {
    fixture.setDelivery(() => Promise.reject(new Error('upstream unavailable')))
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.feed[0]).toMatchObject({ kind: 'diagnostic' })
    expect(fixture.engine.getBufferedEvents()).toHaveLength(1)
    fixture.setDelivery(() => Promise.resolve(true))
    await vi.advanceTimersByTimeAsync(350)
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('drains an in-flight delivery before releasing the runtime lease', async () => {
    let finish: (accepted: boolean) => void = () => {}
    fixture.setDelivery(() => new Promise<boolean>((resolve) => { finish = resolve }))
    fixture.engine.enqueue(event())
    await vi.advanceTimersByTimeAsync(1800)
    const disposing = fixture.ctx.fiber.dispose()
    expect(fixture.leases).toBe(1)
    finish(true)
    await disposing
    expect(fixture.leases).toBe(0)
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    expect(fixture.feed).toEqual([])
    expect(fixture.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops timers and rejects work when the runtime aborts its lease', async () => {
    const action = fixture.engine.beginSelfAction('target', 'submit')
    action.release()
    fixture.engine.enqueue(event())
    fixture.controller.abort()
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    fixture.engine.enqueue(event())
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.notifications).toEqual([])
  })
})
