# 恢复中断任务时 400：孤儿 tool result 合成缺陷 + 三项 UI/功能待办（2026-09-20）

> 现象：点击工作区左上角"继续任务"按钮恢复中断任务，模型请求直接被服务端 400 拒绝。
> 根因：恢复逻辑为"消息存档里没有对应 tool_use 的孤儿工具记录"合成了 tool result，违反 Anthropic 协议的配对要求。
> 状态：根因已定位，修复方案已定稿待实施；另含三项待办——工作区提示移入消息流（第四节）、工具卡命令渐隐截断与输出折行（第五节，方案已定）、终端实时输出查看（第六节，方案已定）。

---

## 一、情况交代

### 1.1 现象

用户在 code 模式会话中点击"继续任务"（该会话此前有任务意外中断，提示"已进行 2 轮"），恢复 run 启动后第一次模型请求即失败：

```
[AgentFlow] 2. 理解用户请求：完成，可信引用 0 个
[HarnessAdapter] starting harness run, mode=code plan=NORMAL
[image-send] 流式请求失败:
  model id: MiniMax-M3
  baseUrl: `https://api.minimaxi.com/anthropic/v1/messages`
  error: Error: 400 {"type":"error","error":{"type":"invalid_request_error",
    "message":"invalid params, tool result's tool id(call_01a0a2f8628573e39d9d255b) not found (2013)"}}
[CyreneHarness] LLM call failed:
  error: E_MODEL_REQUEST_FAILED 模型服务请求失败。
