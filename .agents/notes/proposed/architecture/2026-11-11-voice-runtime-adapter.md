# Agent Note: 语音运行时适配层（Voice Runtime Adapter）

Status: proposed

## 问题

在[全局语音总管架构](2026-11-11-design-philosophy.md)下，实时双向语音通道连接着客户端音频采集与播放、DSH Host 工具与钩子编排、以及云端或本地语音模型，直接耦合具体语音 API 或采用同步阻塞工具模型会引发以下工程与可靠性问题：

- **厂商专有协议约束与续答行为差异**：以 **Qwen-Audio 3.1 Realtime**（`qwen-audio-3.1-realtime-flash` / `qwen-audio-3.1-realtime-plus`）为例，上游依赖专有 WebSocket 事件（`session.update`、`conversation.item.create`、`conversation.item.created`、`response.create`、`response.cancel`），存在严格的协议边界：`turn_detection` 仅允许在首次发送音频前设置，自动模式下忽略 `input_audio_buffer.clear`；同一时刻不允许并发创建响应，无进行中推理时发送 `response.cancel` 会报错；服务端事件的 `event_id` 不回显客户端请求 ID；且回填 `function_call_output` 收到 `conversation.item.created` 确认后**上游不会自动触发续答**（而其他语音模型可能原生自动续答）。若上层业务直接硬编码这些协议细节，替换或新增语音提供方将波及全栈。
- **同步阻塞工具模型扼杀“边聊边干”体验**：Qwen-Audio 3.1 Realtime 支持在 `function_call` 尚未回填 `function_call_output` 期间继续正常进行多轮实时语音或文字问答，并在稍后接纳原 `call_id` 的延迟回填。若运行时因存在在途工具而阻塞新对话、在用户插话时误取消后台工具，或在延迟回填完成瞬间无视当前话轮状态盲目硬发 `response.create`，会打断在跑任务或造成抢话撞车。
- **跨载体传输、GUI 依赖校验与凭据隔离约束**：云端 API Key 与 Workspace ID 不能暴露给客户端，且 Host 与 Client 的凭据接口分属不同服务面；插件安装在 Web 或 Electron 桌面端（`dsh-app://app/` 主窗口经主进程重写 Origin/Cookie 并注入 `streamBaseUrl`）时，缺少必需宿主服务必须明确报错而非静默跳过，同时所有控制与媒体路由均须显式校验 owner 身份。
- **多源并发竞态、上下文日志恢复与 Cordis 销毁排空风险**：同一会话上交织着流式语音、说话中途静音、纯文字直发、异步工具延迟回填、钩子注入与多窗口接管。若不在发出 `response.create` 前锁定生成意图槽位，或缺乏播放水位确认与候选连接版本校验，极易引发迟到响应误绑定、未配对工具残片污染或拆卸时底层 socket 提前关闭。

## 提案

提供面向 Web 与 Electron Desktop GUI profile 的 Cordis 服务 `ctx.ttdsRuntime`（`VoiceRuntimeService`）、可扩展的多提供方注册表（`registerProvider` / `listProviders`）与提供方接口 `VoiceRuntimeAdapter`，内置首个实现 `QwenRealtimeAdapter`（`id: 'qwen-realtime'`，适配 **Qwen-Audio 3.1 Realtime Flash** 与 **Qwen-Audio 3.1 Realtime Plus**）；通过适配器能力特征 `capabilities.autoRespondOnToolOutput` 解耦厂商续答差异，采用内部系统预置提示词与用户可修改口语提示词合并组装机制，支持**非阻塞异步工具执行与延迟回填（边聊边干）**，将延迟完成的工具续答信号统一移交[事件钩子与话轮礼让缓冲](2026-11-11-event-hook-engine.md)仲裁；依托 DSH 公开的 `ctx.connection`、`ctx.webServer` 与 `ctx.credentials` 建立校验 owner 身份的控制与媒体通道，内部通过单一上游响应槽位状态机、播放水位确认、结构化语音会话日志、带六元组 CAS 校验的隔离连接轮换以及循环排空的消费者生命周期租约，向上层暴露确定性的状态与写入契约。

## GUI 依赖声明与 Host ↔ Client 传输契约

### 必需宿主服务校验与启动就绪

