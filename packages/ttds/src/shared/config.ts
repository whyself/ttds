/** Schemastery configuration schema, defaults, and explicit resolution for `@whyself/ttds`. */
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  composeVoiceInstructions,
  DEFAULT_QWEN_VOICE,
} from './voice-instructions.ts'

export {
  composeVoiceInstructions,
  DEFAULT_QWEN_VOICE,
  DEFAULT_VOICE_SYSTEM_INSTRUCTIONS,
} from './voice-instructions.ts'

/** Supported realtime voice provider identifiers; extensible as new providers register. */
export type VoiceProviderId = 'qwen-realtime' | (string & {})

/** Supported Qwen-Audio 3.1 Realtime model identifiers. */
export type QwenRealtimeModel = 'qwen-audio-3.1-realtime-flash' | 'qwen-audio-3.1-realtime-plus'

/** Supported cloud turn-detection modes exposed in configuration. */
export type TurnDetectionMode = 'smart_turn_v2' | 'smart_turn' | 'server_vad' | 'push_to_talk'

/** Two-tier execution confirmation policy for mutating or external voice tools. */
export type VoiceConfirmationMode = 'auto' | 'ui'

/** Default DashScope Realtime WebSocket endpoint when no workspace subdomain is configured. */
export const DEFAULT_DASHSCOPE_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'

/** Qwen-Audio 3.1 Realtime provider connection and model parameters. */
export interface QwenRealtimeProviderConfig {
  /** DashScope API key; falls back to `$DASHSCOPE_API_KEY` when left empty in config. */
  readonly apiKey?: string
  /** Optional Bailian workspace identifier (`X-DashScope-WorkSpace` and workspace subdomain routing). */
  readonly workspaceId?: string
  /** Optional explicit WebSocket base URL override. */
  readonly baseUrl?: string
  /** Selected Qwen-Audio 3.1 Realtime model tier. */
  readonly model?: QwenRealtimeModel
  /** Selected output voice timbre identifier. */
  readonly voice?: string
  /** Maximum conversation turns retained in upstream realtime context (`5` to `50`). */
  readonly maxHistoryTurns?: number
}

/** Resolved Qwen-Audio 3.1 Realtime provider configuration with all defaults applied. */
export interface ResolvedQwenRealtimeProviderConfig {
  /** Resolved API key (empty string when neither config nor environment provides one). */
  readonly apiKey: string
  /** Whether a non-empty API key is available from config or environment. */
  readonly hasApiKey: boolean
  /** Source of the active API key (`config`, `env`, or `none`). */
  readonly apiKeySource: 'config' | 'env' | 'none'
  /** Optional trimmed workspace identifier. */
  readonly workspaceId: string
  /** Resolved WebSocket endpoint URL without query string. */
  readonly endpointUrl: string
  /** Selected Qwen Realtime model identifier. */
  readonly model: QwenRealtimeModel
  /** Selected voice timbre identifier. */
  readonly voice: string
  /** Context turn retention window (`5` to `50`). */
  readonly maxHistoryTurns: number
  /** Native upstream search stays disabled so queries route through `dsh_search`. */
  readonly enableSearch: false
}

/** Provider-keyed map of provider-specific configuration blocks. */
export interface VoiceProvidersConfig {
  /** Alibaba Cloud Bailian Qwen-Audio 3.1 Realtime settings. */
  readonly 'qwen-realtime'?: QwenRealtimeProviderConfig
}

/** Speech turn-taking, instruction customization, and audio capture preferences. */
export interface VoiceConversationConfig {
  /** Turn-detection mode (`push_to_talk` maps to `turn_detection: null` on the wire). */
  readonly turnDetection?: TurnDetectionMode
  /** Turn-detection sensitivity threshold (`-1.0` to `1.0`). */
  readonly threshold?: number
  /** Silence duration in milliseconds (`200` to `2000`), sent only in `server_vad` mode. */
  readonly silenceDurationMs?: number
  /** User-editable custom instructions appended to {@link DEFAULT_VOICE_SYSTEM_INSTRUCTIONS}. */
  readonly customInstructions?: string
  /** Browser input microphone `deviceId` (`""` selects system default). */
  readonly inputDeviceId?: string
  /** Browser output speaker `deviceId` (`""` selects system default). */
  readonly outputDeviceId?: string
  /** Start new voice sessions with microphone capture muted (`false` by default). */
  readonly startMuted?: boolean
}

