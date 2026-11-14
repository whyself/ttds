/** Host approval bridge service and optional interaction contract for pending DSH tool approvals. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { VoiceToolResult } from '../shared/index.ts'

/** Closed approval decision outcomes aligned with `@deepseek-ai/dsh-user-approval`. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Minimal pending approval request payload observed on the host `approval/request` waterfall. */
export interface HostApprovalRequest {
  /** Agent whose session owns the pending tool decision. */
  readonly agent: {
    readonly id: string
    readonly session: Session
  }
  /** Tool name awaiting user confirmation. */
  readonly toolName: string
  /** Optional tool call identifier pairing the request with logged arguments. */
  readonly callId?: string
  /** Optional human-readable reason for requesting escalation. */
  readonly reason?: string
  /** Optional localized presentation text. */
  readonly displayReason?: Readonly<Record<string, string>>
  /** Cancellation signal aborted when the caller withdraws the request. */
  readonly signal?: AbortSignal
}

/** Pending approval item returned by {@link VoiceToolHostBridge.listPendingApprovals}. */
export interface VoicePendingApprovalView {
  /** Owning DSH session ID. */
  readonly sessionId: string
  /** Approval request identifier matching `approval/asked`. */
  readonly approvalId: string
  /** Tool name when captured by the host bridge. */
  readonly toolName?: string
  /** Concise human-readable description of the pending action. */
  readonly summary: string
}

/** Delegates pending approval inspection and decisions to the host's interaction owner. */
export interface VoiceToolHostBridge {
  /**
   * Read answerable approval identities without modifying pending interactions.
   * @param signal - Tool timeout and session cancellation.
   * @returns Compact approval rows with their session and approval identities.
   */
  listPendingApprovals(signal: AbortSignal): Promise<readonly VoicePendingApprovalView[]>
  /**
   * Submit a decision through the interaction owner and report its authoritative outcome.
   * @param request - Exact target and explicit approval or rejection.
   * @param signal - Tool timeout and session cancellation.
   * @returns Host-confirmed outcome, or a structured unavailable/unconfirmed error.
   */
  resolveToolApproval(
    request: { readonly sessionId: string; readonly approvalId: string; readonly approved: boolean },
    signal: AbortSignal,
  ): Promise<VoiceToolResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional adapter to the host's client-owned approval interaction mechanism. */
    ttdsToolHost: VoiceToolHostBridge
  }
  interface Events {
    /** Observe or answer host tool approval requests while delegating to downstream answerers. */
    'approval/request'(
      req: HostApprovalRequest,
      next: () => Promise<HostApprovalOutcome>,
    ): Promise<HostApprovalOutcome>
  }
}

type LocalDecision =
  | { readonly kind: 'decided'; readonly outcome: HostApprovalOutcome }
  | { readonly kind: 'yield' }

interface AskedApprovalRecord {
  readonly id: string
  readonly toolName: string
  readonly callId: string
  readonly reason: string
}

