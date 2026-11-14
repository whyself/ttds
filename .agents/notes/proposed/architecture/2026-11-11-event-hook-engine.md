# Agent Note: 事件钩子与话轮礼让缓冲（Event Hook Engine）

Status: proposed

## 问题

在[全局语音总管架构](2026-11-11-design-philosophy.md)、[语音运行时适配层](2026-11-11-voice-runtime-adapter.md)与[DSH 桥接工具注册表](2026-11-11-voice-tool-registry.md)之上，后台 DSH 会话事件与前台非阻塞异步工具（边聊边干）的延迟完成信号都会请求语音总管主动接话，若直接将事件或手动 `response.create` 硬编码触发语音生成会引发四类核心问题：

- **对话余温期抢话、异步工具续答撞车与子代理洪泛**：用户刚听完上一句回复或正在与语音总管边聊边干时，若后台宿主事件或延迟回填的工具输出一就绪就立即裸发 `response.create`，或者未过滤子代理（`origin === 'subagent'`）内部轮次与已被同步等待的作业（`awaited === true`），会打断用户思绪、与正在进行的闲聊冲突，甚至在用户已主动追问过结果后再重复播报一遍。
- **过期提醒滞后播报、持续态误删与同步自操作回声**：在等待静默窗口或等待上游上下文确认期间，挂起的权限审批或用户提问可能已被用户在原生界面点击处理；定时提问答复入队后仍可能被丢弃（`agent/inbox/discarded`）重回待答；工具发起的取消或作业终止又会在方法返回前同步发出宿主事件。若缺乏前置观察、在途批次复核与副作用前预登记抑制，会导致播报过期弹窗或重复回声。
- **多事件批次预算溢出与非连接态误唤醒**：繁忙期积压多条事件或调小批次字符上限（`maxBatchChars`）时，无分批装箱与降级规则会撑爆单次注入预算；而处于 `'disconnected'`（客户端 `'off'`）时，后台钩子绝不能私自建立云端语音连接突然出声。
- **扩展钩子卸载排空竞态与观察器悬挂**：若引擎释放 `ConsumerLease` 前未等待全部钩子的异步清理与事件处理任务完成，会提前关闭底层运行时资源；挂载在宿主 waterfall 上的透传观察器卸载时必须无损脱离，绝不能取消宿主正在进行的原生审批或提问请求。

## 提案

提供公开钩子注册表服务 `ctx.ttdsHooks`（`VoiceHookRegistry`）与编排引擎 `EventHookEngine`：基于分配唯一 `registrationId` 并返回**可等待异步排空销毁函数**的 `register()` 接口管理内置与第三方钩子；默认内置 5 个 DSH 生命周期钩子及 1 个承接 `autoRespondOnToolOutput === false` 异步工具延迟续答的系统钩子 `ttds_tool_output_ready`；实施受 `quietGraceMs`（默认 `5000` 毫秒，`.volatile()`）约束的**话轮静默礼让缓冲**、**用户新轮次自然消费消解**与按预算贪心分批装箱，并通过双层循环排空协议管理生命周期。

## 注册表契约、依赖核查与事件门禁

### 双层装配、外层 Entry Fiber 热更新与宿主依赖核查

延续[语音运行时适配层](2026-11-11-voice-runtime-adapter.md)与[DSH 桥接工具注册表](2026-11-11-voice-tool-registry.md)的双层装配契约：

1. **顶层 Schema 原生校验与外层热更新投递**：导出的顶层 Schemastery `Config` schema 直接声明所有范围、整数步进与非空白字符串校验；加载期首步由 `resolveHooksConfig(config)` 同步复核。外层入口以自身 `entryFiber = ctx.fiber` 注册 `settings.configure({ auto: false }, entryFiber)` 与 `ctx.on('loader/volatile-update', ...)`，将最新不可变配置快照推送给注册表与引擎实例。
2. **严格单向依赖 DAG（`ttdsRuntime ⟵ ttdsHooks ⟵ ttdsTools`）与必需服务核查**：为保证下游 `ttdsTools` 在卸载排空期间始终可安全调用 `beginSelfAction`，钩子子插件不反向依赖 `ttdsTools`，仅声明 `inject = ['ttdsRuntime', 'sessions', 'agents', 'jobs', 'sessionProjections']`，并在启动结算边界（`appReady.onReady` 或声明 `inject = { loader: { await: true } }` 的受控核查子插件）显式枚举核查上述必需服务，缺失任一服务立即输出指明服务名的错误诊断并使启动依赖审计失败。

