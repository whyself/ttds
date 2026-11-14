import { afterEach, describe, expect, it } from 'vitest'
import { bootBundle, type BootedBundle } from '../../../scripts/test-support/boot-bundle.ts'
import { resolveTtdsConfig, unwrapTtdsConfig } from '../src/index.ts'

let booted: BootedBundle | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

describe('@whyself/ttds real Loader composition', () => {
  it('loads from cordis.patch.yml, registers runtime/tools/hooks, and disposes cleanly', async () => {
    booted = await bootBundle('packages/ttds')

    const entry = [...booted.ctx.loader.entries()].find(candidate => candidate.options.id === 'ttds')
    expect(entry?.options.name).toBe('@whyself/ttds')

    const runtime = booted.ctx.get('ttdsRuntime')
    const tools = booted.ctx.get('ttdsTools')
    const hooks = booted.ctx.get('ttdsHooks')
    expect(runtime).toBeDefined()
    expect(tools).toBeDefined()
    expect(hooks).toBeDefined()
    expect(tools?.listToolNames()).toEqual([
      'dsh_list_sessions',
      'dsh_get_session_progress',
      'dsh_inspect_workspace_changes',
      'dsh_read_session_messages',
      'dsh_list_pending_approvals',
      'dsh_search',
      'dsh_create_session',
      'dsh_send_session_prompt',
      'dsh_cancel_session_turn',
      'dsh_switch_session_model',
      'dsh_resolve_tool_approval',
    ])
    expect(runtime?.getSnapshot().config.qwenRealtime.enableSearch).toBe(false)

    const rootCtx = booted.ctx
    await booted.dispose()
    booted = undefined

    expect(rootCtx.get('ttdsRuntime')).toBeUndefined()
    expect(rootCtx.get('ttdsTools')).toBeUndefined()
    expect(rootCtx.get('ttdsHooks')).toBeUndefined()
  }, 30_000)

  it('unwraps Cordis .volatile() wrappers when resolving live plugin config', () => {
    const wrapped = {
      provider: { get: () => 'qwen-realtime' },
      providers: { get: () => ({ 'qwen-realtime': { apiKey: 'sk-volatile', model: 'qwen-audio-3.1-realtime-plus' as const } }) },
      voice: { get: () => ({ turnDetection: 'server_vad' as const, startMuted: true }) },
      tools: { get: () => ({ enableSearchTool: false }) },
      hooks: { get: () => ({ quietGraceMs: 2500 }) },
      storageDir: 'D:/tmp/ttds-volatile',
    }
    expect(unwrapTtdsConfig(wrapped)).toEqual({
      provider: 'qwen-realtime',
      providers: { 'qwen-realtime': { apiKey: 'sk-volatile', model: 'qwen-audio-3.1-realtime-plus' } },
      voice: { turnDetection: 'server_vad', startMuted: true },
      tools: { enableSearchTool: false },
      hooks: { quietGraceMs: 2500 },
      storageDir: 'D:/tmp/ttds-volatile',
    })
    const resolved = resolveTtdsConfig(wrapped, {})
    expect(resolved.providers['qwen-realtime'].hasApiKey).toBe(true)
    expect(resolved.providers['qwen-realtime'].model).toBe('qwen-audio-3.1-realtime-plus')
    expect(resolved.voice.startMuted).toBe(true)
    expect(resolved.tools.enableSearchTool).toBe(false)
    expect(resolved.hooks.quietGraceMs).toBe(2500)
  })
})
