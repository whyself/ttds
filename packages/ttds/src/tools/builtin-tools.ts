/** Bounded voice-facing tools backed by public DSH Session and Web services. */
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionController,
  SessionCreateRequest,
  SessionProjectionsValue,
  SessionQueuedItem,
  SessionRequestId,
  SessionSummary,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-web'
import type {} from './host-bridge.ts'
import type {
  VoiceToolDefinition,
  VoiceToolExecutionContext,
  VoiceToolJsonSchema,
  VoiceToolRegistryContract,
  VoiceToolResult,
} from '../shared/index.ts'

type WorkspaceIdLike = NonNullable<SessionCreateRequest['workspaceId']>

interface WorkspaceEntryLike {
  readonly id: WorkspaceIdLike
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly SessionId[]
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceEntryLike[]
  resolveByPath?(path: string): Promise<WorkspaceEntryLike | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional Host workspace registry mapping workspaces and canonical directories. */
    workspaceRegistry?: WorkspaceRegistryLike
  }
}

function error(code: string, message: string): VoiceToolResult {
  return { ok: false, error: { code, message } }
}

function text(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value
}

function stringArg(args: Readonly<Record<string, unknown>>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`参数 ${name} 必须是非空字符串。`)
  return value
}

function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  if (args[name] === undefined) return undefined
  return stringArg(args, name)
}

function normalizeDirPath(pathValue: string | undefined): string {
  if (typeof pathValue !== 'string') return ''
  return pathValue.trim().replace(/[\\/]+$/u, '').toLowerCase()
}

function queueItemText(content: readonly unknown[]): string {
  return text(content.map(block => text(object(block).text, 200)).filter(Boolean).join(' '), 200)
}

function findSessionWorkspace(
  workspaces: readonly WorkspaceEntryLike[],
  sessionId: SessionId,
  cwd: string | undefined,
): WorkspaceEntryLike | undefined {
  const byId = workspaces.find(ws => ws.sessionIds.includes(sessionId))
  if (byId !== undefined) return byId
  const normalized = normalizeDirPath(cwd)
  if (normalized === '') return undefined
  return workspaces.find(ws => normalizeDirPath(ws.path) === normalized)
}

function pickDefaultWorkspace(workspaces: readonly WorkspaceEntryLike[]): WorkspaceEntryLike | undefined {
  return workspaces.find(ws =>
    normalizeDirPath(ws.path).endsWith('default-workspace')
    || ws.title.trim() === '默认工作区'
    || ws.title.includes('默认'),
  ) ?? workspaces[0]
}

async function resolveCreateTarget(
  ctx: Context,
  workspaceArg: string | undefined,
  cwdArg: string | undefined,
): Promise<
  | { readonly ok: true; readonly request: Pick<SessionCreateRequest, 'workspaceId' | 'cwd'>; readonly workspaceTitle?: string }
  | { readonly ok: false; readonly result: VoiceToolResult }
> {
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry?.list() ?? []

  if (workspaceArg !== undefined) {
    const normalized = workspaceArg.trim().toLowerCase()
    let matched = workspaces.find(ws =>
      ws.id.toLowerCase() === normalized
      || ws.title.trim().toLowerCase() === normalized
      || (ws.path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? '').toLowerCase() === normalized,
    )
    if (matched === undefined && ['默认工作区', '默认', 'default', 'default-workspace'].includes(normalized)) {
      matched = pickDefaultWorkspace(workspaces)
    }
    if (matched !== undefined) {
      return { ok: true, request: { workspaceId: matched.id }, workspaceTitle: matched.title }
    }
    if (isAbsolute(workspaceArg)) {
      return { ok: true, request: { cwd: workspaceArg } }
    }
    const available = workspaces.map(ws => ws.title || ws.id).join('、') || '无'
    return { ok: false, result: error('workspace_not_found', `未找到名为“${workspaceArg}”的工作区，当前可用工作区：${available}。`) }
  }

  if (cwdArg !== undefined) {
    if (registry !== undefined) {
      let resolved: WorkspaceEntryLike | undefined
      if (registry.resolveByPath !== undefined) {
        try {
          resolved = await registry.resolveByPath(cwdArg)
        } catch {
          // Nonexistent or non-canonical directory falls back to plain string path comparison and direct cwd creation.
          resolved = undefined
        }
      }
      resolved ??= workspaces.find(ws => normalizeDirPath(ws.path) === normalizeDirPath(cwdArg))
      if (resolved !== undefined) {
        return { ok: true, request: { workspaceId: resolved.id }, workspaceTitle: resolved.title }
      }
    }
    return { ok: true, request: { cwd: cwdArg } }
  }

  const fallback = pickDefaultWorkspace(workspaces)
  if (fallback !== undefined) {
    return { ok: true, request: { workspaceId: fallback.id }, workspaceTitle: fallback.title }
  }
  return { ok: true, request: {} }
}