TTDS 作为图形工作台插件包，面向 Web 与 Electron Desktop profile 安装（非 GUI 的 `headless`、`acp` 或 `sdk` profile 不安装本 bundle）。由于 Cordis 对声明了顶层 `inject` 的插件在缺少服务时会将其停留在 `PENDING` 状态而不进入 `apply()`（且在热重载重组合中 `pending` 条目不按激活异常抛错），插件采用**无顶层 `inject` 的外层校验入口加受控子插件**的双层装配：

1. 外层入口 `apply(ctx, config)` 不声明阻塞式 `inject`，加载时必定执行并首步调用 `resolveRuntimeConfig(config)`——任何畸形配置立即同步抛错使外层 fiber 进入 `FAILED` 状态，绝不被缺失服务掩盖。
2. 外层入口挂载声明 `inject = ['webServer', 'connection', 'credentials']` 的运行时子插件以适应同趟启动的任意加载顺序，同时注册确定性的依赖就绪核查（宿主存在 `ctx.appReady` 时通过 `ctx.effect(() => ready.onReady(verify))` 托管；无 `appReady` 的嵌入式或测试 Loader 通过挂载声明 `inject = { loader: { await: true } }` 的受控核查子插件在树结算后同步核查，避免外层 `apply()` 直接等待 `loader.await()` 自锁或留下浮动任务）：一旦启动结算完成而运行时子插件仍未激活，立即枚举 `['webServer', 'connection', 'credentials'].filter(k => ctx.get(k) === undefined)`，输出指明缺失服务名的错误诊断并使启动依赖审计可观测失败。
3. 当三项服务齐备且存在 `ctx.appReady` 时，子插件通过 `ready.onReady(() => openExternalAdmission())` 延迟开放外部请求准入并托管其注销函数，不在激活函数内 `await` 就绪回调。

### 凭据解析、客户端交互与错误脱敏

- **Host 侧解析**：插件 `Config` 仅保存符合 `@deepseek-ai/dsh-credentials` 规范的凭据引用名（`apiKeyRef` 默认 `'DASHSCOPE_API_KEY'`，可选 `workspaceIdRef` 默认 `'DASHSCOPE_WORKSPACE_ID'`）。建连时调用 `await ctx.credentials.resolve(credentialRef(name))` 读取 `.value`；目录查询调用 `await ctx.credentials.describe(ref)` 投影 `{ configured, source, writable }`，并将配置就绪度定义为独立的 `ConfigReadiness = 'ready' | 'unconfigured'`。
- **Client 侧管理**：客户端在「插件」二级详情页通过 `@deepseek-ai/dsh-api-settings-controller` 公开的 `ctx.remote.credentials`（或 `/ttds` 目录投影）查看凭据状态与写入新密钥，区分处理非法引用、未配置与只读环境来源，轮换后对下一次建连立即生效。
- **错误脱敏**：所有发往客户端或写入日志的错误文本均擦除当前已解析的凭据原文及 `sk-*` / Bearer 令牌片段。

### 一元控制、实时 WebSocket 与多窗口控制权纪元

- **一元 RPC（`ctx.connection.rpc`）**：Host 注册 `ctx.connection.rpc.handle('/ttds', handler)`，在入口显式校验 `peer.principal.kind === 'owner'`（拒绝非 owner API Peer）并对 `payload` 做 schema 校验，承载 `runtime/catalog` 等元数据查询。
- **全双工实时 WebSocket（`ctx.webServer.registerUpgrade` + `ctx.connection.openWebSocket`）**：
  - **Host 准入与物理 socket 托管**：在精确路径 `/api/ttds/realtime` 注册升级路由；鉴于 `registerUpgrade()` 注销时仅移除路由表项，所有已升级 socket 及其异步读写循环均归 `VoiceRuntimeService` 实例跟踪并在销毁阶段显式关闭等待。升级入口调用 `ctx.connection.admit(req)`，拒绝带 `rejection`（`401` / `403`）或 `admission.peer.principal.kind !== 'owner'` 的请求，同时监听物理 socket 的 `'close'` / `'error'` 与 `admission.peer.signal`。
  - **Client 连接与载体范围**：客户端调用 `ctx.connection.openWebSocket('/api/ttds/realtime')`，由 TTDS 客户端控制器管理重连退避与旧句柄关闭。普通浏览器走页面基准地址与同源签名 Cookie；Electron 桌面端主工作区窗口（`dsh-app://app/`）读取 `__DSH_TRANSPORT__.streamBaseUrl`，由桌面主进程为该主窗口重写 Origin 与认证 Cookie（不向非主应用窗口扩展）。
  - **JSON 文本帧与背压上限**：契合 `ConnectionWebSocket.send(data: string)`，通道采用经 schema 校验的紧凑 JSON 文本帧，单声道 PCM16 LE 音频以 base64 字符串传输（上行 16kHz 约 42.7 KB/s，下行 24kHz 约 64 KB/s）。Host 限制单帧字节上限（256 KiB）与单连接待发送缓冲上限，违规立即关闭该客户端 socket。
