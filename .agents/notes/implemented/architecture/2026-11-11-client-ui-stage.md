# Agent Note: 极简声波主舞台、跨会话微球与原生详情配置页

Status: implemented

## 问题

实时语音总管在浏览器端存在多重视觉与生命周期矛盾：用户在主舞台专注全双工对话时，密集参数按钮或表格会破坏口语交流心流；当用户转入代码会话查看工作区更改、点击其它页面时，若随视图卸载而断开媒体流，会话和音频上下文会被强制终止；同时插件界面必须遵守 DSH 的无侵入包管理体系、统一圆角规范、主题语义 token 与集中化字典管理。

## 决策

客户端作为独立浏览器入口 `@whyself/ttds/client`（[client/index.ts](../../../../packages/ttds/src/client/index.ts)）随宿主 UI 初始化挂载，将长期网络与音频生命周期交由全局唯一实例 `TtdsClientController`（[controller.ts](../../../../packages/ttds/src/client/controller.ts)）与 `TtdsAudioEngine`（[audio-engine.ts](../../../../packages/ttds/src/client/audio-engine.ts)）托管，面向 React 层暴露无副作用状态快照，并通过宿主 5 个公开插槽与标准清单字段分布全部界面入口。

### 包清单呈现与 5 处官方扩展插槽

- **识别度图标与详情介绍海报**：[packages/ttds/package.json](../../../../packages/ttds/package.json) 顶层声明 `"icon": "./icon.png"`（[icon.png](../../../../packages/ttds/icon.png)）并打包 `docs` 与 `locale/*.json`；[locale/zh.json](../../../../packages/ttds/locale/zh.json) 与英文包设定插件标题、介绍，并通过 `meta.detail` 指向精简图文详情文档 [DETAIL.zh.md](../../../../packages/ttds/docs/DETAIL.zh.md)（内含全景功能预览海报 [preview.zh.jpg](../../../../packages/ttds/docs/preview.zh.jpg)），在插件详情表单顶部呈现清晰的功能指引而非直接铺设长篇开发文档。
- **五插槽协同分布**：
  - `sidebar.panellist`（[SidebarPanelIcon.tsx](../../../../packages/ttds/src/client/SidebarPanelIcon.tsx)）：复用宿主 `FISH_LOGO_PATH` 在左侧栏嵌入入口，当会话在线或存在待确认卡片时亮起脉动活跃点。
  - `main`（[VoiceStagePage.tsx](../../../../packages/ttds/src/client/VoiceStagePage.tsx)）：主界面全双工语音总管舞台（面板 ID `'ttds'`）。
  - `shell.overlay`（[FloatingVoiceOrb.tsx](../../../../packages/ttds/src/client/FloatingVoiceOrb.tsx)）：离开 `'ttds'` 主面板时浮现跨会话保活悬浮微球及展开胶囊。
  - `plugins.bundle.config`（[TtdsSettingsView.tsx](../../../../packages/ttds/src/client/TtdsSettingsView.tsx)）：仅当目标包为 `@whyself/ttds` 时覆盖渲染四分区配置表单与状态摘要（未就绪时提供配置引导）。
  - `plugins.detail.badge`（[client/index.ts](../../../../packages/ttds/src/client/index.ts)）：在包详情页标题旁展示来自内核配置的百炼凭据状态 `<Tag>`（已配置 / 未配置）。
- **语言词典与主题设计系统**：所有用户可见字符串从命名空间 `'ttds'` 的 [locales.ts](../../../../packages/ttds/src/client/locales.ts) 严格双语等价字典读取，样式借助 CSS Modules 与 `clsx` 消费 `--dsw-alias-*` 及 `--dsw-radius-*` 语义 token，无硬编码色值或第三方 UI 依赖。

### 四态中空声波舞台与旁侧事件流

