/**
 * CyreneHarness 核心循环
 *
 * 连续 Agent Loop：while 循环 + function calling + content 流式。
 *
 * 关键设计约束：
 * - 每轮 assistant response 必须写回 messages（否则模型看不到自己上一轮的回复，多轮工具调用会断链）
 * - uncertainEffects 拦截重复副作用
 * - Harness 内置工具统一 dispatch
 * - 同轮多 tool call 遇 fatal/unknown 中断
 * - mid-loop compaction 每轮检查
 * - 工具输出双级截断
 *
 * 文件结构（自上而下）：
 * 1. runCyreneHarness   — 主入口与主循环骨架
 * 2. 运行准备           — createRun / materializeInitialContext / buildRoundPromptLayers
 * 3. 每轮 LLM 阶段      — compactIfNeeded / emitContextUsage / emitCacheDiagnostic / callRoundLLM
 * 4. 结算出口           — checkpoint / settleRun / cancelledResult / finishRun / buildResult
 *
 * 拆分出去的实现细节（按需深入）：
 * - harness-llm.ts           — 供应商调用：流式/非流式兜底、用量记账、压缩摘要请求
 * - tool-round.ts            — 工具执行轮：ask_user 排他、调度重试、按序提交
 * - harness-observability.ts — 上下文容量快照与缓存结构诊断（调用点仍在主循环）
 */

import type {
  ChatMessage,
  ChatResponse,
  ToolSpec,
} from "../vendors/types";
import type {
  AgentState,
  HarnessCacheState,
  HarnessConfig,
  HarnessInput,
  HarnessResult,
  RunAdjustmentMessage,
} from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";
import { INITIAL_HARNESS_CACHE_STATE, DEFAULT_HARNESS_CONFIG } from "./types";
import { getHarnessBuiltinToolSpecs } from "./builtin-tools";
import type { ToolDispatchContext } from "./tool-dispatcher";
import { computeTokenBudget, compressForAgentLoop, type TokenBudget } from "./compaction";
import { emitContextUsage, emitCacheDiagnostic } from "./harness-observability";
import { StreamController } from "./stream-controller";
import { TimeoutClock } from "./timeout-clock";
import { buildCurrentTodoNotebookContext } from "./todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "./internal-transcript";
import { callLLM, summarizeHistory } from "./harness-llm";
import { ChatTimeStreamPrefixFilter } from "../../chat-time-stream-filter";
import { runToolRound, type ToolRoundOutcome } from "./tool-round";
import {
  buildStableSystemPrefix,
  type PromptLayers,
} from "../prompt-layers";

const LOG_PREFIX = "[CyreneHarness]";

/**
 * 单次 harness 运行的可变上下文。
 * 主循环与各阶段 helper 共享读写，替代闭包捕获，让每个阶段都能抽成独立函数。
 * tool-round.ts 等实现文件通过 type-only import 引用（无运行时循环依赖）。
 */
export interface HarnessRun {
  input: HarnessInput;
  config: HarnessConfig;
  state: AgentState;
  clock: TimeoutClock;
  streamController: StreamController;
  /** 模型可见的完整工具清单（registry + harness built-in）。
   *  不变量：run 期间固定不变（对前缀缓存友好）；工具集合变化 = 运行边界变化，应开启新 run。 */
  allToolSpecs: ToolSpec[];
  messages: ChatMessage[];
  toolOutputs: ToolOutputRef[];
  cache: HarnessCacheState;
  /** 已完成的工具执行轮数（最终无工具的回复轮不计入；LLM 请求轮数 = rounds + 最终回复轮）。 */
  rounds: number;
  checkpointFailure?: string;
  /** ask_user 等交互内置工具的 dispatch 上下文。 */
  askDispatchContext: ToolDispatchContext;
  /** 普通工具的 dispatch 上下文（延迟输出持久化，重试收敛后统一落盘）。 */
  toolDispatchContext: ToolDispatchContext;
  /** 工具调用开始时刻（toolCallId → epoch ms），供完成事件计算耗时；提交后即移除。 */
  toolCallStartedAt: Map<string, number>;
  /** 当前轮 assistant 的轨迹条目 ID（appendAssistant 返回；工具结果提交的锚点）。 */
  currentAssistantEntryId?: string;
}

