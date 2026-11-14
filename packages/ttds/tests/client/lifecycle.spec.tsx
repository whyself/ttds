// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index.ts'
import { encodePcm16 } from '../../src/client/audio-engine.ts'
import { resolveTtdsConfig, toClientSafeConfigView } from '../../src/shared/config.ts'
import { clientFixture, snapshot } from './fixture.ts'

describe('client plugin lifetime', () => {
  it('withdraws all five real slot registrations and closes socket, tracks and contexts on disposal', async () => {
    const fixture = clientFixture()
    const fiber = fixture.ctx.plugin((scope) => {
      const controller = apply(scope, fixture.options)
      controller.start()
    })
    await fiber
    fixture.socket.open()
    expect(fixture.ctx.slots.entriesOfSlot('main')).toHaveLength(1)
    expect(fixture.ctx.slots.entriesOfSlot('sidebar.panellist')).toHaveLength(1)
    expect(fixture.ctx.slots.entriesOfSlot('shell.overlay')).toHaveLength(1)
    expect(fixture.ctx.slots.entriesOfSlot('plugins.bundle.config')).toHaveLength(1)
    expect(fixture.ctx.slots.entriesOfSlot('plugins.detail.badge')).toHaveLength(1)
    expect(fixture.socket.sent).toContainEqual({ type: 'session.start', inputDeviceId: '' })
    await fiber.dispose()
    expect(fixture.socket.closed).toBe(true)
    expect(fixture.audio.track.readyState).toBe('ended')
    expect(fixture.audio.contexts.every(context => context.state === 'closed')).toBe(true)
    expect(fixture.ctx.slots.entriesOfSlot('main')).toHaveLength(0)
    expect(fixture.ctx.slots.entriesOfSlot('sidebar.panellist')).toHaveLength(0)
    expect(fixture.ctx.slots.entriesOfSlot('shell.overlay')).toHaveLength(0)
    expect(fixture.ctx.slots.entriesOfSlot('plugins.bundle.config')).toHaveLength(0)
    expect(fixture.ctx.slots.entriesOfSlot('plugins.detail.badge')).toHaveLength(0)
    await fixture.ctx.fiber.dispose()
  })

  it('joins a late permission grant during actual plugin disposal', async () => {
    const fixture = clientFixture()
    fixture.audio.deferPermission()
    const fiber = fixture.ctx.plugin((scope) => { apply(scope, fixture.options).start() })
    await fiber
    const disposal = fiber.dispose()
    await Promise.resolve()
    fixture.audio.grant()
    await disposal
    expect(fixture.audio.track.readyState).toBe('ended')
    expect(fixture.audio.urls).toHaveLength(0)
    expect(fixture.socket.closed).toBe(true)
    await fixture.ctx.fiber.dispose()
  })

  it('auto-starts on disconnected text utterance and routes speaker sinkId changes', async () => {
    const fixture = clientFixture()
    expect(fixture.controller.sendText('先查一下会话列表')).toBe(true)
    expect(fixture.controller.state.getSnapshot().connection).toBe('connecting')
    fixture.socket.open()
    expect(fixture.socket.sent).toEqual([
      { type: 'session.start', inputDeviceId: '' },
      { type: 'audio.mute', muted: false },
      { type: 'input.text', text: '先查一下会话列表' },
    ])
    const updatedConfig = toClientSafeConfigView(resolveTtdsConfig({ voice: { outputDeviceId: 'speaker-usb' } }, {}))
    fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot({ config: updatedConfig }) })
    await Promise.resolve()
    expect(fixture.audio.contexts[0]?.sinkId).toBe('speaker-usb')
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('mirrors incremental transcripts and acknowledges each finished chunk with the server cursor', async () => {
    const fixture = clientFixture()
    fixture.controller.start()
    fixture.socket.open()
    fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot() })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '你', itemId: 'one', final: false })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '你好', itemId: 'one', final: true })
    fixture.socket.receive({ type: 'audio.delta', audioSeq: 7, responseId: 'r1', pcm24kBase64: encodePcm16([0, 1]) })
    fixture.audio.contexts[0]?.sources[0]?.end()
    expect(fixture.controller.state.getSnapshot().feed.map(item => item.text)).toEqual(['你好'])
    expect(fixture.socket.sent).toContainEqual({ type: 'playback.drained', playbackSeq: 7, responseId: 'r1' })
    fixture.socket.receive({ type: 'audio.delta', audioSeq: 8, responseId: 'r1', pcm24kBase64: encodePcm16([0, 1]) })
    fixture.socket.receive({ type: 'audio.clear', reason: 'barge_in' })
    fixture.audio.contexts[0]?.sources[1]?.end()
    expect(fixture.socket.sent.some(frame => frame.playbackSeq === 8)).toBe(false)
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('keeps user transcripts ordered ahead of assistant replies even when final ASR lands after assistant output', async () => {
    const fixture = clientFixture()
    fixture.controller.start()
    fixture.socket.open()
    fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot() })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '', itemId: 'speech_1', final: false })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '正在帮你查', itemId: 'resp_1', final: false })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '帮我查会话', itemId: 'speech_1', final: true })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '正在帮你查，请稍等', itemId: 'resp_1', final: true })
    expect(fixture.controller.state.getSnapshot().feed.map(item => [item.kind, item.text])).toEqual([
      ['transcript_user', '帮我查会话'],
      ['transcript_assistant', '正在帮你查，请稍等'],
    ])
    // Multi-segment committed user item arriving before final transcription stays ordered ahead of the assistant reply.
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '', itemId: 'speech_2a', final: false })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '', itemId: 'speech_2b', final: false })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '第二轮回答', itemId: 'resp_2', final: true })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '第二段问题', itemId: 'speech_2b', final: true })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '第一段话', itemId: 'speech_2a', final: true })
    expect(fixture.controller.state.getSnapshot().feed.map(item => [item.kind, item.text])).toEqual([
      ['transcript_user', '帮我查会话'],
      ['transcript_assistant', '正在帮你查，请稍等'],
      ['transcript_user', '第一段话'],
      ['transcript_user', '第二段问题'],
      ['transcript_assistant', '第二轮回答'],
    ])
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('activates output from a muted start without requesting capture and releases it after network failure', async () => {
    const fixture = clientFixture()
    fixture.controller.toggleMute()
    fixture.controller.start()
    fixture.socket.open()
    fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot({ muted: false }) })
    expect(fixture.controller.state.getSnapshot().muted).toBe(true)
    expect(fixture.socket.sent).toContainEqual({ type: 'audio.mute', muted: true })
    expect(fixture.audio.contexts).toHaveLength(1)
    expect(fixture.audio.urls).toHaveLength(0)
    fixture.socket.receive({ type: 'error', code: 'not_ready', message: '需要配置语音服务' })
    expect(fixture.socket.closed).toBe(true)
    expect(fixture.audio.contexts[0]?.state).toBe('closed')
    expect(fixture.controller.state.getSnapshot().connection).toBe('error')
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('rejects malformed network frames and closes media before they can reach the UI', async () => {
    const fixture = clientFixture()
    fixture.controller.start()
    fixture.socket.open()
    fixture.socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'state.snapshot', snapshot: { phase: 'speaking', pendingConfirmations: null },
    }) }))
    expect(fixture.controller.state.getSnapshot().connection).toBe('error')
    expect(fixture.controller.state.getSnapshot().snapshot).toBeNull()
    expect(fixture.audio.contexts[0]?.state).toBe('closed')
    expect(fixture.socket.closed).toBe(true)
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('preserves chronological feed order across stop and restart cycles', async () => {
    const fixture = clientFixture()
    fixture.controller.start()
    fixture.socket.open()
    fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot() })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '第一轮提问', itemId: 'old_u', final: true })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '第一轮回答', itemId: 'old_a', final: true })
    await fixture.controller.stop()

    fixture.controller.start()
    fixture.socket.open()
    fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot() })
    fixture.socket.receive({ type: 'transcript', role: 'user', text: '重连后追问', itemId: 'new_u', final: true })
    fixture.socket.receive({ type: 'transcript', role: 'assistant', text: '重连后回答', itemId: 'new_a', final: true })
    expect(fixture.controller.state.getSnapshot().feed.map(item => item.text)).toEqual([
      '第一轮提问',
      '第一轮回答',
      '重连后追问',
      '重连后回答',
    ])
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })
})
