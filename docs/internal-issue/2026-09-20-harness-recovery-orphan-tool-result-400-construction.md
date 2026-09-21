# 施工文档：恢复 400 修复 + 三项 UI/功能待办（2026-09-20）

> 依据报告：`2026-09-20-harness-recovery-orphan-tool-result-400-report.md`（方案已定稿）
> 施工内容：报告第三～六节，拆为四个独立施工包（A/B/C/D），相互无代码耦合
> 建议顺序：A → C → B → D（先恢复链路可用，再做纯前端小改，最后三层功能打通）
> 提交纪律：每包独立 commit，出问题按包 revert，不跨包混提交

---

## 一、总览

| 施工包 | 内容 | 涉及层 | 依据 |
| --- | --- | --- | --- |
| A | 恢复 400 bug 修复（孤儿 tool result 闸门） | 主进程 harness | 报告第三节 |
| B | 工作区提示移入消息流 | 渲染层 | 报告第四节 |
| C | 工具卡显示修复（折行 + 命令渐隐截取） | 渲染层 | 报告第五节 |
| D | 终端实时输出查看（运行中/结束后） | 主进程 + 协议 + 渲染 | 报告第六节 |

---

## 二、施工包 A：恢复 400 bug 修复

### A.1 改动文件

- `src/main/orchestrator/harness/run-recovery.ts`
- `src/main/orchestrator/harness/run-recovery.test.ts`

### A.2 施工步骤

1. **加孤儿闸门**（`prepareHarnessRecovery` 合成 tool result 处）：消息存档里没有对应 tool_use（`callById` 查不到该 id）的记录不写入 transcript；不可重放的危险副作用仍照旧记入 `uncertainEffects`（安全拦截记录不丢）。代码见报告 3.1，注释用中文写清"中断发生在该轮 assistant 消息落盘之前"的语义。
2. **测试辅助改造**：`session()` 支持传入"未声明进 assistant 消息"的孤儿记录。
3. **新增两个回归用例**：
   - 孤儿只读调用（`read_file` 停在 `started`）→ 不产生任何 tool 消息；
   - 孤儿非幂等调用（`send_email` 停在 `started`）→ 不产生 tool 消息，但 `uncertainEffects` 必须有记录。
4. **不动**：harness 主循环 checkpoint 时序、压缩路径、run-store 持久化（报告 3.3）。

### A.3 验证

```powershell
npx vitest run src/main/orchestrator/harness/run-recovery.test.ts
```

人工复现：非 chat 模式启动带工具任务 → 工具执行中途强杀应用 → 重启 → 点"继续任务" → 恢复 run 正常续跑，不再 400。

---

## 三、施工包 B：工作区提示移入消息流

### B.1 改动文件

- `ChatPage.tsx`、`ChatWorkspaceNotices.tsx`、`ChatMessageList.tsx`（或同级新卡片组件）、`react-root.css`、`ChatWorkspaceNotices.test.ts`

### B.2 施工步骤

1. **卡片化**：两条提示（中断 + "继续任务"按钮；接管 + "终止并重开"按钮）改为消息流内的系统卡片，插在对话历史中渲染，工作区顶部不再出现任何文字；
2. **样式**：与消息流内其他系统卡片保持一致（`react-root.css` 补卡片样式）；不再使用无 CSS 定义的 `cy-harness-recovery` 裸样式；
3. **挂载迁移**：`RunRecoveryNotices` 从 `ChatPage.tsx` 顶部区域移除，改为 `ChatMessageList` 按条件渲染（或作为其前置插槽）；
4. **交互不动**：`onResume(runId)` / `onTakeover()` 回调照旧接线；
5. **测试同步**：`ChatWorkspaceNotices.test.ts` 断言随迁移调整。

### B.3 验证

- 单测：`ChatWorkspaceNotices.test.ts` 全绿；
- 手动：打开含中断存档的会话 → 顶部无横幅，消息流内出现提示卡片 → 点"继续任务"行为与迁移前一致。

---

## 四、施工包 C：工具卡显示修复（本方案已定稿，报告第五节）

### C.1 改动文件

- `ChatMessageList.css`（两处样式）
- `ChatMessageList.tsx`（`ToolExecutionContent` 组件）

