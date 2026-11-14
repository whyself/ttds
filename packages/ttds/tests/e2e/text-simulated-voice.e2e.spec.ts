import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import {
  Peer,
  type ConnectionRpcHandler,
  type HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { bootBundle, type BootedBundle } from '../../../../scripts/test-support/boot-bundle.ts'
import { TtdsClientController, type RealtimeSocket, type VoiceAudioAdapter } from '../../src/client/index.ts'
import {
  DEFAULT_VOICE_SYSTEM_INSTRUCTIONS,
  SupervisorSessionJournal,
  TTDS_REALTIME_WS_PATH,
  type TtdsConfig,
} from '../../src/index.ts'

interface UpstreamMessage {
  readonly type: string
  readonly session?: Readonly<Record<string, unknown>>
  readonly item?: Readonly<Record<string, unknown>>
}

function readLabEnv(): { readonly apiKey: string; readonly workspaceId: string } {
  const envKey = (process.env.DASHSCOPE_API_KEY ?? '').trim()
  const envWorkspace = (process.env.DASHSCOPE_WORKSPACE_ID ?? '').trim()
  if (envKey !== '') return { apiKey: envKey, workspaceId: envWorkspace }
  const labEnvPath = resolve(import.meta.dirname, '../../../../lab/qwen_realtime_lab/.env')
  if (!existsSync(labEnvPath)) return { apiKey: '', workspaceId: '' }
  const raw = readFileSync(labEnvPath, 'utf8')
  let apiKey = ''
  let workspaceId = ''
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '')
    if (key === 'DASHSCOPE_API_KEY') apiKey = value
    if (key === 'WORKSPACE_ID' || key === 'DASHSCOPE_WORKSPACE_ID') workspaceId = value
  }
  return { apiKey, workspaceId }
}

function createNodeBrowserSocket(url: string): RealtimeSocket {
  const ws = new WebSocket(url)
  const wrapper: RealtimeSocket = {
    get readyState() {
      return ws.readyState
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data: string) => { ws.send(data) },
    close: () => { ws.close() },
  }
  ws.on('open', () => {
    wrapper.onopen?.(new Event('open'))
  })
  ws.on('message', (data) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    wrapper.onmessage?.(new MessageEvent('message', { data: bytes.toString('utf8') }))
  })
  ws.on('error', () => {
    wrapper.onerror?.(new Event('error'))
  })
  ws.on('close', (code, reason) => {
    wrapper.onclose?.({ code, reason: reason.toString('utf8') } as CloseEvent)
  })
  return wrapper
}

function createSimulatedAudioAdapter() {
  const playedChunks: { readonly pcm24kBase64: string; readonly byteLength: number }[] = []
  let pendingDrains: (() => void)[] = []
  let autoDrain = true
  const adapter: VoiceAudioAdapter = {
    activatePlayback: () => Promise.resolve(),
    startCapture: () => Promise.resolve(),
    stopCapture: () => {},
    play: (audio, drained) => {
      const byteLength = Buffer.from(audio, 'base64').byteLength
      playedChunks.push({ pcm24kBase64: audio, byteLength })
      if (autoDrain) {
        queueMicrotask(drained)
      } else {
        pendingDrains.push(drained)
      }
    },
    clear: () => {
      pendingDrains = []
    },
    close: () => {
      pendingDrains = []
      return Promise.resolve()
    },
    dispose: () => {
      pendingDrains = []
      return Promise.resolve()
    },
  }
  return {
    adapter,
    playedChunks,
    setAutoDrain: (enabled: boolean) => { autoDrain = enabled },
    drainAll: () => {
      for (const drain of pendingDrains.splice(0)) drain()
    },
  }
}