function limitArg(args: Readonly<Record<string, unknown>>, name: string, fallback: number, maximum: number): number {
  const value = args[name]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`参数 ${name} 必须为 1 到 ${maximum} 的整数。`)
  }
  return value
}

function controller(ctx: Context): SessionController {
  const service = ctx.get('sessionController')
  if (service === undefined) throw new Error('缺少 DSH sessionController 服务。')
  return service
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function eventText(event: SessionWireEvent): string {
  const data = object(event.data)
  if (typeof data.text === 'string') return text(data.text, 600)
  const message = object(data.message)
  const content = data.content ?? message.content
  if (typeof content === 'string') return text(content, 600)
  if (!Array.isArray(content)) return ''
  return text(content.map((block: unknown) => text(object(block).text, 600)).filter(Boolean).join('\n'), 600)
}

async function recentEvents(
  ctx: Context,
  sessionId: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ readonly events: readonly SessionWireEvent[]; readonly hasMore: boolean }> {
  const page = await controller(ctx).events({
    address: { kind: 'session', sessionId: SessionId(sessionId) },
    maxMessages: limit,
  }, signal)
  return {
    events: page.records.map(record => record.event),
    hasMore: page.hasMore,
  }
}

function summaryTitleFromValues(values: unknown): string | null {
  const raw = object(values).title
  if (typeof raw !== 'string') return null
  const trimmed = raw.replace(/\s+/gu, ' ').trim()
  return trimmed === '' ? null : text(trimmed, 120)
}

function summaryTitle(item: SessionSummary | undefined): string | null {
  return summaryTitleFromValues(item?.projections?.values)
}

function isUserAuthoredMessage(event: SessionWireEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = object(object(event.data).source)
  return source.kind === undefined || source.kind === 'user'
}

function extractTitleFromEvents(events: readonly SessionWireEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const title = summaryTitleFromValues(event.data)
    if (title !== null) return title
  }
  const firstUser = events.find(isUserAuthoredMessage)
  if (firstUser === undefined) return null
  const preview = eventText(firstUser).replace(/\s+/gu, ' ').trim()
  return preview === '' ? null : text(preview, 48)
}

async function readProjectedTitle(ctx: Context, sessionId: string, signal: AbortSignal): Promise<string | null> {
  const service: { projections?: SessionController['projections'] } = controller(ctx)
  if (typeof service.projections !== 'function') return null
  let value: SessionProjectionsValue
  try {
    value = await service.projections({ sessionId: SessionId(sessionId) }, signal)
  } catch {
    // Projection lookups on cold or unmigrated sessions fall back to event scanning.
    return null
  }
  return value === null ? null : summaryTitleFromValues(value.values)
}

function sessionPriorityRank(item: SessionSummary): number {
  if (!item.blank && item.origin !== 'subagent') return 0
  if (item.origin !== 'subagent') return 1
  return 2
}

function sortSessionsByPriority(items: readonly SessionSummary[]): SessionSummary[] {
  return [...items].sort((a, b) => sessionPriorityRank(a) - sessionPriorityRank(b))
}

function isIntermediateToolStepMessage(events: readonly SessionWireEvent[], index: number): boolean {
  const current = events[index]
  if (current?.type !== 'assistant/message') return false
  const data = object(current.data)
  const msg = object(data.message)
  const toolCalls = msg.toolCalls ?? data.toolCalls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true
  const rawContent = msg.content ?? data.content
  if (Array.isArray(rawContent)) {
    const hasToolBlock = rawContent.some((block: unknown) => {
      const kind = object(block).type
      return kind === 'tool-call' || kind === 'tool_call' || kind === 'tool_use'
    })
    if (hasToolBlock) return true
  }
  const turn = data.turn
  const step = data.step
  if (typeof turn === 'number' && typeof step === 'number') {
    return events.some(other =>
      other.type === 'tool/call' && object(other.data).turn === turn && object(other.data).step === step)
  }
  for (let nextIndex = index + 1; nextIndex < events.length; nextIndex++) {
    const nextEvent = events[nextIndex]
    if (nextEvent === undefined) break
    if (nextEvent.type === 'tool/call') return true
    if (nextEvent.type === 'user/message' || nextEvent.type === 'turn/end' || nextEvent.type === 'assistant/message') {
      return false
    }
  }
  return false
}

