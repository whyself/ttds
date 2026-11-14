import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SessionController, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTtdsConfig, type VoiceToolResult } from '../../src/shared/index.ts'
import { registerBuiltinVoiceTools, VoiceApprovalHostBridge, type VoiceToolHostBridge } from '../../src/tools/index.ts'
import { fixture } from './fixture.ts'

const fixtures: ReturnType<typeof fixture>[] = []
const directories: string[] = []
const toolsDirectory = resolve('packages/ttds/tests/tools')

function setup() {
  const f = fixture()
  fixtures.push(f)
  f.state.config = resolveTtdsConfig({ tools: { writeConfirmation: 'auto' } }, {})
  const events: SessionWireEvent[] = [
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '检查构建' }] } },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
    { type: 'tool/call', seq: 2, time: 3, data: { name: 'shell' } },
    { type: 'assistant/message', seq: 3, time: 4, data: { content: [{ type: 'text', text: '构建完成' }] } },
    { type: 'turn/end', seq: 4, time: 5, data: {} },
  ]
  const service = {
    list: vi.fn<SessionController['list']>(() => Promise.resolve({ items: [{
      sessionId: SessionId('s1'), running: true, agentAvailable: true, blank: false, updatedAt: 1, cwd: 'D:/work',
    }] })),
    state: vi.fn<SessionController['state']>(() => Promise.resolve({
      active: true, running: true, cursor: 4,
      queue: [{ id: 'q-1' as never, placement: 'queued', content: [{ type: 'text', text: '排队任务一' }] }],
      pendingInput: ['approval'],
    })),
    events: vi.fn<SessionController['events']>(() => Promise.resolve({
      cursor: 4, hasMore: false, records: events.map(event => ({ type: 'event', event })),
    })),
    create: vi.fn<SessionController['create']>(() => Promise.resolve({ sessionId: SessionId('created') })),
    prompt: vi.fn<SessionController['prompt']>(() => Promise.resolve({ accepted: true })),
    updateQueue: vi.fn<SessionController['updateQueue']>(() => Promise.resolve({ accepted: true })),
    cancel: vi.fn<SessionController['cancel']>(() => ({ accepted: true })),
    selectModel: vi.fn<SessionController['selectModel']>(request => Promise.resolve({
      selected: { provider: request.provider, model: request.model },
    })),
  } satisfies Pick<SessionController, 'list' | 'state' | 'events' | 'create' | 'prompt' | 'updateQueue' | 'cancel' | 'selectModel'>
  const sessionControllerKey: string = 'sessionController'
  f.ctx.provide(sessionControllerKey, service)
  const dispose = registerBuiltinVoiceTools(f.ctx, f.registry)
  const call = async (name: string, args: Readonly<Record<string, unknown>> = {}): Promise<VoiceToolResult> => {
    const callId = f.dispatch(args, name)
    await vi.waitFor(() => { expect(f.state.results.some(item => item.callId === callId)).toBe(true) })
    return f.state.results.find(item => item.callId === callId)!.result
  }
  return { ...f, service, events, call, dispose }
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.ctx.fiber.dispose()
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(`${toolsDirectory}\\`) && !directory.startsWith(`${toolsDirectory}/`)) {
      throw new Error('Test directory escaped tools scope')
    }
    await rm(directory, { recursive: true, force: true })
  }
})

