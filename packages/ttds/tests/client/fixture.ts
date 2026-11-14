import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { VoiceSessionSnapshot, ServerRealtimeFrame } from '../../src/shared/protocol.ts'
import { resolveTtdsConfig, toClientSafeConfigView } from '../../src/shared/config.ts'
import { TtdsAudioEngine, type AudioEngineOptions } from '../../src/client/audio-engine.ts'
import { TtdsClientController, type RealtimeSocket } from '../../src/client/controller.ts'
import { zh, type TtdsLocaleKey } from '../../src/client/locales.ts'

function loadClient(specifier: string): unknown {
  const require = createRequire(import.meta.url)
  let loaded: unknown
  runInNewContext(readFileSync(require.resolve(specifier), 'utf8'), {
    document, navigator, console, process, queueMicrotask, setTimeout, clearTimeout,
    window: {
      __ModuleLoader__: {
        load: (entry: { factory: (require: (id: string) => unknown) => unknown }) => {
          loaded = entry.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(id))
        },
      },
    },
  })
  return loaded
}

function hardware<T extends object>(members: Partial<T>): T {
  return members as T
}

/** Controllable network endpoint exposing the frames actually sent by the client. */
export class TestSocket implements RealtimeSocket {
  readyState = 0
  onopen: RealtimeSocket['onopen'] = null
  onmessage: RealtimeSocket['onmessage'] = null
  onerror: RealtimeSocket['onerror'] = null
  onclose: RealtimeSocket['onclose'] = null
  readonly sent: Record<string, unknown>[] = []
  closed = false
  /** Complete the fake network handshake. */
  open(): void { this.readyState = 1; this.onopen?.(new Event('open')) }
  /**
   * Deliver one Host frame.
   * @param frame - server wire frame.
   * @returns nothing.
   */
  receive(frame: ServerRealtimeFrame): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })) }
  /**
   * Record the client wire output.
   * @param data - serialized JSON frame.
   * @returns nothing.
   */
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>) }
  /** Close the fake socket. */
  close(): void { this.closed = true; this.readyState = 3 }
}

/** Deterministic playback source with observable schedule and stopped state. */
export class TestSource {
  buffer: AudioBuffer | null = null
  onended: AudioBufferSourceNode['onended'] = null
  when = -1
  stopped = false
  disconnected = false
  /** Attach the source to its destination. */
  connect(): AudioNode { return hardware<AudioNode>({}) }
  /** Detach the source from the graph. */
  disconnect(): void { this.disconnected = true }
  /**
   * Record the start time.
   * @param when - requested AudioContext timeline position.
   * @returns nothing.
   */
  start(when: number): void { this.when = when }
  /** Stop the source without an audible drain acknowledgement. */
  stop(): void { this.stopped = true }
  /** Complete audible playback. */
  end(): void { this.onended?.call(hardware<AudioBufferSourceNode>(this), new Event('ended')) }
}

/**
 * Create hardware boundaries with permission under test control and real engine resource ownership.
 * @returns the engine plus track, worklet and context observations.
 */
