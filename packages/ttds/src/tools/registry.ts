/** Instance-owned voice tool dispatch, UI confirmation tickets, and lifecycle cancellation. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assertNever,
  type VoiceAdapterToolCall,
  type VoicePendingUiConfirmationView,
  type VoiceRuntimeServiceContract,
  type VoiceToolDefinition,
  type VoiceToolExecutionContext,
  type VoiceToolJsonSchema,
  type VoiceToolRegistryContract,
  type VoiceToolResult,
  type VoiceUpstreamToolSpec,
} from '../shared/index.ts'

interface UiTicket {
  readonly tool: VoiceToolDefinition
  readonly view: VoicePendingUiConfirmationView
  readonly settle: (approved: boolean) => void
}

interface InFlight {
  readonly tool: VoiceToolDefinition | undefined
  readonly controller: AbortController
  readonly task: Promise<void>
}

function failure(code: string, message: string): VoiceToolResult {
  return { ok: false, error: { code, message } }
}

function parseArgs(json: string, schema: VoiceToolJsonSchema): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具参数必须是 JSON 对象。')
  const args = value as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Error(`缺少参数：${key}`)
  }
  for (const [key, item] of Object.entries(args)) {
    const property = schema.properties[key]
    if (property === undefined) {
      if (schema.additionalProperties === false) throw new Error(`未知参数：${key}`)
      continue
    }
    const matches = property.type === 'integer' ? Number.isSafeInteger(item)
      : property.type === 'array' ? Array.isArray(item)
        : property.type === 'object' ? typeof item === 'object' && item !== null && !Array.isArray(item)
          : typeof item === property.type
    if (!matches || (property.enum !== undefined && !property.enum.includes(String(item)))) {
      throw new Error(`参数类型或取值错误：${key}`)
    }
  }
  return args
}

async function withAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new Error('工具调用已取消或超时。')) }
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([task, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Registers tools and dispatches calls without blocking the foreground voice conversation. */
export class VoiceToolRegistry implements VoiceToolRegistryContract {
  private readonly tools = new Map<string, VoiceToolDefinition>()
  private readonly ui = new Map<string, UiTicket>()
  private readonly inFlight = new Set<InFlight>()
  private disposed = false
  private cancelling = false

  /**
   * Publish the registry with cleanup owned by the calling Cordis fiber.
   * @param ctx - Context providing the runtime and optional hook service.
   */
  constructor(private readonly ctx: Context) {
    const provision = (): (() => void) => ctx.provide('ttdsTools', this)
    const closeAdmission = (): void => { this.disposed = true }
    const cleanup = async (): Promise<void> => {
      closeAdmission()
      await this.cancelAll('工具注册表已卸载。')
      this.tools.clear()
    }
    ctx.effect(function* () {
      yield cleanup
      yield provision()
      yield closeAdmission
    })
  }

