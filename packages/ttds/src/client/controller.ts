import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TurnDetectionMode } from '../shared/config.ts'
import type { ClientRealtimeFrame, VoiceFeedItem, VoiceSessionSnapshot } from '../shared/protocol.ts'
import { TTDS_REALTIME_WS_PATH } from '../shared/protocol.ts'
import { assertNever } from '../shared/assert-never.ts'
import { TtdsAudioEngine, type VoiceAudioAdapter } from './audio-engine.ts'
import { readServerRealtimeFrame } from './protocol-reader.ts'

/** Sanitized host config preferences mirrored from `configForms.get('ttds')` before socket connect. */
export interface HostVoicePreferences {
  readonly hasConfigCredential: boolean
  readonly turnDetection: TurnDetectionMode
  readonly startMuted: boolean
  readonly inputDeviceId: string
  readonly outputDeviceId: string
}

/** UI state shared across main-panel mounts, plugin badge, and the floating companion. */
export interface TtdsClientState {
  readonly connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  readonly snapshot: VoiceSessionSnapshot | null
  readonly feed: readonly VoiceFeedItem[]
  readonly muted: boolean
  readonly error: string | null
  readonly hostConfigReady: boolean
  readonly hostConfig: HostVoicePreferences
  readonly configRevision: number
}

/** Browser socket surface needed by the controller and injectable network tests. */
export interface RealtimeSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send: (data: string) => void
  close: () => void
}

/** Explicit browser dependencies for one controller. */
export interface TtdsClientOptions {
  createSocket: (url: string) => RealtimeSocket
  audio: VoiceAudioAdapter
  url: string
}

