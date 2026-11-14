# Agent Note: DSH 桥接工具注册表（Voice Tool Registry）

Status: proposed

## 问题

在[全局语音总管架构](2026-11-11-design-philosophy.md)与[语音运行时适配层](2026-11-11-voice-runtime-adapter.md)之上，实时语音模型需要通过工具调用查看 DSH 工作台内容并协助用户操作 DSH，直接暴露原始宿主接口、采用同步阻塞调用或缺乏确定性门禁会导致四类核心问题：

- **同步阻塞调用打断实时闲聊，或语音插话误杀后台工具**：文件检索、多会话状态拉取与跨端交互对账耗时可达数秒；若工具执行期间冻结前台对话，或把用户随口插话（`turnGeneration` 推进）直接绑上工具的 `AbortSignal`，就会破坏 Qwen-Audio 3.1 Realtime 原生支持的“边聊边干”体验并造成半截失败。
- **上下文倾倒、盲目截断与原地死循环**：DSH 会话轨迹、文件改动 Diff 与工作区源码体量远超实时语音模型的最佳注意力窗口；直接返回整页原始事件流会迅速撑爆上下文并诱发幻觉，外层裸字符串截断会切碎 JSON，而缺乏游标推进校验的分页返回又可能在超长单条内容上原地踏步导致无限重试。
- **操作类调用的幻觉越权与跨端交互割裂**：端到端语音模型可能误判用户意图或幻觉发起写操作，需要确定性的界面点击确认机制；DSH 的权限审批（`approval/request`）与前台用户提问（`user-questions/request`）在浏览器 `ctx.uiSession` 中渲染原生卡片，Host 私自抢答 waterfall 会留下幽灵卡片，客户端 `answer()` 也不等同于 Host 已权威落定；此外，若单工具注销不等待在途 `execute()` 异步收尾完成，扩展插件卸载时会提前释放仍在被访问的外部资源。

## 提案

提供 Cordis 工具注册表服务 `ctx.ttdsTools`（`VoiceToolRegistry`）及非阻塞异步派发器 `VoiceToolDispatcher`：通过分配唯一 `registrationId` 并返回**可等待异步排空销毁函数**的 `register()` 接口管理内置与第三方扩展工具；采用**与前台话轮打断解耦的非阻塞后台执行**支撑边聊边干；实施**注册期 Schema 核验**与**含严格游标推进校验的运行期有界输出门禁**；内置 11 个精确对接 `@deepseek-ai/*` 公开接口的核心工具（含对接 `ctx.web` 的联网检索工具 `dsh_search`）；提供确定性的两档安全门禁（`'auto' | 'ui'`）及外层 entry fiber 驱动的 `.volatile()` 热同步闭环。

## 注册表服务契约与双阶段确定性门禁

### 依赖装配、外层 Entry Fiber 热更新与宿主服务核查

延续[语音运行时适配层](2026-11-11-voice-runtime-adapter.md)的双层装配与外层配置所有权契约：

1. **顶层 Schema 拦截与外层热更新投递**：所有配置校验约束使用 Schemastery 原生公开校验器声明在导出的顶层 `Config` schema 固定路径上，由宿主 Loader、`ctx.settings` 与 `ConfigEditor` 在持久化及提交 `Volatile<T>` 引用前直接拦截非法值；加载期首步由外层 `resolveToolsConfig(config)` 同步复核。外层入口以自身 `entryFiber = ctx.fiber` 注册 `settings.configure({ auto: false }, entryFiber)` 与 `ctx.on('loader/volatile-update', ...)`，将最新不可变配置快照推送给注册表与派发器实例。
2. **严格单向依赖 DAG（`ttdsRuntime ⟵ ttdsHooks ⟵ ttdsTools`）与必需服务核查**：内层子插件显式声明 `inject = ['ttdsRuntime', 'ttdsHooks', 'sessionController', 'jobController', 'workspaceFiles', 'workspaceChanges', 'userQuestions', 'jobs', 'sessions', 'agents', 'sandboxPolicy']`（按需读取可选公开服务 `ctx.get('sessionQuery')` 与 `@deepseek-ai/dsh-web` 提供的 `ctx.get('web')`）；在启动结算边界（`appReady.onReady` 或声明 `inject = { loader: { await: true } }` 的核查子插件）显式枚举核查上述 11 项必需服务，缺失任一服务时输出指明服务名的错误诊断并使启动依赖审计失败。