  /**
   * Register one tool; duplicates, missing mutation summaries, and automatic approvals throw.
   * @param tool - Definition owned by the caller until its disposer runs.
   * @returns Idempotent disposer cancelling calls and invalidating confirmation tickets.
   */
  register(tool: VoiceToolDefinition): () => void {
    if (this.disposed) throw new Error('工具注册表已卸载。')
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`)
    if ((tool.category === 'write' || tool.category === 'approval') && tool.summarizeCall === undefined) {
      throw new Error(`工具 ${tool.name} 必须提供 summarizeCall。`)
    }
    const mode = tool.resolveConfirmation(this.ctx.ttdsRuntime.getConfig())
    if (mode !== 'auto' && tool.summarizeCall === undefined) throw new Error(`工具 ${tool.name} 缺少确认摘要。`)
    if (tool.category === 'approval' && mode === 'auto') throw new Error(`审批工具 ${tool.name} 禁止自动确认。`)
    this.tools.set(tool.name, tool)
    this.refresh()
    return () => {
      if (this.tools.get(tool.name) !== tool) return
      this.tools.delete(tool.name)
      for (const ticket of this.ui.values()) if (ticket.tool === tool) ticket.settle(false)
      for (const flight of this.inFlight) if (flight.tool === tool) flight.controller.abort('工具已注销。')
      if (!this.disposed) this.refresh()
    }
  }

  /**
   * Read the catalog with current enablement filters.
   * @returns Detached upstream function specifications.
   */
  listUpstreamSpecs(): readonly VoiceUpstreamToolSpec[] {
    const config = this.ctx.ttdsRuntime.getConfig()
    return [...this.tools.values()].filter(tool =>
      (tool.category !== 'read' || config.tools.enableReadTools)
      && (tool.category !== 'search' || config.tools.enableSearchTool),
    ).map(tool => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }

  /**
   * Read registered names, including tools currently hidden by configuration.
   * @returns Names in registration order.
   */
  listToolNames(): readonly string[] {
    return [...this.tools.keys()]
  }

  /**
   * Admit independent leased calls and return before their asynchronous work settles.
   * @param calls - Upstream function calls paired by callId.
   */
  dispatchToolCalls(calls: readonly VoiceAdapterToolCall[]): void {
    if (this.disposed || this.cancelling) return
    const runtime = this.ctx.ttdsRuntime
    for (const call of calls) {
      const lease = runtime.acquireLease()
      if (lease === null) continue
      const tool = this.tools.get(call.name)
      const controller = new AbortController()
      const signal = AbortSignal.any([
        controller.signal,
        lease.signal,
        AbortSignal.timeout(runtime.getConfig().tools.toolTimeoutMs),
      ])
      // Defer execution until the task is tracked, including synchronous failures at admission.
      const task = Promise.resolve().then(() => this.run(call, tool, runtime, signal)).catch(async (error: unknown) => {
        await runtime.appendJournal('error', { callId: call.callId, message: String(error) })
      }).finally(() => {
        this.inFlight.delete(flight)
        lease.release()
      })
      const flight: InFlight = { tool, controller, task }
      this.inFlight.add(flight)
    }
  }

  /**
   * Settle one pending UI decision; consumed or unknown IDs return false.
   * @param confirmationId - Confirmation card identifier.
   * @param approved - Explicit user decision.
   * @returns Whether a matching pending card was consumed.
   */
  resolveUiConfirmation(confirmationId: string, approved: boolean): Promise<boolean> {
    const ticket = this.ui.get(confirmationId)
    if (ticket === undefined) return Promise.resolve(false)
    this.ui.delete(confirmationId)
    this.publishPending(this.ctx.ttdsRuntime)
    ticket.settle(approved)
    return Promise.resolve(true)
  }

  /**
   * Abort admitted calls, discard tickets, and wait for handlers and result cleanup.
   * @param reason - Session teardown or rotation reason.
   * @returns Completion after every admitted task releases its lease.
   */
  async cancelAll(reason: string): Promise<void> {
    this.cancelling = true
    for (const flight of this.inFlight) flight.controller.abort(reason)
    for (const ticket of this.ui.values()) ticket.settle(false)
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight].map(flight => flight.task))
    this.cancelling = false
  }

  private refresh(): void {
    void this.ctx.get('ttdsRuntime')?.refreshTools()
  }

  private async run(
    call: VoiceAdapterToolCall,
    tool: VoiceToolDefinition | undefined,
    runtime: VoiceRuntimeServiceContract,
    signal: AbortSignal,
  ): Promise<void> {
    runtime.publishFeedItem({ kind: 'tool_call', text: call.name, detail: call.callId })
    await runtime.appendJournal('tool.call', { callId: call.callId, toolName: call.name, argumentsJson: call.argumentsJson })
    let result: VoiceToolResult
    try {
      result = await this.invoke(call, tool, runtime, signal)
    } catch (error: unknown) {
      result = failure(signal.aborted ? 'tool_cancelled' : 'tool_failed', String(error))
    }
    await runtime.submitToolResult(call.callId, call.name, result)
    if (!signal.aborted) {
      this.ctx.get('ttdsHooks')?.enqueue({
        hookId: 'ttds_tool_output_ready',
        priority: 'normal',
        dedupeKey: `tool:${call.callId}`,
        summary: `${call.name} 的结果已就绪。`,
        metadata: { callId: call.callId, toolName: call.name, ok: result.ok },
      })
    }
  }

  private async invoke(
    call: VoiceAdapterToolCall,
    tool: VoiceToolDefinition | undefined,
    runtime: VoiceRuntimeServiceContract,
    signal: AbortSignal,
  ): Promise<VoiceToolResult> {
    signal.throwIfAborted()
    if (tool === undefined || this.tools.get(call.name) !== tool) return failure('tool_unavailable', '工具不存在或已注销。')
    const config = runtime.getConfig()
    if ((tool.category === 'read' && !config.tools.enableReadTools)
      || (tool.category === 'search' && !config.tools.enableSearchTool)) return failure('tool_disabled', '该工具已停用。')
    let args: Readonly<Record<string, unknown>>
    try {
      args = parseArgs(call.argumentsJson, tool.parameters)
    } catch (error: unknown) {
      return failure('invalid_arguments', String(error))
    }
    const mode = tool.resolveConfirmation(config)
    if (tool.category === 'approval' && mode === 'auto') return failure('confirmation_required', '审批工具禁止自动执行。')
    switch (mode) {
      case 'auto':
        break
      case 'ui':
        if (!await this.confirmUi(tool, args, runtime, signal)) return failure('confirmation_cancelled', '用户已在界面取消该操作。')
        break
      default:
        assertNever(mode)
    }
    signal.throwIfAborted()
    if (this.tools.get(call.name) !== tool) return failure('tool_unavailable', '工具已注销。')
    if (tool.resolveConfirmation(runtime.getConfig()) !== mode) {
      return failure('confirmation_policy_changed', '确认策略已改变，请重新发起操作。')
    }
    const latest = runtime.getConfig().tools
    if ((tool.category === 'read' && !latest.enableReadTools) || (tool.category === 'search' && !latest.enableSearchTool)) {
      return failure('tool_disabled', '该工具已停用。')
    }
    const supervisorSessionId = runtime.getSnapshot().supervisorSessionId
    if (supervisorSessionId === null) return failure('session_unavailable', '语音会话未连接。')
    const context: VoiceToolExecutionContext = {
      signal,
      supervisorSessionId,
      callId: call.callId,
      beginSelfAction: (sessionId, actionKind) => {
        const hooks = this.ctx.get('ttdsHooks')
        if (hooks === undefined) throw new Error('缺少 ttdsHooks，无法建立自操作抑制。')
        return hooks.beginSelfAction(sessionId, actionKind)
      },
    }
    const result = await tool.execute(args, context)
    signal.throwIfAborted()
    return result
  }

  private async confirmUi(
    tool: VoiceToolDefinition,
    args: Readonly<Record<string, unknown>>,
    runtime: VoiceRuntimeServiceContract,
    signal: AbortSignal,
  ): Promise<boolean> {
    const summary = tool.summarizeCall?.(args)
    if (summary === undefined) throw new Error(`工具 ${tool.name} 缺少确认摘要。`)
    const confirmationId = randomUUID()
    const view: VoicePendingUiConfirmationView = {
      confirmationId, toolName: tool.name, summary, mode: 'ui', createdAtMs: Date.now(),
    }
    const decision = new Promise<boolean>((settle) => { this.ui.set(confirmationId, { tool, view, settle }) })
    this.publishPending(runtime)
    runtime.publishFeedItem({ kind: 'confirmation', text: summary, confirmation: view })
    let approved: boolean
    try {
      approved = await withAbort(decision, signal)
    } finally {
      this.ui.delete(confirmationId)
      this.publishPending(runtime)
    }
    await runtime.appendJournal('tool.confirmation', { confirmationId, toolName: tool.name, approved })
    return approved
  }

  private publishPending(runtime: VoiceRuntimeServiceContract): void {
    runtime.setPendingConfirmations([...this.ui.values()].map(ticket => ticket.view))
  }
}