export function audioFixture() {
  const track = {
    readyState: 'live',
    stop() { this.readyState = 'ended' },
  }
  const stream = { getTracks: () => [track] } as MediaStream
  let grant: (stream: MediaStream) => void = () => { throw new Error('no pending permission') }
  let permission: Promise<MediaStream> = Promise.resolve(stream)
  let moduleLoad: () => Promise<void> = () => Promise.resolve()
  let resume: () => Promise<void> = () => Promise.resolve()
  const contexts: {
    state: string
    sinkId: string
    sources: TestSource[]
    sampleRate: number
    port: { onmessage: ((event: MessageEvent<unknown>) => void) | null; closed: boolean; close: () => void }
  }[] = []
  const urls: string[] = []
  const revoked: string[] = []
  const options: AudioEngineOptions = {
    getUserMedia: () => permission,
    createModuleUrl: () => { const url = `blob:audio-${urls.length}`; urls.push(url); return url },
    revokeModuleUrl: (url) => { revoked.push(url) },
    createContext: () => {
      const context = {
        state: 'running' as AudioContextState,
        sinkId: '',
        sampleRate: 48000,
        currentTime: 4,
        destination: hardware<AudioDestinationNode>({}),
        sources: [] as TestSource[],
        port: {
          onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
          closed: false,
          close() { this.closed = true },
        },
        setSinkId(sinkId: string) {
          this.sinkId = sinkId
          return Promise.resolve()
        },
        resume: () => resume(),
        close() { this.state = 'closed'; return Promise.resolve() },
        audioWorklet: { addModule: () => moduleLoad() },
        createMediaStreamSource: () => hardware<MediaStreamAudioSourceNode>({
          connect: () => hardware<AudioNode>({}), disconnect() {},
        }),
        createBuffer: (_channels: number, size: number, rate: number) => {
          const samples = new Float32Array(size)
          return {
            duration: size / rate, length: size, numberOfChannels: 1, sampleRate: rate, getChannelData: () => samples,
            copyFromChannel(destination: Float32Array) { destination.set(samples) },
            copyToChannel(source: Float32Array) { samples.set(source) },
          }
        },
        createBufferSource() {
          const source = new TestSource()
          this.sources.push(source)
          return hardware<AudioBufferSourceNode>(source)
        },
      }
      contexts.push(context)
      return hardware<AudioContext>(context)
    },
    createWorkletNode: () => {
      const context = contexts.at(-1)
      if (context === undefined) throw new Error('missing audio context')
      return hardware<AudioWorkletNode>({
        port: hardware<MessagePort>(context.port), connect: () => hardware<AudioNode>({}), disconnect() {},
      })
    },
  }
  return {
    engine: new TtdsAudioEngine(options), options, track, contexts, urls, revoked,
    deferPermission: () => { permission = new Promise<MediaStream>((resolve) => { grant = resolve }) },
    grant: () => { grant(stream) },
    setModuleLoad: (load: () => Promise<void>) => { moduleLoad = load },
    setResume: (next: () => Promise<void>) => { resume = next },
  }
}

/**
 * Build a complete Host snapshot using production configuration resolution.
 * @param patch - state fields to override.
 * @returns typed server snapshot.
 */
export function snapshot(patch: Partial<VoiceSessionSnapshot> = {}): VoiceSessionSnapshot {
  return {
    supervisorSessionId: 'supervisor-1', connectionEpoch: 1, phase: 'listening', providerReady: true,
    statusReason: null, muted: false, inputAdmissionSeq: 0, pendingToolCount: 0, pendingConfirmations: [],
    config: toClientSafeConfigView(resolveTtdsConfig({}, {})), ...patch,
  }
}

/**
 * Translate component copy with the production Chinese dictionary.
 * @param key - dictionary key.
 * @param params - interpolation arguments.
 * @returns localized string.
 */
export function t(key: TtdsLocaleKey, params?: Record<string, unknown>): string {
  return zh[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  })
}

type RootSlotNames = 'main' | 'sidebar.panellist' | 'shell.overlay' | 'plugins.bundle.config' | 'plugins.detail.badge'

/**
 * Create real Cordis, locale and slot services with injectable network and hardware.
 * @returns the owned root and test-controlled controller dependencies.
 */
export function clientFixture() {
  const ctx = new Context()
  const { SlotRegistry } = loadClient(
    '@deepseek-ai/dsh-client-ui-renderer/client',
  ) as typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
  const { LocaleRuntime } = loadClient(
    '@deepseek-ai/dsh-client-locale/client',
  ) as typeof import('@deepseek-ai/dsh-client-locale/client')
  new SlotRegistry(ctx)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'plugins.detail.badge': { kind: 'list', scope: 'root' },
    },
  }, (props: PropsRenderSlots<RootSlotNames>) => [
    props.renderSlot('main', {}, { entryKey: 'ttds' }),
    props.renderSlot('sidebar.panellist', { size: 16, active: false }),
    props.renderSlot('shell.overlay', {}),
    props.renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: '@whyself/ttds' }),
  ])
  const socket = new TestSocket()
  const audio = audioFixture()
  const options = { createSocket: () => socket, audio: audio.engine, url: 'wss://example.test/api/ttds/realtime' }
  const controller = new TtdsClientController(ctx, options)
  return { ctx, socket, audio, options, controller }
}

/**
 * Create a real form page surface whose mutation output is observable.
 * @returns page form and the accepted atomic writes.
 */
export function formFixture() {
  const value = resolveTtdsConfig({}, {})
  const writes: { ops: Parameters<ConfigPageForm['mutate']>[0]; revision: number | undefined }[] = []
  const form: ConfigPageForm = {
    state: { status: 'ready', value: { ...value }, base: { ...value }, user: {}, writable: true, revision: 12 },
    mutate: (ops, revision) => { writes.push({ ops, revision }); return Promise.resolve(true) },
  }
  return { form, writes }
}