### `VoiceToolRegistry`（`ctx.ttdsTools`）公开注册与非阻塞执行契约

内置工具与外部插件通过 `ctx.ttdsTools.register(definition)` 注册工具：每次成功注册分配全局单调递增、不可复用的 `registrationId`，并返回**幂等异步排空销毁函数 `dispose: () => Promise<void>`**（同时提供 `registerWithCleanup(definition, releaseResource)` 顺序串联排空与资源释放）。每项 `VoiceToolDefinition<TParams, TResult>` 包含：

- `name: string`：工具唯一标识，必须匹配 `^[a-z][a-z0-9_]{1,63}$`。
- `defaultDescription: string`：面向模型的默认行为说明，遵循[面向模型的体验设计](../../../skills/ttds-agent-experience/SKILL.md)只陈述工具用途与返回结构，不重复参数级约束。
- `parameters: z<TParams>`：顶层为 `z.object(...)` 的 Schemastery 入参定义。
- `defaultConfirmation: 'auto' | 'ui'`：默认调用安全确认档位。
- `maxOutputChars?: number`：可选单次序列化 JSON 输出字符上限（缺省取 `Config.toolsPolicy.defaultMaxOutputChars`）。
- `drillDownParams?: readonly string[]`：可选下钻游标/分页参数名列表，声明该工具属于有界可下钻工具。
- `summarize?: (args: TParams) => string`：可选的人类可读操作摘要生成函数，用于 `'ui'` 确认卡片展示。
- `execute: (args: TParams, context: VoiceToolExecutionContext) => Promise<TResult>`：**非阻塞异步执行体**。其 `context.signal` 绑定会话挂断、该 `registrationId` 注销/禁用及插件卸载——**用户在前台开口插话、打断当前语音播报或发送新文字推进 `turnGeneration` 时，绝不中止已在后台运行的 `execute()`**；执行结果就绪后按原 `callId` 独立异步回填至运行时，并由运行时与[事件钩子引擎](2026-11-11-event-hook-engine.md)按是否发生边聊边干决定快速直通续答或进入静默礼让缓冲。

### 注册期确定性门禁（Registration Gate）

`register(definition)` 在接纳工具前同步执行四项静态契约校验，任一违规立即抛错拒绝注册：

1. **命名与唯一性**：`name` 格式合法且当前注册表中不存在同名活跃或排空中（`draining`）条目（旧条目 `await dispose()` 彻底排空移除后才允许重注册同名工具并获得全新 `registrationId`）。
2. **基础元数据与保留字段隔离**：`defaultDescription.trim()` 非空，`defaultConfirmation` 属于封闭二元联合（`'auto' | 'ui'`），`parameters` 为顶层 `z.object` 节点。
3. **输出预算边界**：若指定 `maxOutputChars`，必须为 `128..16384` 范围内的安全整数。
4. **下钻参数存在性核验**：若指定 `drillDownParams`，必须为非空且无重复项的字符串数组，且每个参数名均必须真实存在于 `parameters.dict` 顶层属性定义中。

### 运行期输出与严格可推进下钻门禁（Runtime Gate）

工具 `execute()` 返回结果后、送交 `VoiceRuntimeService` 回填模型前，派发器对照该调用绑定的目录快照统一执行运行期校验：

1. **无损 JSON 结构校验**：返回值必须为普通无损 JSON 对象（拒绝顶层原始标量、`BigInt`、`NaN`/`Infinity`、函数或循环引用）。
2. **`truncated: true` 触发式合法性与严格推进校验**：当返回对象包含 `truncated === true` 时：
   - 该工具定义必须声明过 `drillDownParams`；
   - 返回对象必须同时携带非空普通对象 `nextArgs: Record<string, unknown>`；
   - `Object.keys(nextArgs)` 必须全部属于 `parameters.dict` 已声明属性，至少包含一个 `drillDownParams` 中的参数且其值非 `undefined`；
   - 将 `{ ...validatedArgs, ...nextArgs }` 代入该工具自身的 `parameters` schema 执行校验必须通过；
   - **严格推进校验（Progress Check）**：规范化对比下，`drillDownParams` 中至少有一个游标或偏移参数在 `nextArgs` 中的值与本次 `validatedArgs` 的生效值**严格不等**（禁止原样回传相同游标造成无限翻页循环）。
