# 内部问题报告：跨 run 上下文不连续——工具历史在轮次间丢失（2026-09-20）

> 定性：架构级缺陷（严重）
> 状态：根因已定位，方案已定（2026-09-20 拍板：跳过短期止血，直接实施 CTA；下一步为独立设计文档）
> 关联：`2026-09-20-harness-recovery-orphan-tool-result-400-report.md`（恢复链路修复，相关问题）；施工文档施工包 A（孤儿闸门，CTA 崩溃恢复重放的前置依赖）

---

## 一、一句话问题

工具调用的完整历史只活在单个 run 内部；**用户每发一条新消息就开一个全新 run，transcript 从聊天记录的纯文本重建，上一轮（以及所有更早轮）的工具调用、参数、结果全部丢弃**。模型跨轮是"半失明"的。

---

## 二、现象（三个具体场景）

### 场景 1：打断后纠正——模型看不到"刚才那个操作"

运行中用户按中断，随后发"你先停，刚才那个操作不能这样，要 xxx"：

- 新 run 的上下文 = 会话历史纯文本（`AgentRunController.ts:255-259`：`session.messages.slice(-16).map(role, modelContext || content, at)`）；
- 中断那一轮的工具卡（工具名、参数、结果）存在 assistant 消息记录的**展示字段**里，根本不进发给模型的消息数组；
- 模型最多看到打断前它流式输出的旁白文字；若动手前没写旁白，"刚才那个操作"对它是猜的。

### 场景 2：正常跨轮长任务——重复摸索

不涉及打断，长任务天然跨多轮（多次用户消息）：

- 第 N 轮里模型已经 find/read 过的文件、跑过的命令，到第 N+1 轮全部不在上下文里；
- 模型只能靠三样东西补：自己的旁白文字、todo 状态（`buildTodoRecoveryContext` 有跨轮携带）、**重新调工具摸一遍**——表现为跨轮任务里反复 find/glob/read 同一批文件；
- 直接后果：token 浪费、行为退化、长任务连贯性差。根因就在这里。

### 场景 3：长会话窗口截断

渲染端只送**最近 16 条**消息（`slice(-16)`），更早的对话（含旁白文字）直接不进上下文，无压缩兜底，硬截断。

---

## 三、机制与根因

### 3.1 架构现状

```
用户消息 N ──> 新 runStore 会话（run-N，transcript 从聊天记录纯文本重建）
                └─ run 内：harness 主循环连续 transcript（多轮工具全在）✅
用户消息 N+1 ──> 又一个全新 runStore 会话（run-N+1，同样从纯文本重建）❌
```

- 权威 transcript 放错了层级：**跨 run 的权威源是聊天记录（纯文本 role+content），runStore 是"单 run 工作档案 + 崩溃恢复备份"**；
- runStore 检查点明明记了每个 run 的完整历史（消息 + 工具调用状态 + todo + cache），但只有"继续任务"按钮那条路（`resumeFromRunId` → `prepareHarnessRecovery`，`run-preparation.ts:111-122`）会读它；
- 打断（cancel）时数据都在：agui-bridge 的 takeover 等待的就是"checkpoint 落盘 + 副作用收尾"（`agui-bridge.ts:437-470`）——**不是日志不存在，是没人把日志接回去**。

### 3.2 唯一连续的路径：插话

运行中直接发消息（不按中断）→ 标记 `adjustRunId`（`chats-store.ts:839-844`）→ 在下一个模型请求边界注入当前 run（`agui-bridge.ts:505-508` 插话轮询）。此时 harness transcript 连续，模型对自己的工具操作**全知**。这佐证了问题不在记录能力，在接续链路。

### 3.3 与成熟项目的差异

| | Claude Code | Codex CLI | 我们 |
| --- | --- | --- | --- |
| 权威 transcript | 会话文件本身，跨消息追加 | rollout JSONL（append-only 全量） | 聊天记录纯文本（跨 run）；runStore（单 run） |
| 下一轮看到什么 | 前面所有轮的工具调用与结果（直到 /compact） | resume 重放完整状态 | 只有 role+content 纯文本 |
| 打断 | transcript 落 `[Request interrupted by user]`，工具留在原地，下一轮照常接 | 同左（rollout 记录中断点） | run 归档，工具明细留在旧 run，下一轮不读 |

成熟项目的共识：**打断只是"这一轮到此为止"的标记，上下文连续性是默认保证**。日志就是会话本身，不存在"回头去找"的动作。

---

## 四、影响面评估

1. 长任务跨轮连贯性差、重复调工具（token 成本 + 行为退化）——**常态影响**；
2. 打断后纠正消息失灵——安全相关（用户纠正的正是危险操作）；
3. 16 条窗口硬截断，无压缩兜底；
4. 修复窗口：插话机制（3.2）恰好说明模型上下文管理本身没坏，只是接续链路缺一段——补链路收益直接。

---

## 五、修复方案

### 5.1 根本对齐：会话级权威 TranscriptStore + run 级执行状态（已立项）

> 依据：2026-09-20 对 Claude Code（session JSONL）与 Codex CLI（rollout JSONL，源码级）的调研结论。核心原则：**正常下一轮不是 recovery**——turn 结束不意味着 transcript 结束，工具调用/结果是历史的一等公民，interrupt 只是 turn 边界，compaction 是历史压缩不是 UI 分页。

#### 5.1.1 目标架构：Conversation Transcript Architecture

