# 计划审批收回 Runtime：原地等回执与三档审批设计

日期：2026-09-23
范围：Plan Mode 审批链路（write_plan → 审批 → 执行）/ 审批 UI / IPC 事件收敛 / 崩溃恢复推演
前置文档：[2026-09-23 计划模式权限与状态改造方案](./2026-09-23-plan-mode-permission-and-state-design.md)（P0/P1/P2 已全部落地，本文在其状态机与持久化语义之上施工）
参照实现：ZCode ExitPlanMode（E:\ZCode，apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts）

---

## 一、背景：现状审批链路与其债务

### 1.1 现状链路（改造对象）

```text
模型 write_plan（落盘 + markPlanWritten，工具立即返回）
→ 模型本轮收工，run 结束
→ agui-bridge complete 回调发现 isSuccessfulCompletion → startPlanReviewFlow
→ moveToReview（DISCUSSING → REVIEW）+ 读计划全文
→ 发 CUSTOM "cyrene.plan.review"（渲染端打开计划面板）
→ requestUserClarification 弹两段式审批卡（第一段：批准 / 我要修改）
→ 批准：approvePlan（REVIEW → EXECUTING）+ 发 "cyrene.plan.approved"
   → 渲染端持久监听器收到，代发执行消息 t("chatPage.planApprovedAutoMessage")
   → 新开 run → preparePlanRunContext 注入 [PLAN_CONTEXT] → 模型开工
→ 需要修改：supplementPlan + 弹第二段纯文本卡 → 用户填意见
   → 发 "cyrene.plan.supplement" → 渲染端代发用户消息 → 新开 run 改计划
```

关键代码位置：

- 审批流编排：[agui-bridge.ts L267-L359](../../../src/main/agui-bridge.ts)（startPlanReviewFlow，run 收尾后异步触发）
- 两段式卡片：[plan-tools.ts L146-L186](../../../src/main/orchestrator/harness/plan-tools.ts)（buildPlanReviewCard / buildPlanSupplementCard）
- 渲染端代发消息与持久监听：[ChatPage.tsx L571-L623](../../../src/renderer/react/features/chat/pages/ChatPage.tsx)
- run 收尾触发：[agui-bridge.ts L1105-L1108](../../../src/main/agui-bridge.ts)

### 1.2 三个问题

**问题 1：审批发生在模型收工之后，模型与审批结果之间隔了一次"新开 run"。**
write_plan 立即返回，模型说完收尾语就下班；用户点批准后，渲染端**代替用户**发一条固定文案的消息新开 run。模型对"用户批准了"的感知来自下一条用户消息而非本次交卷的直接回应；"需要修改"的意见同样绕道新消息传递。链路绕：runtime → renderer → 再 runtime。

**问题 2：run 外等待没有统一的生命周期语义。**
审批卡挂在 run 结束后的 requestUserClarification 上：超时（60s，沿用询问卡的快问快答配置）静默拉回讨论态；用户在 REVIEW 态直接发消息则由下个 run 的 preparePlanRunContext 补拉回。等待期间的状态、超时、取消语义都是补丁式的。

**问题 3：渲染端持有业务决策（代发执行消息）。**
"批准后该开工了"这个决策本属于 runtime 状态机，现在由 renderer 的持久监听器代为执行（发消息开 run）。主进程与渲染端各持一半流程，事件名（cyrene.plan.approved / cyrene.plan.supplement）与消息文案（planApprovedAutoMessage）散落两端。

---

## 二、设计原则（三条）

1. **交卷即等待，回执即继续。** 模型调用交卷工具后，run 原地挂起等待用户三档决定；用户的决定作为**工具结果**回传，模型在同一次 run 内继续——批准则直接开工，需要修改则原地改方案重新交卷。审批不再跨 run。
2. **runtime 持有全部状态转换，renderer 只做呈现。** 三档按钮的语义（状态机迁移 + 回执文案）全部由 runtime 决定；渲染端删除代发消息逻辑，事件链从"run 外持久监听"收敛回"run 内订阅"。
3. **复用已验证的机制，不发明新的。** 等待复用 ask_user 的排他轮 + requestUserClarification + 双时钟（userWait 不计执行超时）；持久化与崩溃恢复复用 P1 的 state.json + 统一降级语义，一行不改。

