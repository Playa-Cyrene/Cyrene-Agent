# 取消自动补发 + 中断状态进上下文 设计方案（v2）

日期：2026-09-22（v2 修订，吸收评审意见）
分支：`chore/upgrade-ag-ui-1.0.0`（AG-UI 升级 + Fix A/B 已在同分支完成，本方案为后续改动）

---

## 一、背景

### 1.1 现象（2026-09-21 晚 smoke 测试）

用户只发送了一条消息，流式回答正常，但出现三类报错：

1. `SESSION_RUN_ACTIVE:run-1790073753338-53omeg`——UI 显示为"模型请求失败"
2. `TRANSCRIPT_IDEMPOTENCY_CONFLICT`——`chats:get` 持续报错
3. `code-git:watch 找不到当前对话`

### 1.2 根因

**报错 2 与 3** 已由 Fix A / Fix B 修复（同分支，已完成）：

- Fix A：commit `79fad414` 改了 user 条目 id 格式，旧格式会话 v1→v2 迁移时撞次级幂等键 → 迁移改为跳过已落盘轮次
- Fix B：`SESSION_RUN_ACTIVE` 错误被 Electron invoke 包装后 `startsWith` 匹配不上，显示成通用"模型请求失败" → 改为 regex 匹配

**报错 1 的根源是渲染端待发队列的自动续派机制**：

- run 被主进程接受的瞬间，`AgentRunController` 调用 `pendingCompleteDispatch` 清除认领（`AgentRunController.ts:299-324`），因此**正常取消（接受后停止）不会残留任何状态，不会触发自动补发**
- 认领残留的三种来源：
  1. 派发确认 IPC 静默失败（代码只 `console.warn` 放过，`AgentRunController.ts:311-323`）
  2. 认领成功到 run 被接受之间有多次 IPC 往返，窗口内并发进入的队列消费会把"正在派发"误判为"未派发完"
  3. 认领后进程退出
- 残留一旦存在，`consume()` 的触发点（会话切换 `ChatPage.tsx:780`、run 结束回调 `ChatPage.tsx:1309` 等）走到 `resumePendingDispatch`，`evaluateClaimRecovery` 判定"未派发"（旧 run 无终态回答），**自动调用 `startClaimedRun` 启动第二个 run**，撞上仍在流式中的第一个 run，被主进程 `SESSION_RUN_ACTIVE` 守卫拒绝
- `pending-queue-flow.ts:238` 的注释表明设计者有意把"run 进行中"列为自动续派场景——这是本方案要废除的语义

### 1.3 关键现状（v2 修订：认领生命周期的真实形态）

**认领状态机（chats-store）**：

- `claimPendingMessage`（`chats-store.ts:828-902`）：v2 认领时，用户消息**只写入 `pendingDispatch.userMessage` 快照**，不进 `record.messages`；队首同时移出 `pendingMessages`。写盘一次完成（不半途丢消息）
- run 派发时主进程 `appendUser` 写权威轨迹（`agui-bridge.ts:610`）——**只有走到这一步，消息才算真正持久化**
- `completePendingDispatch`（`chats-store.ts:914-926`）：直接 `delete session.pendingDispatch`——**快照随簿记一起删除**

**由此推出关键结论**："认领成功但主进程从未接受 run"的场景下，`pendingDispatch.userMessage` 是用户消息的**唯一副本**。任何"清簿记"式的恢复都会让消息既不在轨迹、也不在队列——刷新后消失，用户下句"继续"时模型看不到原问题。**原 v1 方案在此处有 P0 缺陷，v2 重新设计（见 2.3）。**

**中断投影的现状**：

- `reduceActiveTranscript` 归约时直接忽略 interruption 条目（`conversation-transcript-projection.ts:145`），但原始 entries 仍可扫描
- **送达失败提示已实现**（`failedDeliveryNotesWithSources` + `insertDeliveryNotes`，`conversation-transcript-projection.ts:233-300`）：从 entries 扫描 delivery_receipt → 找 assistant 后的下一个活动 user → 该 user 后无 assistant 则在其前插入一次性内部提示。提示形态为 `role: "system"` + `visibility: "internal"` + `internal { kind, revision, digest, id, runId, createdAt }`，带 sourceSeq 保证压缩/重放一致。**本方案的中断提示与此同构**