- **独立连接身份与原子接管（Owner Epoch）**：因同浏览器多页签共享同一个 `browserPeer`，Host 为每条升级连接分配唯一 `connId`，维护单调递增的 `ownerEpoch` 与同步建连互斥占位。同一时刻仅 `activeOwnerConnId` 持有控制与上行权，其余连接只读订阅状态并收到 `already_active`；任何改变状态的上行帧均须匹配当前 `(activeOwnerConnId, ownerEpoch)`。新窗口发送 `session.start({ takeover: true })` 时，Host 原子递增 `ownerEpoch` 切换 `activeOwnerConnId`、推进 `turnGeneration` 并通知旧窗口 `session.replaced`（清空旧窗口播放队列；若旧窗口残留未结算语音段则按下方静音恢复规则处理）；旧窗口随后的迟到消息与 `close` 回调仅移除其自身记录。

## 适配器能力契约、非阻塞工具状态机与并发仲裁

### `VoiceRuntimeAdapter` 能力声明与内部权威事实

`VoiceRuntimeAdapter` 显式声明只读能力描述 `readonly capabilities: { readonly autoRespondOnToolOutput: boolean }`（`QwenRealtimeAdapter` 为 `false`，标识上游确认接收 `function_call_output` 后不会自动发起语音生成）。`VoiceRuntimeService` 内部维护五组精确运行事实：

1. **独立会话标识、上游事件序号与单一上游响应槽位（`upstreamSlot`）**：每条物理上游连接拥有唯一分配的 `sessionId`（仅当前已激活连接记为 `activeSessionId`）及单调递增的服务端下行事件序号 `upstreamEventSeq`（精确刻画同一 TCP WebSocket 连接内 `conversation.item.created` 与 `response.created` 的严格先后因果序），并维护唯一的上游生成槽位状态机：
   - `'idle'`：上游无创建中、进行中或取消中的响应。
   - `{ state: 'creating', intentGeneration: number }`：已发出 `response.create`、正等待对应的 `response.created`。
   - `{ state: 'in_progress', responseId: string, generation: number, createdAtUpstreamSeq: number, audioDone: boolean }`：已收到 `response.created` 且尚未终结。
   - `{ state: 'cancelling', responseId: string, generation: number }`：已对该活跃 `responseId` 发出一次 `response.cancel`，正等待其 `response.done` 终态结算。
