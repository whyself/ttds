/** Cross-module service contracts and Cordis Context augmentations for `@whyself/ttds`. */
import type {
  ResolvedTtdsConfig,
  TtdsConfig,
  TurnDetectionMode,
  VoiceConfirmationMode,
} from './config.ts'
import type {
  ClientRealtimeFrame,
  ServerRealtimeFrame,
  VoiceFeedItem,
  VoicePendingUiConfirmationView,
  VoiceSessionSnapshot,
  VoiceTurnPhase,
} from './protocol.ts'

/** JSON Schema subset describing tool parameters sent to realtime voice models. */
export interface VoiceToolJsonSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, {
    readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
    readonly description: string
    readonly enum?: readonly string[]
    readonly items?: { readonly type: string }
  }>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

/** Function tool specification formatted for upstream realtime session configuration. */
export interface VoiceUpstreamToolSpec {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: VoiceToolJsonSchema
  }
}

/** Session configuration pushed to a provider adapter on connect and `session.update`. */
export interface VoiceAdapterSessionConfig {
  /** Merged system instructions (`DEFAULT_VOICE_SYSTEM_INSTRUCTIONS` + user `customInstructions`). */
  readonly instructions: string
  /** Output voice timbre identifier. */
  readonly voice: string
  /** Turn detection mode (`push_to_talk` maps to `null` on Qwen Realtime). */
  readonly turnDetection: TurnDetectionMode
  /** Turn detection threshold (`-1.0` to `1.0`). */
  readonly threshold: number
  /** Silence duration in milliseconds (`server_vad` only). */
  readonly silenceDurationMs: number
  /** Maximum conversation turns kept in upstream context. */
  readonly maxHistoryTurns: number
  /** Registered voice tools exposed for function calling. */
  readonly tools: readonly VoiceUpstreamToolSpec[]
}

/** Function call item emitted by the upstream voice model at `response.done`. */
export interface VoiceAdapterToolCall {
  /** Upstream conversation item ID, when provided. */
  readonly itemId: string
  /** Unique call identifier (`call_id`) used to pair `function_call_output`. */
  readonly callId: string
  /** Invoked function tool name. */
  readonly name: string
  /** Raw JSON argument string emitted by the model. */
  readonly argumentsJson: string
}

/** Normalized upstream events emitted by a {@link VoiceAdapterSession}. */
export type VoiceAdapterEvent =
  | { readonly type: 'session.created'; readonly upstreamSessionId: string }
  | { readonly type: 'session.updated' }
  | { readonly type: 'speech.started'; readonly itemId: string }
  | { readonly type: 'speech.stopped'; readonly itemId: string }
  | { readonly type: 'input.transcript'; readonly itemId: string; readonly transcript: string; readonly final: boolean }
  | { readonly type: 'response.created'; readonly responseId: string }
  | { readonly type: 'response.audio.delta'; readonly responseId: string; readonly pcm24kBase64: string }
  | { readonly type: 'response.transcript.delta'; readonly responseId: string; readonly delta: string }
  | { readonly type: 'response.transcript.done'; readonly responseId: string; readonly transcript: string }
  | {
    readonly type: 'response.done'
    readonly responseId: string
    readonly status: 'completed' | 'cancelled' | 'incomplete' | 'failed'
    readonly transcript: string
    readonly toolCalls: readonly VoiceAdapterToolCall[]
  }
  | { readonly type: 'tool.output.acknowledged'; readonly callId: string; readonly itemId: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly fatal: boolean }
  | { readonly type: 'closed'; readonly code: number; readonly reason: string }