3. **字符上限与单条超限有界切片契约**：序列化后的紧凑 JSON 字符串长度不得超过生效 `maxOutputChars`。当单条消息、单个补丁块或单行超长源码本身超过单次预算时，内置工具通过字符窗口游标（`charOffset` 推进至更大的 `nextCharOffset`，标注 `partialItem: true`）返回有界片段并推进游标。
4. **违规失败闭合（Fail-Closed）**：任何违反运行期门禁的返回均不做裸字符截断，记录指明工具名与 `registrationId` 的宿主警告日志，并向模型回填有界结构化错误 `{ ok: false, code: 'TOOL_OUTPUT_CONTRACT_VIOLATION', message }` 正常完成该 `callId` 回填。

## 两档调用安全门禁（`confirmation`）与边聊边确认

工具调用进入派发器时读取绑定快照与实时注册表的较严确认档位，并在任何异步等待结束后、踏入 `execute()` 副作用执行点之前**同步二次核验**：（a）该 `registrationId` 仍处于活跃态；（b）当前最新配置下 `enabled === true`；（c）已满足当前最新生效的 `confirmation` 等级（以自有 `assertNever` 穷尽分支）：

1. **`'auto'`（自动放行）**：适用于只读查看、纯视图导航与已由用户明确切至自动放行的写操作。入参校验与二次核验通过后直接异步启动 `execute()`。
2. **`'ui'`（支持边聊边点确认的客户端纪元弹窗门禁）**：作为会话写操作默认档位与审批操作固定档位，派发器生成唯一确认编号与可读摘要，向浏览器舞台控制坞与跨页面悬浮微球下发待确认项；挂起等待用户明确允许或拒绝，期间用户可继续语音或文字询问操作细节而不会误关确认卡片；收到用户允许后执行 `execute()`，拒绝、超时或连接关闭均取消执行并返回结构化错误。

## 核心内置工具目录与 DSH 公开接口精确映射

主包默认注册以下 11 个核心语音工具，均支持非阻塞异步执行并严格匹配 `@deepseek-ai/*` 公开接口：

| 工具名 | 默认档位 | 下钻参数（`drillDownParams`） | 职责与 DSH 公开服务精确映射 |
|---|---|---|---|
| `dsh_list_sessions` | `'auto'` | `['cursor', 'limit']` | 调用 `ctx.sessionController.list({}, signal)` 与逐项 `ctx.sessionController.state({ sessionId }, signal)` 返回会话摘要（含客户端上报的 `focusedSessionId`），冷态只读不唤醒 Agent；传入 `query` 时先查 `ctx.get('sessionQuery')`，未挂载或返回 `SESSION_QUERY_SEARCH_DISABLED` 时确定性回退标题与 `cwd` 匹配并标注 `searchScope: 'metadata_only'`。 |
| `dsh_read_session_messages` | `'auto'` | `['beforeSeq', 'maxMessages', 'charOffset']` | 调用 `ctx.sessionController.events({ address: { kind: 'session', sessionId }, beforeSeq, maxMessages }, signal)` 冷安全逆序分页读取消息摘要；单条超长消息按 `charOffset` 分片推进。 |
| `dsh_inspect_workspace_changes` | `'auto'` | `['seq', 'fileIndex', 'hunkOffset', 'charOffset']` | 调用 `ctx.workspaceChanges.summary(sessionId, seq)` 与 `ctx.workspaceChanges.diff(sessionId, seq, fileIndex, signal)` 分段查看补丁；非活跃冷会话返回 `undefined` 时明确回填 `changes_unavailable_for_inactive_session`。 |
| `dsh_read_workspace_file` | `'auto'` | `['offset', 'limit', 'charOffset']` | 按会话 `header` 解析 `WorkspaceFileScope`（回退 `sandboxPolicy.workspaceRoot`），调用 `ctx.workspaceFiles.read`、`list` 或 `search`；超长单行通过 `charOffset` 分片推进。 |
| `dsh_list_pending_interactions` | `'auto'` | — | 聚合 `ctx.sessionController.state`、`projections`（`userQuestions.active`）、未决 `approval/asked`、`ctx.jobs.list(sessionId)` 及客户端 `ctx.uiSession.sessionStatus.getSnapshot()`，标注 `coverage: 'top_per_session_plus_host_projections'`。 |
| `dsh_search` | `'auto'` | — | 读取可选公开服务 `ctx.get('web')`（`@deepseek-ai/dsh-web`），对 `1..5` 条去重非空 `queries` 并发调用 `web.search({ query, maxResults }, signal)`（复用宿主已配置的搜索提供方，替代关闭的模型黑盒原生搜索），合并去重 `sources`（含 `url`、`title`、有界压缩 `summary ?? snippet` 与 `publishedAt`）并附带外部不可信网页防注入标记 `untrustedExternalContent: true`；服务未挂载或抛出 `WebError` 时确定性回填 `{ ok: false, code: error.code ?? 'WEB_SEARCH_UNAVAILABLE', message }`。 |
| `dsh_focus_session` | `'auto'` | — | 校验目标会话存在后，经客户端委托通知当前 `(activeOwnerConnId, ownerEpoch)` 窗口切换焦点会话。 |
| `dsh_create_session` | `'ui'` | — | 调用 `ctx.sessionController.create({ cwd, agentPreset })` 创建新会话；若附带初始 `prompt` 则以确定性 `requestId` 异步投递后台队列，不阻塞语音总管前台会话。 |
| `dsh_send_prompt` | `'ui'` | — | 调用 `ctx.sessionController.prompt({ sessionId, requestId, mode, content: [{ type: 'text', text }] }, signal)` 投递指令（`mode: 'queue' | 'steer'`）；`requestId` 由 `(logicalConversationId, callId)` 确定性派生。 |
| `dsh_control_execution` | `'ui'` | — | 按 `action: 'cancel_turn' | 'kill_job'` 调用 `ctx.sessionController.cancel` 或 `ctx.jobController.kill`（调用前预挂 `beginSelfAction` 抑制同步回声）。 |
| `dsh_resolve_interaction` | `'ui'` | — | 结算待处理权限审批或用户提问，显式区分客户端提交与 Host 权威落定（见下节）。 |

