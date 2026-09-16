# 第三阶段返修：运行中统一展示 + 终态归类

## 背景

当前第三阶段把运行中内容过早分成了"过程折叠区"和"候选正式回答区"：
- 工具轮一出现，正文被搬进折叠区（气泡位置内容消失）
- ask_user 时正文被 `candidate_text_discard` 直接清空
- 内层轮次组每轮结束自动折叠，运行中就做了"归类"

目标：运行期间所有内容在一个展开的运行区域中按实际发生顺序连续显示；
只有成功终态才做整理；同时删除第三阶段新增的动效与提示行。

## 核心方案

**"分界线"而非"搬运"**：所有内容（推理、正文、工具卡）在数据层始终是一份带
`roundId` 的列表；运行中全部平铺渲染；终态时只改一个"从哪开始算正式回答"的
分界线——分界线之前的内容收进折叠区，最后一轮正文原地不动成为正式回答。

不重播、不闪白、不双显自动满足：终态整理只是"收起上面的"，最后一轮正文的
DOM 节点不动。

### 数据层原则（评审修订）

**不新建第二套时间线**。`processMessages / reasoningBlocks / toolExecutions`
是检查点落盘的持久化格式（历史恢复、runSnapshot 都依赖），保持不动。
正文的生命周期只有两个位置、一次转换：

```
当前未闭合轮的正文 → candidateText（唯一 "open" 状态，仅渲染态）
轮闭合（round end）→ append 进 processMessages（append-only，永不移除、不改内容）
终态成功          → 最后一轮 candidateText 一次性转正为 content
```

关键认知：**数据位置 ≠ 视觉位置**。轮闭合后正文进了 processMessages，
但运行中渲染照样把它平铺在展开区——"不要视觉搬入折叠栏"是渲染层的分界线
问题，不是数据层的。正文在哪永远只有一个两行的答案。

**顺序保证**：`roundId` 只负责分组；轮内顺序由新增的 `seq`（run 内单调递增）
保证，旧记录无 seq 时回退现有 `afterToolCount` 排序。加入正确性边界：
同一 run 内所有可展示事件具有稳定单调顺序，终态归类不得重新排序。

**`candidate_text_discard` 语义转义**：事件名是历史协议，渲染端收到后立即
调用 `closeRoundCandidateText()`（该轮正文不再是候选，但保留显示），绝不按
字面语义清除内容。禁止 discard 语义渗透进渲染层内部。

**最终回答判定（三态）**：轮次状态 `open → process | final`，
只有 invocation 完整结束（收到 TEXT_MESSAGE_END）后才允许离开 open：

```
Run 成功结束（success 终态）
AND 最后一个 assistant invocation 已完整结束
AND 该 invocation 无 tool call
AND 存在权威 TEXT_MESSAGE
→ finalAnswerBoundary 确定，最后一轮正文转正
```

运行中"没看到 tool call"只能叫 not-yet-seen-tool-call，不触发任何归类。

## 一、目标交互

### 运行中（runtime）

```
[头像] ● 正在处理 12s · 昔涟正在读文件…      ← 头部：RunActivityContent 复用
────────────────────────────────────────
推理A（第1轮，默认折叠可点开）
正文A（第1轮，无边框文本，流式追加）
工具卡（读文件 ✓）
推理B（第2轮）
正文B（第2轮，正在流式…）                    ← 就停在这
```

- 助手气泡样式删除：运行中助手内容全部无边框文本展示
  （即"关闭气泡"模式，复用现有 borderless 样式）
- 轮与轮之间不折叠、不搬运，按实际发生顺序连续平铺
- 工具轮出现时，上面已显示的正文原地不动
- ask_user：底部交互卡照常 + 运行流里出现"询问用户"工具卡，
  该轮已显示的正文不消失

### 终态成功（最后一轮无 tool call）

```
[头像] ▶ 处理完成 · 28s                       ← 折叠区头部（点开看全过程）
────────────────────────────────────────
正文B（最终回答，无边框文本）                 ← 原地不动，成为正式回答
```