- **Canvas 2D 单色中空径向声波核心**：[VoiceRings.tsx](../../../../packages/ttds/src/client/VoiceRings.tsx) 以 72 根径向圆头针环绕居中的静止 `FISH_LOGO_PATH`（悬浮微球模式下精简为 32 根以适配 36px 紧凑空间）。`acousticState()` 将网络与会话相位映射至四种表现态并经时间积分平滑过渡：`off`（`baseLen: 26`, `deltaSpan: 0`, `speed: 0` 静止灰色外圈）、`standby`（`28 / 24 / 1.0` 微幅呼吸，覆盖建连、思考及监听期间人工闭麦状态）、`listening`（`32 / 62 / 2.5` 灵敏波动）与 `speaking`（`36 / 110 / 3.4` 饱满舒展）。内核通过 `MutationObserver` 跟踪文档根节点属性自适应主题明暗切换，并响应系统 `prefers-reduced-motion` 自动静止动画。
- **舞台主栏与可折叠渐隐事件流**：[VoiceStagePage.tsx](../../../../packages/ttds/src/client/VoiceStagePage.tsx) 中部仅呈现声波圆环、最新一行实时字幕与精炼状态（含缺失 API 密钥时的配置引导胶囊）；底栏集成麦克风启停/闭麦切换、受 `observeComposition` 保护防止中文输入法候选回车误触的文字直投框（未建连时发送会自动拉起语音会话）、发言打断钮（仅 `speaking` 显露）、`push_to_talk` 专属提交录音钮（仅 `push_to_talk` 且未闭麦时呈现）、挂断按钮，以及堆叠呈现的界面确认允许/取消卡片。旁侧事件流可自由收折，由控制器以单调递增的 `feedOrder` 顺序维护至多 `200` 条记录，即使实时 ASR 终稿略迟于助手首帧文本到达也不会出现对话顺序倒挂。

### 跨会话悬浮微球与三边半露保活

- **全双工脱壳伴随**：`FloatingVoiceOrb` 在通话连接非断开且主面板处于编码会话或其他页签时自动呈现，支持在 `44×44` 收缩圆形声波球与 `162×44` 横向纯图标胶囊（静音切换、回到主舞台、挂断）间动画转换，并在出现待确认操作时智能按视口方位弹出悬浮确认气泡。
- **无级拖拽与贴边收隐**：支持指针捕获拖动并结合 `--dsh-frame-overlay-top` 保护顶部窗栏留空区域；拖放靠近左右或上边界 `28` px 阈值内时自动切换收起态并贴边露半展示（存在待确认卡片时自动取消隐藏以确保安全提醒），窗体缩放时同步重钳位坐标。

### 全双工浏览器音频链路

- **音轨独立回收**：[audio-engine.ts](../../../../packages/ttds/src/client/audio-engine.ts) 通过可置换硬件工厂挂载 `AudioWorklet`（`ttds-capture`）将设备麦克风重采样为连续小端 16kHz 单声道 PCM16 送入服务器，并用单声道 24kHz `AudioBufferSourceNode` 串联排程无缝播放下行音频，直到实际播完回调再向上游反馈 `playback.drained`（点击打断即刻中止在播片段并清空队列而不谎报已播毕）。
- **闭麦保听与延迟权限兜底**：开启闭麦立即停止工作线程与销毁 `MediaStreamTrack` 释放系统录音图标，同时保留 `AudioContext` 与扬声器输出设备以持续播放完助手尾音及后台事件提示；输出设备切换在支持 `setSinkId` 时可实时生效；插件注销时会跟踪等待异步挂起的 `getUserMedia` 与 `addModule` 授权承诺彻底清理全部音轨与对象 URL。

### 二级包详情页四分区原子配置表单

