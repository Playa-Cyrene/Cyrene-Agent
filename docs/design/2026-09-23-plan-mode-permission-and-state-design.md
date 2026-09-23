# 计划模式权限与状态改造方案

日期：2026-09-23
范围：Plan Mode 权限守卫 / 隐式副作用 / 状态持久化
结论来源：与 ZCode（E:\ZCode）Plan Mode 对比核验，三轮交叉确认，所有论断均已在当前代码中落实证。

---

## 一、背景：三个已经坐实的问题

对比 ZCode 后核验发现，Cyrene 的 Plan Mode 在**产品流程**（DISCUSSING → REVIEW → EXECUTING 状态机）和**计划方法论**（Ground Truth、Coverage Check、Execution Handoff）上并不落后，差距集中在**权限语义、状态持久化和隐式副作用**。具体三个问题：

### 问题 1：Plan 权限守卫按 `risk` 判断，维度用错了

`risk` 回答的是"这个工具危不危险、要不要问用户"；Plan Mode 需要回答的是"这个工具会不会改变世界"。这是两个维度。按 `risk` 判断的后果：

- `write_memory`（[tool-registry.ts L421-L448](../../../src/main/orchestrator/tools/registry/tool-registry.ts)）声明了 `effectKind: "mutation"` 但未声明 `risk`（默认 `safe`），于是 **Plan Mode 下调用 `write_memory` 修改用户核心记忆是被当前守卫放行的**。这不是假设——今天就存在。
- 未来任何 MCP/插件工具只要声明 `risk: "safe"`，无论副作用如何，都会被 Plan Mode 放行。

打个比方：门禁只看"这个人平时脾气好不好"（risk），却没看"他手里有没有拿着油漆刷"（effectKind）。

### 问题 2：`allow_all` 跳过 Plan 守卫

[tool-runtime.ts L41](../../../src/main/orchestrator/harness/adapter/tool-runtime.ts) 的 `allow_all` 判断在 Plan 只读检查**之前**返回。用户开着 allow_all 权限进入计划模式时，"只规划不执行"的承诺直接失效。

"先规划不要动"是用户对这一轮对话的**契约**，不是权限档位。契约应该压过任何权限设置——ZCode 同语义：YOLO 可以绕普通权限，不能绕 Plan Mode。

### 问题 3：`write_plan` 隐式修改项目 `.gitignore`

[plan-tools.ts L148-L151](../../../src/main/orchestrator/harness/plan-tools.ts) 在写计划文件时顺手调用 `ensureCyreneIgnored`（L73-L92），把 `.cyrene/` 追加进项目 `.gitignore`。用户说"进入计划模式，不要改项目"，Cyrene 却改了项目的 `.gitignore`——与 Plan Mode 承诺直接矛盾。

### 附带发现的第 4 个问题（P2 处理）

[side-effect-resolver.ts L12-L18](../../../src/main/orchestrator/harness/side-effect-resolver.ts) 的映射表存在两处语义债：

| 映射 | 问题 |
|---|---|
| `verification → read_only` | 验证工具会跑 build/test/lint，产生 `dist/`、coverage、snapshot，甚至执行项目自己的 package script（`run_verification` 的 build 分支 trust 是 `workspace_script`）。"验证意图"不等于"无副作用"——质检员试机器，机器转起来照样产废料 |
| `unknown → read_only` | 与 [tool-registry.ts L91](../../../src/main/orchestrator/tools/registry/tool-registry.ts) 注释"未配置默认 unknown，**不静默放行**"直接矛盾。一边门禁说没登记不让进，一边保安把没登记的当自己人。MCP 工具接入后所有未声明 `effectKind` 的都会被当作只读 |

---

## 二、设计原则（三条）

