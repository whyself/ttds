import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DEFAULT_VOICE_SYSTEM_INSTRUCTIONS,
  resolveTtdsConfig,
  type ServerRealtimeFrame,
  type TtdsConfig,
  type VoiceAdapterEvent,
  type VoiceAdapterSession,
  type VoiceAdapterSessionConfig,
} from '../../src/shared/index.ts'
import { QwenRealtimeAdapter, SupervisorSessionJournal, VoiceRuntimeService } from '../../src/runtime/index.ts'
import { VoiceToolRegistry } from '../../src/tools/index.ts'

interface WireMessage {
  type: string
  session?: Record<string, unknown>
  item?: Record<string, unknown>
  audio?: string
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(import.meta.dirname, 'fixture-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function upstream() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('Missing upstream port')
  const messages: WireMessage[] = []
  const sockets: WebSocket[] = []
  const requests: { url: string | undefined; headers: Record<string, string | string[] | undefined> }[] = []
  let acknowledgeUpdates = true
  server.on('connection', (socket, request) => {
    sockets.push(socket)
    requests.push({ url: request.url, headers: request.headers })
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      const message = JSON.parse(bytes.toString('utf8')) as WireMessage
      messages.push(message)
      if (message.type === 'session.update' && acknowledgeUpdates) socket.send(JSON.stringify({ type: 'session.updated' }))
    })
  })
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => {
      if (error) reject(error)
      else resolve()
    }) })
  })
  return {
    url: `ws://127.0.0.1:${address.port}`,
    server,
    messages,
    sockets,
    requests,
    delayUpdates: () => { acknowledgeUpdates = false },
    send: (event: object, index = sockets.length - 1) => {
      const socket = sockets[index]
      if (!socket) throw new Error('Missing upstream socket')
      socket.send(JSON.stringify(event))
    },
  }
}

function spec(): VoiceAdapterSessionConfig {
  return {
    instructions: '请自然交谈',
    voice: 'longanqian_v3.1',
    turnDetection: 'smart_turn_v2',
    threshold: 0.5,
    silenceDurationMs: 800,
    maxHistoryTurns: 10,
    tools: [],
  }
}

async function connected() {
  const cloud = await upstream()
  const config = resolveTtdsConfig({ providers: { 'qwen-realtime': {
    apiKey: 'sk-test-private', workspaceId: 'test-workspace', baseUrl: cloud.url,
  } } }, {})
  const session = await new QwenRealtimeAdapter().connect(config, spec(), new AbortController().signal)
  cleanups.push(() => session.close())
  return { cloud, session, config }
}

async function runtimeFixture(extra: TtdsConfig = {}) {
  const cloud = await upstream()
  const storageDir = await directory()
  const ctx = new Context()
  const config: TtdsConfig = {
    ...extra,
    storageDir,
    providers: { 'qwen-realtime': {
      apiKey: 'sk-runtime-private', baseUrl: cloud.url, workspaceId: 'runtime-workspace',
    } },
  }
  const runtime = new VoiceRuntimeService(ctx, config)
  cleanups.push(() => ctx.fiber.dispose())
  const frames: ServerRealtimeFrame[] = []
  runtime.subscribeFrames(frame => frames.push(frame))
  return { cloud, storageDir, ctx, config, runtime, frames }
}

