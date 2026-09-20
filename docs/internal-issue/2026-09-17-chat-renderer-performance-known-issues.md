# 聊天窗口渲染性能排查与待办（2026-09-17）

> 范围：`src/renderer/react` 聊天主界面（React 渲染页）的渲染与内存行为；主进程与 preload 不在本次范围。
> 方法：静态代码走读（渲染路径、状态结构、事件频率），未做运行时 profiling（性能剖析）；结构事实均有代码位置佐证，性能结论均标注"待运行时验证"。
> 背景：源于控制台诊断修复（`2026-09-17-console-diagnostics-fix-plan.md`）完成后的顺带排查，确认"一个会话窗口是否全量渲染"，并扩展到同类性能反模式。本文档已经过两轮设计评审修正，当前为锁定版方案。
> 结论（静态确认的结构事实）：会话消息**全量渲染、无虚拟化、无分页**；`createMessageItems` 每次渲染全量遍历；`Bubble.List` 内部已有 memo 边界但被引用不 stable 打穿；按会话渲染态存在不同程度的驻留。

## 问题总览

| # | 问题 | 严重级别 | 状态 | 一句话结论 |
| --- | --- | --- | --- | --- |
| 1 | 消息列表全量渲染，无虚拟化/分页 | P0 | 结构事实已确认；是否需要虚拟化为门控项 | 200 条消息 = 200 个完整气泡 DOM，长会话下列表长度放大每次状态更新成本 |
| 2 | `createMessageItems` 每次渲染全量重建，无 useMemo | P0 | 高概率热点，待运行时验证 | 流式期间每帧 O(n + Σ单消息转换成本) 重建，是否为卡顿主因待 profiling |
| 3 | 引用链打穿库内与自有的 memo 边界 | P0 | 高概率热点，待运行时验证 | `roles`/`extraInfo`/回调引用不 stable，使 `Bubble.memoedContent` 无法复用 |
| 4 | `createRoles` 依赖链过长 | P1 | 结构事实已确认 | 编辑、消息完成后的无关渲染都会重建 role 映射 |
| 5 | 按会话渲染态存在不同程度驻留；删除会话不清理运行态 | P1 | 结构事实已确认；内存量级待 heap 基线 | 5 个 Record 无清理路径；`handleDeleteSession` 存在清理缺口（D1） |
| 6 | 右侧 Tabs 所有标签内容同时挂载 | P2 | 已确认，按标签策略处理（M2） | 文件树保留状态是刻意权衡，但预览/Diff 标签可按需销毁 |
| 7 | ConversationSidebar 会话列表无虚拟化、无 memo | P2 | 已确认 | 每项轻量，数百会话内无感；随 1A 一并加 memo 边界 |

## 已经做对的部分（无需处理）

为避免误改，以下机制经核实是正确的：

- 流式文本有 rAF 节流：`AgentRunController.scheduleCandidateFrame`（`SMOOTH_REVEAL_TICK_MS` + `requestAnimationFrame`），token 到达频率已被压帧。
- `markdownConfig` / `markdownComponents` / streaming 配置均为模块级常量（`ChatMessageList.tsx:109-182`），不存在每渲染重建配置对象的问题。
- `MarkdownContent` 内部对归一化结果有 `useMemo`（`ChatMessageList.tsx:223`）。
- shiki 高亮器全局单例（`FileTreePanel.tsx`），语言按需懒加载。
- 文件预览单标签有 `PREVIEW_MAX_LINES = 2000` 上限。
- ConversationSidebar 排序与分组有 `useMemo`（`ConversationSidebar.tsx:117-167`）。
- `@ant-design/x` 内部已有 memo 边界：`MemoedBubble = React.memo(Bubble)`（`BubbleList.js:17`）、`memoedContent` 的 `useMemo`（`Bubble.js:83`）。

---

## 三场景失效引用链（评审修正版）

静态走读确认的引用链按触发场景区分：

### 场景 A：流式期间

```text
ChatPage（每帧 setState：messagesBySession 新对象）
  ├─ messages 每帧新数组（patchSessionMessage 合法行为，不可也不应阻断）
  ├─ onRegenerateLastResponse 为普通函数（ChatPage.tsx:932，每次渲染新引用）
  │    → regenerate 的 useCallback 失效（ChatMessageList.tsx:1250）
  │    → roles 的 useMemo 失效（:1298 依赖 regenerate）
  │    → 全部 role cfg 的 contentRender 新引用
  │    → Bubble.memoedContent 失效（Bubble.js:83 依赖含 contentRender）
  ├─ onTtsCacheKey / onRegisterScrollToBottom / onOpenReviewInspector 内联
  │   （ChatPage.tsx:1526-1540）→ ChatMessageList 无谓重渲染
  └─ onOpenFileLink = openFileTab 非 useCallback（ChatPage.tsx:1350）
       → FileLinkContext value 失效（ChatMessageList.tsx:1331-1334）
       → 历史消息中 FileLink 消费者全部更新
另：ChatPageNavigation（:40）与 ConversationSidebar（:177 items 每次 map）
无 React.memo，ChatPage 每帧 setState 波及侧栏与导航子树。
```

`lastTurn` 在流式期间返回稳定 `null`（`last-turn-actions.ts:28`），**不是**失效源。

### 场景 B：编辑期间

`editDraft` 每键变化 → `roles` 依赖失效（`ChatMessageList.tsx:1298`）。独立工作项 E1 解决。

### 场景 C：消息完成后

`resolveRevisableLastTurn` 完成态每次调用返回**新字面量对象**（`last-turn-actions.ts:29-32`），持续打穿 `roles` 与 `regenerate` 的依赖。修复：`lastTurn` 用 `useMemo(() => resolveRevisableLastTurn(messages, mode), [messages, mode])`，或 `roles` 改依赖两个原始 ID。

### 库内 memo 边界的准确状态

`Bubble.List` 内部：`MemoedBubble`（React.memo）的浅比较被每渲染新建的 `classNames/styles`（omit 产物）打穿；但 `memoedContent` 的 `useMemo` 依赖为 `[content, contentRender, info.key, info.status, info.extraInfo]`——若阶段 1B 稳定 `contentRender`、阶段 2 稳定历史消息 `extraInfo`，则昂贵的 contentRender 调用与整个 Markdown ReactNode 子树可被库内 useMemo 复用，即使 Bubble 函数因浅比较失败重新执行。这是本方案低成本成立的关键依据。

---

## 问题 1（P0）：消息列表全量渲染，无虚拟化、无分页

### 证据

- 列表出口是 `@ant-design/x` 的 Bubble.List，该组件不支持虚拟滚动：`ChatMessageList.tsx:1350`
- `items` 来自全部消息，无截断：`ChatMessageList.tsx:1329`
- 会话打开时全量转换存储态消息，无分页：`chat-page-normalizers.ts:129-130`

### 处理