2. **输入段追踪、准入身份与静音状态**：维护 `micMuted: boolean`、单调递增的 `inputEpoch`、单调递增的输入活动序号 `inputActivitySeq`、为每段新准入用户输入（新语音段首帧进入 Host 准入或新 `sendText` 准入）固定分配的单调递增准入身份 `userInputAdmissionSeq`（迟到的同轮语音 ASR 转写沿用其准入时绑定的 `userInputAdmissionSeq`）、`userSpeechActive: boolean`，以及精确的未结算音频标志 `hasUnsettledAudio: boolean`（从首帧 PCM 准入发往当前活跃上游连接起同步置为 `true` 并递增 `inputActivitySeq`，直至该段输入被清空、完成自动提交或连接轮换才归零）。
3. **带单调水位与音频终结门控的客户端播放状态**：Host 每向控制端下发一帧音频块即递增单调序号 `lastSentAudioSeq`（并在每个响应收到上游 `response.audio.done` / `response.done` 时记录该响应的末尾序号 `finalAudioSeq`）并置 `clientPlaybackActive = true`。客户端按渐进播放进度上报携带 `{ connId, ownerEpoch, turnGeneration, upToAudioSeq }` 的 `playback.drained`；为防止流式 TTS 句间网络抖动欠载（Buffer Underrun）导致播放态闪烁早退，Host **仅当三元控制身份匹配、当前响应已收到上游音频终结（`audioDone` 或已进入 `'idle'`）、`upToAudioSeq === lastSentAudioSeq` 且无后续待下发音频帧时**才将 `clientPlaybackActive` 清零（辅以按未确认音频时长加余量的超时兜底）。
4. **会话规格提交版本与非阻塞在途工具集合（`InFlightToolCall`）**：对运行时配置与工具目录维护单调递增的 `SessionSpecRevision`（严格区分 `desiredRevision`、`pendingRevision` 与已收到 `session.updated` 确认并落盘的 `appliedRevision`）。每项从已终结父响应 `response.done` 派发的工具调用按 `(originSessionId, parentResponseId, callId)` 独立登记为非阻塞 `InFlightToolCall`（固定绑定派发时刻的 `appliedRevision` 与 `dispatchAdmissionSeq = userInputAdmissionSeq`，状态封闭为 `'running' | 'awaiting_item_ack' | 'completed' | 'bridged_after_rotation' | 'failed_dirty'`）——**在途 `'running'` 工具不占用 `upstreamSlot`，也不阻塞用户继续发起语音或文字对话**。
5. **双粒度静默判定（话轮静默 vs 连接维护静默）**：
   - **话轮静默态（`isSpeechQuiescent`）**：当 `activeSessionId` 已就绪，且 `!userSpeechActive`、`!hasUnsettledAudio`、`upstreamSlot === 'idle'`、无在途上下文条目确认（`awaiting_item_ack` 为空）、无 `pendingRevision` 在途、无排队中的用户文本且 `!clientPlaybackActive` 同时成立时，判定为话轮静默态并刷新 `lastInteractionAt`（即便此时仍有其他长耗时异步工具处于 `'running'`，也不阻塞已就绪结果或钩子的礼让播报）。
   - **连接维护静默态（`isMaintenanceQuiescent`）**：在满足 `isSpeechQuiescent` 基础上，额外要求当前 `activeSessionId` 名下无 `'running'` 态 `InFlightToolCall`，用于安全执行在线工具目录 `session.update` 与低优候选连接轮换。

对外发布的会话状态与元数据：向客户端推送四态声波状态 `VoiceStageState = 'off' | 'standby' | 'listening' | 'speaking'`（以自有 `assertNever` 穷尽校验：无就绪连接为 `'off'`；`!micMuted && userSpeechActive` 为 `'listening'`；存在有效代际下行音频流或 `clientPlaybackActive` 为 `'speaking'`；其余已连接状态统一为平稳 `'standby'`）及独立的 `inFlightToolCount` 供旁侧事件流展示后台进度。

### 遵循上游协议约束的麦克风静音

鉴于 Qwen-Audio 3.1 Realtime 仅允许在首次发送音频前配置 `turn_detection`，且自动模式忽略 `input_audio_buffer.clear`，`setMicMuted(true)` 按是否存在未结算上游音频分路径处理：

- 立即置 `micMuted = true` 并递增 `inputEpoch`，丢弃网络飞行中迟到的客户端 PCM 帧。
- 若 `!hasUnsettledAudio`（空闲期静音），上游缓冲区本就干净，无需发送额外指令，保持当前连接不断开。
- 若 `hasUnsettledAudio === true`（用户在说话中途点击静音）：`manual` 模式下直接发送 `input_audio_buffer.clear` 并置 `hasUnsettledAudio = false`；`smart_turn_v2` 或 `server_vad` 自动模式下，为彻底杜绝已吸入云端的半截尾音触发幽灵回复，立即推进 `turnGeneration` 并触发一次**强制候选会话轮换**，直接关闭含残余尾音的旧上游连接、基于会话日志切入零残余缓冲的新连接。

### 非阻塞工具延迟回填、意图槽位与续答解耦