describe('SupervisorSessionJournal', () => {
  it('persists ordered records and removes credentials and raw audio recursively', async () => {
    const storageDir = await directory()
    const journal = new SupervisorSessionJournal(storageDir, 'journal_test', ['private-key'])
    await Promise.all([
      journal.append('session.started', { instructions: 'private-key sk-other-secret Bearer abcDEF' }),
      journal.append('tool.output', { nested: { apiKey: 'private-key', audioBase64: 'AAAA', pcm: [0, 1] }, result: 'ok' }),
      journal.append('user.text', { text: '你好' }),
    ])
    await journal.flush()
    const records = await SupervisorSessionJournal.readRecords(storageDir, 'journal_test')
    expect(records.map(record => record.seq)).toEqual([1, 2, 3])
    expect(records[2]?.payload).toEqual({ text: '你好' })
    const raw = await readFile(join(storageDir, 'journal_test.jsonl'), 'utf8')
    expect(raw).not.toContain('private-key')
    expect(raw).not.toContain('sk-other-secret')
    expect(raw).not.toContain('abcDEF')
    expect(raw).not.toContain('AAAA')
    expect(raw).not.toContain('[0,1]')
    expect(await SupervisorSessionJournal.readRecords(storageDir, 'absent')).toEqual([])
  })

  it('rejects path traversal before creating a journal', async () => {
    const storageDir = await directory()
    expect(() => new SupervisorSessionJournal(storageDir, '../escape')).toThrow('identifier')
    await expect(SupervisorSessionJournal.readRecords(storageDir, '../escape')).rejects.toThrow('identifier')
  })

  it('reads recent historical journals in chronological order while skipping excluded or corrupt files', async () => {
    const missing = await SupervisorSessionJournal.readRecentHistory(join(await directory(), 'absent'))
    expect(missing).toEqual([])

    const storageDir = await directory()
    const j1 = new SupervisorSessionJournal(storageDir, 'session_old')
    await j1.append('user.text', { text: '第一轮旧问题' })
    const j2 = new SupervisorSessionJournal(storageDir, 'session_newer')
    await j2.append('user.text', { text: '第二轮问题' })
    await j2.append('assistant.transcript', { text: '第二轮回答' })
    const jCurrent = new SupervisorSessionJournal(storageDir, 'session_current')
    await jCurrent.append('user.text', { text: '不应重复读取自己' })
    await writeFile(join(storageDir, 'corrupt_file.jsonl'), '{"broken":true\n', 'utf8')

    const records = await SupervisorSessionJournal.readRecentHistory(storageDir, { excludeSessionId: 'session_current' })
    expect(records.map(r => r.supervisorSessionId)).toEqual(['session_old', 'session_newer', 'session_newer'])
    expect(records.map(r => r.payload.text)).toEqual(['第一轮旧问题', '第二轮问题', '第二轮回答'])
  })
})