async function resolveTargetSessionId(
  ctx: Context,
  rawRef: string,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly sessionId: string; readonly summary?: SessionSummary }
  | { readonly ok: false; readonly result: VoiceToolResult }
> {
  const trimmed = rawRef.trim()
  const lower = trimmed.toLowerCase()
  const isLatestAlias = lower === 'latest' || trimmed === '最新' || trimmed === '最近'
    || trimmed === '最新会话' || trimmed === '最近会话'
  if (!isLatestAlias && ctx.get('sessions')?.get(SessionId(trimmed)) !== undefined) {
    return { ok: true, sessionId: trimmed }
  }
  const listed = await controller(ctx).list({}, signal)
  if (isLatestAlias) {
    const ordered = sortSessionsByPriority(listed.items)
    const target = ordered[0]
    if (target === undefined) return { ok: false, result: error('session_not_found', '当前没有可操作的 DSH 会话。') }
    return { ok: true, sessionId: target.sessionId, summary: target }
  }
  const exact = listed.items.find(item => item.sessionId === trimmed)
  if (exact !== undefined) return { ok: true, sessionId: exact.sessionId, summary: exact }

  const exactTitleMatches = listed.items.filter(item => summaryTitle(item)?.toLowerCase() === lower)
  if (exactTitleMatches.length === 1 && exactTitleMatches[0] !== undefined) {
    return { ok: true, sessionId: exactTitleMatches[0].sessionId, summary: exactTitleMatches[0] }
  }

  const partialMatches = listed.items.filter(item =>
    (trimmed.length >= 8 && item.sessionId.toLowerCase().startsWith(lower))
    || (summaryTitle(item)?.toLowerCase().includes(lower) === true),
  )
  if (partialMatches.length === 1 && partialMatches[0] !== undefined) {
    return { ok: true, sessionId: partialMatches[0].sessionId, summary: partialMatches[0] }
  }
  const pool = exactTitleMatches.length > 1 ? exactTitleMatches : partialMatches
  if (pool.length > 1) {
    const primaryMatches = pool.filter(item => !item.blank && item.origin !== 'subagent')
    if (primaryMatches.length === 1 && primaryMatches[0] !== undefined) {
      return { ok: true, sessionId: primaryMatches[0].sessionId, summary: primaryMatches[0] }
    }
    const display = (primaryMatches.length > 1 ? primaryMatches : pool)
      .slice(0, 5)
      .map(item => `${summaryTitle(item) ?? '未命名'} (${item.sessionId})`)
      .join('；')
    return { ok: false, result: error('ambiguous_session', `匹配到多个会话，请指定具体 sessionId：${display}`) }
  }
  return { ok: true, sessionId: trimmed }
}

async function readInitialPrompt(
  ctx: Context,
  sessionId: string,
  hasMore: boolean,
  loadedEvents: readonly SessionWireEvent[],
  signal: AbortSignal,
): Promise<string | null> {
  if (hasMore) {
    try {
      const head = await controller(ctx).events({
        address: { kind: 'session', sessionId: SessionId(sessionId) },
        throughSeq: 15,
        maxMessages: 2,
      }, signal)
      const headUser = head.records.map(record => record.event).find(isUserAuthoredMessage)
      if (headUser !== undefined) {
        const promptText = eventText(headUser).trim()
        if (promptText !== '') return text(promptText, 240)
      }
    } catch {
      // Cold sessions or mocks that reject throughSeq lookups fall back to the loaded window.
    }
  }
  const fallbackUser = loadedEvents.find(isUserAuthoredMessage)
  if (fallbackUser === undefined) return null
  const fallbackText = eventText(fallbackUser).trim()
  return fallbackText === '' ? null : text(fallbackText, 240)
}

async function selfAction<T>(
  context: VoiceToolExecutionContext,
  sessionId: string,
  actionKind: string,
  action: () => Promise<T> | T,
): Promise<T> {
  context.signal.throwIfAborted()
  const guard = context.beginSelfAction(sessionId, actionKind)
  try {
    return await action()
  } finally {
    guard.release()
  }
}