---

## 三、目标链路：新增 submit_plan 交卷工具

### 3.1 为什么是新增工具，而不是改造 write_plan

write_plan 承担"落盘计划草稿"职责，讨论期间模型可能多次调用整份覆盖（现状已支持）；交卷是另一个动作——"讨论收敛了，请用户审阅"。两者分离后：

- 讨论期间反复 write_plan 不会反复弹审批卡；
- 语义与 ZCode 对齐：write_plan ≈ 写计划文件，submit_plan ≈ ExitPlanMode（提请审批 + 等待 + 带回执退出讨论态）；
- 状态机衔接干净：PLAN_DISCUSSING → PLAN_REVIEW 的迁移点从"run 结束时（agui-bridge 编排）"迁回"工具执行时（状态机自身）"，[plan-mode.ts](../../../src/main/orchestrator/plan-mode.ts) 的 moveToReview 从此由 harness 内部调用，agui-bridge 不再触碰状态机。

### 3.2 工具定义

`submit_plan`（harness builtin，与 enter_plan_mode / write_plan 同组，不走权限链）：

```text
名称：submit_plan
参数：无（计划全文已在 write_plan 落盘，submit_plan 不重复传内容）
描述要点：讨论收敛后提交计划交用户审批；调用后运行会原地等待用户决定，
  结果作为工具结果返回：批准则立即开始执行，需要修改则根据意见修订计划
  后再次 write_plan + submit_plan，不批准则退出计划模式。
状态守卫：仅 PLAN_DISCUSSING 且本轮 write_plan 已完成（planWrittenThisRun）时可用，
  其余状态一律 failure（runtime_safety），与 ZCode 的 InvalidStateTransition 同语义。
```

执行流程（[plan-tools.ts](../../../src/main/orchestrator/harness/plan-tools.ts) 新增 executeSubmitPlan）：

```text
校验状态（PLAN_DISCUSSING + planWrittenThisRun；失败即 failure 返回）
→ moveToReview（DISCUSSING → REVIEW；此时 state.json 已 durable 落盘，P1 语义原样生效）
   并消费 planWrittenThisRun（原"run 结束时消费"的时机迁移至此）
→ 读计划全文，经 HarnessEvent 发 "计划待审" 通知（渲染端打开计划面板）
→ requestUserClarification 弹三档审批卡（复用 ask 卡通道，见第四节）
→ 等待用户决定（排他轮内，双时钟 startUserWait，不消耗执行超时预算）
→ 按三档出回执（见 3.3）
```

### 3.3 三档回执（语义分层，用户拍板）

| 用户选择 | 状态机迁移 | 工具回执（模型可见） |
|---|---|---|
| **批准** | approvePlan：REVIEW → EXECUTING | `用户已批准该计划，现在开始执行。请严格按计划清单顺序执行，用 update_todo 维护任务进度。以下是批准的计划全文：` + 计划全文 |
| **需要修改**（附意见全文） | supplementPlan：REVIEW → DISCUSSING | `用户要求先修改计划，再重新提交审批。修改意见如下：` + 意见全文 + `请根据意见修订计划，调用 write_plan 整份覆盖后，再调用 submit_plan 重新提交。` |
| **不批准** | exitPlanMode：→ NORMAL | `用户否决了该计划，已退出计划模式。不要执行计划中的任何步骤。请询问用户接下来想如何处理。` |
| 超时 / 取消等待 | supplementPlan：→ DISCUSSING | `等待审批超时，已回到计划讨论状态。计划文件已保留，用户下次回复后可继续讨论；讨论收敛后可重新提交审批。` |

回执设计要点：