1. **Plan 不变量 > 一切权限模式。** `allow_all` 的语义是"执行阶段我信任你"；Plan Mode 的语义是"现在根本不是执行阶段"。两者不互相覆盖。
2. **`effectKind` 决定"会不会改变世界"，`risk` 决定"要不要问用户"。** Plan 守卫只看前者，且只放行 `effectKind === "read"`——宁可从严（fail-closed），不可从宽。将来真有某个验证工具需要在计划阶段使用，再显式给它开白名单（如 `planPolicy: "allow"` 字段），而不是整类放行。
3. **计划文档是项目资产，计划状态是运行时状态。** 文档留在工作区（`<workspace>/.cyrene/docs/`，用户可见可版本化）；状态进 userData（`<userData>/plans/<conversationId>/state.json`），不污染项目目录。

---

## 三、P0：权限守卫与隐式副作用（本次实施）

### 3.1 改造 `tool-runtime.ts` 权限检查

**现状**（L36-L65 的 `permissionCheck`）：

```ts
// allow_all 是显式总开关，会跳过后续权限检查；普通权限模式下才先执行计划只读拦截。
if (options.permissionMode === "allow_all") return true;
if (
  (options.conversationMode === "code" || options.conversationMode === "chat")
  && isPlanReadOnly(threadId)
) {
  const planTool = toolRegistry.getById(toolId) as (ToolDefinition & { risk?: ToolRiskLevel }) | undefined;
  const planRisk: ToolRiskLevel = planTool?.risk ?? "safe";
  if (policyFor("read-only", planRisk) !== "allow") {
    console.log(`[HarnessAdapter] [Plan] read-only enforcement blocked tool=${toolId} risk=${planRisk}`);
    return false;
  }
}
```

**改为**（两处修改合并为一段）：

```ts
// 计划只读不变量：必须先于 allow_all 判断。
// 用户说"先规划不要动"是对本轮对话的契约，任何权限档位都不能越过。
// 判断依据从 risk（危险程度）换成 effectKind（是否改变世界），只放行纯读取工具。
if (
  (options.conversationMode === "code" || options.conversationMode === "chat")
  && isPlanReadOnly(threadId)
) {
  const planTool = toolRegistry.getById(toolId);
  if (!planTool) return false;
  const effect = resolveEffectKind(planTool, args);
  if (effect !== "read") {
    console.log(`[HarnessAdapter] [Plan] read-only enforcement blocked tool=${toolId} effect=${effect}`);
    return false;
  }
}
// 契约检查完毕后，allow_all 才生效（只影响执行阶段语义）
if (options.permissionMode === "allow_all") return true;
```

要点：

- **顺序对调**：Plan 检查在前，`allow_all` 在后。
- **只放行 `read`**：`unknown / mutation / verification / external_side_effect` 一律拒绝。未注册工具（`getById` 未命中）也拒绝。这天然是 fail-closed：MCP 工具没声明 `effectKind` 就进不了计划阶段，插件作者需要显式声明 `effectKind: "read"`。
- **通过 Plan 检查的 read 工具继续走原有权限链**（不提前 return true），保持"per-action 档位下 read 工具仍会询问"的现有语义，diff 最小。
- `policyFor`、`ToolRiskLevel` 的相关导入若仅此处使用则同步删除。

**为什么 `write_plan` 自己不会被拦**：`enter_plan_mode / write_plan / ask_user` 是 harness builtin，在 `checkPermission` 之前 dispatch、不走权限链（[plan-tools.ts L4-L6](../../../src/main/orchestrator/harness/plan-tools.ts) 头部注释已写明）。所以本改造无需为它们开白名单。

### 3.2 删除 `ensureCyreneIgnored` 及其调用

- 删除 [plan-tools.ts](../../../src/main/orchestrator/harness/plan-tools.ts) 中 `ensureCyreneIgnored` 函数（L72-L92）及 `write_plan` 内的调用点（L148-L151，含"顺带确保 .cyrene/ 不进 git"注释）。
- 同步修正 [plan-mode.ts L8](../../../src/main/orchestrator/plan-mode.ts) 头部注释：删去"且 .cyrene 由 write_plan 自动加 .gitignore"表述。

**不做任何替代机制**。`.cyrene/` 要不要进 `.gitignore` 由用户决定：