function gitSummary(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args], {
      signal, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
    }, (failure, stdout) => {
      if (failure !== null) reject(new Error(failure.message, { cause: failure }))
      else resolve(stdout)
    })
  })
}

function schema(
  properties: VoiceToolJsonSchema['properties'],
  required: readonly string[] = [],
): VoiceToolJsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function definitions(ctx: Context): VoiceToolDefinition[] {
  const sessionProperty = {
    type: 'string' as const,
    description: '目标 DSH 会话 ID、唯一会话标题关键词，或传 "latest" 自动定位最近活跃的非空白主会话。',
  }
  const sessionSchema = schema({ sessionId: sessionProperty }, ['sessionId'])
  return [
    {
      name: 'dsh_list_sessions',
      description: '列出活跃与最近的 DSH 会话、标题、工作目录、运行状态和事件序号。',
      category: 'read',
      parameters: schema({}),
      resolveConfirmation: () => 'auto',
      execute: async (_args, context) => {
        const listed = await controller(ctx).list({}, context.signal)
        const workspaces = ctx.get('workspaceRegistry')?.list() ?? []
        const items = sortSessionsByPriority(listed.items).slice(0, 20)
        return { ok: true, data: {
          workspaces: workspaces.map(ws => ({
            workspaceId: ws.id,
            title: text(ws.title, 120),
            path: text(ws.path, 240),
          })),
          sessions: items.map((item) => {
            const live = ctx.get('sessions')?.get(item.sessionId)
            const ws = findSessionWorkspace(workspaces, item.sessionId, item.cwd)
            return {
              sessionId: item.sessionId,
              title: summaryTitle(item),
              cwd: text(item.cwd, 240),
              workspaceId: ws?.id ?? null,
              workspaceTitle: ws === undefined ? null : text(ws.title, 120),
              running: item.running,
              active: item.agentAvailable,
              blank: item.blank,
              updatedAt: item.updatedAt,
              origin: item.origin ?? 'root',
              lastEventSeq: live === undefined ? null : live.seq - 1,
            }
          }),
          truncated: listed.items.length > items.length,
        } }
      },
    },
    {
      name: 'dsh_get_session_progress',
      description: '读取会话标题、运行状态、最新实质助手结论和工具活动摘要。',
      category: 'read',
      parameters: sessionSchema,
      resolveConfirmation: () => 'auto',
      execute: async (args, context) => {
        const resolved = await resolveTargetSessionId(ctx, stringArg(args, 'sessionId'), context.signal)
        if (!resolved.ok) return resolved.result
        const sessionId = resolved.sessionId
        const state = await controller(ctx).state({ sessionId: SessionId(sessionId) }, context.signal)
        const { events } = await recentEvents(ctx, sessionId, 30, context.signal)
        const title = summaryTitle(resolved.summary)
          ?? await readProjectedTitle(ctx, sessionId, context.signal)
          ?? extractTitleFromEvents(events)
        const assistantMessages = events
          .map((event, index) => ({
            event,
            intermediate: isIntermediateToolStepMessage(events, index),
            text: eventText(event),
          }))
          .filter(entry => entry.event.type === 'assistant/message' && entry.text.trim() !== '')
        const finalAssistant = assistantMessages.filter(entry => !entry.intermediate).at(-1)
          ?? assistantMessages.at(-1)
        const phase = events.filter(event => /^(turn|step)\//u.test(event.type)).at(-1)
        const queued: readonly SessionQueuedItem[] = (state.queue ?? []).filter(item => item.placement === 'queued')
        return { ok: true, data: {
          sessionId, title, active: state.active, running: state.running, lastEventSeq: state.cursor,
          phase: phase === undefined ? (state.running ? 'running' : 'idle') : phase.type,
          pendingInput: state.pendingInput.slice(0, 10),
          queuedCount: queued.length,
          queuedPrompts: queued.slice(0, 5).map(item => ({ itemId: item.id, text: queueItemText(item.content) })),
          latestAssistant: finalAssistant?.text ?? '',
          toolActivity: events.filter(event => /tool/u.test(event.type)).slice(-5).map(event => ({
            seq: event.seq, type: event.type, name: text(object(event.data).name, 80),
          })),
        } }
      },
    },
    {
      name: 'dsh_inspect_workspace_changes',
      description: '读取指定会话或绝对工作目录中的 Git 文件改动和差异统计。',
      category: 'read',
      parameters: schema({
        sessionId: sessionProperty,
        cwd: { type: 'string', description: '绝对工作目录；与 sessionId 至少提供一个。' },
      }),
      resolveConfirmation: () => 'auto',
      execute: async (args, context) => {
        const rawSessionId = optionalString(args, 'sessionId')
        const explicitCwd = optionalString(args, 'cwd')
        let resolvedSessionId: string | undefined
        let resolvedSummary: SessionSummary | undefined
        if (rawSessionId !== undefined) {
          const resolved = await resolveTargetSessionId(ctx, rawSessionId, context.signal)
          if (!resolved.ok) return resolved.result
          resolvedSessionId = resolved.sessionId
          resolvedSummary = resolved.summary
        }
        const live = resolvedSessionId === undefined ? undefined : ctx.get('sessions')?.get(SessionId(resolvedSessionId))
        const cwd = explicitCwd ?? live?.header.cwd ?? resolvedSummary?.cwd
        if (cwd === undefined || !isAbsolute(cwd)) return error('workspace_unavailable', '请提供绝对工作目录或已加载的会话 ID。')
        const [status, stat] = await Promise.all([
          gitSummary(cwd, ['status', '--short'], context.signal),
          gitSummary(cwd, ['diff', '--stat'], context.signal),
        ])
        return { ok: true, data: { cwd: text(cwd, 240), status: text(status, 1800), diffStat: text(stat, 1800),
          truncated: status.length > 1800 || stat.length > 1800 } }
      },
    },
    {
      name: 'dsh_read_session_messages',
      description: '读取指定 DSH 会话标题、首条任务及最近用户提问和最终助手回复，自动过滤中间工具调用步骤草稿。',
      category: 'read',
      parameters: schema({
        sessionId: sessionProperty,
        limit: { type: 'integer', description: '返回的最近消息条数，默认 5，范围 1 到 20。' },
      }, ['sessionId']),
      resolveConfirmation: () => 'auto',
      execute: async (args, context) => {
        const rawSessionId = stringArg(args, 'sessionId')
        const limit = limitArg(args, 'limit', 5, 20)
        const resolved = await resolveTargetSessionId(ctx, rawSessionId, context.signal)
        if (!resolved.ok) return resolved.result
        const sessionId = resolved.sessionId
        const scanWindow = Math.max(limit * 6, 30)
        const { events, hasMore } = await recentEvents(ctx, sessionId, scanWindow, context.signal)
        const [projectedTitle, initialPrompt] = await Promise.all([
          summaryTitle(resolved.summary) === null ? readProjectedTitle(ctx, sessionId, context.signal) : Promise.resolve(null),
          readInitialPrompt(ctx, sessionId, hasMore, events, context.signal),
        ])
        const title = summaryTitle(resolved.summary) ?? projectedTitle ?? extractTitleFromEvents(events)
        const finalMessages = events.filter((event, index) =>
          isUserAuthoredMessage(event)
          || (event.type === 'assistant/message' && !isIntermediateToolStepMessage(events, index) && eventText(event).trim() !== ''))
        let candidateMessages = finalMessages
        if (!finalMessages.some(event => event.type === 'assistant/message')) {
          const fallbackAssistant = [...events].reverse().find(
            event => event.type === 'assistant/message' && eventText(event).trim() !== '',
          )
          if (fallbackAssistant !== undefined) {
            candidateMessages = [...finalMessages, fallbackAssistant].sort((a, b) => a.seq - b.seq)
          }
        }
        const selected = candidateMessages.slice(-limit)
        const projected = selected.map(event => ({ seq: event.seq, role: event.type.split('/')[0], text: eventText(event) }))
        return { ok: true, data: {
          sessionId,
          title,
          initialPrompt,
          messages: projected,
          truncated: candidateMessages.length > limit || hasMore || projected.some(item => item.text.endsWith('…')),
        } }
      },
    },
    {
      name: 'dsh_list_pending_approvals',
      description: '列出等待人工处理的 DSH 审批或交互项。',
      category: 'read',
      parameters: schema({}),
      resolveConfirmation: () => 'auto',
      execute: async (_args, context) => {
        const host = ctx.get('ttdsToolHost')
        if (host !== undefined) {
          const items = await host.listPendingApprovals(context.signal)
          const titleMap = new Map<string, string>()
          const sessionService = ctx.get('sessionController')
          if (items.length > 0 && sessionService !== undefined) {
            try {
              const listed = await sessionService.list({}, context.signal)
              for (const row of listed.items) {
                const rowTitle = summaryTitle(row)
                if (rowTitle !== null) titleMap.set(row.sessionId, rowTitle)
              }
            } catch {
              // Approval listings remain valid even when session metadata listing fails.
            }
          }
          return { ok: true, data: { approvals: items.slice(0, 20).map((item) => {
            const sessionTitle = titleMap.get(item.sessionId)
            return {
              sessionId: item.sessionId,
              ...(sessionTitle === undefined ? {} : { sessionTitle }),
              approvalId: item.approvalId,
              ...(item.toolName === undefined ? {} : { toolName: item.toolName }),
              summary: text(item.summary, 240),
            }
          }), truncated: items.length > 20 } }
        }
        const listed = await controller(ctx).list({}, context.signal)
        const pending = await Promise.all(listed.items.slice(0, 20).map(async (item) => {
          const state = await controller(ctx).state({ sessionId: item.sessionId }, context.signal)
          const sessionTitle = summaryTitle(item)
          return {
            sessionId: item.sessionId,
            ...(sessionTitle === null ? {} : { sessionTitle }),
            pendingInput: state.pendingInput.slice(0, 10),
          }
        }))
        return { ok: true, data: {
          approvals: pending.filter(item => item.pendingInput.length > 0),
          truncated: listed.items.length > 20,
          resolutionAvailable: false,
        } }
      },
    },
    {
      name: 'dsh_search',
      description: '使用 DSH 配置的联网搜索源检索网页，返回摘要和来源。',
      category: 'search',
      parameters: schema({
        query: { type: 'string', description: '要检索的问题或关键词。' },
        maxResults: { type: 'integer', description: '来源数量，默认 5，范围 1 到 10。' },
      }, ['query']),
      resolveConfirmation: () => 'auto',
      execute: async (args, context) => {
        const query = stringArg(args, 'query')
        const maxResults = limitArg(args, 'maxResults', 5, 10)
        const web = ctx.get('web')
        if (web === undefined) return error('web_search_unavailable', '未安装 DSH web 服务，请先配置搜索源。')
        let found: Awaited<ReturnType<typeof web.search>>
        try {
          found = await web.search({ query, maxResults }, context.signal)
        } catch (caught: unknown) {
          const code = object(caught).code
          return error(typeof code === 'string' ? code : 'web_search_unavailable', text(String(caught), 320))
        }
        return { ok: true, data: {
          summary: text(found.content, 800),
          sources: found.sources.slice(0, maxResults).map(source => ({
            title: text(source.title, 160), url: text(source.url, 1000), snippet: text(source.snippet ?? source.summary, 320),
          })),
          truncated: found.truncated || found.sources.length > maxResults,
          untrustedExternalContent: true,
        } }
      },
    },
    {
      name: 'dsh_create_session',
      description: '在指定或默认工作区中创建后台 DSH 会话并归入侧边栏工作区分组，可附带首条任务。',
      category: 'write',
      parameters: schema({
        workspace: { type: 'string', description: '目标工作区名称、标题或 ID（例如“默认工作区”）；省略且未指定 cwd 时自动归入默认工作区。' },
        cwd: { type: 'string', description: '新会话的工作目录；省略时自动归入默认工作区。' },
        prompt: {
          type: 'string',
          description: '创建后立即发送的首条任务，可省略。必须完整保留用户原话中的具体数值、档位、型号、专有名词与限制条件（如积分额度、订阅倍数、项目或模型原名），严禁自行缩写删减或添加用户未提及的模型与假设。',
        },
      }),
      resolveConfirmation: config => config.tools.writeConfirmation,
      summarizeCall: (args) => {
        const workspace = typeof args.workspace === 'string' && args.workspace.trim() !== '' ? text(args.workspace.trim(), 120) : ''
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? text(args.cwd.trim(), 240) : ''
        const scope = workspace || cwd || '默认工作区'
        const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? text(args.prompt.trim(), 400) : ''
        return prompt === '' ? `创建 DSH 会话（${scope}）` : `创建 DSH 会话（${scope}）：${prompt}`
      },
      execute: async (args, context) => {
        const workspaceArg = optionalString(args, 'workspace')
        const cwdArg = optionalString(args, 'cwd')
        const prompt = optionalString(args, 'prompt')
        const target = await resolveCreateTarget(ctx, workspaceArg, cwdArg)
        if (!target.ok) return target.result
        const service = controller(ctx)
        const requestedId = SessionId(`ttds-${context.supervisorSessionId}-${context.callId}`)
        return await selfAction(context, requestedId, 'create_session', async () => {
          const created = await service.create({ sessionId: requestedId, ...target.request })
          if (prompt !== undefined) {
            await selfAction(context, created.sessionId, 'send_session_prompt', () => service.prompt({
              sessionId: created.sessionId,
              requestId: `ttds:${context.supervisorSessionId}:${context.callId}` as SessionRequestId,
              mode: 'queue', content: [{ type: 'text', text: prompt }],
            }, context.signal))
          }
          return { ok: true, data: {
            sessionId: created.sessionId,
            ...(target.request.workspaceId === undefined ? {} : { workspaceId: target.request.workspaceId }),
            ...(target.workspaceTitle === undefined ? {} : { workspaceTitle: target.workspaceTitle }),
            promptSubmitted: prompt !== undefined,
          } }
        })
      },
    },
    {
      name: 'dsh_send_session_prompt',
      description: '向后台 DSH 会话发送跟进任务，支持立即插话生效（steer）或排队发送（queue），也可把已有排队消息转为立即插话。',
      category: 'write',
      parameters: schema({
        sessionId: sessionProperty,
        prompt: {
          type: 'string',
          description: '要发送的跟进或插话纠偏指令；仅将现有排队消息转为插话时可省略。必须完整保留用户补充的具体数值、档位、专有名词与纠偏要求，不要概括成笼统短句，也不要编造用户未提及的前提。',
        },
        mode: { type: 'string', enum: ['steer', 'queue'], description: '发送模式：steer（默认）在当前步骤后立即插话生效，queue 排在当前回合结束后执行。' },
        flushQueued: { type: 'boolean', description: '为 true 时，将该会话当前所有排队中的消息一并转为立即插话发送（steer）。' },
      }, ['sessionId']),
      resolveConfirmation: config => config.tools.writeConfirmation,
      summarizeCall: (args) => {
        const idText = text(args.sessionId, 100)
        const hasPrompt = typeof args.prompt === 'string' && args.prompt.trim() !== ''
        if (!hasPrompt && args.flushQueued === true) return `将会话 ${idText} 的排队消息转为插话发送`
        const verb = args.mode === 'queue' ? '排队发送' : '插话发送'
        return `向会话 ${idText} ${verb}：${text(args.prompt, 400)}`
      },
      execute: async (args, context) => {
        const rawSessionId = stringArg(args, 'sessionId')
        const prompt = optionalString(args, 'prompt')
        if (args.flushQueued !== undefined && typeof args.flushQueued !== 'boolean') {
          return error('invalid_arguments', 'flushQueued 必须为布尔值。')
        }
        const flushQueued = args.flushQueued === true
        if (args.mode !== undefined && args.mode !== 'steer' && args.mode !== 'queue') {
          return error('invalid_arguments', 'mode 只能为 steer 或 queue。')
        }
        const mode: 'steer' | 'queue' = args.mode === 'queue' ? 'queue' : 'steer'
        if (prompt === undefined && !flushQueued) {
          return error('invalid_arguments', '请提供 prompt 内容，或将 flushQueued 设为 true 以插话发送排队消息。')
        }
        const resolved = await resolveTargetSessionId(ctx, rawSessionId, context.signal)
        if (!resolved.ok) return resolved.result
        const sessionId = resolved.sessionId
        const service = controller(ctx)
        let steeredQueuedCount = 0
        await selfAction(context, sessionId, 'send_session_prompt', async () => {
          if (prompt !== undefined) {
            await service.prompt({
              sessionId: SessionId(sessionId),
              requestId: `ttds:${context.supervisorSessionId}:${context.callId}` as SessionRequestId,
              mode, content: [{ type: 'text', text: prompt }],
            }, context.signal)
          }
          if (flushQueued && typeof service.updateQueue === 'function') {
            const current = await service.state({ sessionId: SessionId(sessionId) }, context.signal)
            const queued = (current.queue ?? []).filter(item => item.placement === 'queued')
            for (const item of queued) {
              await service.updateQueue({
                sessionId: SessionId(sessionId),
                itemId: item.id,
                action: { kind: 'steer' },
              })
              steeredQueuedCount++
            }
          }
        })
        return { ok: true, data: {
          sessionId,
          accepted: true,
          mode,
          ...(flushQueued ? { steeredQueuedCount } : {}),
        } }
      },
    },
    {
      name: 'dsh_cancel_session_turn',
      description: '取消指定 DSH 会话正在执行的回合。',
      category: 'write',
      parameters: sessionSchema,
      resolveConfirmation: config => config.tools.writeConfirmation,
      summarizeCall: args => `取消会话 ${text(args.sessionId, 100)} 正在执行的回合。`,
      execute: async (args, context) => {
        const resolved = await resolveTargetSessionId(ctx, stringArg(args, 'sessionId'), context.signal)
        if (!resolved.ok) return resolved.result
        const sessionId = resolved.sessionId
        await selfAction(context, sessionId, 'cancel_session_turn', () => controller(ctx).cancel({ sessionId: SessionId(sessionId) }))
        return { ok: true, data: { sessionId, cancelled: true } }
      },
    },
    {
      name: 'dsh_switch_session_model',
      description: '切换指定 DSH 会话使用的模型和提供方。',
      category: 'write',
      parameters: schema({
        sessionId: sessionProperty,
        provider: { type: 'string', description: '模型提供方 ID。' },
        model: { type: 'string', description: '要切换到的模型 ID。' },
      }, ['sessionId', 'provider', 'model']),
      resolveConfirmation: config => config.tools.writeConfirmation,
      summarizeCall: args => `将会话 ${text(args.sessionId, 100)} 的模型切换为 ${text(args.provider, 80)}/${text(args.model, 100)}。`,
      execute: async (args, context) => {
        const rawSessionId = stringArg(args, 'sessionId')
        const provider = stringArg(args, 'provider')
        const model = stringArg(args, 'model')
        const resolved = await resolveTargetSessionId(ctx, rawSessionId, context.signal)
        if (!resolved.ok) return resolved.result
        const sessionId = resolved.sessionId
        await selfAction(context, sessionId, 'switch_session_model', () =>
          controller(ctx).selectModel({ sessionId: SessionId(sessionId), provider, model }))
        return { ok: true, data: { sessionId, provider, model } }
      },
    },
    {
      name: 'dsh_resolve_tool_approval',
      description: '批准或拒绝指定的 DSH 挂起审批项。',
      category: 'approval',
      parameters: schema({
        sessionId: sessionProperty,
        approvalId: { type: 'string', description: '待处理审批项 ID。' },
        approved: { type: 'boolean', description: '批准为 true，拒绝为 false。' },
      }, ['sessionId', 'approvalId', 'approved']),
      resolveConfirmation: () => 'ui',
      summarizeCall: args => `${args.approved === true ? '批准' : '拒绝'}会话 ${text(args.sessionId, 100)} 的审批 ${text(args.approvalId, 100)}。`,
      execute: async (args, context) => {
        const rawSessionId = stringArg(args, 'sessionId')
        const approvalId = stringArg(args, 'approvalId')
        if (typeof args.approved !== 'boolean') return error('invalid_arguments', 'approved 必须为布尔值。')
        const host = ctx.get('ttdsToolHost')
        if (host === undefined) return error('approval_service_unavailable', '未配置宿主审批桥接，请在 DSH 界面处理该审批。')
        let sessionId = rawSessionId.trim()
        if (ctx.get('sessionController') !== undefined) {
          const resolved = await resolveTargetSessionId(ctx, sessionId, context.signal)
          if (!resolved.ok) return resolved.result
          sessionId = resolved.sessionId
        }
        const approved = args.approved
        return await selfAction(context, sessionId, 'resolve_tool_approval', () =>
          host.resolveToolApproval({ sessionId, approvalId, approved }, context.signal))
      },
    },
  ]
}

/**
 * Register all eleven bridge tools with the calling fiber's cleanup ownership.
 * @param ctx - Context supplying public DSH services.
 * @param registry - Target voice tool registry.
 * @returns Idempotent disposer unregistering the complete built-in catalog.
 */
export function registerBuiltinVoiceTools(ctx: Context, registry: VoiceToolRegistryContract): () => void {
  const disposers: (() => void)[] = []
  const cleanup = (): void => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
  const effect = ctx.effect(() => cleanup)
  try {
    definitions(ctx).forEach((tool) => { disposers.push(registry.register(tool)) })
  } catch (caught: unknown) {
    cleanup()
    throw caught
  }
  return () => { void effect() }
}
