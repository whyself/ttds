# Agent Note: TTDS 总体设计理念与边界架构

Status: implemented

## 问题

DeepSeek Harness（DSH）内置编码会话生命周期与插件扩展体系，但缺少可自然开口交流的全双工实时语音交互能力。若直接以文本朗读或阻塞式工具流改造主界面，不仅交互停顿感强，还会把大段编码回复和工具日志塞进语音信道；同时，将外部服务商连接和私有状态直接耦合进宿主核心，会破坏扩展隔离与多提供方演进。

## 决策

TTDS（`@whyself/ttds`）定位为面向 DSH 的独立解耦插件包，以**全双工口语交流**与**边聊边干异步执行**为总体架构基线，通过 [packages/ttds/cordis.patch.yml](../../../../packages/ttds/cordis.patch.yml) 注册单个顶层 Cordis 入口（[packages/ttds/src/index.ts](../../../../packages/ttds/src/index.ts)），全部能力严格经 DSH 公开服务、事件、waterfall 与 UI 插槽协作。

### 五项核心架构边界

- **前端轻量保活，宿主掌握全局权威**：浏览器仅承担麦克风 16kHz PCM16 采集、24kHz 音频排队播放、输入动作发送与实时声波渲染，且将状态控制器和 Web Audio 资源托管在插件顶层插槽上下文（[client/index.ts](../../../../packages/ttds/src/client/index.ts)），切出主舞台不会断线或丢声音；真实凭证（插件配置与 `DASHSCOPE_API_KEY` / `WORKSPACE_ID` 环境变量回退）、上游模型连接、持久化日志及 DSH 工具调度一律保留在宿主服务端（[voice-runtime-adapter.md](2026-11-11-voice-runtime-adapter.md)）。
- **拟人化短句对话与工具纪律门禁**：内置基线提示词（[voice-instructions.ts](../../../../packages/ttds/src/shared/voice-instructions.ts)）约束语音模型像面对面交谈般用 1 至 3 句口语优先给出核心结论，且在需要查看或操作 DSH 会话、工作区与搜索时必须在当前回合发出 `function_call`；运行期由服务端对“口头答应但不调工具”输出补充 `tool_promise_nudge` 提醒，固定关闭语音模型自带检索（`enable_search: false`）以统一复用宿主 `ctx.web`，并在新建语音会话时从文本日志静默恢复近期对话背景（[journal.ts](../../../../packages/ttds/src/runtime/journal.ts)）。
- **模型可见即已记录且全程脱敏**：语音轮次、文本直投、工具调用、回填结果、钩子通知及连接恢复摘要全部写入单会话顺序 JSONL 日志 `SupervisorSessionJournal`（默认位于 `join(dshHome, 'ttds', 'sessions')`）；写盘与向客户端输出诊断错误帧前均由 `redactText` 和结构脱敏器剥离 API 密钥、`sk-*` / `Bearer` 凭证及原始音频数组（[journal.ts](../../../../packages/ttds/src/runtime/journal.ts)）。
- **工具独立并发执行与宿主协同审批**：模型发出的 `function_call` 交由独立租约后台执行并异步回填，语音通话不被磁盘读写、Git 命令、联网检索或弹窗确认阻塞（[voice-tool-registry.md](2026-11-11-voice-tool-registry.md)）；高权限写工具支持在 `ui`（界面弹窗确认）与 `auto` 间切换，其中 `dsh_resolve_tool_approval` 强制不可自动确认，并通过前置 `approval/request` waterfall 的 `VoiceApprovalHostBridge`（[host-bridge.ts](../../../../packages/ttds/src/tools/host-bridge.ts)）与网页 UI 竞速决议。
- **礼让式事件聚合与无打扰舞台呈现**：后台 DSH 事件与工具完成信号进入有界优先级缓冲区，仅在语音信道连续静默满 `quietGraceMs`（默认 `1800` ms）并通过自操作回声抑制窗口后批量注入提醒（[event-hook-engine.md](2026-11-11-event-hook-engine.md)）；客户端依托宿主 `main`、`sidebar.panellist`、`shell.overlay`、`plugins.bundle.config` 与 `plugins.detail.badge` 五处公开插槽构建极简声波舞台、跨会话拖拽胶囊微球及原生详情配置页（[client-ui-stage.md](2026-11-11-client-ui-stage.md)）。

## 考虑过的替代方案

- **在浏览器侧直连实时语音服务商并由前端调 DSH API**：虽能减少一层中继，但会把 API Key 下发给渲染端、导致切页销毁 WebSocket 与录音上下文，也无法可靠聚合后台多个会话的生命周期事件。
- **同步串行执行工具或直接替模型修改宿主原生插件内部状态**：同步阻塞导致语音长期无声甚至断流；改写 DSH 私有文件或绕过 `approval/request` waterfall 会使网页界面与语音工具看到的会话及审批状态产生分歧。
- **每次重连使用全量原始音频重放上下文**：音频重放延迟高且消耗巨大上下文预算，在宿主侧落地轻量文本投影日志兼顾离线可重放与快速无感接续。

## 后果

- 语音对话、后台桥接工具与 DSH 主代理并发推进而互不卡顿；全部配置经过 `TtdsConfigSchema` 校验并支持运行时热更新（`loader/volatile-update` 与 `settings/document-updated`），且可通过 `registerAdapter` / `register` 扩展第三方服务商、工具和钩子而不侵入主逻辑。
- 面向语音模型的返回数据严格在工具边界截断投影（如会话条数上限、单条消息限长与 `git diff --stat` 限长），因此语音助手在默认口语汇报中不会直接获得大段代码全文或长报错栈。
- 子系统具体契约与细节决策由四篇配套记录分别承载：[语音运行时与适配器](2026-11-11-voice-runtime-adapter.md)、[异步语音工具注册表](2026-11-11-voice-tool-registry.md)、[事件钩子引擎](2026-11-11-event-hook-engine.md)与[客户端舞台与配置页](2026-11-11-client-ui-stage.md)。

## 测试

- 插件包通过真实 DSH Loader 组合 `cordis.patch.yml` 并校验全组件启停、热配置解包及彻底注销验证见 [packages/ttds/tests/loader.spec.ts](../../../../packages/ttds/tests/loader.spec.ts)。
- 文本模拟全双工端到端闭环（多轮通话、并发工具、界面确认、无断连热更新、静默礼让钩子与日志重放）见 [packages/ttds/tests/e2e/text-simulated-voice.e2e.spec.ts](../../../../packages/ttds/tests/e2e/text-simulated-voice.e2e.spec.ts)。