- **批准回执自带计划全文**（模仿 ZCode formatExitPlanModeModelContent：批准 = 执行许可 + 计划原文）。这是因为同 run 继续时，run 上下文是 run 开始时构建的，没有 [PLAN_CONTEXT] 注入块——执行许可必须由工具结果自带给模型。
- **三档文案语义分层**：批准 = 许可 + 开工指引；需要修改 = 修订指引（回到讨论）；不批准 = 终止 + 明确禁止执行。三档措辞不混用，模型能正确区分"还要继续磨方案"和"整个方案被否掉"。
- **回执走工具结果，不走 [PLAN_CONTEXT] / [PLAN_RECOVERY] 注入块**。[PLAN_CONTEXT] 的职责是"跨 run 的执行许可"（批准后新开 run 的场景，如崩溃恢复后），[PLAN_RECOVERY] 的职责是"崩溃后的事实参考"；本次交卷的答复是一次工具调用的直接回应，属于工具结果。三个通道各司其职。

### 3.4 排他与双时钟：完全复用 ask_user 机制

- [tool-round.ts L68-L70](../../../src/main/orchestrator/harness/tool-round.ts) 的排他集合加入 submit_plan：`new Set(["ask_user", "confirm_uncertain_effect", "submit_plan"])`。与 ask_user 同轮出现的其他工具调用统一 not_executed，模型基于回执重新决策。
- 排他轮内现有逻辑原样生效：`clock.startUserWait()` / `stopUserWait()`（等待不计执行超时）、tool_start / tool_end 事件（运行流中出现"提交审批"卡片，等待与结果可见）、raceWithSignal（用户点停止 → abort → 等待即取消）。
- dispatch 走 `run.askDispatchContext`（已注入 requestUserClarification），不需要新的注入通道。

### 3.5 超时：审批专用配置，不沿用快问快答的 60s

现状审批卡沿用 userChoiceTimeout（默认 60s，设置页"询问等待时间"）。审批是重决策——用户要通读整份计划，60s 连阅读都不够，超时即静默拉回讨论，体验是断的。

新增 `planApprovalTimeout`（[timeout-types.ts](../../../src/shared/timeout-types.ts) 默认 600_000 即 10 分钟，设置页可调）。submit_plan 等待用它；ask_user 等快问快答维持 userChoiceTimeout 不动。超时语义见 3.3 第四行：**宁可拉回讨论态等用户回来，绝不默认批准，也不默认否决**。

### 3.6 状态机改动清单（[plan-mode.ts](../../../src/main/orchestrator/plan-mode.ts)）

| 函数 | 改动 |
|---|---|
| `moveToReview` | 保留实现，**调用点**从 agui-bridge startPlanReviewFlow 迁到 executeSubmitPlan；planWrittenThisRun 的消费时机同步迁移 |
| `approvePlan` | 不改（submit_plan 批准分支调用） |
| `supplementPlan` | 不改（需要修改 / 超时分支调用） |
| `exitPlanMode` | 不改（不批准分支调用） |
| `restorePlanSession` 等 P1 全家 | **一行不改**（见第五节推演） |

---

## 四、三档审批 UI（用户拍板定稿）

### 4.1 交互形态

一张卡三个平级主按钮，取代现状两段式：

```text
┌──────────────────────────────────────────────┐
│  计划已提交，请审阅右侧计划面板后决定            │
│                                              │
│  [ 批准 ]      [ 需要修改 ]      [ 不批准 ]    │
│                                              │
│  （点击"需要修改"后原地展开 ↓）                 │
│  ┌────────────────────────────────────────┐  │
│  │ 请描述你想修改的内容（自动聚焦）          │  │
│  │                                        │  │
│  │                                        │  │
│  └────────────────────────────────────────┘  │
│  [ 提交修改意见 ]  （Ctrl+Enter 提交）        │
└──────────────────────────────────────────────┘
```

- **批准**：点击即提交，状态机 → EXECUTING，run 内模型直接开工。
- **需要修改**：点击后**原地展开**大输入框（不弹第二张卡），自动聚焦光标；用户填写具体意见后提交（按钮或 Ctrl+Enter，沿用 ZCode ElicitationDialog 的防误触约定）；空文本不提交（提示填写）。状态机 → DISCUSSING。
- **不批准**：点击即提交，**不展开输入框**；状态机 → NORMAL，退出计划模式。
- 三档提交后卡片结算清空（复用 cyrene.choice.dismiss 通道），等待期间计划面板保持打开。