/** Active bidirectional connection instance managed by a {@link VoiceRuntimeAdapter}. */
export interface VoiceAdapterSession {
  /** Send initial or updated session parameters (`session.update`) and resolve once `session.updated` arrives. */
  updateSession(config: VoiceAdapterSessionConfig, signal?: AbortSignal): Promise<void>
  /** Stream a base64-encoded 16kHz PCM16 mono audio frame (`input_audio_buffer.append`). */
  appendAudio(pcm16kBase64: string): Promise<void>
  /** Explicitly commit the input audio buffer (`input_audio_buffer.commit`) and request a response. */
  commitAudio(): Promise<void>
  /** Append a user text message (`conversation.item.create` + `response.create`). */
  sendUserText(text: string): Promise<void>
  /** Inject a system/context notification message and optionally trigger an immediate spoken response. */
  sendContextNotification(text: string, triggerResponse: boolean): Promise<void>
  /** Backfill a function call result (`function_call_output`) and await upstream `conversation.item.created` ack. */
  submitToolOutput(callId: string, outputJson: string, signal?: AbortSignal): Promise<void>
  /** Trigger an explicit `response.create` turn on the upstream session. */
  requestResponse(): Promise<void>
  /** Cancel an in-progress assistant response (`response.cancel`). */
  cancelResponse(): Promise<void>
  /** Subscribe to normalized adapter events; returns an unsubscribe disposer. */
  onEvent(listener: (event: VoiceAdapterEvent) => void): () => void
  /** Close the upstream connection cleanly and release socket resources. */
  close(): Promise<void>
}

/** Provider adapter factory registered with `VoiceRuntimeService` (supports multi-provider extension). */
export interface VoiceRuntimeAdapter {
  /** Provider identifier matched against `config.provider` (e.g. `'qwen-realtime'`). */
  readonly id: string
  /** Check whether resolved configuration contains required credentials for this provider. */
  checkReadiness(config: ResolvedTtdsConfig): { readonly ready: boolean; readonly reason: string | null }
  /** Open and authenticate a new upstream realtime session. */
  connect(
    config: ResolvedTtdsConfig,
    sessionConfig: VoiceAdapterSessionConfig,
    signal: AbortSignal,
  ): Promise<VoiceAdapterSession>
}

/** Lease tracking an asynchronous consumer so `dispose()` drains in-flight work deterministically. */
export interface ConsumerLease {
  /** Cancellation signal aborted when the owning service or session disposes. */
  readonly signal: AbortSignal
  /** Release the lease once the consumer finishes cleanup. */
  release(): void
}

/** Durable JSONL record persisted by `SupervisorSessionJournal` (never stores raw PCM bytes or secrets). */
export interface SupervisorJournalRecord {
  /** Monotonic sequence within the supervisor session journal. */
  readonly seq: number
  /** ISO-8601 UTC timestamp. */
  readonly timestamp: string
  /** Supervisor session identifier. */
  readonly supervisorSessionId: string
  /** Record category reconstructing every model-visible input and output. */
  readonly kind:
    | 'session.started'
    | 'session.rotated'
    | 'session.ended'
    | 'user.transcript'
    | 'user.text'
    | 'assistant.transcript'
    | 'tool.call'
    | 'tool.confirmation'
    | 'tool.output'
    | 'hook.injected'
    | 'error'
  /** Structured record payload without raw audio or credentials. */
  readonly payload: Readonly<Record<string, unknown>>
}

/** Self-action suppression token returned by `beginSelfAction` so TTDS-initiated mutations do not echo as hooks. */
export interface SelfActionHandle {
  /** Release the suppression guard once the TTDS-originated operation settles. */
  release(): void
}

/** Cursor snapshot exposed by `VoiceRuntimeService` to observe connection, input, and playback progress. */
export interface VoicePlaybackCursors {
  /** Current connection epoch (`connectionEpoch`). */
  readonly connectionEpoch: number
  /** Current admitted user input sequence (`inputAdmissionSeq`). */
  readonly inputAdmissionSeq: number
  /** Highest downlink audio sequence confirmed drained by the client (`drainedAudioSeq`). */
  readonly drainedAudioSeq: number
  /** Latest downlink audio sequence emitted by the assistant (`emittedAudioSeq`). */
  readonly emittedAudioSeq: number
  /** True when a real Web Audio client WebSocket is attached and reporting `playback.drained`. */
  readonly hasAudioClient: boolean
}

