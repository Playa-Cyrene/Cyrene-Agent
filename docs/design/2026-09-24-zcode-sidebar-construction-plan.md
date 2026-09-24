# Cyrene 项目／会话侧栏施工方案

日期：2026-09-24。产品与视觉规则见 [项目与会话侧栏迁移方案](./zcode-sidebar-migration.md)。本文件供直接施工使用；每个阶段完成、验证后再进入下一阶段。

## 1. 施工边界与基线

- 参考 ZCode 本地源码提交 `872ad960de7ec172591f7e1952f7849229f94521`。复用其项目排序、顶层分组节点、组成员变换和拖放预览规则，按 Cyrene 的会话 ID、模式和工作区绑定改造。迁入源码时记录源文件，保留 Apache License 2.0（Apache 2.0 许可证）所要求的声明与修改说明。
- Cyrene 的会话内容及元数据继续由 `src/main/chats/chats-store.ts` 管理。侧栏组织文件只保存引用和顺序，不复制消息、标题、时间或工作区权限。
- 项目视图拖动项目；分组视图拖动组和会话。把会话放入自定义分组不改变工作区绑定。`chat`／`learn` 仍使用现有模式列表；`work`／`code` 共享项目与分组组织。
- 当前工作树已有许多未提交改动，尤其是 `package.json`、`package-lock.json` 和 React 页面。施工前对将要修改的文件逐个查看当前差异，只编辑本功能相关内容。按用户约定在现有分支施工；不自行创建分支或提交。

## 2. 文件清单

| 动作 | 文件 | 职责 |
| --- | --- | --- |
| 新增 | `src/shared/sidebar-organization.ts` | 组织快照、项目、分组、排序节点和命令的数据契约 |
| 新增 | `src/main/chats/sidebar-organization-store.ts` | 初始化、校验、原子保存、修复悬空引用和版本升级 |
| 新增 | `src/main/chats/sidebar-organization-store.test.ts` | 旧会话初始化、重复引用、删除／置顶／跨模式、失败恢复 |
| 修改 | `src/shared/ipc-channels.ts`、`src/main/chats/chats-ipc.ts` | 读取快照、应用命令、变更广播及调用方隔离 |
| 修改 | `src/preload/index.ts`、`src/renderer/react/features/chat/pages/chat-page-bridge.ts` | 暴露带类型的侧栏读写和订阅接口 |
| 新增 | `src/renderer/react/features/chat/components/sidebar/sidebar-view.ts` 及测试 | 从会话元数据与组织快照生成项目视图／分组视图；适配 ZCode 纯重排逻辑 |
| 新增 | `src/renderer/react/features/chat/components/sidebar/sidebar-preferences.ts` | 安全读取／保存视图、排序、折叠和滚动偏好 |
| 新增 | `src/renderer/react/features/chat/components/sidebar/SidebarProjectTree.tsx`、`SidebarGroupedTree.tsx`、`SidebarSearch.tsx` | 项目树、分组树和全会话搜索 |
| 修改 | `src/renderer/react/features/chat/components/ConversationSidebar.tsx`、`ChatPageNavigation.tsx` | 接入双视图，复用现有重命名、置顶、删除与项目详情操作 |
| 修改 | `src/renderer/react/features/chat/pages/ChatPage.tsx` | 维护 Work／Code 的统一轻量列表、跨模式打开、变更刷新与稳定引用 |
| 修改 | `src/renderer/react/features/chat/components/ConversationSidebar.css`、`src/renderer/react/styles/react-root.css`、`src/renderer/ui/themes/pearl-white.css` | 侧栏层次、行状态、滚动与主题变量 |
| 修改 | `package.json`、`package-lock.json` | 引入拖拽库；大量条目时再引入虚拟列表库 |
| 同步 | `docs/design/react-frontend-visual-guidelines.md` | 记录聊天侧栏的新宽度、主题变量和导航规则 |

以上是预期触点；若已有模块足以承载某项能力，直接扩展现有模块，不为凑文件清单增加包装层。

## 3. 存储和接口契约

组织文件建议为 `<userData>/cyrene-chats/sidebar-organization.json`，与当前会话索引同目录，文件自身带 `version: 1` 和递增的 `revision`：

