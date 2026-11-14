/** Resources used by the browser media engine, replaceable by deterministic browser tests. */
export interface AudioEngineOptions {
  createContext: () => AudioContext
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createWorkletNode: (context: AudioContext) => AudioWorkletNode
  createModuleUrl: () => string
  revokeModuleUrl: (url: string) => void
}

/** Capture and playback operations owned by one client controller. */
export interface VoiceAudioAdapter {
  activatePlayback: (outputDeviceId?: string) => Promise<void>
  setOutputDevice?: (outputDeviceId: string) => Promise<void>
  startCapture: (onAudio: (audio: string) => void, deviceId: string) => Promise<void>
  stopCapture: () => void
  play: (audio: string, drained: () => void) => void
  clear: () => void
  close: () => Promise<void>
  dispose: () => Promise<void>
}

type SinkableAudioContext = AudioContext & {
  setSinkId: (sinkId: string) => Promise<void>
}

function isSinkable(context: AudioContext): context is SinkableAudioContext {
  return 'setSinkId' in context && typeof context.setSinkId === 'function'
}

/**
 * Resolve browser hardware factories without allocating media resources.
 * @returns factories whose resources belong to their calling audio engine.
 */
export function resolveAudioEngineOptions(): AudioEngineOptions {
  return {
    createContext: () => new AudioContext(),
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    createWorkletNode: context => new AudioWorkletNode(context, 'ttds-capture'),
    createModuleUrl: () => URL.createObjectURL(new Blob([`
      class TtdsCapture extends AudioWorkletProcessor {
        process(inputs) {
          const channels = inputs[0];
          if (channels && channels.length) {
            const mono = new Float32Array(channels[0].length);
            for (const channel of channels) {
              for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
            }
            this.port.postMessage(mono, [mono.buffer]);
          }
          return true;
        }
      }
      registerProcessor('ttds-capture', TtdsCapture);
    `], { type: 'text/javascript' })),
    revokeModuleUrl: (url) => { URL.revokeObjectURL(url) },
  }
}

/**
 * Encode normalized samples as little-endian PCM16 base64.
 * @param samples - mono samples in the range minus one through one.
 * @returns base64 bytes accepted by audio.append.
 */
export function encodePcm16(samples: readonly number[]): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => {
    const bounded = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, Math.round(bounded * (bounded < 0 ? 32768 : 32767)), true)
  })
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Owns all tracks, worklets, queued sources and audio contexts for one plugin instance. */
export class TtdsAudioEngine implements VoiceAudioAdapter {
  private context: AudioContext | undefined
  private stream: MediaStream | undefined
  private input: MediaStreamAudioSourceNode | undefined
  private worklet: AudioWorkletNode | undefined
  private mediaGeneration = 0
  private disposed = false
  private nextPlaybackTime = 0
  private outputDeviceId = ''
  private appliedSinkId = ''
  private readonly sources = new Set<AudioBufferSourceNode>()
  private readonly pending = new Set<Promise<void>>()
  private readonly closing = new Set<Promise<void>>()
  private samples: number[] = []
  private samplePosition = 0

  /**
   * @param options - browser hardware factories resolved before constructing this engine.
   */
  constructor(private readonly options: AudioEngineOptions = resolveAudioEngineOptions()) {}

  /**
   * Resume playback from the user gesture and bind the selected output speaker when supported.
   * @param outputDeviceId - optional browser audiooutput deviceId (`""` selects system default).
   * @returns settlement of the browser autoplay permission and sink routing.
   */
  async activatePlayback(outputDeviceId = this.outputDeviceId): Promise<void> {
    if (this.disposed) return
    this.outputDeviceId = outputDeviceId
    const context = this.ensureContext()
    await context.resume()
    await this.syncSink(context)
  }

  /**
   * Bind an active playback AudioContext to a new output speaker device when supported.
   * @param outputDeviceId - target audiooutput deviceId (`""` selects system default).
   * @returns settlement of sink switching.
   */
  async setOutputDevice(outputDeviceId: string): Promise<void> {
    this.outputDeviceId = outputDeviceId
    if (this.disposed || this.context === undefined || this.context.state === 'closed') return
    await this.syncSink(this.context)
  }

  /**
   * Request a microphone; late grants are stopped before they can enter the capture graph.
   * @param onAudio - receives streaming 16kHz mono PCM16 base64 chunks.
   * @param deviceId - exact input device, or empty for the system default.
   * @returns settlement of permission and worklet loading; rejects on hardware failure.
   */
  startCapture(onAudio: (audio: string) => void, deviceId: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.stopCapture()
    const generation = this.mediaGeneration
    const task = this.capture(generation, onAudio, deviceId).catch(async (error: unknown) => {
      if (generation === this.mediaGeneration) await this.close()
      throw mediaError(error)
    })
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }

  /** Invalidate pending grants and release capture while leaving playback available. */
  stopCapture(): void {
    this.mediaGeneration++
    this.worklet?.disconnect()
    if (this.worklet !== undefined) {
      this.worklet.port.onmessage = null
      this.worklet.port.close()
    }
    this.worklet = undefined
    this.input?.disconnect()
    this.input = undefined
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    this.samples = []
    this.samplePosition = 0
  }

  /**
   * Schedule a 24kHz chunk directly after the preceding chunk.
   * @param audio - little-endian PCM16 base64 from audio.delta.
   * @param drained - called only after this chunk actually ends, never when cleared.
   * @returns nothing.
   */
  play(audio: string, drained: () => void): void {
    if (this.disposed) return
    const binary = atob(audio)
    if (binary.length % 2 !== 0) throw new Error('ttds: PCM16 audio must contain complete samples')
    if (binary.length === 0) {
      queueMicrotask(drained)
      return
    }
    const context = this.ensureContext()
    const buffer = context.createBuffer(1, binary.length / 2, 24000)
    const channel = buffer.getChannelData(0)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      if (!this.sources.delete(source)) return
      source.disconnect()
      drained()
    }
    this.sources.add(source)
    const when = Math.max(context.currentTime, this.nextPlaybackTime)
    this.nextPlaybackTime = when + buffer.duration
    source.start(when)
  }

  /** Stop queued sources without acknowledging interrupted audio as played. */
  clear(): void {
    for (const source of this.sources) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    this.nextPlaybackTime = 0
  }

  /**
   * Release current hardware; this engine may be started again afterwards.
   * @returns settlement after every currently closing AudioContext has closed.
   */
  async close(): Promise<void> {
    this.stopCapture()
    this.clear()
    this.appliedSinkId = ''
    const context = this.context
    this.context = undefined
    if (context !== undefined && context.state !== 'closed') {
      const closing = context.close()
      this.closing.add(closing)
      void closing.then(() => { this.closing.delete(closing) }, () => { this.closing.delete(closing) })
    }
    await Promise.all([...this.closing])
  }

  /**
   * Permanently reject new capture and join late permissions and context closure.
   * @returns settlement after every admitted capture has released its resources.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const [closed] = await Promise.allSettled([this.close(), Promise.allSettled([...this.pending])] as const)
    if (closed.status === 'rejected') throw mediaError(closed.reason)
  }

  private ensureContext(): AudioContext {
    this.context ??= this.options.createContext()
    return this.context
  }

  private async syncSink(context: AudioContext): Promise<void> {
    if (!isSinkable(context) || this.appliedSinkId === this.outputDeviceId) return
    try {
      await context.setSinkId(this.outputDeviceId)
    } catch (_error) {
      // Unplugged or unavailable output devices fall back to the system default speaker.
      if (this.outputDeviceId === '') return
      this.outputDeviceId = ''
      try {
        await context.setSinkId('')
      } catch (_fallbackError) {
        // Keep default destination active when the runtime rejects sink switching.
        return
      }
    }
    this.appliedSinkId = this.outputDeviceId
  }

  private async capture(generation: number, onAudio: (audio: string) => void, deviceId: string): Promise<void> {
    const context = this.ensureContext()
    const resumed = context.resume().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const media = this.options.getUserMedia({
      audio: { channelCount: 1, ...(deviceId === '' ? {} : { deviceId: { exact: deviceId } }) },
    })
    // Permission cannot be cancelled by the browser; each result owns its immediate stale-track release.
    const stream = await media
    if (generation !== this.mediaGeneration || this.disposed) {
      for (const track of stream.getTracks()) track.stop()
      await resumed
      return
    }
    this.stream = stream
    const resumedResult = await resumed
    if (!resumedResult.ok) throw mediaError(resumedResult.error)
    if (generation !== this.mediaGeneration) return
    await this.syncSink(context)
    if (generation !== this.mediaGeneration) return
    const url = this.options.createModuleUrl()
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      this.options.revokeModuleUrl(url)
    }
    if (generation !== this.mediaGeneration) return
    this.input = context.createMediaStreamSource(stream)
    this.worklet = this.options.createWorkletNode(context)
    this.worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (generation !== this.mediaGeneration || !(event.data instanceof Float32Array)) return
      this.samples.push(...event.data)
      const output: number[] = []
      const ratio = context.sampleRate / 16000
      while (this.samplePosition + ratio <= this.samples.length) {
        const end = this.samplePosition + ratio
        let weighted = 0
        for (let i = Math.floor(this.samplePosition); i < end; i++) {
          weighted += (this.samples[i] ?? 0) * (Math.min(i + 1, end) - Math.max(i, this.samplePosition))
        }
        output.push(weighted / ratio)
        this.samplePosition = end
      }
      const consumed = Math.floor(this.samplePosition)
      this.samples.splice(0, consumed)
      this.samplePosition -= consumed
      if (output.length > 0) onAudio(encodePcm16(output))
    }
    this.input.connect(this.worklet)
    this.worklet.connect(context.destination)
  }
}

function mediaError(error: unknown): Error {
  return error instanceof Error ? error : new Error('ttds: browser audio operation failed', { cause: error })
}