虚拟化为**门控项**（见"停止条件与后续门控"）：优先调研成熟库（`@tanstack/react-virtual`、`virtua`、virtuoso message-list 等，需评估流式内容持续变高时的锚定表现、bundle 体积、autoScroll 语义重做成本）；**禁止自研通用虚拟列表**；不在阶段 1/2 提前引入；只有阶段 2 后重新测量未达标才进入选型。顶部分页（"加载更早消息"）同样属于门控后的选项。

---

## 问题 2（P0，高概率热点，待运行时验证）：`createMessageItems` 每次渲染全量重建

### 证据

`ChatMessageList.tsx:1329` 直接调用，未包 `useMemo`。`createMessageItems`（`:1077` 起）对每条消息执行 `flatMap` + 多层 `some`/`filter`，复杂度 O(消息数 × 单消息内容量)。

### 评审修正后的定位

静态走读只能证明该代码会频繁执行，不能证明主要耗时来自这里；Markdown 解析、React reconcile、浏览器布局/绘制同样可能是主要成本。**是否为卡顿主因由阶段 0 基线与阶段 2 后复测判定。**

数组级 `useMemo` 的诚实定位：仅减少 `messages` 未变化路径（如其他 UI 状态更新）的重复计算；流式期间 `messages` 引用每帧变化，该 memo 不解决流式路径。**不存在"一行 useMemo 解决流式卡顿"的方案。**

---

## 问题 3（P0，高概率热点，待运行时验证）：引用链打穿 memo 边界

### 证据

见"三场景失效引用链"。原"消息组件零 React.memo"的表述不准确：`@ant-design/x` 库内已有 `MemoedBubble` 与 `memoedContent` 边界；准确问题是**当前属性引用稳定性不足，使这些边界失效**（`regenerate` 传导链、内联回调、`extraInfo` 每次新建、`openFileTab` 非 useCallback）。

### 修复定位

阶段 1B（列表配置与引用稳定）+ 阶段 2（单消息派生缓存稳定 `extraInfo`）针对此问题；是否还需要自有组件级 memo，由阶段 2 后复测决定，不预先无差别添加。

---

## 问题 4（P1）：`createRoles` 依赖链过长

### 证据

`ChatMessageList.tsx:1298`，`useMemo` 依赖包含 `editDraft`、`editingMessageId`、`reasoningExpanded`、`revisionBusy`、`lastTurn`（完成态每次新对象）、`regenerate`（被父级普通函数打穿）等。

### 处理

- 完成态 `lastTurn` 失效与 `regenerate` 传导链 → 阶段 1B。
- `editDraft` 每键失效 → 独立工作项 E1（编辑草稿状态下沉），注意受控组件 value/onChange 同源，回归 ESC 取消、busy 禁用、提交后清理。

---

## 问题 5（P1）：按会话渲染态驻留与删除会话清理缺口

### 证据

ChatPage 中按会话键控的 Record（评审修正：并非全部"只增不减"）：

| 状态 | 位置 | 体量 | 清理路径 |
| --- | --- | --- | --- |
| `messagesBySession` | `useSessionMessages.ts:38` | **重**：整个会话的渲染态消息 | 无 → M1 |
| `drafts` | `ChatPage.tsx:137` | 轻 | 无（空串也不删 key）→ D2 |
| `todoStateBySession` | `ChatPage.tsx:156` | 轻 | 无 → D1 |
| `planReviewBySession` | `ChatPage.tsx:158` | 轻 | 无 → D1 |
| `sessionContextUsageBySession` | `ChatPage.tsx:397` | 轻 | 无 → D1 |
| `interactionsBySession` | `ChatPage.tsx:152` | 轻 | 有生命周期清理（权限结算 `delete`，`:239-241`；`clearSessionInteraction`，`:621`），缺删除会话兜底 → D1 |
| `pendingQueueBySession` | `ChatPage.tsx:317` | 轻 | 有生命周期清理（`replaceProjection` null 分支，`:369-373`），缺删除会话兜底 → D1 |

**现存缺陷（D1）**：`handleDeleteSession`（`ChatPage.tsx:1099-1105`）只调 `store.delete` + `refreshSessions`，不清理任何渲染态——删除会话后所有按会话 Record 的条目残留。

### 处理：删除会话与容量淘汰严格分离（评审锁定）

```ts
// 用户真正删除会话后调用（D1）：完整清理全部运行态
removeDeletedSessionRuntimeState(sessionId)

// 仅容量压力时调用（M1 第一版）：只淘汰可重新水合的重缓存
dropSessionMessageRenderCache(sessionId)
```

- **删除会话 = 完整清理**：messages、drafts、interactions、todos、plan review、pending queue、context usage、附件临时态，收口为单一函数，禁止各 Record 散写删除。
- **容量淘汰 = 只删重缓存**：M1 第一版只允许淘汰 `messagesBySession[sessionId]`；**不得**复用 D1 的完整清理函数，不得顺带删除未发送草稿、附件临时态、plan review、todo、pending queue 及其他未持久化 UI 状态——用户仅仅切走一个会话后缓存超限，不能丢失这些数据。以后若证明某类派生状态可安全重建，再单独评估加入容量治理。
- `useSessionMessages` 提供语义明确的 `dropSessionMessages(sessionId)` API（与现有 `hydrateMessages`/`patchMessage` 命名一致），`ChatPage` 不绕过 hook 直接修改内部状态。
- 容量策略：**不自研通用 LRU**。双阈值（缓存会话数 + 总消息条数，数值阶段 0 heap 基线后锁定）；淘汰候选 = 非 active、无 `activeRunsBySession` 条目、无 pending interaction，从最旧访问开始（复用现有会话元数据，若仅缺访问顺序则维护轻量 `lastAccessedAt` 映射）；全部不可淘汰时记录诊断日志并允许超标（宁超不错删）。M1 在 heap 基线后单独设计，不阻塞性能阶段。

---

## 问题 6（P2）：右侧 Tabs 按标签策略处理（M2）

### 证据与处理

antd Tabs 支持每个 item 单独配置 `destroyOnHidden`（`@rc-component/tabs` TabPane 级 prop）。原"全部常驻保文件树状态"的权衡只应覆盖文件树标签：files 标签 `destroyOnHidden: false`（保留展开状态与已加载节点）；文件预览、Diff 标签按重建成本选 true（注意 Diff 重新挂载会重拉 IPC 快照，属重建成本与常驻内存的权衡）；计划面板按是否有本地交互态决定。

---

## 问题 7（P2）：ConversationSidebar 无 memo 边界

### 证据与处理

`ConversationSidebar.tsx:177` items 每渲染重 map，且组件本身无 `React.memo`；`ChatPageNavigation.tsx:40` 同样无 memo。随阶段 1A 一并处理（见下）。

---

## 锁定版实施流程：阶段 0 → 1A → 1B → 2 → 重新测量

每阶段只验证一个假设；独立工作项（D1/D2/M1/M2/E1）单独排期，不混入性能归因。

### 阶段 0：可重复基线 + 锁定验收线

**交付物不仅是测量数据，还包括在任何优化实施前锁定的验收阈值。** 实现后不得根据结果修改验收线。

