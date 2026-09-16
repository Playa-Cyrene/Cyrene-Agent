# CyreneHarness 设计稿

> **状态**:设计稿 v3(7 个关键漏洞已补,**架构冻结,可写施工计划**)
> **日期**:2026-08-09(v2 同天,v1:2026-08-08)
> **性质**:设计意图与架构取舍,不含具体实现步骤
> **v2 变更**:① structured-output 保留 runner 并强制 legacy 后端,LangChain 6 依赖全删 ② ask_user 复用现有澄清链路,不开新 IPC ③ todo 事件定名 `cyrene.todo` ④ mid-loop compaction + 工具输出截断提前到 P0(§10.6 / §5.7)⑤ 删除清单补齐 `ask_user_choice` / `task-router` / `ask-soul` 与 task-plan 前置迁移
> **v3 变更**:① 每轮 assistant response 必须写回 messages(§3.1)② `unknown` non-idempotent side-effect 进 `AgentState.uncertainEffects` 并阻止重复副作用/伪完成(§5.5.1 / §6.3)③ Harness 内置工具 dispatch 统一(§3.1 / §8.3)④ 同轮多 tool call 遇 fatal/unknown 中断规则(§3.1)⑤ compaction token budget 加入 tool schemas + output reserve(§10.6)⑥ 工具截断 `fullOutputRef` 语义明确(§5.7)⑦ 清三处旧文档残留(§1.2 / §13.2 / §12)⑧ `ToolCallOutcome` 扩展为四态(含 `not_executed`)(§5.5.1)⑨ `fingerprint` 拦截前置到工具执行前(§3.1)⑩ `update_todo` state 更新职责收归 `executeHarnessBuiltin`(§3.1)
> **v4 现行补充（2026-09-15）**:运行期允许把 Model Stream 正文作为有明确“生成中”状态的临时候选预览发到 UI；Harness 仍保留原 buffer 与最终 commit 语义。工具轮归入 Progress，成功无工具轮才提交 Final，排他交互丢弃，失败或取消只保留为中断过程片段。当前实现已取消旧 Completion Guard，模型停止调用工具即进入成功结算；本稿下方相关段落只保留为历史设计。详细事件、持久化边界和动效规范见 [`2026-09-15-live-candidate-answer-construction-plan.md`](./2026-09-15-live-candidate-answer-construction-plan.md)。
> **位置**:git 不跟踪(`docs/` 在 `.gitignore` 中)

---

## 0. 一句话目标

把 Cyrene 从"多个 LLM 职能节点拼成的 Workflow"变成"CyreneHarness:一个连续的 Agent Loop + 外围确定性 Runtime"。

`CyreneHarness` 是新模块的统一名字。**Harness** 表达"模型自由决策,Runtime 兜底"这个核心设计哲学。

> 昔涟就是那个在干活的 Agent,不是一个干完活后来配音的角色。

---

## 1. 为什么要做这件事

### 1.1 当前痛点(代码事实已验证)

| 痛点 | 代码证据 |
|---|---|
| 工程师阶段(Planner/Action Gate/Native FC/Tool Phase)完全看不到人设 | `system-prompt-builder.ts:88-96` 的 `buildToolSystemPrompt` 不加载 `soul.md`/`identity`/`canon_quotes` |
| Action Gate 用结构化输出逼模型填表,模型不填就流程死掉 | `action-gate.ts:94-179` 的 schema + `structured-output/runner.ts` 的 repair loop |
| Action Gate + Native FC 每轮 2 次 LLM 调用,锁死模型策略空间 | `native-function-calling.ts:58` 的 `toolChoiceIntent: must_call` |
| SOUL 是独立 LLM 阶段,读"事故报告"而不是"接着说" | `langgraph-agent-loop.ts:1398-1412` 的 system 拼接 |
| 工具失败只有 `retryable: bool`,默认 false,甩给模型决定 | `tool-outcome-normalizer.ts:14-19` |
| Plan 状态纯内存,进程死即蒸发 | `agent-graph.ts:1067` 的 `.compile()` 无 checkpointer |
| LangGraph 在本项目未使用 checkpointer/stream/interrupt/parallel,只用了路由 DSL | 见前期取证报告 |

### 1.2 设计原则

1. **Loop 简单,Harness 成熟**:核心循环一两百行,复杂能力放在循环外的确定性代码里。
2. **模型自主,Runtime 兜底**:模型决定"想做什么",Runtime 决定"能不能做 + 做完了吗"。
3. **两套 persona 完全独立,不动态切换**:Chat Persona(完整 soul + style)只在 Chat 模式用;Harness Persona(`prompts/cyrene_harness.md`)只在 CyreneHarness 用。整个 Harness Loop 用同一份,不"第一轮完整、后续精简"。Style 是 Chat 专属能力,不进 Harness。
4. **失败先分类,再决定**:工具失败先由代码确定性分类,能自动重试的重试,不能的把结构化错误给模型。
5. **YAGNI**:第一版只做 P0,不做 checkpoint/subagent/并行。mid-loop compaction 已随连续 Loop 的上下文管理需求进入 P0(§10.6),不是 P1。

---

## 2. 模式分工(简化后)

### 2.1 三个模式,只改一个

| 模式 | 用途 | 处理方式 |
|---|---|---|
| **Chat** | 纯聊天,无工具 | **完全不动**(单次 LLM 调用,跟现在一样) |
| **Code** | 编程 | **完全不动**(外包 `@cline/sdk`,跟现在一样) |
| **Work + Daily/Learn** | 工程师型任务 + 日常型任务 | **删除当前实现,新建 `CyreneHarness` 替代** |

### 2.2 删除清单(全部干掉)

| 删除项 | 文件 / 模块 | 备注 |
|---|---|---|
| LangGraph 主循环 | `langgraph-agent-loop.ts`, `agent-graph.ts` | 整个删 |
| Action Gate | `action-gate.ts`, `task-plan.ts` | 整个删。**前置**:`subagents/{types,graph,search-agent,document-agent}.ts` 引用了 task-plan,先把共享类型迁到 subagents 本地再删 |
| Native FC | `native-function-calling.ts` | 整个删 |
| 结构化输出 LangChain 后端 | `structured-output/langchain-invoker.ts` + `backend.ts` 的 langchain 分支 | runner.ts **保留**(memory / CITA / social-context 在用),强制走 legacy vendor adapter |
| SOUL 独立阶段 | `soul-execution-context.ts` 的 project 逻辑、SOUL_NO_TOOL_DIRECTIVE 注入 | 删 |
| TwoPhaseFC legacy 循环 | `two-phase-fc-loop.ts` | **整个删**,流式/fallback 逻辑搬到 CyreneHarness |
| legacy 歧义消解工具 | `built-in-tools.ts:1490-1553` 的 `ask_user_choice` 注册 | 名字与职责被 Harness 内置 `ask_user` 取代 |
| 任务路由 | `task-router.ts` | 依赖结构化输出做路由,随旧架构删 |
| Ask Soul | `ask-soul.ts` | SOUL 独立阶段的一部分 |
| LangChain 全部依赖 | `@langchain/langgraph`, `@langchain/core`, `@langchain/anthropic`, `@langchain/openai`, `@langchain/deepseek`, `langchain` | **全删**。langgraph 仅 agent-graph.ts 用;其余 5 个仅 langchain-invoker.ts 用。结构化输出全面走自己的 vendor adapter(legacy),OpenAI / Anthropic 官方文档足够,不需要 langchain 做对齐层 |

### 2.3 改名逻辑:Daily → CyreneHarness

原 "Daily" 走 TwoPhaseFC(legacy 循环)。新模式下:
- **Daily 这个 mode 名消失**(UI 入口可能要重新设计,但本设计稿不涉及 UI)
- **改名为 `CyreneHarness`**:表达这是 Cyrene 的运行框架,而不是某个 mode

`CyreneHarness` 同时覆盖了原 Work + Daily/Learn 的工具调用场景。具体某个 ChatSession 走 CyreneHarness 还是 Chat 模式,根据 `session.mode` 判断(`agui-bridge.ts:241`)。

### 2.4 保留的模块(完全不动)

| 模块 | 文件 | 为什么保留 |
|---|---|---|
| `toolRegistry` | `tool-registry.ts` | 统一工具注册,CyreneHarness 继续用 |
| `executeToolCall` | `cyrene-agent.ts:207-281` | 统一工具执行 wrapper,CyreneHarness 直接调用 |
| 权限系统 | `permission.ts`, `permission-policy.ts` | 工具执行前的权限检查 |
| `ExecutionLedger` | `execution-ledger.ts` | 工具去重(P0 **接入并复用**,不趁机重构;见 §12 P0 范围)。注意:当前只传给 LangGraph 路径(`cyrene-agent.ts:391-400`),Harness 路径要显式传入 |
| 结构化输出 runner | `structured-output/runner.ts` 及解析 / repair 逻辑 | memory / CITA / social-context / task-router 依赖;**强制 legacy 后端**(vendor adapter),langchain 后端删除 |
| 用户澄清链路 | `user-choice.ts` + `IPC.CHOICE_RESOLVE` + `cyrene.choice` 事件 | ask_user 的 pending Promise / 超时 / UI 卡片全现成(§9.4) |
| 上下文压缩底座 | `context-manager.ts` | estimateTokens / 阈值 / 摘要调用直接复用;Harness 新增配对安全切点与 agent 导向 prompt(§10.6) |
| (无 — LangGraph Plan 体系已全删) | - | Todo State 替代了 TaskPlan 整套,不依赖任何 LangGraph 函数 |
| 子 agent | `subagents/graph.ts` | 已经是 plain TS while 循环 |
| CITA | `cita/` 整目录 | 上下文改写,跟 Loop 无关 |
| 记忆系统 | `memory/`, `rag/` | 长期记忆 + 检索,跟 Loop 无关 |
| `WorkStreamEventBridge`(流式) | 逻辑搬到 `agent-loop-stream.ts` | 纯 TS,跟 LangGraph 无关 |
| 所有工具实现 | `built-in-tools.ts`, `fs-tools.ts`, `document-tools.ts`, `life-tools.ts`, `email-tools.ts`, `search-code-tools.ts` 等 | 工具本身不动,执行入口换到CyreneHarness |

---

## 3. CyreneHarness 核心结构

### 3.1 伪代码

