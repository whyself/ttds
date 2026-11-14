/** Wire protocol shared by the Host `/api/ttds/realtime` WebSocket, `/ttds` RPC endpoints, and Web client. */
import type { ClientSafeTtdsConfigView } from './config.ts'

/** Realtime voice stage states rendered across the main stage, sidebar indicator, and floating orb. */
export type VoiceTurnPhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

/** Category of transient event pills rendered in the borderless fading stage stream. */
export type VoiceFeedItemKind = 'transcript_user' | 'transcript_assistant' | 'tool_call' | 'hook_event' | 'confirmation' | 'diagnostic'

/** Transient stage event stream item projected to the browser UI. */
export interface VoiceFeedItem {
  /** Stable unique identifier within the supervisor session. */
  readonly id: string
  /** Monotonic timestamp in epoch milliseconds. */
  readonly timestampMs: number
  /** Discriminated visual category. */
  readonly kind: VoiceFeedItemKind
  /** Short primary label or spoken text. */
  readonly text: string
  /** Optional secondary badge or status detail (such as tool status or session ID). */
  readonly detail?: string
  /** Optional pending UI confirmation request attached to this item. */
  readonly confirmation?: VoicePendingUiConfirmationView
}

/** Pending UI confirmation card payload delivered to the browser when confirmation mode is `ui`. */
export interface VoicePendingUiConfirmationView {
  /** Confirmation token matching the blocked tool invocation. */
  readonly confirmationId: string
  /** Tool identifier awaiting user decision. */
  readonly toolName: string
  /** Localized or concise summary of the requested action. */
  readonly summary: string
  /** Confirmation mode (`ui` only). */
  readonly mode: 'ui'
  /** Creation timestamp in epoch milliseconds. */
  readonly createdAtMs: number
}

/** Live runtime status snapshot shared over `/ttds/status` RPC and WebSocket `state.snapshot` frames. */
export interface VoiceSessionSnapshot {
  /** Active supervisor session ID when a live session exists, or `null` when disconnected. */
  readonly supervisorSessionId: string | null
  /** Monotonic connection generation counter incremented on each connect/rotate/disconnect transition. */
  readonly connectionEpoch: number
  /** Current turn phase for UI waveform and orb visualization. */
  readonly phase: VoiceTurnPhase
  /** Whether the active provider has valid credentials and registered adapter support. */
  readonly providerReady: boolean
  /** Optional human-readable readiness or failure reason (never contains secret values). */
  readonly statusReason: string | null
  /** Whether local microphone capture is muted by the user. */
  readonly muted: boolean
  /** Monotonic sequence counter tracking admitted user input turns (`speech_started` or `input.text`). */
  readonly inputAdmissionSeq: number
  /** Count of background voice tool executions currently in flight. */
  readonly pendingToolCount: number
  /** Pending confirmation items awaiting user response. */
  readonly pendingConfirmations: readonly VoicePendingUiConfirmationView[]
  /** Sanitized configuration snapshot. */
  readonly config: ClientSafeTtdsConfigView
}

/** Frames sent from the Web browser (or E2E test harness) to the Host over `/api/ttds/realtime`. */
export type ClientRealtimeFrame =
  | {
    /** Start or join the active realtime voice session on the Host. */
    readonly type: 'session.start'
    /** Optional microphone device preference reported by the browser. */
    readonly inputDeviceId?: string
  }
  | {
    /** Stop and tear down the active realtime voice session. */
    readonly type: 'session.stop'
  }
  | {
    /** Append one PCM16 LE 16kHz mono audio chunk encoded as base64. */
    readonly type: 'audio.append'
    /** Base64-encoded PCM16 little-endian 16kHz mono bytes. */
    readonly audioBase64: string
  }
  | {
    /** Commit buffered audio explicitly when operating in `push_to_talk` mode. */
    readonly type: 'audio.commit'
  }
  | {
    /** Send a direct text utterance into the realtime voice session (also used by text-simulated E2E tests). */
    readonly type: 'input.text'
    /** Spoken-equivalent user utterance text. */
    readonly text: string
  }
  | {
    /** Interrupt current assistant speech playback and cancel upstream generation. */
    readonly type: 'speech.interrupt'
  }
  | {
    /** Update mute state recorded on the session snapshot. */
    readonly type: 'audio.mute'
    /** True when microphone capture is muted. */
    readonly muted: boolean
  }
  | {
    /** Report that the browser's Web Audio playback queue drained through a specific audio sequence cursor. */
    readonly type: 'playback.drained'
    /** Highest `audioSeq` whose scheduled buffer finished audible playback. */
    readonly playbackSeq: number
    /** Assistant response ID associated with the drained audio, when known. */
    readonly responseId?: string
  }
  | {
    /** Approve or reject a pending UI confirmation card. */
    readonly type: 'confirmation.respond'
    /** Target confirmation identifier. */
    readonly confirmationId: string
    /** True to approve execution, false to cancel. */
    readonly approved: boolean
  }
  | {
    /** Heartbeat ping frame echoed as `pong`. */
    readonly type: 'ping'
    /** Client timestamp in milliseconds. */
    readonly timestampMs: number
  }

