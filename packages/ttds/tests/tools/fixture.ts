import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import {
  resolveTtdsConfig,
  toClientSafeConfigView,
  type VoiceFeedItem,
  type VoiceHookTriggerPayload,
  type VoicePendingUiConfirmationView,
  type VoicePlaybackCursors,
  type VoiceRuntimeServiceContract,
  type VoiceToolDefinition,
  type VoiceToolResult,
} from '../../src/shared/index.ts'
import { VoiceToolRegistry } from '../../src/tools/index.ts'

/** Creates a real Cordis context with observable runtime and hook boundaries.
 * @returns Registry fixture with mutable configuration and playback cursors.
 */
export function fixture() {
  const ctx = new Context()
  const state = {
    config: resolveTtdsConfig({}, {}),
    cursors: {
      connectionEpoch: 1, inputAdmissionSeq: 1, emittedAudioSeq: 10, drainedAudioSeq: 10, hasAudioClient: false,
    } as VoicePlaybackCursors,
    pending: [] as readonly VoicePendingUiConfirmationView[],
    results: [] as { callId: string; name: string; result: VoiceToolResult }[],
    hooks: [] as VoiceHookTriggerPayload[],
    released: 0,
    leases: 0,
    journal: [] as { kind: string; payload: Readonly<Record<string, unknown>> }[],
  }
  const sessionAbort = new AbortController()
  const refreshTools = vi.fn(() => Promise.resolve())
  const runtime: VoiceRuntimeServiceContract = {
    getConfig: () => state.config,
    getPlaybackCursors: () => state.cursors,
    getSnapshot: () => ({
      supervisorSessionId: 'voice', connectionEpoch: state.cursors.connectionEpoch, phase: 'idle',
      providerReady: true, statusReason: null, muted: false, inputAdmissionSeq: state.cursors.inputAdmissionSeq,
      pendingToolCount: 0, pendingConfirmations: state.pending, config: toClientSafeConfigView(state.config),
    }),
    acquireLease: () => {
      state.leases++
      return { signal: sessionAbort.signal, release: () => { state.released++ } }
    },
    registerAdapter: () => () => {},
    subscribeFrames: () => () => {},
    onStateChange: () => () => {},
    startSession: () => Promise.resolve(runtime.getSnapshot()),
    stopSession: () => Promise.resolve(runtime.getSnapshot()),
    handleClientFrame: () => Promise.resolve(),
    sendTextUtterance: () => Promise.resolve({ accepted: true, inputAdmissionSeq: state.cursors.inputAdmissionSeq }),
    submitToolResult: (callId, name, result) => {
      state.results.push({ callId, name, result: result as VoiceToolResult })
      return Promise.resolve(true)
    },
    injectHookNotification: () => Promise.resolve(true),
    requestSpokenTurn: () => Promise.resolve(true),
    publishFeedItem: item => ({ ...item, id: 'feed', timestampMs: Date.now() }) satisfies VoiceFeedItem,
    setPendingConfirmations: (pending) => { state.pending = pending },
    appendJournal: (kind, payload) => { state.journal.push({ kind, payload }); return Promise.resolve() },
    readJournal: () => Promise.resolve([]),
    refreshTools,
    updateConfig: () => Promise.resolve(),
  }
  ctx.provide('ttdsRuntime', runtime)
  const selfActionReleases: (() => void)[] = []
  const beginSelfAction = vi.fn((_sessionId: string, _actionKind: string) => {
    const release = vi.fn<() => void>()
    selfActionReleases.push(release)
    return { release }
  })
  ctx.provide('ttdsHooks', {
    register: () => () => {},
    beginSelfAction,
    enqueue: (event: VoiceHookTriggerPayload) => { state.hooks.push(event) },
    markToolOutputsNaturallyConsumed: () => {},
    getBufferedEvents: () => state.hooks,
    clear: () => { state.hooks = [] },
  })
  const registry = new VoiceToolRegistry(ctx)
  let calls = 0
  const dispatch = (args: Readonly<Record<string, unknown>> = {}, name = 'dsh_test'): string => {
    const callId = `call-${++calls}`
    registry.dispatchToolCalls([{ callId, itemId: callId, name, argumentsJson: JSON.stringify(args) }])
    return callId
  }
  return { ctx, state, runtime, registry, dispatch, sessionAbort, beginSelfAction, selfActionReleases, refreshTools }
}

/** Creates a mutating test tool with observable execution.
 * @param overrides - Definition fields changed for the scenario.
 * @returns Complete test tool definition.
 */
export function tool(overrides: Partial<VoiceToolDefinition> = {}) {
  const definition: VoiceToolDefinition = {
    name: 'dsh_test', description: '测试操作', category: 'write',
    parameters: { type: 'object', properties: { target: { type: 'string', description: '目标' } }, additionalProperties: false },
    resolveConfirmation: config => config.tools.writeConfirmation,
    summarizeCall: args => `操作 ${String(args.target)}`,
    execute: vi.fn(() => Promise.resolve({ ok: true, data: { done: true } })),
    ...overrides,
  }
  return { ...definition, execute: vi.fn(definition.execute.bind(definition)) }
}
