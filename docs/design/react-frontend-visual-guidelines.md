# React 前端视觉与组件约定

> 记录当前已确认的界面方向和代码入口，供后续修改前端时对照。更新界面实现时，同步检查这份约定；实际尺寸、颜色以代码中的变量和样式为准。

## 视觉方向

- 关键词：可爱、简约、视觉舒服轻松。参考 ZCode 的文字层级、留白和控件手感，保留昔涟自己的浅粉色工作区与品牌气质，不逐像素照搬。
- 让文字和内容先被看见。大面积背景保持轻、浅、安静；粉色主要承担选中、焦点、主操作和少量点缀，不用一串互不相关的粉色表达同一级状态。
- 控件圆润，边框和阴影轻。卡片负责把相关设置包在一起，行间分隔清楚；不要让设置项悬浮在背景图上，失去所属关系。
- 通用界面图标优先复用 `lucide-react`；品牌标识使用项目已有的品牌图标资源并保留其本色，不统一染成主题色。天气卡片允许保留独立的深色玻璃质感。

## 页面骨架与文字

- 工作区左侧使用浅粉背景，中间是浅白色内容区，底部现有装饰图形保留。设置在同一个 React 窗口中切换成设置视图，左侧变为设置导航，提供“返回工作区”；当前导航项必须有可见底色。
- 设置页沿用工作区的整体骨架。当前侧栏宽 `192px`，设置内容最大宽 `832px`，卡片圆角 `12px`，设置行最小高 `72px`；具体值见 [页面样式](../../src/renderer/react/features/settings/AppearanceSettingsPage.css) 和 [工作区样式](../../src/renderer/react/styles/react-root.css)。
- 设置正文与说明为 `14px / 1.5`，普通导航字重 `400`、选中导航 `500`，侧栏分组标题 `12px / 500`；页面标题在普通窗口为 `24px`，宽窗口为 `30px`。这些是当前代码的文字层级，不要求聊天正文和 Markdown 内容跟着变化。
- 设置卡片内一行由左侧名称与说明、右侧操作组成。较长的英文、翻译文本和窄窗口不能把按钮或分段选项撑出卡片；必要时让文案换行、控制区收缩或整行改为上下排列。

## 样式代码入口

| 要改什么 | 从哪里开始 |
| --- | --- |
| 基础字号、间距、圆角等尺度 | [tokens.css](../../src/renderer/ui/tokens.css) |
| 浅色主题的语义色，如表面、文字、边框和强调色 | [pearl-white.css](../../src/renderer/ui/themes/pearl-white.css) |
| 旧窗口共用的主题适配 | [theme.css](../../src/renderer/ui/theme.css) |
| React 工作区骨架和现有 `--cy-*` 变量 | [react-root.css](../../src/renderer/react/styles/react-root.css) |
| 设置页排版、卡片、导航和 Ant Design 外观适配 | [AppearanceSettingsPage.css](../../src/renderer/react/features/settings/AppearanceSettingsPage.css) |
| 设置页基础控件及其外观 | [SettingsControls.tsx](../../src/renderer/react/components/ui/SettingsControls.tsx)、[SettingsControls.css](../../src/renderer/react/components/ui/SettingsControls.css) |
| 聊天功能栏与消息正文 | [ChatComposer.css](../../src/renderer/react/features/chat/components/ChatComposer.css)、[ChatMessageList.css](../../src/renderer/react/features/chat/components/ChatMessageList.css) |

颜色优先使用 `--rb-surface-*`、`--rb-text-*`、`--rb-border-*`、`--rb-accent` 这类语义变量。新增主题时让主题文件覆盖语义变量，组件继续使用同一名称。`tokens.css` 保留基础尺度和默认值；每个主题独立维护自己的颜色覆盖。

当前还存在两处需要在后续主题工作中处理的重复定义：`react-root.css` 直接声明了部分 `--cy-*` 工作区颜色；`theme.css` 与 `pearl-white.css` 都覆盖了部分浅色主题变量。修改颜色前先核对 [React 样式加载顺序](../../src/renderer/react/index.html) 和最终生效值。此约定描述目标与现状，并不表示深色主题已经接通。

## 控件选用

| 场景 | 优先使用 | 保留专用实现的情况 |
| --- | --- | --- |
| 普通文本、数字、密码 | `SettingsInput`、`SettingsPasswordInput` | 带后缀按钮、单位、步进器或特殊校验的字段 |
| 简单单选下拉 | `SettingsSelect` | 可搜索、多选、异步加载等复杂选择器 |
| 滑块、开关 | `SettingsSlider`、`SettingsSwitch` | 需要当前封装尚未提供的交互时，先评估扩展封装 |
| 分段选择 | `SettingsSegmented` | 非分段语义的单选按钮组 |
| 按钮、弹窗和复杂表单 | 项目已使用的 Ant Design 组件 | 仅在现有组件无法满足交互时另作评估 |

简单下拉、滑块和开关的交互基础来自 Radix UI；分段选择沿用 Ant Design，再套用本项目的圆润外观。页面只负责选项、状态、校验与保存逻辑。控件需具备清楚的选中、悬停、键盘焦点、禁用和加载状态；分段选中块及其滑动动画都应保持胶囊形。系统要求减少动态效果时，停用非必要动画。

## 修改前后的核对

1. 找到同类现有页面和上表中的代码入口，再确定要改的变量或组件；避免在新页面另写一套相同控件。
2. 同时查看中文、英文长文案以及较窄窗口，确认标题、按钮、输入框和下拉不会互相挤压。
3. 检查默认、悬停、选中、焦点、禁用、加载状态；设置保存或即时应用行为应与修改前一致。
4. 影响全局文字或颜色时，单独检查聊天功能栏、Markdown 正文、代码块和天气卡片。设置页的排版规则限定在 `.cy-settings-page`，不要扩散到消息内容。
5. 若设计方向或代码入口发生变化，同次修改更新本文对应段落，让后续工作能沿着最新实现继续。