### C.2 施工步骤

**改动 1：结果框折行**——`.cy-tool-executions__result` 补断行属性：

```css
.cy-tool-executions__result {
  /* ……现有样式不动 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;  /* 超长不可断行内容（长路径/base64/压缩 JSON）直接折行，
                               不再出现框内横向滚动条 */
}
```

**改动 2：命令 chip 前缀截取 + 渐隐**——组件侧（`ToolExecutionContent`）：

```tsx
// 模块顶部常量
const DETAIL_PREVIEW_LIMIT = 44; // 前缀截取长度，实施时按观感微调

// items map 内：
const detail = presentation.detail;
// 超长才截取 + 渐隐；未超限原样显示，短命令不出现渐隐伪影
const clipped = Boolean(detail && detail.length > DETAIL_PREVIEW_LIMIT);

// description 渲染处：
<span className="cy-tool-executions__description">
  <span className="cy-tool-executions__status">{presentation.statusText}</span>
  {detail && (
    <code
      className={`cy-tool-executions__detail${clipped ? " is-clipped" : ""}`}
      title={detail}
    >
      {clipped ? detail.slice(0, DETAIL_PREVIEW_LIMIT) : detail}
    </code>
  )}
</span>
```

样式侧（`ChatMessageList.css`）：

```css
.cy-tool-executions__detail.is-clipped {
  /* 截取后的前缀以渐隐收尾（替代省略号的观感升级） */
  -webkit-mask-image: linear-gradient(90deg, #000 78%, transparent);
  mask-image: linear-gradient(90deg, #000 78%, transparent);
}
```

要点：现有 `text-overflow: ellipsis` 保留作窄窗口兜底；chip 同时用于命令与文件路径，统一同一上限。

**改动 3：ask_user 问答卡断行**——与 result 框同一修复模式：

```css
.cy-ask-user-qa__row {
  /* ……现有样式不动 */
  overflow-wrap: anywhere;  /* 问题/回答里的长 URL、无空格长串直接折行，
                              不再画出圆角背景、不再撑出工作区横向滚动 */
}
```

**明确不改**：Markdown 代码块（`.cy-message-markdown pre`）保留长行横向滚动的 IDE 惯例（用户已确认）。

### C.3 验证

1. 输出含长 token 的命令（`echo` 一段无空格长串）：展开工具卡，输出全部折行，框内无横向滚动条；
2. 超长命令：chip 显示前 ~44 字符 + 尾部渐隐，悬停 title 看完整命令；短命令无渐隐、无省略号；
3. ask_user 含长 URL 的问答：文本在圆角背景内折行，工作区无横向滚动；
4. 回归：普通多行输出、含空格长文本折行不变；Markdown 代码块仍横向滚动。

---

## 五、施工包 D：终端实时输出查看（本方案已定稿，报告第六节）

按依赖顺序分四步施工：共享类型 → 主进程 → 事件协议 → 渲染层。

### D.1 共享类型

`src/shared/chat-types.ts` 的 `ToolExecutionRecord` 增加字段：

```ts
/** run_shell 执行期间的终端输出累积（用户视图专用，不进模型消息、不持久化）。 */
liveOutput?: string;
```

### D.2 主进程

1. **`harness/types.ts`**：`HarnessEvent` 联合增加成员：

```ts
| { type: "tool_output"; toolCallId: string; delta: string }
```

2. **`tools/registry/tool-context.ts`**：`ToolContext` 增加回调：

```ts
/** 工具执行期间的流式输出回调（run_shell 的 stdout/stderr 节流转发）；仅服务用户视图，不进模型消息。 */
onOutput?: (chunk: string) => void;
```

3. **`harness/tool-dispatcher.ts`**（`dispatchTool` 内，`tool_start` 事件发送之后、工具执行之前）接线：

```ts
// 工具流式输出接线：转发为 tool_output 事件，渲染层累积到 liveOutput
ctx.toolContext = {
  ...ctx.toolContext,
  onOutput: (delta) => ctx.onEvent?.({ type: "tool_output", toolCallId: call.id, delta }),
};
```

