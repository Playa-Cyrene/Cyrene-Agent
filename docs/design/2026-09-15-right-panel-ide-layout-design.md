# 右侧面板 IDE 化改造：施工方案（定稿）

> 本文是 [dsh 右侧面板对照](2026-09-15-dsh-right-panel-diff-comparison.md) 与 [工作区打开与文件浏览设计](2026-09-15-workspace-open-files-review-design.md) 之后落定的实施方案。经两轮外部评审（codex review）修正，结论：**不移植 dsh 的 dockkit，用成熟轮子组合完成 IDE 式右栏**。

---

## 决策记录

### 为什么不用 dsh 的 dockkit

1. **右栏宽度不归 dockkit 管**。dsh 源码明确：右栏整体宽度、推挤聊天区与全屏布局由外层布局（`ui-layout` 的 AppFrame）负责；dockkit 只提供面板内部的标签页、拆分、拖放和浮窗。
2. **dockkit 是预稳定内部引擎**。其 README 声明 "Internal engine... may change in any release"，键盘可访问性与样式接口尚不完整。
3. **依赖非零**。源码引用 clsx、DSH 图标组件、Tooltip 与品牌类型；npm 发布版仍声明 Cordis peer 依赖与 React 18（本项目是 React 19，npm 安装有双 React 实例风险）。
4. **文件树与文件预览不在 dockkit 内**，dsh 分别维护 `ui-sidebar-files` 和 `ui-sidebar-documentpreview`，且都深度绑定其会话插槽与 Cordis 框架，无法单包复用。

### dsh 源码使用政策

- 全仓库为 MIT 协议（版权方 DeepSeek），法律上可复制，需保留版权声明。
- **第一轮施工零复制 dsh 源码**；dsh 仅作为交互参考。
- 图标与品牌组件**一律不用 dsh 的**，使用本项目自有图标体系（lucide-react）。
- 将来若确认需要"面板内部分屏、跨面板拖动、浮窗"，再评估引入 dockkit（作为带来源与 commit 记录的 vendored 分支维护，需在 `THIRD_PARTY_NOTICES.md` 登记 MIT 声明）或 `dockview-react`。

### 技术选型（复用组合）

| 能力 | 方案 | 说明 |
| --- | --- | --- |
| 右栏拖宽 | `react-resizable-panels` | 支持 React 19，MIT，维护活跃；只管尺寸不管浮窗 |
| 标签页 | `antd` Tabs（项目已装） | 关闭、切换、激活、溢出滚动开箱即用 |
| 文件树 | `antd` Tree | 懒加载 |
| 文件预览 | `shiki`（项目已装） | 代码高亮 |
| 差异查看 | 现有 `ReviewInspector` 原样保留 | `RunReviewTracker` 数据层不动 |
| 面板骨架 | 改造现有 `RightInspector` | 移除固定 620px |

自定义代码只保留业务接线：标签标识、同文件去重、活动标签管理、宽度持久化、IPC 安全读取。

---

## 设计

### 标签标识（必须稳定且可去重）

- 文件树：`files`
- 文件预览：`file:<规范化路径>`
- 差异查看：`diff:<runId>:<文件路径>`
- 计划：`plan:<会话标识>`

同一标识重复打开时**激活已有标签**，不新开。

### 状态隔离

标签状态（打开的标签、活动标签、各标签宽度）必须按 **会话 + 工作区** 隔离，切换会话或工作区时不能把 A 项目的文件带进 B 项目。

### 宽度持久化

- 使用 `react-resizable-panels` 的默认布局恢复宽度，通过 `onLayout`（布局调整完成回调）持久化；**禁止监听鼠标移动逐帧写盘**。
- 默认 45% 窗口宽，限制范围 320px ～ 窗口的 70%。

### IPC 文件读取安全

- 新增目录列表与文件读取 IPC，每次读取都从会话绑定的工作区出发。
- 用 `realpath` 校验最终路径仍位于工作区内，防止通过 symlink 越界。
- 限制预览文件大小，识别二进制文件并给出提示而非乱码。

### 第一轮明确不做

内部拆分、浮窗、跨面板拖放，以及任何 dsh 源码复制。

---

## 执行步骤

### 1. 可拖宽右栏 ✅（2026-09-15 完成）

`RightInspector` 移除固定 620px（`RightInspector.css`），套 `react-resizable-panels`。默认 45%、320px～70% 窗口、宽度持久化。

验证：拖宽流畅、重启后宽度保留、聊天区保持最小阅读宽度。

实施：ChatPage 用 `Group/Panel`（chat 区常驻防重挂载）+ `useDefaultLayout`（`onLayout` 指针释放后才写 localStorage，不逐帧写盘）；拖动条命中区 24px（外溢到两侧，视觉条仍 12px）。

### 2. 四类标签 ✅（2026-09-15 完成）

建立 `文件树 / 预览 / Diff / 计划` 四类标签，antd Tabs 承载，同标识去重激活。

验证：同文件重复点击不新开标签、关闭活动标签后回退到相邻标签。

实施：标签 ID 规范 `files` / `file:<路径>` / `diff:<runId>:<路径>` / `plan:<会话>`；RightInspector 重写为 antd Tabs（editable-card，chip 自带关闭）；同一 run 的多个文件可同时开多个 diff 标签；切会话清空全部工作区标签。

### 3. 文件树与安全读取 ✅（2026-09-15 完成）

antd Tree 懒加载（首次只请求根目录，展开再请求该层）；IPC 读目录/文件，realpath 校验 + 大小限制 + 二进制识别。

验证：越界路径拒绝、超大文件与二进制文件提示、目录读取失败有明确状态。

实施：`workspace-files-ipc.ts`（realpath 双重校验防 symlink 越界、隐藏文件过滤、条目上限 1000、1MB 上限、\0 占比 >5% 判二进制）；安全测试 9 个（`workspace-files-ipc.test.ts`）；文件树用 `Tree.DirectoryTree`（点击目录名即展开）。

### 4. 接差异数据与文件预览 ✅（2026-09-15 完成）

`ReviewDiffContent` 迁入 diff 标签（行为不变）；shiki 渲染当前文件。差异标签与当前文件标签明确区分"本次差异"与"当前文件"两种语义。

验证：现有 diff 打开/关闭/切换行为与改造前一致。

实施：diff 标签与文件预览标签各自独立（`diff:` / `file:` 前缀区分语义）；预览用 shiki 单例（github-light 主题，按扩展名选语言，渐进式上色，失败保持纯文本）。

### 5. 观察期后再议

实际使用后确认确实需要"内部左右分屏、标签拖放、浮窗"时，再评估 dockkit（vendored 方式）或 `dockview-react`。

---

## 验收清单

- [x] 拖宽后宽度正确恢复（重启保留）— useDefaultLayout + onLayout 持久化
- [x] 同一文件不重复打开标签（去重激活）— openDiffTab / openFileTab 按 ID 去重
- [x] 关闭活动标签后正确回退 — closeInspectorTab 优先左侧相邻标签
- [x] 切换会话/工作区不串标签 — activeSessionId 变化时清空工作区相关标签
- [x] 越界路径（含 symlink）拒绝访问 — 安全测试覆盖（9/9 通过）
- [x] 超大文件与二进制文件给出提示 — TOO_LARGE / BINARY 错误码 + i18n 文案
- [x] 现有 diff 审查行为无回归 — chat 全量测试 53 文件 451 个通过