- 最后一轮正文留在折叠区外，成为正式回答
- 此前各轮的推理、正文、工具卡统一收进折叠区
- 第一轮就无工具调用：没有可折叠内容 → 不创建折叠区（或隐藏），
  正文直接就是回答
- 多个工具轮：最终归类按 roundId 分组，顺序不乱

### 取消 / 错误 / 超时

- 不产生正式回答
- 已显示的全部内容（含最后一轮正文）整理为"未完成的运行过程"
- 默认保持展开（复用现有 keepExpanded 逻辑），用户能看到中断前发生了什么

## 二、ask_user 工具卡增强

现状：ask_user 已走工具卡事件链（tool_start/tool_end），
底部交互卡独立通道不冲突。但卡片体验糙：
- 标题显示原始名 `ask_user`
- 点开只有参数 JSON + "用户已回答 N 个问题"，看不到具体问答

改进：
1. `builtin-tools.ts` executeAskUser：成功返回时把"问题 → 回答"逐条
   写入 message（preview 截断规则不变）
2. `agent-rounds.ts`：标签映射补 ask_user（"询问用户"），
   状态文案"已询问用户 · 已收到回答"
3. `ChatMessageList.tsx` ToolResultContent：ask_user 卡片点开时
   渲染问答配对样式（问题 + 用户选择），不做原始 JSON 展示

## 三、实现要点（按文件）

### src/renderer/react/features/chat/pages/run/AgentRunController.ts

核心改动：正文生命周期"两位置一转换"+ 终态一次性归类。

1. 轮闭合（`cyrene.round` end / `candidate_text_discard`）：
   不再清空候选正文，而是 `closeRoundCandidateText()` —— 把该轮
   candidateText append 为一条 processMessage（带 roundId + seq），
   渲染层继续平铺显示它（数据进 processMessages ≠ 视觉进折叠区）
2. `cyrene.process_text` / `candidate_text_discard` 事件到达时：
   transientText 不清除；候选正文保留在原地参与统一平铺
3. 终态结算（RUN_FINISHED / RUN_ERROR / catch），一次性完成：
   - success + 最终轮完整结束 + 无 tool call + 有权威正文：
     最后一轮候选正文转正为 content（以正式 TEXT_MESSAGE 全文为权威，
     不一致时对同一 item 做 content reconcile，不重建节点）；
     其余轮正文已在 processMessages，无需搬运
   - cancelled / timeout / runtime_error：候选正文转为 interrupted
     processMessage（复用 moveCandidateToInterruptedProcess）
   - 归类 patch 并入终态 patch，避免中间态闪现
4. 保留：roundId/runId 事件隔离（RunEventGate）、真实增量通道、
   rAF 合帧、revealChain 渐显链、检查点不落候选正文的边界

### src/main/orchestrator/harness/tool-round.ts

- ask_user 分支的 `candidate_text_discard` 事件：保留事件本身
  （渲染端语义从"清除"改为"该轮正文不再是候选，但保留显示"）
- 普通工具轮的 progress_text flush：事件照发（终态归类时用它兜底
  非 candidate_text 通道的正文），渲染端不再实时搬运

### src/renderer/react/features/chat/components/ChatMessageList.tsx

1. **删除气泡**：assistant 角色不再用气泡容器，统一无边框文本
   （用户消息气泡保留）
2. **运行中统一平铺**：runActivity 存在且未完成时，
   RunActivityDetail 直接展开渲染全部轮次内容（推理/正文/工具），
   不用 AgentRoundGroup 的"每轮头部+自动折叠"结构——运行中删除
   内层折叠栏
3. **终态分界渲染**：runActivity 完成后：
   - 最后一轮正文（assistant 槽位）渲染在折叠区之外
   - 其余内容渲染进折叠区（复用现有折叠交互）
4. 删除 streamingMarkdownOptions / LiveAnswerTail 等动效组件
   （若第二阶段未删净）

### src/renderer/react/features/chat/components/ChatMessageList.css

- 删除 cy-live-answer-tail / cy-live-answer-status /
  cy-live-answer-breathe 及 reduced-motion 样式
