# CTA 设计文档：会话轨迹架构（Conversation Transcript Architecture）

> 状态：设计修订 v4；Phase 1 与 Phase 2（兼容面清理及验收）已落地（2026-09-22）
> 依据：`docs/internal-issue/2026-09-20-cross-run-context-discontinuity-report.md`（问题报告，含决策记录）
> 前置：施工包 A（孤儿闸门，`2026-09-20-harness-recovery-orphan-tool-result-400-construction.md`）先行落地
> 路线拍板（2026-09-20）：路线 2——Phase 1 建立会话级轨迹权威源 + 渲染端暂时双写；路线 1（串接 run 检查点）与路线 3（一次性全量翻转）已否决
> Phase 1 施工计划：`docs/superpowers/plans/2026-09-21-cta-phase-1.md`

---

## 一、目标与非目标

### 目标（Phase 1）

1. 主进程为桌面 **chat / work / code / learn** 四种模式构建模型上下文，权威源为会话级 `ConversationTranscriptStore`；
2. 跨轮工具历史连续：打断后纠正、正常跨轮对话不再失忆；
3. 废除渲染端 16 条消息硬截断（`AgentRunController.slice(-16)`）；
4. Phase 1 的产物（轨迹存储 + 上下文构建）**就是最终架构的组成部分**，Phase 2 只删双写、不推翻。

### 非目标（Phase 1）

- **不动 UI 呈现与交互**：渲染端仅一处数据通路改动（编辑/重新生成的 dispatch 附带回退锚点，见八）；
- **不做 compaction**：用过渡窗口规则（见六），压缩升层在 Phase 2；
- **不接外部渠道**：微信/飞书/QQ 在 Phase 2 末尾整合；
- **不动崩溃恢复路径**：`run-recovery.ts` 在施工包 A 后冻结，Phase 2 才改为轨迹重放；
- **不新增数据库**：复用现有文件存储、原子快照与 JSONL 日志模式；
- **不从 AG-UI 事件构建轨迹**：事件流是展示投影，与轨迹写入解耦（单向：执行 → 展示）。

---

## 二、架构总览

### 2.1 分层

```
Conversation（会话）
│
├── TranscriptStore（新增，权威）   ← 会话级 append-only 轨迹
│     user / assistant（原样 ChatMessage，含 rawAssistant、thinking、toolCalls）
│     tool_result / interruption / turn_rewind
│     backfill_boundary / compaction(占位)
│
├── RunStore（现有，职责不变）     ← 执行生命周期
│     status / checkpoint / 工具状态日志 / todo / runtime cache
│
└── chats-store session.messages（降级） ← UI 展示与既有功能
```

### 2.2 Phase 1 数据流

```
用户发消息（桌面四模式）
  → agui-bridge dispatch
      0. （重新生成）写 turn_rewind（keep_user，单行）
         （编辑）写 turn_rewind（replace_user，**同一行携带替换 user**——原子提交，见三/八）
      1. transcript.append(user 条目)（仅新输入走此步；regenerate 复用原条目、
         edit 的替换 user 已随 turn_rewind 行写入，均跳过）
      2. context = buildModelContext(transcript)   ← 权威构建，忽略渲染端 messages
      3. run 启动（Harness 工具循环 或 ChatLoop 聊天循环）
  → 执行中：两循环经 TranscriptSink 在 canonical 消息产生处写入
      assistant 条目（响应完整解析后、任何工具执行前落盘整组 toolCalls）
      tool_result 条目（工具完成时）
  → 结算：物化快照（原子写至确定 throughSeq）+ run 照旧结算

取消（用户打断）：
  闭合未配对 toolCalls → 追加 interruption 边界 → 结算
  （写入侧修协议完整性，不经 prepareHarnessRecovery，不属于 E）

崩溃：
  轨迹留下孤儿 toolCalls（无 tool_result）→ 读取侧按 runStore
  执行状态分类闭合：已启动 → unknown，排队未执行 → not_executed（见 6.3）
```

---

## 三、数据模型（信封 + 载荷）

**不重新发明协议模型**：条目 = 信封（轨迹管理字段）+ 载荷（**原样复用** `vendors/types.ts` 的 `ChatMessage` 与既有工具 outcome 分类——Anthropic 多轮需原样回传 `rawAssistant`）。