```
// 在 CyreneHarness.run(input) 里:

构建 system prompt(见 §4 + §17 人设注入)
构建 tools 清单:
    registryTools = toolRegistry.getSchemas()          // 普通工具
    harnessBuiltinTools = [
       schema(update_todo),    // §8.3 内置,不进 registry
       schema(ask_user)        // §9.4 内置,不进 registry
    ]
    tools = [...registryTools, ...harnessBuiltinTools]

messages = [用户消息 + 历史]
state = {
  todoItems: [],
  completionObligations: [],   // §6.3 obligation 数组
  uncertainEffects: []         // §5.5.1 / §6.3:未知副作用的安全拦截
}

while (轮数 < maxRounds && 没超时 && 没被取消):
    // §10.6 Mid-loop compaction:每轮调用前检查上下文预算
    usableInputBudget = contextWindow - reservedOutputTokens - safetyMargin
    estimatedInput = estimateTokens(system + toolSchemas) + estimateMessageTokens(messages)
    if estimatedInput >= usableInputBudget * 0.7:
        messages = await compressForAgentLoop(messages)  // 配对安全切点 + agent 导向摘要

    response = await callLLM(system, messages, tools)

    // ============== Assistant response 必须写回 transcript ==============
    // 这是连续 Loop 的记忆核心:模型必须记得自己上一轮干了什么。
    // 即使 content 后续被 UI discard,也不能从模型自己的 messages 里删除。
    messages.push(normalizeAssistantMessage(response))   // P0 blocker

    // ============== Progress Stream vs Final Commit ==============
    // 模型这一轮的 content 可能是"还在干活"也可能是"这是我的最终回复"
    // 现在不确定,先 buffer;
    // 后面要么 commit(模型没调工具 + completion 通过)
    // 要么继续 stream(模型调了工具 / completion 没通过)
    if response.content:
        bufferProgressContent(response.content)

    // ============== Tool Call Processing ==============
    if response.tool_calls:
        // 检查 ask_user 排他规则(见 §9.2)
        askCalls = response.tool_calls.filter(c => c.name == "ask_user")
        otherCalls = response.tool_calls.filter(c => c.name != "ask_user")

        if askCalls.length > 0:
            // ask_user 是 exclusive control tool
            // 如果有多个 ask_user,只执行第一个,其余 ask_user 也要返回 Tool Result
            primaryAsk = askCalls[0]
            for call in askCalls.slice(1):
                messages.push(toolResult(call, { outcome: "not_executed", reason: "not_executed_due_to_another_ask" }))

            // 同一轮普通工具调用都不能执行,但必须返回 Tool Result(协议要求每个 tool_call 都有对应 tool_result)
            for call in otherCalls:
                messages.push(toolResult(call, { outcome: "not_executed", reason: "not_executed_due_to_clarification" }))

            askResult = await executeHarnessBuiltin(primaryAsk)   // §9.4 pending Promise
            messages.push(toolResult(primaryAsk, askResult))   // { outcome: "success", answers: {...} }
            discardProgressBuffer()
            continue  // 回到 LLM,模型重新决定

        // ===== 普通工具循环(没有 ask_user)=====
        // 普通工具循环前,把 buffered content flush 为 progress message
        flushProgressBufferAsProgress()

        halted = false
        for each tool_call in otherCalls:
            if halted:
                // 前面出现 fatal 或 unknown non-idempotent side-effect,后续调用不执行
                messages.push(toolResult(tool_call, {
                    outcome: "not_executed",
                    reason: "runtime_halted_after_prior_uncertain_side_effect_or_fatal"
                }))
                continue

            // 统一 dispatcher:Harness 内置工具 vs 普通工具
            if isHarnessBuiltin(tool_call.name):
                result = await executeHarnessBuiltin(tool_call)
            else:
                // §5.5.1.1 相同 fingerprint 的未确认副作用禁止重复执行
                if state.uncertainEffects.some(e => e.fingerprint == fingerprint(tool_call)):
                    result = {
                        outcome: "failure",
                        category: "runtime_safety",
                        message: "该副作用已有一次未确认结果,在 reconcile 或 ask 用户前不能重复执行"
                    }
                else:
                    result = await executeToolCall(tool_call)   // 权限检查 + 预校验 + §5.7 输出截断

            if result.outcome == "failure":
                error = classifyError(result.err)
                retryDecision = decideRetry(error, tool_call)  // §5.3 (category + side-effect)
                if retryDecision == "retry":
                    result = await retry(tool_call, 带退避)
                else:
                    result = buildObservation(tool_call, result)  // §5.5 结构化错误对象

            messages.push(toolResult(tool_call, result))

            // update_todo 的 state 更新与事件发射由 executeHarnessBuiltin 内部完成
            // Loop 只负责把 result 写回 transcript

            // §5.5.1 unknown non-idempotent side-effect -> 记录 uncertain effect
            if result.outcome == "unknown" && resolveSideEffect(tool_call) == "non_idempotent_side_effect":
                state.uncertainEffects.push({
                    toolCallId: tool_call.id,
                    fingerprint: fingerprint(tool_call),
                    toolName: tool_call.name,
                    message: "副作用已发起,但 Runtime 无法确认是否生效"
                })
                halted = true   // 本轮后续 side-effect 类调用暂停

            // §6.4 生成 / 满足 obligation
            updateObligations(state, tool_call, result)

            // fatal 也 halt(虽然 fatal 通常会直接终止 loop,但同一轮内必须先给其他 tool_call 一个结果)
            if result.category == "fatal":
                halted = true

        continue

    // ============== Model Wants to End ==============
    else:
        unresolved = state.completionObligations.filter(o => !o.satisfied)
        if unresolved.length == 0 && state.uncertainEffects.length == 0:
            // Completion 通过 -> commit buffered content as final answer
            finalAnswer = commitProgressBuffer()
            return finalAnswer

        // 还有未完成 obligation 或 unresolved uncertain effect
        feedbackParts = []
        if unresolved.length > 0:
            feedbackParts.push(`你还有 ${unresolved.length} 个未完成的验证义务:\n` +
                               unresolved.map(describeObligation).join('\n'))
        if state.uncertainEffects.length > 0:
            feedbackParts.push(`以下副作用结果未知,必须先 reconcile 或 ask 用户,不能结束:\n` +
                               state.uncertainEffects.map(e => `- ${e.toolName}: ${e.message}`).join('\n'))

        messages.push(runtimeFeedbackMessage(feedbackParts.join('\n\n')))
        // 不 commit progress buffer,继续循环
        continue

// 兜底:超 maxRounds 或超时
return buildTimeoutReply(state)
```

`CyreneHarness` 对外只暴露 `run(input)` 这一个入口。内部模块边界在施工稿根据代码量和依赖关系决定(见 §13.2)。

### 3.2 关键特征

| 特征 | 说明 |
|---|---|
| 每轮 1 次 LLM 调用 | 不再有 Action Gate + Native FC 两段式 |
| 模型用 function calling 自由决策 | `tool_choice: "auto"`,不锁死 |
| 模型可同时说话 + 调工具 | content + tool_calls 同一条回复 |
| **Assistant response 写回 transcript** | 每轮 `callLLM` 返回的 assistant message 立即 `messages.push`,即使 content 被 UI discard(§3.1) |
| **Harness 内置工具统一 dispatch** | `update_todo` / `ask_user` 不进 registry,由 `executeHarnessBuiltin` 处理;普通工具走 `executeToolCall`(§3.1) |
| **`ask_user` 排他** | 一轮里出现 `ask_user`,**不执行同轮其他工具调用**;其他返回 `not_executed_due_to_clarification` |
| **同轮多 tool call 中断** | 遇 `fatal` 或 `unknown non_idempotent side-effect`,本轮后续调用返回 `not_executed`(§3.1) |
| **Progress stream vs Final commit** | 模型 content 先 buffer;`checkCompletion` 通过后才 commit 给用户,否则丢弃/继续 |
| **Obligations 数组 + uncertainEffects 数组** | Runtime 追踪未完成的验证义务和未知副作用,**不扫历史** |
| **失败先代码分类**(category + side-effect → retry decision) | 不直接甩给模型 |
| maxRounds 兜底 | 防跑飞 |

### 3.3 不做什么(P0 范围外)

- ❌ Checkpoint / 跨进程 resume(P1)
- ⚠️ Context compaction:**循环内检查点 + 配对安全切点 + agent 导向 prompt 提前到 P0**(§10.6);精细化(按用户回合保留、obligation/todo 注入摘要)仍属 P1
- ❌ ExecutionLedger 持久化(P1)
- ❌ SubAgent 并行(P2)
- ❌ Git/worktree isolation(P2)
- ❌ Goal mode(P2)

---

## 4. 人设策略:两套独立,不是动态切换

### 4.1 设计原则

**Chat 人设和 Harness 人设是两套完全独立的人设,不是同一个请求里"完整/精简"的来回切。**

理由:
- Chat 模式不跑工具,可以用完整 soul.md + style + sampling parameters 自由发挥。
- Harness 模式持续在工具循环中,任何影响 model function calling 稳定性的额外 prompt 都是风险。
- Style(风格采样参数 + 额外风格 prompt)是 Chat 的特性,**不属于 Harness**。Style 的采样参数 / 额外 prompt 都有可能干扰工具选择、Function Calling 和任务执行。

### 4.2 Chat 模式(完全不动)

用现在完整的人设体系:
- 完整 soul.md + identity + canon_quotes + tone-rules
- Style 功能(额外 prompt + sampling parameters)
- 当前 Chat Loop 不变
- 采样参数策略不变

**Chat 不在 CyreneHarness 重构范围内。**

### 4.3 CyreneHarness 模式

- 整个 Loop **只**用一套人设:用户自己写在 `prompts/cyrene_harness.md`(已建好,内容由用户写)。
- 不是从完整 soul.md 机械删行,而是**专门针对 Harness 工作场景**写的 prompt。
- 整个 Loop —— 第一轮、第二轮、第十轮 —— **都用同一份 `cyrene_harness.md`**,不做动态切换。
- 不包含 Style 功能。

### 4.4 为什么不做"完整/精简"动态切换

- 不同场景用不同人设 比 同一个请求里切换层级 更清晰、更不容易出错。
- 动态切换在实现上需要"先监测后切换",引入额外状态和判断点,反而脆弱。
- 一份稳定的人设,从第一轮到第 N 轮,模型说话风格一致,反而更"像同一个 Agent"。

### 4.5 System Prompt 的分层注入(代码层语义分开)

**`prompts/cyrene_harness.md` 只承担 Persona(人格),不承担 Runtime Policy(运行时规则)。**