/** Resolved speech turn-taking and instruction configuration. */
export interface ResolvedVoiceConversationConfig {
  /** Resolved turn-detection mode. */
  readonly turnDetection: TurnDetectionMode
  /** Clamped threshold in `[-1.0, 1.0]`. */
  readonly threshold: number
  /** Clamped silence duration in `[200, 2000]` ms. */
  readonly silenceDurationMs: number
  /** Trimmed user custom instructions. */
  readonly customInstructions: string
  /** Combined system instructions (`DEFAULT_VOICE_SYSTEM_INSTRUCTIONS` + `customInstructions`). */
  readonly mergedInstructions: string
  /** Selected input device identifier (`""` for system default). */
  readonly inputDeviceId: string
  /** Selected output speaker identifier (`""` for system default). */
  readonly outputDeviceId: string
  /** Whether new voice sessions begin with microphone capture muted. */
  readonly startMuted: boolean
}

/** Enablement and confirmation gates for DSH bridge tools exposed to the voice supervisor. */
export interface VoiceToolsConfig {
  /** Enable read-only session listing, progress, workspace diff, and history inspection tools. */
  readonly enableReadTools?: boolean
  /** Enable `dsh_search` routing through DSH's configured `ctx.web` search provider. */
  readonly enableSearchTool?: boolean
  /** Confirmation tier for session creation, prompt submission, model switching, and cancellation. */
  readonly writeConfirmation?: VoiceConfirmationMode
  /** Maximum execution timeout per voice tool call in milliseconds. */
  readonly toolTimeoutMs?: number
}

/** Resolved tool enablement and confirmation policy. */
export interface ResolvedVoiceToolsConfig {
  /** Whether read-only inspection tools are registered. */
  readonly enableReadTools: boolean
  /** Whether `dsh_search` is registered. */
  readonly enableSearchTool: boolean
  /** Confirmation tier for write/dispatch tools. */
  readonly writeConfirmation: VoiceConfirmationMode
  /** Tool execution timeout in milliseconds. */
  readonly toolTimeoutMs: number
}

/** Background DSH lifecycle event hook toggles and quiet-turn grace policy. */
export interface VoiceHooksConfig {
  /** Quiet grace window in milliseconds after speech settles before buffered hooks dispatch. */
  readonly quietGraceMs?: number
  /** Announce background agent turn completions (`agent/turn-settled`). */
  readonly onTurnSettled?: boolean
  /** Announce background tool approval requests (`agent/tool-approval`). */
  readonly onToolApproval?: boolean
  /** Announce background agent errors (`agent/error`). */
  readonly onAgentError?: boolean
  /** Announce non-zero shell exits (`shell/exit-error`). */
  readonly onShellExitError?: boolean
  /** Announce background subagent completions or failures (`subagent/settled`). */
  readonly onSubagentSettled?: boolean
}

/** Resolved lifecycle event hook configuration. */
export interface ResolvedVoiceHooksConfig {
  /** Quiet grace window in milliseconds (`>= 0`). */
  readonly quietGraceMs: number
  /** Whether `agent/turn-settled` hook is active. */
  readonly onTurnSettled: boolean
  /** Whether `agent/tool-approval` hook is active. */
  readonly onToolApproval: boolean
  /** Whether `agent/error` hook is active. */
  readonly onAgentError: boolean
  /** Whether `shell/exit-error` hook is active. */
  readonly onShellExitError: boolean
  /** Whether `subagent/settled` hook is active. */
  readonly onSubagentSettled: boolean
}