```ts
// 信封：每条 JSONL 一行
interface TranscriptEnvelope {
  seq: number;               // 会话内单调递增，快照/重放协议依据
  id: string;                // entryId，幂等主键
  at: number;
  kind: "user" | "assistant" | "tool_result" | "interruption"
      | "turn_rewind" | "backfill_boundary" | "compaction_checkpoint";
  runId?: string;            // 产生该条目的 run
  turnId?: string;           // userTurnId / assistantTurnId
  revision?: number;         // user 条目修订号（编辑替换递增，初值 1；
                              // replace_user 的 turn_rewind 行复用此字段表达替换条目的修订号）
  roundId?: string;          // Harness 主循环内的轮次（多轮工具）
}

// 载荷按 kind（assistant 为 canonical ChatMessage 原样，不改字段形态）：
// user        : { text; attachments?: PendingChatAttachment[] }
//               ——直接复用 shared/chat-types.ts 的稳定附件元数据：
//                  kind / name / filePath / mime? / caption? / hasAnnotations?
// assistant   : ChatMessage——content、thinking、rawAssistant（provider 原始响应）、
//               toolCalls?: ToolCall[]（{ id, name, arguments }，数组顺序即调用顺序）
// tool_result : { toolCallId; assistantEntryId; outcome; message: ChatMessage; fullRef? }
//               ——message 是当前 Harness 实际送回模型的 canonical role:"tool" 消息，
//                  原样保留 message / suggestion / truncated / preview / fullOutputRef / output 等
//                  已序列化内容；preview 不能替代它（ask_user 答案等可能超过展示预览）
// interruption: { reason: "user_cancel" }
// turn_rewind : { anchorUserTurnId; disposition: "keep_user" | "replace_user"; reason: "edit" | "regenerate";
//                 replacementUser?: { text; attachments?: PendingChatAttachment[] } }
//               —— replace_user 时 replacementUser 必填：与 rewind 同一行携带，
//                  单行落盘即原子完成"删旧 + 加新"，不存在两次追加之间的
//                  中间态（见八）；替换条目的修订号即信封 revision
// backfill_boundary / compaction_checkpoint: { note / ref }
```

**关联与配对约束（协议完整性）**：

- `assistantEntryId` = assistant 条目信封的 `id`；tool_result 以 `(assistantEntryId, toolCallId)` 双键关联，跨 run 不歧义；其 `message` 原样复用 Harness 已构造的 canonical `role:"tool"` `ChatMessage`，不得从 AG-UI 的 200 字 preview 反推；同轮多工具顺序由 assistant `ChatMessage.toolCalls` 数组顺序表达（不另设 orderIndex）；
- `outcome` 复用既有工具结果分类 `success / failure / unknown / not_executed`，**不合并**：`unknown`（已启动、结果未知）与 `not_executed`（根本未执行）是安全语义不同的两态，压成单一 interrupted 会丢失该差异；
- `assistant` 条目**整组提交**：响应完整解析后、任何工具开始执行前落盘（含完整 toolCalls）——工具执行期间崩溃，组已在盘上；
- 优雅取消：结算前为 assistant 载荷中未取得结果的 toolCalls 补 tool_result——已启动未完成 → `unknown`，排队未执行 → `not_executed`；
- 崩溃遗留孤儿：读取侧**按 runStore 执行状态分类闭合**——已启动 → `unknown`，排队未执行 → `not_executed`（见 6.3）；
- **幂等键**：主键 `entryId`；user 条目次级键 `(turnId, revision)`——regenerate 复用原条目（无新增），edit 每次替换 revision 递增，裸 `turnId` 不作去重键（否则与 rewind 语义冲突，见八）；
- **锚点解析**：`anchorUserTurnId` 始终解析为**当前活动视图**中该 turnId 下 revision 最大的 user 条目——多次编辑后锚点永远指向最新有效文本，不会误绑历史中的旧 revision（盘上同 turnId 的历史条目仅供审计，不参与解析）；
- `fullRef` 由执行侧写入（Harness/ChatLoop 持有全量输出，AG-UI `tool_end` 无此字段，这也是不能从事件流反推轨迹的原因之一）。

---

## 四、存储设计（可验证修订协议）

```
<userData>/transcripts/<conversationId>/
├── transcript.jsonl    ← 逐行追加，每条目一行 JSON，追加即落盘
└── snapshot.json      ← 物化检查点，原子写（temp + rename）
```

- **两文件模式**：与 runStore 现有「session JSON + events JSONL」同构，成熟做法直接复用；
- **单调 seq**：JSONL 条目按 `seq` 严格递增；`snapshot.throughSeq` 记录快照覆盖进度；
- **snapshot 内容**：`schemaVersion`、`throughSeq`、条目物化结果（或活动视图所需的 rewind 状态）、**幂等索引**（已见 `entryId` 与 `(turnId, revision)` 键集合）——快照恢复后，旧 `entryId` 重试仍可被识别拒绝；
- **增量重放协议**：读取时先确认 `snapshot.throughSeq`，再重放 `seq > throughSeq` 的 JSONL 增量——快照"是否落后"由序号判定，不再含糊；
- **快照原子性**：snapshot 必须先覆盖到某个确定的 `throughSeq` 再被读取引用，写入用 temp + rename；
- **串行写入队列**：每会话独立写队列串行化追加——跨 `await` 的异步交错不依赖"主进程单线程"假设；
- **截断尾行容错**：追加前检测末行 JSON 完整性，不完整则修剪该行（半行是崩溃的合法遗留）；
- **会话删除**：删除整个会话 = 删除该目录（append-only 只约束单会话内的历史，不约束会话生命周期）。

