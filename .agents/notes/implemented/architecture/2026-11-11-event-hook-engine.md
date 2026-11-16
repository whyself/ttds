# Agent Note: 静默礼让事件钩子引擎与防打断播报机制

Status: implemented

## 问题

在多任务编码场景下，DSH 后台会话的回合结束、命令报错、权限审批和子代理状态会不定时并发产生。若系统事件到达即强行推送语音打断人声，或由语音工具自身引发的会话变更马上作为“外部提醒”回声通知，交互体验会陷入频繁自言自语和噪音干扰；同时，异步完成的语音工具若只在对话幕后静默写回输出而不择机主动发声，用户无法得知结果何时就绪。

## 决策

实现全局实例级的事件钩子调度引擎 `EventHookEngine`（[hook-engine.ts](../../../../packages/ttds/src/hooks/hook-engine.ts)，服务名 `ttdsHooks`）以及六类面向 DSH 公开事件的内置观测挂载 [builtin-hooks.ts](../../../../packages/ttds/src/hooks/builtin-hooks.ts)。

### 六类内置观测钩子与范围约束

`registerBuiltinVoiceHooks` 向 `ttdsHooks` 注册 6 个钩子定义并通过全局 `ctx.on('session/event', ...)` 与 `ctx.on('ttds/lifecycle-event', ...)` 仅以只读方式观测事实，不拦截或吞噬宿主总线上的任何事件传播（其中除核心工具完成钩子外，其余 5 项均受 `Config.hooks` 中对应开关在入队与派发双阶段动态校验管控）：

| 钩子 ID | 优先级 | 触发来源与过滤契约 | 配置开关 |
| --- | --- | --- | --- |
| `ttds_tool_output_ready` | `normal` | 语音工具后台执行且未经中止地完成 `submitToolResult` 回填后由工具注册表入队，用于触发无提示文直接唤醒 | 内置固定启用 |
| `agent/turn-settled` | `normal` | 观测非子代理主会话的正常完结 `turn/end`（排除用户主动取消、清理销毁、中断或接管等合成结束态），附带截断的工作区/会话标签与最新实质回答摘要 | `hooks.onTurnSettled` |
| `agent/tool-approval` | `high` | 统一覆盖两条等待人工决策路径：`session/event` 中 `approval/asked`（配对关联工具参数摘要；在收到 `approval/decided` 后移除对应内部排队记录），以及模型调用 `ask_user_question` / `ask_question` 向用户发起交互提问 | `hooks.onToolApproval` |
| `agent/error` | `critical` | 观测非主动取消类 `turn/error`、`step/error` 及通用错误事件，提取可读摘要 | `hooks.onAgentError` |
| `shell/exit-error` | `high` | 观测终端/命令类 `tool/result`，从结构化 metadata 或输出 JSON 解析非零 `exitCode` 后生成简洁告警 | `hooks.onShellExitError` |
| `subagent/settled` | `normal` | 观测 `origin === 'subagent'` 会话的回合结算与异常退出，与主根会话汇报隔离 | `hooks.onSubagentSettled` |

为防止冷会话日志回放误触发大量过时播报，公共事件处理器还借助状态指纹或历史事件标记跳过重复重放的旧历史内容。

### 静默礼让窗口、分级防抖与优先级有界合并

- **单信道礼让时序**：未连接到有效语音会话时，入队事件只缓存不启动计时器，一旦会话进入空闲连接状态立即开启调度。当新用户语音/文本进入（`inputAdmissionSeq` 推进）、助手开口或配置变动导致静默起点重置时，引擎以 `quietSinceMs` 重新估算就绪时间。
- **双路径触发机制**：
  1. **纯工具输出唤醒路径**：当队列中全部为 `ttds_tool_output_ready` 信号且其中包含尚未被后续对话自然消解的工具输出时，只需等待短防抖 `min(quietGraceMs, 120ms)` 并在确认当前空闲后调用 `runtime.requestSpokenTurn()`，无需向上下文重复塞入提示文本即可触发语音回复汇总；若在此之前模型已自然产生包含该输出的回复，调用 `markToolOutputsNaturallyConsumed(callIds)` 会自动撤除该唤醒。
  2. **宿主事件聚合通知路径**：一旦队列包含任意后台生命周期事件，必须等到通道静默满 `quietGraceMs`（`0..60_000` ms，默认 `1800` ms）且至少满足 `min(quietGraceMs, 350ms)` 聚合防抖窗口，才会出队发送。