### 客户端委托纪元围栏与交互权威落定对账

`dsh_list_pending_interactions`、`dsh_focus_session` 与 `dsh_resolve_interaction` 经 `VoiceRuntimeService.requestActiveClient(method, payload, { operationId, timeoutMs })` 与当前 `(activeOwnerConnId, ownerEpoch)` 客户端通信：

- **客户端前置核验**：对前台 `PendingApproval` 核验 `pending.answerable === true` 后调用 `pending.answer('allowed-once' | 'rejected')`；对前台 `PendingQuestion` 核验 `!snap.closed && snap.channel !== 'none'` 后调用 `pending.answer(answer)`。
- **Host 权威结算对账**：发出委托前同步记录目标活跃 `Session` 的 `startSeq = session.seq` 并预挂 `session/event` 监听器，往返期间与返回后同时对账实时事件与 `[startSeq, session.seq)` 已落盘事件：权限审批核对配对 `approval/decided` 的真实 `outcome` 返回 `host_confirmed`；定时提问核对 `userQuestions.settled`（转入后台持续态返回 `moved_to_continued`）；后台 `'continued'` 提问经 `ctx.userQuestions.answer(agent, callId, answer)` 入队返回 `reply_queued`；委托超时或尚未观测到结算事件统一返回 `settlement_unconfirmed`。

## 配置 Schema 与版本化目录热同步

底层配置包含 `Config.toolsPolicy` 与按工具名索引的 `Config.tools` 覆盖字典（均标记 `.volatile()`，支持在「插件」二级详情页 `plugins.bundle.config` 中通过原生 `<SettingsForm>` 热更新；详情页提供 `弹窗确认` / `自动执行` 两档切换，`defaultMaxOutputChars`、`uiConfirmationTimeoutMs` 与单条 `description` 覆写仅保留在 `cordis.patch.yml` 配置层）。每当 `register()`、单工具 `dispose()` 或外层 `loader/volatile-update` 改变生效工具定义集合时，注册表推进 `desiredRevision`，由 `VoiceRuntimeService` 在满足 `isMaintenanceQuiescent`（无在途未回填工具与活跃响应）时串行发送 `session.update` 并等待 `session.updated` 确认落盘后发布 `appliedRevision`。

## Cordis 所有权、生成器生命周期编排与双层异步排空闭环

