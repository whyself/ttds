/** Host plugin entry and public contracts for Talk to DeepSeek (`@whyself/ttds`). */
import type { Context } from '@deepseek-ai/cordis'
import { EventHookEngine, registerBuiltinVoiceHooks } from './hooks/index.ts'
import { mountTtdsTransport, VoiceRuntimeService } from './runtime/index.ts'
import { TtdsConfigSchema, unwrapTtdsConfig, type LiveTtdsConfig, type TtdsConfig } from './shared/index.ts'
import { registerBuiltinVoiceTools, VoiceApprovalHostBridge, VoiceToolRegistry } from './tools/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional Host settings form projection service. */
    settings?: {
      /** Configure automatic settings page generation for a plugin fiber. */
      configure: (presentation: { auto?: boolean }, owner?: Context['fiber']) => () => void
    }
  }
  interface Events {
    /** Emitted by Host SettingsForms when a plugin namespace revision updates. */
    'settings/document-updated'(ns: string, revision: number): void
    /** Emitted by Cordis plugin loader when a running fiber commits `.volatile()` configuration changes. */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export {
  assertNever,
  composeVoiceInstructions,
  DEFAULT_DASHSCOPE_REALTIME_URL,
  DEFAULT_QWEN_VOICE,
  DEFAULT_VOICE_SYSTEM_INSTRUCTIONS,
  resolveQwenEndpointUrl,
  resolveTtdsConfig,
  toClientSafeConfigView,
  TTDS_REALTIME_WS_PATH,
  TTDS_RPC_PREFIX,
  TtdsConfigSchema,
  unwrapTtdsConfig,
} from './shared/index.ts'
export type {
  ClientRealtimeFrame,
  ClientSafeTtdsConfigView,
  ConsumerLease,
  LiveTtdsConfig,
  QwenRealtimeModel,
  QwenRealtimeProviderConfig,
  ResolvedQwenRealtimeProviderConfig,
  ResolvedTtdsConfig,
  ResolvedVoiceConversationConfig,
  ResolvedVoiceHooksConfig,
  ResolvedVoiceToolsConfig,
  SelfActionHandle,
  ServerRealtimeFrame,
  SupervisorJournalRecord,
  TtdsConfig,
  TtdsRpcEndpoints,
  TurnDetectionMode,
  VoiceAdapterEvent,
  VoiceAdapterSession,
  VoiceAdapterSessionConfig,
  VoiceAdapterToolCall,
  VoiceConfirmationMode,
  VoiceConversationConfig,
  VoiceFeedItem,
  VoiceFeedItemKind,
  VoiceHookDefinition,
  VoiceHookPriority,
  VoiceHookRegistryContract,
  VoiceHookTriggerPayload,
  VoiceHooksConfig,
  VoicePendingUiConfirmationView,
  VoicePlaybackCursors,
  VoiceProviderId,
  VoiceProvidersConfig,
  VoiceRuntimeAdapter,
  VoiceRuntimeServiceContract,
  VoiceSessionSnapshot,
  VoiceToolDefinition,
  VoiceToolExecutionContext,
  VoiceToolJsonSchema,
  VoiceToolRegistryContract,
  VoiceToolResult,
  VoiceToolsConfig,
  VoiceTurnPhase,
  VoiceUpstreamToolSpec,
  VolatileLike,
} from './shared/index.ts'
export {
  mountTtdsTransport,
  QwenRealtimeAdapter,
  SupervisorSessionJournal,
  VoiceRuntimeService,
} from './runtime/index.ts'
export type { QwenWebSocketFactory } from './runtime/index.ts'
export { registerBuiltinVoiceTools, VoiceApprovalHostBridge, VoiceToolRegistry } from './tools/index.ts'
export type {
  HostApprovalOutcome,
  HostApprovalRequest,
  VoicePendingApprovalView,
  VoiceToolHostBridge,
} from './tools/index.ts'
export { EventHookEngine, registerBuiltinVoiceHooks, VoiceHookRegistry } from './hooks/index.ts'

/** Cordis plugin identifier. */
export const name = 'ttds'

/** Schemastery configuration schema validated by the DSH Loader. */
export const Config = TtdsConfigSchema

/**
 * Mount the TTDS voice runtime, DSH bridge tools, background event hooks, and authenticated transport.
 * @param ctx - plugin context that owns every registered service, effect, and listener.
 * @param config - validated plugin configuration from the active DSH profile.
 */
export function apply(ctx: Context, config: TtdsConfig | LiveTtdsConfig = {}): void {
  const runtime = new VoiceRuntimeService(ctx, unwrapTtdsConfig(config))
  mountTtdsTransport(ctx, runtime)
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (settings !== undefined) settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber))
  })
  const syncConfig = (): void => {
    void runtime.updateConfig(unwrapTtdsConfig(config)).catch(() => {
      // Runtime surfaces operational errors through its own state snapshot; never crash the Host process.
    })
  }
  ctx.on('loader/volatile-update', () => { syncConfig() })
  ctx.on('settings/document-updated', (ns) => {
    if (ns === 'ttds') syncConfig()
  })
  ctx.inject(['ttdsRuntime'], (runtimeCtx) => {
    if (runtimeCtx.get('ttdsToolHost') === undefined) new VoiceApprovalHostBridge(runtimeCtx)
    const tools = new VoiceToolRegistry(runtimeCtx)
    registerBuiltinVoiceTools(runtimeCtx, tools)
    const hooks = new EventHookEngine(runtimeCtx)
    registerBuiltinVoiceHooks(runtimeCtx, hooks)
  })
}
