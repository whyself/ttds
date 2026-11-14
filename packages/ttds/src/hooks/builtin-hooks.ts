import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  VoiceHookDefinition,
  VoiceHookRegistryContract,
  VoiceHookTriggerPayload,
} from '../shared/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Observe a normalized lifecycle notification without claiming host control flow.
     * @param event - notification using a registered hook identifier.
     */
    'ttds/lifecycle-event'(event: VoiceHookTriggerPayload): void
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
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
    // Model tool arguments may arrive malformed or truncated; ignore parse failures.
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

function workspaceNameOf(cwd: string | undefined): string {
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.replace(/[\\/]+$/u, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/u)
  return parts.at(-1) ?? ''
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length > 24 && sessionId.startsWith('session-')) return sessionId.slice(0, 16)
  return sessionId
}

function resolveWorkspaceTitle(ctx: Context, session: Session): string {
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
  return workspaceNameOf(session.header.cwd)
}

function formatSessionLabel(ctx: Context, session: Session, titles: ReadonlyMap<string, string>): string {
  const title = titles.get(session.id)
  const workspace = resolveWorkspaceTitle(ctx, session)
  if (title !== undefined && title !== '' && workspace !== '') return `工作区 ${workspace} 的会话「${title}」`
  if (title !== undefined && title !== '') return `会话「${title}」`
  if (workspace !== '') return `工作区 ${workspace} 的会话 ${shortSessionId(session.id)}`
  return `后台会话 ${shortSessionId(session.id)}`
}

function summarizeToolCallArguments(rawArgs: string): string {
  const args = parseJsonRecord(rawArgs)
  if (args === undefined) return ''
  for (const key of ['description', 'command', 'path', 'file_path', 'action', 'query', 'url'] as const) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return truncateText(value, 70)
  }
  return ''
}

function extractQuestionText(rawArgs: string): string {
  const args = parseJsonRecord(rawArgs)
  if (args === undefined || !Array.isArray(args.questions)) return ''
  const parts: string[] = []
  for (const entry of args.questions) {
    if (!isRecord(entry)) continue
    const header = typeof entry.header === 'string' ? entry.header.trim() : ''
    const question = typeof entry.question === 'string' ? entry.question.trim() : ''
    if (question !== '') {
      parts.push(header !== '' && !question.includes(header) ? `${header}：${question}` : question)
    } else if (header !== '') {
      parts.push(header)
    }
  }
  return truncateText(parts.join('；'), 90)
}

function cleanApprovalReason(reason: unknown): string {
  if (typeof reason !== 'string') return ''
  const replaced = reason.replace(/^escalate sandbox to ([^:]+):\s*/iu, '需提权至 $1：')
  return truncateText(replaced, 80)
}

function getExitCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const code = value.exitCode
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined
}

function parseExitCode(text: string): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Ordinary tool prose is not a structured shell result.
    return undefined
  }
  return getExitCode(value)
}

interface HookTrackerState {
  readonly sessionTitles: Map<string, string>
  readonly recentToolCalls: Map<string, { readonly name: string; readonly summary: string }>
}

function recordSessionMetadata(session: Session, event: SessionEvent, state: HookTrackerState): void {
  const type: string = event.type
  const data: unknown = event.data
  if (type === 'session/title' && isRecord(data) && typeof data.title === 'string') {
    const title = truncateText(data.title, 40)
    if (title !== '') setBounded(state.sessionTitles, session.id, title, 128)
    return
  }
  if (event.type === 'user/message' && !state.sessionTitles.has(session.id)
    && isRecord(event.data.source) && event.data.source.kind === 'user') {
    const raw = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    const title = truncateText(raw, 40)
    if (title !== '') setBounded(state.sessionTitles, session.id, title, 128)
    return
  }
  if (event.type === 'tool/call') {
    const summary = summarizeToolCallArguments(event.data.arguments)
    setBounded(state.recentToolCalls, `${session.id}:${event.data.callId}`, {
      name: event.data.name,
      summary,
    }, 128)
  }
}

