import type { Context } from '@deepseek-ai/cordis'
import type {
  SelfActionHandle,
  VoiceHookDefinition,
  VoiceHookPriority,
  VoiceHookRegistryContract,
  VoiceHookTriggerPayload,
  VoiceSessionSnapshot,
} from '../shared/index.ts'
import { assertNever } from '../shared/index.ts'

interface SelfAction {
  count: number
  timer: ReturnType<typeof setTimeout> | undefined
}

function priorityRank(priority: VoiceHookPriority): number {
  switch (priority) {
    case 'critical': return 4
    case 'high': return 3
    case 'normal': return 2
    case 'low': return 1
    default: return assertNever(priority)
  }
}

function isQuiet(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.supervisorSessionId !== null && (snapshot.phase === 'listening' || snapshot.phase === 'idle')
}

const TOOL_WAKEUP_DEBOUNCE_MS = 120
const HOOK_COALESCE_DEBOUNCE_MS = 350

/** Fiber-owned hook registry with bounded buffering and uninterrupted quiet-turn delivery. */
export class EventHookEngine implements VoiceHookRegistryContract {
  private readonly definitions = new Map<string, VoiceHookDefinition>()
  private readonly selfActions = new Map<string, SelfAction>()
  private buffer: VoiceHookTriggerPayload[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerIsShort = false
  private pending: Promise<void> | undefined
  private snapshot: VoiceSessionSnapshot
  private quietGraceMs: number
  private quietSinceMs: number | null
  private disposed = false

  /**
   * Publish `ttdsHooks` and retain the runtime until in-flight delivery drains on disposal.
   * @param ctx - owning context with an available `ttdsRuntime` service.
   */
  constructor(private readonly ctx: Context) {
    const runtime = ctx.ttdsRuntime
    const lease = runtime.acquireLease()
    if (lease === null) throw new Error('ttdsHooks: ttdsRuntime is disposing')
    this.snapshot = runtime.getSnapshot()
    this.quietGraceMs = runtime.getConfig().hooks.quietGraceMs
    this.quietSinceMs = isQuiet(this.snapshot) ? Date.now() : null
    const unsubscribe = runtime.onStateChange((snapshot) => { this.onStateChange(snapshot) })
    const stop = (): void => {
      this.disposed = true
      this.clear()
      this.definitions.clear()
      unsubscribe()
    }
    let leaseReleased = false
    const releaseLease = (): void => {
      if (leaseReleased) return
      leaseReleased = true
      lease.release()
    }
    const onAbort = (): void => {
      stop()
      if (this.pending === undefined) releaseLease()
      else void this.pending.then(releaseLease, releaseLease)
    }
    lease.signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = async (): Promise<void> => {
      stop()
      lease.signal.removeEventListener('abort', onAbort)
      await this.pending
      releaseLease()
    }
    const provision = (): (() => void) => ctx.provide('ttdsHooks', this)
    ctx.effect(function* () {
      yield cleanup
      yield provision()
      yield stop
    })
  }

  /**
   * Register one unique definition.
   * @param hook - definition whose enablement is evaluated against the latest runtime config.
   * @returns idempotent disposer that removes the definition and its buffered events.
   */
  register(hook: VoiceHookDefinition): () => void {
    if (this.disposed) throw new Error('ttdsHooks: registry is disposed')
    if (this.definitions.has(hook.id)) throw new Error(`ttdsHooks: duplicate hook "${hook.id}"`)
    this.definitions.set(hook.id, hook)
    let registered = true
    return (): void => {
      if (!registered) return
      registered = false
      this.definitions.delete(hook.id)
      this.buffer = this.buffer.filter(event => event.hookId !== hook.id)
      if (this.buffer.length === 0) this.cancelTimer()
    }
  }

  /**
   * Suppress session echoes through all overlapping actions and 250 ms after the last release.
   * @param sessionId - DSH session mutated by the caller.
   * @param _actionKind - mutation kind retained by the caller for its own diagnostics.
   * @returns idempotent release handle; disposal invalidates every outstanding handle.
   */
  beginSelfAction(sessionId: string, _actionKind: string): SelfActionHandle {
    if (this.disposed) return { release() {} }
    let action = this.selfActions.get(sessionId)
    if (action === undefined) {
      action = { count: 0, timer: undefined }
      this.selfActions.set(sessionId, action)
    }
    if (action.timer !== undefined) clearTimeout(action.timer)
    action.timer = undefined
    action.count++
    const current = action
    let released = false
    return {
      release: () => {
        if (released || this.disposed || this.selfActions.get(sessionId) !== current) return
        released = true
        current.count--
        if (current.count > 0) return
        current.timer = setTimeout(() => {
          this.selfActions.delete(sessionId)
        }, 250)
      },
    }
  }

  /**
   * Accept an enabled event, replacing an equal dedupe key and retaining at most 20 priority-ranked entries.
   * @param event - normalized lifecycle notification or acknowledged tool-output wakeup.
   */
  enqueue(event: VoiceHookTriggerPayload): void {
    if (this.disposed || !this.isEnabled(event)) return
    if (event.sessionId !== undefined && this.selfActions.has(event.sessionId)) return
    const index = event.dedupeKey === undefined
      ? -1
      : this.buffer.findIndex(item => item.dedupeKey === event.dedupeKey)
    if (index < 0) this.buffer.push(event)
    else this.buffer[index] = event
    this.trimBuffer()
    if (this.timerIsShort && this.buffer.some(item => item.hookId !== 'ttds_tool_output_ready')) {
      this.cancelTimer()
    }
    this.schedule()
  }

  /**
   * Remove redundant tool-output wakeups without changing lifecycle notifications.
   * @param callIds - consumed call identifiers; omission removes all pending tool-output wakeups.
   */
  markToolOutputsNaturallyConsumed(callIds?: readonly string[]): void {
    this.buffer = this.buffer.filter((event) => {
      if (event.hookId !== 'ttds_tool_output_ready') return true
      if (callIds === undefined) return false
      const callId = event.metadata?.callId
      return !(typeof callId === 'string' && callIds.includes(callId))
    })
    if (this.buffer.length === 0) this.cancelTimer()
  }

  /**
   * Inspect pending notifications without exposing the mutable queue.
   * @returns a fresh array in buffered order.
   */
  getBufferedEvents(): readonly VoiceHookTriggerPayload[] {
    return [...this.buffer]
  }

  /** Clear pending events, the grace timer, and self-action suppression timers. */
  clear(): void {
    this.buffer = []
    this.cancelTimer()
    for (const action of this.selfActions.values()) {
      if (action.timer !== undefined) clearTimeout(action.timer)
    }
    this.selfActions.clear()
  }

  private isEnabled(event: VoiceHookTriggerPayload): boolean {
    const definition = this.definitions.get(event.hookId)
    return definition !== undefined
      && (event.hookId === 'ttds_tool_output_ready' || definition.isEnabled(this.ctx.ttdsRuntime.getConfig()))
  }

  private trimBuffer(): void {
    while (this.buffer.length > 20) {
      let lowest = 0
      for (const [index, event] of this.buffer.entries()) {
        const candidate = this.buffer[lowest]
        if (candidate !== undefined && priorityRank(event.priority) < priorityRank(candidate.priority)) lowest = index
      }
      this.buffer.splice(lowest, 1)
    }
  }

  private onStateChange(snapshot: VoiceSessionSnapshot): void {
    if (this.disposed) return
    const grace = this.ctx.ttdsRuntime.getConfig().hooks.quietGraceMs
    const previous = this.snapshot
    const changed = snapshot.phase !== previous.phase
      || snapshot.supervisorSessionId !== previous.supervisorSessionId
      || snapshot.connectionEpoch !== previous.connectionEpoch
      || snapshot.inputAdmissionSeq !== previous.inputAdmissionSeq
      || grace !== this.quietGraceMs
    this.snapshot = snapshot
    this.quietGraceMs = grace
    if (!isQuiet(snapshot)) {
      this.quietSinceMs = null
    } else if (changed || this.quietSinceMs === null) {
      this.quietSinceMs = Date.now()
    }
    this.buffer = this.buffer.filter(event => this.isEnabled(event))
    if (changed || !isQuiet(snapshot) || this.buffer.length === 0) this.cancelTimer()
    this.schedule()
  }

  private cancelTimer(): void {
    this.timerIsShort = false
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.disposed || this.pending !== undefined || this.timer !== undefined || this.buffer.length === 0) return
    if (!isQuiet(this.snapshot)) return
    const quietGraceMs = this.ctx.ttdsRuntime.getConfig().hooks.quietGraceMs
    const onlyToolWakeups = this.buffer.every(item => item.hookId === 'ttds_tool_output_ready')
    let delayMs: number
    if (onlyToolWakeups) {
      delayMs = Math.min(quietGraceMs, TOOL_WAKEUP_DEBOUNCE_MS)
    } else {
      const elapsedQuietMs = this.quietSinceMs === null ? 0 : Math.max(0, Date.now() - this.quietSinceMs)
      const remainingGraceMs = Math.max(0, quietGraceMs - elapsedQuietMs)
      delayMs = Math.max(remainingGraceMs, Math.min(quietGraceMs, HOOK_COALESCE_DEBOUNCE_MS))
    }
    this.timerIsShort = onlyToolWakeups && delayMs < quietGraceMs
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerIsShort = false
      this.pending = Promise.resolve().then(() => this.flush()).catch((error: unknown) => {
        if (this.disposed) return
        this.ctx.ttdsRuntime.publishFeedItem({
          kind: 'diagnostic',
          text: `后台进展播报失败，将在静默后重试：${String(error)}`,
        })
      }).finally(() => {
        this.pending = undefined
        this.schedule()
      })
    }, delayMs)
  }

  private async flush(): Promise<void> {
    const runtime = this.ctx.ttdsRuntime
    if (this.disposed || !isQuiet(runtime.getSnapshot())) return
    this.buffer = this.buffer.filter(event => this.isEnabled(event))
    const entries = [...this.buffer].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))
    if (entries.length === 0) return
    const lifecycle = entries.filter(event => event.hookId !== 'ttds_tool_output_ready')
    const batch = lifecycle.slice(0, 3)
    const tools = entries.filter(event => event.hookId === 'ttds_tool_output_ready')
    const delivered = [...batch, ...tools]
    let accepted: boolean
    let text = ''
    if (batch.length === 0) {
      accepted = await runtime.requestSpokenTurn()
    } else {
      text = batch.map(event => event.summary.trim()).join('；')
      const remaining = lifecycle.length - batch.length
      if (remaining > 0) text += `（另有 ${remaining} 条后台会话进展待查看）`
      accepted = await runtime.injectHookNotification(text, { events: delivered, remainingCount: remaining })
    }
    // Identity checks preserve a newer event replacing the same dedupe key during an awaited delivery.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run during the awaited runtime delivery.
    if (!accepted || this.disposed) return
    this.buffer = this.buffer.filter(event => !delivered.includes(event))
    if (batch.length > 0) runtime.publishFeedItem({ kind: 'hook_event', text })
  }
}

/** The public registry and event engine share one instance and one disposal boundary. */
export { EventHookEngine as VoiceHookRegistry }