```ts
interface SidebarOrganizationV1 {
  version: 1;
  revision: number;
  projects: Array<{ id: string; workspaceRoot: string; hidden: boolean }>;
  projectOrder: string[]; // project id
  groups: Array<{ id: string; title: string; color: string }>;
  topLevelOrder: Array<
    { type: "group"; groupId: string } | { type: "session"; sessionId: string }
  >;
  groupMembers: Record<string, string[]>; // group id -> ordered session ids
}
```

项目通过规范化后的工作区路径去重，持久化 ID 在路径不变时稳定。首次启动从 `ChatSessionMeta.workspaceRoot` 建立项目；没有工作区的会话显示在「未归入项目」。项目即使无会话也能留在注册表。旧会话文件和 `index.json` 均无需迁移或重写。

主进程提供 `getSidebarOrganization()`、`applySidebarOrganizationCommand({ expectedRevision, command })` 和 `onSidebarOrganizationChanged()`。命令至少覆盖项目显示／隐藏／排序、分组创建／修改／删除，以及一次性提交顶层和组内完整顺序。每个命令返回最新快照；修订号不符时返回冲突及最新快照，前端取消旧预览并刷新，避免多窗口互相覆盖。发起窗口使用返回值更新，其他窗口通过广播刷新。

保存前按当前 `chatsStore.listSessions()` 校验会话存在、模式限于 `work`／`code`、组存在、同一会话不重复出现在多个位置；置顶会话保留原组织位置，只在渲染时抽到置顶区。删除会话后读取／写入时清除悬空引用；删除分组时将其成员按原顺序移到顶层。文件损坏时保留损坏原件并从会话索引重建可显示的列表。沿用当前临时文件写入后重命名的原子保存方式。

## 4. 逐步施工

### A. 锁定现状与依赖

1. 对第 2 节涉及的已修改文件检查 `git diff`，确认其他人正在做的改动，尤其不要覆盖 `package.json` 的现有变更。
2. 记录当前聊天侧栏截图：普通宽度、窄窗口、至少两个项目及置顶会话。记录 `ChatPageNavigation` 流式回复期间的现有渲染探针基线。
3. 引入 `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`（React 拖拽库，版本参考 ZCode 当前可用组合），保留现有 Ant Design（成熟界面组件库）的菜单和输入组件。`radix-ui` 与 `react-resizable-panels` 已安装。虚拟列表库等到大列表阶段再加入。

**阶段验收：** 锁文件只增加本功能依赖，不丢已有依赖；`npm run check:renderer` 能编译当前代码。

### B. 主进程组织数据

1. 建立共享类型和主进程存储。初始化只读会话轻量索引，并按规范化路径补齐缺失项目；显式隐藏的项目不因列表刷新自动重现。
2. 在 `chats-ipc.ts` 注册读取、命令和变更广播；在 preload（安全桥）及 `ChatStoreApi` 增加对应方法。不要让渲染层直接读写组织文件。
3. 完成命令校验、原子写入、修订冲突、损坏文件恢复与会话删除后的引用清理。打开隐藏项目或选中其会话时恢复项目显示。

**阶段验收：** 定向测试覆盖空数据、旧会话、路径大小写差异、重复归组、跨模式、删除会话、坏文件、两窗口旧修订写入和写盘失败。只运行相关测试与 `npm run build:main`、`npm run build:preload`。

### C. 统一侧栏数据与跨模式导航

1. `ChatPage.tsx` 为侧栏读取 `chatStore.list()` 的全模式轻量索引，并从中筛出 Work／Code；当前 `sessionsByMode` 仍负责现有模式内容和自动选择。`CHATS_CHANGED` 到达时同时刷新侧栏索引；本窗口的创建、重命名、置顶、删除和工作区绑定成功后也要主动刷新，因为现有广播刻意跳过发起窗口。比较新旧元数据后保留未变化数组的引用，避免流式回复穿透侧栏的 `memo` 隔离。
2. 从侧栏点击会话时，根据该会话元数据的 `mode` 调用现有选择流程，**同时**设置当前模式。现有 `selectSession(id, targetMode)` 只更新该模式的活跃会话 ID，施工时必须补上可见模式切换；补测快速连续点击时旧异步结果不会抢占新选择。
3. 保留已有重命名、置顶、删除、工作区打开和危险删除确认。增加侧栏搜索入口，搜索所有会话的标题和项目名，包括隐藏项目中的会话；从结果打开时恢复相应项目。