describe('built-in voice tools', () => {
  it('registers all eleven tools and disposes the whole catalog idempotently', () => {
    const f = setup()
    expect(f.registry.listToolNames()).toEqual([
      'dsh_list_sessions', 'dsh_get_session_progress', 'dsh_inspect_workspace_changes',
      'dsh_read_session_messages', 'dsh_list_pending_approvals', 'dsh_search', 'dsh_create_session',
      'dsh_send_session_prompt', 'dsh_cancel_session_turn', 'dsh_switch_session_model', 'dsh_resolve_tool_approval',
    ])
    f.dispose()
    f.dispose()
    expect(f.registry.listToolNames()).toEqual([])
  })

  it('rolls back partial built-in registration when a name is already occupied', () => {
    const f = setup()
    f.dispose()
    f.registry.register({
      name: 'dsh_get_session_progress', description: 'Existing tool', category: 'read',
      parameters: { type: 'object', properties: {} },
      resolveConfirmation: () => 'auto',
      execute: () => Promise.resolve({ ok: true }),
    })
    expect(() => registerBuiltinVoiceTools(f.ctx, f.registry)).toThrow('重复')
    expect(f.registry.listToolNames()).toEqual(['dsh_get_session_progress'])
  })

  it('lists bounded recent sessions from the public controller', async () => {
    const f = setup()
    expect(await f.call('dsh_list_sessions')).toMatchObject({
      ok: true, data: { sessions: [{ sessionId: 's1', title: null, cwd: 'D:/work', running: true, active: true, blank: false, updatedAt: 1, origin: 'root' }] },
    })
    expect(f.service.list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
    expect(f.beginSelfAction).not.toHaveBeenCalled()
  })

  it('prioritizes non-blank root sessions and exposes projected session titles in dsh_list_sessions', async () => {
    const f = setup()
    f.service.list.mockResolvedValueOnce({
      items: [
        {
          sessionId: SessionId('s-sub'), running: false, agentAvailable: false, blank: false, updatedAt: 300,
          origin: 'subagent', cwd: 'D:/sub', projections: { kind: 'cached', asOfSeq: 1, values: { title: '子代理任务' } },
        },
        {
          sessionId: SessionId('s-blank'), running: false, agentAvailable: false, blank: true, updatedAt: 200,
          cwd: 'D:/blank',
        },
        {
          sessionId: SessionId('s-sophon'), running: true, agentAvailable: true, blank: false, updatedAt: 100,
          cwd: 'D:/work', projections: { kind: 'cached', asOfSeq: 5, values: { title: 'Sophon-Realtime Colab 部署可行性' } },
        },
      ],
    })
    const res = await f.call('dsh_list_sessions')
    expect(res).toMatchObject({
      ok: true,
      data: {
        sessions: [
          { sessionId: 's-sophon', title: 'Sophon-Realtime Colab 部署可行性', blank: false, updatedAt: 100, origin: 'root' },
          { sessionId: 's-blank', title: null, blank: true, updatedAt: 200, origin: 'root' },
          { sessionId: 's-sub', title: '子代理任务', origin: 'subagent' },
        ],
      },
    })
  })

  it('summarizes progress, the latest reply and tool activity', async () => {
    const f = setup()
    expect(await f.call('dsh_get_session_progress', { sessionId: 's1' })).toMatchObject({
      ok: true, data: {
        sessionId: 's1', running: true, phase: 'turn/end', latestAssistant: '构建完成',
        toolActivity: [{ seq: 2, name: 'shell' }],
      },
    })
    expect(f.service.state).toHaveBeenCalledWith({ sessionId: 's1' }, expect.any(AbortSignal))
  })

  it('reads only user/assistant messages and forwards the default and explicit limits', async () => {
    const f = setup()
    expect(await f.call('dsh_read_session_messages', { sessionId: 's1' })).toMatchObject({
      ok: true,
      data: {
        initialPrompt: '检查构建',
        messages: [{ role: 'user', text: '检查构建' }, { role: 'assistant', text: '构建完成' }],
      },
    })
    expect(f.service.events).toHaveBeenLastCalledWith({
      address: { kind: 'session', sessionId: 's1' }, maxMessages: 30,
    }, expect.any(AbortSignal))
    expect(await f.call('dsh_read_session_messages', { sessionId: 's1', limit: 1 })).toMatchObject({
      ok: true, data: { initialPrompt: '检查构建', messages: [{ role: 'assistant', text: '构建完成' }], truncated: true },
    })
    expect(await f.call('dsh_read_session_messages', { sessionId: 's1', limit: 21 })).toMatchObject({ ok: false })
  })

  it('filters intermediate tool-call assistant drafts and extracts initialPrompt and title cleanly', async () => {
    const f = setup()
    f.service.list.mockResolvedValue({
      items: [{
        sessionId: SessionId('ttds-sophon-session-uuid'),
        running: false,
        agentAvailable: true,
        blank: false,
        updatedAt: 500,
        cwd: 'D:/work',
        projections: { kind: 'cached', asOfSeq: 9, values: { title: 'Sophon-Realtime Colab 部署可行性' } },
      }],
    })
    const richEvents: SessionWireEvent[] = [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '评估 Ultra 5X 下 Colab 跑 Sophon-Realtime 的可行性' }] } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'Let me search Colab GPUs first.' }] } },
      { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, name: 'web_search' } },
      { type: 'step/start', seq: 5, time: 6, data: { turn: 1, step: 2 } },
      { type: 'assistant/message', seq: 6, time: 7, data: { turn: 1, step: 2, content: [{ type: 'text', text: 'Fixing JSON escape issue in tool call.' }] } },
      { type: 'tool/call', seq: 7, time: 8, data: { turn: 1, step: 2, name: 'web_fetch' } },
      { type: 'assistant/message', seq: 8, time: 9, data: { turn: 1, step: 3, content: [{ type: 'text', text: '最终结论：Ultra 5X 每月 1000 积分建议首选 3B 流式模型。' }] } },
      { type: 'turn/end', seq: 9, time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    f.service.events.mockResolvedValue({
      cursor: 9,
      hasMore: false,
      records: richEvents.map(event => ({ type: 'event', event })),
    })

    const messagesRes = await f.call('dsh_read_session_messages', { sessionId: 'Sophon-Realtime' })
    expect(messagesRes).toMatchObject({
      ok: true,
      data: {
        sessionId: 'ttds-sophon-session-uuid',
        title: 'Sophon-Realtime Colab 部署可行性',
        initialPrompt: '评估 Ultra 5X 下 Colab 跑 Sophon-Realtime 的可行性',
        messages: [
          { seq: 0, role: 'user', text: '评估 Ultra 5X 下 Colab 跑 Sophon-Realtime 的可行性' },
          { seq: 8, role: 'assistant', text: '最终结论：Ultra 5X 每月 1000 积分建议首选 3B 流式模型。' },
        ],
      },
    })

    const progressRes = await f.call('dsh_get_session_progress', { sessionId: 'latest' })
    expect(progressRes).toMatchObject({
      ok: true,
      data: {
        sessionId: 'ttds-sophon-session-uuid',
        title: 'Sophon-Realtime Colab 部署可行性',
        latestAssistant: '最终结论：Ultra 5X 每月 1000 积分建议首选 3B 流式模型。',
      },
    })

    await expect(f.call('dsh_send_session_prompt', { sessionId: 'latest', prompt: '补充：按 Ultra 5X 档位预算计算' })).resolves.toMatchObject({
      ok: true,
      data: { sessionId: 'ttds-sophon-session-uuid', accepted: true },
    })
    expect(f.service.prompt).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'ttds-sophon-session-uuid',
      content: [{ type: 'text', text: '补充：按 Ultra 5X 档位预算计算' }],
    }), expect.any(AbortSignal))
  })

  it('returns ambiguous_session when a title keyword matches multiple root sessions', async () => {
    const f = setup()
    f.service.list.mockResolvedValueOnce({
      items: [
        {
          sessionId: SessionId('s-dup-1'), running: false, agentAvailable: true, blank: false, updatedAt: 20, cwd: 'D:/a',
          projections: { kind: 'cached', asOfSeq: 2, values: { title: 'Colab 测算方案一' } },
        },
        {
          sessionId: SessionId('s-dup-2'), running: false, agentAvailable: true, blank: false, updatedAt: 10, cwd: 'D:/b',
          projections: { kind: 'cached', asOfSeq: 2, values: { title: 'Colab 测算方案二' } },
        },
      ],
    })
    expect(await f.call('dsh_get_session_progress', { sessionId: 'Colab' })).toMatchObject({
      ok: false,
      error: { code: 'ambiguous_session' },
    })
  })

  it('bounds each message instead of returning long transcripts', async () => {
    const f = setup()
    f.events.push({ type: 'assistant/message', seq: 5, time: 6, data: { text: '长'.repeat(10_000) } })
    const result = await f.call('dsh_read_session_messages', { sessionId: 's1' })
    expect(result).toMatchObject({ ok: true, data: { truncated: true } })
    expect(JSON.stringify(result).length).toBeLessThan(1000)
  })

  it('inspects actual Git status and diff in an explicit workspace', async () => {
    const f = setup()
    const directory = await mkdtemp(join(toolsDirectory, 'git-fixture-'))
    directories.push(directory)
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true })
    await writeFile(join(directory, 'example.txt'), 'first\n')
    execFileSync('git', ['-c', 'core.autocrlf=false', '-C', directory, 'add', 'example.txt'], { windowsHide: true })
    await writeFile(join(directory, 'example.txt'), 'first\nsecond\n')
    const result = await f.call('dsh_inspect_workspace_changes', { cwd: directory })
    expect(result.ok).toBe(true)
    expect(result.data?.status).toContain('example.txt')
    expect(result.data?.diffStat).toContain('example.txt')
    expect(await f.call('dsh_inspect_workspace_changes', { cwd: 'relative' })).toMatchObject({
      ok: false, error: { code: 'workspace_unavailable' },
    })
  })

  it('lists pending interactions through cold-safe Session state when the bridge is absent', async () => {
    const f = setup()
    expect(await f.call('dsh_list_pending_approvals')).toMatchObject({
      ok: true, data: { approvals: [{ sessionId: 's1', pendingInput: ['approval'] }], resolutionAvailable: false },
    })
  })

  it('reads approval identities and submits decisions through the explicit host bridge', async () => {
    const f = setup()
    const listPendingApprovals = vi.fn<VoiceToolHostBridge['listPendingApprovals']>(() => Promise.resolve([
      { sessionId: 's1', approvalId: 'approval-1', summary: '运行构建脚本' },
    ]))
    const resolveToolApproval = vi.fn<VoiceToolHostBridge['resolveToolApproval']>(() =>
      Promise.resolve({ ok: true, data: { status: 'host_confirmed' } }))
    f.ctx.provide('ttdsToolHost', { listPendingApprovals, resolveToolApproval })
    expect(await f.call('dsh_list_pending_approvals')).toMatchObject({
      ok: true, data: { approvals: [{ sessionId: 's1', approvalId: 'approval-1' }] },
    })
    const callId = f.dispatch({ sessionId: 's1', approvalId: 'approval-1', approved: false }, 'dsh_resolve_tool_approval')
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    expect(resolveToolApproval).not.toHaveBeenCalled()
    const pendingCard = f.state.pending[0]
    if (!pendingCard) throw new Error('Expected pending confirmation')
    await f.registry.resolveUiConfirmation(pendingCard.confirmationId, true)
    await vi.waitFor(() => { expect(f.state.results.some(item => item.callId === callId)).toBe(true) })
    expect(resolveToolApproval).toHaveBeenCalledWith({
      sessionId: 's1', approvalId: 'approval-1', approved: false,
    }, expect.any(AbortSignal))
    expect(f.state.results.find(item => item.callId === callId)?.result).toMatchObject({
      ok: true, data: { status: 'host_confirmed' },
    })
    expect(f.beginSelfAction).toHaveBeenCalledWith('s1', 'resolve_tool_approval')
    expect(f.selfActionReleases.at(-1)).toHaveBeenCalledTimes(1)
  })

  it('returns a clear unavailable error when approval ownership is not connected', async () => {
    const f = setup()
    const callId = f.dispatch({ sessionId: 's1', approvalId: 'approval-1', approved: true }, 'dsh_resolve_tool_approval')
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    const unconfiguredCard = f.state.pending[0]
    if (!unconfiguredCard) throw new Error('Expected pending confirmation')
    await f.registry.resolveUiConfirmation(unconfiguredCard.confirmationId, true)
    await vi.waitFor(() => { expect(f.state.results.some(item => item.callId === callId)).toBe(true) })
    expect(f.state.results.find(item => item.callId === callId)?.result).toMatchObject({
      ok: false, error: { code: 'approval_service_unavailable' },
    })
  })

  it('creates a session and sends the optional initial prompt under self-action guards', async () => {
    const f = setup()
    expect(await f.call('dsh_create_session', { cwd: 'D:/work', prompt: '检查测试' })).toMatchObject({
      ok: true, data: { sessionId: 'created', promptSubmitted: true },
    })
    expect(f.service.create.mock.calls[0]?.[0].sessionId).toMatch(/^ttds-voice-/u)
    expect(f.service.create.mock.calls[0]?.[0].cwd).toBe('D:/work')
    expect(f.service.prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'created', mode: 'queue', content: [{ type: 'text', text: '检查测试' }],
    })
    expect(f.service.prompt.mock.calls[0]?.[0].requestId).toMatch(/^ttds:voice:call-/u)
    expect(f.beginSelfAction).toHaveBeenCalledTimes(2)
    for (const release of f.selfActionReleases) expect(release).toHaveBeenCalledTimes(1)
  })

  it('creates a session without a prompt when none was requested', async () => {
    const f = setup()
    expect(await f.call('dsh_create_session')).toMatchObject({ ok: true, data: { promptSubmitted: false } })
    expect(f.service.prompt).not.toHaveBeenCalled()
    expect(f.selfActionReleases[0]).toHaveBeenCalledTimes(1)
  })

  it('formats a clear default-workspace summary when dsh_create_session requires ui confirmation without cwd', async () => {
    const f = setup()
    f.state.config = resolveTtdsConfig({ tools: { writeConfirmation: 'ui' } }, {})
    const callId = f.dispatch({ prompt: '搜索新闻' }, 'dsh_create_session')
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    const card = f.state.pending[0]
    if (!card) throw new Error('Expected pending confirmation')
    expect(card.summary).toBe('创建 DSH 会话（默认工作区）：搜索新闻')
    await f.registry.resolveUiConfirmation(card.confirmationId, false)
    await vi.waitFor(() => { expect(f.state.results.some(item => item.callId === callId)).toBe(true) })
    expect(f.service.create).not.toHaveBeenCalled()
  })

  it.each([
    ['dsh_send_session_prompt', { sessionId: 's1', prompt: '继续任务' }, 'send_session_prompt'],
    ['dsh_cancel_session_turn', { sessionId: 's1' }, 'cancel_session_turn'],
    ['dsh_switch_session_model', { sessionId: 's1', provider: 'deepseek', model: 'chat' }, 'switch_session_model'],
  ] as const)('bridges %s and releases its self-action guard', async (name, args, actionKind) => {
    const f = setup()
    expect(await f.call(name, args)).toMatchObject({ ok: true })
    expect(f.beginSelfAction).toHaveBeenCalledWith('s1', actionKind)
    expect(f.selfActionReleases[0]).toHaveBeenCalledTimes(1)
    if (name === 'dsh_send_session_prompt') {
      expect(f.service.prompt).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1', content: [{ type: 'text', text: '继续任务' }], mode: 'steer',
      }), expect.any(AbortSignal))
    } else if (name === 'dsh_cancel_session_turn') {
      expect(f.service.cancel).toHaveBeenCalledWith({ sessionId: 's1' })
    } else {
      expect(f.service.selectModel).toHaveBeenCalledWith({ sessionId: 's1', provider: 'deepseek', model: 'chat' })
    }
  })

  it('attaches created sessions to the default or named workspace via workspaceRegistry', async () => {
    const f = setup()
    const wsDefault = { id: 'ws-default' as never, title: '默认工作区', path: 'C:\\Users\\demo\\default-workspace', sessionIds: [] }
    const wsTtds = { id: 'ws-ttds' as never, title: 'TTDS', path: 'D:\\Projects\\TTDS', sessionIds: [] }
    f.ctx.provide('workspaceRegistry', {
      list: () => [wsTtds, wsDefault],
      resolveByPath: async (p: string) => (p.includes('TTDS') ? wsTtds : undefined),
    })

    expect(await f.call('dsh_create_session', { prompt: '去查默认工作区任务' })).toMatchObject({
      ok: true, data: { sessionId: 'created', workspaceId: 'ws-default', workspaceTitle: '默认工作区', promptSubmitted: true },
    })
    expect(f.service.create.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'ws-default' })
    expect(f.service.create.mock.calls[0]?.[0].cwd).toBeUndefined()

    expect(await f.call('dsh_create_session', { workspace: 'TTDS' })).toMatchObject({
      ok: true, data: { workspaceId: 'ws-ttds', workspaceTitle: 'TTDS' },
    })
    expect(f.service.create.mock.calls[1]?.[0]).toMatchObject({ workspaceId: 'ws-ttds' })

    expect(await f.call('dsh_create_session', { workspace: '不存在的工作区' })).toMatchObject({
      ok: false, error: { code: 'workspace_not_found' },
    })
  })

  it('supports explicit queue mode and flushQueued steering conversion in dsh_send_session_prompt', async () => {
    const f = setup()
    expect(await f.call('dsh_send_session_prompt', { sessionId: 's1', prompt: '排队这条', mode: 'queue' })).toMatchObject({
      ok: true, data: { sessionId: 's1', mode: 'queue' },
    })
    expect(f.service.prompt).toHaveBeenCalledWith(expect.objectContaining({ mode: 'queue' }), expect.any(AbortSignal))

    expect(await f.call('dsh_send_session_prompt', { sessionId: 's1', flushQueued: true })).toMatchObject({
      ok: true, data: { sessionId: 's1', mode: 'steer', steeredQueuedCount: 1 },
    })
    expect(f.service.updateQueue).toHaveBeenCalledWith({
      sessionId: 's1',
      itemId: 'q-1',
      action: { kind: 'steer' },
    })
  })

  it('resolves live approval/request waterfalls through VoiceApprovalHostBridge and yields when disposed', async () => {
    const f = setup()
    new SessionStore(f.ctx)
    new VoiceApprovalHostBridge(f.ctx)
    const session = f.ctx.sessions.create(SessionId('s-approve'))
    const askedEvent: { type: string; data: Record<string, unknown> } = {
      type: 'approval/asked',
      data: { id: 'req-real-1', toolName: 'pwsh', callId: 'call-pwsh-1', reason: 'escalate sandbox to danger-full-access: desktop probe' },
    }
    ;(session as { append(t: string, d: Record<string, unknown>): void }).append(askedEvent.type, askedEvent.data)

    const waterfallPromise = f.ctx.waterfall(
      'approval/request',
      { agent: { id: session.id, session }, toolName: 'pwsh', callId: 'call-pwsh-1', reason: 'escalate' } as never,
      () => Promise.resolve('unavailable' as const),
    )
    const listed = await f.call('dsh_list_pending_approvals')
    expect(listed).toMatchObject({
      ok: true,
      data: { approvals: [{ sessionId: 's-approve', approvalId: 'req-real-1', toolName: 'pwsh' }] },
    })

    const callId = f.dispatch({ sessionId: 's-approve', approvalId: 'req-real-1', approved: true }, 'dsh_resolve_tool_approval')
    await vi.waitFor(() => { expect(f.state.pending).toHaveLength(1) })
    const card = f.state.pending[0]
    if (!card) throw new Error('Expected UI confirmation card for dsh_resolve_tool_approval')
    await f.registry.resolveUiConfirmation(card.confirmationId, true)

    await expect(waterfallPromise).resolves.toBe('allowed-once')
    await vi.waitFor(() => { expect(f.state.results.some(item => item.callId === callId)).toBe(true) })
    expect(f.state.results.find(item => item.callId === callId)?.result).toMatchObject({
      ok: true, data: { sessionId: 's-approve', approvalId: 'req-real-1', approved: true, outcome: 'allowed-once' },
    })

    let settleDownstream: (outcome: 'rejected') => void = () => {}
    const downstreamPromise = new Promise<'rejected'>((resolve) => {
      settleDownstream = resolve
    })
    const disposeYieldPromise = f.ctx.waterfall(
      'approval/request',
      { agent: { id: session.id, session }, toolName: 'pwsh', callId: 'call-pwsh-2', reason: 'escalate' } as never,
      () => downstreamPromise,
    )
    const listedBeforeDispose = await f.call('dsh_list_pending_approvals')
    expect(listedBeforeDispose).toMatchObject({
      ok: true,
      data: { approvals: [{ sessionId: 's-approve', toolName: 'pwsh' }] },
    })

    await f.ctx.fiber.dispose()
    settleDownstream('rejected')
    await expect(disposeYieldPromise).resolves.toBe('rejected')
  })

  it('releases the self-action guard when the underlying mutation rejects', async () => {
    const f = setup()
    f.service.prompt.mockRejectedValueOnce(new Error('Session missing'))
    expect(await f.call('dsh_send_session_prompt', { sessionId: 'missing', prompt: '继续' })).toMatchObject({
      ok: false, error: { code: 'tool_failed' },
    })
    expect(f.selfActionReleases[0]).toHaveBeenCalledTimes(1)
  })
})