---

## 五、写入路径（TranscriptSink，提交点与失败策略）

**权威写入源 = `TranscriptSink`（新增的轨迹写入边界接口）**：Harness 与 ChatLoop 直接依赖它在 canonical `ChatMessage` 产生处写入；AG-UI 事件流保持纯展示投影，不参与轨迹构建。

| 条目 | 写入时机 | 说明 |
| --- | --- | --- |
| `user` | dispatch（仅新输入） | regenerate（keep_user）复用原条目不写；edit 的替换 user **不走此行**——随 turn_rewind 同行原子写入 |
| `turn_rewind` | dispatch 处理回退锚点 | keep_user 单行；replace_user **同一行携带 replacementUser**（新文本，revision+1）——单行落盘即原子提交（见八） |
| `assistant` | canonical ChatMessage 产生处（响应完整解析后、工具执行前） | 原样 ChatMessage，整组 toolCalls 随条目落盘 |
| `tool_result` | 工具完成时 | `(assistantEntryId, toolCallId)` + outcome + canonical tool `ChatMessage` + fullRef（若有） |
| `interruption` | 取消结算前 | 先闭合未配对 toolCalls，再写边界 |
| 快照物化 | turn / run 边界 | 原子写至确定 throughSeq |

**提交点**：

- **Harness**（`cyrene-harness.ts` 主循环）：canonical ChatMessage 产生处——即现有 assistant 消息进入 checkpoint 的同一位置（施工前核对相对时机），工具执行前整组落盘；tool_result 在工具完成处；
- **ChatLoop**（`orchestrator/chat-loop.ts` 的 `runChatLoop`）：assistant 轮次结束处，经 TranscriptSink 提交（含 rawAssistant）；
- 两循环不感知彼此，只依赖 TranscriptSink 接口。

**失败策略（fail-closed，实现强制）**——TranscriptSink 写入必须被 `await` 且失败即阻断后续环节，**禁止异步旁路**（否则 CTA 会重现"执行记录先于消息落盘"的旧问题）：

| 写入失败 | 阻断动作 |
| --- | --- |
| `user` 条目 | 不启动模型请求，dispatch 报错上抛 |
| `turn_rewind` 条目（含 replace_user 携带的替换 user） | 不启动模型请求，dispatch 报错上抛（与 user 条目同级；原子性由单行设计保证，失败即整条未落盘，无半状态） |
| `assistant` 条目（含 toolCalls 组） | 禁止执行任何工具，run 按失败结算 |
| `tool_result` 条目 | 禁止进入下一次模型请求；工具已产生副作用时保留 unknown 副作用记录（uncertainEffects） |
| 取消闭合（interruption） | 该轨迹不得视为协议完整——读取侧按崩溃孤儿分类规则兜底 |
| 读取（buildModelContext） | 必须先等待该会话写队列清空再读，禁止读到半更新状态 |

---

## 六、读取路径（上下文构建）

### 6.1 buildModelContext

```
输入：conversationId + token 预算
0. 等待该会话写队列清空（fail-closed 读取前置）
1. 读 snapshot（throughSeq）→ 重放 seq > throughSeq 增量 → 内存条目序列
2. 应用 turn_rewind 语义（按 disposition 排除对应区间；replace_user 行同时从
   载荷取出 replacementUser 注入活动视图——单行即完成删旧加新；旧条目保留在盘供审计）
3. 物化为 canonical messages：assistant 与已提交 tool_result 的 `message` 载荷均原样展开
   （ChatMessage 不改形态），tool_result 按 (assistantEntryId, toolCallId) 配对；未配对者按 runStore
   执行状态分类闭合（unknown / not_executed，见 6.3）
4. 复用 findSafeCutPointForRetainedTokens 在工具配对安全边界裁剪，
   token 预算内取尾部（compaction.ts:125 既有实现）
5. 输出 messages 数组喂 buildOptions
```

### 6.2 Phase 1 过渡窗口规则

- **先物化、后裁剪**：不以单条轨迹为单位累计——先重建 canonical messages，再复用既有安全裁剪点回退到工具配对完整的位置，杜绝孤立 `tool_result` 或切开多工具回合；
- 预算值纳入既有 preview/截断预算体系（不另立标准）；
- Phase 2 compaction（checkpoint + suffix）落地后替换此规则。

### 6.3 崩溃孤儿处理（读取侧，按执行状态分类）

物化时遇到未配对 toolCall：**按 runStore 执行状态分类闭合**（复用施工包 A 的成熟语义——不把"从未执行"误报成"可能已产生副作用"）。assistant 整组在工具执行前已落盘，因此崩溃时组内可能存在从未启动的排队调用，**不能一律 unknown**：