### 4.2 卡片协议：AskClarificationCard 新增 mode

复用 ask 卡通道（requestUserClarification → cyrene.choice / cyrene.choice.dismiss → CHOICE_RESOLVE IPC），不新建事件体系：

- [AskClarificationCard](../../../src/shared/ask-clarification.ts) 新增 `mode: "plan_approval"`（现有 mode 旁新增枚举值）+ `planPath`；
- 渲染端交互卡组件按 mode 识别，渲染上述三按钮布局（**过渡期兼容**：第一批施工先以现有 single_select 三选项渲染跑通语义，专属卡片 UI 第二批替换，见实施批次）；
- 回传答案沿用 AskUserAnswer：`{ field: "plan_decision", selectedValues: ["approve" | "revise" | "reject"] }` + `customText`（修改意见，revise 时必填）；
- 三档**全部不删计划文件**——计划文档是项目资产（P0 设计原则第 3 条），不批准也保留在工作区供用户回看。

### 4.3 渲染端改动清单

| 位置 | 改动 |
|---|---|
| [ChatPage.tsx L571-L623](../../../src/renderer/react/features/chat/pages/ChatPage.tsx) 持久监听 | **退役**：cyrene.plan.approved 代发执行消息、cyrene.plan.supplement 代发用户消息两个分支删除；审批卡改走 run 订阅（与 ask_user 卡同路径） |
| 交互卡组件 | 新增 plan_approval 模式分支（三按钮 + 展开输入框 + Ctrl+Enter） |
| i18n（zh-CN / en） | 三档按钮与回执文案 key；删除 planApprovedAutoMessage |

---

## 五、崩溃恢复推演（复用 P1，零改动验证）

等待挂进 run 内之后，P1 的持久化语义是否仍然成立？逐场景推演：

| 场景 | state.json 此刻内容 | 重启后恢复行为（P1 既有实现） | 结论 |
|---|---|---|---|
| DISCUSSING 中崩溃（尚未交卷） | `PLAN_DISCUSSING` | 原样恢复 DISCUSSING，无注入 | 不变 |
| **等待审批中崩溃**（submit_plan 已执行，REVIEW 已 durable 落盘） | `PLAN_REVIEW` | 降级 DISCUSSING + recoveredFrom=REVIEW，首条消息注入 [PLAN_RECOVERY]（"等待审批时被中断"文案 + 计划草稿全文） | **与 P1 完全一致**——迁移点变了，但 REVIEW 的落盘时机仍是 durable transition，恢复语义无需重推 |
| 批准后 EXECUTING 中崩溃 | `EXECUTING` | 降级 DISCUSSING + "不要假设未执行"警示，不自动续跑 | 不变 |
| 等待中用户点停止（abort） | `PLAN_REVIEW`（已落盘） | run 以 cancelled 结算，cancelPendingChoicesForRun 清卡；REVIEW 残留至用户下条消息补拉回（preparePlanRunContext supplementPlan），或重启后按 REVIEW 恢复 | 可接受：残留的 REVIEW 语义 = "审批被中断"这个事实本身，两条路径（发消息 / 重启）都正确收敛回讨论态 |

推演结论：**P1 的状态机、persister、restorePlanSession、[PLAN_RECOVERY] 注入一行不改**。唯一的新前提是 submit_plan 在 moveToReview 后才发起等待——这由 durable persister 保证（moveToReview 返回时 state.json 已在磁盘），顺序天然正确。

**边界：等待期间的插话。** run 活跃时渲染端 composer 处于 busy（sendMessage 排队），UI 层天然无法在等待中插话；排队的消息在 run 结束（超时/取消）后发出，preparePlanRunContext 的 supplementPlan 把 REVIEW 拉回 DISCUSSING，语义顺滑。v1 依赖该 busy 锁，不为插话另做通道；若后续开放插话，须显式设计"插话取消审批等待"的迁移，本方案不预留。

---

## 六、IPC 事件收敛

