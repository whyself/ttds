# Agent Note: 异步语音工具注册表与 DSH 桥接审批

Status: implemented

## 问题

全双工语音模型在通话中频繁召唤检查工作区、读取长对话进度或派发多步骤写会话任务时，若注册表阻塞对话轮次直到磁盘 I/O 或人工确认落盘，实时音频流就会明显卡顿、丢帧甚至触发超时断开；此外，高危会话控制、参数纠偏和工具审批必须遵从 DSH 原有会话与用户权限所有权，且随时承受工具热注销或超时撤回。

## 决策

构建实例级的 `VoiceToolRegistry`（[registry.ts](../../../../packages/ttds/src/tools/registry.ts)，服务名 `ttdsTools`）、11 个结构化 DSH 桥接工具（[builtin-tools.ts](../../../../packages/ttds/src/tools/builtin-tools.ts)），以及与宿主网页端共存竞速的审批观察桥 `VoiceApprovalHostBridge`（[host-bridge.ts](../../../../packages/ttds/src/tools/host-bridge.ts)，服务名 `ttdsToolHost`）。

### 非阻塞后台执行、租约取消与同步注销

- **同步可撤回注册**：`registry.register(tool)` 校验工具名称未重复、所有 `write` / `approval` 类及非自动确认的工具必须提供 `summarizeCall`，以及 `approval` 分类永远禁止 `auto` 模式；注册生效立即触发上游工具目录刷新，返回同步幂等销毁函数 `() => void`。一旦工具或插件卸载，注销器撤回待决卡片、经独立 `AbortController` 中止关联 `inFlight` 任务并通知上游下线该工具。
- **独立租约并发执行**：`dispatchToolCalls(calls)` 面对批量模型调用不阻塞主会话循环，为每一路 `call` 单独从 `ttdsRuntime` 申请 `ConsumerLease`，组合调用级取消控制器、租约取消信号与 `AbortSignal.timeout(config.tools.toolTimeoutMs)`（范围 `1000..300_000` ms，默认 `60_000` ms）。执行前落盘 `tool.call` 审计、结束或中止后经 `submitToolResult` 回填结果；仅当尚未被中止时向 `ttdsHooks` 入队 `ttds_tool_output_ready` 以等待适当时机提示模型开口反馈。

### 双档确认策略与等待期内变更拦截

- **四分类与显隐隔离**：工具定义归入 `'read' | 'search' | 'write' | 'approval'`。其中 `'read'` 与 `'search'` 默认自动执行且可被 `enableReadTools` / `enableSearchTool` 隐藏（未公开的工具即使用户或模型构造残留名字直调也会被 `invoke` 阶段按 `tool_disabled` 拒绝）；`'write'` 服从 `writeConfirmation`（默认 `'ui'` 弹窗确认，可选 `'auto'` 自动放行）；`'approval'` 强制 `'ui'`，若配置或调用期落入自动模式立即按 `confirmation_required` 拦截。
- **待决确认卡片与重入核对**：进入界面确认模式时，注册表生成带唯一 `confirmationId` 的 `VoicePendingUiConfirmationView` 推送给所有已连接 UI 并发布 `'confirmation'` 事件流条目；用户在主舞台、悬浮球气泡或 `/ttds/confirm` 点击拒绝时返还 `confirmation_cancelled`。无论放行与否，阻塞解除后都会重新比对确认策略、工具在册状态与启停开关：若等待人工确认期间配置已切换确认策略，即返回 `confirmation_policy_changed` 并中止执行，彻底堵住策略窗口期内的高权限绕过。

### 11 个内置 DSH 桥接工具与字段定界输出

| 分类 | 工具名 | 核心能力与内置定界规则 | 确认模式 |
| --- | --- | --- | --- |
| `read` | `dsh_list_sessions` | 经 `sessionController.list` 与 `workspaceRegistry` 按非空白主会话优先返回最多 `20` 个会话及工作区映射 | `auto` |
| `read` | `dsh_get_session_progress` | 汇报会话状态、最新阶段、挂起队列与最近实质助手回复（过滤中间工具步草稿），附带最近 5 条工具活动与队列摘要 | `auto` |
| `read` | `dsh_inspect_workspace_changes` | 通过 `execFile('git', ...)` 在会话目录或显式工作目录读取 `--short` 状态与 `--stat` 统计，单字段以 `1800` 字符封顶并标记 `truncated` | `auto` |
| `read` | `dsh_read_session_messages` | 读取会话标题、首条任务（`initialPrompt`）与最近 `1..20`（默认 `5`）条人类与最终助手对话，单条限 `600` 字符并自动剔除中间过程草稿 | `auto` |
| `read` | `dsh_list_pending_approvals` | 优先通过 `ttdsToolHost` 返回最多 `20` 条挂起审批项并补全会话标题；宿主未接管时回退到冷安全 `state` 查询并显式注明不可在此直接代批 | `auto` |
| `search` | `dsh_search` | 经宿主 `ctx.web.search` 检索网页，`maxResults` 范围 `1..10`（默认 `5`），摘要限 `800` 字符且附带 `untrustedExternalContent: true` 边界标识 | `auto` |
| `write` | `dsh_create_session` | 在匹配工作区（或按默认工作区/显式路径归属）创建后台会话，可选附带保留用户关键数值原话的首条入队任务 | `config.tools.writeConfirmation` |
| `write` | `dsh_send_session_prompt` | 支持 `steer`（默认立即插话）或 `queue` 追问已有会话，并可设 `flushQueued: true` 将全部排队消息一并转为立即插话 | `config.tools.writeConfirmation` |
| `write` | `dsh_cancel_session_turn` | 调用 `sessionController.cancel` 终止指定会话当前正在进行的回合 | `config.tools.writeConfirmation` |
| `write` | `dsh_switch_session_model` | 调用 `sessionController.selectModel` 热切换指定后台会话的模型提供方与模型 ID | `config.tools.writeConfirmation` |
| `approval` | `dsh_resolve_tool_approval` | 通过 `ttdsToolHost.resolveToolApproval` 对目标 `sessionId` 下的 `approvalId` 提交显式批准或拒绝 | 强制 `'ui'` |

