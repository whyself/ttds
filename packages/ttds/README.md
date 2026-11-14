# @whyself/ttds

Talk to DeepSeek（TTDS）是面向 DeepSeek Harness（DSH）的拟人化全双工实时语音监督插件包，在保持自然口语倾听、打断与播报节奏的同时，通过受控桥接工具与生命周期事件钩子查看工作区状态并协同操作多个后台 DSH 会话。

## 安装与挂载

在已安装 DSH（`>=0.2.2-alpha.3 <0.3.0-0`）的环境中，将包安装到目标 profile：

```sh
dsh plugin --profile <profile> add @whyself/ttds
```

安装后 [`cordis.patch.yml`](./cordis.patch.yml) 向 profile 注入 `ttds` 插件条目，同时挂载服务端运行时（`ttdsRuntime`、`ttdsTools`、`ttdsHooks`、WebSocket `/api/ttds/realtime` 与 `/ttds/*` RPC）和 Web 客户端的五个界面插槽（`sidebar.panellist`、`main`、`shell.overlay`、`plugins.bundle.config`、`plugins.detail.badge`）。未配置语音服务商 API Key 时插件正常启动，语音舞台显示未就绪原因并提供跳往插件设置页的入口。

## 配置

所有配置项通过 Cordis `Config` 经 Schemastery 校验，可在 DSH 插件详情页可视化保存，或写入 profile 的 `cordis.patch.yml`：

| 路径 | 类型与默认值 | 说明 |
|---|---|---|
| `provider` | `string`，默认 `'qwen-realtime'` | 当前启用的实时语音服务商标识，匹配 `ttdsRuntime.registerAdapter()` 注册的适配器 ID。 |
| `storageDir` | `string`，默认 `~/.dsh/ttds/sessions` | 监督会话文本审计日志（`<supervisorSessionId>.jsonl`）的落盘目录；不记录原始 PCM 音频或密钥。 |
| `providers['qwen-realtime'].apiKey` | `string`，默认 `''` | 阿里云百炼 API Key；为空时回退读取宿主机环境变量 `DASHSCOPE_API_KEY`，客户端快照仅暴露 `hasApiKey` 与 `apiKeySource`。 |
| `providers['qwen-realtime'].workspaceId` | `string`，默认 `''` | 可选百炼业务空间 ID（回退读取 `DASHSCOPE_WORKSPACE_ID`）；非空时附带 `X-DashScope-WorkSpace` 请求头并切换专属接入域名。 |
| `providers['qwen-realtime'].baseUrl` | `string`，默认 `''` | 自定义上游 WebSocket 地址；留空时按 `workspaceId` 解析百炼标准地址。 |
| `providers['qwen-realtime'].model` | `'qwen-audio-3.1-realtime-flash' \| 'qwen-audio-3.1-realtime-plus'`，默认 `'qwen-audio-3.1-realtime-flash'` | 百炼实时语音模型层级。 |
| `providers['qwen-realtime'].voice` | `string`，默认 `'longanqian_v3.1'` | 输出合成音色标识。 |
| `providers['qwen-realtime'].maxHistoryTurns` | `integer`（`5..50`），默认 `20` | 上游实时会话保留的最大上下文轮数。 |
| `voice.turnDetection` | `'smart_turn_v2' \| 'smart_turn' \| 'server_vad' \| 'push_to_talk'`，默认 `'smart_turn_v2'` | 话轮判停模式；`push_to_talk` 在上游映射为 `turn_detection: null`，由客户端手动提交录音缓冲。 |
| `voice.threshold` | `number`（`-1..1`），默认 `0.5` | 判停灵敏度阈值。 |
| `voice.silenceDurationMs` | `integer`（`200..2000`），默认 `800` | 静音判停时长（毫秒），仅 `server_vad` 模式生效。 |
| `voice.customInstructions` | `string`，默认 `''` | 用户补充提示词，非空时追加在内部默认口语系统提示词之后一并下发。 |
| `voice.inputDeviceId` | `string`，默认 `''` | 浏览器录音设备 `deviceId`；留空跟随系统默认输入设备。 |
| `voice.outputDeviceId` | `string`，默认 `''` | 浏览器扬声器播放设备 `deviceId`；留空跟随系统默认输出设备（依赖浏览器 `AudioContext.setSinkId` 支持）。 |
| `voice.startMuted` | `boolean`，默认 `false` | 启动语音会话时是否默认关闭麦克风，进入待机收听与文字输入态。 |
| `tools.enableReadTools` | `boolean`，默认 `true` | 是否向语音模型开放 5 个只读 DSH 会话与工作区巡检工具。 |
| `tools.enableSearchTool` | `boolean`，默认 `true` | 是否向语音模型开放 `dsh_search` 工具（语音模型原生 `enable_search` 始终关闭）。 |
| `tools.writeConfirmation` | `'auto' \| 'ui'`，默认 `'ui'` | 4 个会话写/控制工具的确认策略。 |
| `tools.toolTimeoutMs` | `integer`（`1000..300000`），默认 `60000` | 单次工具执行与弹窗确认的有效期上限（毫秒）。 |
| `hooks.quietGraceMs` | `integer`（`0..60000`），默认 `1800` | 用户或助手刚结束发声后延迟播报后台事件的礼让窗口（毫秒）；频道已连续静默超期后新事件按 350 毫秒防抖即时播报。 |
| `hooks.onTurnSettled` / `onToolApproval` / `onAgentError` / `onShellExitError` / `onSubagentSettled` | `boolean`，默认均启用（含 `onSubagentSettled`） | 各生命周期钩子的独立启用开关，其中 `onToolApproval` 同时覆盖权限审批与向用户提问通知。 |