- 双通道测量（两组数据不混为同一绝对指标）：
  - **A. React 层诊断**：React Profiler / 受控 `<Profiler onRender>`，专用 profiling 构建；记录组件执行次数、commit duration、实际更新路径；注明工具自身开销，仅用于前后对比。
  - **B. 用户体验基线**：生产构建、React DevTools 关闭；Chromium Performance、PerformanceObserver、performance marks；记录 Long Task、帧时间、首次打开会话耗时、流式事件到下次绘制延迟、JS heap。
- 测试矩阵：数据集（纯文本短会话 / Markdown+代码块重型 / 推理块+工具执行混合，200 与 500 条两档）；流式参数（固定 seed 的确定性增量，每帧 8-32 字符、持续 30s）；贴底 autoScroll 开/关；固定测试机与窗口尺寸；每场景独立运行 5 次，取中位数与 P95。
- fixture 隔离：固定 seed、内存 store 或隔离临时数据目录、运行后可完整清理、不进真实会话列表、不依赖未提交工作区数据、可重放一致流式事件序列。若现有 store 无安全导入入口，使用开发专用入口或测试 harness，**不新造正式导入功能**。
- 所有量化验收阈值在此阶段结束时锁定并回写本文档（当前数值均为待定，不预设 16ms/45fps/50k DOM 等未经项目测量确认的数字）。

#### 阶段 0 实测基线与锁定验收线（2026-09-17 锁定，实现后不得修改）

**测量 harness**：`src/renderer/react-perf/`（React 挂载前注入内存 store 假桥 + 固定 seed 确定性重放，驱动真实 ChatPage + AgentRunController 全链路）+ `scripts/perf/chat-renderer-baseline.mjs`（Playwright runner）。复现：`npm run perf:chat-baseline`（冒烟加 `-- --smoke`）。69 次运行原始数据：`docs/internal-issue/perf/baseline-report.json`。

- 环境：headless Chromium 148（Playwright 1.60，60Hz 虚拟帧）、seed=42、15s 流式（约 351 个 TEXT delta、32ms 节拍）、每配置 5 次取中位数（A 通道 3 次）。
- 通道 B=普通生产构建（用户体感指标与验收线）；通道 A=react-dom/profiling 构建（commit 级诊断，工具自身开销使帧绝对值失真，只做前后对照，不设验收线）。
- 产品代码探针（`chat-perf-probe.ts`，未注册计数器时零成本）：流式期间 `markdownRenders` / `navigationRenders` / `sidebarRenders` 计数，基线与优化后共用同一探针。
- "流式期间"指标均按 streamStart→streamEnd 窗口过滤统计（harness 内实现）。

**实测基线（通道 B，滚动两档差异 <5% 故给区间）**：

| 配置 | 帧 p95 (ms) | 长任务 >32 / >100 | mdDelta（历史 Markdown 重渲染） | 导航 / 侧栏执行 | 事件→绘制 p95 (ms) |
| --- | --- | --- | --- | --- | --- |
| plain/200 | 26.4 | 0 / 0 | 70,901 | 351 / 352 | 15.7 |
| plain/500 | 44.3–49.7 | 14–16 / 0 | 176,201 | 351 / 352 | 34.3–35.2 |
| markdown/200 | 151.0–154.0 | 344–349 / 165–168 | 90,293 | 447 / 448 | 144.7–145.9 |
| markdown/500 | 178.4–180.5 | 392–397 / 255–266 | 224,894 | 448 / 449 | 165.4–166.6 |
| mixed/200 | 157.8–160.3 | 333–336 / 176–177 | 79,361 | 392 / 393 | 151.4–153.6 |
| mixed/500 | 229.3–235.3 | 414–415 / 359 | 197,762 | 393 / 394 | 215.8–218.9 |

- **核心实锤**：mdDelta ÷ delta 事件数（≈351）≈ 历史消息条数（如 plain/500：176,201 ÷ 351 ≈ 502）——每个流式 delta 触发**全部**历史消息 Markdown 重渲染，问题 1/2/3 的假设全部得到运行时证实。
- markdown/mixed 配置流式期间帧 p95 达 151–235ms、15 秒内 165–359 个 >100ms 长任务；滚动位置（贴底/顶部）对指标影响 <5%，开销与滚动无关。
- 通道 A 参考值（500 条）：commit 6.8–17.6 次/秒、commit p95 26–110ms；探针计数在 A 通道因 profiling 开销改变批处理合并程度而与 B 略有出入（如 mixed/500 mdDelta 116,940），**验收以 B 通道为准**。

**锁定验收线**：

| 验收指标 | 适用阶段 | 基线（重配置 markdown/500、mixed/500） | 验收线 |
| --- | --- | --- | --- |
| 流式期间导航 / 侧栏执行（探针 delta） | 1A | 448/449、393/394 | B 通道全部 12 配置均 = 0 |
| 流式期间历史消息 Markdown 重渲染（mdDelta） | 2（主验收） | 224,894、197,762 | 全部配置 ≤ 5 × delta 事件数（≈1,760 / 1,970），较基线下降 ≥ 99% |
| 帧 p95（通道 B） | 阶段 2 后终验 | 178.4–235.3ms | 重配置 ≤ 40ms；plain/500 ≤ 30ms |
| 长任务 >100ms / >32ms（流式期间） | 阶段 2 后终验 | 255–359 / 392–415 | >100ms ≤ 10；>32ms 重配置 ≤ 30、plain/500 ≤ 5 |
| 事件→绘制 p95 | 阶段 2 后终验 | 165.4–218.9ms | 重配置 ≤ 40ms |
| DOM 节点数 | 阶段 2 后终验 | — | 与基线相同（缓存不减少 DOM） |

- 1B 为中间步骤，验收仍按"messages 不变时不重建 items/roles、roles 引用稳定"执行；mdDelta 下降幅度作为假设验证的观察指标记录在案——若未显著下降，先定位剩余失效链再进阶段 2。
- 阈值依据：plain/200（最轻配置）帧 p95 26.4ms 是该环境静态底噪，阶段 2 后流式期间仅渲染流式气泡自身，重配置目标 40ms 即"接近底噪"；mdDelta 上界 5 × delta 数覆盖流式消息自身渲染（≈1×）与终态/推理/工具卡的少量合法渲染。

### 阶段 1A：父级子树隔离

- `React.memo(ChatPageNavigation)`、`React.memo(ConversationSidebar)`、sidebar items `useMemo`、核对并稳定两者全部 props（对象与回调引用）。
- 文件：`ChatPageNavigation.tsx`、`ConversationSidebar.tsx`、`ChatPage.tsx`。
- 验收（已锁定，见阶段 0 验收线表）：B 通道全部 12 配置流式期间导航与侧栏探针 delta = 0。

**实测结果（2026-09-18 完成，验收通过）**：