interface PendingApprovalEntry {
  readonly approvalId: string
  readonly sessionId: string
  readonly toolName: string
  readonly summary: string
  settled: boolean
  readonly decide: (decision: LocalDecision) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}…`
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Model tool arguments may arrive malformed; ignore parse errors.
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

function summarizeArgs(rawArgs: string): string {
  const args = parseJsonRecord(rawArgs)
  if (args === undefined) return ''
  for (const key of ['description', 'command', 'path', 'file_path', 'action', 'query', 'url'] as const) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return truncateText(value, 80)
  }
  return ''
}

function workspaceTitleOf(ctx: Context, session: Session): string {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    const byMembership = registry.list().find(item => item.sessionIds.includes(session.id))
    if (byMembership !== undefined && byMembership.title.trim() !== '') return byMembership.title.trim()
    const cwd = session.header.cwd?.replace(/[\\/]+$/u, '').toLowerCase()
    if (cwd !== undefined && cwd !== '') {
      const byPath = registry.list().find(item => item.path.replace(/[\\/]+$/u, '').toLowerCase() === cwd)
      if (byPath !== undefined && byPath.title.trim() !== '') return byPath.title.trim()
    }
  }
  const cwd = session.header.cwd?.replace(/[\\/]+$/u, '')
  if (cwd === undefined || cwd === '') return ''
  return cwd.split(/[\\/]/u).at(-1) ?? ''
}

/**
 * Built-in `ttdsToolHost` implementation observing `approval/request` waterfalls and session audit logs
 * so voice tools can inspect and approve/reject pending DSH tool escalations alongside Web UI answerers.
 */
export class VoiceApprovalHostBridge implements VoiceToolHostBridge {
  private readonly sessionTitles = new Map<string, string>()
  private readonly recentToolCalls = new Map<string, { readonly name: string; readonly summary: string }>()
  private readonly askedQueue = new Map<string, AskedApprovalRecord[]>()
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>()
  private disposed = false

  /**
   * Publish `ttdsToolHost` on the owning context and attach global approval waterfall observers.
   * @param ctx - plugin context providing `sessions`, `ttdsRuntime`, and waterfall events.
   */
  constructor(private readonly ctx: Context) {
    const provision = ctx.provide('ttdsToolHost', this)
    const removeSessionListener = ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    }, { global: true })
    const removeWaterfall = ctx.on('approval/request', (req, next) => this.handleApprovalRequest(req, next), {
      global: true,
      prepend: true,
    })
    ctx.effect(() => () => {
      this.dispose()
      removeWaterfall()
      removeSessionListener()
      provision()
    })
  }

  /**
   * Read pending approvals currently open on the host `approval/request` waterfall.
   * @param signal - Tool timeout and cancellation signal.
   * @returns Compact pending approval descriptors with session ID, approval ID, and summary.
   */
  listPendingApprovals(signal: AbortSignal): Promise<readonly VoicePendingApprovalView[]> {
    signal.throwIfAborted()
    return Promise.resolve([...this.pendingApprovals.values()].map(entry => ({
      sessionId: entry.sessionId,
      approvalId: entry.approvalId,
      toolName: entry.toolName,
      summary: entry.summary,
    })))
  }

  /**
   * Submit an explicit allow/reject decision for a pending approval captured from `approval/request`.
   * @param request - Target session ID, approval ID, and explicit boolean decision.
   * @param signal - Tool timeout and cancellation signal.
   * @returns Confirmed outcome when a live request was settled, or a structured error if absent.
   */
  resolveToolApproval(
    request: { readonly sessionId: string; readonly approvalId: string; readonly approved: boolean },
    signal: AbortSignal,
  ): Promise<VoiceToolResult> {
    signal.throwIfAborted()
    const target = this.findPendingEntry(request.sessionId, request.approvalId)
    if (target === undefined || target.settled) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'approval_not_found',
          message: '未找到对应的待审批请求，可能已在界面处理或已取消。',
        },
      })
    }
    const outcome: HostApprovalOutcome = request.approved ? 'allowed-once' : 'rejected'
    target.decide({ kind: 'decided', outcome })
    return Promise.resolve({
      ok: true,
      data: {
        sessionId: target.sessionId,
        approvalId: target.approvalId,
        toolName: target.toolName,
        approved: request.approved,
        outcome,
      },
    })
  }

  private findPendingEntry(sessionId: string, approvalId: string): PendingApprovalEntry | undefined {
    const exact = this.pendingApprovals.get(approvalId)
    if (exact !== undefined && exact.sessionId === sessionId) return exact
    const matches = [...this.pendingApprovals.values()].filter(item => item.sessionId === sessionId)
    return matches.length === 1 ? matches[0] : undefined
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const type: string = event.type
    const data: unknown = event.data
    if (type === 'session/title' && isRecord(data) && typeof data.title === 'string') {
      const title = truncateText(data.title, 30)
      if (title !== '') setBounded(this.sessionTitles, session.id, title, 128)
      return
    }
    if (event.type === 'user/message' && !this.sessionTitles.has(session.id)
      && isRecord(event.data.source) && event.data.source.kind === 'user') {
      const raw = event.data.content.filter(block => block.type === 'text').map(block => block.text).join(' ')
      const title = truncateText(raw, 30)
      if (title !== '') setBounded(this.sessionTitles, session.id, title, 128)
      return
    }
    if (event.type === 'tool/call') {
      setBounded(this.recentToolCalls, `${session.id}:${event.data.callId}`, {
        name: event.data.name,
        summary: summarizeArgs(event.data.arguments),
      }, 128)
      return
    }
    if (type === 'approval/asked' && isRecord(data) && typeof data.id === 'string' && typeof data.toolName === 'string') {
      const queue = this.askedQueue.get(session.id) ?? []
      queue.push({
        id: data.id,
        toolName: data.toolName,
        callId: typeof data.callId === 'string' ? data.callId : '',
        reason: typeof data.reason === 'string' ? data.reason : '',
      })
      if (queue.length > 32) queue.shift()
      this.askedQueue.set(session.id, queue)
      return
    }
    if (type === 'approval/decided' && isRecord(data) && typeof data.id === 'string') {
      const queue = this.askedQueue.get(session.id)
      if (queue !== undefined) {
        const filtered = queue.filter(item => item.id !== data.id)
        if (filtered.length === 0) this.askedQueue.delete(session.id)
        else this.askedQueue.set(session.id, filtered)
      }
      const entry = this.pendingApprovals.get(data.id)
      if (entry !== undefined && !entry.settled) {
        const outcome: HostApprovalOutcome = data.outcome === 'allowed-once'
          || data.outcome === 'rejected'
          || data.outcome === 'cancelled'
          || data.outcome === 'unavailable'
          ? data.outcome
          : 'unavailable'
        entry.decide({ kind: 'decided', outcome })
      }
    }
  }

  private consumeAskedId(sessionId: string, toolName: string, callId: string | undefined): string {
    const queue = this.askedQueue.get(sessionId)
    if (queue === undefined || queue.length === 0) return randomUUID()
    const index = queue.findIndex(item => item.toolName === toolName
      && (callId === undefined || item.callId === '' || item.callId === callId))
    if (index < 0) return randomUUID()
    const [matched] = queue.splice(index, 1)
    if (queue.length === 0) this.askedQueue.delete(sessionId)
    return matched?.id ?? randomUUID()
  }

  private formatSummary(req: HostApprovalRequest): string {
    const session = req.agent.session
    const ws = workspaceTitleOf(this.ctx, session)
    const title = this.sessionTitles.get(session.id)
    const callSummary = req.callId !== undefined
      ? this.recentToolCalls.get(`${session.id}:${req.callId}`)?.summary ?? ''
      : ''
    const reason = typeof req.reason === 'string'
      ? truncateText(req.reason.replace(/^escalate sandbox to ([^:]+):\s*/iu, '提权至 $1：'), 80)
      : ''
    const detail = callSummary || reason
    const prefix = title !== undefined && title !== ''
      ? (ws !== '' ? `[${ws}] 会话「${title}」` : `会话「${title}」`)
      : (ws !== '' ? `[${ws}] ` : '')
    return detail !== '' ? `${prefix}${req.toolName}（${detail}）` : `${prefix}${req.toolName}`
  }

  private isVoiceSessionActive(): boolean {
    const runtime = this.ctx.get('ttdsRuntime')
    return runtime !== undefined && runtime.getSnapshot().supervisorSessionId !== null
  }

  private async handleApprovalRequest(
    req: HostApprovalRequest,
    next: () => Promise<HostApprovalOutcome>,
  ): Promise<HostApprovalOutcome> {
    const downstream = Promise.resolve().then(() => next())
    // Downstream answerer rejections are normalized as unavailable below; suppress unhandled rejections.
    void downstream.catch(() => {})
    if (this.disposed) return await downstream
    if (req.signal?.aborted) return 'cancelled'

    const sessionId = req.agent.session.id
    const approvalId = this.consumeAskedId(sessionId, req.toolName, req.callId)
    let resolveLocal: (decision: LocalDecision) => void = () => {}
    const localPromise = new Promise<LocalDecision>((resolve) => { resolveLocal = resolve })
    const entry: PendingApprovalEntry = {
      approvalId,
      sessionId,
      toolName: req.toolName,
      summary: this.formatSummary(req),
      settled: false,
      decide: (decision) => {
        if (entry.settled) return
        entry.settled = true
        resolveLocal(decision)
      },
    }
    this.pendingApprovals.set(approvalId, entry)

    const onAbort = (): void => {
      entry.decide({ kind: 'decided', outcome: 'cancelled' })
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    let stopRuntimeWatch: (() => void) | undefined
    const runtime = this.ctx.get('ttdsRuntime')
    if (runtime !== undefined) {
      stopRuntimeWatch = runtime.onStateChange((snapshot) => {
        if (snapshot.supervisorSessionId === null) entry.decide({ kind: 'yield' })
      })
    }

    try {
      const winner = await Promise.race([
        localPromise.then(decision => ({ kind: 'local' as const, decision })),
        downstream.then(
          outcome => ({ kind: 'downstream' as const, outcome }),
          () => ({ kind: 'downstream' as const, outcome: 'unavailable' as const }),
        ),
      ])

      if (winner.kind === 'local') {
        if (winner.decision.kind === 'decided') return winner.decision.outcome
        return await downstream.catch(() => 'unavailable')
      }

      if (winner.outcome !== 'unavailable' || !this.isVoiceSessionActive()) {
        return winner.outcome
      }

      // No browser answerer claimed the prompt; keep waiting for a voice decision while the voice session is active.
      const voiceDecision = await localPromise
      return voiceDecision.kind === 'decided' ? voiceDecision.outcome : 'unavailable'
    } finally {
      req.signal?.removeEventListener('abort', onAbort)
      stopRuntimeWatch?.()
      entry.settled = true
      if (this.pendingApprovals.get(approvalId) === entry) this.pendingApprovals.delete(approvalId)
    }
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.pendingApprovals.values()]) entry.decide({ kind: 'yield' })
    this.pendingApprovals.clear()
    this.askedQueue.clear()
    this.recentToolCalls.clear()
    this.sessionTitles.clear()
  }
}