| runStore 执行状态（该 runId 的工具状态日志） | 合成 tool_result 的 outcome | uncertainEffects |
| --- | --- | --- |
| 已启动（started / 结果未知） | `unknown`（"中断，结果未知"） | **仅此态且工具非幂等时**，从 runStore 执行日志带出 `uncertainEffects` 警告注入 recoveryContext |
| 无执行记录（当前生产路径中的排队未启动；`planned` 目前仅为 runStore 类型预留态） | `not_executed`（"未执行"） | 不产生 |

读取侧物化前按信封 `runId` 读 runStore 工具状态日志分流；**写入侧无人补救的场景，读取侧兜底**——与施工包 A 的孤儿闸门同一语义、不同位置。

---

## 七、Phase 1 改动清单

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 主进程 | `orchestrator/conversation-transcript-store.ts`（新增） | 存储（JSONL + 快照 + seq/幂等/串行/fail-closed 协议）+ `buildModelContext`（物化 + 安全裁剪） |
| 主进程 | `orchestrator/transcript-sink.ts`（新增，或并入 store） | 轨迹写入边界接口，Harness / ChatLoop 的唯一依赖 |
| 主进程 | `cyrene-harness.ts` 主循环 | canonical ChatMessage 产生处写 assistant 条目（原样 ChatMessage，整组 toolCalls 工具执行前落盘）与 tool_result |
| 主进程 | `orchestrator/chat-loop.ts` | assistant 轮次结束写条目（含 rawAssistant） |
| 主进程 | `agui-bridge.ts` dispatch | user 条目（仅新输入）+ 回退锚点（turn_rewind + disposition；replace_user 单行携带 replacementUser）+ 上下文从 transcript 构建；不再声明或传递 renderer 历史旁路字段 |
| 主进程 | 取消路径（takeover 结算处） | 闭合未配对 toolCalls（unknown / not_executed）+ interruption 边界 |
| 渲染端 | `ChatPage.tsx` 编辑/重新生成路径 | dispatch 附带回退锚点与 disposition——Phase 1 唯一渲染端改动 |
| 展示 | AG-UI 事件流 | 保持纯展示投影，不作为轨迹来源 |

**回退开关**：Phase 2 已移除；所有生产入口只接受 canonical journal 物化上下文。

---

## 八、双写边界与回退语义（待定项 2 的答案）

- 渲染端 `session.messages` 继续维护，服务 UI 展示与既有功能（检索、导出、渠道绑定镜像）；
- **重新生成（regenerate）**：dispatch 附带锚点 `userTurnId` + `disposition: "keep_user"` → 主进程写 `turn_rewind`（排除锚点 user **之后**的旧 assistant 尾部），**不追加新 user 条目**——原 user 即本轮输入。渲染端复用原 `userMessageId`（ChatPage.tsx:937 现状），轨迹行为与之自洽；
- **编辑最后一条用户消息（edit）**：dispatch 附带锚点 `userTurnId` + `disposition: "replace_user"` → 主进程写**单条** `turn_rewind`：连锚点 user **本身**一并排除，且**同一行携带 replacementUser**（新文本，`revision+1`）——**原子提交**：单行落盘即同时完成"删旧"与"加新"，活动视图在任意时刻读到的要么两者都未发生、要么两者同时生效，**不存在"两次追加之间崩溃导致有删无加"的中间态**（进程死亡窗口 = 单行写入的 fail-closed 已覆盖范围）；
- **幂等不冲突**：user 条目去重键为 `(turnId, revision)` 而非裸 `turnId`——regenerate 复用原条目、无新增写入；edit 每次替换 revision 递增，去重永不误拒；锚点字段用 `anchorUserTurnId + disposition` 表达无歧义（"回退到 user 之后 / 之前"由 disposition 决定），且锚点解析取活动视图中 revision 最大的 user（见三）；
- **禁改清单（Phase 1）**：非末轮的删除/编辑消息（`replaceTail` 只支持末轮，此为天然边界，非新增限制）；
- 会话重命名是元数据，不涉轨迹；删除整个会话 = 删除轨迹目录；
- **施工前核对**：`replaceTail` 精确截断锚点与 `userMessageId` 复用细节到锚点参数的映射（见十三）。

---

## 九、存量回填（待定项 1 的答案）

- 会话**首次在 Phase 1 下发消息时**，dispatch 顺序执行：
  1. 回填 `chats-store` 的 `session.messages` 为纯文本条目（role + content + at），**排除当前轮 userTurnId**（当前用户消息由步骤 3 正常写入，避免首跑重复）；
  2. 写入 `backfill_boundary` 标记分界；
  3. 追加当前 user 条目，照常构建上下文启动 run；
- 分界之前的工具历史**不可恢复，接受**（原本就不在任何跨 run 权威源里）；
- **不回填 runStore 旧档案**：配对歧义大、收益低，旧 run 档案继续只服务旧恢复路径；
- 分界之后，轨迹即唯一权威。

---

## 十、Phase 2 落地摘要（详见十四）

