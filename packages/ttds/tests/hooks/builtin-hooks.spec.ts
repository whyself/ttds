import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSeq, type Session, type ToolResultMessage } from '@deepseek-ai/dsh-session'
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

function appendCustom(session: Session, type: string, data: Record<string, unknown>): void {
  const writer: { append(eventType: string, payload: Record<string, unknown>): void } = session
  writer.append(type, data)
}

function appendResult(session: Session, text: string, meta?: { exitCode: number }): void {
  const callId = 'call-1' as ToolResultMessage['toolCallId']
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'result-1' as ToolResultMessage['id'],
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text }],
    },
    ...meta === undefined ? {} : { meta },
  }, { surfaceOp: 'append' })
}

describe('built-in public event subscriptions', () => {
  it('registers all six built-ins and observes the named bridge without intercepting listeners', async () => {
    let observed = 0
    fixture.ctx.on('ttds/lifecycle-event', () => { observed++ })
    for (const hookId of [
      'agent/turn-settled',
      'agent/tool-approval',
      'agent/error',
      'shell/exit-error',
      'subagent/settled',
    ]) {
      fixture.ctx.emit('ttds/lifecycle-event', event({ hookId }))
    }
    fixture.engine.enqueue(toolReady('call-1'))
    expect(observed).toBe(5)
    expect(fixture.engine.getBufferedEvents()).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications).toHaveLength(1)
  })

  it('projects live root turn completion into a Chinese notification through the real session feed', async () => {
    const session = fixture.ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.engine.getBufferedEvents()).toMatchObject([{
      hookId: 'agent/turn-settled',
      priority: 'normal',
      sessionId: session.id,
      dedupeKey: `turn:${session.id}`,
    }])
    await vi.advanceTimersByTimeAsync(1800)
    expect(fixture.notifications[0]?.text).toContain('已完成本轮任务')
  })

  it.each(['error', 'blocked'] as const)('projects %s turn settlement at high priority', (kind) => {
    const session = fixture.ctx.sessions.create()
    session.append('turn/end', {
      turn: 1,
      reason: kind === 'error'
        ? { kind, error: { message: 'request failed', code: 'UNKNOWN' } }
        : { kind },
    })
    expect(fixture.engine.getBufferedEvents()).toMatchObject([{ hookId: 'agent/error', priority: 'high' }])
  })

  it('keeps child settlements separate from root completions and ignores child tool chatter', () => {
    const session = fixture.ctx.sessions.create(undefined, {
      meta: { origin: 'subagent', delegationDepth: 1 },
    })
    appendResult(session, '{"exitCode":2}')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.engine.getBufferedEvents()).toMatchObject([{
      hookId: 'subagent/settled',
      priority: 'normal',
      sessionId: session.id,
    }])
  })

  it('ignores user cancellation, teardown, fork, and interrupted synthetic closers', () => {
    const session = fixture.ctx.sessions.create()
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    session.append('turn/end', { turn: 3, reason: { kind: 'forked' } })
    session.append('turn/end', { turn: 4, reason: { kind: 'interrupted' } })
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores seed history even when it is republished on the live event bus', () => {
    const seed = {
      type: 'turn/end',
      seq: SessionSeq(0),
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    } as const
    const session = fixture.ctx.sessions.create(undefined, { seed: [seed] })
    fixture.ctx.emit('session/event', session, seed)
    expect(fixture.engine.getBufferedEvents()).toEqual([])
  })

  it('projects a nonzero shell JSON result and records its call and exit code', () => {
    const session = fixture.ctx.sessions.create()
    appendResult(session, '{"exitCode":7,"stderr":{"text":"failed"}}')
    expect(fixture.engine.getBufferedEvents()).toMatchObject([{
      hookId: 'shell/exit-error',
      priority: 'high',
      metadata: { callId: 'call-1', exitCode: 7 },
    }])
    expect(fixture.engine.getBufferedEvents()[0]?.summary).toContain('退出码 7')
  })

  it('reads structured result metadata and ignores successful or unrelated results', () => {
    const session = fixture.ctx.sessions.create()
    appendResult(session, '普通文本结果')
    appendResult(session, '{"exitCode":0}')
    appendResult(session, '{"exitCode":"7"}')
    appendResult(session, '{"count":4}')
    appendResult(session, '命令失败', { exitCode: 9 })
    expect(fixture.engine.getBufferedEvents()).toMatchObject([{
      hookId: 'shell/exit-error',
      metadata: { exitCode: 9 },
    }])
  })

  it('captures ask_user_question tool calls and formats readable workspace and session title labels', () => {
    const session = fixture.ctx.sessions.create(
      'session-5d6f71a9-cb8d-4c92-8d20-c76339e7357c' as Session['id'],
      { meta: { cwd: resolve(tmpdir(), 'default-workspace') } },
    )
    appendCustom(
      session,
      'session/title',
      { title: '用工具提问的交互测试', messageSeqs: [], source: { kind: 'provider', provider: 'p' } },
    )
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call_q_1' as ToolResultMessage['toolCallId'],
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{ id: 'q1', header: '下一步', question: '想让我帮你做什么？' }],
      }),
    })
    expect(fixture.engine.getBufferedEvents()).toMatchObject([{
      hookId: 'agent/tool-approval',
      priority: 'critical',
      dedupeKey: `question:${session.id}:call_q_1`,
    }])
    const summary = fixture.engine.getBufferedEvents()[0]?.summary ?? ''
    expect(summary).toContain('工作区 default-workspace')
    expect(summary).toContain('用工具提问的交互测试')
    expect(summary).toContain('下一步：想让我帮你做什么？')

    const longSession = fixture.ctx.sessions.create()
    appendCustom(
      longSession,
      'session/title',
      { title: 'Sophon-Realtime Colab 部署可行性与千积分预算方案', messageSeqs: [], source: { kind: 'provider', provider: 'p' } },
    )
    longSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.engine.getBufferedEvents()[1]?.summary).toContain('Sophon-Realtime Colab 部署可行性与千积分预算方案')
  })

  it('enriches approval/asked with paired tool call arguments and abbreviates long UUID session ids', () => {
    const longId = 'session-5d6f71a9-cb8d-4c92-8d20-c76339e7357c' as Session['id']
    const session = fixture.ctx.sessions.create(longId)
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call_pwsh_1' as ToolResultMessage['toolCallId'],
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'Get-ChildItem D:/Projects', description: '列出项目目录' }),
    })
    appendCustom(
      session,
      'approval/asked',
      {
        id: 'approval-1',
        toolName: 'pwsh',
        callId: 'call_pwsh_1',
        reason: 'escalate sandbox to danger-full-access: read outside workspace',
      },
    )
    const summary = fixture.engine.getBufferedEvents()[0]?.summary ?? ''
    expect(summary).toContain('session-5d6f71a9')
    expect(summary).not.toContain('c76339e7357c')
    expect(summary).toContain('pwsh')
    expect(summary).toContain('列出项目目录')
  })

  it('suppresses a real synchronous session mutation until its self-action guard releases', async () => {
    const session = fixture.ctx.sessions.create()
    const guard = fixture.engine.beginSelfAction(session.id, 'cancel')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    guard.release()
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    await vi.advanceTimersByTimeAsync(250)
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(fixture.engine.getBufferedEvents()).toHaveLength(1)
  })

  it('uses live built-in toggles on the real shell result feed', () => {
    const session = fixture.ctx.sessions.create()
    fixture.setConfig({ onShellExitError: false })
    appendResult(session, '{"exitCode":1}')
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    fixture.setConfig({ onShellExitError: true })
    appendResult(session, '{"exitCode":1}')
    expect(fixture.engine.getBufferedEvents()).toHaveLength(1)
  })

  it('unregisters every built-in and both event listeners synchronously and idempotently', () => {
    const session = fixture.ctx.sessions.create()
    fixture.ctx.emit('ttds/lifecycle-event', event())
    fixture.unregister()
    fixture.unregister()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    fixture.ctx.emit('ttds/lifecycle-event', event())
    fixture.engine.enqueue(toolReady('call-1'))
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears queued events and all timers on fiber disposal and ignores subsequent session dispatch', async () => {
    const session = fixture.ctx.sessions.create()
    fixture.engine.enqueue(event())
    const guard = fixture.engine.beginSelfAction('target', 'submit')
    guard.release()
    expect(vi.getTimerCount()).toBe(2)
    await fixture.ctx.fiber.dispose()
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    expect(fixture.listeners.size).toBe(0)
    expect(fixture.leases).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    fixture.ctx.emit('session/event', session, {
      type: 'turn/end',
      seq: SessionSeq(0),
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    fixture.ctx.emit('ttds/lifecycle-event', event())
    guard.release()
    fixture.engine.beginSelfAction('late', 'submit').release()
    expect(fixture.engine.getBufferedEvents()).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.notifications).toEqual([])
  })
})