- **20 条有界队列与每批 3 条上限**：缓冲队列最多容留 `20` 条按优先级（`critical > high > normal > low`）保留的事件；入队时若已有相同 `dedupeKey`，则原地覆盖更新摘要与元数据并重新定序，满载时淘汰最低优先级中最陈旧条目。出队派发时每次仅消费前 **3 条**高优先级项拼装一条【后台事件提醒】通知（并在尾部附带关联 `sessionId` 及 `approvalId` 以便模型继续追问或直接呼出审批工具），队列剩余条目折叠汇总为余量计数并在下一次静默窗口继续送达；若运行时此刻因抢占或断连拒绝投递（返回 `false` 或异常），已出队条目安全退回队列等待下个礼让窗口，并发期间到达的同键新事件不会被旧批次写回覆盖。

### 自操作回声抑制窗口

通过工具注册表注入 DSH 会话的操作（新建、插话、取消、切换模型、提交审批裁决）在调用前申请 `hooks.beginSelfAction(sessionId, actionKind)`。在该 `sessionId` 的活跃抑制句柄尚未 `release()` 之前以及**释放后的 `250` ms 冷却窗口内**，由该会话同步涌回的 `agent/turn-settled` 与 `agent/tool-approval` 通知均视为自身引发的回声并予过滤；而 `agent/error`、`shell/exit-error` 与 `subagent/settled` 保持直通透传，防止误屏蔽指令执行自身的真实故障告警。

## 考虑过的替代方案

- **收到后台事件或工具输出立即强制发送语音通知**：在全双工音频交互时，强制推送极易截断用户尚未说完的话轮尾音，或在语音助手正在解释 A 问题时突然插嘴报告 B 会话动态。`quietGraceMs` 礼让机制结合双指针音轨确认确保仅在人机话轮均自然收束后统一开口。
- **把所有钩子都注入大段系统通知且全量打包排队事件**：多会话并发爆发错误时一次性塞入数十条摘要既污染对话上下文又让口语播报失控；通过上限 20 条优先级队列、同键原地去重与单批 3 条配额，保障最高严重等级的故障始终优先并保持播报短促自然。

## 后果

- 后台工作区报错、审批阻断与子代理进展能够在用户话音刚落、音频播报排空后的礼让周期内有序并流汇报；工具结果则享受到低延迟（`120` ms 防抖）的主动汇报路径而不产生冗余提醒文字。
- 自操作回声过滤依赖于目标工具显式获取与释放 `SelfActionHandle`，若非通过 TTDS 发起或超过 250ms 异步跨回合产生的新结果，则正常作为后台增量信息通知用户。
- 引擎全部状态随插件实例持有，伴随 runtime `ConsumerLease` 与销毁流程清零队列与计时器，不会在测试或重载后残留定时器泄漏。

## 测试

- `1800` ms 默认边界与 `350` ms 聚合防抖、`120` ms 工具轻唤醒与自然消费抵消、20 条队列淘汰、同键合并、3 条拆批投递、失败退回重试、动态开关及 `250` ms 自操作抑制验证见 [packages/ttds/tests/hooks/hook-engine.spec.ts](../../../../packages/ttds/tests/hooks/hook-engine.spec.ts)。
- 6 类钩子提取规则、`ask_user_question` 与 `approval/asked` 配对、`shell/exit-error` 退出码判定、子代理与历史日志隔离以及同步彻底注销验证见 [packages/ttds/tests/hooks/builtin-hooks.spec.ts](../../../../packages/ttds/tests/hooks/builtin-hooks.spec.ts)。
