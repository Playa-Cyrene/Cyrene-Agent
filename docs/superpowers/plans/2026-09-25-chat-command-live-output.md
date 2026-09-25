# 聊天命令实时输出面板实施计划

> 执行方式：当前任务内由 Codex 直接实施和自审。用户已明确免除规格及计划的人工复核；不派生代理，不创建分支。

**目标：** 聊天中的 `run_shell` 工具运行时显示 ZCode 风格的命令输出面板，并在重新打开会话后保留最近 64,000 字符。

**架构：** 命令执行器批量发布输出增量，工具分发器为每次调用绑定 `toolCallId`，现有 Harness→AG-UI 自定义事件链路把数据发给聊天控制器。聊天工具记录保存有界输出，消息列表使用改造自 ZCode `ai-elements/terminal.tsx` 的暗色面板显示命令、输出、状态与复制按钮。

**技术栈：** Electron、React、TypeScript、AG-UI、自带 `ThoughtChain`、`ansi-to-react`。

**规格：** `docs/superpowers/specs/2026-09-25-chat-command-live-output-design.md`

## 全局约束

- 只接入前台 `run_shell`；后台作业继续由现有工具管理。
- 不改变命令权限、安全策略、超时、捕获上限与最终 JSON 结果。
- Windows 的 UTF-8/GBK 判定保留；实时预览在命令结束时重建校正。
- 界面与持久化只保存最近 64,000 个字符，并显示裁剪提示。
- 现有用户改动不得覆盖或一并提交；现有 `master` 分支不切换。
- 若形成提交，消息必须为中文；当前共享工作区中已有大量未提交改动，因此实现文件先保留为工作区改动，避免将别人的修改一并提交。

## 审查重点

1. UTF-8 或 GBK 多字节字符跨数据块：预览和最终校正都不损坏中文。
2. 命令一次输出数兆字节：事件速率及单次载荷有界，UI 和会话记录只保留尾部。
3. 两个命令并行：输出严格按工具调用 ID 分流。
4. 命令取消、超时或进程错误：保留已显示部分输出，工具原有终态和原因不变。
5. 旧会话只有短结果预览：面板能显示可用内容，不把预览误称为完整日志。

## 文件职责

- `src/main/orchestrator/tools/registry/tool-context.ts`：增加可选命令输出回调。
- `src/main/orchestrator/harness/tool-dispatcher.ts`：单次命令调用绑定 ID 后转发输出事件。
- `src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts`：从现有 stdout/stderr 读取路径发布批量预览，并在结束时重建已捕获输出。
- `src/main/orchestrator/harness/types.ts` 与 `adapter/event-mapper.ts`：定义并转发输出事件。
- `src/shared/chat-types.ts` 与两个 transcript 校验文件：持久化有界输出字段。
- `src/renderer/react/features/chat/pages/run/AgentRunController.ts`：接收输出并更新对应工具记录。
- `src/renderer/react/features/chat/components/CommandTerminal.tsx` 与 CSS：ZCode 风格输出面板。
- `src/renderer/react/features/chat/components/ChatMessageList.tsx`：在 `run_shell` 工具行装入面板。
- 中英文文案、依赖清单和第三方声明：呈现及许可证信息。

### 任务 1：命令执行输出事件

**产物接口：**

```ts
type ShellOutputUpdate = { action: "append" | "replace"; text: string; truncated?: boolean };
interface ToolContext { onShellOutput?: (update: ShellOutputUpdate) => void }
type HarnessEvent = { type: "tool_output"; toolCallId: string } & ShellOutputUpdate;
// AG-UI CUSTOM: name="cyrene.tool_output", value={toolCallId, action, text, truncated}
```

- [ ] 在 `tool-context.ts` 添加回调类型；`tool-dispatcher.ts` 仅给 `run_shell` 的执行上下文绑定回调，闭包持有 `call.id`，转发异常不得打断命令。
- [ ] 在 `types.ts` 与 `event-mapper.ts` 增加事件映射；保持 `tool_start`、`tool_end` 顺序。
- [ ] 在 `run-shell-tool.ts` 接收可选回调：按现有每流 2 MiB 限额裁剪原始字节，输出预览每 100 ms 批量发布，单次最多发送 64,000 字符，过量保留尾部。
- [ ] 命令结束时按每条流既有 UTF-8/GBK 规则重解码，按接收顺序组合输出，只发送最近 64,000 字符的 `replace`，并携带截断标记；无回调时执行路径与现有工具返回值一致。
- [ ] 在命令工具、分发器、事件映射的测试中覆盖跨块中文、GBK、输出洪流、并发 ID、取消及回调异常。用短命令或受控假进程，不改权限逻辑。