1. **消除迟到 `response.created` 误绑定**：在发出 `response.create` 前，仲裁器必须确认 `upstreamSlot === 'idle'`，并预先写入 `{ state: 'creating', intentGeneration: G }`。当上游返回 `response.created(R)` 时：
   - 若 `upstreamSlot.state === 'creating'`，`R` 严格继承预存的 `intentGeneration`（若等待期间用户已打断使 `turnGeneration > intentGeneration`，`R` 仍归属旧代际并立即转入 `'cancelling'` 发出一次 `response.cancel`）。
   - 若 `upstreamSlot === 'idle'`（服务端自动 VAD 触发的新语音响应，或 `autoRespondOnToolOutput === true` 模型自动发起的续答），仅当允许自动生成且 `inputEpoch` 未作废时绑定当前有效代际；否则绑定为过期代际并立即取消。
2. **打断语音不误杀后台异步工具**：用户开口插话或发送新文字触发打断时，递增 `turnGeneration`、向客户端发送 `{ type: 'playback.clear', turnGeneration }`，并在 `upstreamSlot.state === 'in_progress'` 时发送一次 `response.cancel` 等待其 `response.done` 归回 `'idle'`；**正在后台运行的 `InFlightToolCall` 其执行 `AbortSignal` 不随 `turnGeneration` 中止**，继续完成宿主查询或任务派发。
3. **串行上下文写入与跨轮换安全回填**：
   - **纯文字直发（`sendText`）**：若当前存在未结算自动 VAD 语音、活跃响应或播放，先推进 `turnGeneration` 作废旧播报（自动模式下若 `hasUnsettledAudio` 为真则走连接轮换清理残余尾音，否则等待 `'cancelling'` 归回 `'idle'`）；随后写入预生成 `itemId` 的用户文本消息、等待匹配的 `conversation.item.created` 确认并落盘日志，在队列尾部校验代际未变后发出单次 `response.create`。
   - **非阻塞工具结果回填与续答解耦**：当某个后台工具执行完成时（若 `disposing === true` 则直接短路网络写入，仅将收尾记录写入本地 `SupervisorSessionJournal` 后立即返回）：
     - **同连接原位回填**：等待当前 `upstreamSlot === 'idle'` 并获取串行仲裁锁后，**二次核验 `!disposing && originSessionId === activeSessionId`**：满足时发送带预生成 `itemId` 的 `conversation.item.create({ type: 'function_call_output', call_id, output })` 进入 `'awaiting_item_ack'`，收到匹配的 `conversation.item.created` 后记录其下行确认序号 `ackUpstreamSeq`、落盘 `SupervisorSessionJournal` 并标为 `'completed'`。若在等待槽位或 `'awaiting_item_ack'` 期间因会话轮换使 `originSessionId !== activeSessionId`（旧连接因轮换正常退役而非上游协议拒绝），严禁标为 `'failed_dirty'`，自动降级转入下述**跨轮换桥接回填**；仅当 `originSessionId === activeSessionId` 且 `!disposing` 时遭遇确认超时或上游协议拒绝（活跃连接残留未配对 `function_call`），才标为 `'failed_dirty'` 并触发受控强制恢复轮换。
     - **跨轮换桥接回填**：若工具完成时或回填等待中途会话已切入新的 `activeSessionId`（新物理连接未重放未完成的半截 `function_call`），运行时不再向新连接硬发孤立 `function_call_output`，而是将工具结果写入 `SupervisorSessionJournal` 并标为 `'bridged_after_rotation'`，转交续答钩子以结构化完成事实注入新连接。
     - **`autoRespondOnToolOutput` 解耦续答**：当 `adapter.capabilities.autoRespondOnToolOutput === true` 时，由上游原生自动生成续答；当 `autoRespondOnToolOutput === false`（如 Qwen-Audio 3.1 Realtime）时：（a）**当轮无插话直通（Fast-Path）**：当且仅当同一 `parentResponseId` 派发的全部工具均已在当前同一 `activeSessionId` 原位 `'completed'`、自派发以来 `userInputAdmissionSeq === dispatchAdmissionSeq`（期间用户未插入新对话）且当前满足 `isSpeechQuiescent` 时，运行时先原子撤回同 `parentResponseId` 此前预入队礼让缓冲池的所有未发兄弟续答条目，随后在串行仲裁锁内直接触发单次 `response.create` 以保持亚秒级查询秒回；（b）**完备补集礼让移交（Else Path）**：其余一切情形（包括同 `parentResponseId` 尚有其他兄弟工具未结算、工具运行期间用户已发起新对话、发生跨轮换桥接、或回填完成时刻非静默），运行时均**不直接发送 `response.create`**，而是将已落盘的工具续答通知（含 `ackUpstreamSeq` 与 `alreadyInUpstreamContext` 标记）移交 `EventHookEngine` 并入话轮静默礼让缓冲池统一调度。

