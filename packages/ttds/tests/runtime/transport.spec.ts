import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  Peer,
  type ConnectionRpcHandler,
  type HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { mountTtdsTransport, VoiceRuntimeService } from '../../src/runtime/index.ts'
import { TTDS_REALTIME_WS_PATH, type ServerRealtimeFrame } from '../../src/shared/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(cloud, 'listening')
  const address = cloud.address()
  if (typeof address === 'string' || address === null) throw new Error('Missing upstream port')
  cloud.on('connection', (socket) => {
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      const message = JSON.parse(bytes.toString('utf8')) as { type: string }
      if (message.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      if (message.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.done', response: {
          id: 'transport_answer', status: 'completed', output: [
            { type: 'message', content: [{ type: 'audio', transcript: '收到' }] },
          ],
        } }))
      }
    })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of cloud.clients) socket.terminate()
    cloud.close(() => { resolve() })
  }))
  const storageDir = await mkdtemp(join(import.meta.dirname, 'fixture-'))
  cleanups.push(() => rm(storageDir, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const channels = new Map<string, ConnectionRpcHandler>()
  const interceptors = new Map<(endpoint: string) => boolean, ConnectionRpcHandler>()
  const owner = new Peer(ctx, { principal: { kind: 'owner' } })
  const attached = new Set<Peer>()
  let releaseCount = 0
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
    fetch: { register: () => { throw new Error('Not used by the network fixture') } },
    requestRejection: () => undefined,
    admit: () => ({ peer: owner }),
    admitConnection: (request) => {
      const headers = request.headers
      const denied = headers instanceof Headers ? headers.get('x-test-admit') === 'deny' : headers['x-test-admit'] === 'deny'
      if (denied) return { rejection: 403 }
      const peer = new Peer(ctx, { principal: { kind: 'owner' } })
      attached.add(peer)
      return {
        peer,
        release: async () => {
          attached.delete(peer)
          ++releaseCount
          await peer.dispose()
        },
      }
    },
    createPeer: options => new Peer(ctx, options),
    createSharedFetchHandler: () => { throw new Error('Not used by the network fixture') },
    authorizeIndex: () => true,
    authenticatedUrl: url => url,
  }
  ctx.provide('connection', connection)
  const runtime = new VoiceRuntimeService(ctx, {
    storageDir,
    providers: { 'qwen-realtime': { apiKey: 'sk-transport-private', baseUrl: `ws://127.0.0.1:${address.port}` } },
  })
  mountTtdsTransport(ctx, runtime)
  await vi.waitFor(() => { expect(channels.has('/ttds')).toBe(true) })
  expect(interceptors.size).toBe(0)
  const web = ctx.get('webServer')!
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/ttds',
    handler: async (request, response) => {
      const parts: Buffer[] = []
      for await (const chunk of request) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { endpoint: string; payload: unknown }
      const channel = channels.get('/ttds')
      const result = channel
        ? await channel(body.endpoint, body.payload, new AbortController().signal, owner)
        : { ok: false, error: { code: 'not_found', message: 'Missing endpoint', details: {} } }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(result))
    },
  }))
  cleanups.push(() => ctx.fiber.dispose())
  return {
    ctx, runtime, channels, interceptors, attached, cloud,
    origin: web.getOrigin(),
    releaseCount: () => releaseCount,
    rpc: async (endpoint: string, payload: object = {}) => {
      const response = await fetch(`${web.getOrigin()}/ttds`, {
        method: 'POST', body: JSON.stringify({ endpoint, payload }),
      })
      return response.json() as Promise<{ ok: boolean; value?: Record<string, unknown>; error?: { code: string } }>
    },
  }
}

async function connect(origin: string) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${TTDS_REALTIME_WS_PATH}`)
  const frames: ServerRealtimeFrame[] = []
  socket.on('message', (data) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    frames.push(JSON.parse(bytes.toString('utf8')) as ServerRealtimeFrame)
  })
  await once(socket, 'open')
  cleanups.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return
    const closed = once(socket, 'close')
    socket.close()
    await closed
  })
  return { socket, frames }
}

it('serves /ttds RPC through the registered channel without intercepting /api', async () => {
  const { rpc, runtime, channels, ctx } = await fixture()
  expect((await rpc('/ttds/status')).ok).toBe(true)
  expect((await rpc('/ttds/start')).value?.phase).toBe('listening')
  expect((await rpc('/ttds/sendText', { text: '你好' })).value?.accepted).toBe(true)
  expect((await rpc('/ttds/sendText', { text: 3 })).error?.code).toBe('invalid_request')
  expect((await rpc('/ttds/confirm', { confirmationId: 'absent', approved: true })).ok).toBe(false)
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  await peer.dispose()
  const handler = channels.get('/ttds')!
  expect(await handler('start', {}, new AbortController().signal, peer)).toMatchObject({
    ok: false, error: { code: 'aborted' },
  })
  expect((await rpc('/ttds/stop')).value?.phase).toBe('idle')
  expect(runtime.getSnapshot().supervisorSessionId).toBeNull()
})

it('upgrades authenticated audio sockets, pushes snapshots, and relays text and audio cursors', async () => {
  const { origin, runtime, attached, releaseCount } = await fixture()
  const { socket, frames } = await connect(origin)
  await vi.waitFor(() => { expect(frames[0]?.type).toBe('state.snapshot') })
  expect(runtime.getPlaybackCursors().hasAudioClient).toBe(true)
  socket.send(JSON.stringify({ type: 'ping', timestampMs: 123 }))
  await vi.waitFor(() => { expect(frames).toContainEqual({ type: 'pong', timestampMs: 123 }) })
  socket.send(JSON.stringify({ type: 'input.text', text: '请回答' }))
  await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'transcript' && frame.text === '收到')).toBe(true) })
  socket.send(JSON.stringify({ type: 'audio.append', audioBase64: 3 }))
  await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'error' && frame.code === 'invalid_frame')).toBe(true) })
  expect(JSON.stringify(frames)).not.toContain('sk-transport-private')
  expect(attached.size).toBe(1)
  const closed = once(socket, 'close')
  socket.close()
  await closed
  await vi.waitFor(() => { expect(releaseCount()).toBe(1) })
  expect(runtime.getPlaybackCursors().hasAudioClient).toBe(false)
})

it('refuses unauthenticated upgrades without creating an attached peer', async () => {
  const { origin, attached } = await fixture()
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${TTDS_REALTIME_WS_PATH}`, {
    headers: { 'x-test-admit': 'deny' },
  })
  const error = await new Promise<Error>((resolve) => { socket.once('error', resolve) })
  expect(error.message).toContain('403')
  expect(attached.size).toBe(0)
})

it('unmounts RPC and upgrade routes, terminates sockets, and releases every peer during fiber disposal', async () => {
  const { origin, ctx, runtime, attached, channels, interceptors, releaseCount, cloud } = await fixture()
  const first = await connect(origin)
  const second = await connect(origin)
  first.socket.send(JSON.stringify({ type: 'session.start' }))
  await vi.waitFor(() => { expect(runtime.getSnapshot().phase).toBe('listening') })
  const closed = [once(first.socket, 'close'), once(second.socket, 'close')]
  await ctx.fiber.dispose()
  await Promise.all(closed)
  expect(attached.size).toBe(0)
  expect(channels.size).toBe(0)
  expect(interceptors.size).toBe(0)
  expect(releaseCount()).toBe(2)
  expect(cloud.clients.size).toBe(0)
})