/** Top-level user-configurable schema for `@whyself/ttds`. */
export interface TtdsConfig {
  /** Active voice runtime provider identifier. */
  readonly provider?: VoiceProviderId
  /** Provider-specific connection and model configurations. */
  readonly providers?: VoiceProvidersConfig
  /** Turn-taking, custom prompt, and microphone settings. */
  readonly voice?: VoiceConversationConfig
  /** DSH session bridge and `dsh_search` tool policies. */
  readonly tools?: VoiceToolsConfig
  /** Background DSH event hook policies. */
  readonly hooks?: VoiceHooksConfig
  /** Directory storing `SupervisorSessionJournal` JSONL logs (`~/.dsh/ttds/sessions` by default). */
  readonly storageDir?: string
}

/** Cordis volatile configuration wrapper exposing the latest live value via `.get()`. */
export interface VolatileLike<T> {
  /** Read the current live configuration value. */
  readonly get: () => T
}

/** Runtime configuration shape delivered to `apply(ctx, config)` when schema branches are `.volatile()`. */
export interface LiveTtdsConfig {
  /** Active provider identifier or its volatile reference. */
  readonly provider?: VoiceProviderId | VolatileLike<VoiceProviderId | undefined>
  /** Provider-specific blocks or their volatile reference. */
  readonly providers?: VoiceProvidersConfig | VolatileLike<VoiceProvidersConfig | undefined>
  /** Voice conversation settings or their volatile reference. */
  readonly voice?: VoiceConversationConfig | VolatileLike<VoiceConversationConfig | undefined>
  /** Bridge tool settings or their volatile reference. */
  readonly tools?: VoiceToolsConfig | VolatileLike<VoiceToolsConfig | undefined>
  /** Event hook settings or their volatile reference. */
  readonly hooks?: VoiceHooksConfig | VolatileLike<VoiceHooksConfig | undefined>
  /** Non-volatile journal storage directory path. */
  readonly storageDir?: string
}

function readLive<T>(value: T | VolatileLike<T>): T {
  if (typeof value === 'object' && value !== null && 'get' in value) {
    const getter = (value as { readonly get?: (() => T) | undefined }).get
    if (typeof getter === 'function') return getter()
  }
  return value as T
}

/**
 * Unwrap any Cordis `.volatile()` wrappers into a plain {@link TtdsConfig} snapshot.
 * @param raw - plain or volatile-wrapped configuration object.
 * @returns detached plain configuration object.
 */
export function unwrapTtdsConfig(raw: TtdsConfig | LiveTtdsConfig = {}): TtdsConfig {
  const provider = readLive(raw.provider)
  const providers = readLive(raw.providers)
  const voice = readLive(raw.voice)
  const tools = readLive(raw.tools)
  const hooks = readLive(raw.hooks)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(providers === undefined ? {} : { providers }),
    ...(voice === undefined ? {} : { voice }),
    ...(tools === undefined ? {} : { tools }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(raw.storageDir === undefined ? {} : { storageDir: raw.storageDir }),
  }
}

/** Fully defaulted and validated runtime configuration consumed across TTDS services. */
export interface ResolvedTtdsConfig {
  /** Selected provider identifier. */
  readonly provider: VoiceProviderId
  /** Resolved provider configurations. */
  readonly providers: {
    readonly 'qwen-realtime': ResolvedQwenRealtimeProviderConfig
  }
  /** Resolved voice conversation parameters. */
  readonly voice: ResolvedVoiceConversationConfig
  /** Resolved tool policies. */
  readonly tools: ResolvedVoiceToolsConfig
  /** Resolved event hook policies. */
  readonly hooks: ResolvedVoiceHooksConfig
  /** Resolved journal storage directory path. */
  readonly storageDir: string
}

/** Public client-safe projection of {@link ResolvedTtdsConfig} that never carries raw API keys. */
export interface ClientSafeTtdsConfigView {
  /** Selected provider identifier. */
  readonly provider: VoiceProviderId
  /** Sanitized Qwen provider view without secret material. */
  readonly qwenRealtime: Omit<ResolvedQwenRealtimeProviderConfig, 'apiKey'>
  /** Resolved voice conversation settings. */
  readonly voice: ResolvedVoiceConversationConfig
  /** Resolved tool settings. */
  readonly tools: ResolvedVoiceToolsConfig
  /** Resolved hook settings. */
  readonly hooks: ResolvedVoiceHooksConfig
}