describe('QwenRealtimeAdapter', () => {
  it('authenticates the handshake and waits for session.updated with native search disabled', async () => {
    const { cloud } = await connected()
    expect(cloud.requests[0]?.url).toBe('/?model=qwen-audio-3.1-realtime-flash')
    expect(cloud.requests[0]?.headers.authorization).toBe('Bearer sk-test-private')
    expect(cloud.requests[0]?.headers['x-dashscope-workspace']).toBe('test-workspace')
    expect(cloud.messages[0]?.session).toMatchObject({
      modalities: ['text', 'audio'],
      voice: 'longanqian_v3.1',
      enable_search: false,
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      input_audio_transcription: { language: 'zh' },
      turn_detection: { type: 'smart_turn_v2', threshold: 0.5 },
      max_history_turns: 10,
    })
  })

  it.each([
    ['push_to_talk', null],
    ['server_vad', { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 }],
    ['smart_turn', { type: 'smart_turn', threshold: 0.5 }],
  ] as const)('encodes %s turn detection', async (turnDetection, expected) => {
    const { cloud, session } = await connected()
    await session.updateSession({ ...spec(), turnDetection })
    expect(cloud.messages.at(-1)?.session?.turn_detection).toEqual(expected)
  })

  it('sends audio, committed turns, text, notifications, and explicit response commands', async () => {
    const { cloud, session } = await connected()
    await session.appendAudio('AAAA')
    await session.commitAudio()
    await session.sendUserText('一加一')
    await session.sendContextNotification('任务已完成', false)
    await session.sendContextNotification('请播报', true)
    await session.cancelResponse()
    await vi.waitFor(() => { expect(cloud.messages).toHaveLength(10) })
    expect(cloud.messages.map(message => message.type)).toEqual([
      'session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create',
      'conversation.item.create', 'response.create', 'conversation.item.create', 'conversation.item.create',
      'response.create', 'response.cancel',
    ])
    expect(cloud.messages[6]?.item?.role).toBe('system')
    expect(cloud.messages[7]?.item?.role).toBe('user')
    const hookContent = (cloud.messages[7]?.item?.content as { text?: string }[] | undefined)?.[0]?.text ?? ''
    expect(hookContent).toContain('【后台事件提醒】')
    expect(hookContent).toContain('请播报')
  })

  it('waits for conversation.item.created ack before response.create when sending context notifications', async () => {
    const { cloud, session } = await connected()
    let completed = false
    const pending = session.sendContextNotification('后台会话请求审批', true).then(() => { completed = true })
    await vi.waitFor(() => { expect(cloud.messages.some(m => m.type === 'conversation.item.create')).toBe(true) })
    expect(cloud.messages.some(m => m.type === 'response.create')).toBe(false)
    const msg = cloud.messages.find(m => m.type === 'conversation.item.create')
    cloud.send({ type: 'conversation.item.created', item: { id: 'ctx_item_1', type: 'message', role: msg?.item?.role } })
    await pending
    expect(completed).toBe(true)
    await vi.waitFor(() => { expect(cloud.messages.some(m => m.type === 'response.create')).toBe(true) })
  })

  it('requires matching call acknowledgement before resolving tool output, without requesting speech', async () => {
    const { cloud, session } = await connected()
    let acknowledged = false
    const completion = session.submitToolOutput('call_1', '{"ok":true}').then(() => { acknowledged = true })
    await vi.waitFor(() => { expect(cloud.messages.at(-1)?.item?.type).toBe('function_call_output') })
    const item = cloud.messages.at(-1)?.item
    cloud.send({ type: 'conversation.item.created', item: { id: 'item_other', ...item, call_id: 'another_call' } })
    await setImmediate()
    expect(acknowledged).toBe(false)
    cloud.send({ type: 'conversation.item.created', item: { id: 'item_server_assigned', ...item } })
    await completion
    expect(acknowledged).toBe(true)
    expect(cloud.messages.some(message => message.type === 'response.create')).toBe(false)
  })

  it('maps transcripts, speech, audio, response tools, upstream errors, and closes', async () => {
    const { cloud, session } = await connected()
    const events: VoiceAdapterEvent[] = []
    session.onEvent(event => events.push(event))
    cloud.send({ type: 'session.created', session: { id: 'upstream_1' } })
    cloud.send({ type: 'input_audio_buffer.speech_started', item_id: 'speech_1' })
    cloud.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'speech_1', text: '你', stash: '好呀' })
    cloud.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'speech_1' })
    cloud.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech_1', transcript: '你好' })
    cloud.send({ type: 'response.created', response: { id: 'response_1' } })
    cloud.send({ type: 'response.audio.delta', response_id: 'response_1', delta: 'AAAA' })
    cloud.send({ type: 'response.audio_transcript.delta', response_id: 'response_1', delta: '好的' })
    cloud.send({ type: 'response.audio_transcript.done', response_id: 'response_1', transcript: '好的' })
    cloud.send({ type: 'response.done', response: {
      id: 'response_1', status: 'completed', output: [
        { type: 'function_call', id: 'item_tool', call_id: 'call_1', name: 'dsh_list_sessions', arguments: '{}' },
      ],
    } })
    cloud.send({ type: 'error', error: { code: 'invalid', message: 'sk-test-private failed' } })
    await vi.waitFor(() => { expect(events).toHaveLength(11) })
    expect(events[2]).toEqual({ type: 'input.transcript', itemId: 'speech_1', transcript: '你好呀', final: false })
    expect(events[9]).toEqual({
      type: 'response.done', responseId: 'response_1', status: 'completed', transcript: '', toolCalls: [
        { itemId: 'item_tool', callId: 'call_1', name: 'dsh_list_sessions', argumentsJson: '{}' },
      ],
    })
    expect(JSON.stringify(events)).not.toContain('sk-test-private')
    await session.close()
    expect(events.at(-1)?.type).toBe('closed')
    await vi.waitFor(() => { expect(cloud.server.clients.size).toBe(0) })
  })

  it('merges streamed function_call_arguments and output_item.done even when response.done omits them', async () => {
    const { cloud, session } = await connected()
    const events: VoiceAdapterEvent[] = []
    session.onEvent(event => events.push(event))
    cloud.send({ type: 'response.created', response: { id: 'resp_stream_tc' } })
    cloud.send({
      type: 'response.output_item.added',
      item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_stream_1', name: 'dsh_search', arguments: '' },
    })
    cloud.send({ type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: '{"query":' })
    cloud.send({ type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: '"黄仁勋"}' })
    cloud.send({
      type: 'response.done',
      response: { id: 'resp_stream_tc', status: 'completed', output: [] },
    })
    await vi.waitFor(() => { expect(events.some(e => e.type === 'response.done')).toBe(true) })
    const done = events.find(e => e.type === 'response.done')
    expect(done).toMatchObject({
      type: 'response.done',
      toolCalls: [{ itemId: 'fc_item_1', callId: 'call_stream_1', name: 'dsh_search', argumentsJson: '{"query":"黄仁勋"}' }],
    })
  })

  it('rejects pending acknowledgements on upstream error, abort, timeout, and socket shutdown', async () => {
    const { cloud, session } = await connected()
    cloud.delayUpdates()
    const errorUpdate = session.updateSession(spec())
    const rejected = expect(errorUpdate).rejects.toThrow('rejected')
    await vi.waitFor(() => { expect(cloud.messages).toHaveLength(2) })
    cloud.send({ type: 'error', error: { message: 'rejected' } })
    await rejected
    const controller = new AbortController()
    const aborted = session.submitToolOutput('call_abort', '{}', controller.signal)
    const abortedAssertion = expect(aborted).rejects.toThrow('aborted')
    controller.abort()
    await abortedAssertion
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timedOut = session.submitToolOutput('call_timeout', '{}')
    const timeoutAssertion = expect(timedOut).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await timeoutAssertion
    vi.useRealTimers()
    const pending = session.submitToolOutput('call_close', '{}')
    const closeAssertion = expect(pending).rejects.toThrow('closing')
    await session.close()
    await closeAssertion
  })
})