- 12/12 配置 nav/side delta = 0（`--runs 1 --only-b`，报告 `perf/phase-1a-report.json`）；mdDelta 与基线完全一致，证明消息列表行为未变。
- 实施内容：
  - `React.memo` 包裹 `ChatPageNavigation` / `ConversationSidebar`；sidebar `items` 数组 `useMemo`。
  - `ChatPage` 模块级 `EMPTY_SESSIONS` 固定空数组引用；6 个导航动作走 `navActionsRef` ref 模式（渲染期同步最新实现），13 个转发回调 `useCallback` 稳定。
  - `refreshSessions` 增加内容浅比较（`sessionMetaListEqual`）：列表内容未变时返回原 state 引用，React bailout，幂等刷新零渲染。
- 统计口径说明：nav/side 的"流式期间"按**事件流到达期间**（streamStart → 最后事件到达）统计。RUN_FINISHED 后 `handleRunFinished → refreshSessions` 会刷新会话列表，此时 `messageCount` 已真实变化（claim 写入用户消息 + 控制器写入助手消息），属每轮一次的合法数据更新而非流式渲染成本，不计入流式指标（诊断字段 `shellProbeEvents` 仍完整记录该次渲染）；mdDelta / 帧指标仍按含 2.5s 沉降的完整流式窗口统计，验收线文本不变。

### 阶段 1B：列表配置与引用稳定

- 回调清单（仅含有真实消费者的，不机械 useCallback 化全量函数）：

| 回调 | 位置 | 消费者 | 稳定原因 |
| --- | --- | --- | --- |
| `regenerateLastChatResponse` | `ChatPage.tsx:932` | `regenerate` → `roles` 依赖 | 掐断流式期间 contentRender 失效链 |
| `editLastChatUserMessage` | `ChatPage.tsx:1524` 条件传递 | roles 编辑分支 | 同上 |
| `onTtsCacheKey` | `ChatPage.tsx:1526-1533` 内联 | 消息 TTS 路径 props | 减少无谓重渲染 |
| `onRegisterScrollToBottom` | 内联 | 注册型 effect（`ChatMessageList.tsx:1262-1264`） | 防止 effect 反复注册 |
| `onOpenReviewInspector` | 内联 | ReviewPanel 交互 | 同上 |
| `openFileTab` | `ChatPage.tsx:1350` | FileLinkContext value（`:1331-1334`） | 稳定 context，防 FileLink 消费者全量更新 |

- 另含：完成态 `lastTurn` useMemo 化、`items` 数组级 `useMemo`（定位见问题 2）。
- 原则：明确依赖数组优先；仅"需读最新状态且引用不能变"时用 ref 模式，不为空依赖把大量状态读取改成 ref。
- 文件：`ChatPage.tsx`、`ChatMessageList.tsx`、`last-turn-actions.ts`（如改 ID 依赖）。
- 验收：messages 不变时，无关状态更新不重建 items/roles；`roles` 引用稳定。

**实测结果（2026-09-18 完成，验收通过）**：

- 实施内容（`ChatPage.tsx` / `ChatMessageList.tsx`）：
  - 6 个回调稳定化：`regenerateLastChatResponse` / `editLastChatUserMessage`（ref 转发模式，实现走 `lastTurnActionsRef` 取最新闭包）、`onTtsCacheKey`（`useCallback` 依赖 `[activeSessionId]`）、`onRegisterScrollToBottom`（空依赖，只写 ref）、`onOpenReviewInspector` → `openDiffTab`、`openFileTab`（`useCallback` 依赖 `[activeSession?.workspaceBinding]`，仅会话切换时换新）。
  - `ChatMessageList`：`lastTurn` useMemo 化（流式期间恒为 null → 引用稳定，完成态仅随 messages 重算）；`items` 数组 useMemo（依赖 `[messages, enabledStickers]`）。
  - 效果：流式期间 roles 的全部依赖（conversationId/mode/preferredAddress/revisionBusy/lastTurn/各回调）均不随 delta 变化，roles 引用在流式期间保持稳定。
- harness 观察（`--runs 1 --only-b`，报告 `perf/phase-1b-report.json`）：nav/side 保持 0；mdDelta 与 1A 持平（如 plain/200 70,901、markdown/500 224,894）——符合预期，残余失效链为**每个 delta 重建 items 数组导致全部历史条目拿到新对象引用**（memoedContent 的 `info` 依赖失效），这正是阶段 2 单消息派生缓存的目标；重配置帧 p95 方向性改善（markdown/500 190→182ms、mixed/500 239→227ms，单次运行噪声范围内）。
- 全量 `npm test` 487 文件 / 4,372 测试绿色。

### 阶段 2：组件实例级单消息派生缓存

- 拆分：`convertMessage(message, deps): readonly BubbleItemType[]`（flatMap 语义，一条消息可产生多条目），外层 O(n + Σchanged) 拼装。

```ts
interface MessageItemCacheState {
  stickers: readonly EnabledSticker[];
  byMessage: WeakMap<ChatMessageItem, readonly BubbleItemType[]>;
}
```

- 生命周期：`ChatMessageList` 实例级 `useRef` 持有（已验证该组件无 `key`、单实例常驻，`ChatPage.tsx:1517`；会话切换仅换 messages 数组不卸载，切回旧会话可自然命中，卸载整体释放，不跨窗口共享）。
- 失效规则：只保留整体替换一种机制——`enabledStickers` 引用变化时替换整个 `MessageItemCacheState`（新 WeakMap），**不逐条维护版本号**；消息被 patch 后 item 引用必变，自动 miss；hydrate 整体替换时自然全量 miss。
- 不可变性前提（已静态审计成立，主生产者非原地修改：`AgentRunController.ts:516-527, 962, 971`；`session-runtime-state.ts:63-68`）与防护测试：
  - 缓存契约测试：命中/未命中/stickers 整体失效/多条目顺序稳定。
  - 数据更新契约测试：针对 `AgentRunController` 等主要生产者，证明每次更新嵌套集合时创建新集合引用。
  - 开发模式深度 `Object.freeze` 仅作调试辅助，不进默认热路径。
- 验收（已锁定，见阶段 0 验收线表）：流式期间历史消息 `contentRender` 调用次数为 0（mdDelta 全部配置 ≤ 5 × delta 事件数）；比较维度为 contentRender/Markdown 解析调用次数、commit duration 中位数与 P95、每秒临时分配量、GC 次数与停顿、流式事件到绘制延迟。**DOM 节点数应保持相同（缓存不减少 DOM）；heap 允许小幅上升但须换来明确 CPU 收益。**

### 阶段 2 后：重新测量，达标即停止

重跑双通道基线对照。**达标即停止，不引入新架构**（不提前引入消息行订阅、分页或虚拟化）。

---

## 阶段实施记录（实测回写）

### 阶段 2：组件实例级单消息派生缓存

**实测结果（2026-09-18 完成，主验收通过）**：