/** Core Host voice runtime service contract (`ctx.ttdsRuntime`). */
export interface VoiceRuntimeServiceContract {
  /** Read the current resolved configuration. */
  getConfig(): ResolvedTtdsConfig
  /** Read the current session snapshot. */
  getSnapshot(): VoiceSessionSnapshot
  /** Read current connection, input admission, and audio playback cursors. */
  getPlaybackCursors(): VoicePlaybackCursors
  /** Acquire a lifecycle consumer lease; returns `null` if the service is already disposing. */
  acquireLease(): ConsumerLease | null
  /** Register a voice provider adapter; returns a disposer removing the adapter. */
  registerAdapter(adapter: VoiceRuntimeAdapter): () => void
  /** Subscribe to snapshot and realtime server frames; returns an unsubscribe disposer. */
  subscribeFrames(listener: (frame: ServerRealtimeFrame) => void): () => void
  /** Subscribe to lifecycle phase or turn-idle transitions; returns an unsubscribe disposer. */
  onStateChange(listener: (snapshot: VoiceSessionSnapshot) => void): () => void
  /** Start or reuse an active supervisor voice session. */
  startSession(options?: { readonly inputDeviceId?: string }): Promise<VoiceSessionSnapshot>
  /** Stop the active supervisor voice session and release upstream sockets. */
  stopSession(reason?: string): Promise<VoiceSessionSnapshot>
  /** Handle an incoming client realtime frame from WebSocket or test harness. */
  handleClientFrame(frame: ClientRealtimeFrame, fromAudioClient?: boolean): Promise<void>
  /** Send a user text turn directly into the active session (starts session first if needed when `autoStart` is true). */
  sendTextUtterance(text: string, options?: { readonly autoStart?: boolean }): Promise<{
    readonly accepted: boolean
    readonly inputAdmissionSeq: number
  }>
  /** Backfill a completed tool call output into the active session and journal. */
  submitToolResult(callId: string, toolName: string, output: unknown): Promise<boolean>
  /** Deliver a coalesced background hook prompt or notification into the active session when quiet. */
  injectHookNotification(summaryText: string, metadata: Readonly<Record<string, unknown>>): Promise<boolean>
  /** Trigger an immediate spoken response turn when the channel is idle. */
  requestSpokenTurn(): Promise<boolean>
  /** Publish a transient event pill to connected UI clients. */
  publishFeedItem(item: Omit<VoiceFeedItem, 'id' | 'timestampMs'>): VoiceFeedItem
  /** Update the list of pending confirmations reflected on the session snapshot. */
  setPendingConfirmations(confirmations: readonly VoicePendingUiConfirmationView[]): void
  /** Append a durable record to the active `SupervisorSessionJournal`. */
  appendJournal(kind: SupervisorJournalRecord['kind'], payload: Readonly<Record<string, unknown>>): Promise<void>
  /** Read all persisted journal records for a supervisor session ID (used by recovery and E2E verification). */
  readJournal(supervisorSessionId: string): Promise<readonly SupervisorJournalRecord[]>
  /** Notify the runtime that the registered tool catalog changed so `session.update` refreshes tools. */
  refreshTools(): Promise<void>
  /** Resolve updated plugin configuration and rotate any active session through an isolated candidate. */
  updateConfig(rawConfig: TtdsConfig): Promise<void>
}

/** Execution context supplied to a {@link VoiceToolDefinition} handler. */
export interface VoiceToolExecutionContext {
  /** Cancellation signal aborted on timeout, session teardown, or plugin disposal. */
  readonly signal: AbortSignal
  /** Active supervisor session ID. */
  readonly supervisorSessionId: string
  /** Upstream function call ID (`call_id`). */
  readonly callId: string
  /** Register a self-originated mutation on a target DSH session so `EventHookEngine` suppresses echo notifications. */
  beginSelfAction(sessionId: string, actionKind: string): SelfActionHandle
}

/** Structured result returned by a {@link VoiceToolDefinition}. */
export interface VoiceToolResult {
  /** True when the operation succeeded. */
  readonly ok: boolean
  /** Concise structured data serialized back to the voice model. */
  readonly data?: Readonly<Record<string, unknown>>
  /** Concise error code and explanation when `ok` is false. */
  readonly error?: {
    readonly code: string
    readonly message: string
  }
}