- 计划文档本来就是项目资产，进 git 不一定坏事（团队可见、可追溯）；
- 若后续有用户反馈"git status 太吵"，再考虑在 UI 层做一次性提示（提示 ≠ 自动写入）；
- 绝不再由 Plan Mode 暗中代劳。

### 3.3 P0 实施前盘点（一次 grep，确认无误伤）

改造会让"计划阶段可用工具"收紧，需确认现有读取类工具都正确声明了 `effectKind: "read"`：

1. `grep effectKind` 全量盘点内置工具声明情况，缺声明的读取类工具（若有）补上；
2. **`run_shell` 在 Plan Mode 下有意禁用**。当前注册是 `risk: "shell"` + `effectKind: "unknown"`（[run-shell-tool.ts L569-L571](../../../src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts)），且没有挂 `effectResolver`（tool-registry 类型注释里的"如 run_shell 根据 purpose 判断"只是字段说明愿景，不是实现）。按 `effect !== "read"` 判断后 `run_shell` 自然被拒——这是**有意行为**，不为保留它临时写 command classifier（`shell-execution-policy.ts` 自己就写明 classifier 不是安全边界）。计划阶段的 Git / 文件 / 搜索事实一律走专用 read-only 工具；若盘点发现确有 `git status` 类刚需，后续补一个声明 `effectKind: "read"` 的专用工具，不走 `run_shell` 放行；
3. 确认计划阶段模型高频使用的工具（read_file / glob / grep / web_search 类）全部 `effectKind: "read"`。

---

## 四、P1：状态持久化与启动恢复（第二批实施）

### 4.1 状态文件设计

```
<userData>/plans/<conversationId>/
├── state.json        ← 新增：生命周期状态（运行时状态，与项目无关）
└── plan.md           ← 既有：无工作区时的计划文档 fallback
```

`state.json` 内容：

```json
{
  "version": 1,
  "state": "PLAN_REVIEW",
  "planPath": "E:/project/.cyrene/docs/plan-20260923-153045.md",
  "enteredAt": 1780000000000,
  "updatedAt": 1780000000000
}
```

工作区计划文档位置不变（`<workspace>/.cyrene/docs/plan-<时间戳>.md`）。

### 4.2 写入机制：durable persister，保持 `plan-mode.ts` 纯净

`plan-mode.ts` 目前无 electron / fs 依赖（L6 注释明示"本模块保持纯净"），直接加 fs 会破坏这个约束。沿用模块既有的注入模式（`initPlanPaths` / `initPlanStateBroadcaster` 同款）：

- `plan-mode.ts` 新增 `initPlanStatePersister(persister)`，签名**同步**：`(conversationId: string, snapshot | null) => void`；
- 状态切换的必经点里依次调用 persist 与 broadcast，**各自独立 try/catch**——UI 广播失败不影响落盘，落盘失败不影响状态机与广播，互不株连；
- main 注入的实现用 `fs.writeFileSync` 同步写：`snapshot` 非 null 写 `state.json`，`null` 删除文件（`exitPlanMode` / `completeExecution` 归 NORMAL 时清尸不留残余）。

**为什么必须是 durable transition，而不是 fire-and-forget**：本方案的目标是 Crash Recovery，但若 persister 内部是 `void fs.promises.writeFile(...)`，`approvePlan()` 改完内存、异步写盘尚未完成的窗口恰恰是最需要持久化的窗口——此刻崩溃，磁盘还是 `PLAN_REVIEW`，恢复语义错乱。JSON 极小（几百字节）且状态转换极低频（一轮对话个位数次），同步写的阻塞可以忽略。宁可朴素（`writeFileSync`），不要语义含糊的异步丢弃。将来状态机若需全面 async 化再重构，v1 先把语义立对。

### 4.3 启动恢复：只恢复事实，不恢复执行许可

**核心原则**：crash recovery 首先恢复事实，不恢复执行权。这与 `cyrene-plan-mode` skill 的 `Workspace Ground Truth > Plan Assumption` 一脉相承。