1. **删双写**：UI 消息从轨迹投影派生；v2 `session.messages` 退役；
2. **Compaction 升层**：`raw prefix → compact → replacement + suffix` 已由 checkpoint + suffix 落地；
3. **渠道整合**：`ChannelDispatcher` 直接读取权威 journal，不再接受 `priorMessages`；
4. **崩溃恢复重放**：`prepareHarnessRecovery` 与执行日志共同提供 recovery context；`uncertainEffects` 保留并禁止自动盲重放。

---

## 十一、风险与对策

| 风险 | 对策 |
| --- | --- |
| 双写不一致 | 轨迹唯一权威；编辑/重新生成经 `turn_rewind`（双 disposition）同步；其余改写历史操作进禁改清单；Phase 2 已移除回退开关 |
| rewind 读取语义复杂度 | 只支持末轮回退（对齐 `replaceTail` 语义）；disposition 只有两态，rewind 区间读取侧整体排除，不做部分恢复 |
| replace_user 两次追加非原子 | **已消除**：rewind 与替换 user 合并为单行 journal record（同一 JSONL 行），单行落盘即原子提交；无需 mutationId/事务提交记录 |
| rawAssistant/thinking 增大轨迹体积 | 上下文体积由 checkpoint + suffix 控制；审计 JSONL 仍 append-only，按十四节归档协议保留，不以压缩结果覆盖审计段 |
| 写入性能 | JSONL 追加 + 快照物化与 runStore 同级，无新风险面 |
| 崩溃丢尾部 | 追加即落盘 + 尾行容错；最多丢流式中 assistant 尾部，读取侧孤儿分类规则兜底（6.3：unknown / not_executed 分流） |
| 存量会话体验 | 回填后分界前无工具历史——与现状持平，不劣化 |
| 四模式回归面 | 验收清单逐模式覆盖（见十二） |

---

## 十二、验收标准（Phase 1）

1. 打断后发纠正消息 → 模型能引用被打断的工具名与参数（不再靠猜）；
2. 正常跨轮长任务 → 不再重复 find/read 同一批文件（抽查对比 token 用量）；
3. **每种模式内部跨轮连续**（四种模式为不同会话，无跨模式连续性）；chat 模式内**无工具 ChatLoop 循环 ↔ 工具 Harness 循环**切换时连续；
4. 16 条窗口废除：长会话早段内容在预算内可达，且裁剪边界不切断工具配对；
5. 存量会话回填后正常对话，`backfill_boundary` 正确标记，**首次 dispatch 不重复当前用户消息**；
6. 崩溃孤儿在读取侧**按 runStore 执行状态分类闭合**（已启动 → unknown、排队未执行 → not_executed；仅已启动的非幂等调用产生 uncertainEffects），无 400（配合施工包 A）；
7. **编辑（replace_user：旧文本排除、新 revision 生效，rewind 与替换 user 单行原子提交——模拟"该行落盘后立即崩溃"不产生有删无加的中间态）与重新生成（keep_user：原 user 保留、旧 assistant 尾部排除、不重复追加）后，模型上下文与 UI 展示一致**；
8. 渠道路径行为不变（Phase 1 不接渠道，回归确认无意外影响）；
9. 单测：transcript-store 读写/seq 增量重放/幂等去重（entryId 与 (turnId, revision)）/尾行容错；物化与安全裁剪窗口；rewind 双 disposition 读取语义（含 replace_user 单行原子性与锚点解析取活动视图 revision 最大 user）；**fail-closed 各阻断分支**（user/turn_rewind/assistant/tool_result/interruption 写失败 + 读取等队列）；dispatch 集成（忽略渲染端 messages + 回退锚点）；取消边界闭合（unknown / not_executed）；**读取侧崩溃孤儿分类闭合**（按 runStore 状态分流 unknown / not_executed，uncertainEffects 仅限已启动非幂等）；ChatLoop 提交。

### 十二.1 Phase 1 验收证据（2026-09-21）

**自动化回归（全部通过）：**

- 14 文件 Phase 1 回归套件（`npx vitest run src/main/orchestrator/harness/run-recovery.test.ts src/main/orchestrator/conversation-transcript-store.test.ts src/main/orchestrator/conversation-transcript-context.test.ts src/main/orchestrator/conversation-transcript-coordinator.test.ts src/main/orchestrator/transcript-sink.test.ts src/main/orchestrator/chat-loop.test.ts src/main/orchestrator/harness/cyrene-harness.test.ts src/main/orchestrator/harness/cyrene-harness-cancel.test.ts src/main/orchestrator/build-options.test.ts src/main/orchestrator/agent-runtime.test.ts src/main/agui-bridge.test.ts src/main/chats/chats-ipc.test.ts src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts`）→ **14 文件 259 测试全部通过**，覆盖验收条目 3/4/5/7/9 的自动化部分：
  - 四模式 dispatch 连续性：chat/work/code/learn 下一轮模型请求由权威轨迹物化；work/code/learn 首轮含工具调用，canonical 工具结果随轨迹重放且与声明保持配对；
  - chat 模式跨工具开关三轮连续：无工具（ChatLoop 单轮）→ 工具启用（Harness，含 canonical 工具结果）→ 再禁用，三轮共用同一条权威轨迹；
  - 完整失败矩阵：userWrite / rewindWrite → model_not_started；assistantWrite → tool_not_started；toolResultWrite → next_model_request_blocked；interruptionWrite → read_side_orphan_repair_required；readDuringPendingWrite → waited_for_queue；
  - 会话删除隔离：CHATS_DELETE 只删目标会话的轨迹目录，其余会话轨迹仍可读；
  - 渲染端 rewind 元数据透传（edit → replace_user / regenerate → keep_user）与 16 条硬截断废除（全量历史发送）。
