import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocket, WebSocketServer } from 'ws'
import {
  TTDS_REALTIME_WS_PATH,
  TTDS_RPC_PREFIX,
  type ClientRealtimeFrame,
  type VoiceRuntimeServiceContract,
} from '../shared/index.ts'
import { redactText } from './journal.ts'
import { VoiceRuntimeService } from './runtime-service.ts'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求必须为 JSON 对象')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请求字段必须为字符串')
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('请求字段必须为布尔值')
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('请求字段必须为非负数值')
  return value
}

function clientFrame(value: unknown): ClientRealtimeFrame {
  const frame = record(value)
  switch (frame.type) {
    case 'session.start': return frame.inputDeviceId === undefined
      ? { type: 'session.start' } : { type: 'session.start', inputDeviceId: text(frame.inputDeviceId) }
    case 'session.stop': return { type: 'session.stop' }
    case 'audio.commit': return { type: 'audio.commit' }
    case 'speech.interrupt': return { type: 'speech.interrupt' }
    case 'audio.append': {
      const audioBase64 = text(frame.audioBase64)
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64)) {
        throw new Error('音频字段必须为有效的 base64')
      }
      return { type: 'audio.append', audioBase64 }
    }
    case 'input.text': return { type: 'input.text', text: text(frame.text) }
    case 'audio.mute': return { type: 'audio.mute', muted: boolean(frame.muted) }
    case 'playback.drained': {
      const playbackSeq = number(frame.playbackSeq)
      if (!Number.isSafeInteger(playbackSeq)) throw new Error('播放序号必须为非负整数')
      return { type: 'playback.drained', playbackSeq }
    }
    case 'confirmation.respond': return {
      type: 'confirmation.respond', confirmationId: text(frame.confirmationId), approved: boolean(frame.approved),
    }
    case 'ping': return { type: 'ping', timestampMs: number(frame.timestampMs) }
    default: throw new Error('未知的实时语音消息类型')
  }
}

function failure(runtime: VoiceRuntimeServiceContract, code: string, error: unknown): ConnectionRpcHandlerResult {
  return { ok: false, error: {
    code,
    message: redactText(error instanceof Error ? error.message : '语音请求失败', [runtime.getConfig().providers['qwen-realtime'].apiKey]),
    details: {},
  } }
}

function updateAudioCount(runtime: VoiceRuntimeServiceContract, count: number): void {
  if (runtime instanceof VoiceRuntimeService) {
    runtime.setAudioClientCount(count)
  }
}

/**
 * Mount authenticated unary control and browser audio routes on their public DSH extension points.
 * @param ctx - plugin context owning route registration and socket cleanup.
 * @param runtime - Host-authoritative runtime receiving validated client frames.
 */
export function mountTtdsTransport(ctx: Context, runtime: VoiceRuntimeServiceContract): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const handler: Parameters<typeof connectionCtx.connection.rpc.handle>[1] = async (endpoint, payload, signal, peer) => {
      const isAborted = (): boolean => signal.aborted || peer.signal.aborted
      if (isAborted()) return failure(runtime, 'aborted', new Error('连接已取消'))
      let value: unknown
      try {
        value = await dispatchRpc(connectionCtx, runtime, endpoint, payload)
      } catch (error) {
        return failure(runtime, 'invalid_request', error)
      }
      if (isAborted()) return failure(runtime, 'aborted', new Error('连接已取消'))
      return { ok: true, value }
    }
    connectionCtx.effect(() => connectionCtx.connection.rpc.handle(TTDS_RPC_PREFIX, handler))
  })

  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const server = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
    const clients = new Set<WebSocket>()
    const releases = new Set<Promise<void>>()
    let accepting = true
    const unsubscribe = runtime.subscribeFrames((frame) => {
      const json = JSON.stringify(frame)
      for (const socket of clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        if (socket.bufferedAmount > 1024 * 1024) socket.close(1013, '语音播放连接过慢')
        else socket.send(json)
      }
    })
    webCtx.effect(() => {
      const unregister = webCtx.webServer.registerUpgrade({
        path: TTDS_REALTIME_WS_PATH,
        handler: async (req, socket, head) => {
          if (!accepting) {
            socket.destroy()
            return
          }
          const admission = webCtx.connection.admitConnection(req)
          if ('rejection' in admission) {
            socket.end(`HTTP/1.1 ${admission.rejection} Unauthorized\r\nConnection: close\r\n\r\n`)
            return
          }
          if (admission.peer.signal.aborted) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            await admission.release()
            return
          }
          let released = false
          const release = (): Promise<void> => {
            if (released) return Promise.resolve()
            released = true
            return admission.release()
          }
          let incoming = Promise.resolve()
          let releaseScheduled = false
          const scheduleRelease = (): void => {
            if (releaseScheduled) return
            releaseScheduled = true
            const completion = incoming.then(release, release)
            releases.add(completion)
            void completion.then(
              () => { releases.delete(completion) },
              () => { releases.delete(completion) },
            )
          }
          socket.once('close', scheduleRelease)
          const abort = (): void => { socket.destroy() }
          admission.peer.signal.addEventListener('abort', abort, { once: true })
          socket.once('close', () => { admission.peer.signal.removeEventListener('abort', abort) })
          try {
            server.handleUpgrade(req, socket, head, (client) => {
              clients.add(client)
              updateAudioCount(runtime, clients.size)
              client.send(JSON.stringify({ type: 'state.snapshot', snapshot: runtime.getSnapshot() }))
              client.once('close', () => {
                clients.delete(client)
                updateAudioCount(runtime, clients.size)
                scheduleRelease()
              })
              client.on('error', () => { client.terminate() })
              client.on('message', (data, isBinary) => {
                if (!accepting || admission.peer.signal.aborted) return
                if (isBinary) {
                  client.close(1003, '仅支持 JSON 文本消息')
                  return
                }
                incoming = incoming.then(async () => {
                  if (!accepting || admission.peer.signal.aborted) return
                  const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
                  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
                  await runtime.handleClientFrame(clientFrame(parsed), true)
                }).catch((error: unknown) => {
                  const result = failure(runtime, 'invalid_frame', error)
                  if (!result.ok && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'error', code: result.error.code, message: result.error.message }))
                  }
                })
              })
            })
          } catch (error) {
            socket.destroy()
            scheduleRelease()
            throw error
          }
        },
      })
      return async () => {
        accepting = false
        unregister()
        unsubscribe()
        const closing = [...clients].map(client => new Promise<void>((resolve) => {
          client.once('close', resolve)
          client.terminate()
        }))
        await Promise.all(closing)
        while (releases.size > 0) await Promise.all([...releases])
        updateAudioCount(runtime, 0)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      }
    })
  })
}

async function dispatchRpc(ctx: Context, runtime: VoiceRuntimeServiceContract, endpoint: string, payload: unknown): Promise<unknown> {
  const method = endpoint.replace(/^\/?(?:ttds\/)?/, '')
  const body = record(payload)
  switch (method) {
    case 'status': return runtime.getSnapshot()
    case 'start': return runtime.startSession(body.inputDeviceId === undefined ? {} : { inputDeviceId: text(body.inputDeviceId) })
    case 'stop': return runtime.stopSession()
    case 'sendText': return runtime.sendTextUtterance(text(body.text), { autoStart: true })
    case 'confirm': {
      const tools = ctx.get('ttdsTools')
      if (!tools) throw new Error('语音工具服务尚未加载')
      const resolved = await tools.resolveUiConfirmation(text(body.confirmationId), boolean(body.approved))
      return { resolved }
    }
    default: throw new Error('未知的语音 RPC 端点')
  }
}