**为什么 `EXECUTING` 不能原样恢复**：`ExecutionLedger` 是纯内存短生命周期的（[execution-ledger.ts L34-L35](../../../src/main/orchestrator/execution-ledger.ts)，两个 `Map`，无任何落盘），重启即失忆，崩溃瞬间的执行进度**未知**。`EXECUTING` 真正表达的是"持久状态停止时执行正在进行"，不是"可以安全继续"。若原样恢复，模型看到完整 Approved Plan，可能把已完成步骤再执行一遍——外部副作用（如发邮件）会被重复触发：

```text
批准 → EXECUTING → write_file A ✓ → send_email ✓ → write_file B ← 此刻 crash
→ 重启 → 原样恢复 EXECUTING → 模型从头理解计划 → send_email 可能再发一次
```

**恢复语义统一为**：三个非 NORMAL 状态全部恢复为 `PLAN_DISCUSSING`，用恢复注入块表达"中断前发生过什么"：

| 崩溃时状态 | 恢复为 | 注入 |
|---|---|---|
| `PLAN_DISCUSSING` | `PLAN_DISCUSSING` | 无（继续讨论，无 UI 依赖） |
| `PLAN_REVIEW` | `PLAN_DISCUSSING` | `[PLAN_RECOVERY]` + 旧计划草稿全文 |
| `EXECUTING` | `PLAN_DISCUSSING` | `[PLAN_RECOVERY]` + 旧计划全文 + "不要假设未执行"警示 |

不引入第五状态 `EXECUTION_INTERRUPTED`：v1 用内存 marker（`recoveredFrom`）+ 统一降级表达，状态机不动。

```text
persist state → restart → 全部降级 DISCUSSING（附中断事实注入）
→ 模型 inspect workspace / git diff → 修订计划 → 重新 write_plan → 用户重新审批
```

**不要自动恢复执行权。**

### 4.4 恢复注入块 `[PLAN_RECOVERY]`：补齐"从磁盘读回"的实现入口

当前 `preparePlanRunContext()`（[plan-lifecycle.ts L32-L48](../../../src/main/orchestrator/harness/adapter/plan-lifecycle.ts)）**只在 `EXECUTING` 读计划文件**，`PLAN_DISCUSSING` 直接返回——"从磁盘读回旧计划"目前没有任何实现路径，必须补这块：

- reconcile 恢复 session 时标记 `recoveredFrom: "PLAN_REVIEW" | "EXECUTING"`；
- `preparePlanRunContext()` 扩展：`PLAN_DISCUSSING` 且 session 带 `recoveredFrom` 且 `planPath` 文件存在 → 读盘注入 `[PLAN_RECOVERY]` 块；注入后清除 marker（一次性消费，后续消息不重复注入）；
- `EXECUTING` 来源的注入文本：

```text
[PLAN_RECOVERY]
上次已批准计划的执行被异常中断。不要假设计划尚未执行——部分步骤可能已经完成，包括有外部副作用的步骤。
先检查 workspace / git diff / 当前状态，确认哪些步骤已经完成，再修订计划并重新提交审批。
以下为中断前的计划原文，仅作事实参考，不要直接继续执行：
<旧计划全文>
```

- `[PLAN_RECOVERY]` 与 `[PLAN_CONTEXT]` 的语义对比是本节灵魂：`[PLAN_CONTEXT]` = **执行许可**（"严格按计划执行"）；`[PLAN_RECOVERY]` = **事实参考**（"先查证、再修订、重新审批"）。两者绝不可混用。

### 4.5 恢复 API 与会话键

- 新增显式恢复入口 `restorePlanSession(conversationId, snapshot)`：validate snapshot → 直接 hydrate `sessions` Map → **不走正常 transition 函数**（避免伪造转换触发再次 persist）→ 打上 `recoveredFrom` marker → 广播最终恢复态。启动代码不得直接碰私有 `sessions` Map；
- `encodePlanSessionKey(conversationId)`：目录名编码，消除 `/ \ .. :` 等路径字符风险（不信任 conversationId 的形态）；
- `resetPlanSessionsForTest()` 一并重置新加入的 persister；
- v1 不做"恢复时重新渲染审批卡"（需要 renderer + agui-bridge 配套改造），留作后续可选增强。