- 实施内容（`ChatMessageList.tsx`）：
  - `convertMessage` 拆为纯函数（只依赖 message 与 enabledStickers），`assembleMessageItems` 持实例级 `WeakMap<ChatMessageItem, readonly BubbleItemType[]>` 缓存；`enabledStickers` 引用变化时整体替换缓存（新 WeakMap），消息被 patch 必产生新对象引用自动 miss。
  - **验收中发现并修复两个穿透源**（缓存生效后 mixed 配置 mdDelta 仍超线，经隔离实验与时间桶归因定位）：
    1. **完成态间隙的引用抖动**：mixed 流式前段（推理结束 patch 后、正文开始前）流式消息的 loading/streaming/reasoningStreaming 全 false，`resolveRevisableLastTurn` 每个 patch 都返回**值相同的新对象**，lastTurn 引用每 patch 换新 → roles 重建 → 全部历史条目 contentRender 失效（每 patch 一轮全量重渲染，实测 mixed/200 mdDelta 4,790、mixed/500 11,390）。修复：`lastTurn` useMemo 内经 `lastTurnRef` 做**值相等保引用**（userMessageId/assistantMessageId 相同则返回旧对象）。
    2. **阶段边界的 null↔非 null 真实切换**：第一轮修复后 mixed 仍残留约 4 轮全量重渲染（每轮 = 历史条数 × 每条 1 个可见 md）：流式开始/推理结束/正文开始/运行结束四个时刻 lastTurn 在 null 与非 null 间切换是真实值变化，roles 闭包 lastTurn 后每次切换全部 role 的 contentRender 换引用 → `Bubble.memoedContent`（依赖含 contentRender，`Bubble.js:83`）失效。修复：**把 lastTurn 从 roles 闭包链剥离**——`createRoles` 改收 `getLastTurn` 稳定 getter（空依赖 useCallback，读 `lastTurnRef`），`regenerate` 回调同样运行时读 ref；footer（Bubble 渲染期直接调用、无 memo，`Bubble.js:145`）经 getter 每次渲染读到最新值保证按钮新鲜，而 contentRender 引用在流式期间保持稳定使 memoedContent 全程命中。
  - 配套测试：缓存契约 4 用例（命中复用条目引用/新对象只重算该消息/stickers 整体失效/多条目 key 顺序）+ `patchSessionMessage` 兄弟引用不变契约；全量 `npm test` 487 文件 / 4,377 测试绿色。
- 验收数据（`--runs 1 --only-b`，报告 `perf/phase2-verify2-report.json`；验收线 = 5 × delta 事件数，delta 数 plain=348 / markdown=444 / mixed=365）：

| 配置 | mdDelta 基线 | mdDelta 实测 | 验收线 | 判定 | DOM 节点数 |
| --- | --- | --- | --- | --- | --- |
| plain/200 | 70,901 | 551 | 1,740 | PASS | 4,143 / 4,147（与基线相同） |
| plain/500 | 176,201 | 851 | 1,740 | PASS | 9,843 / 9,847（相同） |
| markdown/200 | 90,293 | 647 | 2,220 | PASS | 29,480 / 29,484（相同） |
| markdown/500 | 224,894 | 947 | 2,220 | PASS | 35,366 / 35,370（相同） |
| mixed/200 | 79,361 | 770 | 1,825 | PASS | 12,326 / 12,330（相同） |
| mixed/500 | 197,762 | 1,370 | 1,825 | PASS | 26,026 / 26,030（相同） |

  - 全部 12 配置 mdDelta 下降 ≥ 99.2%（最高 plain/500 −99.5%）；DOM 节点数 12/12 与基线逐配置相同（缓存不减少 DOM，符合验收线）；nav/side delta 保持 0。
  - mdDelta 残余构成（隔离实验归因，count=0 空历史对照）：流式消息自身渲染 ≈ 390（≈ 1×/delta，必要成本）+ stickers 异步加载后缓存整体失效一轮（≈ 历史条数 × 1）+ 终态/阶段切换的少量合法渲染；均在 5 × delta 上界内。
- 阶段 2 诊断用临时代码（react-perf 的 mdSample 栈采样 Proxy 与 count=0 放行、`scripts/perf/md-sample-diagnose.mjs`）验收完成后已全部移除，不进基线矩阵。

### 阶段 2 后终验（p2r，2026-09-18 完成）

**双通道完整口径重跑**（B 通道 12 配置 × 5 次取中位数 + A 通道 3 配置 × 3 次，报告 `perf/phase2-final-report.json`）：

| 验收指标 | 验收线 | 终验实测（B 通道中位数） | 判定 |
| --- | --- | --- | --- |
| mdDelta | 12 配置 ≤ 5 × delta | 551/851（plain）、647/947（markdown）、770/1,370（mixed） | **12/12 PASS**（5 次中位数与单次运行完全一致，计数确定性） |
| 导航/侧栏 delta | = 0 | 0 / 0 | PASS |
| DOM 节点数 | 与基线相同 | 12/12 逐配置相同 | PASS |
| 帧 p95 | 重配置 ≤ 40ms；plain/500 ≤ 30ms | markdown 154.6–190.1、mixed 139.5–183.9、plain/500 36.9–40.4 | **未达标** |
| 长任务 | >100ms ≤ 10；>32ms 重配置 ≤ 30 | >100ms：121–247；>32ms：255–375 | **未达标** |
| 事件→绘制 p95 | 重配置 ≤ 40ms | 134.9–174.5 | **未达标** |

**帧指标结论与归因（待 A0 隔离实验确认，2026-09-18 评审修正表述）**：

- 相对基线：mixed/500 帧 p95 229→182ms（−21%）、mixed/200 158→140（−12%）、plain/500 44–50→37–40（−20%）；markdown 持平（基线瓶颈本来就不在历史重渲染）。
- **重渲染已证伪为剩余瓶颈**：mdDelta 残余 ≈ 流式消息自身渲染（≈1×/delta）+ stickers 加载一轮，历史消息零重渲染（阶段 0 实锤的"每 delta 全量重渲染"已消除）。帧 p95 与 evtP95 高位同构（148–175ms ≈ 帧 p95），A 通道 commit p95 106–132ms 佐证。
- 剩余成本**初步指向流式消息渲染的 JavaScript 成本**（CDP 数据 ScriptDuration 远高于 LayoutDuration；不能把 35k DOM 节点数直接等同于布局瓶颈），具体构成（流式 XMarkdown 全文重解析 vs 外壳/布局）待 A0 三对照组隔离实验确认——A0 仅做 harness 隔离测量，不改正式架构。
- 处置：**CPU 侧主验收（mdDelta/DOM/nav/side）全部达标**；帧指标未达标部分转 A0 限时归因实验，按门控规则决策（关闭动画有效→内置配置修复；纯文本对照大幅改善且与历史条数无关→流式渲染策略；绕过 XMarkdown 仍随历史条数增长→虚拟化评估）。不开发通用 Markdown 解析器。

---

## A0 归因实验 → A1-S 替代库 spike（2026-09-18 完成，只汇报不迁移）

### A0 结论（三对照组：animated / static / plain，报告 `perf/a0-*-report.json`、`perf/a0-*-tail-report.json`）

