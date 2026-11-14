import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import {
  resolveTtdsConfig,
  toClientSafeConfigView,
  type ResolvedTtdsConfig,
  type VoiceFeedItem,
  type VoiceHookTriggerPayload,
  type VoiceRuntimeServiceContract,
  type VoiceSessionSnapshot,
} from '../../src/shared/index.ts'
import { EventHookEngine, registerBuiltinVoiceHooks } from '../../src/hooks/index.ts'

/**
 * Mount real Cordis and session services with a controllable runtime delivery boundary.
 * @param active - whether a supervisor session starts connected and listening.
 * @returns owned services, captured runtime effects, and state transition controls.
 */
export function createFixture(active = true) {
  const ctx = new Context()
  let config = resolveTtdsConfig({}, {})
  let snapshot: VoiceSessionSnapshot = {
    supervisorSessionId: active ? 'voice-1' : null,
    connectionEpoch: 1,
    phase: active ? 'listening' : 'idle',
    providerReady: true,
    statusReason: null,
    muted: false,
    inputAdmissionSeq: 0,
    pendingToolCount: 0,
    pendingConfirmations: [],
    config: toClientSafeConfigView(config),
  }
  const listeners = new Set<(snapshot: VoiceSessionSnapshot) => void>()
  const notifications: { text: string; metadata: Readonly<Record<string, unknown>> }[] = []
  const feed: VoiceFeedItem[] = []
  let spokenTurns = 0
  let leases = 0
  let deliver: () => Promise<boolean> = () => Promise.resolve(true)
  const controller = new AbortController()
  const runtime = {
    getConfig: () => config,
    getSnapshot: () => snapshot,
    acquireLease: () => {
      leases++
      return {
        signal: controller.signal,
        release: () => { leases-- },
      }
    },
    onStateChange: (listener: (snapshot: VoiceSessionSnapshot) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    requestSpokenTurn: () => {
      spokenTurns++
      return deliver()
    },
    injectHookNotification: (text: string, metadata: Readonly<Record<string, unknown>>) => {
      notifications.push({ text, metadata })
      return deliver()
    },
    publishFeedItem: (item: Omit<VoiceFeedItem, 'id' | 'timestampMs'>) => {
      const result = { ...item, id: String(feed.length), timestampMs: Date.now() }
      feed.push(result)
      return result
    },
  } satisfies Pick<VoiceRuntimeServiceContract,
    'getConfig' | 'getSnapshot' | 'acquireLease' | 'onStateChange'
    | 'requestSpokenTurn' | 'injectHookNotification' | 'publishFeedItem'>
  ctx.provide('ttdsRuntime', runtime)
  new SessionStore(ctx)
  const engine = new EventHookEngine(ctx)
  const unregister = registerBuiltinVoiceHooks(ctx, engine)
  return {
    ctx,
    engine,
    notifications,
    feed,
    listeners,
    controller,
    unregister,
    get spokenTurns() { return spokenTurns },
    get leases() { return leases },
    setDelivery: (delivery: () => Promise<boolean>) => { deliver = delivery },
    setState: (patch: Partial<VoiceSessionSnapshot>) => {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener(snapshot)
    },
    setConfig: (hooks: Partial<ResolvedTtdsConfig['hooks']>, notify = true) => {
      config = { ...config, hooks: { ...config.hooks, ...hooks } }
      snapshot = { ...snapshot, config: toClientSafeConfigView(config) }
      if (notify) for (const listener of listeners) listener(snapshot)
    },
  }
}

/**
 * Construct one normalized background notification.
 * @param overrides - payload fields differing from the normal completion case.
 * @returns complete trigger payload.
 */
export function event(overrides: Partial<VoiceHookTriggerPayload> = {}): VoiceHookTriggerPayload {
  return {
    hookId: 'agent/turn-settled',
    priority: 'normal',
    sessionId: 'background-1',
    summary: '后台任务已完成',
    ...overrides,
  }
}

/**
 * Construct an acknowledged tool-output wakeup without injecting result text.
 * @param callId - upstream tool call identifier.
 * @returns normalized tool-output notification.
 */
export function toolReady(callId: string): VoiceHookTriggerPayload {
  return event({
    hookId: 'ttds_tool_output_ready',
    dedupeKey: `tool_ready:${callId}`,
    metadata: { callId },
    summary: '工具结果已就绪',
  })
}