Harness system prompt 的拼接顺序(代码层按这个顺序组合,运行时拼成一条):

```
Harness System Policy      ← Runtime 行为规则:"不要假装完成" / "edit_file 后要 verify" / "Todo State 怎么用"
       ↓
Harness Persona            ← `prompts/cyrene_harness.md`:我是谁、怎么说话、关系
       ↓
Environment / Capabilities ← OS 时间、工作目录、可用工具列表、permission level
       ↓
Memory / Retrieved Context  ← L0/L1 画像、Worldbook 激活、长期记忆摘要
       ↓
Agent State / Todo          ← 当前 Todo Items 当前未完成 obligations
       ↓
Conversation                ← 历史 messages(用户消息 / assistant / tool)
```

**为什么必须分层**:
- 你以后改昔涟 Prompt 不会不小心把 Harness 行为规则改坏。
- Runtime Policy 那一段可以"加 lock"或 audit,不会被人设同文件污染。
- 施工时各层独立可测:可以单独测试"Runtime Policy"层、"Persona"层是否生效。

`cyrene_harness.md` 具体应该定义什么:
- 昔涟是谁
- 怎么说话
- 工作时怎么表现
- 与用户的关系

**不应该**塞进去(由 Runtime System Policy 层负责):
- "什么时候该用 Todo"
- "Ask 如何使用"
- "不要虚假完成"
- "工具权限"
- "Completion"
- "Environment"
- "当前时间"
- "Memory"
- "Agent State"

这样改 Persona 不会跟 Harness 行为规则互相打架。

---

## 5. 错误分类与重试

**核心原则:Error Category 和 Retry Policy 必须分开,两者结合 Tool Side-effect Semantics 共同决定 Retry。**

不能简单地 `transient -> 自动 retry`。例:`send_email` 超时(timeout 归类为 transient)但邮件可能已经发出,无脑重试会导致重复发件。

### 5.1 错误类别(Error Category)

由 `classifyToolError(err)` 分类,参考已有的 `classifyCreatePlanError`(`agent-graph.ts:439-481`)。

| category | 触发 | 含义 |
|---|---|---|
| `not_found` | ENOENT / 404 | 目标不存在 |
| `permission_denied` | EACCES / EPERM / 403 | 权限不足 |
| `invalid_arguments` | schema / 参数类型错 | 参数错误 |
| `timeout` | 工具自身超时 | 超时(可能是网络,可能是工具内部) |
| `rate_limited` | 429 | 限流 |
| `transient` | 网络/锁/503/EBUSY/EAGAIN 等明确知道是临时的 | 临时错误,**已知**值得重试 |
| `unknown` | Runtime 无法归到已知 category 的错误(TypeError / 协议解析异常 / SDK 行为变化 / 工具实现 bug / unexpected response shape) | 未知,**不确定** |
| `semantic_failure` | 工具跑了但业务结果失败(测试不通过) | 语义失败 |
| `partial_failure` | 部分成功、部分失败 | 部分失败 |
| `fatal` | Runtime 本身无法保证继续安全 | 已无法可靠继续 |

**关键澄清:`unknown` 不是 `transient`,也不是 `fatal`**。

- `unknown` 不归到 `transient`:`unknown → retry` 是错的,因为它可能是 SDK 解析 bug、协议变更、TypeError 等,重试 3 次没意义。
- `unknown` 不归到 `fatal`:它可能只是边缘 case,Runtime 仍能继续处理。
- `unknown` 的策略保守:**只对 `read_only` 工具考虑最多 1 次重试,其他不重试**。
- `fatal` 仍然只表示 Harness Runtime 已经无法保证继续安全(内部状态损坏、依赖不可用)。`fatal` 不是"未知错误垃圾桶"。

### 5.2 工具副作用语义(Tool Side-effect Semantics)

**Side-effect Semantics 不是 Tool 的静态属性,而是 (Tool, Arguments) 的属性。**

```ts
type SideEffectKind =
  | "read_only"                     // 只读
  | "idempotent_mutation"           // 幂等修改
  | "non_idempotent_side_effect"    // 非幂等副作用
```

**重要原则:Fail-safe Default(失败安全默认值),不要做"智能 Shell 语义分析器"。**

shell command 的语义几乎无限(`python script.py` 内部做了什么完全是黑盒)。仅靠 command string 字符串分析不可靠。

```
原则:宁愿少 retry 一次,也不要错把非幂等副作用当作可重试。

明确 whitelist 识别 → 对应 SideEffectKind
其他所有不知道的 → non_idempotent_side_effect(默认按有副作用处理)
```

实现:

```ts
type ToolDefinition = {
  // ...
  sideEffect: SideEffectKind | ((args: unknown) => SideEffectKind)
}
```

| form | 含义 |
|---|---|
| 静态值(字符串) | 该工具所有调用都属于这一类(如 `read_file` 永远 `read_only`) |
| 函数 `(args) => SideEffectKind` | 根据参数动态判断(如 `run_shell` whitelist 已知 read-only 命令,其他默认 `non_idempotent_side_effect`) |

`runtime.resolveSideEffect(tool, args)` 内部:
```ts
resolveSideEffect(tool, args):
   if typeof tool.sideEffect === "function":
      return tool.sideEffect(args)   // run_shell 走这,默认 non_idempotent
   return tool.sideEffect
```

例子:
- `read_file` → `sideEffect: "read_only"`
- `send_email` → `sideEffect: "non_idempotent_side_effect"`(发出去就发出去了)
- `run_shell` → `sideEffect: (args) => isReadOnlyCommand(args.command) ? "read_only" : "non_idempotent_side_effect"` —— 默认保守
  - whitelist(read-only):`git status` / `pwd` / `ls` / `cat` 等
  - 其他(rm / curl / npm publish / python xxx.py 等)→ `non_idempotent_side_effect`
- `write_file` → `sideEffect: (args) => args.mode === "append" ? "non_idempotent_side_effect" : "idempotent_mutation"`

**`completionSemantics`(见 §6.1)同样支持动态解析**。

### 5.3 Retry Decision(分类 + 副作用 → 重试决策)

```
classifyToolError(err) -> category
getToolSideEffect(toolId) -> semantics

decideRetry(category, semantics):
   case "read_only":
      transient / timeout / rate_limited: 重试(参数见 §5.4)
      unknown: 最多 1 次重试(保守)
      not_found / permission_denied / invalid_arguments / fatal: 不重试

   case "idempotent_mutation":
      transient / timeout / rate_limited: 重试
      unknown / not_found / permission_denied / invalid_arguments / semantic_failure / partial_failure: 不重试

   case "non_idempotent_side_effect":
      任何 category 都不自动重试
      (除非有 idempotency key 保证安全,P1 再说)
      unknown 也要拦,因为重发邮件 / 重 clone / 重删都是错的

   任何 category == "fatal":
      不重试,考虑终止 loop
```

### 5.4 自动重试参数

```
transient:
   重试 3 次,退避 500ms -> 1s -> 2s(带抖动)

timeout:
   重试 2 次,退避 1s -> 3s(留出一点时间等依赖恢复)

rate_limited:
   重试 2 次,退避 2s -> 5s
   (按 Retry-After header 优先)

unknown:
   只对 read_only 工具考虑:最多 1 次,无退避(立即重试一次)。
   任何情况下都不对 mutation / side_effect 重试。

重试间不调 LLM,纯 Runtime 行为。
重试用尽后,无论何 category 都把最终错误结构化给模型。
```

### 5.5 给模型的 observation 格式

```json
{
  "outcome": "failure",
  "category": "not_found",
  "toolSideEffect": "read_only",
  "retry_decision": "gave_up_after_3",
  "tool": "read_file",
  "target": "foo.ts",
  "message": "文件 foo.ts 不存在",
  "suggestion": "可以先 list_dir 查看目录内容"
}
```

#### 5.5.1 outcome 四态:处理 non_idempotent_side_effect 的结果不确定问题

`outcome` 字段固定四态,**只用这一种状态维度**,不与 `category` 重叠:

| outcome | 含义 | 触发 |
|---|---|---|
| `success` | Runtime 明确知道工具成功(返回了证据 / 文件存在) | 工具正常返回;retry 成功 |
| `failure` | Runtime 明确知道工具失败(err.message / exit code 等确定性信号) | error 抛出;输出是结构化失败 |
| `unknown` | Runtime **不知道**工具到底怎么样了 | 主要是 **`non_idempotent_side_effect` 在 timeout 时**:邮件 / clone / 删除 等已经发起的副作用,response 中途丢失,Runtime 无法确认是否真正生效 |
| `not_executed` | Runtime 主动决定不执行该工具(协议性结果,非工具真实执行结果) | ask_user 排他;同轮 fatal / unknown 中断;fingerprint 重复拦截 |

**为什么 `unknown` 必须存在**:

`send_email` 超时时,`category = timeout` 但 outcome 不能是 `failure`,因为不能肯定"邮件没发出去";也不能是 `success`,因为不能肯定"发出去了"。如果强选 `failure` 然后重试,**可能重复发**;如果强选 `success` 然后跑后续逻辑,**用户以为发了但其实没有**。

`unknown` 触发 Runtime 处理:

```
outcome = unknown + sideEffect = non_idempotent_side_effect:
   // 重要:不重试,不假设成功,不告诉模型"成功了"
   // 暴露给模型 / 用户:让上层决定怎么处理
   observation.outcome = "unknown"
   observation.message = "命令已发起但未确认是否成功(可能是已生效/可能未生效)"
   observation.require_user_involvement = true   // 标记
```

### 5.5.1.1 `uncertainEffects` 状态:阻止伪完成与重复副作用(v3 新增)

`unknown` 不能只停留在 observation 的 message 里,否则模型下一轮可能:

1. 假装 obligation 已完成,骗过 Completion Guard;
2. 自己再次调用同一副作用工具,导致重复发送 / 重复删除 / 重复发布。

P0 加一个极小的状态数组:

```ts
type UncertainEffect = {
  toolCallId: string
  fingerprint: string      // 工具名 + 参数签名,用于识别"同一调用"
  toolName: string
  message: string
}

type AgentState = {
  todoItems: TodoItem[]
  completionObligations: CompletionObligation[]
  uncertainEffects: UncertainEffect[]   // v3 新增
}
```

**生成规则**:

```
on tool result:
   if outcome == "unknown" and sideEffect == "non_idempotent_side_effect":
      push UncertainEffect(toolCallId, fingerprint(tool), toolName, message)
```

**拦截规则**:

```
// 1. Completion Guard 必须同时检查 obligations 和 uncertainEffects
checkCompletion():
   if unresolvedObligations.length == 0 && state.uncertainEffects.length == 0:
      return final
   else:
      return runtimeFeedback(...)

// 2. 同轮执行中断:一旦出现 unknown non-idempotent,本轮后续 side-effect 调用 halt
//    (见 §3.1 多 tool call 中断规则)

// 3. 禁止直接重复执行相同 fingerprint 的副作用
before executeToolCall(call):
   if state.uncertainEffects.some(e => e.fingerprint == fingerprint(call)):
      return toolResult(call, {
         outcome: "failure",
         category: "runtime_safety",
         message: "该副作用已有一次未确认结果,在 reconcile 或 ask 用户前不能重复执行"
      })
```

**解除规则(v3 P0)**:

不确定 effect **只能**通过以下两种方式之一解除:

1. **`reconcile` 工具(或等效验证工具)**:Runtime / 模型调用一个确定性验证工具确认副作用实际状态(例如 `send_email` 后查邮件已发列表、`clone` 后查目录存在)。验证成功后从 `uncertainEffects` 移除。
2. **`ask_user` 让用户确认**:用户明确说"邮件已经发了,继续"或"再发一次"。

P0 不自动做"重试 + 幂等标记",也不让模型在未解除的情况下直接重复副作用。这是一个 safety invariant:

> **我不知道一个不可重复的副作用是否已经发生时,不能假装知道,也不能直接再做一遍。**

**`unknown` 不会自动走 Completion Guard 的"满足 obligation"路径** -- 因为 obligation 是"必须有证据才算完成",unknown 不是证据。

P0 不强行实现"给 unknown 自动做事"(如重发 + 标记幂等),这是 P1 idempotency key 的方向,但 P0 至少要把这个状态**显式承认并写入 AgentState**,不让它隐藏成 `failure` 误导后续逻辑。

### 5.5.2 其他 observation 字段

`retry_decision` 字段告诉模型 Runtime 已经做了什么(`retried_3_times_and_gave_up` / `auto_retried` / `not_retried`)。模型不用关心分类细节,只看 `outcome` / `category` / `retry_decision` 就知道下一步。

`suggestion` 字段是可选的提示,模型可不采纳。

### 5.6 不做什么

- ❌ 不让 LLM 决定"要不要重试"(这是代码的活)
- ❌ 不做工具级 idempotency key(P1)
- ❌ 不做 side-effect tracking(P1)
- ❌ 不做跨执行的失败预测(P2)

### 5.7 工具输出预算与截断(v2 新增,P0)

**问题**:连续 Loop 上下文爆炸的最常见来源不是对话,而是工具大输出(`read_file` 读 2000 行日志、`run_shell` 刷大量 stdout)。现有 `truncateToolResult`(`context-manager.ts:54`,2000 字符平砍)只在 legacy 路径使用,LangGraph 路径没接,且一刀切会砍掉关键内容。

**P0 方案(双级预算,统一挂在 `executeToolCall` 出口)**:

| 级别 | 预算 | 行为 |
|---|---|---|
| 软截断 | ~2000 字符(复用 `truncateToolResult`) | 默认所有工具;截断后返回结构化 preview,**可选附带 `fullOutputRef`** |
| 硬熔断 | ~8000 字符 | 任何工具输出超过即砍到 8000 + 明显标记,防单次调用吃掉数万 token |

**截断后的 Tool Result 结构(v3 明确)**:

```json
{
  "outcome": "success",
  "truncated": true,
  "preview": "...前 2000 字符...",
  "fullOutputRef": "file://temp/tool-output/<callId>.txt"  // 有才给,没有就不给
}
```

`fullOutputRef` 规则:

1. **只读工具**(`read_file`, `grep`, `run_shell` 的 read-only whitelist 等):如果有 backing store 把完整输出存了,给 `fullOutputRef`,并允许提示模型"可用 read_file offset 查看"。
2. **副作用工具**(`send_email`, `append_file`, `npm publish`, `run_shell` 的非白名单命令等):**禁止把"可重跑"作为通用 fallback**。可以提示"完整日志已保存到 X",但不能建议"再执行一次"——重跑一次可能产生重复副作用。
3. **没有 backing store 时**:`fullOutputRef` 字段直接省略,preview 就是全部能拿到的东西;对只读工具可以提示重新读取,对副作用工具不提供重跑建议。

`ToolDefinition` 增加可选字段(与 §5.2 sideEffect、§6.1 completionSemantics 同批施工):
- `maxOutputChars?: number` —— 覆盖默认软截断预算
- `outputStorage?: "memory" | "temp_file" | "none"` —— 是否/如何保存完整输出供 `fullOutputRef` 引用

`read_file` / `run_shell` 这类已知大输出工具首批声明 `maxOutputChars` 与 `outputStorage`。

**P1**:分工具策略化截断(`read_file` 按行保留头尾、`grep` 限条数、`run_shell` 保留 stdout 头 + stderr 尾),替代平砍;Backing store 统一为 `ToolOutputStore` 抽象。

---

## 6. 完成策略

**核心原则:Tool 声明语义("我是什么"),Runtime 执行验证策略("这种东西怎么算真的完成")。**

### 6.1 Tool 声明的 `completionSemantics`(支持动态解析)

跟 §5.2 的 sideEffect 一样,completion 也常常跟参数相关(`run_shell("rm -rf")` 不需要 post-verify,`run_shell("npm test")` 自己就是 verification)。

```ts
type CompletionSemantics = {
  type: "read_self_evidence"          // 工具自己返回 result 就算完成
       | "require_post_verification"  // 完成后需要跑验证(声明期望 verify 工具)
       | "require_artifact_persistence" // 完成后必须看到外部产物存在
       | "always_satisfied"           // 总是满足(read 类常用)

  // 仅 require_post_verification
  preferredVerifyToolId?: string
  
  // 仅 require_artifact_persistence
  artifactCheck?: "file_exists_nonempty" | "file_exists"
  artifactPathFromArgs?: (args) => string  // 从参数里提取产物路径
}

type ToolDefinition = {
  id: string
  name: string
  inputSchema: ...
  // 不再保留 effectKind 字段(原来 read / mutation / external_side_effect 三分)。
  // 新语义只用 sideEffect(retry 决策)和 completionSemantics(完成策略)两个维度。
  sideEffect: SideEffectKind | ((args) => SideEffectKind)  // 见 §5.2
  
  // 完成语义:可以静态值,也可以根据 args 动态解析
  completionSemantics: CompletionSemantics
                 | ((args: unknown) => CompletionSemantics)
}
```

`runtime.resolveCompletionSemantics(tool, args)` 内部:
```ts
if typeof tool.completionSemantics === "function":
   return tool.completionSemantics(args)
return tool.completionSemantics
```

具体怎么验证由 Harness Runtime 的 completion policy 统一实现。

### 6.2 几个例子

| 工具 | sideEffect | completionSemantics |
|---|---|---|
| `read_file` | `read_only` | `always_satisfied` |
| `list_dir` | `read_only` | `always_satisfied` |
| `web_search` | `read_only` | `read_self_evidence`(当场判定,有结果就 satisfied,没结果就是一次失败的 observation,**不产生 obligation**,让模型自己换关键词) |
| `write_file` 覆盖模式 | `idempotent_mutation` | `require_artifact_persistence`,artifactCheck `file_exists_nonempty`,artifactPathFromArgs `(args) => args.path` |
| `write_file` 追加模式 | `non_idempotent_side_effect` | `require_artifact_persistence`,artifactCheck `file_exists_nonempty` |
| `edit_file` | 视情况 | `require_post_verification`,preferredVerifyToolId `run_verification` |
| `run_shell`(npm test) | 视 command 解析 | `read_self_evidence` —— **`npm test` 本身就是 verification**,不需要再 verify |
| `run_shell`(普通命令) | 视 command 解析 | `always_satisfied` 或 `read_self_evidence` |
| `send_email` | `non_idempotent_side_effect` | `read_self_evidence`(已发送就算完成) |

### 6.3 Runtime 用"未完成 Obligations 数组"追踪

**核心转变:不是"历史上所有工具调用是不是都成功",而是"现在还有没有 unresolved 的 completion obligation"。**

```ts
type CompletionObligation = {
  id: string
  toolCallId: string              // 关联到具体的 tool_call
  type: "verify_required" | "artifact_required"
  // verify_required
  expectedVerifyToolId?: string
  // artifact_required
  artifactPath?: string
  artifactCheck?: string
  createdAt: string
}

type UncertainEffect = {
  toolCallId: string
  fingerprint: string             // 工具名 + 参数签名
  toolName: string
  message: string
}

type AgentState = {
  todoItems: TodoItem[]
  completionObligations: CompletionObligation[]
  uncertainEffects: UncertainEffect[]             // v3 新增:未知副作用的安全拦截
  // ...
}
```

**为什么用数组而不是扫历史**:
- 旧算法:"for each toolCall in toolResults..." 会遇到已失败的旧搜索 / 旧尝试,这些不需要永久 blocker 完成。
- 新算法:失败的、supersede 的工具调用**不产生** obligation;只有"产生 obligation 的成功调用"才算数。

### 6.4 Obligation 生命周期

**生成 obligation** —— Runtime 在每次工具返回后,**只有 `outcome == "success"` 时才根据 resolved `completionSemantics` 决定**:

```
on tool result:
   if outcome != "success":
      // failure / unknown 都不产生 obligation
      // failure:让模型看 observation 自己决定
      // unknown:写入 uncertainEffects(如果是 non_idempotent side-effect,见 §5.5.1.1)
      pass

   semantics = resolveCompletionSemantics(tool, args)

   case "always_satisfied":
      // 不产生任何 obligation
      pass
   
   case "read_self_evidence":
      // 当场判定:工具自己的 result 就是证据
      if toolCall.result 有非空 evidence(结果对象 / 文件路径 / 数量):
         pass  // 完全不产生 obligation
      else:
         // 没结果不是"有未完成义务",只是"一次失败的 observation"
         // 让模型自己决定下一步(换关键词 / 换工具 / 接受空结果)
         pass  // 不产生 obligation
   
   case "require_post_verification":
      // 产生 obligation,期望模型后续调用 preferredVerifyToolId
      push obligation(type: "verify_required", expectedVerifyToolId, ...)
   
   case "require_artifact_persistence":
      path = artifactPathFromArgs(args)
      push obligation(type: "artifact_required", path, ...)
```