### `VoiceHookRegistry`（`ctx.ttdsHooks`）公开注册契约

内置钩子与第三方插件通过 `ctx.ttdsHooks.register(definition)` 注册钩子：每次注册分配全局单调递增、不可复用的 `registrationId`，返回**幂等异步排空销毁函数 `dispose: () => Promise<void>`**（同时提供 `registerWithCleanup(definition, releaseResource)`），并暴露自操作意图守卫 `beginSelfAction(spec)`。每项 `VoiceHookDefinition` 包含：

- `name: string`：钩子唯一标识，匹配 `^[a-z][a-z0-9_]{1,63}$`（注册期拒绝同名活跃或排空中条目覆盖）。
- `defaultEnabled?: boolean`：默认启用状态（缺省 `true`）。
- `defaultMode: 'speak' | 'silent_context'`：默认响应模式（主动口语播报，或仅静默注入上下文记忆而不触发发声）。
- `defaultDescription: string`：面向语音模型的默认处理说明（非空白且长度 `1..500` 字符）。
- `maxSummaryChars?: number`：单条候选事件结构化 `facts` 序列化字符上限（`128..4096` 安全整数，默认 `800`）。
- `setup: (sink: VoiceHookEventSink, context: VoiceHookSetupContext) => (() => void | Promise<void>)`：挂载事件监听器并返回清理函数，通过 `sink.publish`、`sink.pause`、`sink.resume` 与 `sink.retract` 驱动缓冲池状态流转。

### 运行期候选事件门禁（Runtime Event Gate）

`sink.publish(candidate)` 在接纳事件入缓冲池前同步校验：该 `registrationId` 仍活跃且当前 `enabled === true`；`dedupeKey` 与可选 `sessionId` 非空白、长度 `<= 128` 且不含 ASCII 控制字符；`facts` 为脱敏后的无损普通 JSON 对象且紧凑 JSON 长度不超过 `maxSummaryChars`。违规载荷记录宿主警告日志并失败闭合丢弃。

## 核心内置钩子目录与异步工具续答统一调度

### 顶层会话与实时性统一过滤准则

所有 DSH 会话级内置钩子统一执行两道前置过滤：（1）**子代理隔离**：检查 `session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0`，严格只采纳顶层普通会话（Root Session）事件；（2）**历史种子与销毁噪音隔离**：忽略 `event.seq < session.firstLiveSeq` 的冷恢复种子历史、合成边界 `turn/end`（`interrupted` / `forked`）以及因销毁触发的中止（`disposed`）。

### 5 个 DSH 生命周期钩子与 1 个异步工具续答系统钩子

审批与提问观察器统一显式声明 **`{ global: true, prepend: true }`** 置于宿主浏览器转发器之前，内部 `try/catch` 隔离观察逻辑，保证恰好调用一次 `return await next()` 并原样保留下游返回值或异常：

