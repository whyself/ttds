# DSH 主题与 Token 参考（`@deepseek-ai/dsh-client-ui-theme`）

## 概述

宿主 `@deepseek-ai/dsh-client-ui-theme` 让用户在设置中选择 `light`、`dark` 或 `system`，并分别设置正文、代码与终端的字体和字号。插件通过 `ctx.theme` 消费不可变的 `ThemeSnapshot`，并在组件 CSS Modules 中直接读取 `--dsw-*` / `--dsw-alias-*` 设计 token，不自行管理主题状态（参见 [Web UI 样式参考](web-styling.md)）。

## 常用语义 Token 与材质约定

- **菜单与浮层材质**：公共菜单通过 `MenuSurface` 共享 `--dsw-menu-surface-fill` 和 `--dsw-menu-backdrop-filter`；菜单吸顶分组标题使用 `--dsw-alias-menu-group-header-fill`；没有菜单底层的独立浮层使用 `--dsw-specific-menu`。模态遮罩保留黑色半透明填充，不模糊背景。
- **层级投影与发丝描边**：`--dsw-elevation-stroke` 经可重绑的 `--dsw-elevation-stroke-color` 绘制 `0.5px` 发丝描边；`--dsw-elevation-panel`、`--dsw-elevation-prominent` 与输入框专用的 `--dsw-elevation-soft` 在描边之上叠加两层极淡柔光。高层级表面设置 `border: 0` 并直接使用上述 `box-shadow` 变量（[组件规则](web-styling.md#component-rules)）。
- **圆角与超椭圆曲线**：`base.css` 提供 `--dsw-radius-xs`（4px）、`--dsw-radius-sm`（8px）、`--dsw-radius-md`（12px）、`--dsw-radius-lg`（16px）、`--dsw-radius-xl`（20px）与 `--dsw-radius-panel`（28px）；`corner-shape.css` 在支持的引擎上应用 `superellipse(1.5)`，圆形与胶囊半径需配对 `corner-shape: round`（[统一圆角规范](ui-radius.md)）。
- **焦点环与输入模态**：`:focus-visible` 使用 `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`（浅色 `#4176E6`，深色 `#7AAAFF`）与 `--dsw-focus-ring-width`（标准 `2px`）。指针模态下非可编辑元素的焦点环自动透明，键盘导航恢复显示。
- **系统提示与状态色**：Toast 使用 `--dsw-alias-toast-bg` 与 `--dsw-alias-toast-label`；开关滑块使用 `--dsw-alias-switch-thumb`；文字扫光使用 `--dsw-alias-label-shimmer` 与 `--dsw-alias-label-deep-diving-shimmer`。
- **排版与字号阶梯**：正文字体栈读取 `--dsw-font-family`，代码字体栈读取 `--ds-font-family-code`，品牌字体读取 `--dsw-font-family-brand`（内置离线 Montserrat）。正文基准字号由 `--dsh-content-font-size`（默认 14px）与低一档 `--dsh-content-font-size-secondary`（默认 13px）控制；代码块由 `--dsh-code-font-size`（默认 11px）控制。
- **滚动条重绑**：`body` 默认将 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 绑定到基础表面 l1 token；菜单、浮层、对话框等高层级表面可在自身容器上重绑为 l2 token 或 `transparent`，不编写组件私有的 `::-webkit-scrollbar` 选择器。

## 注册扩展主题覆盖

组合需要在进程内注册自定义主题时，可通过宿主 `ctx.theme` 注册带别名 token 覆盖的第三方主题 id；普通功能插件（如语音控制面板与状态浮层）直接消费现有 `--dsw-alias-*` token 即可自动适配浅色与深色模式。