**主进程侧其余利好现状**：

- 上下文构建：所有入口从 canonical journal 构建上下文，渲染端传的历史消息被运行时显式丢弃（`agui-bridge.ts:671`）
- run 派发顺序：先 `appendUser`（`agui-bridge.ts:610`）→ 再 `buildModelContext`（`agui-bridge.ts:654`）→ 轨迹写失败 fail-closed（`agui-bridge.ts:655-662`）
- 工具中断警告已存在：投影层合成 `unknown`（"该工具已启动但结果未知……不得自动重放"）/ `not_executed`（"该工具从未执行……自行决定是否重新调用"）消息（`conversation-transcript-projection.ts:155-168`）
- 非幂等副作用警告已存在：`uncertainEffects` → `formatTranscriptUncertainEffects`（`build-options.ts:958`）
- 取消时轨迹闭合已存在：`closeInterruption`（`transcript-sink.ts:104-155`）写 interruption 条目 + 为未闭合工具补写 tool_result

---

## 二、设计意图

### 2.1 核心语义

```text
上一轮结束
→ 完整记录发生过的事情
→ 不自动补发、不自动续跑
→ 等待用户输入
→ 用户发送任意新消息
→ 用"此前全部上下文 + 用户新消息"启动新一轮
```

### 2.2 不变量（v2 修订：收窄到恢复/对账域）

> **恢复、对账、重载和投影缺口不得产生模型请求。新请求只能来自当前用户意图，或用户事先明确授权的调度/主动任务。**

不写成"系统级宪法"的原因：scheduler（定时任务）与 proactive（主动搭话）是用户预授权的合法模型请求来源，不受此不变量约束。

**新 run 触发链审计（改造后）**：

合法触发（当前用户意图）：

- 用户点发送 → `sendMessage` → `consume` → 认领派发
- 用户语音输入 → `submitTextToSession` → 派发
- run 结束后消费用户排队发的消息（发送时意图已存在，属"延迟执行"）
- 用户点接管操作卡 → takeover 重试（`AgentRunController.ts:414`）
- 外部渠道消息（QQ/微信等外部用户）

合法触发（预授权，本方案不动）：

- scheduler 调度任务
- proactive 主动搭话

删除的非法触发：

- ~~认领残留 + 无终态回答 → 自动 `startClaimedRun`~~（`pending-queue-flow.ts:272`）

### 2.3 认领状态机（v3 修订：搁置机制不必要，P0 已被现有 reconcile 解决）

v2 评审提出 P0："清簿记会删掉用户消息唯一副本"。**实施时发现该前提在 IPC 层不成立**——认领的真实入口 `sessionMigration.claimPendingMessage` 有两道 reconcile 保险：

1. **认领时**（conversation-session-migration.ts:126-149）：store 认领成功后、返回 claimed 给渲染端**之前**，`reconcilePendingDispatch` 把快照写进权威轨迹（幂等 id `user:v1:{turnId}:r1`）；轨迹写失败则整个认领返回 `transcript-write-failed`
2. **每次读取时**（conversation-session-migration.ts:151-157，`loadCurrentRecord`）：每次 `chats:get` 都无条件 reconcile

而 `resumePendingDispatch` 的唯一入口 `consume()` 在触达它之前必先 `store.get`——所以**任何"清簿记"执行到的那一刻，消息已确定在轨迹里**。唯一丢消息窗口（认领 IPC 内部崩溃）会被下一次任意 get 自愈。

因此认领生命周期实际为：

```text
claimed（认领即落轨迹：reconcile 在 claim IPC 返回前完成）
→ cleared（run 接受时确认清除，或恢复逻辑清账）
```