| 钩子名 | 默认模式 | 订阅源 | 触发条件、去重键与撤回/消解规则 |
|---|---|---|---|
| `ttds_tool_output_ready` | `'speak'` | `ttdsRuntime` 延迟工具回填事件 | 仅当适配器 `capabilities.autoRespondOnToolOutput === false`（如 Qwen-Audio 3.1 Realtime）且异步工具结果未走当轮无插话 Fast-Path 时触发，以 `tool_ready:<callId>` 入队：（a）若结果已原位写入当前活跃上游连接（`alreadyInUpstreamContext: true`，附带其 `conversation.item.created` 下行确认序号 `ackUpstreamSeq`），标记无需重复注入载荷、仅请求礼让 `response.create`；若属跨连接轮换桥接或在后续候选连接轮换中未被重放进新连接，均置 `alreadyInUpstreamContext: false` 并携带结构化结果摘要待注入新连接；（b）**严格协议因果序的自然消费消解**：对 `alreadyInUpstreamContext: true` 的条目，当且仅当在同一 `activeSessionId` 上观测到某个模型响应 `R` 满足 **`R.createdAtUpstreamSeq > ackUpstreamSeq`**（证明 `R` 创建时该工具输出确已在上游上下文中，杜绝全双工网络飞行交叉误消解），且 `R` **未被取消地正常完成 `response.done`（落盘非空口语输出）并经活跃客户端同 `turnGeneration` 下 `upToAudioSeq >= R.finalAudioSeq` 排空播完**（中途被打断截断绝不消解）时，该待续答条目立即自动 `retract` 消解，绝不重复播报。 |
| `dsh_turn_completed` | `'speak'` | `ctx.on('session/event', ..., { global: true })` | 顶层会话追加 `turn/end`（`completed` / `max-tokens`）时触发，提取末条助手消息紧凑摘要与 `workspace/changes` 标记，以 `turn:<sessionId>` 入队。 |
| `dsh_turn_failed` | `'speak'` | `ctx.on('session/event', ..., { global: true })` | 顶层会话追加异常 `turn/end`（`error` / `blocked` 或非用户、非销毁的异常 `aborted`）时以 `turn:<sessionId>` 高优入队。 |
| `dsh_approval_requested` | `'speak'` | `ctx.on('approval/request', ..., { global: true, prepend: true })` + `session/event` | 前置透传观察顶层会话审批，以 `approval:<sessionId>:<id>`（`stateful: true`）发布提醒；一旦 `await next()` 返回、`req.signal` 中止或收到 `approval/decided`，立即 `sink.retract` 撤回未发播报（若此前已注入上下文则补排 `'silent_context'` 结算事实）。 |
| `dsh_question_requested` | `'speak'` | `ctx.on('user-questions/request', ..., { global: true, prepend: true })` + `agent/inbox/*` + `session/event` | 前置透传观察顶层会话提问，以 `question:<sessionId>:<callId>`（`stateful: true`）发布提醒；转入后台 `'continued'` 态后收到 `agent/inbox/inserted` 仅 `pause` 暂停，若触发 `agent/inbox/discarded` 且投影仍活跃则 `resume` 恢复，直至正式写入 `user-question-reply` 或会话销毁才永久 `retract`。 |
| `dsh_job_settled` | `'silent_context'` | `ctx.jobs.events.subscribe({ owners: 'all' }, ...)` | 仅当 `event.type === 'settled'`、`!event.awaited`、`event.cause !== 'teardown'` 且非子代理会话时，以 `job:<jobId>` 记录后台长作业终态。 |

### 副作用前预登记的自操作回声抑制（`beginSelfAction`）

针对 `jobController.kill()`、`sessionController.cancel()` 等在方法返回前同步发出宿主事件的操作，工具派发器在发起宿主调用前调用 `const guard = ctx.ttdsHooks.beginSelfAction({ targetKey, expectedKind, ttlMs })`：调用抛错时 `guard.rollback()` 移除预登记印记；调用成功时 `guard.commit()` 抑制匹配的同步回声并对缓冲池及在途批次中同 `targetKey` 候选提醒执行追溯撤回或降级。

## 话轮礼让缓冲、在途撤回拦截与有界分批装箱

### 非连接态静默保护

当 `VoiceRuntimeService` 处于未连接态（客户端 `'off'`）时，钩子引擎绝不私自建立云端语音连接：瞬态完成事件不予播报，有状态的未决审批与提问仅维护有界内存表。

### 按预算贪心装箱、无冗余续答触发与 `quietGraceMs` 礼让调度

当实时语音会话处于已连接态时，引擎按以下确定性状态机运行：

