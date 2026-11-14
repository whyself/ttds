// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { encodePcm16 } from '../../src/client/audio-engine.ts'
import { audioFixture } from './fixture.ts'

describe('browser audio resources', () => {
  it.each(['stop', 'dispose'] as const)('stops a late microphone grant after %s', async (operation) => {
    const fixture = audioFixture()
    fixture.deferPermission()
    const capture = fixture.engine.startCapture(() => {}, '')
    const cleanup = operation === 'dispose' ? fixture.engine.dispose() : fixture.engine.close()
    expect(fixture.contexts[0]?.state).toBe('closed')
    fixture.grant()
    await capture
    await cleanup
    expect(fixture.track.readyState).toBe('ended')
    expect(fixture.urls).toHaveLength(0)
  })

  it('releases capture on mute while preserving gapless playback and only acknowledges audible chunks', async () => {
    const fixture = audioFixture()
    const chunks: string[] = []
    await fixture.engine.startCapture((audio) => { chunks.push(audio) }, '')
    const context = fixture.contexts[0]
    if (context === undefined) throw new Error('audio context was not created')
    context.port.onmessage?.(new MessageEvent('message', { data: new Float32Array([1, 1, 1, -1, -1, -1]) }))
    expect(chunks).toEqual([encodePcm16([1, -1])])
    const drained: number[] = []
    const audio = encodePcm16([0.25, -0.5, 1])
    fixture.engine.play(audio, () => { drained.push(1) })
    fixture.engine.play(audio, () => { drained.push(2) })
    const [first, second] = context.sources
    expect(first?.when).toBe(4)
    expect(second?.when).toBeCloseTo(4 + 3 / 24000)
    fixture.engine.stopCapture()
    expect(fixture.track.readyState).toBe('ended')
    expect(context.state).toBe('running')
    expect(context.port.closed).toBe(true)
    first?.end()
    expect(drained).toEqual([1])
    fixture.engine.play('', () => { drained.push(99) })
    await Promise.resolve()
    expect(drained).toEqual([1, 99])
    fixture.engine.clear()
    second?.end()
    expect(second?.stopped).toBe(true)
    expect(drained).toEqual([1, 99])
    expect(fixture.revoked).toEqual(fixture.urls)
    await fixture.engine.dispose()
    expect(context.state).toBe('closed')
  })

  it('retains resampler phase across worklet blocks and rejects truncated PCM', async () => {
    const fixture = audioFixture()
    const chunks: string[] = []
    await fixture.engine.startCapture((audio) => { chunks.push(audio) }, '')
    const context = fixture.contexts[0]
    if (context === undefined) throw new Error('audio context was not created')
    const port = context.port
    port.onmessage?.(new MessageEvent('message', { data: new Float32Array([1, 1]) }))
    expect(chunks).toEqual([])
    port.onmessage?.(new MessageEvent('message', { data: new Float32Array([1, -1, -1, -1]) }))
    expect(chunks).toEqual([encodePcm16([1, -1])])
    expect(() => { fixture.engine.play(btoa('a'), () => {}) }).toThrow('complete samples')
    await fixture.engine.dispose()
  })

  it('joins delayed worklet loading and revokes its module URL after disposal', async () => {
    const fixture = audioFixture()
    let finish: () => void = () => {}
    fixture.setModuleLoad(() => new Promise<void>((resolve) => { finish = resolve }))
    const capture = fixture.engine.startCapture(() => {}, '')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.urls).toHaveLength(1)
    const disposal = fixture.engine.dispose()
    expect(fixture.track.readyState).toBe('ended')
    expect(fixture.contexts[0]?.state).toBe('closed')
    finish()
    await capture
    await disposal
    expect(fixture.revoked).toEqual(fixture.urls)
    expect(fixture.contexts[0]?.port.onmessage).toBeNull()
  })

  it.each(['resume', 'module'] as const)('releases granted tracks and contexts when %s fails', async (failure) => {
    const fixture = audioFixture()
    const reject = (): Promise<void> => Promise.reject(new Error('hardware failure'))
    if (failure === 'resume') fixture.setResume(reject)
    else fixture.setModuleLoad(reject)
    await expect(fixture.engine.startCapture(() => {}, '')).rejects.toThrow('hardware failure')
    expect(fixture.track.readyState).toBe('ended')
    expect(fixture.contexts[0]?.state).toBe('closed')
    expect(fixture.revoked).toEqual(fixture.urls)
    await fixture.engine.dispose()
  })
})