function projectEvent(ctx: Context, session: Session, event: SessionEvent, state: HookTrackerState): VoiceHookTriggerPayload | undefined {
  recordSessionMetadata(session, event, state)
  if (event.seq < session.firstLiveSeq) return undefined
  const sessionId = session.id
  const label = formatSessionLabel(ctx, session, state.sessionTitles)
  const metadata = { sessionId, seq: event.seq, eventType: event.type }
  if (event.type === 'turn/end') {
    const reason = event.data.reason
    let failed: boolean
    switch (reason.kind) {
      case 'completed':
      case 'max-tokens':
        failed = false
        break
      case 'error':
      case 'blocked':
        failed = true
        break
      default:
        // Turn-end reasons are host-extensible; cancellations and synthetic closers are not news.
        return undefined
    }
    const child = session.header.origin === 'subagent'
      || (session.header.delegationDepth !== undefined && session.header.delegationDepth > 0)
    if (child) {
      return {
        hookId: 'subagent/settled',
        priority: 'normal',
        sessionId,
        dedupeKey: `subagent:${sessionId}`,
        summary: `子代理会话 ${shortSessionId(sessionId)} ${failed ? '执行失败' : '已完成任务'}`,
        metadata: { ...metadata, reason: reason.kind, parentSessionId: session.header.parentSession },
      }
    }
    return {
      hookId: failed ? 'agent/error' : 'agent/turn-settled',
      priority: failed ? 'high' : 'normal',
      sessionId,
      dedupeKey: `turn:${sessionId}`,
      summary: `${label}${failed ? '执行遇到错误，请查看详情' : '已完成本轮任务'}`,
      metadata: { ...metadata, reason: reason.kind },
    }
  }
  if (session.header.origin === 'subagent'
    || (session.header.delegationDepth !== undefined && session.header.delegationDepth > 0)) return undefined
  if (event.type === 'tool/call' && (event.data.name === 'ask_user_question' || event.data.name === 'ask_question')) {
    const questionText = extractQuestionText(event.data.arguments)
    return {
      hookId: 'agent/tool-approval',
      priority: 'critical',
      sessionId,
      dedupeKey: `question:${sessionId}:${event.data.callId}`,
      summary: questionText !== ''
        ? `${label}正在向你提问：「${questionText}」，请前往会话回复`
        : `${label}正在向你提问，等待你的回复`,
      metadata: { ...metadata, callId: event.data.callId, toolName: event.data.name, question: questionText },
    }
  }
  if (event.type === 'tool/result') {
    let exitCode = getExitCode(event.data.meta)
    if (exitCode === undefined) {
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue
        exitCode = parseExitCode(block.text)
        if (exitCode !== undefined) break
      }
    }
    if (exitCode === undefined || exitCode === 0) return undefined
    return {
      hookId: 'shell/exit-error',
      priority: 'high',
      sessionId,
      dedupeKey: `shell:${sessionId}:${event.data.message.toolCallId}`,
      summary: `${label}的命令执行失败，退出码 ${exitCode}`,
      metadata: { ...metadata, exitCode, callId: event.data.message.toolCallId },
    }
  }
  // Plugin-owned audit records cross a persisted JSON boundary and are not core SessionEvent variants.
  const type: string = event.type
  const data: unknown = event.data
  if (type === 'approval/asked' && isRecord(data) && typeof data.id === 'string' && typeof data.toolName === 'string') {
    const callKey = typeof data.callId === 'string' ? `${sessionId}:${data.callId}` : ''
    const callDetail = callKey !== '' ? state.recentToolCalls.get(callKey)?.summary ?? '' : ''
    const reasonDetail = cleanApprovalReason(data.reason)
    const detail = callDetail !== '' ? callDetail : reasonDetail
    return {
      hookId: 'agent/tool-approval',
      priority: 'critical',
      sessionId,
      dedupeKey: `approval:${sessionId}:${data.id}`,
      summary: detail !== ''
        ? `${label}请求执行 ${data.toolName}（${detail}），正等待你的权限审批`
        : `${label}请求调用工具 ${data.toolName}，正等待你的权限审批`,
      metadata: { ...metadata, approvalId: data.id },
    }
  }
  return undefined
}

/**
 * Register all six built-in definitions and observe public session and bridge event feeds.
 * @param ctx - context owning the definitions and event subscriptions.
 * @param hooks - registry receiving normalized notifications and enforcing live configuration.
 * @returns idempotent synchronous disposer detaching listeners and unregistering every definition.
 */
export function registerBuiltinVoiceHooks(ctx: Context, hooks: VoiceHookRegistryContract): () => void {
  const state: HookTrackerState = {
    sessionTitles: new Map(),
    recentToolCalls: new Map(),
  }
  const definitions: VoiceHookDefinition[] = [
    { id: 'ttds_tool_output_ready', priority: 'normal', isEnabled: () => true },
    { id: 'agent/turn-settled', priority: 'normal', isEnabled: config => config.hooks.onTurnSettled },
    { id: 'agent/tool-approval', priority: 'critical', isEnabled: config => config.hooks.onToolApproval },
    { id: 'agent/error', priority: 'high', isEnabled: config => config.hooks.onAgentError },
    { id: 'shell/exit-error', priority: 'high', isEnabled: config => config.hooks.onShellExitError },
    { id: 'subagent/settled', priority: 'normal', isEnabled: config => config.hooks.onSubagentSettled },
  ]
  const disposers: (() => void)[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    state.sessionTitles.clear()
    state.recentToolCalls.clear()
    for (const remove of disposers.reverse()) remove()
  }
  ctx.effect(() => dispose)
  for (const definition of definitions) disposers.push(hooks.register(definition))
  disposers.push(ctx.on('session/event', (session, event) => {
    const notification = projectEvent(ctx, session, event, state)
    if (notification !== undefined) hooks.enqueue(notification)
  }, { global: true }))
  disposers.push(ctx.on('ttds/lifecycle-event', (event) => { hooks.enqueue(event) }, { global: true }))
  return dispose
}