- **版本栅栏暂存草稿模型**：[settings-model.ts](../../../../packages/ttds/src/client/settings-model.ts) 将编辑值收集为与首次更改时 Host 配置版本 `revision` 绑定的本地草稿（并发改动若已落后则拒收），且彻底禁止在本地缓存与页面回显明文 `apiKey`（留空保存即保留原配置秘密值），离开页面放弃即清理草稿、保存失败保留现场输入供修改。
- **原生控件四分区布局**：[TtdsSettingsView.tsx](../../../../packages/ttds/src/client/TtdsSettingsView.tsx) 全部依托 DSH 原生 `SettingsForm`、`SettingsSecretField`、`SettingsValueField`、`Menu`、`Switch`、`DisclosureRow` 与 `Tooltip` 构建四节视图：① **语音服务与模型**（提供方、百炼 API 密钥与 `workspaceId`、Flash/Plus 模型切换、预设音色及自定义音色入口、4 种 `turnDetection` 模式含 `smart_turn_v2` / `smart_turn` 与条件显隐 `silenceDurationMs`、默认折叠的 `baseUrl` 高级展开区）；② **音频设备与通用交互**（动态枚举麦克风与扬声器且无 `setSinkId` 时自动提示跟随系统默认、连接后默认闭麦开关、自定义口语提示词附气泡点击查阅只读基准预置提示词）；③ **DSH 桥接工具**（只读巡检、经 `ctx.web` 的 `dsh_search` 及 `ui` / `auto` 确认模式开关）；④ **事件钩子与话轮礼让**（`quietGraceMs` 带边界校验输入框与 5 类内置后台事件开关）。

### 网络输入边界防守

所有经 WebSocket `/api/ttds/realtime` 抵达客户端的帧都在入状态前经过 [protocol-reader.ts](../../../../packages/ttds/src/client/protocol-reader.ts) 的纯手工字段类型及闭合鉴别标签验证，遭遇畸形结构或未知帧类型直接终止当前套接字并闭合媒体，防止脏帧污染声波组件状态或引发异常循环。

## 考虑过的替代方案

- **将 WebSocket 连接与 Web Audio 状态附着于 React 主舞台组件树中**：切回代码会话会立刻挂载失效导致通话中断且重启重连耗时明显。交由插槽宿主级别持有唯一的 `TtdsClientController`，各界面槽位仅作为无状态投影，实现了页面无感切换与跨界面确认联动。
- **使用全局固定顶部横幅或 DSH 顶层“设置”独立标签页**：增加设置主菜单噪声且破坏 DSH 包管理器收敛设计。依托 `plugins.bundle.config` 与 `plugins.detail.badge` 统一嵌入包详情页，配合 [DETAIL.zh.md](../../../../packages/ttds/docs/DETAIL.zh.md) 实现开箱即用的说明与配置一体化体验。

## 后果

- 浏览器端零外部 UI 框架依赖，随宿主昼夜主题与无障碍减动效设定无缝切换，并在不同平台（含不支持 `setSinkId` 的浏览器）安全降级扬声器控制项。
- 会话生命周期严格归属于顶层控制器及宿主清理流程，切换视图不断话，卸载或切闭麦均无悬空 `AudioWorklet` 或常驻麦克风权限泄露。

## 测试

- 客户端五处插槽全撤回、异步媒体权限滞后到场回收、未建连文本自动启流、`sinkId` 热切换、事件流跨启停保序及非法下行帧强防线测试见 [packages/ttds/tests/client/lifecycle.spec.tsx](../../../../packages/ttds/tests/client/lifecycle.spec.tsx)。
- 闭麦放开录音音轨保听播放、断续工作线程块重采样连续性、空音频及错截长度拒绝以及对象 URL 回收测试见 [packages/ttds/tests/client/audio-engine.spec.tsx](../../../../packages/ttds/tests/client/audio-engine.spec.tsx)。
- 四态声波展示、IME 防误触、悬浮微球展开收缩与贴边吸附、徽标隔离、四分区草稿校验与并发版本冲突保持验证见 [packages/ttds/tests/client/views.spec.tsx](../../../../packages/ttds/tests/client/views.spec.tsx)。