const DEFAULT_HOST_PREFERENCES: HostVoicePreferences = {
  hasConfigCredential: false,
  turnDetection: 'smart_turn_v2',
  startMuted: false,
  inputDeviceId: '',
  outputDeviceId: '',
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractHostPreferences(raw: unknown): HostVoicePreferences {
  if (!isObjectRecord(raw)) return DEFAULT_HOST_PREFERENCES
  const providers = isObjectRecord(raw.providers) ? raw.providers : undefined
  const qwen = providers && isObjectRecord(providers['qwen-realtime']) ? providers['qwen-realtime'] : undefined
  const hasConfigCredential = typeof qwen?.apiKey === 'string' && qwen.apiKey.trim() !== ''
  const voice = isObjectRecord(raw.voice) ? raw.voice : undefined
  const td = voice?.turnDetection
  const turnDetection: TurnDetectionMode = td === 'smart_turn_v2'
    || td === 'smart_turn'
    || td === 'server_vad'
    || td === 'push_to_talk'
    ? td
    : 'smart_turn_v2'
  const startMuted = typeof voice?.startMuted === 'boolean' ? voice.startMuted : false
  const inputDeviceId = typeof voice?.inputDeviceId === 'string' ? voice.inputDeviceId.trim() : ''
  const outputDeviceId = typeof voice?.outputDeviceId === 'string' ? voice.outputDeviceId.trim() : ''
  return { hasConfigCredential, turnDetection, startMuted, inputDeviceId, outputDeviceId }
}

/**
 * Resolve browser defaults without opening a socket or requesting microphone access.
 * @returns dependencies for a controller in the current browser origin.
 */
export function resolveClientOptions(): TtdsClientOptions {
  const url = new URL(TTDS_REALTIME_WS_PATH, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return { createSocket: address => new WebSocket(address), audio: new TtdsAudioEngine(), url: url.href }
}

/** Owns the realtime connection independently of React panel mounting. */
export class TtdsClientController {
  /** Reactive immutable UI snapshots; no hardware is owned by subscribers. */
  readonly state = createSnapshotStore<TtdsClientState>({
    connection: 'disconnected',
    snapshot: null,
    feed: [],
    muted: false,
    error: null,
    hostConfigReady: false,
    hostConfig: DEFAULT_HOST_PREFERENCES,
    configRevision: 0,
  })
  private socket: RealtimeSocket | undefined
  private disposed = false
  private generation = 0
  private inputDeviceId = ''
  private outputDeviceId = ''
  private userToggledMute = false
  private pendingMute: boolean | undefined
  private queuedUtterances: string[] = []
  private readonly feedOrder = new Map<string, number>()
  private nextFeedSeq = 0
  private hostPageForm: ConfigPageForm | undefined

  /**
   * @param ctx - plugin context providing optional navigation and config form services.
   * @param options - socket and audio dependencies resolved for this browser.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: TtdsClientOptions = resolveClientOptions(),
  ) {
    this.ctx.inject(['configForms'], (scope) => {
      const form = scope.configForms.get<Record<string, unknown>>('ttds')
      const describe = scope.configForms.describe()
      this.hostPageForm = {
        get state() { return form.getSnapshot() },
        mutate: (ops, expectedRevision) => form.mutate(ops, expectedRevision),
      }
      scope.effect(() => () => { this.hostPageForm = undefined })
      const sync = (): void => {
        if (this.disposed) return
        const snap = form.getSnapshot()
        const nsView = describe.getSnapshot().view?.namespaces.find(item => item.ns === 'ttds')
        const secretSet = nsView?.secrets.some(
          item => item.path.length === 3
            && item.path[0] === 'providers'
            && item.path[1] === 'qwen-realtime'
            && item.path[2] === 'apiKey'
            && item.set,
        ) === true
        const nextRevision = this.state.getSnapshot().configRevision + 1
        if (snap.status !== 'ready') {
          this.patch({ configRevision: nextRevision })
          return
        }
        const extracted = extractHostPreferences(snap.value)
        const prefs: HostVoicePreferences = {
          ...extracted,
          hasConfigCredential: extracted.hasConfigCredential || secretSet,
        }
        const current = this.state.getSnapshot()
        const outputChanged = this.outputDeviceId !== prefs.outputDeviceId
        this.inputDeviceId = prefs.inputDeviceId
        this.outputDeviceId = prefs.outputDeviceId
        const nextMuted = current.connection === 'disconnected' && !this.userToggledMute
          ? prefs.startMuted
          : current.muted
        this.patch({
          hostConfigReady: true,
          hostConfig: prefs,
          muted: nextMuted,
          configRevision: nextRevision,
        })
        if (outputChanged && current.connection !== 'disconnected') {
          void this.options.audio.setOutputDevice?.(this.outputDeviceId)
        }
      }
      sync()
      scope.effect(() => form.subscribe(sync))
      scope.effect(() => describe.subscribe(sync))
    })
  }

  /**
   * Return the Host-backed configuration page form when `configForms` is mounted.
   * @returns reactive form adapter for `TtdsSettingsView`, or undefined outside the Host settings runtime.
   */
  getConfigPageForm(): ConfigPageForm | undefined {
    return this.hostPageForm
  }

  /** Open this window's voice session; duplicate starts do not allocate another connection. */
  start(): void {
    if (this.disposed || this.socket !== undefined) return
    const generation = ++this.generation
    const initialSnap = this.state.getSnapshot()
    const initialMuted = this.userToggledMute ? initialSnap.muted : (initialSnap.muted || initialSnap.hostConfig.startMuted)
    this.patch({ connection: 'connecting', muted: initialMuted, error: null })
    void this.options.audio.activatePlayback(this.outputDeviceId).catch((error: unknown) => {
      if (generation === this.generation) this.fail(error)
    })
    let socket: RealtimeSocket
    try {
      socket = this.options.createSocket(this.options.url)
    } catch (error) {
      this.fail(error)
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (generation !== this.generation) return
      this.patch({ connection: 'connected' })
      this.send({ type: 'session.start', inputDeviceId: this.inputDeviceId })
      this.pendingMute = this.state.getSnapshot().muted
      this.send({ type: 'audio.mute', muted: this.pendingMute })
      if (this.queuedUtterances.length > 0) {
        const pending = this.queuedUtterances.splice(0)
        for (const utterance of pending) {
          this.send({ type: 'input.text', text: utterance })
        }
      }
    }
    socket.onmessage = (event) => {
      if (generation !== this.generation) return
      try {
        this.receive(event.data)
      } catch (error) {
        this.fail(error)
      }
    }
    socket.onerror = () => {
      if (generation === this.generation) this.fail(new Error('ttds: realtime connection failed'))
    }
    socket.onclose = () => {
      if (generation !== this.generation) return
      this.fail(new Error('ttds: realtime connection closed'))
    }
    if (!initialMuted) this.capture()
  }

  /**
   * End the session and release both capture and playback hardware.
   * @returns settlement of current audio hardware closure.
   */
  async stop(): Promise<void> {
    this.queuedUtterances = []
    this.userToggledMute = false
    this.send({ type: 'session.stop' })
    this.detachSocket()
    const defaultMuted = this.state.getSnapshot().hostConfig.startMuted
    this.patch({ connection: 'disconnected', snapshot: null, muted: defaultMuted, error: null })
    await this.closeAudio()
  }

  /** Toggle microphone capture; muting releases tracks while preserving assistant playback. */
  toggleMute(): void {
    const muted = !this.state.getSnapshot().muted
    this.userToggledMute = true
    this.pendingMute = muted
    this.patch({ muted })
    this.send({ type: 'audio.mute', muted })
    if (muted) this.options.audio.stopCapture()
    else if (this.socket !== undefined) this.capture()
  }

  /** Cancel assistant generation and immediately stop local playback. */
  interrupt(): void {
    this.options.audio.clear()
    this.send({ type: 'speech.interrupt' })
  }

  /** Commit the captured input buffer when manual turn detection is selected. */
  commitAudio(): void { this.send({ type: 'audio.commit' }) }

  /**
   * Submit a nonempty spoken-equivalent text utterance; auto-starts the session if disconnected.
   * @param text - user-entered utterance.
   * @returns whether the utterance was sent or queued for handshake completion.
   */
  sendText(text: string): boolean {
    const trimmed = text.trim()
    if (trimmed === '' || this.disposed) return false
    if (this.socket !== undefined && this.socket.readyState === 1) {
      return this.send({ type: 'input.text', text: trimmed })
    }
    this.queuedUtterances.push(trimmed)
    if (this.socket === undefined) {
      this.start()
    }
    return this.socket !== undefined
  }

  /**
   * Resolve a pending confirmation through the server.
   * @param id - confirmation token from the server snapshot.
   * @param approved - true to permit execution, false to cancel.
   * @returns nothing; the server snapshot owns confirmation removal.
   */
  respondConfirmation(id: string, approved: boolean): void {
    this.send({ type: 'confirmation.respond', confirmationId: id, approved })
  }

  /** Navigate to the host-owned plugin configuration page when available. */
  openPluginSettings(): void { this.ctx.get('pluginNavigation')?.openBundle('@whyself/ttds') }

  /** Select the voice main panel without changing the active code session. */
  openVoiceStage(): void { this.ctx.get('layout')?.selectPanel('ttds' as MainPanelId) }

  /**
   * Withdraw all connection callbacks and join media cleanup, including late microphone grants.
   * @returns settlement after the instance has no admitted media work remaining.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.queuedUtterances = []
    this.feedOrder.clear()
    this.nextFeedSeq = 0
    this.detachSocket()
    await this.options.audio.dispose()
  }

  private capture(): void {
    const generation = this.generation
    void this.options.audio.startCapture((audioBase64) => {
      if (generation === this.generation) this.send({ type: 'audio.append', audioBase64 })
    }, this.inputDeviceId).catch((error: unknown) => {
      if (generation === this.generation) this.fail(error)
    })
  }

  private detachSocket(): void {
    this.generation++
    this.pendingMute = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.close()
  }

  private send(frame: ClientRealtimeFrame): boolean {
    if (this.socket === undefined || this.socket.readyState !== 1) return false
    this.socket.send(JSON.stringify(frame))
    return true
  }

  private receive(data: unknown): void {
    const frame = readServerRealtimeFrame(data)
    switch (frame.type) {
      case 'state.snapshot': {
        const previousMuted = this.state.getSnapshot().muted
        const deviceChanged = this.inputDeviceId !== frame.snapshot.config.voice.inputDeviceId
        const outputChanged = this.outputDeviceId !== frame.snapshot.config.voice.outputDeviceId
        this.patch({ snapshot: frame.snapshot })
        this.inputDeviceId = frame.snapshot.config.voice.inputDeviceId
        this.outputDeviceId = frame.snapshot.config.voice.outputDeviceId
        if (outputChanged) {
          void this.options.audio.setOutputDevice?.(this.outputDeviceId)
        }
        if (this.pendingMute !== undefined && frame.snapshot.muted !== this.pendingMute) return
        this.pendingMute = undefined
        this.patch({ muted: frame.snapshot.muted })
        if (frame.snapshot.muted && !previousMuted) this.options.audio.stopCapture()
        else if (!frame.snapshot.muted && (previousMuted || deviceChanged)) this.capture()
        return
      }
      case 'transcript': {
        const id = `transcript:${frame.role}:${frame.itemId}`
        if (!this.feedOrder.has(id)) {
          this.feedOrder.set(id, ++this.nextFeedSeq)
        }
        if (frame.text.trim() === '') {
          return
        }
        this.upsertFeed({
          id,
          timestampMs: Date.now(),
          kind: frame.role === 'user' ? 'transcript_user' : 'transcript_assistant',
          text: frame.text,
        })
        return
      }
      case 'feed.item':
        this.upsertFeed(frame.item)
        return
      case 'audio.delta':
        this.options.audio.play(frame.pcm24kBase64, () => {
          this.send({ type: 'playback.drained', playbackSeq: frame.audioSeq, responseId: frame.responseId })
        })
        return
      case 'audio.clear':
        this.options.audio.clear()
        return
      case 'error':
        this.fail(new Error(frame.message))
        return
      case 'pong':
        return
      default:
        assertNever(frame)
    }
  }

  private upsertFeed(item: VoiceFeedItem): void {
    let order = this.feedOrder.get(item.id)
    if (order === undefined) {
      order = ++this.nextFeedSeq
      this.feedOrder.set(item.id, order)
    }
    const feed = [...this.state.getSnapshot().feed]
    const index = feed.findIndex(entry => entry.id === item.id)
    if (index >= 0) {
      feed[index] = item
    } else {
      const insertAt = feed.findIndex(entry => (this.feedOrder.get(entry.id) ?? 0) > order)
      if (insertAt < 0) feed.push(item)
      else feed.splice(insertAt, 0, item)
    }
    const clipped = feed.slice(-200)
    if (feed.length > 200) {
      for (const dropped of feed.slice(0, feed.length - 200)) {
        this.feedOrder.delete(dropped.id)
      }
    }
    this.patch({ feed: clipped })
  }

  private patch(patch: Partial<TtdsClientState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.queuedUtterances = []
    this.detachSocket()
    void this.closeAudio()
    this.patch({ connection: 'error', error: error instanceof Error ? error.message : String(error) })
  }

  private async closeAudio(): Promise<void> {
    try {
      await this.options.audio.close()
    } catch (error) {
      if (!this.disposed) {
        this.patch({
          connection: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