/** Frames pushed from the Host to connected Web clients over `/api/ttds/realtime`. */
export type ServerRealtimeFrame =
  | {
    /** Full state snapshot emitted immediately on WebSocket attach and after state transitions. */
    readonly type: 'state.snapshot'
    /** Current runtime session snapshot. */
    readonly snapshot: VoiceSessionSnapshot
  }
  | {
    /** Downlink PCM16 LE 24kHz mono audio chunk for gapless browser playback. */
    readonly type: 'audio.delta'
    /** Monotonic downlink audio chunk sequence number used by `playback.drained` cursors. */
    readonly audioSeq: number
    /** Upstream assistant response identifier. */
    readonly responseId: string
    /** Base64-encoded 24kHz mono PCM16 little-endian audio bytes. */
    readonly pcm24kBase64: string
  }
  | {
    /** Instruct the browser to flush and stop any queued downlink audio immediately (barge-in or session reset). */
    readonly type: 'audio.clear'
    /** Reason for clearing queued audio. */
    readonly reason: 'barge_in' | 'interrupted' | 'session_closed'
  }
  | {
    /** Incremental or final transcript update for user or assistant speech. */
    readonly type: 'transcript'
    /** Speaker role. */
    readonly role: 'user' | 'assistant'
    /** Transcript text content. */
    readonly text: string
    /** True when the turn's transcript is finalized. */
    readonly final: boolean
    /** Upstream item or response identifier. */
    readonly itemId: string
  }
  | {
    /** Transient event pill pushed to the stage's borderless fading stream. */
    readonly type: 'feed.item'
    /** Event feed item. */
    readonly item: VoiceFeedItem
  }
  | {
    /** Structured error frame surfaced to the client without exposing credentials. */
    readonly type: 'error'
    /** Machine-readable error code. */
    readonly code: string
    /** User-safe error description. */
    readonly message: string
  }
  | {
    /** Heartbeat pong response. */
    readonly type: 'pong'
    /** Echoed client timestamp. */
    readonly timestampMs: number
  }

/** RPC channel prefix registered on `ctx.connection.rpc`. */
export const TTDS_RPC_PREFIX = '/ttds'

/** Exact WebSocket upgrade route path registered on `ctx.webServer`. */
export const TTDS_REALTIME_WS_PATH = '/api/ttds/realtime'

/** Unary RPC endpoints served under `/ttds/<method>`. */
export interface TtdsRpcEndpoints {
  /** Read current session status and sanitized config snapshot. */
  'status': {
    readonly request: Record<string, never>
    readonly response: VoiceSessionSnapshot
  }
  /** Start or ensure an active supervisor voice session. */
  'start': {
    readonly request: { readonly inputDeviceId?: string }
    readonly response: VoiceSessionSnapshot
  }
  /** Stop the active supervisor voice session. */
  'stop': {
    readonly request: Record<string, never>
    readonly response: VoiceSessionSnapshot
  }
  /** Inject a text utterance directly into the active session (used by UI quick actions or E2E harnesses). */
  'sendText': {
    readonly request: { readonly text: string }
    readonly response: { readonly accepted: boolean; readonly inputAdmissionSeq: number }
  }
  /** Resolve a pending UI confirmation over unary RPC. */
  'confirm': {
    readonly request: { readonly confirmationId: string; readonly approved: boolean }
    readonly response: { readonly resolved: boolean }
  }
}