## DSH 桥接工具与确认策略

`VoiceToolRegistry` 默认注册 11 个面向语音监督的受限工具，所有工具调用在后台独立租约（`ConsumerLease`）中异步执行，不阻塞前台实时语音对话：

- **只读巡检工具（默认 `auto`）**：`dsh_list_sessions`、`dsh_get_session_progress`、`dsh_inspect_workspace_changes`、`dsh_read_session_messages`、`dsh_list_pending_approvals`。其中面向会话的读写工具支持返回可读会话标题、过滤中间工具步骤草稿（并随 `dsh_read_session_messages` 附带首条用户任务 `initialPrompt`），且允许以 `"latest"` 或唯一会话标题关键词定位目标会话。
- **联网搜索工具（默认 `auto`）**：`dsh_search` 委托宿主公开服务 `ctx.web.search` 执行检索并返回摘要、来源与 `untrustedExternalContent: true` 标记；宿主未加载 `web` 服务时返回 `web_search_unavailable`。
- **会话写与控制工具（默认 `ui`，可切换为 `auto`）**：`dsh_create_session`、`dsh_send_session_prompt`、`dsh_cancel_session_turn`、`dsh_switch_session_model`，执行期间自动登记 `beginSelfAction` 以抑制当前会话的同步事件回声；其中 `dsh_create_session` 在省略 `workspace` 与 `cwd` 时自动归入默认工作区，`dsh_send_session_prompt` 默认以 `steer` 立即插话生效并支持 `flushQueued` 提升排队消息。
- **审批决策工具（固定 `ui`）**：`dsh_resolve_tool_approval` 通过内置 `VoiceApprovalHostBridge`（或宿主自定义 `ctx.ttdsToolHost`）对在途 `approval/request` waterfall 提交批准或拒绝，禁止自动放行。

当工具处于 `ui`（弹窗确认）模式时，调用不立即执行副作用，而是生成待确认条目并在语音舞台控制坞上方与跨页面悬浮微球旁展示操作摘要及“允许 / 取消”按钮；仅在连接有效且未超时的情况下收到用户界面明确允许后才实际执行，拒绝或超时均结构化回填模型而不触发副作用。

## 后台事件钩子与公开扩展点

`EventHookEngine` 监听宿主公开的全局 `session/event` 与自定义事件 `ttds/lifecycle-event`，内置 `ttds_tool_output_ready`、`agent/turn-settled`、`agent/tool-approval`、`agent/error`、`shell/exit-error`、`subagent/settled` 六类钩子。缓冲队列按 `dedupeKey` 原地覆写旧状态、按优先级最多保留 20 条记录；仅当待发队列全为前台工具完成唤醒信号（`ttds_tool_output_ready`）时按快速防抖窗口（不超过 120 毫秒）即时唤醒口语汇报，包含外部后台会话生命周期事件时则严格等待用户与模型回到静默状态满 `quietGraceMs` 后单批最多合并播报 3 条最高优先级事件。