- `npm run build:main` → 通过。
- `npm run check:renderer` → 通过。
- `npm test` → 4478 通过 / 1 失败 / 1 跳过；唯一失败为 `ChatMessageList.test.ts:99`（工作区未提交的 Streamdown 样式改动把 `h1 padding-bottom` 从 10px 改为 8px，与 CTA 改动无关；HEAD 上该测试通过）。CTA 相关改动文件全部在通过集合内。该预存失败随后消除（样式改动已入库），评审修复轮全量回归 0 失败，见十二.2。

**手动烟测（待真实桌面环境执行，完成前对应验收条目不视为已验收）：**

- [ ] 条目 1/2：Work 模式跑一次工具待 run 结束，下一轮发纠正消息，确认模型能点名此前工具与参数、不重复 find/read 同一批文件；
- [ ] 条目 6：在首个非幂等工具 started 后取消多工具 run，下一轮必须对该工具陈述不确定、不得声称排队中的调用已执行；
- [ ] 条目 3：Chat 模式无工具一轮 → 启用工具一轮 → 再禁用第三轮，三轮保持连续；
- [ ] 条目 7：编辑最新 user 消息两次、重新生成一次，重启应用，确认只有最新编辑文本是活动分支；
- [ ] 回退开关：设 `CYRENE_TRANSCRIPT_CONTEXT_SOURCE=renderer` 重启确认旧渲染端源可跑；取消后重启确认轨迹源恢复默认。

### 十二.2 评审修复轮验收证据（2026-09-21）

针对 Phase 1 评审发现的 5 项问题（2×P0 + 3×P1），按修订顺序 1→2→4→3→5（先 scheduler 取消闭合、再 user 稳定 ID、回退开关拆分、sink 接线、插话双写）逐项 TDD 修复，每项独立 commit：

| # | 修复 | Commit | 红→绿测试 |
|---|------|--------|-----------|
| 1 | scheduler 取消时已启动独占调用保留 `started`（闭合起点 `index+1`，交 `closeInterruption` 写 unknown + uncertainEffects；未派发调用才记 `aborted_before_dispatch`） | `90fed854` | tool-call-scheduler.test.ts「cancel during an exclusive call」 |
| 2 | user 条目稳定 ID 显式含 revision：`user:v1:${userTurnId}:r1`，条目不写 `runId`（换 runId 重试命中主键幂等，不再触发次级键冲突） | `79fad414` | coordinator.test.ts「re-dispatches the same user turn under a new runId」 |
| 3 | renderer 回退开关只切换读取源（`useTranscriptContext` 标记），轨迹双写无条件持续 | `a78e0c01` | agui-bridge.test.ts「renderer 回退开关只切换读取源，桌面双写持续」 |
| 4 | TranscriptSink 接入生产 run：bridge 创建 sink（含 `assistantTurnId` 锚点）注入 `options.transcriptSink`，ChatLoop / Harness 两条链路生效；四模式测试改用 bridge 实际注入的 sink | `d2794637` | 四模式 + chat 跨工具测试断言 `options.transcriptSink` 存在 |
| 5 | 插话双写下沉 `createRunAdjustmentPoller`：先稳定 ID 写轨迹（含附件元数据）→ 后 `commitPendingAdjust`；任一步失败抛错、pending 保留（fail-closed）；Harness 两注入点只消费双写成功返回值，poll 抛错转 error 终态 | `65f5429f` | pending-adjustment.test.ts 双写顺序/两失败分支 + cyrene-harness.test.ts「插话双写失败」 |

**自动化回归（全部通过）：**

- CTA 相关回归（`npx vitest run` 13 文件：conversation-transcript-store / coordinator / context、transcript-sink、internal-transcript、agui-bridge、cyrene-agent、chat-loop、cyrene-harness、cyrene-harness-cancel、tool-call-scheduler、pending-adjustment、run-recovery、run-store）→ **200 测试全部通过**；
- `npm run build:main` → 通过；
- `npm run check:renderer` → 通过；
- `npm test` → **全部通过：498 个测试文件，4489 通过 / 1 跳过 / 0 失败（exit 0）**。十二.1 时期的 ChatMessageList.test.ts:99 预存失败未再出现——其 Streamdown 样式改动已在修复轮开工前由 `3abf1cdf` / `2d6ed489` / `4fffd685` 提交入库，全量套件至此完全干净。