- **零模块级单例与单个生成器 `ctx.effect` 逆序编排**：工具注册表、挂起的 `'ui'` 审批队列、客户端委托请求表及在途 `InFlightToolCall` 全部归属 `VoiceToolRegistry` 与 `VoiceToolDispatcher` 实例；通过单个 `ctx.effect(function* () { ... yield ctx.provide('ttdsTools', registry) })` 逆序编排服务撤回与排空清理。
- **单工具异步排空注销**：调用 `await dispose()` 时，同步将该 `registrationId` 置为 `draining`（拒绝新调用、废除关联令牌、取消挂起 `'ui'` 确认并向该实例所有在途 `execute()` 发出 `abort`），随后 `while` 循环等待该实例所有在途 `execute()` 异步清理尾部、错误回填（`TOOL_UNLOADED`；整体卸载 `disposing` 时仅写本地日志短路网络等待）及日志写入全部结算完毕后才移除占位并 `resolve()`。
- **与 `VoiceRuntimeService` 及 `VoiceHookRegistry` 的单向 `ConsumerLease` 排空**：`VoiceToolDispatcher` 同时持有 `ttdsRuntime.acquireConsumerLease({ stop })` 与 `ttdsHooks.acquireConsumerLease({ stop })`；收到任一 `stop()` 或自身卸载时中止全部在途调用，并以 `while` 循环等待所有在途执行（含 `beginSelfAction` 守卫结算）与本地日志落盘稳定归零后，先释放 `ttdsHooks` 租约再释放 `ttdsRuntime` 租约，确保派发器排空期间 `ttdsHooks` 始终存活可用。

## 考虑过的替代方案

**把前台话轮 `turnGeneration` 绑定到工具 `execute()` 的 `AbortSignal` 上。** 落选原因：用户在耗时工具运行期间开口与语音总管闲聊或追问细节属于正常的“边聊边干”交互，若开口即取消后台工具会导致查询与操作反复中断；仅将会话挂断、单工具注销与插件卸载绑定至 `execute()` 的取消信号才能保障异步工具稳健完成。

**由后端外层对超长工具输出直接做字符切片截断，或仅校验 `nextArgs` 类型而不校验游标推进。** 落选原因：裸切片会破坏 JSON 语法，而允许重复原游标会导致模型在超长单条内容上无限翻页死循环；结合 schema 复验、游标严格不等校验与 `charOffset` 分片推进才能根除死循环。

**在两阶段工具调用中增加模型口头二次确认票据（`'verbal'`）档位。** 落选原因：端到端语音模型在多轮口语复述中难以稳定回传确认票据与逐字一致的业务参数，且真实语音流转写时序与票据有效期极易造成模型反复重试却无法执行命令，改为在 `'ui'` 界面物理点击与 `'auto'` 自动放行两档之间清晰切换，确定性与可靠性更高。

**在 Host 侧抢答 `approval/request` waterfall，或让 `register()` 返回同步销毁函数 `() => void`。** 落选原因：Host 抢答会留下前端幽灵卡片，同步销毁函数会导致扩展插件发生 Use-After-Dispose；客户端委托加 Host 日志对账与异步排空 `dispose()` 才能闭环。

## 验收标准

- 为非阻塞异步执行、注册/运行期门禁、安全确认与生命周期附带确定性正反例单元测试：
  - **非阻塞边聊边干与取消隔离测试**：启动耗时异步工具进入 `execute()` 后，连续模拟用户语音打断与 `sendText` 推进 `turnGeneration`，断言工具 `signal.aborted === false` 且正常完成后回填落盘；模拟 `'ui'` 确认弹窗挂起期间用户开口询问细节，断言确认卡片保持有效直至用户点击批准或超时；模拟单工具 `dispose()` 或会话挂断，断言 `signal.aborted === true` 并等待异步收尾排空。
  - **注册期与运行期推进门禁反例**：验证缺少 `drillDownParams` 字段或同名未排空重注册被同步拒绝；验证超预算、缺失 `nextArgs` 或游标未推进返回被拦截为 `TOOL_OUTPUT_CONTRACT_VIOLATION`。
  - **`'ui'` 弹窗确认、`'auto'` 自动放行与 DSH 接口对账测试**：验证允许、拒绝、超时、注销清理的幂等与隔离行为；验证 `dsh_resolve_interaction` 的预挂 `startSeq` 对账、`moved_to_continued`、`reply_queued` 与 `settlement_unconfirmed` 精确分支。

## 风险

- **无活跃浏览器窗口或冷会话未激活边界**：无活跃客户端窗口时纯前台审批返回 `CLIENT_UI_UNAVAILABLE`，冷会话未加载 live root `Agent` 时持续态问题返回 `SESSION_AGENT_INACTIVE`，均由语音总管如实口播说明。