"accepted" 证据问题不复存在；搁置状态机、`awaitingUserAction` 标记、agui-bridge 补写旧快照**全部不需要**。用户下一条消息发出后：新消息认领时同样落轨迹，`buildModelContext` 天然同时看到旧意图与新消息（旧意图已由 claim-time reconcile 在轨迹）。

### 2.4 中断状态进上下文（v2 修订：同构 delivery note 算法）

**不沉默、不伪造 assistant、合成为一次性内部 system message。**

**注入算法（与 `failedDeliveryNotesWithSources` 同构）**：

1. 从原始 entries 扫描 interruption 条目（不经 activeNodes 归约——归约会忽略它）
2. 找到该中断**之后**（`seq` 大于中断条目）的**第一个活动 user**
3. 若该 user 之后**尚无 assistant**，则在它之前插入内部提示；一旦该 user 后产生 assistant，提示自然不再注入（一次性语义）
4. `sourceSeq` 用中断条目的 seq，保证压缩与重放一致
5. 必须按活动分支处理 `turn_rewind` 与 `turn_tombstone`（中断所在分支被裁掉时提示不注入）

**闭合判定为"中断后第一个 user 后出现 assistant"，不是"出现任意 assistant"**——带工具调用的 assistant 可能在中断之前已经存在，不能误判为已闭合。

**提示形态（复用现有内部恢复消息，不造裸 system message）**：

```ts
{
  role: "system",
  visibility: "internal",
  content: "<按类别选择的文案>",
  internal: {
    kind: "recovery",
    revision: 1,
    digest: "<稳定摘要，如 interruption id + reason>",
    id: `<interruption-entry-id 派生>`,
    runId: <中断条目 runId>,
    createdAt: <中断条目 at>,
  },
}
```

**位置说明（次要修订）**：Anthropic 与 Responses 适配器会把系统消息提取并提升到顶层（`anthropic-adapter.ts:122`、`responses-adapter.ts:140`），因此提示只能保证**逻辑关联**（紧贴中断后的 user 轮），不能依赖最终线序位置。OpenAI 适配器保持原位。

**五类停止类别（v2 修订：本次承诺范围收窄）**：

| 类别 | 本次承诺 | 轨迹记录 | 提示文案 |
|------|----------|---------|---------|
| `user_cancelled` | ✅ | 已有 `interruption(reason: "user_cancel")` | `[上一轮由用户主动停止，未完整结束。不要自行延续上一轮；以用户最新消息为准。]` |
| `failed`（技术失败，含 timeout） | ✅ | 现状缺失，本次补写 | `[上一轮因系统错误未完整结束，没有生成完整回答。请结合用户最新消息决定是否继续。]` |
| `crashed`（进程崩溃） | ❌ **明确列为后续非目标** | 崩溃时无人写入，需启动对账 | （后续） |
| `superseded`（被编辑/重新生成取代） | N/A | `turn_rewind` 已把旧分支从 active 序列裁掉，模型看不到 | 不需要——轨迹结构本身已表达 |
| `delivery_failed`（送达失败） | ✅ **已实现，无需改动** | `delivery_receipt` + `failedDeliveryNotesWithSources` 现有实现 | 现有实现 |

文案统一用"未完整结束"而非"未生成完整回答"——中断前可能已产生部分 assistant 内容或工具调用。

**`closeInterruption` 改造**（`transcript-sink.ts:43-155`）：现状接口只接受 `user_cancel`，工具结果文案写死"取消"。需：

- `reason` 参数化（`"user_cancel" | "runtime_error"`），工具结果文案按 reason 生成（取消 → 现有文案；系统错误 → "上一轮系统错误，结果未知"类文案）
- 覆盖调用点：Harness 正常返回的 runtime_error/timeout、ChatLoop 抛错路径、已有 assistant/tool call 后失败

工具 unknown 警告由现有 `syntheticToolMessage` 覆盖，与本提示不重复。

---

## 三、改动清单

### 第一层：删除自动续派（v3 已实施：三处改动 + 测试）