- 新增/调整无边框正文的排版样式（对齐现有 borderless）

### src/renderer/react/features/chat/components/message-visibility.ts

- assistantRenderStages：transientText（候选正文）运行中参与
  assistant 阶段判定（已有）；确认终态后 responseStarted 逻辑
  与"无工具首轮无折叠区"一致

### src/renderer/react/features/chat/components/agent-rounds.ts

- ask_user 标签映射 + 状态文案
- AgentRoundGroup 运行中不再自动折叠（或运行中不使用该组件）

### src/renderer/react/features/chat/components/run-activity.ts

- 折叠判定：运行中强制展开；终态折叠（keepExpanded 逻辑保留）

### 国际化

- zh-CN.json / en.json：ask_user 卡片文案、中断过程标题等新 key

## 四、必须保留的正确性边界

1. 真实正文增量通道、roundId 和 runId 事件隔离
2. 候选正文只存在于渲染状态：不进正式聊天正文、不进运行中检查点、
   不提前触发 TTS
3. 成功终态以正式 TEXT_MESSAGE 全文为权威，不一致时对同一 item
   reconcile，不重建节点
4. 非流式供应商走现有兜底路径
5. 不回退"整轮缓存完成后才第一次显示正文"的旧问题
   （candidate_text 实时增量照旧）
6. 不动第二阶段消息队列、附件、待发、调整、修改逻辑
7. 同一 run 内所有可展示事件具有稳定单调顺序（seq），终态归类
   不得重新排序
8. 不新建第二套时间线/消息存储/流式基础设施（持久化格式不动）

## 五、删除清单（第三阶段动效）

- [ ] 正文末尾呼吸尾标
- [ ] 闪烁光标 / 半透明竖条
- [ ] XMarkdown 自定义 tail 配置
- [ ] 新字淡入动画
- [ ] "昔涟正在生成…"提示行
- [ ] cy-live-answer-tail / cy-live-answer-status /
      cy-live-answer-breathe 及 reduced-motion 样式
- [ ] AgentRoundGroup 运行中每轮自动折叠（内层折叠栏）

保留：真实增量到达后的自然刷新；不引入新动画库。

## 六、测试计划（先写失败测试再实现）

### 单元/组件测试

1. **首轮无工具**：正文实时出现；成功后原地成为正式回答；
   无空折叠区（runActivity 完成且无过程内容时不渲染折叠头部）
2. **正文 → 工具 → 最终回答**：
   - 运行中所有内容连续展开、顺序正确（时间线测试）
   - 工具轮出现时正文不消失、不立即折叠
   - 最终成功后旧内容只出现一次（进折叠区）、最终正文只出现一次
3. **多工具轮**：运行中统一展开；终态归类按轮分组不乱序
4. **ask_user**：已显示正文不被 discard 清除；交互卡正常显示；
   完成后正文归入过程区；工具卡显示问答内容
5. **取消/错误/超时**：无正式回答；已显示内容成为展开的中断过程
6. **候选正文边界**：不进检查点（checkpoint 不含 transientText）；
   不提前进 TTS（earlyTts.append 只吃正式正文通道）
7. **迟到事件**：旧 roundId / 旧 runId 事件仍被忽略
8. **动效清除**：源码断言不再存在呼吸尾标、尾标动画、生成提示行
9. **非流式兜底**：现有 fallback 测试保持通过
10. **工具并行调用**：text → A start → B start → B end → A end → final，
    timeline 顺序稳定不乱序
11. **长正文后 tool call**：已流 500 token 后工具轮出现，整个运行阶段
    DOM 不迁移、不消失
12. **success 但 final text 为空**：不产生空白正式回答 + 空折叠区
13. **权威文本与候选不一致**（transient ABCDEF / 权威 ABCDE）：
    同一 item 的 content reconcile，不删旧节点再建新节点

### 回归与构建

- Harness、AG-UI、聊天消息相关既有测试
- 主进程及预加载类型检查
- 前端生产构建

## 七、暂不做（等审查后另行安排）

- 外部应用下拉菜单
- 右侧文件面板