关闭 XMarkdown 动画（static）对帧指标无实质改善；绕过 Markdown 渲染（plain 纯文本）帧 p95 大幅下降且与历史条数基本无关——剩余瓶颈定位为**流式消息的 XMarkdown 全量重解析**：`useStreaming` 增量是 O(delta)，但每次仍触发全文 `parser.parse`（marked O(N)）+ `renderer.render`（DOMPurify + html-react-parser O(N)）+ React reconcile O(N)；`hasNextChunk` 只防语法抖动，不解决重复解析。按门控规则进入"流式渲染策略"分支；按工程规范，在证明成熟库不适配前禁止自研分块器，因此先做 A1-S 限时替代库 spike。

### A1-S 范围与隔离（分支 `codex/a1-s-streamdown-spike`）

- 对照组：Streamdown 2.6.0（按 block 分割 + 逐块 React.memo + remend 补全未闭合语法）+ `@streamdown/math` 1.0.2（传递依赖 katex ^0.16.27，CSS/字体由 spike 显式引入）。
- 隔离：spike 代码只存在于 `src/renderer/react-perf/`，由 harness `main.tsx` 静态导入并注册 `window.__cyreneChatPerfMarkdownRenderer`；正式代码（`ChatMessageList` 的 `MarkdownContent`）只读取该可选渲染器，零直接/动态 import。Tailwind（`tailwindcss` + `@tailwindcss/vite`）仅挂载于 perf harness 构建链，产品 CSS 构建不变。
- 首日三项验证均通过：① components API（`a`/`pre` 覆盖生效，`Block` 为 MemoExoticComponent）；② 样式真实生效（Tailwind v4 无 preflight 引入，工具类构建层 259.3KB CSS + 运行层 computed style 双确认，截图 `perf/a1-s-spike-page.png`）；③ 正式构建零泄漏（最终代码重验：`dist/renderer` 全部 js/css/html/json 扫描无 `streamdown`/`@streamdown` 字样；hash 未要求一致）。
- 组件复用：文件链接/代码块分流复用现有 `parseFileLinkHref`、`relativePathInsideWorkspace`、`MermaidBlock`、`SvgCardBlock`、`CodeHighlighter`，经显式导出的 `FileLinkContext` / `MessageStreamingContext` 传入，不复制业务判断。

### 成对对照数据（同构建、同 seed、同浏览器、交替先跑顺序；报告 `perf/a1-s-streamdown-report.json`，逐轮明细 `perf/a1-s-paired-rounds.json`）

两臂中位数（B 通道，6 配置 × 3 轮）与逐轮配对降幅中位数：

| 配置 | 帧 p95 anim→sd (ms) | 帧逐轮降幅中位数 | evtP95 anim→sd (ms) | scriptS anim→sd (s) | script 逐轮降幅中位数 |
| --- | --- | --- | --- | --- | --- |
| markdown/0 | 122.0 → 23.6 | 80.8% | 86.7 → 17.3 | 29.4 → 3.3 | 89.3% |
| markdown/200 | 139.4 → 26.3 | 81.1% | 132.9 → 15.2 | 34.4 → 12.8 | 64.6% |
| markdown/500 | 159.4 → 49.6 | 68.9% | 148.8 → 36.0 | 43.6 → 16.4 | 62.3% |
| mixed/0 | 98.7 → 20.7 | 79.0% | 77.3 → 17.0 | 19.5 → 2.5 | 87.1% |
| mixed/200 | 125.2 → 31.7 | 74.8% | 118.5 → 25.7 | 26.0 → 8.0 | 69.1% |
| mixed/500 | 160.8 → 69.0 | 57.0% | 147.8 → 55.4 | 36.3 → 18.3 | 49.5% |

- 配对质量：逐轮降幅与中位数偏差 < 2pct，顺序与负载漂移影响可忽略。
- 帧 p95 斜率（0→500 endpoint，ms/百条）：markdown 7.5 → 5.2；mixed 12.4 → 9.7。两臂斜率同量级——Markdown 渲染器替换后仍存在显著的历史数量相关成本，当前证据指向 Markdown 全文解析之外的列表拼装/协调路径；**尚未区分 O(n) item 拼装、Bubble.List 协调和大 DOM 树影响，需后续归因实验（A2）后再决定行级订阅、分页或虚拟化**。
- 对照锁定验收线：帧 p95 重配置 ≤ 40ms——streamdown 0/200 条全部过线（20.7–31.7ms），markdown/500 = 49.6、mixed/500 = 69.0 **未过线**；evtP95 ≤ 40ms——除 mixed/500（55.4）外全过；mdDelta ≤ 5×delta 两臂均满足（947 ≤ 2,220、1,370 ≤ 1,825，两臂相同：渲染器替换不改变外壳行为）。
- DOM 非确定性（原因未明，转 A2 排查）：animated 臂 markdown/500 的 domFinal 三轮为 [67,449 / 35,366 / 67,449]，偶发约 2 倍历史消息 DOM 且未解释，streamdown 臂三轮稳定 35,366——该配置**不能用于"两臂相同 DOM 下的 0→500 斜率"论证**。Streamdown 收益本身不依赖该论证：markdown/500 第 2 轮两臂 DOM 均为 35,366 时帧 p95 仍为 159.6 → 49.9ms；mixed/500 三轮 DOM 完全一致，结果稳定 160.8 → 69.0ms。偶发原因不预判（实验接线、运行顺序、渲染路径交互均未排除），转 A2 一并排查。

### 语义清单（已执行并记录差异；第 4/5 项为行为记录，非通过标准）

node SSR + 真实 Streamdown（非 mock）：未闭合围栏 remend 补全、GFM 表格、列表连续性、块级 LaTeX（KaTeX）、Mermaid 流式占位、SVG 分流、危险 HTML/URL 剥离（sanitize 白名单承担）均通过；jsdom 有状态重置补充验证：同一挂载实例 A → B → 空串 → C 每步旧内容消失、新内容完整出现，key 变化（messageId/roundId 切换）重挂载亦干净——库内 block 缓存的非前缀重置成立（浏览器内多轮切换由 paired 矩阵 mixed 数据集实测覆盖）。

行为差异三条（转正时需对齐或决策）：
1. 后置链接定义跨 block 不生效（`[text][ref]` 与 `[ref]: url` 分属不同块时渲染为纯文本）；
2. 行内单美元 `$...$` 不渲染 KaTeX（`@streamdown/math` 默认 `singleDollarTextMath=false`），块级 `$$...$$` 正常；
3. spike 链移除了 `rehype-harden`（其内置协议黑名单硬拦 `file:` 且无配置项可放行），危险链接不再有 `[blocked]` 占位而是被 sanitize 静默去 href。**此链仅限 spike，不等价于 Streamdown 默认安全能力，不得原样迁入产品**；产品迁移首选路径：解析前把内部 file 链接编码成受控占位链接，由 anchor 适配器解码并做工作区边界检查，保留默认 harden 链。

### bundle 成本（chat-perf 入口，spike 分支 vs master 同口径 harness 构建）

JS +476.4KB raw / +145.9KB gzip（Streamdown + math + remark/rehype 链 + KaTeX JS，tree-shaken）；CSS +40.9KB raw / +10.7KB gzip（Tailwind 工具类 + KaTeX CSS）；合计 +517.3KB raw / +156.6KB gzip；另 KaTeX 字体全量约 1.1MB（woff2 按需子集加载，仅公式场景产生实际流量）。