| 事件 | 现状 | 新设计 |
|---|---|---|
| `cyrene.plan` action=state_changed / written | run 内（event-mapper） | 保留不动 |
| `cyrene.plan.review`（计划全文 → 面板） | run 外，startPlanReviewFlow 发 | **迁移**：submit_plan 执行时经 run 内事件链发出（走 HarnessEvent 新增 plan_submitted，由 event-mapper 映射，与 plan_written 同路） |
| `cyrene.choice` / `cyrene.choice.dismiss` | 审批卡与 ask 卡共用 | 保留（三档卡走同一通道） |
| `cyrene.plan.approved` | 渲染端据此代发执行消息 | **删除** |
| `cyrene.plan.supplement` | 渲染端据此代发用户消息 | **删除** |
| `cyrene.plan.completed` | run 内执行收尾通知 | 保留不动 |
| `cyrene.plan.exited`（如存在退出通知） | — | 保留（不批准时由状态机广播自然触发） |

收敛后 `shouldListenForDeferredPlanEvents`（conversation-run-policy.ts）名存实亡，随持久监听退役一并删除。

---

## 七、EXECUTING 同 run 衔接（与 P0 守卫）

批准后模型同 run 开工，与 P0 的 Plan 只读守卫如何衔接？**无需任何改动**，推演如下：

- P0 守卫（[tool-runtime.ts](../../../src/main/orchestrator/harness/adapter/tool-runtime.ts)）按 `isPlanReadOnly` 拦截，其定义为 `state === "PLAN_DISCUSSING" || "PLAN_REVIEW"`。批准瞬间状态已切 EXECUTING，**不在守卫集合内**，修改类工具自然放行——"先规划不要动"的契约在 REVIEW 阶段仍然压过一切权限档位，批准后契约履行完毕。
- 工具清单是 run 级固定的：DISCUSSING 时注入的 submit_plan 在批准后仍在清单里。若模型执行中再次误调 submit_plan，状态守卫（仅 PLAN_DISCUSSING 可用）以 failure 回执拦下，无死循环风险。update_todo 本就在清单中，开工指引直接可用。
- run 结束时 completePlanRun 照旧：completeExecution → NORMAL → cyrene.plan.completed。**同 run 开工不改变执行收尾的任何语义。**

---

## 八、未决问题的决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 多轮"需要修改"是否设轮次上限 | **不设上限** | 每一轮都是用户主动选择，不是自动循环；submit_plan 的状态守卫（仅 DISCUSSING 可用）已天然防住"被否决后立刻重交"——不批准后状态是 NORMAL，再交卷必须重新走 enter_plan_mode，用户全程握有方向盘 |
| 回执注入位置：工具结果 vs 注入块 | **工具结果** | 见 3.3；[PLAN_CONTEXT] / [PLAN_RECOVERY] 的 run 级职责不被侵蚀 |
| 审批等待超时时长 | **新增 planApprovalTimeout，默认 10 分钟** | 见 3.5；60s 是快问快答的配置，不能覆盖"通读计划做决策" |
| "需要修改"的意见必填吗 | **必填**（空文本不提交） | 空意见的"需要修改"对模型毫无信息量，等于让模型瞎猜 |

---

## 九、验证清单

### 语义主链

| # | 场景 | 预期 |
|---|---|---|
| 1 | DISCUSSING 中 write_plan → submit_plan（同 run） | 弹三档卡，run 挂起等待，计划面板打开 |
| 2 | 点"批准" | 状态 → EXECUTING；回执含计划全文；**同一 run** 内模型开工（无新消息、无新 run）；修改类工具放行；run 结束回 NORMAL + completed 通知 |
| 3 | 点"需要修改"填意见提交 | 状态 → DISCUSSING；回执含意见全文；模型原地 write_plan 覆盖 → submit_plan 二次交卷，二审卡片正常弹出 |
| 4 | 点"不批准" | 状态 → NORMAL；回执含"禁止执行"语义；run 收尾；**计划文件仍在工作区** |
| 5 | submit_plan 空等 10 分钟（planApprovalTimeout） | 超时回执 → DISCUSSING；run 正常收尾；卡片结算清空 |
| 6 | 等待中点"停止" | run cancelled；卡片取消；REVIEW 残留由下条消息拉回 DISCUSSING |
| 7 | REVIEW / EXECUTING 态误调 submit_plan | failure 回执（状态守卫） |
| 8 | PLAN_DISCUSSING 未 write_plan 直接 submit_plan | failure 回执（planWrittenThisRun 守卫） |
| 9 | 同轮 submit_plan + read_file | read_file not_executed（排他轮） |
| 10 | allow_all + 批准后执行 | 契约已履行，写工具放行（P0 衔接，见第七节） |