1. **有界缓冲池与满容淘汰**：缓冲池按 `dedupeKey` 原地更新并分配单调递增 `entryVersion`；达到 `maxBufferedEvents`（默认 `24`）时优先淘汰最早的普通完成事件，若全为高优项则淘汰最旧项并累加 `overflowDroppedCount`。
2. **按 `maxBatchChars` 的贪心分批装箱与零冗余原位触发**：
   - 若当前就绪待发集合仅包含 `alreadyInUpstreamContext: true` 的 `ttds_tool_output_ready` 条目（对应 `function_call_output` 已存在于当前上游连接上下文），无需额外写入 `injectContext` 消息，礼让窗口到期且复核无新用户输入后直接请求运行时触发单次 `response.create`。
   - 若包含需要写入上下文的宿主钩子事件或跨轮换桥接工具结果，按优先级（待决审批/提问 > 异步工具续答 > 轮次失败 > 轮次完成 > 后台作业）与完整序列化长度 `JSON.stringify(envelope).length <= maxBatchChars` 贪心装箱，剩余条目留存下一礼让周期；单条超预算时先裁剪内联 `description`，仍超限时退化为长度恒 `<= 242` 字符的零转义十六进制摘要引用信封，确保队列永不死锁。
3. **纯 `'silent_context'` 批次的无声写入**：当未暂停池中仅存在 `'silent_context'` 条目且运行时满足话轮静默态 `isSpeechQuiescent` 时，装箱发送 `injectContext({ mode: 'silent_context', batch })` 等待确认落盘，不触发 `response.create`。
4. **含 `'speak'` 条目的礼让等待、用户退让与在途逐条有效性复核**：
   - **启动条件**：当存在未暂停的 `'speak'` 条目（含待续答异步工具与宿主提醒）且 `VoiceRuntimeService` 满足话轮静默态 `isSpeechQuiescent`（即使仍有其他慢速异步工具在后台 `'running'` 也不阻塞已就绪项计时）时，按 `delayMs = Math.max(0, lastInteractionAt + quietGraceMs - now)`（默认 `5000` 毫秒）挂载唯一礼让定时器。
   - **在途确认期逐条有效性复核**：定时器到期写入上下文并等待 `conversation.item.created` 与日志落盘期间，发出 `response.create` 前执行逐条复核：（a）若期间用户准入首帧新音频（`inputActivitySeq` 递增）或 `sendText`（`turnGeneration` 推进），立即放弃本次 `response.create`；（b）若无新用户输入，但批次内任意条目在等待期间已 `retract`、`pause`、被热更新禁用或注销，严禁直接对含陈旧条目的原批次发 `response.create`——无剩余活跃 `'speak'` 项则放弃生成，仍有剩余有效项则先在同一槽位追加确认 `{ kind: 'hook_batch_patch', invalidatedSeqs, speakOnlySeqs }` 更正条目后才发出单次 `response.create`。

## 配置 Schema 与完备双层异步排空

- **配置结构与热更新**：底层包含 `Config.hooksPolicy`（`quietGraceMs` 默认 `5000`、`maxBufferedEvents` 默认 `24`、`maxBatchChars` 默认 `3200`）与 `Config.hooks` 覆盖字典，全部标记 `.volatile()` 并接入「插件」二级详情页（`plugins.bundle.config`）热更新链路；详情页仅向用户展示 `quietGraceMs` 与 5 个宿主生命周期钩子的三档响应策略（`speak` / `silent_context` / 已禁用），`ttds_tool_output_ready` 系统续答钩子保持后台常驻，`maxBufferedEvents`、`maxBatchChars` 与单条 `description` 覆写仅保留在 `cordis.patch.yml` 配置层。
- **Cordis 所有权、生成器生命周期编排、无损脱离与双层循环排空闭环**：
  - **零模块级单例与单个生成器 `ctx.effect` 逆序编排**：钩子注册表、缓冲池、自操作守卫表、消费者租约表、礼让定时器与在途注入跟踪全部归属实例；通过单个 `ctx.effect(function* () { ... yield ctx.provide('ttdsHooks', registry) })` 逆序编排服务撤回、下游 `ttdsTools` 租约等待与引擎自身清理。
  - **透传 waterfall 观察器的非破坏脱离**：挂起在 `await next()` 的观察器遭遇卸载时仅置 `detached = true` 立即解除卸载阻塞，绝不 abort 宿主原始 `req.signal`。
  - **双层循环排空（含销毁期网络等待短路）**：引擎等待下游消费者租约（如 `VoiceToolDispatcher`）释放后，或在收到上游 `ttdsRuntime` 的 `ConsumerLease.stop()` 时，同步拒绝新事件、清除定时器并遍历调用全部钩子的幂等 `dispose()`，以 `while` 循环等待**全部钩子清理 Promise、在途异步事件提取与本地 `SupervisorSessionJournal` 落盘任务**（整体销毁 `disposing` 时上游网络等待由 `ttdsRuntime` 立即短路）共同稳定为空后，最后调用 `ttdsRuntime` 租约的 `lease.release()`。