- **语义会话定位**：除列举全局状态外，定位单个会话均通过 `resolveTargetSessionId` 统一解析：优先精准匹配 ID，接受 `'latest'` / `'最新会话'`（优先活跃非空白主会话）以及按会话标题关键词搜索，多条模糊命中时返回结构化 `ambiguous_session` 错误提示模型改用明确 `sessionId`。

### 宿主审批瀑布竞速与自操作回声抑制

- **`approval/request` waterfall 公平竞速**：`VoiceApprovalHostBridge` 全局以 `{ prepend: true }` 注册为 `approval/request` 前置拦截者并同步订阅 `session/event`，持续关联来自 `tool/call` 的调用参数、`session/title` 与工作区名称以形成带上下文的高可读摘要。每次工具提权事件到来时，桥接层与下游浏览器审批 UI `next()` 并行竞速（`Promise.race`）：只要浏览器界面先行结算，语音侧立即失效清理；若无浏览器界面接管（下游返回 `unavailable`）且此时语音主会话正在运行，则维持请求悬停等待，直至用户通过语音确认调起 `dsh_resolve_tool_approval` 结案；若语音会话断开或插件停机卸载，则发出 `yield` 将裁决完全让渡给下游处理流程。
- **自操作回声抑制**：所有 `write` 与 `approval` 工具调用公开接口前必经 `selfAction` helper 包裹调用 `context.beginSelfAction(sessionId, actionKind)`，保证由语音工具引起的会话变更（新建、追加指令、取消、审批落定）在操作期间及其后短冷却内不会重复生成钩子提示语音（[event-hook-engine.md](2026-11-11-event-hook-engine.md)）。

## 考虑过的替代方案

- **将 DSH 日志原文与长代码 diff 直接返回给 Realtime 会话窗**：语音模型的上下文窗口与口语理解成本在海量堆栈和源码面前迅速恶化且易复述大段行号；通过结构化清洗过滤中间步骤草稿并在每个返回字段设定硬截断，确保语音侧始终只拿到简洁定界事实。
- **在语音插件内部新增独立的工具审批持久化接口，或直接拦截修改 DSH 内部权限数据库**：打破多端状态唯一性并与宿主 `dsh-user-approval` 模型产生竞争冲突。依托 `approval/request` waterfall 前置观测与 `Promise.race` 共存，保证不论网页还是语音入口都能对同一请求做出互认决议。
- **用 `exec` 拼接 Shell 字符串查询工作区变更，或允许通过 `dsh_create_session` 写绝对路径任意执行指令**：改以固定参数数组的 `execFile('git', ['--no-optional-locks', ...])` 并设置 10 秒超时及 64 KiB 缓冲区封顶，排除参数注入和无限挂起风险。

## 后果

- 语音对话全程不被工具和人工审批阻塞；用户随时可以在等待确认或后台排查进展期间自由打断话题，并可按需把常用非审批写工具切换为自动执行以进一步提速。
- 当未安装 `ctx.web` 服务或 DSH 核心未能连接界面审批桥接时，`dsh_search` 与 `dsh_resolve_tool_approval` 会各自退回到显式结构化不可用提示，不影响其余只读巡检与会话操控工具正常使用。

## 测试

- 注册防重、缺失摘要拒收、异步独立租约、同步销毁撤回确认卡、等待期内确认策略切换拦截及 `toolTimeoutMs` 超时放弃测试见 [packages/ttds/tests/tools/registry.spec.ts](../../../../packages/ttds/tests/tools/registry.spec.ts)。
- 全量 11 个内置工具参数校验、会话标题/别名消歧、中间工具步骤筛选、工作区 `git` 截断、`dsh_search` 错误辨别、`selfAction` 异常清理以及 `VoiceApprovalHostBridge` 竞速让渡验证见 [packages/ttds/tests/tools/builtin-tools.spec.ts](../../../../packages/ttds/tests/tools/builtin-tools.spec.ts)。
