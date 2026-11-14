import { randomUUID } from 'node:crypto'
import { WebSocket, type ClientOptions, type RawData } from 'ws'
import {
  assertNever,
  type ResolvedTtdsConfig,
  type VoiceAdapterEvent,
  type VoiceAdapterSession,
  type VoiceAdapterSessionConfig,
  type VoiceAdapterToolCall,
  type VoiceRuntimeAdapter,
} from '../shared/index.ts'
import { redactText } from './journal.ts'

/**
 * Construct a socket without changing authentication or protocol handling.
 * @param url - model-qualified upstream URL.
 * @param options - authenticated WebSocket options.
 * @returns a socket owned by the adapter session.
 */
export type QwenWebSocketFactory = (url: string, options: ClientOptions) => WebSocket

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item: unknown) => object(item)) : []
}

function turnDetection(config: VoiceAdapterSessionConfig): object | null {
  switch (config.turnDetection) {
    case 'push_to_talk': return null
    case 'server_vad':
      return { type: 'server_vad', threshold: config.threshold, silence_duration_ms: config.silenceDurationMs }
    case 'smart_turn':
    case 'smart_turn_v2':
      return { type: config.turnDetection, threshold: config.threshold }
    default: return assertNever(config.turnDetection)
  }
}

interface PendingToolCall {
  itemId: string
  callId: string
  name: string
  argumentsDelta: string
  argumentsDone: string
}