```
Conversation
│
├── TranscriptStore              ← 会话级权威历史（append-only）
│   ├── user message
│   ├── assistant message
│   ├── tool call
│   ├── tool result
│   ├── interruption
│   ├── compaction checkpoint
│   └── ...
│
├── Run A                        ← 执行生命周期
│   └── transcript range 0..27
│
├── Run B
│   └── transcript range 28..52
│
└── Run C
    └── transcript range 53..
```

最重要的语义变化：

```ts
// 正常下一轮
transcript.append(userMessage)
startRun()
```

而不是 `resumeFromRunId(previousRunId)`。**resume 只保留给真正的恢复场景**：崩溃、进程重启、显式"继续任务"。打断只是 transcript 里落一条中断标记（turn 边界），turn 的 run 结算，transcript 不动。UI 消息从 transcript **投影**派生，而不是像今天这样反过来由 UI 文本**重建**模型历史。

#### 5.1.2 迁移主体：所有权翻转（ownership inversion）

真正的大改不是建一个 TranscriptStore，而是**谁持有历史**。

现状：

```text
Renderer
  owns session.messages
       ↓
AgentRunController
  slice(-16)
       ↓
Main / Harness
```

目标：

```text
Renderer
  sends new user input
       ↓
Main process
  owns authoritative transcript
       ↓
Harness
       ↓
UI receives projection
```

即 `chats-store / session.messages` 从"模型上下文权威源"降级为 **UI projection / 展示持久化**。这是实施时最大的波及面：`AgentRunController`、聊天持久化、run 创建参数、恢复逻辑都默认了现有所有权关系；**chat 模式（陪伴对话不走 harness，但共享同一套消息管道）的双模兼容**是调研看不到、我们必须自己处理的点。

#### 5.1.3 Compaction 升到 transcript 层

run 内 compaction 保留实现能力，但**触发与结果的生命周期不能只属于某个 run**：

```text
raw transcript prefix
        ↓ compact
replacement context/checkpoint
        +
subsequent transcript suffix
```

而不是"某个 run 压缩完，下一 run 又重新从 UI messages 开始"。16 条窗口截断随之废弃——窗口策略改为压缩策略。

#### 5.1.4 现有资产映射

| 资产 | 在新架构中的位置 |
| --- | --- |
| `run-store.ts` 执行侧（status/toolCalls/cache） | 原样保留——Run 该干的活它都在干 |
| `prepareHarnessRecovery` 的 transcript 重建 | 降级为纯崩溃恢复路径（对标 Codex `rollout_reconstruction`），不再承担日常语义 |
| run 内 compaction | 实现能力保留，触发/生命周期上移到 transcript 级 |
| `resumedFromRunId` 字段 | 语义收窄回"崩溃恢复 / 显式继续"，不承担正常多轮会话 |

#### 5.1.5 与施工包 A 的关系

- 施工包 A（孤儿闸门）是本方案的前置依赖：transcript 权威化后，崩溃恢复重放同样存在孤儿 tool call 的协议配对问题；
- `uncertainEffects`、孤儿工具处理等**真正属于执行恢复的机制仍然保留**——任何架构都需要。

#### 5.1.6 风险面

- 所有权翻转的双模（code/chat）回归面；
- 压缩正确性：transcript 级压缩后，崩溃恢复链路要在压缩后的历史上自洽；
- 现网存档兼容：既有 runStore 会话/聊天记录到新结构的迁移。

**下一步：出独立设计文档（含所有权翻转分阶段迁移方案），不在本报告展开。**

### 5.2 决策记录（2026-09-20 拍板）

1. **原短期方案 E（cancelled-run 自动续检查点）取消**：其价值仅存在于长期方案落地前的空窗期，且与"正常下一轮不是 recovery"的核心原则相悖；E 的目标（打断后纠正不失忆、跨轮工具历史连续）**并入 CTA 第一里程碑**；
2. **CTA 立项启动**：独立设计文档为下一交付物。里程碑排序原则——**先通跨轮连续性（消灭半失明），再做渲染端投影化（所有权翻转）**，避免打断失忆活到架构全部翻完；
3. **施工包 A 照常实施**：400 是现存 bug，与架构选型无关，且是 CTA 崩溃恢复重放的前置；
4. **Phase 1 范围 = 桌面 chat/work/code/learn 四模式**：外部渠道（微信/飞书/QQ/QQbot）为独立入口（`channels/bootstrap.ts` 的 `buildAndRunAgent`，纯文本历史过滤，不 agui-bridge dispatch）且耦合渠道策略沙箱，列入 **Phase 2 末尾整合**；渠道路径自身同样存在跨轮失忆（症状较轻），届时将 `priorMessages` 改读权威轨迹即可；
5. **实施路线 = 路线 2**（2026-09-20）：Phase 1 建立会话级轨迹权威源（`ConversationTranscriptStore`，JSONL + 物化快照，复用 runStore 两文件模式），Harness 与 ChatLoop 统一提交轨迹检查点，渲染端暂时双写、`session.messages` 退出模型上下文构建；正常取消在结算前闭合未配对工具调用并写 interruption 边界（写入侧协议完整性，不经 `prepareHarnessRecovery`，不属于 E）。路线 1（串接最新 run 检查点——chat 模式无检查点、模式切换断链、Phase 2 推倒重来）与路线 3（一次性全量翻转——违背里程碑排序、回归面最大）已否决。设计定稿见 `docs/design/2026-09-21-cta-conversation-transcript-architecture-design.md`。