**满足 / 取代 obligation** —— 后续工具调用结果检查:

```
on tool result received:
   for each obligation in completionObligations:
      if obligation.type == "verify_required" and result.toolCall.name == obligation.expectedVerifyToolId:
         if verification passed:
            mark obligation.satisfied = true
         else:
            保留 obligation(继续 blocker)
      
      if obligation.type == "artifact_required" and artifact check passed:
         mark obligation.satisfied = true

   清理 satisfied obligations
```

#### 6.4.1 Completion Guard 边界:只管确定性事实,禁止膨胀成第二套 Workflow

**Completion Guard(完成守卫)的边界** —— **只管确定性事实,不做任何开放语义判断**:

✅ **可以做的**(确定性事实):
- 验证工具返回里是否包含具体证据(结构化成功标志、文件存在 / 大小、测试输出等)
- 验证未完成 obligation 是否被满足
- 检查 `outcome` 是不是 `success`(明确知道成功)
- 阻断 `non_idempotent_side_effect` + `outcome = unknown` 的伪完成:通过 `AgentState.uncertainEffects` 数组拦截(§5.5.1.1)

❌ **不可以做的**(开放语义):
- 不评估"工作质量好不好"
- 不做 LLM 调用来"评估"模型回答得是否合理(那是评价,不是事实)
- 不"再想想"是否真的完成(模型自己判断)
- 不维护第二套并行状态机或 workflow
- 不存任何"工作进度的高级推断"

**为什么这条边界关键**:

Completion Guard 容易膨胀,一旦开始"判断工作是不是真的做完了",就会演变成第二套隐含 Workflow,CyreneHarness 就退化成 LangGraph 那条死路。

P0 Completion Guard 严格限于"obligation 是不是全部 satisfied"+"outcome 是不是 success"。**剩下的判断交给模型自己**。

模型如果说"完成了但其实没做完"(撒谎 / 自欺)—— Runtime 能拦的是这一类:明确的 obligation 缺失 / `unknown` outcome。**拦不住的**是"模型说得头头是道但实际工作没真做" —— 这种只能靠评估 / 复盘机制做,但 P0 不做。

### 6.5 检查 Completion(模型想结束 Loop 时)

模型说"完成了"(没有 tool_call)时,Runtime 跑 `checkCompletion()`:

```
unresolved = completionObligations.filter(o => !o.satisfied)

if unresolved.length == 0 && state.uncertainEffects.length == 0:
   commit final content to user    // 见 §3.1 progress stream vs final commit
   return

# 模型想结束但有未完成义务或未知副作用
feedbackParts = []
if unresolved.length > 0:
   feedbackParts.push(`你还有 ${unresolved.length} 个未完成的验证义务:\n` +
                      unresolved.map(o => `- ${describe(o)}`).join('\n'))
if state.uncertainEffects.length > 0:
   feedbackParts.push(`以下副作用结果未知,不能结束:\n` +
                      state.uncertainEffects.map(e => `- ${e.toolName}: ${e.message}`).join('\n'))

push Runtime Feedback 消息(feedbackParts.join('\n\n'))
continue  // 让模型继续处理
```

**关键变化:不再扫所有 tool history**。失败 / superseded 的旧工具调用不会永久 blocker,因为它们从来没产生 obligation 或已经被清理。`uncertainEffects` 会阻止"unknown non-idempotent side-effect"后的伪完成(§5.5.1.1)。

### 6.5.1 Runtime Feedback:不伪装成 `role:user`

**Runtime 自己说的反馈不能伪装成 `role: user`** —— 用户根本没说过这句话。

```
# 错误 ❌
messages.push({ role: "user", content: "你还有 2 个验证义务没完成" })

# 正确 ✅
messages.push(runtimeFeedback("你还有 2 个验证义务没完成"))
```

`runtimeFeedback` 是 Harness 内部的抽象消息类型,具体形态由 **Provider Adapter 决定**:

```
runtimeFeedback(text):
   OpenAI:    -> { role: "developer" }                // developer role
   Anthropic: -> 续接在 system 后的特殊 block
   GLM:       -> { role: "system" }
```

**为什么不直接复用 `role: user`**:
- 模型会把 `role:user` 当作"用户说的话",可能误以为用户在催它,改变响应风格。
- **长期上下文与恢复很重要**:Crash 之后如果 conversation history 有"假用户消息",恢复会误以为用户改主意了。
- 让 Provider 决定最合适的角色映射更灵活。

Provider Adapter 内部维护这个映射表。同一段 Runtime Feedback 在不同 provider 下走不同 channel,但**对外是统一的 `runtimeFeedback` 抽象**。

### 6.6 与 planVerify 解耦

- LangGraph 时代 `planVerify` 是一个**图节点**,在 `routeAfterTool` 之后跑。
- Harness 里 obligation 是 `AgentState` 的一个**数组**,没有图节点 / 边 / Command 概念。
- 没有 Todo 跟 obligation 的"两套事实源"问题:Todo(§8)是模型对未来步骤的计划,obligation 是 Runtime 对已完成步骤的承诺追踪。两者不同。

### 6.7 Prompt 层 + 代码层配合

**Prompt 层**(在 Harness System Policy 层,不是 `cyrene_harness.md` -- 见 §4.5):
```
涉及代码修改时,如果存在合理可用的验证方式,在宣布完成前应执行验证。
涉及文件生成时,确认文件已成功写入磁盘。
不要在没有验证的情况下声称任务完成。
```

**代码层**:`completionObligations` 数组。即使模型撒谎,Runtime 也能拦住。

```

**代码层**:`checkCompletion` 兜底。即使模型撒谎,Runtime 也能拦住。

---

## 7. 流式与事件

### 7.1 两层 Stream:Model Stream vs User-visible Stream

> **现行说明（v4）**：下文“不能直接发 UI”指不能把模型增量提前当作已确认的 Progress 或 Final 提交。现在允许通过独立的 `cyrene.candidate_text` 临时通道预览正文；该内容不进入正式消息、检查点或早播语音，随后仍由本节的 flush / discard / commit 规则决定唯一权威归类。下文 Completion Guard 已不属于现行实现，参见文首 v4 补充。

**关键区分:Provider -> Harness 的 token 流 和 Harness -> UI 的用户可见流是两层,不能混为一谈。**

| 层 | 方向 | 含义 |
|---|---|---|
| **Model Stream** | Provider -> Harness | token 可以实时流入 Harness,Harness 收到后 **buffer**,不无条件直发 UI |
| **User-visible Stream** | Harness -> UI | 由 Progress / Final 语义决定什么时候真正 flush / commit 给用户 |

**为什么不能让 Model Stream 直接发 UI**:

如果 token 一到就无条件发 UI,模型说"测试全部通过了"时用户立刻看到。然后 Completion Guard 发现根本没跑测试,拦住了 Loop 结束 -- 但用户已经看到"测试通过了"。**Completion Guard 拦住了状态,没拦住用户可见的错误声明。**

所以 Model Stream 必须先 buffer,由 Harness 根据 §3.1 的语义决定:
- **有普通 tool_calls** -> buffered content 作为 **Progress Message** flush 给用户(进度汇报,用户应该看到)
- **有 ask_user** -> buffered content **discard**(Ask 卡片自己承担交互,不需要 progress text)
- **无 tool_calls + Completion 通过** -> buffered content 作为 **Final Answer** commit 给用户
- **无 tool_calls + Completion 未通过** -> **不 commit**,给模型 Runtime Feedback 后继续(用户不应该看到模型提前宣布"已完成")

#### 7.1.1 正确性优先于逐 token streaming

**Final Answer 允许 buffer 后提交。正确性优先于真正的实时 token streaming(逐 token 流式输出)。**

这意味着:
- Progress Message 阶段可以**真正逐 token 流式**给用户(进度汇报,模型边想边说,边发用户看得到)
- Final Answer 阶段 **buffer 完整 response 之后**,再一次性 commit 给 UI(不是边生成边发)

**为什么 Final Answer 不能逐 token 流**:

如果 Final Answer 边生成边发,模型刚生成 token "我修改完了,..." 用户立刻看到;然后 Completion Guard 后续跑检测发现 obligation 未满足,Runtime 反馈回去让模型"继续"。**但用户已经看到"我修改完了,..." 后面又来一段"对不起,我还没改完..."** — 体验上是先撒谎再撤回。

即使 Final Answer 99% 会通过 Completion Guard,1% 的情况也会给用户看到一份半真半假的"已成功"声明,然后被 Runtime 收紧。这跟 SOUL 独立阶段的"事故报告"问题本质上一样,**不能为了实时性牺牲正确性**。

Progress Message 与 Final Answer 的流式策略分离:

| 类别 | 是否逐 token 流 | 理由 |
|---|---|---|
| Progress Message(中间进度汇报) | ✅ 是 | 用户看到的是"正在做什么",即使后面改主意也不会误导 |
| **Final Answer**(声称完成) | ❌ 否,buffer 完整后 commit | 用户看到的应该是 Runtime 已经确认过的事实,不是模型刚编的第一个 token |

实现层面:P0 可以用同步 streaming(边生成边 buffer 到内存,跑完再 emit),不必实现"边生成边发然后撤回"。**P0 实现可以是同步的,不动 streaming pipeline**。P1 可以优化 buffer 延迟。

### 7.2 流式实现

- Model Stream:复用 TwoPhaseFC 里 `WorkStreamEventBridge` 的纯 TS 逻辑,搬到 `agent-loop-stream.ts` 文件。
- 工具执行不流式(工具结果是完整 JSON,不需要流式)。
- User-visible Stream 的 flush / discard / commit 由 Harness Loop 控制,不是 Stream Bridge 控制。

### 7.3 AG-UI 事件

保留已有的事件类型:
- `TEXT_MESSAGE_START` / `CONTENT` / `END` -- 模型的 content(由 Harness 决定何时发出)
- `TOOL_CALL_START` / `ARGS` / `RESULT` / `END` -- 工具调用
- `REASONING_MESSAGE_*` -- 如果模型支持 reasoning
- `CUSTOM`(`cyrene.todo`,单数) -- Todo State 更新。**已定名**:`cyrene.taskPlan` 随旧体系删除;`cyrene.todos`(复数)是另一套用户待办系统(`todos/bootstrap.ts`),不动

**不新增事件类型。** CyreneHarness 产出的事件跟现有 UI 兼容。

---

## 8. 长任务工作清单:Todo State(替代 LangGraph Plan)

**核心思路:Todo 不再只是给用户看的 UI 效果,而是正式成为 `Agent State` 的一部分,由模型自己维护。**

### 8.1 删掉 LangGraph Plan 体系

明确删除(理由详见 §2.2 与 §Q9 对齐):
- `task-plan.ts` 里的 `runCreatePlan` / `verifyStep` / `runReplan`
- LangGraph 时代的 Planner / Replanner 节点 / TaskPlan 概念

不再有"Plan"和"Todo"两套 source of truth 并存。P1 引入 checkpoint / durable state 时,**Todo State 是天然的任务层状态基础**。

### 8.2 Todo 是什么

`Todo` 是 `Agent State` 的一部分:

```ts
type TodoItem = {
  id: string
  content: string         // 步骤描述(模型自己写)
  status: "pending" | "in_progress" | "completed" | "skipped"
  createdAt: string
  updatedAt: string
}