## 结构化语音会话日志（`SupervisorSessionJournal`）

语音总管为自身模型上下文维护独立于后台 DSH Agent 的结构化会话日志：

- **重建范围界定**：原始多模态 PCM 声学波形与敏感密钥不落盘；`SupervisorSessionJournal`（默认位于 `$DSH_HOME/ttds/voice-sessions/`，单调递增 `journalSeq`）完整记录**语音模型可见的全部结构化上下文与文本投影**，足以在任意时刻审计模型可见事实并通过文本历史重放恢复新连接。
- **记录内容与落盘时点**：按严格确认顺序记录每次生效的 `instructions` 与工具 schema 快照、每次连接轮换基线、纯文字用户消息、上游确认的用户语音转写（转写为空或失败时记录显式音频轮次占位符）、**助手输出的完整口语文本及被打断取消时已保留的截断状态**、每次 `function_call` 参数与完整 `function_call_output`（含跨轮换桥接结果）以及每次钩子 `injectContext` 原文。在触发 `response.create` 或对外发布轮次终态前，必须等待对应必要日志条目写入完成。

## 长连接治理与隔离候选连接轮换（Session Rotation）

- **云端原生轮数滑窗**：建连 `session.update` 直接下发 `max_history_turns`（Qwen-Audio 3.1 Realtime 范围 `1..50`），由上游在轮次边界原子维护问答历史长度。
- **带六元组 CAS 校验的隔离候选连接轮换**：不在活跃连接上逐条发送无事务的 `conversation.item.delete`，上下文裁剪、挂起连接级配置热更新、说话中途静音清理与 `failed_dirty` 恢复统一走候选连接轮换：
  1. 预分配全新独立的 `candidateSessionId`，记录发起瞬间的一致性六元组基线 `(baseSessionId, baseTurnGeneration, baseOwnerEpoch, baseJournalSeq, baseInputActivitySeq, baseDesiredRevision)`。
  2. 候选连接按 `baseDesiredRevision` 发送首次 `session.update` 并等待 `session.updated` 确认后，从 `SupervisorSessionJournal` 读取截至 `baseJournalSeq` 保留的最近完整轮次记录、**已配对闭合的工具调用对**（跳过尚未跑完的未配对 `function_call` 与 `failed_dirty` 脏残片）及预算内的有效静默背景项，逐条写入并等待全部 `conversation.item.created` 确认，记 `syncedJournalSeq = baseJournalSeq`。
  3. **切换前六元组 CAS 校验与未发续答上下文对齐**：低优维护轮换要求 `isMaintenanceQuiescent` 且六元组与基线完全一致才原子晋升 `candidateSessionId`（一旦准备期间用户准入首帧 PCM、启动新工具或再次修改配置则立即放弃候选连接，零丢帧保留原连接）；强制恢复轮换在串行仲裁锁内冻结旧连接新输入、对齐最新 `desiredRevision`、按 `(syncedJournalSeq, journalSeq]` 补齐配对前置 `function_call` 已存在于候选连接的有效闭合项（若某条新增 `function_call_output` 的前置 `function_call` 在 `<= baseJournalSeq` 时因未完成被跳过，或旧调用已滑出轮换保留轮次窗口，则不向候选连接裸写孤立输出）并二次通过完整六元组 CAS 校验后原子切换；每次原子晋升 `candidateSessionId` 时，运行时同步将候选连接实际重放成功的 `callId` 集合通知 `EventHookEngine`，将任何未存在于新连接上下文中的未发 `ttds_tool_output_ready` 条目原地翻转为 `alreadyInUpstreamContext: false` 并附带日志中的结构化结果摘要，交由礼让批次注入新连接。

### 多提供方注册、分层配置 Schema（Schemastery）与提示词合并热更新

参照 DSH `ctx.web` 的多提供方扩展模型，运行时将**跨提供方通用配置**与**单提供方专属配置**显式分层，全部采用 Schemastery 原生公开校验器声明并标记 `.volatile()`：