### 4.6 容错

- `planPath` 指向的文件已不存在（workspace 移动/删除/手动清理）：照常降级，不注入计划全文；`EXECUTING` 来源仍注入"执行被中断"警示（无全文）；
- `state.json` 损坏 / 字段不合法：跳过该会话，日志告警，按 NORMAL 处理。

---

## 五、P2：清理副作用映射表（第三批实施）

[side-effect-resolver.ts](../../../src/main/orchestrator/harness/side-effect-resolver.ts) 的 `EFFECT_KIND_MAP` 两行一起改：

| effectKind | 现映射 | 改为 |
|---|---|---|
| `verification` | `read_only` | `idempotent_mutation` |
| `unknown` | `read_only`（注释还写着"保守默认"） | `non_idempotent_side_effect` |

**为什么 `verification` 不是 `non_idempotent_side_effect`**：这个映射不只影响并发，还影响重试——[retry-policy.ts L34](../../../src/main/orchestrator/harness/retry-policy.ts) 规定 `non_idempotent_side_effect` 任何 category 都不自动重试。verification 落进去，一次普通 typecheck/test 因 timeout 或 transient 临时故障就会被赋予"绝不能重试的外部副作用"语义，过重。`verification` 的准确定位是：**不是只读**（有产物、会执行项目脚本，必须退出并发 read pool），**但通常可安全重跑**（`idempotent_mutation` 允许 transient / timeout / rate_limited 重试）。

**为什么 `unknown` 是 `non_idempotent_side_effect`**：fail-closed——不知道它干什么，就按最危险的对待。

`read / mutation / external_side_effect` 三行不动。

**实施前盘点（必须）**：`unknown → non_idempotent_side_effect` 会把所有未声明 `effectKind` 的工具在 harness 并发调度中从"可并发"改为"串行"、从"可重试"改为"不重试"。改造前先 grep 盘点未声明 `effectKind` 的工具清单（内置 / 插件 / MCP 三个来源），逐个确认是否需要补声明，避免行为意外收紧。

`verification` 的精化等 P3 阶段 Tool Capability 模型建立后再拆子类（`verification + no artifacts` / `verification + workspace artifacts` / `verification + arbitrary project script`），本阶段用 `idempotent_mutation` 作为过渡。

---

## 六、P3：方向展望（本方案不实施）

1. **approve → execution 链收回 Runtime**：现在批准后走 `agui-bridge` 发 CUSTOM 事件 → renderer 自动发执行消息 → 新 run。链路不优雅但可工作，属于架构债而非语义 bug，且涉及 Electron IPC 改造，收益/成本比低，延后。
2. **Tool Capability 模型统一**：`risk / effectKind / SideEffectKind / verificationPolicy` 已在四套语义间存在历史映射假设，待 P0/P1/P2 落地后，以 `effectKind` 为主轴重新收敛，必要时引入 `planPolicy` / `sideEffectScope` 精细字段。

---

## 七、验证清单

### P0 验证

| # | 场景 | 预期 |
|---|---|---|
| 1 | Plan 模式 + allow_all，调用 `run_verification` | **拒绝**（当前放行，本次修复核心） |
| 2 | Plan 模式，调用 `read_file` / `web_search` | 放行 |
| 3 | Plan 模式，调用 `write_memory` | **拒绝**（当前放行，实锤 bug 修复验证） |
| 4 | NORMAL 态调 `enter_plan_mode`；DISCUSSING 态调 `write_plan`；REVIEW 态用户批准后进 EXECUTING | 全链路正常（builtin 不走权限链；当前无 `exit_plan_mode` 模型工具，退出走 UI） |
| 5 | DISCUSSING 态重复调用 `enter_plan_mode` | 被拒（状态机幂等防御生效） |
| 6 | Plan 模式，调用 `run_shell`（任意命令，含 `git status`） | **拒绝**（有意禁用，见 3.3） |
| 7 | Plan 模式，`write_plan` 后检查项目 `.gitignore` | **未被修改** |
| 8 | 非 Plan 模式，全部工具 | 行为与改造前完全一致 |
| 9 | per-action 档位 + Plan 模式，read 工具 | 仍弹权限询问（语义保持） |
| 10 | Plan 模式，未声明 `effectKind` 的 MCP 测试工具 | 拒绝（fail-closed） |