type AgentState = {
  todoItems: TodoItem[]
  // 后续可以加更多(用户偏好、工具历史摘要、checkpoint 信息等)
}
```

### 8.3 模型通过 `update_todo` 工具维护

`update_todo` 是 **Harness 内置工具**(v2 拍板):**不注册进通用 toolRegistry**——避免暴露给 Chat 模式和子代理;由 Harness Loop 内部直接 dispatch,不走 `executeToolCall`、不过权限系统(不该问用户"是否允许昔涟更新她的 todo 列表"):

```ts
{
  name: "update_todo",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "enum", enum: ["pending", "in_progress", "completed", "skipped"] }
          },
          required: ["id", "content", "status"]
        }
      }
    },
    required: ["items"]
  }
}
```

**模型调 `update_todo` 时**:Runtime 更新 `state.todoItems`,并通过 AG-UI 事件(`cyrene.todo`)推给 UI。

### 8.4 强制什么时候使用 Todo

**不是所有任务都强制创建 Todo。**

- 一两步的简单任务:模型直接调工具,不创建 Todo。
- 多步、需要持续跟踪的任务:模型主动创建 Todo。

判断权完全在模型。Runtime 不强制。

### 8.5 模型与现实不一致时主动更新

类比"人干活时调整手里的任务清单":

```
模型: 计划先读 foo.ts,再改 line 82,再跑测试
   ↓
执行后模型意识到:line 82 实际已经被别人改了,我的改法不对
   ↓
模型主动调 update_todo 更新 items
   (原"改 line 82"标 completed 但加备注说是改另外地方;新增一行"先 git pull")
```

### 8.6 与 LangGraph Plan 关键差异

| 维度 | LangGraph Plan | Todo State |
|---|---|---|
| 谁生成 | Planner LLM(独立节点) | 模型自己 |
| 谁维护 | Verify / Replan 节点(LangGraph API) | 模型自己(通过 update_todo 工具) |
| 是否有图节点 | 是 | 否,纯 state |
| 是否走图 Command | 是 | 否,直接 mutate state |
| 触发更新 | Verify / Replan 结果驱动 | 模型自觉调用 |
| 持久化 | 不持久化 | 当前不持久化(P1 加) |

### 8.7 UI 的位置

UI **只是 Todo State 的展示层**,不是 Todo 本身。

- Todo State 是 Agent 自治的一部分
- UI 通过 AG-UI 事件订阅 `cyrene.todo` 事件流,展示当前 todo 列表
- 模型更新 todo 时,UI 跟着更新
- **UI 不参与 Todo 的生成、维护、判断**

### 8.8 给现有 todo 卡片的工程影响

现有 todo 卡片(应该是 UI 上展示的"工作清单"组件)从"展示驱动"升级为"状态驱动":
- 后端:`AgentState.todoItems` 是唯一的 source of truth
- 事件:`update_todo` 调用 -> 更新 state -> emit `cyrene.todo` 事件 -> UI 收到事件更新
- UI:订阅事件流展示

不需要改 UI 卡片组件,只需要让事件来源从"占位数据"换成"真实 state"。

**事件定名(v2 拍板):`cyrene.todo`(单数)。** `ChatPage.tsx:1085` 当前订阅 `cyrene.taskPlan` 的代码改订阅 `cyrene.todo`,payload 形状从 TaskPlan 换成 `TodoItem[]`;`cyrene.todos`(复数,`ChatPage.tsx:430`)是用户待办系统,**不动**。

### 8.9 Todo Runtime invariants

Runtime 维护 Todo State 时必须保证的不变量:

```ts
// invariant checks
validateTodo(items: TodoItem[]):
   ids = items.map(i => i.id)
   assert new Set(ids).size === ids.length   // ids 必须唯一
   assert items.every(i => isValidStatus(i.status))
   // (P0 不引入 deleted 状态;取消的项用 existing skipped 状态表达)
   // pending / in_progress 整表替换时不能无故消失
```

**整表替换 vs 增量修改(replace vs patch)**:

P0 用**整表替换** (`update_todo({ items: [...] })`),但 Runtime 每次应用前必须验证 invariants:
- `pending / in_progress` 的项整表替换时不能无故消失(防止误删还在跟进的步骤)
- 不再需要的计划项标记为 `skipped`(P0 状态机不引入 deleted)
- `completed / skipped` 后续是否继续保留展示由实现决定(Runtime 不强制)
- Status 只能合法转移:pending -> in_progress -> completed / skipped;不能在 completed 之后再变回 pending

P1 可以引入增量 API (`update_todo({ operations: [...] })`),但 P0 不必。

### 8.10 最多一个 `in_progress`

P0 没有并行执行,Runtime **保证 Todo 列表里最多只有一个 `status: "in_progress"` 的 item**(语义层面的"当前在做什么")。

如果模型传了一个多 in_progress 的 Todo,Runtimeraise invariant violation,fallback 接受第一个 in_progress,其余降级回 pending(报错但不让 Loop 死)。

**invariant 修正必须回告模型**:Runtime 做修正(降级多 in_progress / 拒绝非法状态转移)后,Tool Result 里必须包含"修正后的实际列表 + 修正说明",不能静默改——否则模型以为计划被原样接受,后续基于错误认知继续干活。

---

## 9. Ask User(信息补全机制)

### 9.1 本质

**Ask 不是"路由决策",而是给模型补充当前任务缺少的信息。**

它不替模型决定后面调用哪个工具。模型调用 `ask_user` → 补全信息 → 模型重新决定下一步。

### 9.2 `ask_user` 是 exclusive control tool(排他控制工具)

模型一次返回可能包含多个 `tool_calls`:

```
tool_calls: [
   { name: "ask_user", args: {...} },
   { name: "write_file", args: {...} },  // ← 同一轮,排在 ask_user 后面
   { name: "update_todo", args: {...} }
]
```

**排他规则:只要一轮里出现 `ask_user`,该轮其他所有工具调用都不能执行。**

处理流程:
```
if response.tool_calls 包含 ask_user:
   对其他所有 tool_call:
      send tool_call_result 工具返回:
         { outcome: "not_executed", reason: "not_executed_due_to_clarification" }
   
   调 ask_user(走 §9.4 pending Promise)
   把答案包成 Tool Result 塞回 messages
   本轮的 progress content 也不 commit
   回到 LLM,模型根据新信息重新决策
```

为什么必须排他:
- 否则模型可能写"我要问你 X,同时已经把 Y 文件改了" —— 但 Y 文件的改动基于"没拿到 X 信息"的假设。
- 用户拿到 Y 改完 + X 问题,可能给出 "应该先别改 Y" 的答案 —— 但 Y 已经改了。
- **必须先问,后改。**

### 9.3 Schema

参考现有 Ask UI 能力,保留多题 + 选项 + 自定义回答:

```ts
ask_user({
  questions: [
    {
      key: string           // 回答里这个字段的键(用户回答会用上)
      prompt: string        // 问题文本
      options?: string[]    // 推荐选项(1-3 个)
      required?: boolean    // 是否必答
    },
    ...
  ]
})
```

**UI 行为**:
- 一次问 1 个或多个问题(模型自己决定)
- 每个问题:
   - 如果 `options` 提供,渲染成按钮 + "其他" 自定义输入
   - 用户始终可以选择"其他 / 自定义回答"
- 多题可以切换查看
- 最后统一提交

### 9.4 实现:P0 用 pending Promise,**不是** AbortSignal

**`AbortSignal` 不是 suspend/resume 机制。** Abort 的语义是"取消",不是"暂停这个 Promise,明天接着跑"。

**P0 完全复用现有澄清链路(v2 拍板),不新建 registry / IPC / 事件类型:**

| 环节 | 现有实现 |
|---|---|
| pending Promise + 超时 + settle | `user-choice.ts:117` `requestUserClarification(card)`(pending Map + 120s 超时) |
| 下行事件 | `cyrene.choice` / `cyrene.choice.dismiss` CUSTOM 事件(`agui-bridge.ts:293-297`) |
| 上行 IPC | `IPC.CHOICE_RESOLVE`(`user-choice.ts:168-192`,含答案校验) |
| 渲染端卡片 | `ChatPage.tsx:1073-1080` 已消费,UI 现成 |

`ask_user` 的执行 = 把 `questions` 映射成 `AskClarificationCard` → 调 `requestUserClarification`(`cyrene-agent.ts:381` 已注入 loop)→ 答案按 §9.5 包成 Tool Result。

与 §8.3 的 `update_todo` 相同,`ask_user` 也是 **Harness 内置工具**:不进通用 registry、不走 `executeToolCall`、由 Loop 内部 dispatch。**必须保持对子代理不可见**(`sub-agent.ts:31` 白名单屏蔽逻辑同步覆盖新工具名),否则子 agent 会直接问用户,绕过主 Loop 的排他规则。

legacy 工具 `ask_user_choice`(`built-in-tools.ts:1490-1553`)随 TwoPhaseFC 一起删除,让出名字与职责。

**P1 才需要真正的 durable suspend / resume**(跨进程持久化恢复)。

### 9.5 用户答案必须作为 `role: tool` 返回,不是 `role: user`

`ask_user` 是 function calling 产生的 `tool_call`,协议上**它的结果必须以 Tool Result 形态返回**:

```json
{
  "role": "tool",
  "tool_call_id": "ask_xyz123",     // 必须配对 tool_call_id
  "content": {
    "answers": {
      "approach": "option_a",
      "scope": "只改 foo.ts"
    }
  }
}
```

**为什么必须这样**:
- 某些 Provider(OpenAI Native FC、Anthropic)对 `tool_call_id` 配对有硬性要求。
- 如果突然在 `assistant tool_call` 后面塞 `user message`,协议适配器可能拒绝整个 turn。
- **协议上,人对 ask_user 的回答 = 对 ask_user tool_call 的 tool result**,跟其他工具调用一致。

### 9.6 与 Action Gate 的 `ask_user` 决策分支的关系

- LangGraph 时代,`ask_user` 是 Action Gate 决策树上的一个分支(act / respond / ask_user / failure)。
- Harness 里:**`ask_user` 不再是一个分支,而是一个工具**,跟 `read_file` / `write_file` 平起平坐。模型想用就用,不用就用其他工具。
- 从图论的角度:删除了"askUser"节点。

---

## 10. 超时与取消(两个时钟)

**关键原则:用户等待时间不计入 Agent Execution Timeout。**

如果用户出去倒杯水 6 分钟,这时 Harness 的 300 秒上限应该 pause,不应该把任务杀掉。

### 10.1 两个时钟

```
activeExecutionTime   ← LLM 调用 / 工具运行 / Runtime 真正在工作
                      ← 累计
                      