### 崩溃恢复（P1 回归）

| # | 场景 | 预期 |
|---|---|---|
| 11 | 等待审批中杀进程 → 重启 → 发消息 | 降级 DISCUSSING，首条消息带 [PLAN_RECOVERY]（REVIEW 版本文案）+ 计划草稿全文 |
| 12 | 批准后 EXECUTING 中杀进程 → 重启 | 同 P1：降级 + "不要假设未执行"警示，不自动续跑 |
| 13 | moveToReview 返回瞬间杀进程 | 磁盘已是 PLAN_REVIEW（durable 写，P1 验证项回归） |

### UI 与事件

| # | 场景 | 预期 |
|---|---|---|
| 14 | 三档按钮平级展示；"需要修改"展开框自动聚焦 | Ctrl+Enter 可提交；空文本提示填写 |
| 15 | 全链路 grep：cyrene.plan.approved / cyrene.plan.supplement / startPlanReviewFlow / shouldListenForDeferredPlanEvents | 无残留引用 |
| 16 | i18n：三档与回执文案 zh-CN / en 双语齐全 | 无硬编码文案 |
| 17 | `npm run typecheck` + plan 相关测试全量 | 通过 |

---

## 十、风险与回滚

| 风险 | 评估 | 对策 |
|---|---|---|
| run 生命周期被审批等待拉长（用户不操作时 run 一直挂着） | 低——userWait 不计执行超时是既有机制 | planApprovalTimeout 兜底结算；等待中 renderer busy 锁与现状 run 活跃语义一致 |
| 等待中插话绕过审批卡 | 低——composer busy 锁天然阻断 | v1 依赖 busy 锁（第五节）；排队消息在 run 结束后发出，语义顺滑 |
| moveToReview 迁移后 planWrittenThisRun 消费时机变化引入回归 | 中——触发点跨模块迁移 | 8 号验证项直测；plan-mode.test.ts 补迁移点用例 |
| 三档卡过渡期（第一批用 single_select 渲染）体验打折 | 低——两批间隔短 | 批次顺序：先跑通语义（第一批），再做专属 UI（第二批）；过渡期功能完整可用 |
| 删除渲染端代发逻辑后，遗漏某条旧事件路径 | 中——事件链分散 | 15 号验证项 grep 清单兜底；三个批次各自独立 commit，可单独 revert |
| 旧会话残留 state.json（REVIEW）在升级后首个消息 | 低 | preparePlanRunContext 补拉回 DISCUSSING（既有行为，不受本改动影响） |

---

## 十一、实施批次

| 批次 | 内容 | Commit |
|---|---|---|
| 第一批（runtime 语义） | submit_plan 工具（executeSubmitPlan + 三档回执）+ 排他轮接入 + planApprovalTimeout 配置 + plan-mode 触发点迁移 + agui-bridge 删 startPlanReviewFlow + 工具清单注入更新 + plan-mode / plan-tools 测试 | 1 个 commit |
| 第二批（三档卡片 UI） | AskClarificationCard 加 plan_approval 模式 + 渲染端三按钮 / 原地展开 / Ctrl+Enter / 空文本校验 + i18n | 1 个 commit |
| 第三批（清尸收尾） | ChatPage 持久监听退役 + cyrene.plan.review 迁移到 run 内事件链 + 删除 planApprovedAutoMessage 等残留 + conversation-run-policy 清理 | 1 个 commit |

每批完成后按验证清单对应条目逐一验证，通过再进下一批。第一批完成后旧两段式卡片 UI 由 single_select 三选项过渡渲染（功能等价），第二批替换为三档专属卡片，第三批删除全部旧链路。