// ═══ 主入口 ═══════════════════════════════════════════════

/**
 * 运行 CyreneHarness。
 *
 * 主循环每一轮：压缩检查 → LLM 调用 → 工具执行 或 最终回复。
 */
export async function runCyreneHarness(input: HarnessInput): Promise<HarnessResult> {
  const run = createRun(input);
  run.clock.startActive();
  materializeInitialContext(run);

  while (!run.clock.isExecutionTimeout()) {
    if (run.checkpointFailure) {
      return finishRun(run, `执行状态保存失败：${run.checkpointFailure}`, true, "error");
    }
    // 用户取消：finalAnswer 保持为空，不生成 "最终回复被取消。" 之类的占位文案。
    if (input.signal?.aborted) return cancelledResult(run);
    // 工具轮上限在下一次模型请求前检查：避免超限后再产生一次 LLM 调用。
    if (run.config.maxRounds > 0 && run.rounds >= run.config.maxRounds) {
      const finalAnswer = run.streamController.getBuffered() || buildMaxRoundsReply(run.state, run.config.maxRounds);
      input.onEvent?.({ type: "final_answer", content: finalAnswer });
      return finishRun(run, finalAnswer, true, "max_rounds");
    }

    // ── 插话注入（下一次模型请求前）──
    // 工具批次或上一轮模型请求已结束：把标记插入当前运行的待发消息双写
    // （权威轨迹 → 聊天历史）后按入队顺序追加进上下文。无标记时保持同步直达，
    // 不引入 await 挂起点（与压缩的门控方式一致）。
    const adjustmentPoll = input.pollRunAdjustments?.();
    if (adjustmentPoll) {
      let adjustments: RunAdjustmentMessage[];
      try {
        adjustments = await adjustmentPoll;
      } catch (error) {
        // 双写任一步失败（fail-closed）：pending 保留，终止运行，不假装注入成功
        return finishRun(run, `插话提交失败：${errorMessage(error)}`, true, "error");
      }
      if (adjustments.length > 0) {
        for (const adjustment of adjustments) {
          run.messages.push({ role: "user", content: adjustment.rawContent });
        }
        checkpoint(run);
        if (run.checkpointFailure) {
          return finishRun(run, `执行状态保存失败：${run.checkpointFailure}`, true, "error");
        }
      }
    }

    const promptLayers = buildRoundPromptLayers(input);
    const roundId = `round-${run.rounds}`;
    input.onEvent?.({ type: "round_start", roundId });

    // ── Mid-loop compaction（循环中途压缩）──
    // 注意：从 run 启动到首次 LLM fetch 之间不得引入 await 挂起点
    //（调用方/测试依赖 fetch 同步发起），因此只在真正需要压缩时才 await。
    const compaction = compactIfNeeded(run, promptLayers);
    if (compaction) {
      await compaction;
      // 压缩已替换模型历史：checkpoint 失败 = 新 epoch 未持久化。
      // 此时继续请求模型，崩溃恢复会拿到旧历史 + 旧周期，违反缓存周期不变量 → 立即熔断。
      if (run.checkpointFailure) {
        return finishRun(run, `执行状态保存失败：${run.checkpointFailure}`, true, "error");
      }
    }

    // ── 上下文容量快照 + 缓存诊断（压缩后、请求前）──
    emitContextUsage(run, "preRequest");
    emitCacheDiagnostic(run, promptLayers);

    // ── callLLM ──
    let response: ChatResponse;
    try {
      response = await callRoundLLM(run, promptLayers, roundId);
    } catch (err) {
      // signal abort 属于用户取消：按 cancelled 结算，不归类为 error。
      if (input.signal?.aborted) return cancelledResult(run);
      // 失败摘要：模型名 / 请求地址 / 错误码置顶，堆栈跟在后面，定位不用翻设置。
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as { code?: string }).code ?? "无错误码";
      console.error(
        `${LOG_PREFIX} LLM call failed:`,
        `\n  model id: ${input.vendorConfig.model}`,
        `\n  baseUrl: ${input.vendorConfig.baseUrl}`,
        `\n  error: ${errCode} ${errorMsg}`,
        err,
      );
      return finishRun(run, `抱歉，模型调用失败：${errorMsg}`, true, "error");
    }

    // ── Assistant response 必须写回 transcript（否则模型下一轮看不到自己上一轮的回复）──
    const assistantMessage = toAssistantMessage(response);
    run.messages.push(assistantMessage);
    try {
      // canonical assistant 先于任何工具 dispatch 落盘（fail-closed）：
      // 写失败 = 本轮协议断裂，直接终态 error，不得带着缺失的声明继续执行。
      run.currentAssistantEntryId = await input.transcriptSink?.appendAssistant({
        message: assistantMessage,
        roundId,
      });
    } catch (error) {
      return finishRun(run, `会话轨迹保存失败：${errorMessage(error)}`, true, "error");
    }
    if (response.text) {
      run.streamController.bufferProgressContent(response.text);
    }

    // ── 截断可见化：finishReason=length 表示命中输出上限 ──
    // 各协议统一映射为 "length"（anthropic-normalizer / responses-normalizer / openai 透传）。
    if (response.finishReason === "length") {
      console.warn(`${LOG_PREFIX} round ${run.rounds} finishReason=length (输出命中上限被截断)`);
    }

    // ── Tool Call Processing ──
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length > 0) {
      let outcome: ToolRoundOutcome;
      try {
        outcome = await runToolRound(run, toolCalls);
      } catch (error) {
        // 调度器已闭合 transcript（合成失败结果 + not_executed）后上抛的
        // 非取消错误：统一走 finishRun 终态结算，不得冲出 runCyreneHarness。
        if (input.signal?.aborted) return cancelledResult(run);
        console.error(`${LOG_PREFIX} tool round failed:`, error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return finishRun(run, `工具执行异常：${errorMsg}`, true, "error");
      }
      if (outcome === "cancelled") return cancelledResult(run);
      input.onEvent?.({ type: "round_end", roundId });
      run.rounds++;
      checkpoint(run);
      continue;
    }

    // ── Model Wants to End（模型不再调用工具 = 主动结束当前 turn）──
    // 不再检查 completionObligations 或 uncertainEffects：模型已选择结束当前 turn。
    // uncertainEffects 仍作为执行期安全状态保留（阻止相同危险副作用自动重放），
    // 但不参与 final settlement。
    // 截断可见化：最终轮命中长度上限时在回复尾部追加提示，不再静默。
    const truncatedSuffix = response.finishReason === "length"
      ? "\n\n⚠️ 模型输出达到长度上限，以上回复可能不完整。"
      : "";
    // ── 最终结算前的插话检查 ──
    // 模型准备结束当前运行：若仍有待插入的调整消息，本轮回复转为中间过程
    // （progress_text），插话双写（权威轨迹 → 聊天历史）进入上下文后继续循环处理，
    // 不在结算前丢弃插话。
    let endAdjustments: RunAdjustmentMessage[];
    try {
      endAdjustments = await input.pollRunAdjustments?.() ?? [];
    } catch (error) {
      // 双写任一步失败（fail-closed）：pending 保留，终止运行，不假装注入成功
      return finishRun(run, `插话提交失败：${errorMessage(error)}`, true, "error");
    }
    if (endAdjustments.length > 0) {
      const intermediate = run.streamController.commitProgressBuffer() + truncatedSuffix;
      input.onEvent?.({ type: "round_end", roundId });
      if (intermediate) {
        input.onEvent?.({ type: "progress_text", content: intermediate });
      }
      for (const adjustment of endAdjustments) {
        run.messages.push({ role: "user", content: adjustment.rawContent });
      }
      // 本轮模型已产出回复且运行未结束：按工具轮口径推进轮次，
      // 让下一轮拿到新 roundId，轮次上限也能正确计数
      run.rounds++;
      checkpoint(run);
      if (run.checkpointFailure) {
        return finishRun(run, `执行状态保存失败：${run.checkpointFailure}`, true, "error");
      }
      continue;
    }
    const finalAnswer = run.streamController.commitProgressBuffer() + truncatedSuffix;
    input.onEvent?.({ type: "round_end", roundId });
    input.onEvent?.({ type: "final_answer", content: finalAnswer });
    return finishRun(run, finalAnswer, false, undefined);
  }

  // ── 兜底：显式配置的总超时 ──
  const finalAnswer = run.streamController.getBuffered() || buildTimeoutReply(run.state);
  input.onEvent?.({ type: "final_answer", content: finalAnswer });
  return finishRun(run, finalAnswer, true, "timeout");
}