1. **[pending-queue-flow.ts](e:\Cyrene-Agent\src\renderer\react\features\chat\pages\pending-queue-flow.ts)**——`resumePendingDispatch`：`dispatched` 与 `needs-dispatch` 分支统一为"清派发簿记 + 继续消费队列"；删除 needs-dispatch 的自动 `startClaimedRun`（即自动补发）与占位补插。claim-message-missing（数据损坏）保持暂停报错
2. **[conversation-session-migration.ts](e:\Cyrene-Agent\src\main\orchestrator\conversation-session-migration.ts)**——`claimPendingMessage` 残留认领分支：reconcile 落轨迹 + 清残留账 + 照常认领下一条；删除 `buildRecoveredClaim`（把旧消息当新认领返回 = 另一条自动补发路径）及 chats-store 的孤儿包装 `pendingDispatchUserMessage`
3. **注释同步**：`startClaimedRun`、`AgentRunController` 的 claimedPendingMessageId 字段与确认处注释（"保留供恢复续派"→"保留给恢复逻辑清账"）
4. **测试**：渲染端翻转"未派发恢复/关联性"两用例 + 新增"残留+下一条只派发下一条""清账写盘失败保留入口"；主进程更新"v2 claim 轨迹写失败重试"（重试不再返回旧消息）+ 新增"残留认领再认领返回下一条且轨迹保留两者"

### 第二层：中断状态进上下文（v3 已实施）

6. **[conversation-transcript-types.ts](e:\Cyrene-Agent\src\main\orchestrator\conversation-transcript-types.ts)** + **[conversation-transcript-store.ts](e:\Cyrene-Agent\src\main\orchestrator\conversation-transcript-store.ts)**：`interruption` 的 `reason` 扩为 `"user_cancel" | "runtime_error"`，store 值域校验同步
7. **[transcript-sink.ts](e:\Cyrene-Agent\src\main\orchestrator\transcript-sink.ts)**：`closeInterruption` 按 reason 参数化——工具闭合文案区分取消（"工具执行中被取消，结果未知"/"取消时未开始执行"）与系统错误（"上一轮系统错误，工具已启动但结果未知"/"上一轮系统错误时未开始执行"）；interruption 边界 id 保持 `${runId}:interruption:${reason}` 确定性幂等
8. **调用点补齐**：
   - [harness-adapter.ts](e:\Cyrene-Agent\src\main\orchestrator\harness-adapter.ts)：取消闭合后新增 else-if 分支——`timeout` / `runtime_error` 终态同样调 `closeInterruption(runtime_error)`（带 runSession，为 started/planned 工具补合成闭合）；闭合失败只记日志（终态本身就是失败）；else-if 结构保证取消闭合失败转出的 runtime_error 不会二次写入不同 reason
   - [cyrene-agent.ts](e:\Cyrene-Agent\src\main\orchestrator\cyrene-agent.ts)：正常路径 `terminal.status === "timeout"` 时幂等补写（Harness 已在 adapter 闭合，ChatLoop 在此闭合）；catch 路径（ChatLoop 抛错等）非取消错误统一 `closeInterruption(runtime_error)` 后再 `subscriber.error`
9. **[conversation-transcript-projection.ts](e:\Cyrene-Agent\src\main\orchestrator\conversation-transcript-projection.ts)**：新增 `interruptionNotesWithSources`（同构 delivery note 算法，见 2.4）+ 插入机制泛化为 `insertInternalNotes`（同一 beforeSeq 多条提示按来源 seq 排序成组插入，中断提示与送达失败提示不互相覆盖）；接入 `buildFullModelContextWithSources` / `buildCompactionSourceView` / `buildModelContextFromCompactedView` 三个模型上下文出口；**UI 投影不接入**（提示只进模型上下文）
10. **测试**：sink 层 runtime_error 闭合（类别/文案/幂等）；投影层 5 用例（注入位置与文案、runtime_error 语义、闭合判定、工具调用 assistant 不误判闭合、尾部暂不注入）

### 第三层：崩溃对账（本次明确不做，列入后续非目标）