userWaitTime          ← ask_user 等用户回答
                      ← 不计入 activeExecutionTime
```

300 秒 `executionTimeoutMs` **只限制 activeExecutionTime**。

### 10.2 时间计量(原则,不规定伪代码)

**双时钟设计的核心是"不要把 pause 时间算进去"。**

Harness 需要维护一个能在 ask_user 触发时 pause 的执行计时器,实现细节(用什么数据结构、用什么 API 做时间累加、是否用现成的 performance trace)由施工稿决定。

**重要警示:不要把当前设计稿里的伪代码当最终算法照抄。** 设计稿只规定原则和边界,具体算法落到施工稿时根据实际代码和性能需求决定。

### 10.3 用户取消

**用户取消仍然立即生效**(不受 pause/active 区分影响)。

### 10.4 时钟总览

| 机制 | 默认 | 说明 |
|---|---|---|
| `executionTimeoutMs`(active only) | 300s | 累计 active time,user wait 不算 |
| `maxRounds` | 30(同 `HARD_MAX_ITERATIONS`) | 循环轮数硬上限 |
| `perCallTimeoutMs` | 60s(可调) | 单次 LLM 调用超时 |
| 用户取消 | AbortController | 任何阶段立即生效 |

### 10.5 超时后

用 `buildTimeoutReply` 生成"任务超时,已完成的部分..."的回复。

### 10.6 循环内上下文压缩:Mid-loop Compaction(v2 新增,P0)

**问题**:现有 `compressConversation`(`context-manager.ts:90`)的 4 个调用方全部在 **Loop 入口处**(chat-loop / langgraph-agent-loop / two-phase-fc-loop / function-calling),循环体内从不检查。连续 Loop 恰在循环里膨胀——每轮塞 assistant 回复 + tool result,长任务跑到中段上下文可能是入场时数倍。旧架构入口检查够用是因为每轮路径短;Harness 下循环中途爆 context window 是必然事件。

**P0 方案(三件事,全部复用现有底座)**:

1. **循环内检查点**:每轮 `callLLM` 前检查。阈值 **0.7**(比入口的 0.8 低——一轮可能新增上万 token,等到 0.8 再压,本轮请求可能已超窗口被 API 拒)。预算计算必须包含 tool schemas 和输出预留:

```ts
usableInputBudget = contextWindow - reservedOutputTokens - safetyMargin
estimatedInput    = estimateTokens(system + toolSchemas) + estimateMessageTokens(messages)

if estimatedInput >= usableInputBudget * 0.7:
    messages = await compressForAgentLoop(messages)