class QwenSession implements VoiceAdapterSession {
  private readonly listeners = new Set<(event: VoiceAdapterEvent) => void>()
  private readonly waiters = new Set<{ reject: (error: Error) => void }>()
  private readonly messageAckWaiters = new Set<(role: string) => void>()
  private readonly pendingToolCalls = new Map<string, PendingToolCall>()
  private updateTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly socket: WebSocket, private readonly secrets: readonly string[]) {
    socket.on('message', this.receive)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private emit(event: VoiceAdapterEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private readonly onError = (error: Error): void => {
    const message = redactText(error.message, this.secrets)
    this.rejectPending(new Error(message))
    this.emit({ type: 'error', code: 'upstream_socket', message, fatal: true })
  }

  private readonly onClose = (code: number, reason: Buffer): void => {
    this.closed = true
    this.pendingToolCalls.clear()
    this.rejectPending(new Error('ttds: upstream connection closed'))
    this.messageAckWaiters.clear()
    this.emit({ type: 'closed', code, reason: redactText(reason.toString(), this.secrets) })
    this.listeners.clear()
  }

  private rejectPending(error: Error): void {
    for (const waiter of [...this.waiters]) waiter.reject(error)
  }

  private upsertPendingToolCall(key: string): PendingToolCall {
    const existing = this.pendingToolCalls.get(key)
    if (existing) return existing
    const created: PendingToolCall = { itemId: key, callId: '', name: '', argumentsDelta: '', argumentsDone: '' }
    this.pendingToolCalls.set(key, created)
    return created
  }

  private collectToolCalls(output: readonly Record<string, unknown>[]): VoiceAdapterToolCall[] {
    const merged = new Map<string, VoiceAdapterToolCall>()
    for (const entry of this.pendingToolCalls.values()) {
      const key = entry.callId || entry.itemId
      if (key === '' || entry.name === '') continue
      merged.set(key, {
        itemId: entry.itemId,
        callId: entry.callId,
        name: entry.name,
        argumentsJson: entry.argumentsDone || entry.argumentsDelta,
      })
    }
    for (const item of output) {
      if (item.type !== 'function_call') continue
      const itemId = string(item.id)
      const callId = string(item.call_id)
      const name = string(item.name)
      const args = string(item.arguments)
      const key = callId || itemId
      const prev = key !== '' ? merged.get(key) : undefined
      const resolved: VoiceAdapterToolCall = {
        itemId: itemId || prev?.itemId || '',
        callId: callId || prev?.callId || '',
        name: name || prev?.name || '',
        argumentsJson: args || prev?.argumentsJson || '',
      }
      if (key !== '') merged.set(key, resolved)
    }
    return [...merged.values()]
  }

  private readonly receive = (data: RawData): void => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      this.onError(new Error('ttds: upstream returned invalid JSON'))
      this.socket.terminate()
      return
    }
    const event = object(parsed)
    const response = object(event.response)
    const responseId = string(event.response_id) || string(response.id)
    const itemId = string(event.item_id)
    switch (event.type) {
      case 'session.created':
        this.emit({ type: 'session.created', upstreamSessionId: string(object(event.session).id) })
        break
      case 'session.updated':
        this.emit({ type: 'session.updated' })
        break
      case 'input_audio_buffer.speech_started':
        this.emit({ type: 'speech.started', itemId })
        break
      case 'input_audio_buffer.speech_stopped':
        this.emit({ type: 'speech.stopped', itemId })
        break
      case 'input_audio_buffer.committed':
        if (itemId !== '') {
          this.emit({ type: 'input.transcript', itemId, transcript: '', final: false })
        }
        break
      case 'conversation.item.input_audio_transcription.delta': {
        const transcript = string(event.delta) || `${string(event.text)}${string(event.stash)}`
        this.emit({ type: 'input.transcript', itemId, transcript, final: false })
        break
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.emit({ type: 'input.transcript', itemId, transcript: string(event.transcript), final: true })
        break
      case 'conversation.item.input_audio_transcription.failed':
        this.emit({ type: 'input.transcript', itemId, transcript: '（音频转写失败）', final: true })
        break
      case 'response.created':
        this.pendingToolCalls.clear()
        this.emit({ type: 'response.created', responseId })
        break
      case 'response.audio.delta':
        this.emit({ type: 'response.audio.delta', responseId, pcm24kBase64: string(event.delta) })
        break
      case 'response.audio_transcript.delta':
      case 'response.text.delta':
        this.emit({ type: 'response.transcript.delta', responseId, delta: string(event.delta) })
        break
      case 'response.audio_transcript.done':
      case 'response.text.done':
        this.emit({ type: 'response.transcript.done', responseId, transcript: string(event.transcript) || string(event.text) })
        break
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = object(event.item)
        if (item.type === 'function_call') {
          const key = string(item.id) || itemId
          if (key !== '') {
            const pending = this.upsertPendingToolCall(key)
            if (string(item.id) !== '') pending.itemId = string(item.id)
            if (string(item.call_id) !== '') pending.callId = string(item.call_id)
            if (string(item.name) !== '') pending.name = string(item.name)
            const args = string(item.arguments)
            if (event.type === 'response.output_item.done' && args !== '') pending.argumentsDone = args
          }
        }
        break
      }
      case 'response.function_call_arguments.delta':
        if (itemId !== '') {
          this.upsertPendingToolCall(itemId).argumentsDelta += string(event.delta)
        }
        break
      case 'response.function_call_arguments.done':
        if (itemId !== '') {
          const pending = this.upsertPendingToolCall(itemId)
          if (string(event.name) !== '') pending.name = string(event.name)
          const args = string(event.arguments)
          if (args !== '') pending.argumentsDone = args
        }
        break
      case 'response.done': {
        const output = records(response.output)
        const toolCalls = this.collectToolCalls(output)
        this.pendingToolCalls.clear()
        const status = response.status
        this.emit({
          type: 'response.done',
          responseId,
          status: status === 'completed' || status === 'cancelled' || status === 'incomplete' ? status : 'failed',
          transcript: output.flatMap(item => records(item.content)).map(part => string(part.transcript) || string(part.text)).join(''),
          toolCalls,
        })
        break
      }
      case 'conversation.item.created': {
        const item = object(event.item)
        if (item.type === 'function_call_output') {
          this.emit({ type: 'tool.output.acknowledged', callId: string(item.call_id), itemId: string(item.id) })
        } else if (item.type === 'message') {
          const role = string(item.role)
          for (const notify of [...this.messageAckWaiters]) notify(role)
        }
        break
      }
      case 'error': {
        const error = object(event.error)
        const message = redactText(string(error.message) || '上游语音请求失败', this.secrets)
        this.rejectPending(new Error(message))
        this.emit({ type: 'error', code: string(error.code) || 'upstream_error', message, fatal: false })
        break
      }
      default:
        // Providers add informational wire events that do not alter the normalized session state.
        break
    }
  }

  private send(event: object): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('ttds: upstream is not open'))
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }), (error) => {
        if (error) reject(new Error(redactText(error.message, this.secrets)))
        else resolve()
      })
    })
  }

  private waitFor(
    predicate: (event: VoiceAdapterEvent) => boolean,
    send: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('ttds: upstream operation aborted'))
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        this.waiters.delete(waiter)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const listener = (event: VoiceAdapterEvent): void => {
        if (predicate(event)) finish()
      }
      const abort = (): void => {
        finish(new Error('ttds: upstream operation aborted'))
      }
      const waiter = { reject: (error: Error): void => { finish(error) } }
      const timer = setTimeout(() => {
        finish(new Error('ttds: upstream acknowledgement timed out'))
      }, 15_000)
      this.waiters.add(waiter)
      this.listeners.add(listener)
      signal?.addEventListener('abort', abort, { once: true })
      send().catch((error: unknown) => { finish(error instanceof Error ? error : new Error('ttds: upstream send failed')) })
    })
  }

  /**
   * Serialize session updates because the upstream acknowledgement does not echo request identifiers.
   * @param config - complete desired session specification.
   * @param signal - optional cancellation of the acknowledgement wait.
   * @returns completion after the upstream acknowledges this update.
   */
  updateSession(config: VoiceAdapterSessionConfig, signal?: AbortSignal): Promise<void> {
    const operation = this.updateTail.then(() => this.waitFor(event => event.type === 'session.updated', () => this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: config.voice,
        instructions: config.instructions,
        enable_search: false,
        tools: config.tools,
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        input_audio_transcription: { language: 'zh' },
        max_history_turns: config.maxHistoryTurns,
        turn_detection: turnDetection(config),
      },
    }), signal))
    this.updateTail = operation.catch(() => { /* Each caller receives its own failed update; later updates remain admissible. */ })
    return operation
  }

  /**
   * Stream an input chunk without retaining PCM in the journal.
   * @param pcm16kBase64 - PCM16 mono input encoded as base64.
   * @returns socket send completion.
   */
  appendAudio(pcm16kBase64: string): Promise<void> {
    return this.send({ type: 'input_audio_buffer.append', audio: pcm16kBase64 })
  }

  /**
   * Commit a push-to-talk input and request one response.
   * @returns completion of both ordered socket writes.
   */
  async commitAudio(): Promise<void> {
    await this.send({ type: 'input_audio_buffer.commit' })
    await this.requestResponse()
  }

  private async sendMessageItem(role: 'user' | 'system', text: string, waitAck: boolean): Promise<void> {
    const payload = {
      type: 'conversation.item.create',
      item: { type: 'message', role, content: [{ type: 'input_text', text }] },
    }
    if (!waitAck) {
      await this.send(payload)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(fallbackTimer)
        this.messageAckWaiters.delete(onCreated)
        this.waiters.delete(waiter)
        if (error) reject(error)
        else resolve()
      }
      const onCreated = (createdRole: string): void => {
        if (createdRole === '' || createdRole === role) finish()
      }
      const waiter = { reject: (error: Error): void => { finish(error) } }
      // Simple test servers often omit message item acks; resolve briefly after send rather than stalling.
      const fallbackTimer = setTimeout(() => { finish() }, 60)
      this.messageAckWaiters.add(onCreated)
      this.waiters.add(waiter)
      this.send(payload).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error('ttds: upstream send failed'))
      })
    })
  }

  /**
   * Append a user utterance and request one response.
   * @param text - utterance text.
   * @returns completion of the message and response request writes.
   */
  async sendUserText(text: string): Promise<void> {
    await this.sendMessageItem('user', text, true)
    await this.requestResponse()
  }

  /**
   * Append background context and optionally ask the model to speak without repeating prior replies.
   * @param text - model-visible background summary.
   * @param triggerResponse - whether to send an explicit response request.
   * @returns completion of the ordered socket writes.
   */
  async sendContextNotification(text: string, triggerResponse: boolean): Promise<void> {
    if (!triggerResponse) {
      await this.sendMessageItem('system', text, false)
      return
    }
    const prompt = `【后台事件提醒】请用一两句口语向用户简明播报以下进展（说明哪个会话提出了什么请求或状态，不要重复上一轮回复）：${text}`
    await this.sendMessageItem('user', prompt, true)
    await this.requestResponse()
  }

  /**
   * Backfill a result without automatically requesting a spoken response.
   * @param callId - function call being completed.
   * @param outputJson - serialized tool result.
   * @param signal - cancellation of the matching item acknowledgement.
   * @returns completion after the matching call output item is acknowledged.
   */
  submitToolOutput(callId: string, outputJson: string, signal?: AbortSignal): Promise<void> {
    return this.waitFor(
      event => event.type === 'tool.output.acknowledged' && event.callId === callId,
      () => this.send({ type: 'conversation.item.create', item: {
        type: 'function_call_output', call_id: callId, output: outputJson,
      } }),
      signal,
    )
  }

  /**
   * Ask the provider to begin a response.
   * @returns socket send completion.
   */
  requestResponse(): Promise<void> {
    return this.send({ type: 'response.create' })
  }

  /**
   * Cancel the provider's active response.
   * @returns socket send completion.
   */
  cancelResponse(): Promise<void> {
    return this.send({ type: 'response.cancel' })
  }

  /**
   * Subscribe to normalized upstream events.
   * @param listener - synchronous event consumer.
   * @returns idempotent listener removal.
   */
  onEvent(listener: (event: VoiceAdapterEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Reject pending acknowledgements, finish socket shutdown, and detach listeners.
   * @returns completion after the physical socket closes.
   */
  async close(): Promise<void> {
    this.rejectPending(new Error('ttds: upstream session is closing'))
    if (this.socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.socket.terminate() }, 1000)
        this.socket.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate()
        else if (this.socket.readyState === WebSocket.OPEN) this.socket.close()
      })
    }
    this.socket.off('message', this.receive)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    this.listeners.clear()
  }
}