// ═══ 运行准备 ═════════════════════════════════════════════

/** 初始化单次运行：合并配置、深拷贝状态、构建工具清单与 dispatch 上下文。 */
function createRun(input: HarnessInput): HarnessRun {
  const config: HarnessConfig = { ...DEFAULT_HARNESS_CONFIG, ...input.config };
  const state: AgentState = input.initialState
    ? deepClone(input.initialState)
    : { todoItems: [], uncertainEffects: [] };

  // 构建 tools 清单：registry 注册的工具 + harness 内置工具
  const registryToolSpecs: ToolSpec[] = input.tools.map((t) => ({
    name: t.id,
    description: t.description,
    parameters: {
      type: "object" as const,
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
  const allToolSpecs: ToolSpec[] = [
    ...registryToolSpecs,
    ...getHarnessBuiltinToolSpecs({
      includeInteractive: input.includeInteractiveTools,
      includeTask: Boolean(input.taskExecutor),
      planState: input.planState,
    }),
  ];

  const askDispatchContext: ToolDispatchContext = {
    state,
    tools: input.tools,
    onEvent: input.onEvent,
    requestUserClarification: input.requestUserClarification,
    includeInteractiveTools: input.includeInteractiveTools,
    toolOutputStore: input.toolOutputStore,
  };

  return {
    input,
    config,
    state,
    clock: new TimeoutClock(config.totalTimeoutMs, config.userWaitTimeoutMs),
    streamController: new StreamController(),
    allToolSpecs,
    messages: [...input.messages],
    toolOutputs: [],
    cache: input.initialCache ? { ...input.initialCache } : { ...INITIAL_HARNESS_CACHE_STATE },
    rounds: 0,
    askDispatchContext,
    toolDispatchContext: {
      ...askDispatchContext,
      checkPermission: input.checkPermission,
      toolContext: input.toolContext,
      executionLedger: input.executionLedger,
      taskExecutor: input.taskExecutor,
      deferOutputPersistence: true,
    },
    toolCallStartedAt: new Map(),
  };
}

/**
 * 把启动时已知的动态事实一次性物化为 transcript 尾部。
 * 每轮临时拼接 runtimeContext 会使上一请求不再是下一请求的前缀，破坏增量缓存。
 */
function materializeInitialContext(run: HarnessRun): void {
  const { input } = run;
  const parts = [
    input.initialInternalContext?.content,
    input.promptLayers?.runtimeContext,
    run.state.todoItems.length > 0 ? buildCurrentTodoNotebookContext(run.state.todoItems) : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  if (parts.length === 0) return;

  const latestRevision = run.messages.reduce(
    (current, message) => Math.max(current, message.internal?.revision ?? 0),
    0,
  );
  run.messages = appendInternalTranscriptMessage(run.messages, createInternalTranscriptMessage({
    kind: input.initialInternalContext?.kind ?? "run_start",
    revision: latestRevision + 1,
    runId: input.runId ?? "harness-run",
    content: parts.join("\n\n---\n\n"),
  }));
}

/** 每轮的提示词分层：优先 promptLayers，兼容旧调用方的扁平 systemPrompt。 */
function buildRoundPromptLayers(input: HarnessInput): PromptLayers {
  return {
    stablePrefix: input.promptLayers?.stablePrefix ?? input.systemPrompt,
    ...(input.promptLayers?.sessionPrefix ? { sessionPrefix: input.promptLayers.sessionPrefix } : {}),
    ...(input.promptLayers?.mode ? { mode: input.promptLayers.mode } : {}),
  };
}

// ═══ 每轮 LLM 阶段 ═══════════════════════════════════════

/**
 * Mid-loop compaction（循环中途压缩）：估算超预算时压缩历史并推进缓存周期。
 * 压缩会替换模型历史，因此下一次请求前必须先持久化新 epoch
 * （主循环在压缩后检查 checkpointFailure，失败即熔断，不再发起模型请求）。
 *
 * 同步门控：未超预算时返回 undefined（不产生 await 挂起点），
 * 保证主循环到首次 LLM fetch 之间保持同步直达。
 */
function compactIfNeeded(run: HarnessRun, promptLayers: PromptLayers): Promise<void> | undefined {
  const { config } = run;
  const roundSystemPrompt = buildStableSystemPrefix(promptLayers);
  const budget = computeTokenBudget(
    roundSystemPrompt,
    run.allToolSpecs,
    run.messages,
    config.contextWindowTokens,
    config.reservedOutputTokens,
    config.safetyMarginTokens,
    config.compactionThreshold,
  );
  if (!budget.needsCompaction) return undefined;
  return runCompaction(run, roundSystemPrompt, budget);
}

async function runCompaction(run: HarnessRun, roundSystemPrompt: string, budget: TokenBudget): Promise<void> {
  const { input, config } = run;
  console.log(`${LOG_PREFIX} mid-loop compaction triggered (estimated=${budget.estimatedInput} budget=${budget.usableInputBudget})`);
  const messageCountBefore = run.messages.length;
  input.onCompactionLifecycle?.({ status: "started", messageCountBefore });
  const compactedMessages = await compressForAgentLoop({
    messages: run.messages,
    retainTokens: Math.floor(config.contextWindowTokens * config.compactionRetainRatio),
    summarize: (history) => summarizeHistory(
      input.vendorConfig,
      roundSystemPrompt,
      history,
      run.allToolSpecs,
      input.signal,
    ),
  });
  if (compactedMessages !== run.messages) {
    run.cache = { cacheEpoch: run.cache.cacheEpoch + 1, epochReason: "compaction" };
    run.messages = compactedMessages;
    input.onCompactionLifecycle?.({
      status: "committed",
      messageCountBefore,
      messageCountAfter: compactedMessages.length,
      cache: { ...run.cache },
    });
    checkpoint(run);
  } else {
    run.messages = compactedMessages;
  }
}

/** 发起一轮 LLM 调用，并桥接 reasoning 流式事件（start/delta/end 配对）。 */
async function callRoundLLM(run: HarnessRun, promptLayers: PromptLayers, roundId: string): Promise<ChatResponse> {
  const reasoningMessageId = `reasoning-${run.rounds}`;
  let reasoningStarted = false;
  const candidateFilter = new ChatTimeStreamPrefixFilter();
  try {
    return await callLLM(
      run.input.vendorConfig,
      promptLayers,
      run.messages,
      run.allToolSpecs,
      run.config,
      run.input.signal,
      (delta) => {
        if (!reasoningStarted) {
          reasoningStarted = true;
          run.input.onEvent?.({ type: "reasoning_start", messageId: reasoningMessageId });
        }
        run.input.onEvent?.({ type: "reasoning_delta", messageId: reasoningMessageId, delta });
      },
      (delta) => {
        const visibleDelta = candidateFilter.push(delta);
        if (visibleDelta) run.input.onEvent?.({ type: "candidate_text_delta", roundId, delta: visibleDelta });
      },
    );
  } finally {
    const tail = candidateFilter.finish();
    if (tail) run.input.onEvent?.({ type: "candidate_text_delta", roundId, delta: tail });
    if (reasoningStarted) {
      run.input.onEvent?.({ type: "reasoning_end", messageId: reasoningMessageId });
    }
  }
}

// ═══ 结算出口 ═════════════════════════════════════════════

/** 持久化可恢复子运行状态；失败记入 checkpointFailure，由主循环统一降级为 error。
 *  注意：messages/state 传的是活引用（不做 deepClone），克隆契约由消费方
 *  （run-store / task-session-store）在回调返回前同步完成。 */
function checkpoint(run: HarnessRun): void {
  try {
    run.input.onCheckpoint?.({
      messages: run.messages,
      state: run.state,
      toolOutputs: run.toolOutputs,
      rounds: run.rounds,
      cache: { ...run.cache },
      at: Date.now(),
    });
  } catch (error) {
    run.checkpointFailure = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} checkpoint failed:`, error);
  }
}

/** 终态统一结算（所有终态共享）：停表 → terminal 快照 → checkpoint。
 *  cancelled / error / timeout / success 一律经过此处，
 *  保证上下文环 UI 拿到终态数据、可恢复状态落盘。 */
function settleRun(run: HarnessRun): void {
  run.clock.stopActive();
  emitContextUsage(run, "terminal");
  checkpoint(run);
}

/** 用户取消的统一出口：settleRun 后返回空 finalAnswer 的 cancelled 结果。 */
function cancelledResult(run: HarnessRun): HarnessResult {
  settleRun(run);
  if (run.checkpointFailure) {
    return buildResult(`执行状态保存失败：${run.checkpointFailure}`, run.state, true, "error", run.rounds);
  }
  return {
    finalAnswer: "",
    finalState: run.state,
    terminated: true,
    terminateReason: "cancelled",
    terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
    rounds: run.rounds,
  };
}

/** 终态统一出口：settleRun → checkpointFailure 降级 error → 构造结果。 */
function finishRun(
  run: HarnessRun,
  finalAnswer: string,
  terminated: boolean,
  terminateReason: HarnessResult["terminateReason"],
): HarnessResult {
  settleRun(run);
  if (run.checkpointFailure) {
    return buildResult(`执行状态保存失败：${run.checkpointFailure}`, run.state, true, "error", run.rounds);
  }
  return buildResult(finalAnswer, run.state, terminated, terminateReason, run.rounds);
}

/** 总超时的兜底回复：带上待办与未知副作用清单，方便用户续跑。 */
function buildTimeoutReply(state: AgentState): string {
  const parts: string[] = [
    "抱歉，任务执行时间较长，已达到时间上限。",
    "",
    "中断原因：执行超时",
  ];

  if (state.todoItems.length > 0) {
    parts.push("", "当前待办状态：");
    for (const t of state.todoItems) {
      parts.push(`  [${t.status}] ${t.content}`);
    }
  }

  if (state.uncertainEffects.length > 0) {
    parts.push("", "⚠️ 以下副作用结果未知：");
    for (const e of state.uncertainEffects) {
      parts.push(`  - ${e.toolName}: ${e.message}`);
    }
  }

  return parts.join("\n");
}

/** 工具轮数到达上限时的确定性兜底回复；不得为总结而追加模型调用。 */
function buildMaxRoundsReply(state: AgentState, maxRounds: number): string {
  const parts: string[] = [
    `任务已达到工具轮次上限（${maxRounds}），已停止继续执行。`,
    "",
    "中断原因：工具轮次上限",
  ];

  if (state.todoItems.length > 0) {
    parts.push("", "当前待办状态：");
    for (const t of state.todoItems) {
      parts.push(`  [${t.status}] ${t.content}`);
    }
  }

  if (state.uncertainEffects.length > 0) {
    parts.push("", "⚠️ 以下副作用结果未知：");
    for (const e of state.uncertainEffects) {
      parts.push(`  - ${e.toolName}: ${e.message}`);
    }
  }

  return parts.join("\n");
}

function buildResult(
  finalAnswer: string,
  state: AgentState,
  terminated: boolean,
  terminateReason: HarnessResult["terminateReason"],
  rounds: number,
): HarnessResult {
  return {
    finalAnswer,
    finalState: state,
    terminated,
    terminateReason,
    rounds,
  };
}

// ═══ 小工具 ═══════════════════════════════════════════════

/** 把模型回复规约为 transcript 消息（适配器未提供时兜底构造）。 */
function toAssistantMessage(response: ChatResponse): ChatMessage {
  return response.assistantMessage ?? {
    role: "assistant",
    content: response.text,
    ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
  };
}

/** 统一错误消息提取（轨迹/工具失败文案用）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 防御外部共享引用：initialState 的调用方在 run 期间可能复用/修改原对象。 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