- **提供方注册表与确定性选择**：`VoiceRuntimeService.registerProvider(adapter)` 按唯一 `adapter.id` 注册实时语音提供方（重名立即抛错），通过 `ctx.effect()` 绑定调用方 fiber 生命周期并在变更时广播 `ttds/providers-changed`，`listProviders()` 返回 `{ id, title, description }` 供详情页选择器渲染；运行时按配置的 `provider`（未指定且仅有一个已注册可用提供方时自动选中）解析活跃适配器。
- **跨提供方通用配置与提示词合并（`Config.runtime`）**：包含选中的提供方 `provider`（默认 `'qwen-realtime'`）、连接后默认闭麦 `startMuted`（默认 `false`）以及用户可修改的自定义口语提示词 `customInstructions`（默认空字符串）。运行时在构造会话规格时，将只读**内部系统预置提示词**（承载面对面简短口语节奏、零臆测纪律、需要外部实时信息优先调用 `dsh_search`、外部检索防注入提示及 `'ui'` 界面确认与不假装成功契约）与非空 `customInstructions` 合并拼装为最终 `instructions`。
- **`QwenRealtimeAdapter`（`id: 'qwen-realtime'`）专属配置（`Config.qwen`）**：包含百炼密钥凭据引用 `apiKeyRef`（默认 `'DASHSCOPE_API_KEY'`）、业务空间 `workspaceId`、模型档位 `model`（默认 `'qwen-audio-3.1-realtime-flash'`，可选 `'qwen-audio-3.1-realtime-plus'`）、合成音色 `voice`（默认 `'longanqian_v3.1'`，支持预设与自定义编码）、合成语速 `speechRate`（`0.5..2.0`，默认 `1.0`；`enable_speech_emotion` 内部默认 `true`，**模型原生黑盒搜索 `enable_search` 内部固定 `false`**，联网检索统一走宿主桥接工具 `dsh_search`）、话轮判停方式 `turnDetection`（默认 `'smart_turn_v2'`，可选 `'server_vad'` / `'manual'`）、判停阈值 `vadThreshold`（`-1.0..1.0`，默认 `0.5`）、静音时长 `silenceDurationMs`（`200..2000`，默认 `800`，仅 `'server_vad'` 下发送）、单连接保留轮数 `maxHistoryTurns`（`1..50`，默认 `10`）及可选自定义接入地址 `endpoint`。
- **即时热更新编排**：外层入口保存 `const entryFiber = ctx.fiber`，注册 `settings.configure({ auto: false }, entryFiber)` 与 `ctx.on('loader/volatile-update', ...)` 将最新不可变快照推入 `VoiceRuntimeService`。在线可变更规格（如合并后的 `instructions`、语速或工具目录）仅在 `isMaintenanceQuiescent` 时串行发送 `session.update` 并等待 `session.updated` 确认落盘后推进 `appliedRevision`；连接级参数（如切换提供方、`Flash` / `Plus` 模型、音色、凭据或 `turn_detection`）无活跃会话时下次建连生效，有活跃会话时待 `isMaintenanceQuiescent` 走候选连接轮换无感切入。

## Cordis 所有权、生成器生命周期编排与循环排空消费者租约

- **零模块级单例与单个生成器 `ctx.effect` 逆序编排**：所有连接记录、控制纪元、上游槽位、播放水位、异步在途工具表、日志句柄与租约表均归属 `VoiceRuntimeService` 实例；服务注册与底层清理统一包裹在单个 `ctx.effect(function* () { ... yield ctx.provide('ttdsRuntime', service) })` 生成器内逆序执行，杜绝同级销毁函数并发抢跑。
- **闭环且销毁期网络短路的消费者生命周期租约（`ConsumerLease`）**：
  1. **首次工作前获取租约**：钩子引擎与工具派发器在激活时调用 `acquireConsumerLease({ stop: () => Promise<void> })` 获取租约句柄，直至清理彻底结束才调用 `lease.release()`。
  2. **阶段一（关闭外部准入、网络等待短路并触发全部租约停止）**：销毁开始时同步置 `acceptingExternal = false` 与 `disposing = true`（注销路由、拒绝新连接与新轮次、立即唤醒并短路所有在途 `upstreamSlot === 'idle'` 等待与 `'awaiting_item_ack'` 网络等待，严禁在销毁期发起新上游写入或新建候选轮换 WebSocket），并遍历全部未释放租约调用幂等 `lease.stop()`；此阶段持有租约的消费者仅将最终收尾记录写入本地 `SupervisorSessionJournal` 即刻完成结算，绝不被半开云端网络超时阻塞。
  3. **阶段二（循环排空直至稳定归零）**：以 `while` 循环反复等待所有未释放租约停止 Promise、派生本地日志收尾任务及运行时自身在途操作的 `Promise.allSettled(...)`，直至未释放租约与在途任务集合**同时稳定为空**。
  4. **阶段三（释放底层连接与句柄）**：排空循环退出后关闭全部客户端与上游 WebSocket、清除定时器、冲刷并关闭 `SupervisorSessionJournal` 句柄。

