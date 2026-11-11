# DSH 共享 UI 原子组件参考（`@deepseek-ai/dsh-client-ui-primitives`）

## 概述

`@deepseek-ai/dsh-client-ui-primitives` 提供 DSH Web 客户端共享的纯 React 原子控件、图标、锚定浮层以及面向不可信模型输出的 Markdown / 代码 / 终端渲染器。组件不导入 Cordis 运行时；调用方通过本地化字典提供文案 label，颜色与排版自动读取 `--dsw-*` 设计 token（参见 [Web UI 样式参考](web-styling.md) 与 [主题与 Token 参考](ui-theme.md)）。

在客户端插件中编写自定义控件前，先查阅下方目录复用已有原语，不复制已有控件。

<a id="component-catalog"></a>
## 组件目录

| 导出 | 用途与契约 |
|---|---|
| `Button` | 可点击操作；`variant` 选择 `primary`、`ghost`、`outline` 或 `toolbar`。`ref` 指向原生按钮，供焦点控制与浮层锚定使用。 |
| `Switch` | 36×20 双态开关；`label` 必填以确保无障碍名称。 |
| `SegmentedControl` | 两段或更多等宽分段加滑动指示块的互斥模式切换 tablist，自带方向键导航。 |
| `SegmentedTabs` | 受控的等宽分段标签，支持滑动指示条及左/右方向键、Home、End 导航。 |
| `Checkbox` | 带本地化 `label` 的受控原生复选框。 |
| `Input` | 单行文本输入，用于搜索框与行内表单，`ref` 指向原生输入框。 |
| `InlineEditor` | 自动聚焦的多行行内编辑器（最多六行后滚动）；Enter 保存，Shift+Enter 换行，IME 组合中 Enter 不提交，Escape 取消。 |
| `Menu`, `MenuItemButton`, `MenuGroup` | 下拉菜单、嵌套子菜单与吸顶分组标题，内置上下方向键走位、Escape 关闭与锚点焦点归还。 |
| `Pill` | 可选中的胶囊按钮（`active` + `onClick`），用于独立开关的筛选器或 24px 行内状态胶囊。 |
| `Tag` | 11px 只读胶囊徽章；`tone` 选择八种语义配色之一。 |
| `StateDot` | 10px 状态点（`done`、`warning`、`error`、`idle`）及同相旋转的 14px `ongoing` 加载态；`appearance="step"` 渲染步骤勾与空心圆。 |
| `ConnectionIndicator` | 行内连接状态胶囊，覆盖断线重试、连接中与已恢复三种状态。 |
| `DisclosureRow` | 24px 紧凑折叠行，标题与内容左右排列，支持 `headerAccessory` 独立操作。 |
| `TextShimmer` | 从左向右扫过单行文字与分隔符的柔和流光动效，遵循减少动态效果偏好。 |
| `Modal`, `useModalLayer`, `closeTopModal` | 页面遮罩之上的居中对话框，共用顶层 Escape / Tab 焦点陷阱与关闭回焦；用 `data-modal-autofocus` 标记初始聚焦控件，不使用原生 React `autoFocus`。 |
| `RiskConfirmation` | 以显式复选框把关的敏感操作确认。 |
| `Tooltip` | 锚定在子元素上的悬停与键盘聚焦提示，支持 `portal` 渲染到外层及信息按钮的 `openOnClick`。 |
| `HoverCard`, `HoverCardGroup` | 带离开宽限期与可选复制按钮的悬停预览卡片，列表内可设置 `grouped` 共享首次延迟并互斥切换。 |
| `ImageLightbox` | 支持焦点恢复与 Escape 关闭的原图预览浮层。 |
| `Toast` | 顶部居中的瞬时通知横幅，停留时长由 `holdMs` 控制。 |
| `SettingsForm`, `SettingsValueField`, `SettingsSecretField` | 插件设置页暂存表单框架、普通值字段（含已覆盖标记与重置）及不回显密文的密钥字段。 |
| `SettingsFormModel`, `settingsNumberField`, `settingsTextField` | 插件设置页背后基于设置 scope 的草稿暂存与保存模型。 |
| `MarkdownText`, `MarkdownDelegateProvider`, `CodeBlock` | 流式安全的 GFM + TeX 数学公式渲染、受控外链/本地文件导航委托与 Shiki 语法高亮代码块。 |
| `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock` | 对应各类工具结果意图的折叠输出卡片，内置 ANSI 解析与复制工具栏。 |
| `JsonTree`, `JsonBlock` | 支持长字符串折叠与单行复制的只读 JSON 检查器。 |
| `PathLabel`, `FileTypeIcon`, `LinkIconRegular`/`Medium` | 溢出保留尾部的文件路径标签、28px 分类文件图形与站点识别链接前置图标。 |
| `icons/*`, `FishLogo`, `BrandWordmark` | 产品双线重图标（`Regular` 1px / `Medium` 1.3px，`size` 控制尺寸）与品牌标识。 |

## 易混控件区分

- **`Tag` 与 `Pill`**：11px 只读徽章用 `Tag`；可点击切换（`active` + `onClick`）或落在 24px 文本行上时用 `Pill`。
- **`Pill` 与 `SegmentedControl`**：一组可各自独立开关的筛选项用一排 `Pill`；在互斥模式中选一并需要 tablist 键盘交互时用 `SegmentedControl`。
- **`DisclosureRow` 与设置卡片**：`DisclosureRow` 是固定 24px 左右排列的折叠行；标题叠在描述之上的卡片布局属于业务插件自建样式（材质遵循 [设置卡片材质](ui-radius.md#settings-cards)）。

<a id="rendering-agent-output"></a>
## 渲染输出与本地化文案

- **输出渲染**：`MarkdownText` 默认为 `variant="body"`，思考流等次级内容使用 `variant="compact"`（13px 字号、20px 行高、tertiary 文字色与默认点状下划线链接）。外层包裹 `MarkdownDelegateProvider` 可接管安全净化后的 HTTP(S) 链接与本地工作区文件行号跳转。
- **强制外部注入文案**：`ui-primitives` 不读取全局 locale，所有面向用户的提示、无障碍标签与空状态文本均须由插件从自身的 locale 字典传入对应 label prop。

<a id="input-modality"></a>
## 焦点与输入模态

弹窗自动聚焦与关闭回焦统一使用 `focusWithoutRing(element)`，抑制自动回焦时的外轮廓线；用户按下 Tab 或方向键切换到键盘模态后自动恢复标准 `:focus-visible` 焦点环。