### 十二.3 第二轮评审修复验收证据（2026-09-21）

第二轮评审发现 1×P1 + 2×P2（插话双写可撤回竞态、无 userTurnId 写孤立 assistant、回退开关未强制覆盖），按 A→B→C 顺序逐项 TDD 修复，每项独立 commit：

| # | 修复 | Commit | 红→绿测试 |
|---|------|--------|-----------|
| A（P1） | `removePendingMessage` 对带 `adjustRunId` 的条目返回 `already-adjusting`（附最新权威队列）：双写窗口内撤回会使轨迹留下 UI 不存在的隐藏 user，与编辑路径同语义拒绝；IPC 透传零改动、渲染端走既有通用错误提示 | `573ca4eb` | chats-pending-queue.test.ts「撤回已标记条目被拒」+「撤回与插话双写的并发窗口」（挂起 `appendUser` → 撤回被拒 → 恢复 → 双写完成） |
| B（P2） | `transcriptEnabled = Boolean(userTurnId)` 统一门控：sink 与插话轨迹端口都不注入（否则模型回写无对应 user 的孤立 assistant，首次回填还会再写一次该回答）；poller 轨迹端口改可选，兼容调用退化为只提交聊天历史（CTA 之前旧行为，插话注入保留） | `a99055e5` | agui-bridge.test.ts 兼容测试实断言 `options.transcriptSink` 为 undefined + pending-adjustment.test.ts「无轨迹端口只提交聊天历史」 |
| C（P2） | 读取源主进程权威覆盖：`useTranscriptContext = Boolean(userTurnId) && transcriptSource === "transcript"`——renderer 回退强制清除 rawInput 恶意携带的 true，兼容调用强制 false（按渲染端消息走） | `aad04ecf` | 回退测试补「rawInput 带 true 仍被覆盖为 false」+ 兼容测试断言改 `toBe(false)`（正向 true 已有 ：1647 覆盖） |

**已知边界（失败路径残留，Phase 2 处理）**：双写进行中若聊天历史提交失败（轨迹 user 已写、pending 保留），运行按 fail-closed 终止后 `endLifecycle` 会无条件复位 `adjustRunId` 标记，条目回普通队列即可被撤回——此时撤回不再被 `already-adjusting` 拦截（标记已清），轨迹中的 user 条目保留，后续模型仍会读到 UI 不存在的输入。这是 fail-closed 失败路径与 append-only 轨迹（无删除/墓碑语义）的结构性冲突：不复位则条目永久卡死（不可编辑不可撤回），复位则接受轨迹残留，两害相权取复位。彻底解决需要 Phase 2 引入轨迹墓碑/删除语义；正常双写窗口（A 修复覆盖）不受此边界影响。

**自动化回归（全部通过）：**

- 定向回归（`npx vitest run` 7 文件：chats-pending-queue / pending-adjustment / chats-store / chats-ipc、agui-bridge、cyrene-harness、cyrene-harness-cancel）→ **179 测试全部通过**；
- `npm run build:main` → 通过（每项修复后各跑一次）；
- `npm test` → **全部通过：498 个测试文件，4492 通过 / 1 跳过 / 0 失败（exit 0）**；
- 附带收尾：agui-bridge.ts 行尾统一为 LF 入库（`0fe4970f`，`git diff --ignore-cr-at-eol` 验证零内容差异）——此前 index 中 CRLF/LF 混合是历史遗留，与 src 其余 LF 文件不一致。

---

## 十三、施工前核对点（开工前逐项确认代码事实）