```

说明：日志里 `[image-send] 流式请求失败` 与 `[CyreneHarness] LLM call failed` 是**同一次请求失败打了两遍**（前者是 `sdk-stream/runtime.ts` 的失败链路日志，后者是 harness 主循环的捕获日志），不是两个独立问题。`[image-send]` 前缀只是链路排查标记，与图片无关。

### 1.2 复现条件

1. 任一非 chat 模式会话中启动带工具调用的任务；
2. 在某一轮工具**执行中途**强杀应用（崩溃 / 任务管理器结束进程 / 强关窗口）；
3. 重启应用，该会话左上角出现"昔涟上次任务意外中断（已进行 X 轮）。继续任务"；
4. 点击"继续任务" → 恢复的 run 第一次模型请求即 400。

---

## 二、根因分析

### 2.1 存档时序的不对称（根源）

一轮工具执行的关键时序（`cyrene-harness.ts` 主循环）：

| 步骤 | 动作 | 是否落盘 |
| --- | --- | --- |
| 1 | 模型返回带 toolCalls 的 assistant 消息，push 进内存 transcript | 否 |
| 2 | 每个工具开始执行：`recordTool(status: "started")` | **立即写盘** |
| 3 | 工具逐个完成：结果消息进内存 transcript，`recordTool` 更新为 `committed` | 记录写盘，**消息不写盘** |
| 4 | 整轮结束：`checkpoint(run)` 把 messages 整体写盘 | 是 |

若应用死在第 2～3 步之间，磁盘上的 session 存档变成：

- `toolCalls`：包含该轮的记录，永远停在 `started`；
- `messages`：停留在**上一个完整轮次的末尾**——该轮的 assistant 消息（含 tool_use 块）从未写入。

### 2.2 恢复逻辑的缺陷（直接原因）

`run-recovery.ts` 的 `prepareHarnessRecovery` 会为所有非 `committed` / `not_executed` / 已有结果的持久化工具记录**合成一条 `role: "tool"` 消息**，但没有校验消息存档里是否存在对应的 tool_use 声明。

对上述"孤儿记录"（`toolCalls` 里有、`messages` 里没有）合成 tool result 后，恢复出的 transcript 含一条引用了不存在 tool id 的结果消息。Anthropic 兼容协议要求 tool result 必须紧跟同 id 的 tool_use，MiniMax 服务端直接拒绝：

```
tool result's tool id(call_01a0a2f8628573e39d9d255b) not found (2013)
```

### 2.3 为什么测试没拦住

`run-recovery.test.ts` 的辅助函数 `session(toolCalls)` 把传入的工具记录**同步声明进 assistant 消息**（1:1 映射），孤儿场景从未被构造过，该缺陷一直处于零覆盖状态。

### 2.4 排除项

- 压缩（compaction）路径：`compressForAgentLoop` 使用"配对安全切点"，不会产生孤儿 tool_use / tool result，与本问题无关。
- "发个'继续'消息代替按钮"：不可行。普通消息只会从对话历史开全新 run，不加载中断 run 的存档（Todo 状态、uncertainEffects 安全记录、transcript 修复全部丢失）。"继续任务"按钮（`resumeFromRunId`）是唯一恢复入口，所以该提示卡片有存在必要，只是位置和本 bug 都需要修。

---

## 三、修改方案（bug 修复）

### 3.1 改动点 1：`src/main/orchestrator/harness/run-recovery.ts`

在合成 tool result 前加一道闸：消息存档里没有对应 tool_use 声明（`callById` 中无此 id）的孤儿记录**不写入 transcript**；但**不可重放的危险副作用仍记入 `uncertainEffects`**（安全拦截记录不丢）。

```ts
if (isUnknown) {
  // ……现有 uncertainEffects 记录逻辑不动
}
// 消息存档里没有对应的 tool_use（中断发生在该轮 assistant 消息落盘之前）：
// 协议要求 tool result 必须紧跟同 id 的 tool_use，合成会被服务端 400 拒绝。
// 这类调用只保留 uncertainEffects 安全记录，不写入 transcript。
if (!call) continue;
messages.push({ role: "tool", toolCallId: persisted.toolCallId, /* …… */ });
```

效果：恢复的 transcript 干净地停在最后一个完整轮次，模型从那里继续。

已知取舍（诚实记录）：孤儿非幂等调用的原始参数随未落盘的 assistant 消息一起丢失，`fingerprint` 只能按空参数计算，"完全相同调用"的自动重放拦截会失灵；由 `recoveryContext` 中的总则兜底（"中断中的外部副作用不得自动重放，必须先查证、询问用户，或诚实说明无法确认"），模型每轮可见。

### 3.2 改动点 2：`src/main/orchestrator/harness/run-recovery.test.ts`

- 小改辅助函数 `session()`：支持传入"未声明进 assistant 消息"的孤儿记录；
- 新增两个回归用例：
  1. 孤儿**只读**调用（`read_file` 停在 `started`）→ 不产生任何 tool 消息；
  2. 孤儿**非幂等**调用（`send_email` 停在 `started`）→ 不产生 tool 消息，但 `uncertainEffects` 必须有记录。

### 3.3 不改什么

- 不动 harness 主循环的 checkpoint 时序（每轮内增量落盘属于更大的架构改动，另行评估）；
- 不动压缩路径、run-store 持久化逻辑。

### 3.4 验证路径

1. `npx vitest run src/main/orchestrator/harness/run-recovery.test.ts`，新旧用例全绿；
2. 人工复现验证：中断一轮工具执行中途 → 重启 → 点"继续任务" → 恢复 run 正常续跑，不再 400。

---

## 四、UI 改造待办：工作区提示移入消息流

### 4.1 现状与问题

工作区左上角（消息列表上方）由 `RunRecoveryNotices`（`ChatWorkspaceNotices.tsx`）渲染两种横幅：

| 提示 | 触发条件 |
| --- | --- |
| "昔涟上次任务意外中断（已进行 X 轮）。继续任务" | 打开会话时存在中断任务存档 |
| "当前会话有正在运行的任务（可能来自刷新前），本轮消息尚未执行。终止并重开" | 发消息时会话仍有运行中任务（如刷新前遗留） |

两个问题：

1. **位置突兀**：横幅直接占用工作区顶部空间，影响观感（用户已确认要移走）；
2. **从未设计过**：`cy-harness-recovery` 这个 class **全项目没有任何 CSS 定义**，目前是浏览器默认样式（裸文字 + 原生灰色按钮）裸奔在白色工作区顶部。

### 4.2 改造方案（用户已选定：移到消息流里）

把两条提示改为**消息流内的系统卡片**，插在对话历史中渲染，顶部不再出现任何文字：

- 卡片承载现有全部功能：中断提示 + "继续任务"按钮、接管提示 + "终止并重开"按钮；
- 样式与消息流内其他系统卡片保持一致（不再使用无样式定义的 `cy-harness-recovery` 裸样式）;
- `RunRecoveryNotices` 从 `ChatPage.tsx` 顶部区域移除，改为在 `ChatMessageList` 中按条件渲染（或作为其前置插槽）；
- 交互逻辑不变：`onResume(runId)` / `onTakeover()` 回调照旧接线。

涉及文件：`ChatPage.tsx`、`ChatWorkspaceNotices.tsx`、`ChatMessageList.tsx`（或同级新卡片组件）、`react-root.css`（卡片样式）、`ChatWorkspaceNotices.test.ts`（断言同步调整）。

### 4.3 实施顺序建议

先落第三节 bug 修复（恢复链路可用），再做本节 UI 改造（入口位置优化）。两项无代码耦合，可分开提交验证。

---

## 五、UI 问题待办：工具卡命令渐隐截断与输出超宽折行

### 5.1 现象（两个诉求，用户 2026-09-20 确认）

1. **命令输出横向滚动**：运行命令（如 `run_shell`）后展开工具卡，输出里一旦出现**不可断行的长内容**（超长路径、base64、无空格的压缩 JSON、单行超长命令回显等），输出框内出现左右滑动的横向滚动条；
2. **超长命令显示生硬**：命令 chip 目前是单行省略号截断（`Get-CimInstance Win32_…`），用户希望改为"只截取前几个字符 + 右侧渐隐"（如 `Get-CimInstance Win32_Pr` 后文字如烟雾淡出），观感更精致。

### 5.2 根因

**输出横向滚动**：渲染链路（`ChatMessageList.tsx` 的 `ToolResultContent` → `<pre className="cy-tool-executions__result">`），样式在 `ChatMessageList.css`：

```css
.cy-tool-executions__result {
  max-height: 180px;
  overflow: auto;              /* ← 内容超宽时出现横向滚动条 */
  ...
  white-space: pre-wrap;       /* ← 可断行文本会换行，但不可断行长串不会 */
}
```

`pre-wrap` 只在**空白/换行点**折行。命令输出里没有空格的超长 token（典型：一行压缩 JSON、长 URL、base64）不满足任何断行条件，直接撑宽 → `overflow: auto` 给出框内横向滚动条。

**chip 无渐隐**：`.cy-tool-executions__detail` 现有 `white-space: nowrap` + `text-overflow: ellipsis` + `min-width: 0`，截断行为正确（显示开头 + `…`，无横向滚动问题），只是省略号观感生硬。

**同类缺口（2026-09-20 全量排查补录）**：

- **ask_user 问答卡**：`.cy-ask-user-qa__row`（`ChatMessageList.css`）的问题/答案文本**没有任何断行属性**——与 result 框同一缺陷模式：问题或回答里出现长 URL、无空格长串时，文字画出圆角背景外，触发工作区整体横向滚动；
- 撑出工作区的机制：`.cy-message-list` 是 `overflow-y: auto`，按 CSS 规则另一轴计算为 `auto`——卡内任何撑不下的内容都会变成工作区整体横向滚动（"要划过去"的来源）。

其余工具展示卡已全量排查，**均有省略号或自包含滚动，无需改动**：Diff 文件卡（标题/目录/文件名三层 `ellipsis`，diff 体自包含滚动）、Review 面板（路径 `ellipsis` + `direction: rtl` 保留尾部）、任务委派行（描述 `ellipsis`）、轮次折叠标题（`ellipsis`）、文件链接 chip（`ellipsis` + `max-width: 260px`）、附件/渠道来源 chip（`ellipsis`）、计划卡（`grid minmax(0, 1fr)` 自然换行）、Mermaid 卡（`overflow-x: auto` 自包含）、mermaid/svg 降级源码框与 markdown 降级框（已有 `word-break: break-word`，长 token 能断）。

低优先级备注（非工具卡，暂不动）：模型正文的一般段落（`.cy-message-markdown` 非 `pre` 部分）没有 `overflow-wrap`，正文贴长 URL 同样会撑宽；中文天然可断、风险小，本期不处理。

已排除的相邻元素：Diff 卡片（`.cy-file-change-card__diff`）`overflow: auto` 自包含，滚动发生在卡片内部，属预期。

### 5.3 修改方案（用户已确认两项决策）

**决策一：Markdown 代码块不改**。消息内 Markdown 代码块（`.cy-message-markdown pre`，`overflow-x: auto`）保留"长行横向滚动"的 IDE 惯例，本期只改命令输出框。

**改动 1：结果框折行**——`.cy-tool-executions__result` 补断行属性，让不可断行长串折行而不是撑出横向滚动：

```css
.cy-tool-executions__result {
  /* ……现有样式不动 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;  /* 超长不可断行内容（长路径/base64/压缩 JSON）直接折行，
                               不再出现框内横向滚动条 */
}
```

不改 `overflow: auto` 本身：纵向滚动（`max-height: 180px`）是预期行为，保留兜底。

**改动 2：命令 chip 前缀截取 + 渐隐**——超长命令只显示前 N 个字符，尾部用 `mask-image` 线性渐变淡出，替代省略号。

组件侧（`ChatMessageList.tsx` 的 `ToolExecutionContent`）：

```tsx
const DETAIL_PREVIEW_LIMIT = 44; // 前缀截取长度，实施时按观感微调