启动对账发现未闭合 run → 补写 `interruption(reason: "crashed")`。留待后续版本，本次验收不含。

### 明确不做的事

- 不做"重试"按钮——"继续"就是重试入口
- 不伪造 assistant 消息
- `superseded` 不加提示（turn_rewind 已裁掉旧分支）
- `delivery_failed` 不改（现有 `failedDeliveryNotesWithSources` 已覆盖）
- `crashed` 本次不做（见上）
- 不动 scheduler / proactive 触发链

---

## 四、验证计划

每层完成后：定向测试 + `build:main` + `check:renderer`；全部完成后 `npm test` 全量。

**必补测试（确定性竞态用例）**：

1. run 已被接受，但 `pendingCompleteDispatch` 失败、投影尚未出现 assistant：不得第二次调用 `agui:run`
2. run 从未被接受：恢复逻辑不得丢失 user 快照（搁置后快照仍在、消息 UI 可见、刷新不丢）
3. 残留认领（搁置）后用户发送新消息：模型上下文同时包含旧意图和新消息，只启动一次 run
4. `interruption → 新 user → 尚无 assistant`：注入一次提示
5. 中断后的 user 后续产生 assistant：提示不再出现
6. assistant 带工具调用后用户取消：仍注入取消提示，不被中断前的 assistant 误判为已闭合
7. runtime_error / timeout 分别验证：类别正确、工具结果文案正确、幂等（重复闭合不重复写入）
8. 用延迟轨迹提交复现"渲染端先结算、主进程后落盘"窗口（原始竞态回归）

**人工验证场景（smoke）**：

- 发消息 → 流式中点停止 → 无自动补发，消息保持"已发送未回答"
- 停止后发"继续" → 新 run 正常启动，模型上下文含中断提示 + 工具 unknown 警告（若有）
- 模型服务故意配错 → 启动失败显示错误，无自动重试循环，消息不丢
- run 进行中发第二条消息 → 排队，run 结束后正常派发（原则 4 行为不变）

---

## 五、实施顺序与提交策略

- 顺序：第一层 → 第二层（每层独立可验证）；第三层为后续非目标
- 提交：待全部完成并经用户验证后，与 AG-UI 升级、Fix A/B 分别独立 commit（具体拆分届时由用户决定）

---

## 附：修订记录

**v2 修订（2026-09-22 评审）**：

- **P0**：needs-dispatch"清簿记"会删掉用户消息唯一副本 → v2 引入三态状态机 + 搁置机制（2.3、改动 1-3）
- **P1**：一次性中断提示"末尾判定"自相矛盾且拿不到中断条目 → 改为同构 delivery note 算法，闭合判定改为"中断后第一个 user 后的 assistant"（2.4、改动 9）
- **P1**：失败/崩溃落盘协议不闭合 → 承诺收窄为 `user_cancel` + `runtime_error`，`crashed` 列为明确非目标；`closeInterruption` 按 reason 参数化文案（2.4、改动 7-8）
- **P1**：不变量范围过宽 → 收窄到恢复/对账域，scheduler/proactive 列为预授权合法入口（2.2）
- **次要**：标注适配器系统消息提升行为；提示复用 `visibility: "internal"` 完整形态；`delivery_failed` 现状描述修正为"已实现"；补齐 8 条确定性竞态用例（第四节）

**v3 修订（2026-09-22 实施发现）**：

- **P0 前提不成立**：认领 IPC（`sessionMigration.claimPendingMessage`）在返回前即 reconcile 落轨迹，且每次 `chats:get` 都会 reconcile；`consume` 触达恢复逻辑前必先 get——清簿记永不丢消息（证据见 2.3）。搁置状态机、新 IPC、agui-bridge 补写全部取消，第一层收缩为渲染端 + migration 两处改动（改动清单已更新为实际实施内容）
- 评审测试用例 1-3 在简化实现下全部成立：用例 1/2 由"清账不续派"保证；用例 3 由"两次 claim-time reconcile 落轨迹"保证（主进程测试已断言轨迹同时含旧意图与新消息）