describe('dsh_search', () => {
  it('uses the real Web service and forwards the tool signal to its selected provider', async () => {
    const f = setup()
    await f.ctx.plugin(WebRuntime, {})
    const search = vi.fn(() => Promise.resolve({
      content: '搜索摘要',
      sources: [{ title: '来源', url: 'https://example.com', snippet: '结果'.repeat(1000) }],
      truncated: false,
    }))
    f.ctx.web.registerSearchProvider({ id: 'test', available: () => true, search })
    const result = await f.call('dsh_search', { query: 'DSH', maxResults: 2 })
    expect(search).toHaveBeenCalledWith({ query: 'DSH', maxResults: 2 }, expect.any(AbortSignal))
    expect(result).toMatchObject({
      ok: true, data: { summary: '搜索摘要', sources: [{ title: '来源', url: 'https://example.com' }], untrustedExternalContent: true },
    })
    expect(JSON.stringify(result).length).toBeLessThan(700)
  })

  it('reports missing service and missing search provider distinctly', async () => {
    const f = setup()
    expect(await f.call('dsh_search', { query: 'DSH' })).toMatchObject({
      ok: false, error: { code: 'web_search_unavailable' },
    })
    await f.ctx.plugin(WebRuntime, {})
    expect(await f.call('dsh_search', { query: 'DSH' })).toMatchObject({
      ok: false, error: { code: 'WEB_PROVIDER_UNAVAILABLE' },
    })
  })

  it('hides disabled read/search tools and rejects stale direct calls', async () => {
    const f = setup()
    f.state.config = resolveTtdsConfig({ tools: { enableReadTools: false, enableSearchTool: false } }, {})
    expect(f.registry.listUpstreamSpecs()).toHaveLength(5)
    expect(await f.call('dsh_search', { query: 'DSH' })).toMatchObject({ ok: false, error: { code: 'tool_disabled' } })
    expect(await f.call('dsh_list_sessions')).toMatchObject({ ok: false, error: { code: 'tool_disabled' } })
  })
})