function installHostServices(booted: BootedBundle) {
  const ctx = booted.ctx
  const channels = new Map<string, ConnectionRpcHandler>()
  const interceptors = new Map<(endpoint: string) => boolean, ConnectionRpcHandler>()
  const owner = new Peer(ctx, { principal: { kind: 'owner' } })
  const peers = new Set<Peer>()
  const connection: HostConnectionHandle = {
    browserPeer: owner,
    allowsRemoteAuthorities: false,
    rpc: {
      handle: (channel, handler) => {
        channels.set(channel, handler)
        return () => {
          channels.delete(channel)
          return Promise.resolve()
        }
      },
      intercept: (_channel, matcher, handler) => {
        interceptors.set(matcher, handler)
        return () => {
          interceptors.delete(matcher)
          return Promise.resolve()
        }
      },
    },
    fetch: { register: () => { throw new Error('unused') } },
    requestRejection: () => undefined,
    admit: () => ({ peer: owner }),
    admitConnection: () => {
      const peer = new Peer(ctx, { principal: { kind: 'owner' } })
      peers.add(peer)
      return {
        peer,
        release: async () => {
          peers.delete(peer)
          await peer.dispose()
        },
      }
    },
    createPeer: options => new Peer(ctx, options),
    createSharedFetchHandler: () => { throw new Error('unused') },
    authorizeIndex: () => true,
    authenticatedUrl: url => url,
  }
  ctx.provide('connection', connection)
  return {
    disposePeers: async () => {
      for (const peer of [...peers]) {
        peers.delete(peer)
        await peer.dispose()
      }
      await owner.dispose()
    },
  }
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('TTDS text-simulated voice E2E', () => {
  it('completes full-stack text-simulated dialogue, async tools, ui confirmation, auto hot-switch without reconnect, quiet hooks, and journal replay', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'ttds-e2e-journal-'))
    cleanups.push(() => rm(storageDir, { recursive: true, force: true }))

    const upstreamMessages: UpstreamMessage[] = []
    const upstreamSockets: WebSocket[] = []
    let userTurnIndex = 0

    const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(cloud, 'listening')
    const cloudAddr = cloud.address()
    if (typeof cloudAddr === 'string' || cloudAddr === null) throw new Error('Missing mock cloud port')
    cleanups.push(() => new Promise<void>((resolvePort) => {
      for (const socket of cloud.clients) socket.terminate()
      cloud.close(() => { resolvePort() })
    }))

    const pcmChunkBase64 = Buffer.alloc(480, 1).toString('base64')

    cloud.on('connection', (socket) => {
      upstreamSockets.push(socket)
      socket.send(JSON.stringify({ type: 'session.created', session: { id: 'up_sess_e2e' } }))
      socket.on('message', (raw) => {
        const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
        const msg = JSON.parse(bytes.toString('utf8')) as UpstreamMessage
        upstreamMessages.push(msg)

        if (msg.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'session.updated' }))
          return
        }

        if (msg.type === 'conversation.item.create' && msg.item?.type === 'function_call_output') {
          socket.send(JSON.stringify({
            type: 'conversation.item.created',
            item: {
              id: `item_srv_${upstreamMessages.length}`,
              type: 'function_call_output',
              call_id: msg.item.call_id,
              output: msg.item.output,
            },
          }))
          return
        }

        if (msg.type === 'response.create') {
          const turn = ++userTurnIndex
          if (turn === 1) {
            // Turn 1: User asks to inspect sessions and search; model gives brief spoken filler + two tool calls.
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_1', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.delta', response_id: 'resp_1', delta: '好的，我帮你查一下' }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_1', transcript: '好的，我帮你查一下会话和搜索资料。' }))
            socket.send(JSON.stringify({
              type: 'response.done',
              response: {
                id: 'resp_1',
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_sessions_1',
                    name: 'dsh_list_sessions',
                    arguments: '{}',
                  },
                  {
                    type: 'function_call',
                    id: 'fc_2',
                    call_id: 'call_search_1',
                    name: 'dsh_search',
                    arguments: JSON.stringify({ query: 'DeepSeek Harness plugin' }),
                  },
                ],
              },
            }))
          } else if (turn === 2) {
            // Turn 2: Foreground conversation while `dsh_search` is still pending in the background!
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_2' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_2', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_2', transcript: '七加五等于十二。' }))
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_2', status: 'completed', output: [] } }))
          } else if (turn === 3) {
            // Turn 3: Automatic spoken delivery woken quickly after tool output backfill.
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_3' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_3', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({
              type: 'response.audio_transcript.done',
              response_id: 'resp_3',
              transcript: '查到了，主工作区会话 s-main 正在运行，搜索也找到了插件扩展规范。',
            }))
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_3', status: 'completed', output: [] } }))
          } else if (turn === 4) {
            // Turn 4: User asks to send a prompt to s-main -> triggers UI confirmation card (cancelled first).
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_4' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_4', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_4', transcript: '请在界面确认框里允许向 s-main 发送指令。' }))
            socket.send(JSON.stringify({
              type: 'response.done',
              response: {
                id: 'resp_4',
                status: 'completed',
                output: [{
                  type: 'function_call',
                  id: 'fc_3',
                  call_id: 'call_prompt_cancel',
                  name: 'dsh_send_session_prompt',
                  arguments: JSON.stringify({ sessionId: 's-main', prompt: '运行全量回归测试' }),
                }],
              },
            }))
          } else if (turn === 5) {
            // Turn 5: Woken after user clicked Cancel in UI.
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_5' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_5', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_5', transcript: '好的，已取消发送指令。' }))
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_5', status: 'completed', output: [] } }))
          } else if (turn === 6) {
            // Turn 6: User asks again -> triggers UI confirmation card (approved this time).
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_6' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_6', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_6', transcript: '我再弹一次确认框，请点允许。' }))
            socket.send(JSON.stringify({
              type: 'response.done',
              response: {
                id: 'resp_6',
                status: 'completed',
                output: [{
                  type: 'function_call',
                  id: 'fc_4',
                  call_id: 'call_prompt_approve',
                  name: 'dsh_send_session_prompt',
                  arguments: JSON.stringify({ sessionId: 's-main', prompt: '运行全量回归测试' }),
                }],
              },
            }))
          } else if (turn === 7) {
            // Turn 7: Woken after approved write tool finishes.
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_7' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_7', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_7', transcript: '已向 s-main 发送跟进指令。' }))
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_7', status: 'completed', output: [] } }))
          } else if (turn === 8) {
            // Turn 8: Write confirmation hot-switched to `auto` without reconnect -> `dsh_create_session` runs directly!
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_8' } }))
            socket.send(JSON.stringify({
              type: 'response.done',
              response: {
                id: 'resp_8',
                status: 'completed',
                output: [{
                  type: 'function_call',
                  id: 'fc_5',
                  call_id: 'call_create_auto',
                  name: 'dsh_create_session',
                  arguments: JSON.stringify({ prompt: '自动创建并执行检查' }),
                }],
              },
            }))
          } else if (turn === 9) {
            // Turn 9: Woken after auto-created session finishes.
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_9' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_9', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'resp_9', transcript: '新会话已自动创建完成。' }))
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_9', status: 'completed', output: [] } }))
          } else if (turn === 10) {
            // Turn 10: Woken by external background session `s-worker` turn/end hook!
            socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_10' } }))
            socket.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'resp_10', delta: pcmChunkBase64 }))
            socket.send(JSON.stringify({
              type: 'response.audio_transcript.done',
              response_id: 'resp_10',
              transcript: '顺便播报一下，后台会话 s-worker 刚刚完成了本轮任务。',
            }))
            socket.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_10', status: 'completed', output: [] } }))
          }
        }
      })
    })

    const booted = await bootBundle('packages/ttds')
    const hostPeers = installHostServices(booted)
    cleanups.push(() => hostPeers.disposePeers())
    cleanups.push(() => booted.dispose())

    await booted.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    new SessionStore(booted.ctx)
    const mainSession = booted.ctx.sessions.create(SessionId('s-main'))
    const workerSession = booted.ctx.sessions.create(SessionId('s-worker'))

    // Wire mock DSH public `sessionController` and slow `web` search services.
    let releaseSlowSearch: () => void = () => {}
    const slowSearchGate = new Promise<void>((resolveGate) => { releaseSlowSearch = resolveGate })
    const sentPrompts: { readonly sessionId: string; readonly text: string }[] = []

    const sessionService = {
      list: vi.fn<SessionController['list']>(() => Promise.resolve({
        items: [{
          sessionId: SessionId('s-main'),
          running: true,
          agentAvailable: true,
          blank: false,
          updatedAt: Date.now(),
          cwd: 'D:/Projects/TTDS',
        }],
      })),
      state: vi.fn<SessionController['state']>(() => Promise.resolve({
        active: true, running: true, cursor: 2, queue: [], pendingInput: [],
      })),
      events: vi.fn<SessionController['events']>(() => Promise.resolve({ cursor: 2, hasMore: false, records: [] })),
      create: vi.fn<SessionController['create']>(() => Promise.resolve({ sessionId: SessionId('s-created') })),
      prompt: vi.fn<SessionController['prompt']>((req) => {
        const firstPart = req.content[0]
        sentPrompts.push({ sessionId: req.sessionId, text: firstPart?.type === 'text' ? firstPart.text : '' })
        // Emit synchronous echo on `s-main` while self-action suppression is active: must NOT enqueue a hook!
        mainSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        return Promise.resolve({ accepted: true })
      }),
      cancel: vi.fn<SessionController['cancel']>(() => ({ accepted: true })),
      selectModel: vi.fn<SessionController['selectModel']>(req => Promise.resolve({
        selected: { provider: req.provider, model: req.model },
      })),
    } satisfies Pick<SessionController, 'list' | 'state' | 'events' | 'create' | 'prompt' | 'cancel' | 'selectModel'>
    const sessionControllerKey: string = 'sessionController'
    booted.ctx.provide(sessionControllerKey, sessionService)

    const webService: Pick<Context['web'], 'search'> = {
      search: async ({ query }) => {
        await slowSearchGate
        return {
          content: `关于 ${query} 的检索结论：通过公开扩展点与 cordis.patch.yml 组合。`,
          sources: [{ title: 'DSH Architecture', url: 'https://example.com/dsh', snippet: 'Bundle patch layer' }],
          truncated: false,
        }
      },
    }
    const webServiceKey: string = 'web'
    booted.ctx.provide(webServiceKey, webService)

    const runtime = booted.ctx.ttdsRuntime
    const testSecretKey = 'sk-e2e-never-persist-secret'
    const e2eConfig: TtdsConfig = {
      storageDir,
      providers: {
        'qwen-realtime': {
          apiKey: testSecretKey,
          baseUrl: `ws://127.0.0.1:${cloudAddr.port}`,
          workspaceId: 'ws-e2e',
        },
      },
      voice: {
        customInstructions: '汇报会话路径时只说目录最后一段名称。',
      },
      hooks: {
        quietGraceMs: 120,
      },
    }
    await runtime.updateConfig(e2eConfig)

    const port = booted.ctx.webServer.port
    expect(port).toBeGreaterThan(0)
    const audioSim = createSimulatedAudioAdapter()
    const clientController = new TtdsClientController(booted.ctx, {
      url: `ws://127.0.0.1:${port}${TTDS_REALTIME_WS_PATH}`,
      createSocket: createNodeBrowserSocket,
      audio: audioSim.adapter,
    })
    cleanups.push(() => clientController.dispose())

    // Phase 1: Connect from client controller & verify upstream `session.update`.
    clientController.start()
    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().snapshot?.phase).toBe('listening')
    })
    const supervisorSessionId = runtime.getSnapshot().supervisorSessionId
    expect(supervisorSessionId).toBeTypeOf('string')

    const initialUpdate = upstreamMessages.find(m => m.type === 'session.update')?.session
    expect(initialUpdate?.enable_search).toBe(false)
    expect(String(initialUpdate?.instructions)).toContain(DEFAULT_VOICE_SYSTEM_INSTRUCTIONS)
    expect(String(initialUpdate?.instructions)).toContain('汇报会话路径时只说目录最后一段名称。')
    const upstreamTools = initialUpdate?.tools as { function: { name: string } }[] | undefined
    expect(upstreamTools?.map(item => item.function.name)).toContain('dsh_search')
    expect(upstreamTools).toHaveLength(11)

    // Phase 2: Send text utterance #1 -> triggers `dsh_list_sessions` + slow `dsh_search`, then talk while search is pending!
    expect(clientController.sendText('帮我查一下当前有哪些 DSH 会话，顺便搜一下 DeepSeek Harness 插件机制')).toBe(true)
    await vi.waitFor(() => {
      expect(upstreamMessages.some(m => m.item?.call_id === 'call_sessions_1')).toBe(true)
    })
    // `dsh_search` is still pending! Verify foreground dialogue remains unblocked:
    expect(runtime.getSnapshot().pendingToolCount).toBe(1)
    expect(clientController.sendText('不等搜索了，先算七加五等于几')).toBe(true)
    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().feed.some(f => f.text.includes('七加五等于十二'))).toBe(true)
    })

    // Release slow `dsh_search` and verify automatic spoken delivery after `quietGraceMs` (120ms):
    releaseSlowSearch()
    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().feed.some(f => f.text.includes('搜索也找到了插件扩展规范'))).toBe(true)
      expect(runtime.getSnapshot().pendingToolCount).toBe(0)
    }, { timeout: 5000 })

    // Phase 3: UI confirmation gate (cancel first, then approve) + live hot-switch to auto without reconnect.
    expect(clientController.sendText('给会话 s-main 发一条运行全量回归测试的指令')).toBe(true)
    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().snapshot?.pendingConfirmations).toHaveLength(1)
    }, { timeout: 5000 })
    const cancelledCard = clientController.state.getSnapshot().snapshot?.pendingConfirmations[0]
    if (!cancelledCard) throw new Error('Expected cancelled confirmation card')
    clientController.respondConfirmation(cancelledCard.confirmationId, false)
    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().feed.some(f => f.text.includes('已取消发送指令'))).toBe(true)
      expect(runtime.getSnapshot().pendingToolCount).toBe(0)
    }, { timeout: 5000 })
    expect(sentPrompts).toEqual([])

    expect(clientController.sendText('再发一次向 s-main 运行全量回归测试的指令')).toBe(true)
    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().snapshot?.pendingConfirmations).toHaveLength(1)
    }, { timeout: 5000 })
    const approvedCard = clientController.state.getSnapshot().snapshot?.pendingConfirmations[0]
    if (!approvedCard) throw new Error('Expected approved confirmation card')
    clientController.respondConfirmation(approvedCard.confirmationId, true)
    await vi.waitFor(() => {
      expect(sentPrompts).toEqual([{ sessionId: 's-main', text: '运行全量回归测试' }])
      expect(clientController.state.getSnapshot().feed.some(f => f.text.includes('已向 s-main 发送跟进指令'))).toBe(true)
    }, { timeout: 5000 })
    // Self-action echo from `s-main` was suppressed!
    expect(booted.ctx.ttdsHooks.getBufferedEvents()).toEqual([])

    const epochBeforePolicySwitch = runtime.getSnapshot().connectionEpoch
    await runtime.updateConfig({
      ...e2eConfig,
      tools: { writeConfirmation: 'auto' },
    })
    expect(runtime.getSnapshot().connectionEpoch).toBe(epochBeforePolicySwitch)
    expect(upstreamSockets).toHaveLength(1)

    expect(clientController.sendText('自动创建一个新会话执行检查')).toBe(true)
    await vi.waitFor(() => {
      expect(sessionService.create).toHaveBeenCalledTimes(1)
      expect(clientController.state.getSnapshot().feed.some(f => f.text.includes('新会话已自动创建完成'))).toBe(true)
    }, { timeout: 5000 })

    // Phase 4: Unrelated background session `s-worker` settles -> delivered politely after `quietGraceMs`!
    workerSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(clientController.state.getSnapshot().feed.some(f => f.kind === 'hook_event' && f.text.includes('s-worker'))).toBe(true)
      expect(clientController.state.getSnapshot().feed.some(f => f.text.includes('后台会话 s-worker 刚刚完成了本轮任务'))).toBe(true)
    }, { timeout: 5000 })

    // Verify downlink 24kHz PCM audio chunks flowed to the client and drained cleanly.
    expect(audioSim.playedChunks.length).toBeGreaterThanOrEqual(5)
    expect(runtime.getPlaybackCursors().drainedAudioSeq).toBe(runtime.getPlaybackCursors().emittedAudioSeq)

    // Phase 5: Stop session and verify complete `SupervisorSessionJournal` reconstruction & secret/audio redaction.
    await clientController.stop()
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().supervisorSessionId).toBeNull()
    })

    if (supervisorSessionId === null) throw new Error('Missing supervisorSessionId')
    const records = await SupervisorSessionJournal.readRecords(storageDir, supervisorSessionId)
    const kinds = records.map(r => r.kind)
    expect(kinds[0]).toBe('session.started')
    expect(kinds).toContain('user.text')
    expect(kinds).toContain('assistant.transcript')
    expect(kinds).toContain('tool.call')
    expect(kinds).toContain('tool.confirmation')
    expect(kinds).toContain('tool.output')
    expect(kinds).toContain('hook.injected')
    expect(kinds.at(-1)).toBe('session.ended')

    const rawJournalText = await readFile(join(storageDir, `${supervisorSessionId}.jsonl`), 'utf8')
    expect(rawJournalText).not.toContain(testSecretKey)
    expect(rawJournalText).not.toContain(pcmChunkBase64)
  }, 20_000)

  const liveCreds = readLabEnv()
  it.skipIf(liveCreds.apiKey === '')(
    'completes a live Alibaba Cloud Bailian Qwen-Audio 3.1 Realtime session via text-simulated voice input',
    async () => {
      const storageDir = await mkdtemp(join(tmpdir(), 'ttds-e2e-live-qwen-'))
      cleanups.push(() => rm(storageDir, { recursive: true, force: true }))

      const booted = await bootBundle('packages/ttds')
      const hostPeers = installHostServices(booted)
      cleanups.push(() => hostPeers.disposePeers())
      cleanups.push(() => booted.dispose())

      await booted.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      new SessionStore(booted.ctx)
      const bgSession = booted.ctx.sessions.create(SessionId('session-beta'))

      const sessionService = {
        list: vi.fn<SessionController['list']>(() => Promise.resolve({
          items: [{
            sessionId: SessionId('session-alpha'),
            running: true,
            agentAvailable: true,
            blank: false,
            updatedAt: Date.now(),
            cwd: 'D:/Projects/LiveVerificationRepo',
          }],
        })),
        state: vi.fn<SessionController['state']>(() => Promise.resolve({
          active: true, running: true, cursor: 1, queue: [], pendingInput: [],
        })),
        events: vi.fn<SessionController['events']>(() => Promise.resolve({ cursor: 1, hasMore: false, records: [] })),
        create: vi.fn<SessionController['create']>(() => Promise.resolve({ sessionId: SessionId('created') })),
        prompt: vi.fn<SessionController['prompt']>(() => Promise.resolve({ accepted: true })),
        cancel: vi.fn<SessionController['cancel']>(() => ({ accepted: true })),
        selectModel: vi.fn<SessionController['selectModel']>(req => Promise.resolve({
          selected: { provider: req.provider, model: req.model },
        })),
      } satisfies Pick<SessionController, 'list' | 'state' | 'events' | 'create' | 'prompt' | 'cancel' | 'selectModel'>
      const sessionControllerKey: string = 'sessionController'
      booted.ctx.provide(sessionControllerKey, sessionService)

      const runtime = booted.ctx.ttdsRuntime
      await runtime.updateConfig({
        storageDir,
        providers: {
          'qwen-realtime': {
            apiKey: liveCreds.apiKey,
            workspaceId: liveCreds.workspaceId,
            model: 'qwen-audio-3.1-realtime-flash',
          },
        },
        hooks: {
          quietGraceMs: 800,
        },
      })

      const port = booted.ctx.webServer.port
      const audioSim = createSimulatedAudioAdapter()
      const clientController = new TtdsClientController(booted.ctx, {
        url: `ws://127.0.0.1:${port}${TTDS_REALTIME_WS_PATH}`,
        createSocket: createNodeBrowserSocket,
        audio: audioSim.adapter,
      })
      cleanups.push(() => clientController.dispose())

      // 1. Live handshake + `session.update` against real Bailian Qwen-Audio 3.1 Realtime Flash
      clientController.start()
      await vi.waitFor(() => {
        expect(clientController.state.getSnapshot().snapshot?.phase).toBe('listening')
      }, { timeout: 20_000 })

      const liveSessionId = runtime.getSnapshot().supervisorSessionId
      expect(liveSessionId).toBeTypeOf('string')

      // 2. Text-simulated voice utterance triggering real `dsh_list_sessions` function call + backfill + spoken 24kHz PCM!
      expect(
        clientController.sendText('请立即调用 dsh_list_sessions 查看当前有哪些 DSH 会话，并用简短口语告诉我它的工作目录名字。'),
      ).toBe(true)

      await vi.waitFor(() => {
        expect(sessionService.list).toHaveBeenCalled()
        expect(runtime.getSnapshot().pendingToolCount).toBe(0)
        const assistantTexts = clientController.state.getSnapshot().feed
          .filter(item => item.kind === 'transcript_assistant')
          .map(item => item.text)
          .join('\n')
        expect(assistantTexts).toMatch(/LiveVerificationRepo|session-alpha/iu)
        const totalPcmBytes = audioSim.playedChunks.reduce((sum, item) => sum + item.byteLength, 0)
        expect(totalPcmBytes).toBeGreaterThan(4800)
        expect(clientController.state.getSnapshot().snapshot?.phase).toBe('listening')
      }, { timeout: 35_000 })

      // 3. Also verify real Bailian accepts background hook injection (`injectHookNotification`) and speaks!
      const pcmChunksBeforeHook = audioSim.playedChunks.length
      bgSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await vi.waitFor(() => {
        expect(clientController.state.getSnapshot().feed.some(f => f.kind === 'hook_event')).toBe(true)
        expect(audioSim.playedChunks.length).toBeGreaterThan(pcmChunksBeforeHook)
        expect(clientController.state.getSnapshot().snapshot?.phase).toBe('listening')
      }, { timeout: 25_000 })

      await clientController.stop()
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().supervisorSessionId).toBeNull()
      }, { timeout: 10_000 })
      if (liveSessionId === null) throw new Error('Missing liveSessionId')
      const liveRecords = await SupervisorSessionJournal.readRecords(storageDir, liveSessionId)
      expect(liveRecords.some(r => r.kind === 'tool.output')).toBe(true)
      expect(liveRecords.some(r => r.kind === 'hook.injected')).toBe(true)
      expect(liveRecords.at(-1)?.kind).toBe('session.ended')

      const rawLiveLog = await readFile(join(storageDir, `${liveSessionId}.jsonl`), 'utf8')
      expect(rawLiveLog).not.toContain(liveCreds.apiKey)
    },
    60_000,
  )
})