/** Registration contract for one voice supervisor bridge tool. */
export interface VoiceToolDefinition {
  /** Unique snake_case tool name (`dsh_*`). */
  readonly name: string
  /** Model-facing tool description explaining purpose and constraints. */
  readonly description: string
  /** JSON Schema for tool arguments. */
  readonly parameters: VoiceToolJsonSchema
  /** Side-effect category (`read` tools run immediately; `write` and `approval` obey confirmation policy). */
  readonly category: 'read' | 'write' | 'approval' | 'search'
  /** Resolve confirmation mode given current resolved config (`'auto'` or `'ui'`). */
  resolveConfirmation(config: ResolvedTtdsConfig): VoiceConfirmationMode
  /** Summarize a call's target and effect for UI confirmation prompts. */
  summarizeCall?(args: Readonly<Record<string, unknown>>): string
  /** Execute the tool against DSH public services. */
  execute(
    args: Readonly<Record<string, unknown>>,
    context: VoiceToolExecutionContext,
  ): Promise<VoiceToolResult>
}

/** Voice tool registry and dispatcher service contract (`ctx.ttdsTools`). */
export interface VoiceToolRegistryContract {
  /** Register a voice tool; throws if duplicate or if non-auto tool lacks confirmation support. Returns disposer. */
  register(tool: VoiceToolDefinition): () => void
  /** List registered tools formatted for upstream `session.update`. */
  listUpstreamSpecs(): readonly VoiceUpstreamToolSpec[]
  /** List registered tool names. */
  listToolNames(): readonly string[]
  /** Dispatch a batch of function calls emitted by `response.done` asynchronously without blocking conversation. */
  dispatchToolCalls(calls: readonly VoiceAdapterToolCall[]): void
  /** Resolve a pending UI confirmation card by ID. */
  resolveUiConfirmation(confirmationId: string, approved: boolean): Promise<boolean>
  /** Cancel all pending confirmations and in-flight tool executions for session teardown/rotation. */
  cancelAll(reason: string): Promise<void>
}

/** Priority levels governing how `EventHookEngine` buffers and coalesces events. */
export type VoiceHookPriority = 'critical' | 'high' | 'normal' | 'low'

/** Normalized event payload pushed into `EventHookEngine`. */
export interface VoiceHookTriggerPayload {
  /** Hook identifier (e.g. `'agent/turn-settled'`, `'ttds_tool_output_ready'`). */
  readonly hookId: string
  /** Priority class. */
  readonly priority: VoiceHookPriority
  /** Optional associated DSH session ID (used for self-action echo suppression and deduplication). */
  readonly sessionId?: string
  /** Optional deduplication key; newer events with the same key supersede older buffered ones. */
  readonly dedupeKey?: string
  /** Concise single-sentence Chinese summary suitable for spoken delivery. */
  readonly summary: string
  /** Structured metadata recorded in the journal. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Registered hook descriptor managed by `VoiceHookRegistry`. */
export interface VoiceHookDefinition {
  /** Unique hook identifier. */
  readonly id: string
  /** Default priority level. */
  readonly priority: VoiceHookPriority
  /** Check whether this hook is enabled in current resolved configuration. */
  isEnabled(config: ResolvedTtdsConfig): boolean
}

/** Event hook registry and quiet-grace coalescing engine contract (`ctx.ttdsHooks`). */
export interface VoiceHookRegistryContract {
  /** Register a hook definition; returns a disposer removing the registration. */
  register(hook: VoiceHookDefinition): () => void
  /** Mark a DSH session mutation as TTDS-originated so synchronous echo events are suppressed. */
  beginSelfAction(sessionId: string, actionKind: string): SelfActionHandle
  /** Enqueue a normalized lifecycle event or `ttds_tool_output_ready` trigger into the quiet-grace buffer. */
  enqueue(event: VoiceHookTriggerPayload): void
  /** Notify the engine that an upstream response consumed pending tool outputs naturally, clearing redundant nudges. */
  markToolOutputsNaturallyConsumed(callIds?: readonly string[]): void
  /** Inspect currently buffered (unflushed) hook payloads for testing and diagnostics. */
  getBufferedEvents(): readonly VoiceHookTriggerPayload[]
  /** Clear all buffered events and timers. */
  clear(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** TTDS Host realtime voice session and adapter service. */
    ttdsRuntime: VoiceRuntimeServiceContract
    /** TTDS DSH bridge tool registry and confirmation dispatcher. */
    ttdsTools: VoiceToolRegistryContract
    /** TTDS background DSH event hook registry and quiet-grace engine. */
    ttdsHooks: VoiceHookRegistryContract
  }
}

export type { VoiceTurnPhase }