// 超长才截取 + 渐隐；未超限原样显示，短命令不出现渐隐伪影
const clipped = Boolean(presentation.detail && presentation.detail.length > DETAIL_PREVIEW_LIMIT);
<code
  className={`cy-tool-executions__detail${clipped ? " is-clipped" : ""}`}
  title={presentation.detail}
>
  {clipped ? presentation.detail.slice(0, DETAIL_PREVIEW_LIMIT) : presentation.detail}
</code>
```

样式侧（`ChatMessageList.css`）：

```css
.cy-tool-executions__detail.is-clipped {
  /* 截取后的前缀以渐隐收尾（替代省略号的观感升级） */
  -webkit-mask-image: linear-gradient(90deg, #000 78%, transparent);
  mask-image: linear-gradient(90deg, #000 78%, transparent);
}
```

要点：

- **为什么在组件里按长度截取、而不是纯 CSS mask**：chip 是 shrink-to-fit 元素，右边缘永远贴着文字末尾，纯 CSS 无法区分"被截断"和"刚好放下"——短命令也会被渐隐误伤。按长度 if/else 是唯一能"只在超长时渐隐"的简单精确方案；
- `title` 悬停可看完整命令；
- 现有 `text-overflow: ellipsis` 保留，作为窄窗口下（截取后的前缀仍超出可用宽度）的兜底；
- 该 chip 同时用于命令与文件路径，统一按同一前缀上限处理，观感一致；
- 运行中 `argsText` 流式补齐时截取随内容更新（同一函数路径，无额外处理）。

**改动 3：ask_user 问答卡断行**——与 result 框同一修复模式：

```css
.cy-ask-user-qa__row {
  /* ……现有样式不动 */
  overflow-wrap: anywhere;  /* 问题/回答里的长 URL、无空格长串直接折行，
                              不再画出圆角背景、不再撑出工作区横向滚动 */
}
```

### 5.4 验证路径

1. 触发一条输出含长 token 的命令（如 `echo` 一段无空格长串 / 输出压缩 JSON 的命令）：展开工具卡，输出全部折行显示，灰色框内无横向滚动条；
2. 超长命令：chip 显示前 ~44 字符，尾部渐隐淡出，悬停 title 显示完整命令；短命令无渐隐、无省略号；
3. ask_user 问答：构造含长 URL 的问答，文本在圆角背景内折行，工作区无横向滚动；
4. 回归确认：普通多行命令输出、含空格长文本的折行表现不变；Markdown 代码块长行仍横向滚动（未改）。

---

## 六、功能待办：运行中/结束后点开查看终端实时输出

### 6.1 需求（用户 2026-09-20 提出）

命令运行期间和运行结束后，都能点开工具卡查看终端的真实输出（stdout/stderr 原文），而不是只看到一行状态文字。

### 6.2 现状调研：三层缺口

| 层 | 现状 | 缺口 |
| --- | --- | --- |
| 主进程 | `run-shell-tool.ts` 的 `executePlan` 把 stdout/stderr 全量缓冲在内存（每流 2MB 上限），进程 `close` 后才随返回值一次性交给调度层 | 执行期间没有任何输出事件，无流式通道 |
| 事件协议 | `HarnessEvent` 只有 `tool_start` / `tool_end`；`tool-dispatcher.ts` 发 `tool_end` 时 preview 截到 **200 字符** | 没有工具输出增量事件 |
| 渲染层 | `ChatMessageList.tsx` 的 `collapsible: Boolean(tool.result \|\| tool.changes)`，运行中 `result` 为空 | 运行中卡片不可展开；结束后展开看到的也只是 200 字符的 JSON 头部（run_shell 返回值是 JSON 字符串，stdout 排在字段最后，preview 里基本看不到） |

结论：这不是前端单点修复，"运行时看终端在输出什么"需要主进程 → 事件协议 → 渲染层三层打通。

### 6.3 修改方案

1. **主进程**：`ToolContext`（`tool-context.ts`）增加 `onOutput?: (chunk: string) => void` 回调；`executePlan` 的 stdout/stderr `data` 回调里节流转发（如 250ms 合并一批、累计上限 64KB 防洪流）；只有 run_shell 接入，其他工具不动；
2. **事件链路**：新增 `HarnessEvent` 成员 `tool_output`（toolCallId + delta）→ `event-mapper.ts` 转成 AG-UI CUSTOM 事件（`cyrene.tool_output`）；
3. **渲染层**：`AgentRunController` 消费该事件，`ToolExecutionRecord` 增加 `liveOutput?: string` 追加式累积（超限保留尾部）；`ToolExecutionContent` 对 run_shell 运行中放开 `collapsible`（有 liveOutput 即可展开），展开内容显示 liveOutput 并自动滚到底部（tail -f 体验）；结束后同样优先显示 liveOutput（终端原文全量），替代 200 字符 JSON preview。

### 6.4 已知取舍

- `liveOutput` 只服务用户视图，不进模型消息（模型侧仍走既有 preview/截断预算），不增加上下文消耗；
- checkpoint 存档是否持久化 liveOutput：默认不持久化（历史消息展开仍看 result，避免存档膨胀），实施时可再评估；
- `run_in_background` 后台任务不在本期范围（已有 logFile + shell_job 查询机制）。

### 6.5 验证路径

1. 运行一条持续输出的命令（如 `npm install`）：运行中点开工具卡，终端输出实时滚动增长；
2. 命令结束后点开：完整终端原文可查（不再是被截断的 JSON 头部）；
3. 回归：非 run_shell 工具的卡片行为不变；中断/恢复后工具卡渲染正常。
