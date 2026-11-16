# Agent Note: 语音运行时内核与服务商适配器架构

Status: implemented

## 问题

实时语音总管需要在同一个长期会话内同时处理持续的双向 PCM 音频流、跨工具并发回填、后台事件定时注入、用户打断播报，以及配置更新或断流重连；若服务商连接代码直接读写传输层、UI 状态或环境变量，不仅凭据暴露风险高，也难以扩展新服务商或安全排空在途异步清理逻辑。

## 决策

以宿主实例级服务 `VoiceRuntimeService`（[runtime-service.ts](../../../../packages/ttds/src/runtime/runtime-service.ts)，服务名 `ttdsRuntime`）统一掌管语音状态机、协议游标、租约排空、日志恢复与配置热更新；外部语音模型通过 `VoiceRuntimeAdapter` / `VoiceAdapterSession` 契约接入，浏览器经认证过的控制 RPC 与音频 WebSocket 与宿主同步（[transport.ts](../../../../packages/ttds/src/runtime/transport.ts)）。

### 配置契约与脱敏视图

- **分组配置与显式回退**：[config.ts](../../../../packages/ttds/src/shared/config.ts) 定义的 `TtdsConfigSchema` 将选项拆分为 `provider`（默认 `'qwen-realtime'`）、`providers['qwen-realtime']`（凭据依次优先配置值，缺省时显式回退至 `DASHSCOPE_API_KEY` 与 `WORKSPACE_ID` 环境变量；默认模型 `'qwen-audio-3.1-realtime-flash'`，可选 `'qwen-audio-3.1-realtime-plus'`；默认音色 `'longanqian_v3.1'`；`maxHistoryTurns` 范围 `5..50` 默认 `20`）、`voice`（`turnDetection` 支持 `'smart_turn_v2' | 'smart_turn' | 'server_vad' | 'push_to_talk'` 默认 `'smart_turn_v2'`，`threshold` 默认 `0.5`，`silenceDurationMs` 范围 `200..2000` 默认 `800`，`startMuted` 默认 `false`，设备偏好及 `customInstructions`）、`tools`、`hooks` 与 `storageDir`（默认 `join(dshHome, 'ttds', 'sessions')`）。
- **指令合成与凭据隐藏**：`composeVoiceInstructions` 将基准口语提示词（[voice-instructions.ts](../../../../packages/ttds/src/shared/voice-instructions.ts)）与用户 `customInstructions` 合并；暴露在快照 `VoiceSessionSnapshot.config` 中的 `ClientSafeTtdsConfigView` 只含 `hasApiKey` 与 `apiKeySource`（`'config' | 'env' | 'none'`），不回传明文钥匙或本地存储目录等敏感信息。

### 多服务商抽象与 Qwen Realtime 适配

- **动态适配器注册**：调用 `runtime.registerAdapter(adapter)` 可注入自定义提供方实现并返回同步销毁器（注册同 ID 适配器会抛出异常）。
- **Qwen Realtime 协议映射**：[qwen-adapter.ts](../../../../packages/ttds/src/runtime/qwen-adapter.ts) 内置适配阿里云百炼 WS 服务，建连握手附加 `Bearer` 与业务空间请求头、推送 `session.update`（固定强制 `enable_search: false`，将 `'push_to_talk'` 映射为 `turn_detection: null`，将 `'smart_turn_v2'` / `'smart_turn'` / `'server_vad'` 写入上游对应参数）；工具输出回填显式等待与 `callId` 匹配的确认回执，上下文提示发送等待 `conversation.item.created` 回执并在空闲时视需要发出 `response.create`。

### 代际指针、租约排空与分级配置热更新

- **单调指针与闲忙判定**：运行时在内部维护单一活跃上游连接及单调计数器 `connectionEpoch`、`inputAdmissionSeq`、`emittedAudioSeq` 与 `drainedAudioSeq`；所有来自已替换连接世代或停机后的回调均由世代比对拦截，防止状态漂移。当且仅当连接就绪、相位为 `'listening'` 且非推理中、在有音频客户端时浏览器已确认播放追平（`drainedAudioSeq >= emittedAudioSeq`），`isQuietForWakeup()` 才允许钩子与自动唤醒接入。
- **消费租约（`ConsumerLease`）**：外部模块发起在途工作（如后台工具调用或钩子投递）前先调用 `acquireLease()` 取得与运行时取消信号联动的租约；销毁或停止会话时运行时立即关闭新租约准入、中止既有信号并等待所有挂起租约显式释放后再闭合上游传输。
- **分级热更新与隔离候选连接轮换**：收到宿主插件热配置或设置文档更新时，运行时评估变动等级：若仅开关只读工具或 `quietGraceMs` 等本地字段仅原地更新视图；若涉及音色、判停参数、提示词或工具列表等会话级选项直接向活跃连接发 `session.update`；若涉及切换提供方、`apiKey`、`workspaceId`、`baseUrl` 或底层模型 ID，则构造隔离候选连接完成握手、按序重放最近文本对话日志（排除内部 `tool_promise_nudge`）并通过 `bridgeToolOutput` 转交待汇总工具钩子后，切换活跃引用并平稳断开待替换连接。