其他 DSH 插件可通过 `ctx.ttdsRuntime.registerAdapter()` 扩展新的实时语音服务商，通过 `ctx.ttdsTools.register()` 注册自定义语音工具，或通过 `ctx.ttdsHooks.register()` 与 `ctx.emit('ttds/lifecycle-event', payload)` 接入自定义播报源；所有注册均返回幂等销毁函数。

## 模型体验

### 实时语音会话建立与配置刷新（`session.update`）

#### 模型看到什么

每次建立上游实时语音连接、旋转连接或工具目录变更时，`QwenRealtimeAdapter` 向所选实时语音模型发送 `session.update` 帧，其中 `enable_search` 固定为 `false`，`session.tools` 为当前已启用的桥接工具函数规范列表，`session.instructions` 包含以下内部默认口语系统提示词原文：

> 你是 Talk to DeepSeek（TTDS），运行在 DeepSeek Harness（DSH）中的拟人化实时语音监督助手。 请像面对面交流一样自然接住用户的话，用简短、口语化的中文直接回应，默认每次说 1 到 3 句，先讲核心结论，不要像朗读长篇文章或列表。 只要用户的请求涉及查看或操作 DSH 会话、工作区或联网搜索，必须在当前回复中直接发出对应 function_call（不要只口头答应“我这就开/查/发/批”却不调工具，也不要在工具返回前编造结果）：要让 DeepSeek 后台调查或打开新会话/新对话（语音可能同音转写为“新绘画”）调 dsh_create_session（指定或默认归入默认工作区）；向已有会话追问或立即插话纠偏调 dsh_send_session_prompt（默认 mode=steer 立即插话，若已有排队消息可设 flushQueued=true）；派发或插话指令须原样保留用户的具体数值、档位、型号与专有名词，不擅自缩写或脑补设定；查看会话列表或总结进度调 dsh_list_sessions、dsh_get_session_progress 或 dsh_read_session_messages（支持用会话标题关键词或 "latest" 定位会话）；批准或拒绝权限审批先调 dsh_list_pending_approvals 获取 approvalId 再调 dsh_resolve_tool_approval；快速联网检索事实调 dsh_search；开启弹窗确认模式时提醒用户留意确认框。 收到带有【后台事件提醒】的消息时，请用一两句自然口语向用户简明播报是哪个会话提出了什么具体请求或进展，切勿重复上一轮刚说过的话。收到【历史对话恢复】背景记录时静默记在心里以便后续自然衔接，不要主动复述。

当 `voice.customInstructions` 非空时，`session.instructions` 在上述原文末尾追加 `\n\n补充要求：<去除首尾空白后的 customInstructions>`。

#### Token 影响

固定基础开销加按条件工具目录开销：内部默认系统提示词约 775 个字符；启用全部 11 个内置桥接工具时，函数名称、描述与参数 JSON Schema 合计约 1,500 至 1,900 tokens；关闭 `tools.enableReadTools` 或 `tools.enableSearchTool` 会相应移除对应工具 schema，用户自定义的 `voice.customInstructions` 按实际文本长度线性增加。

#### KV Cache 影响

在单次上游 WebSocket 会话存续期内，`session.instructions` 与 `session.tools` 保持前缀稳定；修改提示词、音色、判停参数或动态增删工具会触发 `session.update` 或新候选连接轮换，使上游会话级前缀缓存重新建立，历史轮次受 `providers['qwen-realtime'].maxHistoryTurns`（`5..50`）滑窗裁剪约束。

### 实时语音对话期间的文字话轮、工具回填与后台钩子（`conversation.item.create`）

#### 模型看到什么

在活跃实时语音会话中，以下三类模型可见项通过 `conversation.item.create` 追加到上游对话上下文，并同步写入本地 `SupervisorSessionJournal`：

