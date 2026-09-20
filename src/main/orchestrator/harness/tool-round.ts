/**
 * Harness 工具执行轮
 *
 * 职责：模型发起 tool call 后的一轮执行——
 * - ask_user / confirm_uncertain_effect 排他为先：交互工具与普通工具互斥，一次只优先处理首个询问，
 *   其余调用一律返回 not_executed，交还给模型基于答案重新决策（confirm_uncertain_effect 是 v3 新增的
 *   未知副作用解除点，排他语义与 ask_user 一致）
 * - 普通工具调度、执行、重试与按序提交：安全读操作可滚动并行，独占调用前后形成串行屏障，
 *   模型可见结果始终按原始 tool-call 顺序写回（并行执行是有意的演化）
 * - uncertainEffects 记录与 fatal / unknown 中断：结果不确定的非幂等副作用要显式入账并停止本轮后续执行，
 *   防止"假装完成"和"副作用被重复执行"
 *
 * 通过 HarnessRun 上下文读写运行状态；
 * 对 cyrene-harness.ts 只有 type-only import（编译后消失，无运行时循环依赖）。
 */

import type { ChatMessage, ToolCall } from "../vendors/types";
import type { ToolCallResult } from "../types";
import { TranscriptWriteError } from "../transcript-sink";
import type { HarnessToolFinishedEvent, SideEffectKind, ToolCallOutcome, ToolObservation } from "./types";
import type { ToolRiskLevel } from "../../permission-policy";
import { parseToolCallArgs, toolCallFingerprint } from "./types";
import { dispatchToolCall, persistToolDispatchResult, type ToolDispatchResult } from "./tool-dispatcher";
import { classifyToolExecutionMode, scheduleToolCalls, type ToolCallScheduleResult, type ToolScheduleCommitDecision } from "./tool-call-scheduler";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tools/registry/tool-evidence";
import { classifyToolResultError } from "./error-classifier";
import { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";
import { isToolBreakerTripped, nextToolFailureStreak, toolBreakerMessage } from "./tool-breaker";
import { isCancellationError, raceWithSignal } from "../../abort-utils";
import type { HarnessRun } from "./cyrene-harness";

/** 工具轮结果：completed = 结果已全部写回，继续下一轮；cancelled = 用户取消。 */
export type ToolRoundOutcome = "completed" | "cancelled";

/** 从工具注册表读取工具注册时声明的风险级；未注册（如 harness 内置工具）视为 safe。 */
function toolRiskOf(run: HarnessRun, toolId: string): ToolRiskLevel {
  return run.input.tools.find((t) => t.id === toolId)?.risk ?? "safe";
}

/** 发布工具完成观察事件：只读稳定元数据，未注入回调时零开销。 */
function notifyToolFinished(
  run: HarnessRun,
  call: Pick<ToolCall, "id" | "name">,
  status: HarnessToolFinishedEvent["status"],
  startedAt?: number,
): void {
  run.input.onToolFinished?.({
    toolId: call.name,
    toolCallId: call.id,
    runId: run.input.runId ?? run.input.toolContext?.runId ?? "",
    status,
    risk: toolRiskOf(run, call.name),
    ...(startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
  });
}

/**
 * 执行一轮工具调用。
 *
 * - 交互工具（ask_user / confirm_uncertain_effect）与其他工具互斥：
 *   只执行首个 ask，其余调用统一返回 not_executed，等模型重新决策；
 * - 普通工具交给调度器：安全读操作滚动并行，独占调用前后形成串行屏障，
 *   模型可见结果始终按原始 tool-call 顺序写回。
 */
export async function runToolRound(run: HarnessRun, toolCalls: ToolCall[]): Promise<ToolRoundOutcome> {
  const { input } = run;
  const exclusiveToolNames = input.includeInteractiveTools === false
    ? new Set<string>()
    : new Set(["ask_user", "confirm_uncertain_effect"]);
  const askCalls = toolCalls.filter((c) => exclusiveToolNames.has(c.name));
  const otherCalls = toolCalls.filter((c) => !exclusiveToolNames.has(c.name));

  // ── ask_user 排他分支 ──
  if (askCalls.length > 0) {
    input.onEvent?.({ type: "candidate_text_discard", roundId: `round-${run.rounds}` });
    try {
      await runAskUserRound(run, askCalls, otherCalls);
    } catch (error) {
      // ask_user 等待期间 abort → cancelled
      if (isCancellationError(error, input.signal)) return "cancelled";
      throw error;
    }
    // ask_user 后丢弃 progress buffer，等待模型重新决策
    run.streamController.discardProgressBuffer();
    return "completed";
  }

  // ── 普通工具循环 ──
  // flush buffered content 为 progress message
  const progressContent = run.streamController.flushProgressBufferAsProgress();
  if (progressContent) {
    input.onEvent?.({ type: "progress_text", content: progressContent });
  }

  let schedule: ToolCallScheduleResult;
  try {
    schedule = await scheduleToolCalls({
      calls: otherCalls,
      maxParallel: run.config.maxParallelToolCalls,
      signal: input.signal,
      classify: (call) => classifyToolExecutionMode(call, input.tools),
      execute: ({ call }) => executeToolCallWithRetry(run, call),
      commit: ({ call }, result) => commitToolResult(run, call, result),
      notExecuted: async ({ call }, reason): Promise<ToolDispatchResult> =>
        reason === "execution_error"
          ? {
              // execute 抛错（基础设施故障）：合成失败结果保证 transcript 闭合，
              // fatal 类别让模型看到诚实结果后自行决策。
              outcome: "failure",
              category: "fatal",
              tool: call.name,
              message: "工具执行异常，结果不可用（execution error）",
            }
          : {
              outcome: "not_executed",
              category: "runtime_safety",
              tool: call.name,
              message: reason,
            },
    });
  } catch (error) {
    if (isCancellationError(error, input.signal)) return "cancelled";
    throw error;
  }
  if (schedule.cancelled || input.signal?.aborted) return "cancelled";
  return "completed";
}

/**
 * 当前 assistant 的轨迹条目锚点；sink 存在时工具结果提交前必须已写入。
 */
function requireAssistantEntryId(run: HarnessRun): string {
  const entryId = run.currentAssistantEntryId;
  if (!entryId) throw new Error("TRANSCRIPT_ASSISTANT_ENTRY_MISSING");
  return entryId;
}

/**
 * 轨迹写失败后保留不确定副作用：非幂等工具已执行但结果未能持久化，
 * 效果状态未知，必须入账防止恢复后自动重放。
 */
function preserveUncertainEffectIfNeeded(run: HarnessRun, call: ToolCall, toolSideEffect?: SideEffectKind): void {
  if (toolSideEffect !== "non_idempotent_side_effect") return;
  const effectId = `${run.input.runId ?? run.input.toolContext?.runId ?? "unknown-run"}:${call.id}`;
  if (run.state.uncertainEffects.some((effect) => effect.id === effectId)) return;
  run.state.uncertainEffects.push({
    id: effectId,
    toolCallId: call.id,
    fingerprint: toolCallFingerprint(call.name, parseToolCallArgs(call)),
    toolName: call.name,
    message: "工具已执行，但结果持久化失败，效果状态未知",
  });
}

/**
 * 工具结果统一提交：先内存 push，再权威轨迹落盘，最后才发布生命周期终态。
 * committed 不得先于轨迹落盘（否则崩溃恢复看到"已提交"却无协议结果）。
 * 轨迹写失败：非幂等副作用先入 uncertainEffects，再以 TranscriptWriteError 上抛（fail-closed）。
 * toolSideEffect 按 registry 解析；合成 not_executed 未派发的场景走保守方向（仅双失败时出现）。
 */
async function commitToolResultMessage(
  run: HarnessRun,
  input: {
    call: ToolCall;
    message: ChatMessage;
    outcome: ToolCallOutcome;
    fullRef?: string;
    roundId: string;
    toolSideEffect?: SideEffectKind;
  },
): Promise<void> {
  run.messages.push(input.message);
  try {
    await run.input.transcriptSink?.appendToolResult({
      assistantEntryId: requireAssistantEntryId(run),
      message: input.message,
      outcome: input.outcome,
      ...(input.fullRef ? { fullRef: input.fullRef } : {}),
      roundId: input.roundId,
    });
  } catch (error) {
    preserveUncertainEffectIfNeeded(run, input.call, input.toolSideEffect);
    throw new TranscriptWriteError("tool_result", error);
  }
}

/**
 * 交互工具的排他轮：
 * 只执行首个 ask_user，其余 ask 与同轮普通工具调用统一返回 not_executed。
 */
async function runAskUserRound(
  run: HarnessRun,
  askCalls: ToolCall[],
  otherCalls: ToolCall[],
): Promise<void> {
  const { input } = run;
  const primaryAsk = askCalls[0];

  // 其余 ask_user 返回 not_executed
  for (const call of askCalls.slice(1)) {
    const message = toolResultMessage(call, {
      outcome: "not_executed",
      reason: "not_executed_due_to_another_ask",
    });
    await commitToolResultMessage(run, { call, message, outcome: "not_executed", roundId: `round-${run.rounds}` });
    input.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect: "read_only", status: "not_executed" });
    notifyToolFinished(run, call, "not_executed");
  }

  // 同轮普通工具调用返回 not_executed
  for (const call of otherCalls) {
    const message = toolResultMessage(call, {
      outcome: "not_executed",
      reason: "not_executed_due_to_clarification",
    });
    await commitToolResultMessage(run, { call, message, outcome: "not_executed", roundId: `round-${run.rounds}` });
    input.onToolLifecycle?.({
      toolCallId: call.id,
      toolName: call.name,
      toolSideEffect: resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call)),
      status: "not_executed",
    });
    notifyToolFinished(run, call, "not_executed");
  }

  // 执行 ask_user（等待期间不计入执行超时）
  // ask_user 同样走工具卡事件链：运行流里出现「询问用户」卡片，等待与问答结果可见
  input.onEvent?.({
    type: "tool_start",
    toolCallId: primaryAsk.id,
    toolName: primaryAsk.name,
    args: parseToolCallArgs(primaryAsk),
  });
  run.clock.startUserWait();
  input.onToolLifecycle?.({ toolCallId: primaryAsk.id, toolName: primaryAsk.name, toolSideEffect: "read_only", status: "started" });
  const askStartedAt = Date.now();
  let askResult: ToolDispatchResult;
  try {
    askResult = await raceWithSignal(
      dispatchToolCall(primaryAsk, run.askDispatchContext),
      input.signal,
    );
  } catch (error) {
    run.clock.stopUserWait();
    throw error;
  }
  run.clock.stopUserWait();

  // 问答结果发布到工具卡：message 已含「问题 → 回答」逐行预览
  input.onEvent?.({
    type: "tool_end",
    toolCallId: primaryAsk.id,
    outcome: askResult.outcome === "success" ? "success" : "failure",
    preview: askResult.message.slice(0, 200),
  });
  const askMessage = toolResultMessage(primaryAsk, askResult);
  await commitToolResultMessage(run, { call: primaryAsk, message: askMessage, outcome: askResult.outcome, roundId: `round-${run.rounds}` });
  input.onToolLifecycle?.({
    toolCallId: primaryAsk.id,
    toolName: primaryAsk.name,
    toolSideEffect: "read_only",
    status: askResult.outcome === "unknown" ? "unknown" : askResult.outcome === "not_executed" ? "not_executed" : "committed",
  });
  notifyToolFinished(run, primaryAsk, askResult.outcome, askStartedAt);
}