### 历史对话静音恢复、补全响应与工具纪律纠偏

- **跨重启背景恢复**：[journal.ts](../../../../packages/ttds/src/runtime/journal.ts) 在新建或重启语音会话开启时扫描目录中按时序排列的近期 `.jsonl` 日志（自动跳过缺失与损坏文件），提取并裁剪近期轮次摘要通过系统上下文通知注入【历史对话恢复】（落盘类型为 `hook.injected` 下 `history_restored`），模型据此静默保持跨连接话题连续性。
- **智能判停兜底与无工具承诺纠偏**：在 `smart_turn` / `smart_turn_v2` 模式下收到用户终稿 ASR 若上游未主动触发回复，运行时补推 `response.create` 保证应答；若模型返回仅含口头承诺查改任务而未包含 `function_call` 且近期工具空跑时，自动注入一次性 `tool_promise_nudge` 引导模型立即发出工具调用。

### 文本投影审计与公开宿主传输端口

- **递归脱敏 JSONL 账本**：`SupervisorSessionJournal` 拒绝包含路径穿越字符的会话标识，写入前串行化为有序 JSON 行，对包含 `apiKey`、`token`、`authorization`、`secret`、`audio`、`pcm`、`base64` 键名的节点及 `Buffer` / `ArrayBuffer` 一律打码替换，同步结合 `redactText` 擦除已解析密钥与凭据匹配串。
- **双向宿主传输面**：[transport.ts](../../../../packages/ttds/src/runtime/transport.ts) 基于公共端点注册 `/ttds/*` RPC（`status`、`start`、`stop`、`sendText`、`confirm`）并注册 `/api/ttds/realtime` HTTP WebSocket 升级路由；所有进线升级均走 `webCtx.connection.admitConnection(req)` 鉴权及连接撤销信号绑定，限制入站文本帧最大 `256 KiB` 并严格执行字段校验，当单个消费者输出队列溢出 `1 MiB` 时触发背压关闭避免宿主机内存积累。

## 考虑过的替代方案

- **配置任何参数变更时无条件强制断流重连**：实现最简单，但修改只读工具可见度、静音礼让时长甚至只调微调阈值都会切断当前语音和上下文连续性。分级更新配合候选连接热切换消除了不必要的断线感知。
- **直接使用独立数据库存储跨会话历史且保存完整原始 PCM 波形**：大幅增加打包体积和额外原生长驻进程依赖；遵循 `SupervisorSessionJournal` 纯追加 JSONL 文本投影加递归脱敏，零额外原生依赖即可满足可重建性与可审计性。
- **在客户端通过直连代理或明文下发临时令牌完成音频握手**：仍需在服务端维护票据生命周期且难以防止页面切页与刷新造成的双活冲突。固定宿主为唯一权威会话宿主并通过统一通道多播快照，彻底收敛状态来源。

## 后果

- 无论服务商增删与否，上层 UI 与工具、钩子子系统都不直接依赖百炼报文结构；即使底层出现断流，也能借助脱敏文本账本接续话题，并随插件停止彻底关闭客户端套接字和消费者租约。
- 同一个宿主实例在同一时刻维护一条主实时语音会话与唯一活跃上游通道，所有浏览器观测视图同源同步，简化了并发锁设计与多窗格状态一致性问题。

## 测试

- 日志写入脱敏与目录防御、历史重放、`QwenRealtimeAdapter` 握手及错误关闭、运行时游标递增、`acquireLease` 停机排空、隔离轮换、无工具承诺纠偏及 `history_restored` 验证见 [packages/ttds/tests/runtime/runtime.spec.ts](../../../../packages/ttds/tests/runtime/runtime.spec.ts)。
- 公共 RPC 派发、`/api/ttds/realtime` 鉴权准入与撤销中止、非法与二进制帧拒收、下行背压断流及错误脱敏验证见 [packages/ttds/tests/runtime/transport.spec.ts](../../../../packages/ttds/tests/runtime/transport.spec.ts)。