/** Schemastery schema validating `@whyself/ttds` plugin configuration in `cordis.patch.yml`. */
export const TtdsConfigSchema: z<TtdsConfig, LiveTtdsConfig> = z.object({
  provider: z.string().default('qwen-realtime').volatile(),
  providers: z.object({
    'qwen-realtime': z.object({
      apiKey: z.string().role('secret'),
      workspaceId: z.string(),
      baseUrl: z.string(),
      model: z.union([
        z.const('qwen-audio-3.1-realtime-flash'),
        z.const('qwen-audio-3.1-realtime-plus'),
      ]).default('qwen-audio-3.1-realtime-flash'),
      voice: z.string().default(DEFAULT_QWEN_VOICE),
      maxHistoryTurns: z.natural().min(5).max(50).default(20),
    }).default({}),
  }).default({}).volatile(),
  voice: z.object({
    turnDetection: z.union([
      z.const('smart_turn_v2'),
      z.const('smart_turn'),
      z.const('server_vad'),
      z.const('push_to_talk'),
    ]).default('smart_turn_v2'),
    threshold: z.number().min(-1).max(1).default(0.5),
    silenceDurationMs: z.natural().min(200).max(2000).default(800),
    customInstructions: z.string().default(''),
    inputDeviceId: z.string().default(''),
    outputDeviceId: z.string().default(''),
    startMuted: z.boolean().default(false),
  }).default({}).volatile(),
  tools: z.object({
    enableReadTools: z.boolean().default(true),
    enableSearchTool: z.boolean().default(true),
    writeConfirmation: z.union([
      z.const('auto'),
      z.const('ui'),
    ]).default('ui'),
    toolTimeoutMs: z.natural().min(1000).max(300_000).default(60_000),
  }).default({}).volatile(),
  hooks: z.object({
    quietGraceMs: z.natural().min(0).max(60_000).default(1800),
    onTurnSettled: z.boolean().default(true),
    onToolApproval: z.boolean().default(true),
    onAgentError: z.boolean().default(true),
    onShellExitError: z.boolean().default(true),
    onSubagentSettled: z.boolean().default(true),
  }).default({}).volatile(),
  storageDir: z.string(),
})

/**
 * Compute the DashScope Realtime WebSocket URL from workspace ID and optional baseUrl override.
 * @param workspaceId - trimmed Bailian workspace identifier, or empty string.
 * @param baseUrl - optional explicit URL override (`ws://` or `wss://`).
 * @returns normalized WebSocket endpoint URL without `?model=` query parameters.
 */
export function resolveQwenEndpointUrl(workspaceId: string, baseUrl: string): string {
  if (baseUrl !== '') {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch (error) {
      throw new Error(`ttds: invalid providers.qwen-realtime.baseUrl "${baseUrl}"`, { cause: error })
    }
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
      throw new Error(`ttds: providers.qwen-realtime.baseUrl must use ws: or wss:, got "${parsed.protocol}"`)
    }
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  }
  if (workspaceId !== '') {
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
      throw new Error('ttds: providers.qwen-realtime.workspaceId contains invalid characters')
    }
    return `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`
  }
  return DEFAULT_DASHSCOPE_REALTIME_URL
}

/**
 * Explicitly resolve a raw {@link TtdsConfig} and process environment into a {@link ResolvedTtdsConfig}.
 * @param input - raw or volatile-wrapped plugin configuration object (may omit optional sections).
 * @param env - environment dictionary used to resolve `DASHSCOPE_API_KEY`, `WORKSPACE_ID`, and `DSH_HOME`.
 * @returns fully defaulted, validated configuration object.
 */