/**
 * 一次 logical invocation 的执行与重试，可在安全池内与其他调用重叠。
 * 输出持久化延后到重试收敛后的最终结果，确保一次调用只对应一条记录。
 */
async function executeToolCallWithRetry(run: HarnessRun, call: ToolCall): Promise<ToolDispatchResult> {
  // 熔断拦截：同工具连续失败达到阈值 → 不再 dispatch，直接合成 not_executed。
  // 拦截必须在 dispatch 之前；合成结果流回 commitToolResult 时 not_executed 不改计数，
  // 熔断不会被自己合成的结果解除。
  const streak = run.state.toolFailureStreaks?.[call.name];
  if (isToolBreakerTripped(streak)) {
    return {
      outcome: "not_executed",
      category: "runtime_safety",
      tool: call.name,
      message: toolBreakerMessage(call.name, streak ?? 0),
    };
  }

  const { input } = run;
  const toolSideEffect = resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));
  input.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect, status: "started" });
  run.toolCallStartedAt.set(call.id, Date.now());

  let result = await raceWithSignal(dispatchToolCall(call, run.toolDispatchContext), input.signal);
  if (result.outcome === "failure") {
    const category = result.category ?? classifyToolResultError(
      result.rawResult ?? { toolId: call.name, args: {}, output: "", status: "failed" } as ToolCallResult,
    );
    if (decideRetry(category, toolSideEffect) === "retry") {
      const retryParams = getRetryParams(category);
      for (let attempt = 0; attempt < retryParams.maxRetries; attempt++) {
        await sleepWithJitter(retryParams.backoffMs[attempt] ?? 1000, input.signal);
        result = await raceWithSignal(dispatchToolCall(call, run.toolDispatchContext), input.signal);
        if (result.outcome !== "failure") break;
      }
    }
  }
  return persistToolDispatchResult(call, result, run.toolDispatchContext);
}