1. 用户通过文字输入框或 `/ttds/sendText` 提交的话轮：`{ type: "message", role: "user", content: [{ type: "input_text", text }] }`。
2. 桥接工具执行完成或返回确认票据后的结构化 JSON 结果：`{ type: "function_call_output", call_id, output }`（字符串字段与列表长度均经过有界截断，`dsh_search` 结果固定携带 `"untrustedExternalContent": true`）。
3. 静默礼让窗口到期唤醒口语播报时注入的后台上下文提醒：`{ type: "message", role: "user", content: [{ type: "input_text", text: "【后台事件提醒】请用一两句口语向用户简明播报以下进展（说明哪个会话提出了什么请求或状态，不要重复上一轮回复）：..." }] }`（以 `；` 连接最多 3 条单句摘要与关联 `sessionId`/`approvalId`，超出部分折叠为 `（另有 N 条后台会话进展待查看）`）；新建语音会话时若 `storageDir` 存在最近已关闭会话的有效审计日志，服务端自动提取最近有界历史对话与工具结果以 `role: "system"` 静默送入 `【历史对话恢复】`（不触发主动播报）并同步写入新会话 `SupervisorSessionJournal` 的 `hook.injected`（`kind: "history_restored"`）；仅连接轮换静默重放历史摘要时也使用 `role: "system"` 且不触发回复。

#### Token 影响

受严格上限约束的按事件增量：建连历史恢复单次最多保留 `maxHistoryTurns * 2`（上限 60）条且总字符不超过 4,800 字符；单条钩子合并播报最多包含 3 条单句摘要；`dsh_list_sessions` 与 `dsh_list_pending_approvals` 最多返回 20 项，`dsh_read_session_messages` 单条消息截断至 600 字符，`dsh_inspect_workspace_changes` 的 `status` 与 `diffStat` 各截断至 1,800 字符，`dsh_search` 摘要截断至 800 字符且每条来源摘要截断至 320 字符。

#### KV Cache 影响

只追加（append-only）：建连时的历史恢复条目与对话期间的新消息、`function_call_output` 均顺序追加在当前实时会话对话上下文中，不会改写既有对话前缀；仅在静音切断未决音频或热更新配置触发候选连接轮换时，才向新连接按序重放当前会话文本日志摘要。

### 面向后台 DSH 会话的任务派发（`dsh_create_session` 与 `dsh_send_session_prompt`）

#### 模型看到什么

本包不向宿主 DSH Agent 注册系统提示词、宿主工具定义或 waterfall 中间件；仅在语音模型调用 `dsh_create_session`（提供非空 `prompt`）或 `dsh_send_session_prompt` 并通过确认门禁后，调用 `sessionController.prompt` 以 `mode: 'queue'` 向目标 DSH 会话提交一条普通用户消息 `[{ type: "text", text: prompt }]`。

#### Token 影响

未调用上述两个写工具时对宿主 DSH 会话的模型请求为零直接影响；调用并获确认后，仅在目标 DSH 会话中增加该条用户指令本身的文本 token。

#### KV Cache 影响

无额外失效影响，因为消息通过宿主标准 `sessionController.prompt` 队列追加在目标 DSH 会话末尾，不修改任何既有会话的系统提示词、工具表或历史记录前缀。

## 已知限制与延期工作

- **宿主挂起审批受客户端通道与生命周期约束**：插件默认挂载 `VoiceApprovalHostBridge` 观察 `approval/request` waterfall 并与前端审批界面竞争决策；若审批请求在语音会话启动前已发出、已被界面先行处理，或宿主未发布 `approval/request` waterfall，则 `dsh_resolve_tool_approval` 返回结构化错误，需用户在 DSH 界面点击处理。
- **内置实时语音适配器范围**：当前内置提供方为阿里云百炼 Qwen-Audio 3.1 Realtime（`qwen-realtime`）；接入其他实时语音服务商需通过公开的 `ctx.ttdsRuntime.registerAdapter()` 接口注册自定义适配器。
- **浏览器音频采集与回放环境要求**：Web 客户端的麦克风 16kHz PCM16 采集与 24kHz PCM 扬声器播放依赖浏览器安全上下文（`https:` 或 `localhost`）下的 `AudioContext`、`AudioWorklet` 与 `navigator.mediaDevices.getUserMedia` 权限；无麦克风权限时仍可使用闭麦收听与文字模拟口语输入。