export function resolveTtdsConfig(
  input: TtdsConfig | LiveTtdsConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTtdsConfig {
  const raw = unwrapTtdsConfig(input)
  const provider = (raw.provider ?? 'qwen-realtime').trim() || 'qwen-realtime'
  const qwenRaw = raw.providers?.['qwen-realtime'] ?? {}
  const configKey = (qwenRaw.apiKey ?? '').trim()
  const envKey = (env.DASHSCOPE_API_KEY ?? '').trim()
  const apiKey = configKey !== '' ? configKey : envKey
  const apiKeySource: 'config' | 'env' | 'none' = configKey !== ''
    ? 'config'
    : envKey !== '' ? 'env' : 'none'
  const workspaceId = (qwenRaw.workspaceId ?? env.WORKSPACE_ID ?? '').trim()
  const baseUrl = (qwenRaw.baseUrl ?? '').trim()
  const endpointUrl = resolveQwenEndpointUrl(workspaceId, baseUrl)
  const model: QwenRealtimeModel = qwenRaw.model ?? 'qwen-audio-3.1-realtime-flash'
  const voice = (qwenRaw.voice ?? DEFAULT_QWEN_VOICE).trim() || DEFAULT_QWEN_VOICE
  const maxHistoryTurns = Math.min(50, Math.max(5, Math.trunc(qwenRaw.maxHistoryTurns ?? 20)))

  const voiceRaw = raw.voice ?? {}
  const turnDetection: TurnDetectionMode = voiceRaw.turnDetection ?? 'smart_turn_v2'
  const threshold = Math.min(1, Math.max(-1, voiceRaw.threshold ?? 0.5))
  const silenceDurationMs = Math.min(2000, Math.max(200, Math.trunc(voiceRaw.silenceDurationMs ?? 800)))
  const customInstructions = (voiceRaw.customInstructions ?? '').trim()
  const inputDeviceId = (voiceRaw.inputDeviceId ?? '').trim()
  const outputDeviceId = (voiceRaw.outputDeviceId ?? '').trim()
  const startMuted = voiceRaw.startMuted ?? false

  const toolsRaw = raw.tools ?? {}
  const enableReadTools = toolsRaw.enableReadTools ?? true
  const enableSearchTool = toolsRaw.enableSearchTool ?? true
  const writeConfirmation: VoiceConfirmationMode = toolsRaw.writeConfirmation ?? 'ui'
  const toolTimeoutMs = Math.min(300_000, Math.max(1000, Math.trunc(toolsRaw.toolTimeoutMs ?? 60_000)))

  const hooksRaw = raw.hooks ?? {}
  const quietGraceMs = Math.min(60_000, Math.max(0, Math.trunc(hooksRaw.quietGraceMs ?? 1800)))
  const onTurnSettled = hooksRaw.onTurnSettled ?? true
  const onToolApproval = hooksRaw.onToolApproval ?? true
  const onAgentError = hooksRaw.onAgentError ?? true
  const onShellExitError = hooksRaw.onShellExitError ?? true
  const onSubagentSettled = hooksRaw.onSubagentSettled ?? true

  const dshHome = (env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const storageDir = (raw.storageDir ?? '').trim() || join(dshHome, 'ttds', 'sessions')

  return {
    provider,
    providers: {
      'qwen-realtime': {
        apiKey,
        hasApiKey: apiKey !== '',
        apiKeySource,
        workspaceId,
        endpointUrl,
        model,
        voice,
        maxHistoryTurns,
        enableSearch: false,
      },
    },
    voice: {
      turnDetection,
      threshold,
      silenceDurationMs,
      customInstructions,
      mergedInstructions: composeVoiceInstructions(customInstructions),
      inputDeviceId,
      outputDeviceId,
      startMuted,
    },
    tools: {
      enableReadTools,
      enableSearchTool,
      writeConfirmation,
      toolTimeoutMs,
    },
    hooks: {
      quietGraceMs,
      onTurnSettled,
      onToolApproval,
      onAgentError,
      onShellExitError,
      onSubagentSettled,
    },
    storageDir,
  }
}

/**
 * Strip secret fields from {@link ResolvedTtdsConfig} before sending status over RPC or WebSocket.
 * @param resolved - resolved host configuration.
 * @returns sanitized client-safe configuration snapshot.
 */
export function toClientSafeConfigView(resolved: ResolvedTtdsConfig): ClientSafeTtdsConfigView {
  const { apiKey: _redacted, ...qwenSafe } = resolved.providers['qwen-realtime']
  return {
    provider: resolved.provider,
    qwenRealtime: qwenSafe,
    voice: resolved.voice,
    tools: resolved.tools,
    hooks: resolved.hooks,
  }
}