/**
 * 按原始 tool-call 顺序提交模型可见结果。
 * result 不确定且副作用不可重放 → 记入 uncertainEffects 并 halt（防止"假装完成"与被重复执行）；
 * fatal 错误 → halt；其余 → continue。
 */
async function commitToolResult(
  run: HarnessRun,
  call: ToolCall,
  result: ToolDispatchResult,
): Promise<ToolScheduleCommitDecision> {
  const { input } = run;
  const toolSideEffect = result.toolSideEffect
    ?? resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));

  // 熔断计数（结果必经点）：failure 递增、success 清零、not_executed/unknown 不动
  const streaks = (run.state.toolFailureStreaks ??= {});
  const streak = nextToolFailureStreak(streaks[call.name], result.outcome);
  if (streak > 0) streaks[call.name] = streak;
  else delete streaks[call.name];

  if (result.toolOutputRef && !run.toolOutputs.some((entry) => entry.recordId === result.toolOutputRef?.recordId)) {
    run.toolOutputs.push(result.toolOutputRef);
  }
  input.onEvent?.({
    type: "tool_end",
    toolCallId: call.id,
    outcome: result.outcome,
    preview: (result.preview ?? result.message).slice(0, 200),
    // Diff Review 卡片证据走独立字段，不受 preview 截断影响
    changes: extractFileChangesFromOutput(result.output),
  });
  const message = toolResultMessage(call, result);
  await commitToolResultMessage(run, {
    call,
    message,
    outcome: result.outcome,
    ...(result.fullOutputRef ? { fullRef: result.fullOutputRef } : {}),
    roundId: `round-${run.rounds}`,
    toolSideEffect,
  });
  input.onToolLifecycle?.({
    toolCallId: call.id,
    toolName: call.name,
    toolSideEffect,
    status: result.outcome === "unknown"
      ? "unknown"
      : result.outcome === "not_executed" ? "not_executed" : "committed",
  });
  // 模型可见结果已确定：发布只读完成事件（正常执行有耗时；合成 not_executed 无）
  const startedAt = run.toolCallStartedAt.get(call.id);
  run.toolCallStartedAt.delete(call.id);
  notifyToolFinished(run, call, result.outcome, startedAt);

  if (result.outcome === "unknown" && toolSideEffect === "non_idempotent_side_effect") {
    const fingerprint = toolCallFingerprint(call.name, parseToolCallArgs(call));
    const effectId = `${input.toolContext?.runId ?? "unknown-run"}:${call.id}`;
    if (!run.state.uncertainEffects.some((effect) => effect.id === effectId)) {
      run.state.uncertainEffects.push({
        id: effectId,
        toolCallId: call.id,
        fingerprint,
        toolName: call.name,
        message: "副作用已发起，但 Runtime 无法确认是否生效",
      });
    }
    return "halt";
  }
  return result.category === "fatal" ? "halt" : "continue";
}

// ── 内部工具 ─────────────────────────────────────────────

/**
 * 构造模型可见的 tool result 消息。
 * 未截断的内置工具输出（例如 ask_user 的答案）仍是下一轮决策所需事实；
 * 长工具输出则必须只写入剪枝后的 preview，不能绕过截断再次注入模型上下文。
 */
function toolResultMessage(
  call: ToolCall,
  observation: ToolObservation | { outcome: string; reason: string },
): ChatMessage {
  const modelObservation = { ...observation } as Record<string, unknown>;
  if (modelObservation.truncated === true) {
    modelObservation.output = modelObservation.preview ?? modelObservation.message;
  }
  delete modelObservation.rawResult;
  delete modelObservation.toolOutputRef;
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(modelObservation),
  };
}