/** Authenticated Qwen Realtime provider; every returned session owns exactly one upstream socket. */
export class QwenRealtimeAdapter implements VoiceRuntimeAdapter {
  /** Provider identifier matched against the resolved runtime configuration. */
  readonly id = 'qwen-realtime'

  /**
   * Configure socket creation for a local upstream fixture or another WebSocket carrier.
   * @param socketFactory - socket constructor receiving the authenticated URL and headers.
   */
  constructor(private readonly socketFactory: QwenWebSocketFactory = (url, options) => new WebSocket(url, options)) {}

  /**
   * Check credentials without initiating a network operation.
   * @param config - resolved Host configuration.
   * @returns provider readiness and a credential-free diagnostic.
   */
  checkReadiness(config: ResolvedTtdsConfig): { readonly ready: boolean; readonly reason: string | null } {
    return config.providers['qwen-realtime'].hasApiKey
      ? { ready: true, reason: null }
      : { ready: false, reason: '请在设置中配置百炼 API Key' }
  }

  /**
   * Connect and wait for the initial session configuration acknowledgement.
   * @param config - resolved provider credentials and model.
   * @param sessionConfig - merged instructions, tools, voice, and turn detection.
   * @param signal - cancellation for connection establishment and initial configuration.
   * @returns configured session; failures close the candidate socket.
   */
  async connect(
    config: ResolvedTtdsConfig,
    sessionConfig: VoiceAdapterSessionConfig,
    signal: AbortSignal,
  ): Promise<VoiceAdapterSession> {
    signal.throwIfAborted()
    const qwen = config.providers['qwen-realtime']
    const headers: Record<string, string> = { Authorization: `Bearer ${qwen.apiKey}` }
    if (qwen.workspaceId !== '') headers['X-DashScope-WorkSpace'] = qwen.workspaceId
    const socket = this.socketFactory(`${qwen.endpointUrl}?model=${encodeURIComponent(qwen.model)}`, { headers })
    const session = new QwenSession(socket, [qwen.apiKey])
    try {
      await this.initialize(socket, session, sessionConfig, signal, qwen.apiKey)
    } catch (error) {
      await session.close()
      throw error
    }
    return session
  }

  private async initialize(
    socket: WebSocket,
    session: QwenSession,
    config: VoiceAdapterSessionConfig,
    signal: AbortSignal,
    apiKey: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        socket.off('open', open)
        socket.off('error', fail)
        socket.off('close', closed)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const open = (): void => { finish() }
      const fail = (error: Error): void => { finish(new Error(redactText(error.message, [apiKey]))) }
      const closed = (): void => { finish(new Error('ttds: upstream closed before opening')) }
      const abort = (): void => { finish(new Error('ttds: upstream connection aborted')) }
      const timer = setTimeout(() => { finish(new Error('ttds: upstream connection timed out')) }, 15_000)
      socket.once('open', open)
      socket.once('error', fail)
      socket.once('close', closed)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    await session.updateSession(config, signal)
  }
}