```

- `toolSchemas`:本轮传给 LLM 的所有工具 schema 的 token 开销。Cyrene 工具越多,这部分越大,不能忽略。
- `reservedOutputTokens`:为 LLM 本轮回复预留的 token 预算(例如 4k / 8k,取决于 provider 和配置)。
- `safetyMargin`:固定安全余量(例如 500 tokens),防 estimate 误差和突发增长。
- 压缩失败沿用现有兜底(丢弃最旧)。
2. **配对安全切点(必须 P0 做对)**:现有 `conversation.slice(0, -keepCount)` 按条数硬切,可能把 `assistant.tool_calls` 和对应 `role:"tool"` 消息切到两侧——OpenAI / Anthropic 协议硬性要求配对,切断即整轮请求被拒。新切点规则:从保留边界往前退,直到落在"user 消息或无 tool_calls 的 assistant"上,保证 tool_call / tool result 永远同进同出。**配单测**:构造交错消息序列,断言切点两侧配对完整(压缩后报协议错会被误判为 provider bug,极难排查)。
3. **agent 导向压缩 prompt**:现有 prompt 是聊天导向("删除寒暄、过渡性语句"),会把工具返回的确定性事实(文件内容、命令输出)当对话历史总结掉。Harness 版 prompt 保留:用户目标、**已执行工具操作序列及确定性结果(路径 / 命令 / 退出码 / 错误信息)**、未完成 obligation 与 todo 状态。机制不动,prompt 不同;Chat 模式继续用老 prompt,互不影响。

**P1(精细化)**:
- `keepRecent` 按用户回合计(现按消息条数,agent loop 里一个用户 turn 可有 30+ 条)
- 压缩时把 `completionObligations` / `todoItems` 序列化注入摘要头部(它们本就在 system prompt 的 Agent State 层,压缩后靠该层恢复)

---

## 11. 不动的部分

以下保持不变,`CyreneHarness` 直接复用:

- `toolRegistry` + 工具注册
- `executeToolCall`(统一工具执行 wrapper)
- 权限系统
- CITA 上下文改写
- memory / worldbook / L0/L1 注入
- `WorkStreamEventBridge` 的纯 TS 逻辑(从 `two-phase-fc-loop.ts:283` 搬到新文件 `agent-loop-stream.ts`;注意 `chat-loop.ts` / `context-manager.ts` / `function-calling.ts` 也 import 其类型,搬迁时同步改)
- AG-UI 事件 + IPC
- 用户澄清链路(`user-choice.ts` + `IPC.CHOICE_RESOLVE` + `cyrene.choice` 事件,§9.4)
- 上下文压缩底座(`context-manager.ts`,§10.6)
- `structured-output/runner.ts`(legacy 化后保留,memory / CITA / social-context 依赖,§2.2)
- Chat 模式(`runChatLoop`,完全不动)
- Code 模式(`runCodeRequest` + Cline,完全不动)
- 子 agent(`subagents/`)
- 所有工具实现(fs-tools / document-tools / built-in-tools 等)

---

## 12. P0 / P1 / P2 分阶段

### P0(第一版,本次设计稿范围)

**架构层**:
- CyreneHarness 主体:while 循环 + function calling + content 流式
- 删除 LangGraph 路径(Action Gate + Native FC + 10 个图节点)
- 删除 SOUL 独立阶段(含 `ask-soul.ts`)
- 删除 TwoPhaseFC legacy 循环(含 `ask_user_choice` 工具、`task-router.ts`)
- structured-output 保留 runner 并强制 legacy 后端,删除 langchain-invoker + LangChain 6 个依赖
- task-plan 删除前置:迁移 subagents 引用的共享类型
- 备份旧文件到 `E:\Cyrene-Harness-Migration-Backup\2026-08-08\`(用 `mv`,跟 git 历史双保险)

**上下文与输出预算(v2 提前自 P1)**:
- Mid-loop compaction:循环内每轮 `callLLM` 前检查,阈值 0.7(§10.6)
- 配对安全压缩切点 + agent 导向压缩 prompt(Chat 的 prompt 不动)
- 工具输出双级截断:软 2000(preview + 可选 `fullOutputRef`)+ 硬熔断 8000,挂在 `executeToolCall` 出口;`ToolDefinition` 增 `maxOutputChars` / `outputStorage`(§5.7)

**人设层(两套独立)**:
- Chat 模式:保持现状,完整人设 + Style + sampling parameters(Chat 不动)
- CyreneHarness:用 `prompts/cyrene_harness.md`(用户自己写),Loop 内全程同一份

**Todo State(替代 LangGraph Plan)**:
- 删除 `TaskPlan` / Planner / Verify / Replan 概念
- 新增 `update_todo` 工具,模型自己维护
- Todo State 是 Agent State 一部分,UI 通过 AG-UI 事件订阅显示
- P0 不做持久化

**错误分类 + 重试**:
- 10 个 Error Category(not_found / permission_denied / invalid_arguments / timeout / rate_limited / transient / **unknown** / semantic_failure / partial_failure / fatal)
- 工具 Side-effect Semantics(read_only / idempotent_mutation / non_idempotent_side_effect)
- `(Error Category + Side-effect Semantics) → Retry Decision`

**完成策略**:
- Tool 在 `ToolDefinition` 上声明 `completionSemantics`(只声明,不写验证流程)
- Harness Runtime 的 `checkCompletion()` 统一执行验证策略
- 不重新搞 planVerify 节点

**Ask User**:
- 重新定位为信息补全工具(不是路由决策)
- Schema:多题 + 每题选项 + "其他"自定义
- 用户回答作为 `ask_user` tool_call 的 Tool Result 返回模型;模型拿到回答后**重新自主决策**,不绑定任何后续 pending action

**生命周期**:
- maxRounds / 超时 / 取消 / 流式(content + tool_call)

**Chat 模式**:**完全不在 P0 范围内**。Chat Loop / Chat 人设 / Style / sampling parameters 全部保持现状。

### P1(可靠 Agent)

```
Session persistence
Checkpoint / resume
Todo State 持久化(跟 Checkpoint 一起)
Context compaction 精细化(按用户回合保留;obligation / todo 注入摘要)
分工具策略化截断(read_file 头尾保留 / grep 限条数 / shell 保留 stderr 尾)
ExecutionLedger 持久化
Ask 完整的 suspend / resume 实现(目前 P0 是简版)
Tool 级别 idempotency key(支持 non_idempotent_side_effect 工具的安全重试)
```

### P2(成熟 Agent Runtime)

```
SubAgent 并行
Git/worktree isolation
Goal mode
高级 context retrieval
跨设备持续运行
复杂 recovery
side-effect tracking
Goal 级别的 plan persistence(与 Todo 区分)
```

---

## 13. 预期效果

### 13.1 用户体感变化

| 维度 | 现在 | P0 之后(CyreneHarness) |
|---|---|---|
| 角色连续性 | 工程师干完活,SOUL 配音 | 昔涟一直在,边干边说 |
| 工具调用速度 | 每轮 2 次 LLM(Gate + FC) | 每轮 1 次 LLM |
| 失败处理 | 甩给模型"你看怎么办" | 代码分类 + 自动重试 + 结构化错误 |
| 模型自由度 | must_call 锁死 | 模型自己选工具 + 参数 |
| 进度可见性 | Action Gate 推理不可见 | 模型每轮 content 流式给用户 |

### 13.2 代码变化

| 维度 | 现在 | P0 之后 |
|---|---|---|
| Loop 代码量 | ~4100 行(langgraph-agent-loop 1497 + agent-graph 1093 + two-phase-fc-loop 842 + action-gate 521 + native-fc 120) | ~800-1500 行(CyreneHarness,含流式桥接 / 错误分类 / obligation / ask_user / 双时钟 / compaction 切点) |
| 依赖 | @langchain/langgraph + 5 个 langchain 包 | 全部去掉 |
| 调试 | 栈追踪指向 LangGraph 调度器 | 栈追踪指向真实代码 |
| 状态描述 | Annotation.Root + AgentGraphState 两份 | 一份 AgentState |
| 删除文件 | - | `langgraph-agent-loop.ts`, `agent-graph.ts`, `action-gate.ts`, `native-function-calling.ts`, `two-phase-fc-loop.ts`;`structured-output/langchain-invoker.ts` + `backend.ts` 的 langchain 分支;`runner.ts` **保留** |

---

## 14. 风险与取舍

### 14.1 去掉 Action Gate 的风险

Action Gate 当前提供三个 native FC 替代不了的东西:
1. `afterSuccess` 策略(工具成功后继续还是回复)
2. `ask_user` 作为一等决策
3. 工具 ID 预校验

**P0 的应对**:
1. `afterSuccess` -- 模型自己决定(不调工具就是回复,调工具就是继续)
2. `ask_user` -- 改为工具(§10)
3. 预校验 -- `executeToolCall` 里已有校验(`cyrene-agent.ts:225-231`),不需要 Action Gate

### 14.2 去掉 SOUL 独立阶段的风险

SOUL 当前提供:
1. 完整人设注入
2. 工具结果投影(`SOUL_EXECUTION_CONTEXT`)
3. 失败策略(`FAILURE_SOUL_POLICY`)
4. 代码验证上下文

**P0 的应对**:
1. 人设 -- Harness 全程同一份 `cyrene_harness.md`(§4)
2. 工具结果 -- 直接在 messages 里(role:tool),不需要投影
3. 失败策略 -- 错误分类器 + Runtime Feedback 通道(§6.5.1)+ 不要伪装成 `role: user`
4. 代码验证 -- prompt 提示 + completion obligation 数组(§6)

### 14.3 模型能力依赖

CyreneHarness 高度依赖模型的 function calling 能力。如果模型不够强(频繁选错工具 / 不会从错误中恢复),Loop 体验会差。

**应对**:先用当前项目已接入的模型(GLM / DeepSeek / Claude)测试。如果某些模型表现差,可以在 Runtime 层做模型适配(比如对较弱的模型加更多 prompt 指引)。这也是 GPT 反馈里提到的"Model × Harness 耦合优化"。

### 14.4 代码验证安全网弱化

当前 LangGraph 的 `requiredNextAction` 是硬强制(代码修改后必须验证)。CyreneHarness 改为 prompt 提示 + 完成策略兜底,从"硬强制"变成"软引导"。

**应对**:完成策略的检查规则要写得严(代码修改没跑验证 = 不让结束)。如果实际效果不好,P1 可以加回硬强制。

### 14.5 结构化输出 legacy 化的质量风险(v2)

删掉 langchain 后端后,所有结构化输出走 vendor adapter 的 legacy 实现:OpenAI 有原生 `json_schema`;**Anthropic 没有,legacy 走 prompt_json(prompt 工程约束)**。memory 抽取、CITA 理解的质量依赖这条路径,切换后需要实测回归。

**应对**:质量下降时强化 adapter 的 prompt 模板 / 解析修复(现有 runner 的 repair loop 可复用),不回引 langchain。环境变量 `CYRENE_LEGACY_STRUCTURED_OUTPUT=1` 已可提前强制 legacy,可用于切换前对比测试。

---

## 15. 已对齐事项(可施工)

以下 10 个问题你和 GPT 已经对齐,本设计稿按这些结论写:

1. ✅ 完成策略:Tool 声明语义,Runtime 执行验证策略(不再细分 A/B)
2. ✅ Todo State 替代 LangGraph Plan:模型自己维护,不是 UI 装饰
3. ✅ 错误分类 10 个 category(含 `unknown`) + 工具 side-effect semantics 共同决定 retry
4. ✅ Ask User 重新定位为信息补全机制,不走 pending tool
5. ✅ CyreneHarness 模块边界:对外单入口,内部按职责拆分,数量施工稿定
6. ✅ `prompts/cyrene_harness.md` 路径 OK,内容由用户自己写(不机械删 soul.md)
7. ✅ 人设两套:Chat Persona + Harness Persona,不做动态切换
8. ✅ 旧代码备份路径 `E:\Cyrene-Harness-Migration-Backup\2026-08-08\`,用 `mv`(Git 已经保留历史)
9. ✅ 旧 Plan 全部退出:不留 deprecated,不留 fallback
10. ✅ Chat 模式完全不动:Loop / 人设 / Style / sampling parameters 全部保持现状
11. ✅(v2)structured-output 保留 runner 强制 legacy;LangChain 6 依赖全删,结构化输出自己按 OpenAI / Anthropic 官方文档适配
12. ✅(v2)ask_user 复用现有澄清链路(user-choice + CHOICE_RESOLVE + cyrene.choice),不开新 IPC;ask_user / update_todo 均为 Harness 内置工具,不进通用 registry、不走 executeToolCall、对子代理不可见
13. ✅(v2)todo 事件定名 `cyrene.todo`(单数);`cyrene.taskPlan` 删除,`cyrene.todos`(复数,用户待办)不动
14. ✅(v2)mid-loop compaction 提前到 P0:循环内 0.7 阈值检查 + 配对安全切点 + agent 导向 prompt
15. ✅(v2)工具输出双级截断提前到 P0:软 2000 + 硬熔断 8000,挂 executeToolCall 出口
16. ✅(v3)每轮 assistant response 必须写回 messages,即使 content 被 UI discard
17. ✅(v3)`unknown non_idempotent side-effect` 写入 `AgentState.uncertainEffects`,阻止伪完成与重复副作用
18. ✅(v3)Harness 内置工具统一 dispatch:不进 registry,`executeHarnessBuiltin` 与 `executeToolCall` 分路
19. ✅(v3)同轮多 tool call 遇 fatal / unknown non-idempotent 中断,剩余返回 `not_executed`
20. ✅(v3)compaction token budget 计入 tool schemas + reserved output + safety margin
21. ✅(v3)工具截断 `fullOutputRef` 语义明确:只读工具可引用,副作用工具禁止建议重跑
22. ✅(v3)Harness 与 AG-UI 事件桥接复用现有 `agui-bridge.ts` 的 `sendCustomEvent`,不开新通道

## 16. 仍待对齐的开放问题(进施工稿前需要解决)

> v2 已拍板(原 #1):**事件名 `cyrene.todo`(单数)**。`cyrene.taskPlan` 随旧体系删;`cyrene.todos`(复数)是用户待办系统,不动。

> v2 已拍板(原 #2):**ask_user 复用现有澄清链路**,不开新 IPC:`requestUserClarification` + `IPC.CHOICE_RESOLVE` + `cyrene.choice`(§9.4)。

> v3 已拍板(原 #2):**Harness 与 AG-UI 事件桥接复用现有 `agui-bridge.ts` 的 `sendCustomEvent`**,不开新通道。`cyrene.todo` / `cyrene.choice` 均通过现有桥接发送。

1. **`ToolDefinition` 类型扩展的兼容**:现有 `tool-registry.ts` 已有 `effectKind`(5 值:read / mutation / verification / external_side_effect / unknown)+ `effectResolver` + `verificationPolicy` + `completionEvidence`,`sideEffect` / `completionSemantics` 是语义升级而非从零新增。施工前盘点现有工具声明覆盖率,写机械迁移映射(read → read_only + always_satisfied 等),并定未声明老工具的默认值。

> 已经拍板:**ExecutionLedger P0 接入并复用**(`execution-ledger.ts`),不重构;Persistence / idempotency key / crash recovery 推 P1。注意 ledger 当前只传给 LangGraph 路径(`cyrene-agent.ts:391-400`),Harness 路径要显式传入。

> 上一个版本里 §17 #1 提到的 `cyrene_harness.md` 怎么注入,已经由 §4.5 "System Prompt 分层注入" 完整决定了 —— Persona 只承担人格,Runtime Policy 单独一层。所以不再列为开放问题。

(以上 1 条是工程细节,不影响 P0 架构选型。施工稿生成时,把它做成 todo。)

---

## 17. 不在本设计稿范围内的事

### 设计 / 工程

- 具体文件改动清单(施工稿)
- 代码实现步骤(施工稿)
- 测试计划(施工稿)
- 迁移路径(施工稿)
- CyreneHarness 内部具体文件拆分数量(§5/§9 已经做了 §Q5 的约束:单入口 + 低耦合 + 高内聚,具体几个文件施工稿决定)
- mode 字符串(原 work / daily / learn)在 UI / ChatSession 上怎么映射到 CyreneHarness(等设计对齐后再细化)

### Chat 模式(明确不在 P0 重构范围)

- Chat Loop / Chat 人设 / Style 功能 / Sampling parameters 全部保持现状
- CyreneHarness 不顺手影响 Chat

### 后续阶段

- memory.json 原子写入改造(P2)
- fs-tools / document-tools 原子写入改造(P2)
- Goal mode(P2)
- SubAgent 并行(P2)

---

## 18. 参考依据

- Cyrene-Agent 现状报告(桌面 `Cyrene-Agent-现状报告.md`)
- GPT 反馈:连续 Agent Loop + Harness 分层 + 确定性失败分类
- 代码取证:LangGraph 耦合度审计 / SOUL 接缝审计 / 三 Loop 对照
- 成熟项目参考:Claude Code Agent Loop / Codex harness / ZCode Goal Mode / LangGraph Plan-and-Execute prebuilt
- v2 评估:`docs/design/2026-08-09-cyreneHarness-design-review.md`(代码事实核验 + 依赖盲区取证)