- [x] ChatLoop 提交点：`chat-loop.ts:308-339`，响应完整解析并完成可见正文规范化后、返回 `AgentLoopResult` 前；写入时保留 `response.assistantMessage` 的 `rawAssistant` / `thinking`，仅令 `content` 与既有规范化后的 `reply` 一致；
- [x] Harness canonical ChatMessage：`cyrene-harness.ts:170-187`，`toAssistantMessage(response)` 入内存后、`runToolRound` 前；现有 checkpoint 在工具轮结束 `:199` 或终态 `settleRun :455-458`，因此新 sink 必须插在二者之前并被 `await`；
- [x] `replaceTail`：`ChatPage.tsx:908-970` 从倒数第二条 user 的 `userIndex` 截尾，并通过展开旧消息复用原 `id`；edit / regenerate 均以该 `userMessageId` 作为 `anchorUserTurnId`，前者发 `replace_user`、后者发 `keep_user`；
- [x] `ChatMessage` / `rawAssistant` / `ToolCall`：`vendors/types.ts:38-73,160-175`；`ToolCall` 固定为 `{ id, name, arguments }`，`ChatMessage` 另含 `content / toolCallId / name / thinking / rawAssistant / visibility / internal`；
- [x] 工具结果 outcome 与载荷：`harness/types.ts:24-31` 定义 `success / failure / unknown / not_executed`；`tool-round.ts:315-330` 构造实际送回模型的 canonical `role:"tool"` `ChatMessage`，其完整 `content` 不能由 AG-UI 预览重建，故 tool_result 载荷原样保存该消息；
- [x] runStore 工具状态：`run-store.ts:15-36,204-214` 持久化 `{ toolCallId, toolName, sideEffect, status, updatedAt }` 并写 `tool_<status>` JSONL；生产回调当前从 `started` 才开始记录，`planned` 仅存在于类型，故“排队未启动”以无记录为主；
- [x] `findSafeCutPointForRetainedTokens`：`compaction.ts:129-143` 直接接收完整 canonical `ChatMessage[]` 与 `retainTokens`，内部用 `estimateMessageTokens` 从尾部累计，并回退至工具配对安全边界；
- [x] 存放约定：runStore 由 `app.getPath("userData")` 构造并落在 `<userData>/cyrene-runs/`；TranscriptStore 同根落在 `<userData>/transcripts/`，沿用单例 + 原子 temp/rename 方式；
- [x] 附件元数据：复用 `shared/chat-types.ts:207-220` 的 `PendingChatAttachment` 稳定字段 `kind / name / filePath / mime? / caption? / hasAnnotations?`；不持久化 `previewUrl / status / processedKind / chunks / reason` 等 UI 或预处理瞬态字段。

---

## 十四、Phase 2 实际落地与最终验收（2026-09-22）

### 14.1 实际提交表

| 工作项 | 实际提交 | 结果 |
|---|---|---|
| Task 8 | `00105a09` | 轨迹上下文与 UI 投影基础 |
| Task 9 | `1a1239b4`、`6619024a`、`5dd464f2` | 编辑/重新生成与回退语义 |
| Task 10 | `5e0111fb`、`3b64b2ac`、`83efa12e` | 执行恢复及压缩基础 |
| Task 11 | `3d39068b`、`db8de45f`、`6fe67117` | 渠道 journal 接入、取消与不确定副作用 |
| Task 12 | 本提交 `fix（cta）/完成二阶段兼容清理与验收` | 删除旧 IPC/API/旁路历史，加入跨组件验收 |

### 14.2 v1 → v2 迁移与归档协议

迁移入口统一为 `ConversationSessionMigration.ensureConversationMigrated`：先读取 v1 `sessions/<id>.json`，将旧 `messages` 按稳定 ID 写入 canonical journal，再以 v2 元数据原子替换；v2 `cyrene-chats` 文件只保存标题、身份、模式、绑定、`messageCount` 等 metadata，不写正式 `messages`。v1 reader 保留到显式删除会话，以便旧文件可读和迁移可重试；新的 renderer/渠道入口不得绕过 journal。

归档以 append-only JSONL 轨迹及 compaction checkpoint 为边界：checkpoint 只改变模型活动视图，不删除审计段；projection 可从审计段重建，归档失败保持原轨迹可恢复，不能以部分归档结果覆盖 canonical 文件。runStore 只保存执行生命周期和工具状态，不承担会话历史。

### 14.3 最终自动化测试数字与手动边界

- Phase 2 acceptance test（跨组件验收测试）：**1 个文件、6 个测试全部通过**，四模式各 1 个真实 journal → projection → recovery → compaction 流程，另含渠道连续性与旧 IPC 零入口断言。
- 指定模块矩阵：`src/main/orchestrator`、`src/main/chats`、`src/main/channels`、`src/main/scheduler`、`src/main/proactive`、`src/renderer/react/features/chat`；**246 文件、2439 测试全部通过**。
- 全量 `npm test`：**506 文件、4624 通过、1 跳过、0 失败**（共 4625）。
- 三项构建检查：`npm run build:main`、`npm run build:preload`、`npm run check:renderer` 均通过。
- 兼容面 `rg` 验收：旧 IPC/API、`transcriptSource`、`useTranscriptContext`、`priorMessages` **0 命中**；`src/main/chats` 的第二条 writer 检查仅命中 `chats-store.ts:875`、`:1082` 两个显式 v1 `schemaVersion !== 2` 迁移兼容分支，精确 v2 writer 检查 **0 命中**。
- 交付语义边界：远端渠道不保证 exactly-once（恰好一次），系统不自动盲重试；收到不确定回执时记录未确认副作用，下一轮通过 recovery context 提示人工确认。
- 保留边界：canonical transcript、审计段、checkpoint、uncertainEffects 和 v1 reader 保留；只在用户显式删除会话时删除 transcript。不得恢复旧 renderer messages 旁路、旧直写 IPC 或 `priorMessages`。
- 人工项：未执行真实扫码、未使用用户已配置渠道、未向外部服务发送消息；以自动适配器矩阵和生产 `ChannelDispatcher` journal 验收作为替代证据。`npm run dev` 仅允许做非交互启动检查，不改变用户配置。