## 考虑过的替代方案

**同步阻塞等待工具返回，期间禁止新语音输入或在用户开口打断时一并取消在跑工具。** 落选原因：Qwen-Audio 3.1 Realtime 原生支持工具未回填期间正常进行多轮实时问答并在稍后接纳原 `call_id` 回填；同步阻塞或打断即杀工具会破坏“边聊边干”协作体验。

**在收到 `function_call_output` 的确认后无条件硬编码立即发送 `response.create`。** 落选原因：既与原生自动续答模型冲突，又会在异步工具延迟完成时打断用户正在进行的闲聊或思考余温期；通过 `capabilities.autoRespondOnToolOutput` 解耦并将延迟续答移交话轮静默礼让缓冲池，才能兼顾快速直通与异步礼让。

**使用 Typert `@Remote({ mode: 'stream' })` 承载实时双向音频流，或由浏览器直连云端 WebSocket。** 落选原因：Gateway 逻辑流受 `streamInboxBytes` 上行缓冲约束且不适合持续高频音频背压隔离，而前端直连会暴露凭据并在切页刷新时丢失 Host 权威会话与日志状态。

**在自动 VAD 活跃连接上动态修改 `turn_detection` 或在线逐条发送 `conversation.item.delete`。** 落选原因：上游禁止在发送音频后修改 `turn_detection`，在线逐条删除无跨条目事务，改用带六元组 CAS 校验的隔离候选连接轮换完全契合协议边界。

## 验收标准

- 通过本地伪造（Mock）的 Qwen-Audio 3.1 Realtime WebSocket 上游与真实 Cordis Loader 完成自动化单元测试，覆盖：
  - **GUI 依赖、授权校验与 Flash / Plus 模型配置**：外层入口在缺少宿主服务时仍对畸形配置同步抛错进入 `FAILED`；缺失 `webServer`、`connection` 或 `credentials` 时结算边界核查准确报错；支持 `qwen-audio-3.1-realtime-flash` 与 `qwen-audio-3.1-realtime-plus` 建连与静默轮换切换。
  - **非阻塞边聊边干与续答解耦验证**：（a）工具进入后台 `'running'` 期间，验证用户发送新文字或语音轮次正常完成问答且在跑工具未被 `abort`，工具稍后完成后原 `call_id` 正常回填确认并移交礼让缓冲池（不直接抢发 `response.create`）；（b）当轮无插话的快速工具在静默态下走 Fast-Path 即时触发单次 `response.create`；（c）`autoRespondOnToolOutput: true` 模拟适配器下不重复发送手动 `response.create`；（d）工具运行期间触发说话中途静音连接轮换，验证新连接不拷贝半截未配对 `function_call`，工具随后完成时走 `'bridged_after_rotation'` 安全写入日志与续答缓冲。
  - **意图槽位、播放水位、日志与 Cordis P0 租约循环排空回归测试**：覆盖创建在途打断不误绑新代际、单调 `upToAudioSeq` 播放排空、`failed_dirty` 自动轮换恢复、六元组 CAS 冲突放弃切换，以及消费者与提供方双向交错 `dispose()` 下底层资源零提前释放。

## 风险

- **自动模式下说话中途静音及异常恢复的连接切换耗时**：空闲静音零重连开销，但在话音未落时突然点击静音或遭遇上游确认超时触发强制轮换时，需经历一次后台 WSS 握手与闭合文本历史重放（数百毫秒至一秒余）。
- **声学特征不跨连接重放**：`SupervisorSessionJournal` 持久化结构化文本上下文而不落盘原始 PCM 波形，候选连接轮换后继承完整对话事实与后台异步工具成果，但不保留旧连接的原始声学副语言特征。