## 考虑过的替代方案

**把 `autoRespondOnToolOutput === false` 下的手动 `response.create` 留在运行时里与事件钩子分开独立调度。** 落选原因：双轨独立触发 `response.create` 会导致延迟工具完成播报与后台宿主事件播报互相抢话或前后连发两次语音，也无法在用户边聊边干已主动追问过结果时自动消解冗余续答；统一收归 `EventHookEngine` 的话轮静默礼让缓冲池才能一次性合并发声并支持自然消费消解。

**仅用 `{ global: true }` 而不加 `{ prepend: true }` 监听 `approval/request` 与 `user-questions/request`。** 落选原因：排在 `api-remotes` 浏览器转发器之后的监听器在客户端回答后不会被调用，必须配对 `prepend: true` 并保证异常安全地单次调用 `next()`。

**在 `user-questions` 答复入队时直接永久撤回提醒，或在工具方法返回后才登记自操作抑制。** 落选原因：入队答复可能因 `agent/inbox/discarded` 回到 `'continued'` 待答态，而作业终止等操作在返回前即同步派发事件，唯有“入队暂停+丢弃恢复”与副作用前 `beginSelfAction` 才能闭环。

## 验收标准

- 通过伪造时钟、Mock 语音运行时与真实 Cordis 事件流完成确定性单元测试：
  - **异步工具礼让续答与自然消费消解测试**：（a）模拟边聊边干下异步工具延迟回填完成，验证进入 `ttds_tool_output_ready` 缓冲并在静默满 `5000ms` 后与同窗口完成的 `dsh_turn_completed` 合并触发**唯一一次** `response.create`；（b）模拟异步工具回填落盘后、礼让定时器到期前，用户主动开口提问完成一轮新对话，验证已原位写入的 `ttds_tool_output_ready` 自动消解，后续静默不再重复触发冗余播报；（c）验证仅含已原位写入 `function_call_output` 的续答信号直接触发 `response.create` 而不重复注入 JSON 副本。
  - **前置观察、在途撤回更正与低预算装箱测试**：验证 `{ global: true, prepend: true }` 100% 捕获开始与结算、混合批次部分撤回先写 `hook_batch_patch` 更正再生成、`continued` 提问丢弃恢复、`beginSelfAction` 同步回声抑制，以及 `maxBatchChars = 500` 极端场景下贪心装箱与 `<= 242` 字符降级信封不超限。
  - **Cordis P0 双层完整排空与非破坏脱离测试**：验证全部钩子异步清理与日志任务归零后才释放 `ConsumerLease`，且挂起审批期间卸载插件不中断宿主原始请求。

## 风险

- **礼让窗口对后台提醒与延迟工具汇报的等待时间**：默认 `5000ms` 静默礼让意味着边聊边干延迟完成的后台工具与宿主提醒会在对话停顿满 5 秒后才主动接话（当轮未插话的快速查询仍走运行时 Fast-Path 零等待直通，且旁侧无边框流式事件流毫秒级实时显示已完成状态）。
- **小预算分批下的多轮拆分**：极端小预算且并发爆发大量高优事件时，单批装不下的条目会留待下一静默周期继续播报；默认 `3200` 字符预算足以覆盖日常并发汇总。