### P1 验证

| # | 场景 | 预期 |
|---|---|---|
| 11 | 进入 PLAN_DISCUSSING → 重启应用 → 调用写类工具 | 仍被拒（状态已恢复） |
| 12 | 停在 PLAN_REVIEW → 重启应用 → 发消息 | 降级为 DISCUSSING，首条消息带 `[PLAN_RECOVERY]` + 旧计划全文 |
| 13 | EXECUTING 中崩溃 → 重启应用 → 发消息 | 降级为 DISCUSSING，`[PLAN_RECOVERY]` 含"不要假设未执行"警示，**不自动续跑** |
| 14 | `[PLAN_RECOVERY]` 注入后的第二条消息 | 不再重复注入（marker 已消费） |
| 15 | `exitPlanMode` / 执行完成 | `state.json` 被删除 |
| 16 | `approvePlan()` 返回后立即模拟 crash（写盘后才返回） | 磁盘已是最新状态（durable write 验证） |
| 17 | `state.json` 的 `planPath` 指向不存在文件 | 不 crash，不注入计划全文，仍注入中断警示 |

### P2 验证

| # | 场景 | 预期 |
|---|---|---|
| 18 | `run_verification` 因 timeout / transient 失败 | 可自动重试（`idempotent_mutation` 语义，修复验证） |
| 19 | 未声明 `effectKind` 的工具 timeout | 不自动重试（`non_idempotent` 语义） |

### 通用

- 20. `npm run typecheck` / 现有 harness 与 plan 相关测试全量通过。

---

## 八、风险与回滚

| 风险 | 评估 | 对策 |
|---|---|---|
| P0 收紧后计划阶段"无工具可用" | 低——3.3 盘点先行，读取类工具均声明 `effectKind: "read"` | 盘点缺漏的工具补声明，同批提交 |
| `run_shell` 在 Plan Mode 被禁后，模型用 shell 做代码探查 | 中——模型可能习惯性尝试 | 计划模式的 system prompt 明示"探索用专用读取工具"；若确有 `git status` 刚需，补 `effectKind: "read"` 专用工具，不放行 `run_shell` |
| MCP/插件工具未声明 `effectKind` 被拒 | **有意的行为变化**（fail-closed） | 插件文档补充说明：需声明 `effectKind: "read"` 才能参与计划模式 |
| P1 同步写盘阻塞主进程 | 可忽略——几百字节 JSON + 低频转换 | 维持 `writeFileSync`；若未来状态转换变高频再评估异步化 |
| EXECUTING 恢复降级，用户需重新审批一次 | **已知代价，有意选择**——换来零重复副作用风险 | 恢复注入块引导模型先查证再修订，多数场景修订成本低 |
| P1 persister 写盘失败 | 状态机本身不受影响（独立 try/catch） | 日志告警；下次状态转换会重写覆盖 |
| 回滚 | — | P0 / P1 / P2 各自独立 commit，可单独 revert，互不依赖 |

---

## 九、实施批次

| 批次 | 内容 | Commit |
|---|---|---|
| 第一批 | P0 全部（守卫重排 + effectKind 判断 + 删 `ensureCyreneIgnored` + 盘点补声明） | 1 个 commit |
| 第二批 | P1 全部（durable persister + state.json + 统一降级 + `[PLAN_RECOVERY]` 注入 + `restorePlanSession` + 容错） | 1 个 commit |
| 第三批 | P2（映射表两行改为 `verification → idempotent_mutation` / `unknown → non_idempotent_side_effect` + 未声明盘点） | 1 个 commit |

每批完成后按验证清单对应条目逐一验证，通过再进下一批。
