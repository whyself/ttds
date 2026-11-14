import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  assertNever,
  resolveTtdsConfig,
  toClientSafeConfigView,
  type ClientRealtimeFrame,
  type ConsumerLease,
  type ResolvedTtdsConfig,
  type ServerRealtimeFrame,
  type SupervisorJournalRecord,
  type TtdsConfig,
  type VoiceAdapterEvent,
  type VoiceAdapterSession,
  type VoiceAdapterSessionConfig,
  type VoiceFeedItem,
  type VoicePendingUiConfirmationView,
  type VoicePlaybackCursors,
  type VoiceRuntimeAdapter,
  type VoiceRuntimeServiceContract,
  type VoiceSessionSnapshot,
  type VoiceTurnPhase,
} from '../shared/index.ts'
import { redactText, SupervisorSessionJournal } from './journal.ts'
import { QwenRealtimeAdapter } from './qwen-adapter.ts'

interface ActiveSession {
  readonly session: VoiceAdapterSession
  readonly epoch: number
  readonly controller: AbortController
  readonly unsubscribe: () => void
}

function isUnfulfilledToolPromise(transcript: string): boolean {
  const compact = transcript.replace(/\s+/gu, '').trim()
  if (compact.length < 2 || compact.length > 90) return false
  return /(?:我这就(?:去|开|创建|让|发|批|查|搜|帮|调|看)|这就(?:去|开|创建|让DSH|帮你|发过去)|马上(?:去|开|创建|帮你查|帮你搜|发过去)|好(?:的|嘞)?，?我这就)/u.test(compact)
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}…`
}

function compactJson(value: unknown, maxChars: number): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return compactText(value, maxChars)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return compactText(String(value), maxChars)
  }
  try {
    return compactText(JSON.stringify(value), maxChars)
  } catch {
    // Non-serializable payloads should not prevent history reconstruction.
    return '[unserializable]'
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function buildRestoredHistoryContext(
  records: readonly SupervisorJournalRecord[],
  maxHistoryTurns: number,
): { readonly text: string; readonly count: number } | null {
  const calls = new Map<string, { readonly name: string; readonly argumentsJson: string }>()
  for (const record of records) {
    if (record.kind !== 'tool.call') continue
    const callId = typeof record.payload.callId === 'string' ? record.payload.callId : ''
    if (callId === '') continue
    const name = typeof record.payload.toolName === 'string' && record.payload.toolName !== ''
      ? record.payload.toolName
      : (typeof record.payload.name === 'string' ? record.payload.name : '')
    let argumentsJson = ''
    if (typeof record.payload.argumentsJson === 'string') {
      argumentsJson = record.payload.argumentsJson
    } else if (record.payload.args !== undefined) {
      argumentsJson = compactJson(record.payload.args, 140)
    }
    calls.set(callId, { name, argumentsJson })
  }

  const lines: string[] = []
  for (const record of records) {
    switch (record.kind) {
      case 'user.text':
      case 'user.transcript': {
        const text = typeof record.payload.text === 'string' ? record.payload.text : ''
        if (text.trim() !== '' && text !== '（音频转写失败）') {
          lines.push(`[用户] ${compactText(text, 320)}`)
        }
        break
      }
      case 'assistant.transcript': {
        const text = typeof record.payload.text === 'string' ? record.payload.text : ''
        if (text.trim() !== '') {
          lines.push(`[助手] ${compactText(text, 320)}`)
        }
        break
      }
      case 'tool.output': {
        const callId = typeof record.payload.callId === 'string' ? record.payload.callId : ''
        const paired = callId !== '' ? calls.get(callId) : undefined
        const toolName = typeof record.payload.toolName === 'string' && record.payload.toolName !== ''
          ? record.payload.toolName
          : (paired?.name ?? '')
        const argsSummary = paired !== undefined && paired.argumentsJson !== '' ? compactText(paired.argumentsJson, 120) : ''
        const outputSummary = compactJson(record.payload.output, 160)
        if (toolName !== '' || outputSummary !== '') {
          const formatted = argsSummary !== ''
            ? `[工具 ${toolName || 'tool'}] 参数=${argsSummary} -> 结果=${outputSummary}`
            : `[工具 ${toolName || 'tool'}] 结果=${outputSummary}`
          lines.push(compactText(formatted, 260))
        }
        break
      }
      case 'hook.injected': {
        if (record.payload.kind === 'tool_promise_nudge' || record.payload.kind === 'history_restored') break
        const summaryText = typeof record.payload.summaryText === 'string' ? record.payload.summaryText : ''
        if (summaryText.trim() !== '') {
          lines.push(`[后台事件] ${compactText(summaryText, 240)}`)
        }
        break
      }
      case 'session.started':
      case 'session.rotated':
      case 'session.ended':
      case 'tool.call':
      case 'tool.confirmation':
      case 'error':
        break
      default:
        assertNever(record.kind)
    }
  }

  if (lines.length === 0) return null
  const maxItems = Math.min(Math.max(maxHistoryTurns * 2, 12), 60)
  const maxTotalChars = 4800
  const selectedReversed: string[] = []
  let totalChars = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    if (selectedReversed.length >= maxItems) break
    const line = lines[index]
    if (line === undefined) continue
    const addedChars = line.length + (selectedReversed.length > 0 ? 1 : 0)
    if (totalChars + addedChars > maxTotalChars) {
      if (selectedReversed.length === 0) selectedReversed.push(compactText(line, maxTotalChars))
      break
    }
    selectedReversed.push(line)
    totalChars += addedChars
  }
  const selected = selectedReversed.reverse()
  return {
    count: selected.length,
    text: `【历史对话恢复】以下是上一轮语音会话关闭前的最近对话与后台会话操作记录，仅供接续上下文参考（请勿主动向用户复述，待用户发言时自然衔接）：\n${selected.join('\n')}`,
  }
}

function buildHookModelText(summaryText: string, metadata: Readonly<Record<string, unknown>>): string {
  const refs: string[] = []
  const seen = new Set<string>()
  const pushRef = (sessionId: string, approvalId = ''): void => {
    const trimmedSession = sessionId.trim()
    if (trimmedSession === '') return
    const trimmedApproval = approvalId.trim()
    const formatted = trimmedApproval !== ''
      ? `sessionId=${trimmedSession}, approvalId=${trimmedApproval}`
      : `sessionId=${trimmedSession}`
    if (seen.has(formatted)) return
    seen.add(formatted)
    refs.push(formatted)
  }
  const events = metadata.events
  if (Array.isArray(events)) {
    for (const item of events) {
      if (!isPlainRecord(item)) continue
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
      const itemMeta = isPlainRecord(item.metadata) ? item.metadata : undefined
      const approvalId = itemMeta && typeof itemMeta.approvalId === 'string' ? itemMeta.approvalId : ''
      pushRef(sessionId, approvalId)
    }
  }
  if (refs.length === 0 && typeof metadata.sessionId === 'string') {
    const approvalId = typeof metadata.approvalId === 'string' ? metadata.approvalId : ''
    pushRef(metadata.sessionId, approvalId)
  }
  return refs.length > 0 ? `${summaryText}（关联会话标识：${refs.join('；')}）` : summaryText
}

/** Host-owned voice sessions, ordered text journals, confirmation cursors, and consumer lifecycle leases. */
export class VoiceRuntimeService implements VoiceRuntimeServiceContract {
  private config: ResolvedTtdsConfig
  private readonly adapters = new Map<string, VoiceRuntimeAdapter>()
  private readonly frames = new Set<(frame: ServerRealtimeFrame) => void>()
  private readonly stateListeners = new Set<(snapshot: VoiceSessionSnapshot) => void>()
  private readonly leases = new Map<AbortController, Promise<void>>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly journals = new Map<string, SupervisorSessionJournal>()
  private readonly journalDirectories = new Map<string, string>()
  private readonly candidates = new Set<AbortController>()
  private readonly sensitiveStrings: string[] = []
  private active: ActiveSession | null = null
  private journal: SupervisorSessionJournal | null = null
  private supervisorSessionId: string | null = null
  private startTask: Promise<VoiceSessionSnapshot> | null = null
  private eventTail: Promise<void> = Promise.resolve()
  private disposing = false
  private connectionEpoch = 0
  private inputAdmissionSeq = 0
  private lastRespondedInputSeq = 0
  private lastToolNudgeInputSeq = 0
  private emittedAudioSeq = 0
  private drainedAudioSeq = 0
  private audioClientCount = 0
  private muted = false
  private userSpeaking = false
  private responseActive = false
  private turnFallbackTimer: ReturnType<typeof setTimeout> | undefined
  private toolNudgeTimer: ReturnType<typeof setTimeout> | undefined
  private journalRevision = 0
  private phase: VoiceTurnPhase = 'idle'
  private statusReason: string | null = null
  private pendingConfirmations: readonly VoicePendingUiConfirmationView[] = []
  private readonly toolOrigins = new Map<string, number>()
  private readonly transcripts = new Map<string, string>()

  /**
   * Register the service and built-in Qwen adapter on the owning Cordis fiber.
   * @param ctx - plugin context owning all registrations and shutdown.
   * @param config - raw or already resolved plugin configuration.
   */
  constructor(private readonly ctx: Context, config: TtdsConfig | ResolvedTtdsConfig = {}) {
    this.config = config.voice && 'mergedInstructions' in config.voice
      ? config as ResolvedTtdsConfig
      : resolveTtdsConfig(config)
    this.sensitiveStrings.push(this.config.providers['qwen-realtime'].apiKey)
    this.adapters.set('qwen-realtime', new QwenRealtimeAdapter())
    const provision = (): (() => void) => ctx.provide('ttdsRuntime', this)
    const closeAdmission = (): void => { this.beginDispose() }
    const cleanup = (): Promise<void> => this.dispose()
    ctx.effect(function* () {
      yield cleanup
      yield provision()
      yield closeAdmission
    })
  }

  /**
   * Read the resolved Host configuration, including server-only credentials.
   * @returns active configuration snapshot.
   */
  getConfig(): ResolvedTtdsConfig {
    return this.config
  }

  /**
   * Project current runtime state without raw provider credentials.
   * @returns immutable session snapshot for RPC and WebSocket clients.
   */
  getSnapshot(): VoiceSessionSnapshot {
    const readiness = this.adapters.get(this.config.provider)?.checkReadiness(this.config)
    return {
      supervisorSessionId: this.supervisorSessionId,
      connectionEpoch: this.connectionEpoch,
      phase: this.phase,
      providerReady: readiness?.ready ?? false,
      statusReason: this.statusReason ?? readiness?.reason ?? (readiness ? null : '未注册语音提供方'),
      muted: this.muted,
      inputAdmissionSeq: this.inputAdmissionSeq,
      pendingToolCount: this.toolOrigins.size,
      pendingConfirmations: this.pendingConfirmations,
      config: toClientSafeConfigView(this.config),
    }
  }

  /**
   * Read monotonic input and playback progress cursors.
   * @returns current connection and audio cursors.
   */
  getPlaybackCursors(): VoicePlaybackCursors {
    return {
      connectionEpoch: this.connectionEpoch,
      inputAdmissionSeq: this.inputAdmissionSeq,
      emittedAudioSeq: this.emittedAudioSeq,
      drainedAudioSeq: this.drainedAudioSeq,
      hasAudioClient: this.audioClientCount > 0,
    }
  }

  /**
   * Retain underlying resources until a consumer finishes its abort cleanup.
   * @returns a release-once lease, or null after shutdown admission closes.
   */
  acquireLease(): ConsumerLease | null {
    if (this.disposing) return null
    const controller = new AbortController()
    let releaseWait: () => void = () => {}
    const completion = new Promise<void>((resolve) => { releaseWait = resolve })
    this.leases.set(controller, completion)
    return {
      signal: controller.signal,
      release: () => {
        this.leases.delete(controller)
        releaseWait()
      },
    }
  }

  /**
   * Register a unique provider on this instance.
   * @param adapter - provider factory.
   * @returns idempotent provider removal function.
   */
  registerAdapter(adapter: VoiceRuntimeAdapter): () => void {
    if (this.disposing) throw new Error('ttds: runtime is disposing')
    if (this.adapters.has(adapter.id)) throw new Error(`ttds: duplicate voice adapter "${adapter.id}"`)
    this.adapters.set(adapter.id, adapter)
    return () => {
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id)
    }
  }

  /**
   * Subscribe to server frames until explicitly released or runtime disposal.
   * @param listener - synchronous frame consumer.
   * @returns listener removal function.
   */
  subscribeFrames(listener: (frame: ServerRealtimeFrame) => void): () => void {
    if (this.disposing) return () => {}
    this.frames.add(listener)
    return () => { this.frames.delete(listener) }
  }

  /**
   * Subscribe to phase and snapshot transitions.
   * @param listener - synchronous state consumer.
   * @returns listener removal function.
   */
  onStateChange(listener: (snapshot: VoiceSessionSnapshot) => void): () => void {
    if (this.disposing) return () => {}
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /**
   * Report the transport's live authenticated audio socket count.
   * @param count - number of attached sockets, including idle listeners.
   */
  setAudioClientCount(count: number): void {
    this.audioClientCount = Math.max(0, count)
    if (this.audioClientCount === 0 && this.phase === 'speaking' && !this.responseActive) {
      this.phase = 'listening'
      this.changed()
    }
  }

  private broadcast(frame: ServerRealtimeFrame): void {
    for (const listener of this.frames) listener(frame)
  }

  private clearClientAudio(reason: 'barge_in' | 'interrupted' | 'session_closed'): void {
    this.drainedAudioSeq = this.emittedAudioSeq
    this.broadcast({ type: 'audio.clear', reason })
  }

  private changed(): void {
    const snapshot = this.getSnapshot()
    this.broadcast({ type: 'state.snapshot', snapshot })
    for (const listener of this.stateListeners) listener(snapshot)
  }

  private sessionConfig(): VoiceAdapterSessionConfig {
    const qwen = this.config.providers['qwen-realtime']
    return {
      instructions: this.config.voice.mergedInstructions,
      voice: qwen.voice,
      turnDetection: this.config.voice.turnDetection,
      threshold: this.config.voice.threshold,
      silenceDurationMs: this.config.voice.silenceDurationMs,
      maxHistoryTurns: qwen.maxHistoryTurns,
      tools: this.ctx.get('ttdsTools')?.listUpstreamSpecs() ?? [],
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.tasks.add(operation)
    void operation.then(
      () => { this.tasks.delete(operation) },
      () => { this.tasks.delete(operation) },
    )
    return operation
  }

  private isCurrent(active: ActiveSession): boolean {
    return !this.disposing && this.active === active && this.connectionEpoch === active.epoch
  }

  private canPromote(epoch: number): boolean {
    return !this.disposing && this.connectionEpoch === epoch
  }

  private safeError(error: unknown): string {
    return redactText(error instanceof Error ? error.message : '语音操作失败', this.sensitiveStrings)
  }

  private reportError(error: unknown): void {
    this.statusReason = this.safeError(error)
    this.phase = 'error'
    this.broadcast({ type: 'error', code: 'runtime_error', message: this.statusReason })
    this.changed()
  }

  /**
   * Start a configured upstream connection once, coalescing simultaneous starts.
   * @param options - optional browser input-device preference.
   * @returns live session snapshot, or a rejected setup operation.
   */
  startSession(options: { readonly inputDeviceId?: string } = {}): Promise<VoiceSessionSnapshot> {
    if (this.disposing) return Promise.reject(new Error('ttds: runtime is disposing'))
    if (this.active) return Promise.resolve(this.getSnapshot())
    if (this.startTask) return this.startTask
    const operation = this.openSession(options)
    this.startTask = operation
    void operation.then(
      () => { if (this.startTask === operation) this.startTask = null },
      () => { if (this.startTask === operation) this.startTask = null },
    )
    return this.track(operation)
  }

  private async openSession(options: { readonly inputDeviceId?: string }): Promise<VoiceSessionSnapshot> {
    const adapter = this.adapters.get(this.config.provider)
    if (!adapter) throw new Error(`ttds: unregistered voice provider "${this.config.provider}"`)
    const readiness = adapter.checkReadiness(this.config)
    if (!readiness.ready) throw new Error(readiness.reason ?? 'ttds: voice provider is not ready')
    const epoch = ++this.connectionEpoch
    const controller = new AbortController()
    this.candidates.add(controller)
    const id = randomUUID()
    const journal = new SupervisorSessionJournal(this.config.storageDir, id, this.sensitiveStrings)
    this.journals.set(id, journal)
    this.journalDirectories.set(id, this.config.storageDir)
    this.journal = journal
    this.supervisorSessionId = id
    this.phase = 'connecting'
    this.statusReason = null
    this.changed()
    const spec = this.sessionConfig()
    let session: VoiceAdapterSession
    try {
      session = await adapter.connect(this.config, spec, controller.signal)
    } catch (error) {
      this.candidates.delete(controller)
      if (this.connectionEpoch === epoch && !this.disposing) {
        await journal.append('error', { message: this.safeError(error) })
        this.reportError(error)
      }
      throw error
    }
    this.candidates.delete(controller)
    if (this.disposing || controller.signal.aborted || this.connectionEpoch !== epoch) {
      await session.close()
      return this.getSnapshot()
    }
    try {
      await journal.append('session.started', { ...spec, provider: adapter.id, inputDeviceId: options.inputDeviceId })
    } catch (error) {
      await session.close()
      throw error
    }
    if (!this.canPromote(epoch)) {
      await session.close()
      return this.getSnapshot()
    }
    await Promise.allSettled([...this.journals.values()].map(entry => entry.flush()))
    if (!this.canPromote(epoch)) {
      await session.close()
      return this.getSnapshot()
    }
    const priorRecords = await SupervisorSessionJournal.readRecentHistory(this.config.storageDir, {
      excludeSessionId: id,
      maxSessions: 5,
    })
    if (!this.canPromote(epoch)) {
      await session.close()
      return this.getSnapshot()
    }
    const restored = buildRestoredHistoryContext(priorRecords, spec.maxHistoryTurns)
    if (restored !== null) {
      try {
        await journal.append('hook.injected', {
          kind: 'history_restored',
          restoredCount: restored.count,
          summaryText: restored.text,
        })
        if (!this.canPromote(epoch)) {
          await session.close()
          return this.getSnapshot()
        }
        await session.sendContextNotification(restored.text, false)
      } catch (error) {
        await session.close()
        throw error
      }
      if (!this.canPromote(epoch)) {
        await session.close()
        return this.getSnapshot()
      }
    }
    this.attach(session, epoch, controller)
    this.phase = 'listening'
    this.changed()
    return this.getSnapshot()
  }

  private attach(session: VoiceAdapterSession, epoch: number, controller: AbortController): void {
    const unsubscribe = session.onEvent((event) => {
      if (this.disposing || this.active?.epoch !== epoch || this.connectionEpoch !== epoch) return
      const operation = this.eventTail.then(async () => {
        if (this.disposing || this.active?.epoch !== epoch || this.connectionEpoch !== epoch) return
        await this.processEvent(event, epoch)
      })
      this.eventTail = operation.catch((error: unknown) => {
        if (this.connectionEpoch === epoch && !this.disposing) this.reportError(error)
      })
      void this.track(this.eventTail)
    })
    this.active = { session, epoch, controller, unsubscribe }
  }

  /**
   * Invalidate callbacks immediately, then close the upstream and persist the session ending.
   * @param reason - structured stop reason.
   * @returns disconnected state after all preceding journal writes.
   */
  stopSession(reason = 'user'): Promise<VoiceSessionSnapshot> {
    return this.track(this.stop(reason))
  }

  private async stop(reason: string): Promise<VoiceSessionSnapshot> {
    const stopEpoch = ++this.connectionEpoch
    this.startTask = null
    this.clearTurnFallbackTimer()
    this.clearToolNudgeTimer()
    for (const candidate of this.candidates) candidate.abort()
    const active = this.active
    const journal = this.journal
    this.active = null
    this.journal = null
    this.phase = 'idle'
    this.userSpeaking = false
    this.responseActive = false
    this.lastRespondedInputSeq = 0
    this.lastToolNudgeInputSeq = 0
    this.pendingConfirmations = []
    this.toolOrigins.clear()
    this.transcripts.clear()
    this.clearClientAudio('session_closed')
    this.changed()
    if (active) {
      active.unsubscribe()
      active.controller.abort()
      await active.session.close()
    }
    await this.ctx.get('ttdsTools')?.cancelAll(reason)
    this.ctx.get('ttdsHooks')?.clear()
    if (journal) await journal.append('session.ended', { reason })
    if (this.connectionEpoch === stopEpoch) {
      this.supervisorSessionId = null
      this.changed()
    }
    return this.getSnapshot()
  }

  /**
   * Admit a validated browser frame through the authoritative Host state.
   * @param frame - shared client protocol frame.
   * @param fromAudioClient - whether this frame came from authenticated Web Audio transport.
   * @returns completion of the requested operation.
   */
  async handleClientFrame(frame: ClientRealtimeFrame, fromAudioClient = false): Promise<void> {
    if (this.disposing) throw new Error('ttds: runtime is disposing')
    switch (frame.type) {
      case 'session.start':
        await this.startSession(frame)
        break
      case 'session.stop':
        await this.stopSession()
        break
      case 'input.text':
        await this.sendTextUtterance(frame.text, { autoStart: true })
        break
      case 'audio.append':
        if (this.active && !this.muted) {
          await this.track(this.active.session.appendAudio(frame.audioBase64))
        }
        break
      case 'audio.commit':
        if (this.active && !this.muted) {
          this.clearTurnFallbackTimer()
          this.lastRespondedInputSeq = this.inputAdmissionSeq
          this.phase = 'thinking'
          this.changed()
          await this.track(this.active.session.commitAudio())
        }
        break
      case 'audio.mute':
        this.muted = frame.muted
        this.changed()
        if (frame.muted && this.userSpeaking && this.active) await this.rotate()
        break
      case 'speech.interrupt':
        this.clearClientAudio('interrupted')
        if (this.active && (this.phase === 'thinking' || this.phase === 'speaking')) {
          await this.track(this.active.session.cancelResponse())
        }
        break
      case 'playback.drained':
        if (fromAudioClient && Number.isSafeInteger(frame.playbackSeq) && frame.playbackSeq >= 0) {
          this.drainedAudioSeq = Math.max(this.drainedAudioSeq, Math.min(frame.playbackSeq, this.emittedAudioSeq))
          if (this.drainedAudioSeq === this.emittedAudioSeq && this.phase === 'speaking' && !this.responseActive) {
            this.phase = 'listening'
          }
          this.changed()
        }
        break
      case 'confirmation.respond':
        await this.ctx.get('ttdsTools')?.resolveUiConfirmation(frame.confirmationId, frame.approved)
        break
      case 'ping':
        this.broadcast({ type: 'pong', timestampMs: frame.timestampMs })
        break
      default: assertNever(frame)
    }
  }

  /**
   * Persist and admit a spoken-equivalent user text turn without waiting for background tools.
   * @param text - nonempty user utterance.
   * @param options - whether a missing session should start automatically.
   * @returns admission result and monotonic input sequence.
   */
  async sendTextUtterance(text: string, options: { readonly autoStart?: boolean } = {}): Promise<{
    readonly accepted: boolean
    readonly inputAdmissionSeq: number
  }> {
    if (this.disposing || text.trim() === '') return { accepted: false, inputAdmissionSeq: this.inputAdmissionSeq }
    if (!this.active && options.autoStart) await this.startSession()
    const active = this.active
    if (!active || !this.isCurrent(active)) return { accepted: false, inputAdmissionSeq: this.inputAdmissionSeq }
    const seq = ++this.inputAdmissionSeq
    this.lastRespondedInputSeq = seq
    this.clearTurnFallbackTimer()
    this.clearToolNudgeTimer()
    await this.appendJournal('user.text', { text, inputAdmissionSeq: seq })
    if (!this.isCurrent(active)) return { accepted: false, inputAdmissionSeq: seq }
    this.phase = 'thinking'
    this.changed()
    this.broadcast({ type: 'transcript', role: 'user', text, final: true, itemId: `text_${seq}` })
    await this.track(active.session.sendUserText(text))
    return { accepted: true, inputAdmissionSeq: seq }
  }

  /**
   * Persist a tool completion and await its upstream acknowledgement on the original connection.
   * @param callId - original function call identifier.
   * @param toolName - registered tool name for journal reconstruction.
   * @param output - JSON-serializable tool result.
   * @returns true only when delivered to the current connection.
   */
  async submitToolResult(callId: string, toolName: string, output: unknown): Promise<boolean> {
    const active = this.active
    const origin = this.toolOrigins.get(callId)
    await this.appendJournal('tool.output', { callId, toolName, output })
    if (!active || this.disposing) return false
    if (origin !== undefined && origin !== active.epoch) {
      this.bridgeToolOutput(callId, toolName, output)
      return false
    }
    try {
      await this.track(active.session.submitToolOutput(callId, JSON.stringify(output), active.controller.signal))
    } catch (error) {
      if (this.isCurrent(active)) throw error
      if (this.canPromote(this.connectionEpoch) && this.active !== null) this.bridgeToolOutput(callId, toolName, output)
      return false
    }
    if (!this.isCurrent(active)) return false
    this.toolOrigins.delete(callId)
    this.changed()
    return true
  }

  private bridgeToolOutput(callId: string, toolName: string, output: unknown): void {
    this.toolOrigins.delete(callId)
    this.ctx.get('ttdsHooks')?.enqueue({
      hookId: 'ttds_tool_output_ready',
      priority: 'normal',
      dedupeKey: `tool:${callId}`,
      summary: `后台工具 ${toolName} 已完成：${JSON.stringify(output)}`,
      metadata: { callId, output, alreadyInUpstreamContext: false },
    })
    this.changed()
  }

  private isQuietForWakeup(): boolean {
    return this.phase === 'listening'
      && !this.userSpeaking
      && !this.responseActive
      && (this.audioClientCount === 0 || this.drainedAudioSeq >= this.emittedAudioSeq)
  }

  /**
   * Persist and inject a background context notification when quiet, requesting a spoken turn.
   * @param summaryText - model-visible coalesced notification.
   * @param metadata - durable hook provenance.
   * @returns whether it reached the still-current quiet connection.
   */
  async injectHookNotification(summaryText: string, metadata: Readonly<Record<string, unknown>>): Promise<boolean> {
    const active = this.active
    if (!active || this.disposing || !this.isQuietForWakeup()) return false
    const modelText = buildHookModelText(summaryText, metadata)
    await this.appendJournal('hook.injected', {
      summaryText,
      ...(modelText === summaryText ? {} : { modelText }),
      metadata,
    })
    if (!this.isCurrent(active) || !this.isQuietForWakeup()) return false
    this.phase = 'thinking'
    this.changed()
    await this.track(active.session.sendContextNotification(modelText, true))
    return this.active === active
  }

  /**
   * Reserve an idle response slot before asking the provider to speak.
   * @returns whether an immediate response was requested.
   */
  async requestSpokenTurn(): Promise<boolean> {
    const active = this.active
    if (!active || this.disposing || !this.isQuietForWakeup()) return false
    this.phase = 'thinking'
    this.changed()
    await this.track(active.session.requestResponse())
    return this.active === active
  }

  /**
   * Publish a transient client feed item.
   * @param item - item content without generated identity or timestamp.
   * @returns the published item.
   */
  publishFeedItem(item: Omit<VoiceFeedItem, 'id' | 'timestampMs'>): VoiceFeedItem {
    const result: VoiceFeedItem = { ...item, id: randomUUID(), timestampMs: Date.now() }
    this.broadcast({ type: 'feed.item', item: result })
    return result
  }

  /**
   * Replace the pending confirmation projection.
   * @param confirmations - currently blocked confirmation requests.
   */
  setPendingConfirmations(confirmations: readonly VoicePendingUiConfirmationView[]): void {
    this.pendingConfirmations = confirmations
    this.changed()
  }

  /**
   * Append to the currently owned journal, including consumer cleanup during disposal.
   * @param kind - record category.
   * @param payload - structured model-visible text and provenance.
   * @returns durable append completion, or a resolved no-op without a supervisor journal.
   */
  appendJournal(kind: SupervisorJournalRecord['kind'], payload: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.journal) return Promise.resolve()
    ++this.journalRevision
    return this.track(this.journal.append(kind, payload))
  }

  /**
   * Flush and read any session journal created by this service.
   * @param supervisorSessionId - session to inspect.
   * @returns persisted records.
   */
  async readJournal(supervisorSessionId: string): Promise<readonly SupervisorJournalRecord[]> {
    await this.journals.get(supervisorSessionId)?.flush()
    return SupervisorSessionJournal.readRecords(
      this.journalDirectories.get(supervisorSessionId) ?? this.config.storageDir,
      supervisorSessionId,
    )
  }

  /**
   * Refresh upstream tool schemas only after a provider acknowledgement.
   * @returns completion of the acknowledged update and durable specification record.
   */
  async refreshTools(): Promise<void> {
    const active = this.active
    if (!active || this.disposing) return
    const spec = this.sessionConfig()
    await this.track(active.session.updateSession(spec, active.controller.signal))
    if (this.isCurrent(active)) await this.appendJournal('session.rotated', { ...spec, reason: 'tools.updated' })
  }

  /**
   * Resolve new configuration and apply connection-level, session-level, or local policy changes without unnecessary reconnects.
   * @param rawConfig - latest plugin configuration.
   * @returns completion of configuration application without crashing on concurrent user turns.
   */
  async updateConfig(rawConfig: TtdsConfig): Promise<void> {
    if (this.disposing) throw new Error('ttds: runtime is disposing')
    const next = resolveTtdsConfig(rawConfig)
    if (isDeepStrictEqual(next, this.config)) return
    const previous = this.config
    this.config = next
    const key = next.providers['qwen-realtime'].apiKey
    if (key !== '' && !this.sensitiveStrings.includes(key)) this.sensitiveStrings.push(key)
    this.changed()
    if (!this.active) return
    if (needsConnectionRotation(previous, next)) {
      await this.rotate()
      return
    }
    if (needsSessionUpdate(previous, next)) {
      await this.refreshTools()
    }
  }

  private rotate(): Promise<void> {
    return this.track(this.rotateCandidate())
  }

  private async rotateCandidate(): Promise<void> {
    const base = this.active
    const id = this.supervisorSessionId
    if (!base || !id || this.disposing) return
    const config = this.config
    const inputSeq = this.inputAdmissionSeq
    const journalRevision = this.journalRevision
    const adapter = this.adapters.get(config.provider)
    if (!adapter) throw new Error(`ttds: unregistered voice provider "${config.provider}"`)
    const controller = new AbortController()
    this.candidates.add(controller)
    const spec = this.sessionConfig()
    let candidate: VoiceAdapterSession
    try {
      candidate = await adapter.connect(config, spec, controller.signal)
    } finally {
      this.candidates.delete(controller)
    }
    const isCurrent = (): boolean => !this.disposing && this.active === base && this.config === config
      && this.inputAdmissionSeq === inputSeq && this.journalRevision === journalRevision
      && !controller.signal.aborted
    try {
      await this.replayHistory(candidate, id)
    } catch (error) {
      await candidate.close()
      throw error
    }
    if (!isCurrent()) {
      await candidate.close()
      return
    }
    const epoch = ++this.connectionEpoch
    base.unsubscribe()
    base.controller.abort()
    this.attach(candidate, epoch, controller)
    this.clearTurnFallbackTimer()
    this.clearToolNudgeTimer()
    this.userSpeaking = false
    this.responseActive = false
    this.phase = 'listening'
    this.clearClientAudio('interrupted')
    await this.appendJournal('session.rotated', { ...spec, connectionEpoch: epoch })
    await base.session.close()
    this.changed()
  }

  private async replayHistory(candidate: VoiceAdapterSession, supervisorSessionId: string): Promise<void> {
    const records = await this.readJournal(supervisorSessionId)
    for (const record of records) {
      if (record.kind === 'hook.injected') {
        if (record.payload.kind === 'tool_promise_nudge') continue
        if (record.payload.kind === 'history_restored' && typeof record.payload.summaryText === 'string') {
          await candidate.sendContextNotification(record.payload.summaryText, false)
          continue
        }
      }
      if (record.kind === 'user.text' || record.kind === 'user.transcript'
        || record.kind === 'assistant.transcript' || record.kind === 'hook.injected' || record.kind === 'tool.output') {
        await candidate.sendContextNotification(JSON.stringify({ kind: record.kind, ...record.payload }), false)
      }
    }
  }

  private clearTurnFallbackTimer(): void {
    if (this.turnFallbackTimer === undefined) return
    clearTimeout(this.turnFallbackTimer)
    this.turnFallbackTimer = undefined
  }

  private clearToolNudgeTimer(): void {
    if (this.toolNudgeTimer === undefined) return
    clearTimeout(this.toolNudgeTimer)
    this.toolNudgeTimer = undefined
  }

  private scheduleToolPromiseNudge(epoch: number, capturedSeq: number, deadlineMs: number): void {
    this.clearToolNudgeTimer()
    const remaining = Math.max(0, deadlineMs - Date.now())
    const audioDrained = this.audioClientCount === 0 || this.drainedAudioSeq >= this.emittedAudioSeq
    const waitMs = audioDrained ? Math.min(80, remaining) : Math.min(200, remaining)
    this.toolNudgeTimer = setTimeout(() => {
      this.toolNudgeTimer = undefined
      const active = this.active
      if (this.disposing
        || !active
        || this.connectionEpoch !== epoch
        || active.epoch !== epoch
        || this.inputAdmissionSeq !== capturedSeq
        || this.userSpeaking
        || this.responseActive
        || this.toolOrigins.size > 0) {
        return
      }
      if (this.audioClientCount > 0 && this.drainedAudioSeq < this.emittedAudioSeq && Date.now() < deadlineMs) {
        this.scheduleToolPromiseNudge(epoch, capturedSeq, deadlineMs)
        return
      }
      const prompt = '你刚才口头答应了立即执行操作，但未发出任何 function_call 工具调用！请立即针对用户刚才的请求直接发出对应的 function_call（如 dsh_create_session、dsh_send_session_prompt、dsh_list_pending_approvals、dsh_resolve_tool_approval、dsh_list_sessions 或 dsh_search），不要再只做口头承诺。'
      void this.track((async () => {
        await this.appendJournal('hook.injected', { kind: 'tool_promise_nudge', inputAdmissionSeq: capturedSeq })
        if (!this.isCurrent(active) || this.inputAdmissionSeq !== capturedSeq || this.userSpeaking || this.responseActive) return
        this.phase = 'thinking'
        this.changed()
        await active.session.sendContextNotification(prompt, true)
      })()).catch((error: unknown) => {
        if (this.connectionEpoch === epoch && !this.disposing) this.reportError(error)
      })
    }, waitMs)
  }

  private scheduleTurnResponseFallback(epoch: number, capturedSeq: number): void {
    this.clearTurnFallbackTimer()
    this.turnFallbackTimer = setTimeout(() => {
      this.turnFallbackTimer = undefined
      const active = this.active
      if (this.disposing
        || !active
        || this.connectionEpoch !== epoch
        || active.epoch !== epoch
        || this.inputAdmissionSeq !== capturedSeq
        || this.lastRespondedInputSeq >= capturedSeq
        || this.responseActive) {
        return
      }
      this.userSpeaking = false
      this.lastRespondedInputSeq = capturedSeq
      this.phase = 'thinking'
      this.changed()
      void this.track(active.session.requestResponse()).catch((error: unknown) => {
        if (this.connectionEpoch === epoch && !this.disposing) this.reportError(error)
      })
    }, 850)
  }

  private async processEvent(event: VoiceAdapterEvent, epoch: number): Promise<void> {
    switch (event.type) {
      case 'speech.started':
        this.clearTurnFallbackTimer()
        this.clearToolNudgeTimer()
        ++this.inputAdmissionSeq
        this.userSpeaking = true
        this.phase = 'listening'
        this.clearClientAudio('barge_in')
        if (event.itemId !== '') {
          this.broadcast({ type: 'transcript', role: 'user', text: '', final: false, itemId: event.itemId })
        }
        this.changed()
        break
      case 'speech.stopped':
        this.userSpeaking = false
        this.phase = 'thinking'
        this.changed()
        break
      case 'input.transcript':
        if (event.final) {
          await this.appendJournal('user.transcript', {
            itemId: event.itemId, text: event.transcript, inputAdmissionSeq: this.inputAdmissionSeq,
          })
        }
        if (this.connectionEpoch !== epoch) return
        this.broadcast({ type: 'transcript', role: 'user', text: event.transcript, final: event.final, itemId: event.itemId })
        if (event.final
          && this.config.voice.turnDetection !== 'push_to_talk'
          && event.transcript.trim() !== ''
          && event.transcript !== '（音频转写失败）'
          && this.lastRespondedInputSeq < this.inputAdmissionSeq
          && !this.responseActive) {
          this.scheduleTurnResponseFallback(epoch, this.inputAdmissionSeq)
        }
        break
      case 'response.created':
        this.clearTurnFallbackTimer()
        this.lastRespondedInputSeq = this.inputAdmissionSeq
        this.responseActive = true
        this.phase = 'thinking'
        this.ctx.get('ttdsHooks')?.markToolOutputsNaturallyConsumed()
        this.changed()
        break
      case 'response.audio.delta':
        this.clearTurnFallbackTimer()
        this.lastRespondedInputSeq = Math.max(this.lastRespondedInputSeq, this.inputAdmissionSeq)
        this.responseActive = true
        if (event.pcm24kBase64 === '') break
        this.phase = 'speaking'
        this.broadcast({
          type: 'audio.delta', audioSeq: ++this.emittedAudioSeq,
          responseId: event.responseId, pcm24kBase64: event.pcm24kBase64,
        })
        this.changed()
        break
      case 'response.transcript.delta': {
        const accumulated = (this.transcripts.get(event.responseId) ?? '') + event.delta
        this.transcripts.set(event.responseId, accumulated)
        this.broadcast({ type: 'transcript', role: 'assistant', text: accumulated, final: false, itemId: event.responseId })
        break
      }
      case 'response.transcript.done':
        this.transcripts.set(event.responseId, event.transcript)
        break
      case 'response.done': {
        this.clearTurnFallbackTimer()
        this.lastRespondedInputSeq = Math.max(this.lastRespondedInputSeq, this.inputAdmissionSeq)
        this.responseActive = false
        const transcript = event.transcript || this.transcripts.get(event.responseId) || ''
        await this.appendJournal('assistant.transcript', {
          responseId: event.responseId, text: transcript, status: event.status,
        })
        if (this.connectionEpoch !== epoch) return
        this.transcripts.delete(event.responseId)
        this.broadcast({ type: 'transcript', role: 'assistant', text: transcript, final: true, itemId: event.responseId })
        const tools = this.ctx.get('ttdsTools')
        for (const call of event.toolCalls) {
          if (tools === undefined) {
            await this.appendJournal('tool.call', { ...call, connectionEpoch: epoch })
            if (this.connectionEpoch !== epoch) return
          }
          this.toolOrigins.set(call.callId, epoch)
        }
        this.phase = this.audioClientCount > 0 && this.drainedAudioSeq < this.emittedAudioSeq ? 'speaking' : 'listening'
        this.ctx.get('ttdsHooks')?.markToolOutputsNaturallyConsumed()
        if (event.toolCalls.length > 0 && tools !== undefined) {
          tools.dispatchToolCalls(event.toolCalls)
        } else if (event.status === 'completed'
          && event.toolCalls.length === 0
          && this.toolOrigins.size === 0
          && (tools?.listUpstreamSpecs().length ?? 0) > 0
          && this.inputAdmissionSeq > 0
          && this.lastToolNudgeInputSeq !== this.inputAdmissionSeq
          && isUnfulfilledToolPromise(transcript)) {
          this.lastToolNudgeInputSeq = this.inputAdmissionSeq
          this.scheduleToolPromiseNudge(epoch, this.inputAdmissionSeq, Date.now() + 600)
        }
        this.changed()
        break
      }
      case 'error':
        await this.appendJournal('error', { code: event.code, message: event.message, fatal: event.fatal })
        if (this.connectionEpoch !== epoch) return
        if (!event.fatal) {
          this.clearTurnFallbackTimer()
          this.userSpeaking = false
          this.responseActive = false
          if (this.phase === 'thinking') this.phase = 'listening'
          this.publishFeedItem({ kind: 'diagnostic', text: event.message })
          this.changed()
          break
        }
        this.reportError(new Error(event.message))
        break
      case 'closed':
        await this.stopSession('upstream_closed')
        break
      case 'session.created':
      case 'session.updated':
      case 'tool.output.acknowledged':
        break
      default: assertNever(event)
    }
  }

  private beginDispose(): void {
    if (this.disposing) return
    this.disposing = true
    this.clearTurnFallbackTimer()
    this.clearToolNudgeTimer()
    for (const controller of this.candidates) controller.abort()
    this.active?.controller.abort()
    for (const controller of this.leases.keys()) controller.abort()
  }

  private async dispose(): Promise<void> {
    this.beginDispose()
    while (this.leases.size > 0 || this.tasks.size > 0) {
      await Promise.allSettled([...this.leases.values(), ...this.tasks])
    }
    await this.stop('dispose')
    for (const journal of this.journals.values()) await journal.flush()
    this.frames.clear()
    this.stateListeners.clear()
    this.adapters.clear()
    this.journals.clear()
    this.journalDirectories.clear()
    this.candidates.clear()
  }
}

function needsConnectionRotation(previous: ResolvedTtdsConfig, next: ResolvedTtdsConfig): boolean {
  const prevQwen = previous.providers['qwen-realtime']
  const nextQwen = next.providers['qwen-realtime']
  return previous.provider !== next.provider
    || prevQwen.apiKey !== nextQwen.apiKey
    || prevQwen.workspaceId !== nextQwen.workspaceId
    || prevQwen.endpointUrl !== nextQwen.endpointUrl
    || prevQwen.model !== nextQwen.model
    || prevQwen.voice !== nextQwen.voice
}

function needsSessionUpdate(previous: ResolvedTtdsConfig, next: ResolvedTtdsConfig): boolean {
  return previous.voice.mergedInstructions !== next.voice.mergedInstructions
    || previous.voice.turnDetection !== next.voice.turnDetection
    || previous.voice.threshold !== next.voice.threshold
    || previous.voice.silenceDurationMs !== next.voice.silenceDurationMs
    || previous.providers['qwen-realtime'].maxHistoryTurns !== next.providers['qwen-realtime'].maxHistoryTurns
    || previous.tools.enableReadTools !== next.tools.enableReadTools
    || previous.tools.enableSearchTool !== next.tools.enableSearchTool
}