关键测试形状：

```ts
const events: BaseEvent[] = [];
sendHarnessEventAsAgui(
  { type: "tool_output", toolCallId: "call-a", action: "append", text: "通过" },
  "message-a", "thread-a", "run-a", (event) => events.push(event),
);
expect(events[0]).toMatchObject({
  type: "CUSTOM", name: "cyrene.tool_output", runId: "run-a",
  value: { toolCallId: "call-a", action: "append", text: "通过" },
});
```

### 任务 2：聊天状态与持久化

**产物接口：**

```ts
interface ToolExecutionRecord {
  terminalOutput?: string;
  terminalOutputTruncated?: boolean;
}
function applyVisibleOutput(current: string, update: ShellOutputUpdate): { text: string; truncated: boolean };
```

- [ ] 在 `chat-types.ts` 增加两个可选字段，并在 `conversation-transcript-types.ts`、`conversation-transcript-store.ts` 的既有工具记录校验中接受受限字段。
- [ ] 新增纯函数 `command-output.ts` 处理 `append`/`replace`、64,000 字符尾窗和首字符代理对完整性；缺失和畸形事件直接忽略。
- [ ] `AgentRunController.ts` 仅消费当前运行的 `cyrene.tool_output`，校验 `toolCallId` 对应 `run_shell`，更新工具记录，并通过现有节流检查点保存。
- [ ] 终态 `TOOL_CALL_RESULT` 仍更新原有状态及 `result`，不可抹掉 `terminalOutput`；当无实时输出时保留旧预览作为回退。
- [ ] 补充纯函数与控制器测试：并行命令、迟到事件、超限尾窗、取消后部分输出、重新加载后的记录校验。

关键测试形状：

```ts
const value = applyVisibleOutput("旧", { action: "replace", text: "新" });
expect(value).toEqual({ text: "新", truncated: false });
expect(applyVisibleOutput("", { action: "append", text: "x".repeat(64_001) }).text.length).toBe(64_000);
```

### 任务 3：ZCode 风格命令面板

**产物接口：** `CommandTerminal({ tool }: { tool: ToolExecutionRecord })`。

- [ ] 以 `E:\ZCode\packages\ui\src\components\ai-elements\terminal.tsx` 为来源，移植消息内暗色容器、命令标题、状态、复制、自动滚动与活动光标。使用 Cyrene 的 CSS 与既有复制交互；组件头部保留原始来源声明。
- [ ] 增加 `ansi-to-react@6.2.6` 为直接依赖，用成熟库处理 ANSI 颜色；更新 `package.json` 与锁文件，并在第三方声明中写入上游 `ai-elements` 来源。
- [ ] 在 `ChatMessageList.tsx` 的 `run_shell` 分支渲染面板，运行中默认展开；旧记录可从 `argsText` 与 `result` 解析已有命令及可用输出，解析失败时安全展示原预览。
- [ ] 增加中英文状态和截断文案；CSS 适配窄窗口、浅色主题中的暗色面板和等宽换行。
- [ ] 组件测试覆盖命令、状态、ANSI、复制文本、空输出和旧记录回退；只运行与这次改动有关的测试与类型检查。

关键测试形状：

```tsx
const html = renderToStaticMarkup(<CommandTerminal tool={{ id: "a", name: "run_shell", status: "running", argsText: '{"command":"npm test"}', terminalOutput: "通过" }} />);
expect(html).toContain("npm test");
expect(html).toContain("通过");
```

## 自审与交付

- [ ] 查看完整差异，确认没有覆盖原工作区的既有改动。
- [ ] 运行与命令事件、聊天状态和面板相关的定向测试，以及主进程、渲染端类型检查；根据实际结果修复问题。
- [ ] 说明已完成的功能、实际验证结果、许可证来源及仍有限制；不把未运行的测试报告为通过。