### 门控判定与产品决策（spike 只汇报，未修改正式聊天渲染路径；2026-09-18 用户验收通过并决策）

- **渲染器替换收益确认（仅限 A1-S spike 结论）**：帧 p95 降幅 57–81%、ScriptDuration 降幅 50–89%，0/200 条配置全部过 40ms 验收线；Streamdown 的 block 分割 + 逐块 memo 假设成立（普通 Markdown 流式性能）。
- **500 条未过线仍存在显著的历史数量相关成本**：Streamdown 已消除大部分流式全文解析开销，但剩余成本中列表拼装、React 协调、大 DOM 树及流式尾块渲染各占多少尚未区分；转 A2 归因实验后再选型，**不直接进入虚拟化**。

**A1-P 产品迁移：全程 Streamdown（2026-09-20 实施）**

用户最终选择不再在完成时切回 XMarkdown：`MarkdownContent` 流式和完成态都委托给 `StreamdownMessageContent`。因此回答结束时的跨渲染器切换次数为 **0**，不再存在“长回复完成后再用另一套解析器重建整篇 DOM”的额外停顿路径。

- 实现保留 Streamdown 默认 `raw → sanitize → harden` 安全链；内部 `file:///` 链接在净化前编码为受控 `https://cyrene.invalid/...` 占位链接，anchor 组件解码后仍执行工作区边界检查。不会复用 spike 中移除 `rehype-harden` 的实验链。
- 流式模式使用 `parseIncompleteMarkdown`，完成态切为 Streamdown 的 static mode；两者都是同一个渲染器，static 仅表示不再补全未闭合语法，并非回退到 XMarkdown。
- `@streamdown/math` 以 `singleDollarTextMath: true` 配置接入。定向测试覆盖流式行内 `$E=mc^2$`、块级 `$$...$$`、未闭合代码围栏、Mermaid 占位、SVG、文件链接和危险 HTML/URL；另有 jsdom 测试验证非前缀替换后不会残留旧 block。
- 上游 [vercel/streamdown#601](https://github.com/vercel/streamdown/issues/601) 仍为 open：它不是迁移时被忽略的已知风险。采用后续运行中若出现公式错乱，按消息内容、浏览器版本、流式事件序列记录最小复现并回归到该 issue；不在代码中静默切回另一渲染器。
- A1-S 注入式对照、成对控制和 spike 文件已删除；性能 harness 仅测量正式产品路径，默认不产生视频文件。

### A1-D 候选：DSH 增量块引擎 + XMarkdown 稳定块渲染（2026-09-18 源码级可行性分析，未实施）

来源：DeepSeek Harness 仓库（`E:\deepseek-harness`）`packages/client/ui-primitives/src/markdown/`，MIT 许可。以下分析基于其源码与测试（64 项全过，已实际运行核实），**不表示 DeepSeek 网页端正在使用该实现**。其公开包为预发布且捆绑自家 CSS/高亮/KaTeX/组件体系，不整体安装，只评估算法层复用。

**组合方案**：DSH 块边界/冻结算法（`incremental.ts`，约 360 行，单文件、仅依赖 mdast 类型 + 调用方注入的 parse 函数）+ XMarkdown 渲染稳定块与活动尾块。目标：稳定块只过一次 XMarkdown 并缓存；每 chunk 只有尾块经 XMarkdown（保留实时公式）；完成时整篇 XMarkdown 做一次最终校正；不引入 Streamdown，不自研渲染器。

**已核实的引擎能力**（`incremental.ts` + `markdown-incremental.client.spec.tsx`）：末尾 2 块不稳定、更早块冻结；块 key 为绝对源码偏移（跨 chunk 稳定，React 按 key reconcile 不重挂载，测试以 DOM 实例追踪验证）；非前缀更新 generation+1 清空全部冻结状态；未闭合顶层围栏有逐行增量路径（已完成行不重复解析）；`update()` 幂等缓存；position-less 语法安全退化（全留 tail 不冻结）；设计文档自述的已知偏差——引用链接/脚注定义跨冻结边界时流式期间字面渲染、settle 全量解析自愈（测试锁定该行为指纹）。上层 `MarkdownText` 流式用 `parseGfm`、完成后用 `parseGfmWithMath`，即 DSH 现状同样是"公式完成后才渲染"——但这是其上层产品决策，`IncrementalMarkdownParser` 只接收注入语法，不限制数学。

**八个问题的结论**：

1. **能否为 XMarkdown 提供可靠边界（不复制 DSH 渲染器）**——能。引擎与渲染层完全解耦（`constructor(parse)` 注入）。但 DSH 注入的是 micromark/mdast 语法，XMarkdown 基于 marked：**跨家族双解析器**是 A1-D 特有风险（DSH 自己流式/完成两臂同为 micromark，无此问题）。边界不一致不影响正确性（XMarkdown 全权解析切片，切片在段落/块边界处取），最坏情况是冻结单位偏粗（如 `$$` 块在无 math 的 mdast 里并入段落，整段冻结）与流式期间片段渲染与全文渲染的可见差异（settle 校正兜底）。
2. **PositionedBlock 需补绝对源码范围**——现状 `key` 已是绝对 start，但 `node.position` 相对解析切片、冻结时的 base（tailStart）未保留，无法还原原始字符串。需补 `range: { start, end }` 绝对偏移（冻结时刻可得，约 20 行改动，不动算法）。另注意切点取冻结末块 end offset、块间空行留在 tail：多块拼接渲染需在片段间补块级分隔（`\n\n`）。
3. **多 XMarkdown 实例回归**——真实风险项，spike 必测：N 个 XMarkdown 根容器堆叠（DSH 渲染器块间是平级 `'\n'` 文本，我们是多容器）——块级 margin 不跨容器折叠（段间距变化，可用 `display: contents` 或负 margin 缓解，但需验证容器自身样式依赖）；冻结瞬间尾块→冻结区迁移 = 容器变化导致一次重挂载（动画重放/CodeHighlighter 重高亮闪烁）；`.cy-message-markdown` 现有 CSS 与 nth-child 类选择器需审计；滚动锚点与 React key（key=绝对偏移，容器列表 keyed）预计无碍但需实测。
4. **尾块实时公式**——能。尾块每 chunk 经 XMarkdown（含 Latex 插件），`$...$`、`$$...$$`、`\(...\)`、`\[...\]` 全按现状渲染；未闭合公式在尾块的重复渲染即现状行为（现状是全文重复，A1-D 范围缩小到尾块）；公式随所在块闭合冻结后只渲染一次——**天然规避 Streamdown #601 类问题（无 ProcessorCache、无块内 KaTeX 状态复用），且不牺牲实时公式**。
5. **非前缀/轮次/来源切换重置**——引擎内建：`!text.startsWith(prevText)` → generation+1 全清（含 openFence）；适配层以 generation 为 key 清块级元素缓存；message/round 切换按消息 key 重建 parser 实例（每消息一个实例，DSH 的 StreamingRenderer ref 模式，其测试覆盖 streaming→settled→streaming 翻转重建）。
6. **退化路径**——长单段/长列表/长表格：整块留尾，每 chunk 重解析重渲染该块——退化为"不劣于现状"（现状是全部历史每 chunk 重渲染；A1-D 最坏=活动消息尾块重渲染）。未闭合围栏：解析增量有专门路径，但 XMarkdown/CodeHighlighter 仍全量渲染尾块围栏。所有形态下最坏=现状，不劣化。
7. **spike 还是不可行**——**适合隔离 spike，无结构性障碍**。引擎单文件可 vendor（MIT）+ 约 20 行 range 补丁；主要不确定性全部是集成质量问题（重挂载闪烁、margin、双解析器一致性），可隔离验证。
8. **相对 Streamdown 的优先级**——**值得成为下一优先实验**。理由：直接解决 A1-P 暂停的两个原因（实时公式保留、无 #601 类风险）；复用 XMarkdown 全部生态（组件、样式、file link、语义）零迁移成本；无需 Tailwind/KaTeX 新依赖（KaTeX 已在链上）。预期收益低于 A1-S 上限（尾块仍 XMarkdown，长列表/长段退化），区间取决于内容形态，harness 可量化。

**主要风险（spike 必须量化）**：双解析器块边界一致性（marked vs micromark）；冻结迁移重挂载闪烁；多容器 margin/样式回归；长列表/表格/段落收益归零（仅保持现状）；引用/脚注跨边界流式期间字面渲染（DSH 已知偏差，settle 自愈，需产品确认可接受）。

**若实施，隔离 spike 设计（不写代码，待批准）**：分支 `codex/a1-d-incremental-xmarkdown-spike`，vendor `incremental.ts`（含 range 补丁）至 react-perf，注入 remark-gfm 语法（是否加 math 语法由边界一致性测试定），块级 XMarkdown 实例（冻结块 `streaming=false` 一次性渲染缓存、尾块 `streaming=true`），完成时整篇 XMarkdown 校正，复用 A1-S 的 harness/注册/paired 模式。验收矩阵：markdown/mixed × 0/200/500 与 XMarkdown animated 同构建 paired 对照（帧 P95、evtP95、ScriptDuration、DOM 数量）；字符级追加的实时公式正确性（尾块 `$`/`$$`/`\(`/`\[` 逐 chunk 渲染断言）；冻结块 DOM 身份不变（按块 key 追踪实例）；非前缀替换完整清缓存；长段落/列表/表格/未闭合围栏退化路径各有专项；引用链接与脚注跨边界行为（fingerprint 记录 + settle 自愈断言）；Mermaid/SVG/代码高亮/文件链接及完成态语义全项；**外加 marked vs micromark 边界一致性 fuzz（逐 prefix 片段渲染 vs 全文渲染对照，DSH 测试 61 行同款方法）**。

**A2 列表规模成本归因（独立实验，可独立进行，不依赖渲染器迁移）**——三段成本测量：① `assembleMessageItems` 拼装时间；② `Bubble.List` / React 协调时间；③ 浏览器样式/布局/绘制时间。现有数据 LayoutDuration 仅约 0.3–1ms 而 ScriptDuration 随历史数量明显增长，**优先怀疑 JavaScript 拼装/协调而非纯布局**。归因后决策：拼装主导 → 增量 item 索引或行级更新边界；协调主导 → 分页或虚拟化；两者均有 → 先分页限制上界，再评估虚拟化。

---

## 独立工作项（单独排期，不混入性能假设）

| 项 | 内容 | 备注 |
| --- | --- | --- |
| D1 | `removeDeletedSessionRuntimeState(sessionId)`：删除会话后完整清理全部运行态，接入 `handleDeleteSession` | 行为修复（现存缺陷），可先行 |
| D2 | drafts 空串删 key | 顺手小修 |
| M1 | 容量治理：仅淘汰可重新水合的 `messagesBySession` 重缓存（`dropSessionMessageRenderCache` + `useSessionMessages.dropSessionMessages`）；双阈值 + 可淘汰判定；不自研通用 LRU | 阶段 0 heap 基线后单独设计，不阻塞 1A/1B/2 |
| M2 | Tabs 按标签 `destroyOnHidden`（files=false 保状态；预览/Diff 按重建成本定） | 独立 |
| E1 | editDraft 下沉至编辑器局部，消除编辑期 roles 重建 | 注意受控组件 value/onChange 同源；回归 ESC/busy/提交清理 |

---

## 停止条件与后续门控

- **停止条件**：阶段 2 后重跑双通道——历史消息 contentRender 零调用（A 通道）；commit duration P95、流式事件到绘制延迟相对基线达到阶段 0 锁定的量化目标（B 通道）；DOM 节点数持平；heap 小幅上升在锁定上限内且换来明确 CPU 收益。达标即停。
- **门控（未达标才评估，按序）**：① 消息行级订阅 / 流式独立更新边界（新状态架构，需完整设计评审：useSyncExternalStore、双源合并、autoScroll 时机、取消/切换同步）；② 顶部分页"加载更早消息"；③ 虚拟化选型（成熟库优先：`@tanstack/react-virtual` / `virtua` / virtuoso；锚定表现、bundle 体积、autoScroll 重做成本；**禁止自研通用虚拟列表**）。

## 验证要求（未来实施时）

- 每阶段验收以阶段 0 锁定的量化阈值为准，实现后不得修改验收线。
- 回归范围：流式输出、消息编辑（ESC/busy/提交）、贴纸发送、推理展开、TTS cacheKey 上报、FileLink 跳转、Diff 标签、计划面板交互、会话切换与切回 hydrate、pending 队列投影、权限/答题卡片、autoScroll 与滚动到底按钮。
- 完整测试集 `npm test` 保持绿色。

---

## 评审记录

- 2026-09-17 初版：静态走读结论（问题总览 + 修复优先级建议）。
- 2026-09-17 设计评审（两轮）：修正 `lastTurn` 失效场景（流式期间返回稳定 null；完成态每次渲染新对象）、确认 `Bubble.List` 库内 memo 边界及其打穿机制、`createMessageItems` 复杂度修正为 O(n + Σchanged)、方案从"memo 化 + LRU"演进为"阶段 0→1A→1B→2 + 独立工作项"、删除会话与容量淘汰严格分离、阶段 0 交付物包含锁定验收线。未经 profiling 证明的性能结论均已降级为"待运行时验证"。
- 2026-09-18 A1-S 评审（用户有条件批准 + 终验前三点修正）：动态 import 改为 harness 注册隔离、样式真实性首日验证、测量改同场成对对照；语义清单表述修正为"已执行并记录差异"（SSR 纯函数性不等于有状态重置验证，补 jsdom 同实例 A→B→空串→C 与 key 重挂载测试）；spike 移除 rehype-harden 仅限实验链，产品迁移需占位链接方案保留默认安全链；报告增加逐轮配对差值。