4. **`tools/builtin-tools/run-shell-tool.ts`**（`executePlan` 的 stdout/stderr `data` 回调）：

   - `executePlan` 增加 `onOutput?: (text: string) => void` 参数，`executeRunShell` 从 `context?.onOutput` 传入；
   - 每流独立节流：chunk 进 pending 缓冲，250ms 定时器合并 flush 一次（复用 `resetIdle` 的节奏，输出活动本身就是 idle 心跳）；
   - 转发前用 `TextDecoder("utf-8", { stream: true })` 流式解码，避免多字节字符被 chunk 边界切断；
   - 累计转发上限 64KB（超出丢弃并停止转发，防事件洪流；完整输出仍走既有 2MB 捕获）；
   - 只有 run_shell 接 `onOutput`，其他工具不动。

5. **`harness/adapter/event-mapper.ts`** 增加 case：

```ts
case "tool_output": {
  send({
    type: EventType.CUSTOM,
    name: "cyrene.tool_output",
    value: { toolCallId: event.toolCallId, delta: event.delta },
    threadId,
    runId,
  } as BaseEvent);
  break;
}
```

   同时确认 harness-adapter 的事件泵对新增事件类型透传（若有类型 switch 需同步补 case）。

### D.3 渲染层

1. **`AgentRunController.ts`**：消费 `cyrene.tool_output`（参考既有 `cyrene.round` / `cyrene.todo` 的 CUSTOM 事件分支）：

```ts
// 终端输出累积：追加并超限保留尾部（64KB，与主进程转发上限一致）
const current = this.toolExecutions.find((tool) => tool.id === event.toolCallId);
this.updateRunTool(event.toolCallId, {
  liveOutput: appendLiveOutput(current?.liveOutput, event.delta),
});
```

   `appendLiveOutput`：拼接后超 64KB 截掉头部，保留最新内容。

2. **`ChatMessageList.tsx`**：
   - `ToolExecutionContent` 的 `collapsible` 放开：`Boolean(tool.result || tool.changes || tool.liveOutput)`；
   - `ToolResultContent` 增加优先级分支（在 `changes` 之后）：`tool.liveOutput` 存在 → 渲染终端原文（复用 `.cy-tool-executions__result` 样式）；
   - 新增小组件（如同文件内 `TerminalLiveOutput`）：接收 `text` + `running`，运行中 `useEffect` 自动滚到底部（用户手动上滚时不强拉，`scrollTop` 距底 > 40px 则跳过）。

3. **持久化剔除**：确认 checkpoint 序列化路径（`buildCheckpoint` → `toolExecutions`）——按报告 6.4 决策，`liveOutput` 不落盘，序列化前剔除该字段。

### D.4 已知取舍（实施时不再讨论，直接按此执行）

- `liveOutput` 只服务用户视图，不进模型消息（模型侧仍走既有 preview/截断预算）；
- GBK 输出（旧版 cmd 中文回显）在实时视图可能短暂乱码——主流现代工具输出 UTF-8，接受该取舍；结束后完整输出以 `tool_end` 的 result 为准；
- `run_in_background` 后台任务不在本期范围（已有 logFile + shell_job 机制）。

### D.5 验证

1. 单测：`event-mapper.test.ts` 加 `tool_output` 转换用例；`harness-adapter.test.ts` 加透传用例；`AgentRunController`/`useSchedulerEvents` 加累积与超限截头用例；
2. 手动：运行 `npm install`——运行中点开工具卡，输出实时滚动增长；结束后点开，完整终端原文可查；
3. 回归：非 run_shell 工具卡行为不变；中断/恢复后工具卡渲染正常；存档重载后无 `liveOutput` 残留。

---

## 六、验收清单（全量）

- [ ] A：恢复中断任务不再 400，`run-recovery.test.ts` 新旧用例全绿
- [ ] B：工作区顶部无横幅，消息流内卡片可完成"继续任务/终止并重开"
- [ ] C：长 token 输出折行无横向滚动条；超长命令 chip 前缀 + 渐隐；ask_user 长文本折行
- [ ] D：运行中/结束后可查看终端实时/完整输出；存档不含 `liveOutput`
- [ ] 全局回归：`npm test`（或项目既有全量测试命令）通过

## 七、回滚方案

每包独立 commit：`git revert <commit>` 即可单独回滚任一包，不影响其余三包。