**阶段验收：** Work 项目中可打开 Code 会话并看到 Code 模式；反向亦然。搜索能找到隐藏项目中的会话。现有 Chat／Learn 模式仍能选中原列表会话。

### D. 项目视图

1. 在 `ConversationSidebar` 的 Work／Code 分支接入项目树；未切换到新列表时继续使用现有 `@ant-design/x` 列表，保证阶段可运行。
2. 使用 `dnd-kit` 的排序上下文实现项目行拖动：指针移动超过约 8px 才启动，拖动浮层保持原宽，约束纵向并支持键盘排序。项目展开内容随项目一起移动，不把会话当作跨项目拖放目标。
3. 项目顺序、显示／隐藏和项目详情接入组织快照；视图切换、项目折叠、会话排序方式和各视图滚动位置接入侧栏偏好。会话按置顶与最近更新排序；排序方式切换时项目的手动顺序保持不变。

**阶段验收：** 项目点击与拖动互不误触；项目顺序、折叠状态重启后恢复；拖动不会改变任何会话的 `workspaceRoot`；置顶会话只显示一次。

### E. 分组视图

1. 适配 ZCode 的顶层节点、组成员和纯重排函数到 Cyrene 的 `sessionId`。先让创建、改名、改色、删除、移入和移出分组通过菜单可用，再接拖放。
2. 分组行与会话行分别注册拖动和落点；处理组头、组尾、空组、未分组顶层与组内会话落点。拖动时只更新本地预览，松手后提交完整顺序；失败或版本冲突时撤销预览并刷新。
3. 浮层挂到窗口根部以避开滚动裁剪；固定拖动宽度，避免不同高度的行被拉伸；靠边时自动滚动。折叠组拖动时记录并恢复折叠状态。

**阶段验收：** 组和会话均能排序，会话可跨组及移回顶层，空组能接收会话。快速拖放、取消拖动、保存失败和跨窗口改动均不会丢会话或产生重复。

### F. 视觉、宽度和长列表

1. 给聊天侧栏增加专用类，例如 `.cy-chat-sidebar`。让该类及中间滚动容器透明，透出 `.cy-page` 的浅粉底色；**不要**直接把公共 `.cy-page-sidebar` 改透明，因为设置页也使用它。选中、悬停、拖动和滚动条颜色放进主题变量；白色工作区和底部装饰保持现状。
2. 聊天侧栏从 192px 调到约 252px，窄窗口可折叠。用现有 `react-resizable-panels` 评估左侧宽度调整，保持现有右侧面板及聊天主区组件实例稳定；宽度约束 220–340px，并恢复用户保存的宽度。
3. 当顶层或单个组内会话超过约 80 行时接入 `@tanstack/react-virtual`（虚拟列表库）。参考 ZCode 的动态高度测量和缓冲行；先核对拖放预览、滚动锚点与「显示更多」的交互，再开启阈值。较短列表保持普通渲染。
4. 更新视觉约定文档，确认中文、英文长标题、时间标签、选中项、浅色主题和窄窗口。侧栏样式不影响聊天正文、Markdown（标记语言）和设置页。

**阶段验收：** 滚动区域与侧栏底色连续，顶部操作与底部头像固定；拖宽时聊天内容不重挂载；100 个以上会话仍能顺畅滚动和拖动。

## 5. 验证顺序与交付

每阶段先运行新增加的定向测试。涉及主进程、预加载或渲染类型的阶段分别运行 `npm run build:main`、`npm run build:preload`、`npm run check:renderer`；侧栏完成后再运行 `npm run build:renderer`。`npm run dev` 下用真实会话执行：旧数据启动 → 新建项目／分组 → 拖动 → 关闭并重开窗口 → 跨模式选中 → 置顶／取消置顶 → 搜索隐藏项目 → 删除会话 → 断开写盘权限模拟失败。检查流式回复期间侧栏渲染探针和聊天输入状态。

交付时列出迁入的 ZCode 源文件、许可证与变更声明、Cyrene 新增依赖、实际验证结果和未解决问题。保留旧会话索引作为读取兜底；如果新侧栏出现严重问题，可临时切回当前 `Conversations` 展示层，组织文件留在磁盘供修复后继续使用，不对用户会话做逆向迁移。