describe('VoiceRuntimeService', () => {
  it('merges persona instructions, admits text, and persists user and assistant facts', async () => {
    const { cloud, runtime, frames } = await runtimeFixture({ voice: { customInstructions: '回答要简短' } })
    const result = await runtime.sendTextUtterance('你好', { autoStart: true })
    expect(result).toEqual({ accepted: true, inputAdmissionSeq: 1 })
    expect(cloud.messages[0]?.session?.instructions).toContain(DEFAULT_VOICE_SYSTEM_INSTRUCTIONS)
    expect(cloud.messages[0]?.session?.instructions).toContain('回答要简短')
    expect(cloud.messages[0]?.session?.enable_search).toBe(false)
    cloud.send({ type: 'response.created', response: { id: 'answer' } })
    cloud.send({ type: 'response.audio_transcript.done', response_id: 'answer', transcript: '你好呀' })
    cloud.send({ type: 'response.done', response: { id: 'answer', status: 'completed', output: [] } })
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'transcript' && frame.text === '你好呀')).toBe(true) })
    const id = runtime.getSnapshot().supervisorSessionId
    expect(id).toBeTypeOf('string')
    const records = await runtime.readJournal(id!)
    expect(records.map(record => record.kind)).toEqual(['session.started', 'user.text', 'assistant.transcript'])
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain('sk-runtime-private')
  })

  it('streams audio, advances input and monotonic playback cursors, and clears barge-in playback', async () => {
    const { cloud, runtime, frames } = await runtimeFixture()
    await runtime.startSession()
    runtime.setAudioClientCount(1)
    await runtime.handleClientFrame({ type: 'audio.append', audioBase64: 'AAAA' }, true)
    await vi.waitFor(() => { expect(cloud.messages.at(-1)?.type).toBe('input_audio_buffer.append') })
    cloud.send({ type: 'input_audio_buffer.speech_started', item_id: 'input_1' })
    cloud.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'input_1' })
    cloud.send({ type: 'response.audio.delta', response_id: 'audio_1', delta: 'AAAB' })
    cloud.send({ type: 'response.audio.delta', response_id: 'audio_1', delta: 'AAAC' })
    cloud.send({ type: 'response.done', response: { id: 'audio_1', status: 'completed', output: [] } })
    await vi.waitFor(() => { expect(runtime.getPlaybackCursors().emittedAudioSeq).toBe(2) })
    expect(runtime.getPlaybackCursors().inputAdmissionSeq).toBe(1)
    expect(frames).toContainEqual({ type: 'audio.clear', reason: 'barge_in' })
    expect(frames.filter(frame => frame.type === 'audio.delta').map(frame => frame.audioSeq)).toEqual([1, 2])
    await runtime.handleClientFrame({ type: 'playback.drained', playbackSeq: 1 }, true)
    await runtime.handleClientFrame({ type: 'playback.drained', playbackSeq: 0 }, true)
    expect(runtime.getPlaybackCursors().drainedAudioSeq).toBe(1)
    await runtime.handleClientFrame({ type: 'playback.drained', playbackSeq: 999 }, false)
    expect(runtime.getPlaybackCursors().drainedAudioSeq).toBe(1)
    await runtime.handleClientFrame({ type: 'playback.drained', playbackSeq: 2 }, true)
    expect(runtime.getPlaybackCursors().drainedAudioSeq).toBe(2)
  })

  it('keeps idle wakeups available during streaming background audio and aligns empty deltas and barge-in drains', async () => {
    const { cloud, runtime } = await runtimeFixture()
    await runtime.startSession()
    runtime.setAudioClientCount(1)
    await runtime.handleClientFrame({ type: 'audio.append', audioBase64: 'AAAA' }, true)
    expect(await runtime.requestSpokenTurn()).toBe(true)
    cloud.send({ type: 'response.created', response: { id: 'empty_audio' } })
    cloud.send({ type: 'response.audio.delta', response_id: 'empty_audio', delta: '' })
    cloud.send({ type: 'response.done', response: { id: 'empty_audio', status: 'completed', output: [] } })
    await vi.waitFor(() => { expect(runtime.getSnapshot().phase).toBe('listening') })
    expect(runtime.getPlaybackCursors().emittedAudioSeq).toBe(0)

    cloud.send({ type: 'response.audio.delta', response_id: 'spoken_1', delta: 'AAAB' })
    await vi.waitFor(() => { expect(runtime.getPlaybackCursors().emittedAudioSeq).toBe(1) })
    cloud.send({ type: 'input_audio_buffer.speech_started', item_id: 'interrupt_1' })
    await vi.waitFor(() => { expect(runtime.getPlaybackCursors().drainedAudioSeq).toBe(1) })
  })

  it('journals tools and waits for real upstream backfill confirmation while admitting another user turn', async () => {
    const { cloud, runtime } = await runtimeFixture()
    await runtime.startSession()
    cloud.send({ type: 'response.done', response: {
      id: 'tool_response', status: 'completed', output: [
        { type: 'function_call', id: 'tool_item', call_id: 'tool_call', name: 'dsh_list_sessions', arguments: '{}' },
      ],
    } })
    await vi.waitFor(() => { expect(runtime.getSnapshot().pendingToolCount).toBe(1) })
    expect((await runtime.sendTextUtterance('先算一加一')).accepted).toBe(true)
    let settled = false
    const output = runtime.submitToolResult('tool_call', 'dsh_list_sessions', { sessions: [] }).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => { expect(cloud.messages.at(-1)?.item?.type).toBe('function_call_output') })
    expect(settled).toBe(false)
    cloud.send({ type: 'conversation.item.created', item: cloud.messages.at(-1)?.item })
    expect(await output).toBe(true)
    expect(runtime.getSnapshot().pendingToolCount).toBe(0)
    const records = await runtime.readJournal(runtime.getSnapshot().supervisorSessionId!)
    expect(records.map(record => record.kind)).toContain('tool.call')
    expect(records.map(record => record.kind)).toContain('tool.output')
  })

  it('dispatches model tool calls through the real registry and backfills its result', async () => {
    const { cloud, runtime, ctx } = await runtimeFixture()
    const tools = new VoiceToolRegistry(ctx)
    let executionCount = 0
    tools.register({
      name: 'dsh_fixture_read',
      description: '读取本地验收数据',
      parameters: { type: 'object', properties: {} },
      category: 'read',
      resolveConfirmation: () => 'auto',
      execute: async () => {
        ++executionCount
        return { ok: true, data: { value: 42 } }
      },
    })
    await runtime.startSession()
    cloud.send({ type: 'response.done', response: {
      id: 'registry_response', status: 'completed', output: [
        { type: 'function_call', id: 'registry_item', call_id: 'registry_call', name: 'dsh_fixture_read', arguments: '{}' },
      ],
    } })
    await vi.waitFor(() => {
      expect(cloud.messages.some(message => message.item?.type === 'function_call_output')).toBe(true)
    })
    expect(executionCount).toBe(1)
    const item = cloud.messages.find(message => message.item?.type === 'function_call_output')?.item
    expect(JSON.parse(String(item?.output))).toEqual({ ok: true, data: { value: 42 } })
    cloud.send({ type: 'conversation.item.created', item })
    await vi.waitFor(() => { expect(runtime.getSnapshot().pendingToolCount).toBe(0) })
  })

  it('rotates through an isolated candidate only on connection-level changes and applies local or session updates in place', async () => {
    const { cloud, runtime, config } = await runtimeFixture()
    await runtime.startSession()
    await runtime.sendTextUtterance('记住核验码 123')
    const initial = runtime.getSnapshot()

    await runtime.updateConfig({ ...config, tools: { writeConfirmation: 'auto' } })
    expect(runtime.getSnapshot().connectionEpoch).toBe(initial.connectionEpoch)
    expect(cloud.sockets).toHaveLength(1)
    expect(cloud.messages.filter(message => message.type === 'session.update')).toHaveLength(1)

    await runtime.updateConfig({ ...config, tools: { writeConfirmation: 'auto' }, voice: { customInstructions: '轻声回答' } })
    expect(runtime.getSnapshot().connectionEpoch).toBe(initial.connectionEpoch)
    expect(cloud.sockets).toHaveLength(1)
    await vi.waitFor(() => {
      expect(cloud.messages.filter(message => message.type === 'session.update')).toHaveLength(2)
    })

    await runtime.updateConfig({
      ...config,
      providers: { 'qwen-realtime': { ...config.providers!['qwen-realtime'], model: 'qwen-audio-3.1-realtime-plus' } },
      tools: { writeConfirmation: 'auto' },
      voice: { customInstructions: '轻声回答' },
    })
    expect(runtime.getSnapshot().connectionEpoch).toBeGreaterThan(initial.connectionEpoch)
    expect(runtime.getSnapshot().supervisorSessionId).toBe(initial.supervisorSessionId)
    expect(cloud.sockets).toHaveLength(2)
    await vi.waitFor(() => { expect(cloud.messages.some(message => message.item?.role === 'system')).toBe(true) })
    expect(JSON.stringify(cloud.messages)).toContain('记住核验码 123')
    await vi.waitFor(() => { expect(cloud.sockets[0]?.readyState).toBe(WebSocket.CLOSED) })
    expect((await runtime.readJournal(initial.supervisorSessionId!)).at(-1)?.kind).toBe('session.rotated')
  })

  it.each(['text', 'speech'] as const)('silently abandons a candidate without crashing if %s turn arrives during rotation', async (kind) => {
    const { cloud, runtime, config } = await runtimeFixture()
    await runtime.startSession()
    const epoch = runtime.getSnapshot().connectionEpoch
    cloud.delayUpdates()
    const rotation = runtime.updateConfig({
      ...config,
      providers: { 'qwen-realtime': { ...config.providers!['qwen-realtime'], model: 'qwen-audio-3.1-realtime-plus' } },
    })
    await vi.waitFor(() => { expect(cloud.sockets).toHaveLength(2) })
    if (kind === 'text') await runtime.sendTextUtterance('新问题')
    else cloud.send({ type: 'input_audio_buffer.speech_started', item_id: 'speech_during_rotate' }, 0)
    cloud.send({ type: 'session.updated' })
    await expect(rotation).resolves.toBeUndefined()
    expect(runtime.getSnapshot().connectionEpoch).toBe(epoch)
    expect(cloud.sockets[0]?.readyState).toBe(WebSocket.OPEN)
    await vi.waitFor(() => { expect(cloud.sockets[1]?.readyState).toBe(WebSocket.CLOSED) })
  })

  it('does not promote a stale asynchronous start after stop', async () => {
    const { cloud, runtime } = await runtimeFixture()
    cloud.delayUpdates()
    const pending = runtime.startSession()
    const assertion = expect(pending).rejects.toThrow('aborted')
    await vi.waitFor(() => { expect(cloud.messages[0]?.type).toBe('session.update') })
    await runtime.stopSession()
    await assertion
    expect(runtime.getSnapshot().supervisorSessionId).toBeNull()
    expect(runtime.getSnapshot().phase).toBe('idle')
    expect(cloud.server.clients.size).toBe(0)
  })

  it('ignores already queued callbacks belonging to a retired connection', async () => {
    const storageDir = await directory()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const runtime = new VoiceRuntimeService(ctx, { provider: 'fixture', storageDir })
    const callbacks: ((event: VoiceAdapterEvent) => void)[] = []
    runtime.registerAdapter({
      id: 'fixture',
      checkReadiness: () => ({ ready: true, reason: null }),
      connect: async () => ({
        updateSession: async () => {},
        appendAudio: async () => {},
        commitAudio: async () => {},
        sendUserText: async () => {},
        sendContextNotification: async () => {},
        submitToolOutput: async () => {},
        requestResponse: async () => {},
        cancelResponse: async () => {},
        onEvent: (listener) => {
          callbacks.push(listener)
          return () => {}
        },
        close: async () => {},
      }),
    })
    await runtime.startSession()
    await runtime.updateConfig({ provider: 'fixture', storageDir, providers: { 'qwen-realtime': { voice: 'chelsie_v3.1' } } })
    const current = runtime.getSnapshot()
    const cursors = runtime.getPlaybackCursors()
    callbacks[0]?.({ type: 'speech.started', itemId: 'retired_input' })
    callbacks[0]?.({ type: 'response.audio.delta', responseId: 'retired_response', pcm24kBase64: 'AAAA' })
    callbacks[0]?.({ type: 'closed', code: 1000, reason: 'retired' })
    await setImmediate()
    expect(runtime.getSnapshot()).toEqual(current)
    expect(runtime.getPlaybackCursors()).toEqual(cursors)
    callbacks[1]?.({ type: 'speech.started', itemId: 'current_input' })
    await vi.waitFor(() => { expect(runtime.getPlaybackCursors().inputAdmissionSeq).toBe(1) })
  })

  it('drains consumer cleanup before closing upstream sockets and rejects new leases', async () => {
    const { cloud, runtime, ctx } = await runtimeFixture()
    await runtime.startSession()
    const id = runtime.getSnapshot().supervisorSessionId!
    const lease = runtime.acquireLease()!
    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(lease.signal.aborted).toBe(true) })
    expect(runtime.acquireLease()).toBeNull()
    expect(disposed).toBe(false)
    expect(cloud.sockets[0]?.readyState).toBe(WebSocket.OPEN)
    await runtime.appendJournal('tool.output', { cleanup: true })
    lease.release()
    await disposing
    expect(cloud.server.clients.size).toBe(0)
    expect(ctx.get('ttdsRuntime')).toBeUndefined()
    const records = await SupervisorSessionJournal.readRecords(runtime.getConfig().storageDir, id)
    expect(records.at(-2)?.payload).toEqual({ cleanup: true })
    expect(records.at(-1)?.kind).toBe('session.ended')
  })

  it('rejects duplicate adapters and removes a custom adapter on explicit release', async () => {
    const { runtime } = await runtimeFixture()
    expect(() => runtime.registerAdapter(new QwenRealtimeAdapter())).toThrow('duplicate')
    const adapter = {
      id: 'test-provider',
      checkReadiness: () => ({ ready: true, reason: null }),
      connect: (): Promise<VoiceAdapterSession> => Promise.reject(new Error('unused')),
    }
    const remove = runtime.registerAdapter(adapter)
    expect(() => runtime.registerAdapter(adapter)).toThrow('duplicate')
    remove()
    await setImmediate()
    expect(() => runtime.registerAdapter(adapter)).not.toThrow()
  })

  it('requests a fallback response when smart_turn emits final transcript without response.created, and survives non-fatal upstream errors', async () => {
    const { cloud, runtime, frames } = await runtimeFixture()
    await runtime.startSession()
    cloud.send({ type: 'input_audio_buffer.speech_started', item_id: 'turn_1' })
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: 'transcript', role: 'user', text: '', final: false, itemId: 'turn_1' })
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cloud.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'turn_1' })
    cloud.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn_1', transcript: '人生呐，能不能放过这一次？' })
    await vi.waitFor(() => { expect(frames.some(f => f.type === 'transcript' && f.final && f.itemId === 'turn_1')).toBe(true) })
    await vi.advanceTimersByTimeAsync(850)
    await vi.waitFor(() => { expect(cloud.messages.some(m => m.type === 'response.create')).toBe(true) })
    vi.useRealTimers()

    cloud.send({ type: 'error', error: { code: 'asr_warn', message: '短音频转写失败' } })
    await vi.waitFor(() => {
      expect(frames.some(f => f.type === 'feed.item' && f.item.kind === 'diagnostic' && f.item.text === '短音频转写失败')).toBe(true)
    })
    expect(runtime.getSnapshot().phase).toBe('listening')
    expect(runtime.getSnapshot().supervisorSessionId).not.toBeNull()
  })

  it('nudges the upstream model when it verbally promises a tool action without emitting any function_call', async () => {
    const { cloud, runtime, ctx } = await runtimeFixture()
    const tools = new VoiceToolRegistry(ctx)
    tools.register({
      name: 'dsh_create_session',
      description: '创建新会话',
      parameters: { type: 'object', properties: {} },
      category: 'read',
      resolveConfirmation: () => 'auto',
      execute: () => Promise.resolve({ ok: true }),
    })
    await runtime.startSession()
    cloud.send({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
    cloud.send({ type: 'input_audio_buffer.committed', item_id: 'u1' })
    cloud.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' })
    cloud.send({ type: 'response.created', response: { id: 'resp_promise' } })
    cloud.send({
      type: 'response.done',
      response: {
        id: 'resp_promise',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'audio', transcript: '对，我这就开个新会话去查。' }] }],
      },
    })
    await vi.waitFor(() => {
      expect(cloud.messages.some(m => m.type === 'conversation.item.create' && m.item?.role === 'user'
        && JSON.stringify(m.item.content).includes('未发出任何 function_call 工具调用'))).toBe(true)
    }, { timeout: 3000 })
  })

  it('restores bounded prior conversation history into a newly opened session after closure without nesting or speaking unprompted', async () => {
    const { cloud, storageDir, runtime } = await runtimeFixture()
    await runtime.startSession()
    await runtime.sendTextUtterance('查一下 Sophon-Realtime 在 Colab 的运行方案，我是 Ultra 5X')
    cloud.send({ type: 'response.created', response: { id: 'r1' } })
    cloud.send({ type: 'response.audio_transcript.done', response_id: 'r1', transcript: '我已创建后台调查会话。' })
    cloud.send({
      type: 'response.done',
      response: {
        id: 'r1',
        status: 'completed',
        output: [{
          type: 'function_call',
          id: 'fc_hist',
          call_id: 'call_hist_1',
          name: 'dsh_create_session',
          arguments: '{"prompt":"Ultra 5X 测算 1000 积分"}',
        }],
      },
    })
    await vi.waitFor(() => { expect(runtime.getSnapshot().pendingToolCount).toBe(1) })
    const backfill = runtime.submitToolResult('call_hist_1', 'dsh_create_session', {
      ok: true,
      data: { sessionId: 'ttds-sophon-1', workspaceTitle: '默认工作区' },
    })
    await vi.waitFor(() => { expect(cloud.messages.at(-1)?.item?.type).toBe('function_call_output') })
    cloud.send({ type: 'conversation.item.created', item: cloud.messages.at(-1)?.item })
    await backfill

    cloud.sockets[0]?.close(1000, 'response_idle_timeout')
    await vi.waitFor(() => { expect(runtime.getSnapshot().phase).toBe('idle') })

    const beforeSecondCount = cloud.messages.length
    await runtime.startSession()
    await vi.waitFor(() => {
      expect(cloud.messages.slice(beforeSecondCount).some(m => m.type === 'conversation.item.create' && m.item?.role === 'system')).toBe(true)
    })
    await setImmediate()
    const secondMessages = cloud.messages.slice(beforeSecondCount)
    const restoredItem = secondMessages.find(m => m.type === 'conversation.item.create' && m.item?.role === 'system')
    expect(restoredItem).toBeDefined()
    const restoredText = ((restoredItem?.item?.content as { text?: string }[] | undefined)?.[0]?.text) ?? ''
    expect(restoredText).toContain('【历史对话恢复】')
    expect(restoredText).toContain('Ultra 5X')
    expect(restoredText).toContain('ttds-sophon-1')
    expect(secondMessages.some(m => m.type === 'response.create')).toBe(false)

    const secondId = runtime.getSnapshot().supervisorSessionId!
    const secondJournal = await runtime.readJournal(secondId)
    expect(secondJournal.some(r => r.kind === 'hook.injected' && r.payload.kind === 'history_restored')).toBe(true)

    await runtime.sendTextUtterance('再看一眼刚才那个会话进度')
    await runtime.stopSession('user')

    const freshCtx = new Context()
    cleanups.push(() => freshCtx.fiber.dispose())
    const restartedRuntime = new VoiceRuntimeService(freshCtx, {
      storageDir,
      providers: { 'qwen-realtime': { apiKey: 'sk-runtime-private', baseUrl: cloud.url, workspaceId: 'runtime-workspace' } },
    })
    const beforeThirdCount = cloud.messages.length
    await restartedRuntime.startSession()
    await vi.waitFor(() => {
      expect(cloud.messages.slice(beforeThirdCount).some(m => m.type === 'conversation.item.create' && m.item?.role === 'system')).toBe(true)
    })
    const thirdRestored = cloud.messages.slice(beforeThirdCount).find(m => m.type === 'conversation.item.create' && m.item?.role === 'system')
    const thirdText = ((thirdRestored?.item?.content as { text?: string }[] | undefined)?.[0]?.text) ?? ''
    expect(thirdText).toContain('再看一眼刚才那个会话进度')
    expect(thirdText.match(/【历史对话恢复】/gu)).toHaveLength(1)
  })

  it('appends associated sessionId and approvalId to model-visible hook notifications', async () => {
    const { cloud, runtime } = await runtimeFixture()
    await runtime.startSession()
    const accepted = await runtime.injectHookNotification('工作区 默认工作区 的会话「部署」正等待权限审批', {
      events: [{
        sessionId: 'ttds-abc-123',
        metadata: { approvalId: 'apr-999' },
      }],
    })
    expect(accepted).toBe(true)
    const hookMsg = cloud.messages.find(m => m.type === 'conversation.item.create' && m.item?.role === 'user')
    const hookText = ((hookMsg?.item?.content as { text?: string }[] | undefined)?.[0]?.text) ?? ''
    expect(hookText).toContain('sessionId=ttds-abc-123')
    expect(hookText).toContain('approvalId=apr-999')
  })
})
