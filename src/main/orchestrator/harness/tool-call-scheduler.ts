import type { ToolCall } from "../vendors/types";
import { resolveEffectKind, type ToolDefinition } from "../tools/registry/tool-registry";
import { parseToolCallArgs } from "./types";
import { resolveSideEffect } from "./side-effect-resolver";
import { isHarnessBuiltin } from "./builtin-tools";
import { READ_TOOL_RESULT_TOOL_ID } from "./tool-output/read-tool-result";

export type ToolExecutionMode = "parallel" | "exclusive";

export type ToolScheduleCommitDecision = "continue" | "halt";

/** 原始模型调用顺序的显式载体；完成顺序不得替代该顺序。 */
export interface ToolCallExecution {
  toolCallIndex: number;
  call: ToolCall;
}

export interface ToolCallSchedulerOptions<T> {
  calls: ToolCall[];
  maxParallel: number;
  signal?: AbortSignal;
  classify: (call: ToolCall) => ToolExecutionMode;
  execute: (execution: ToolCallExecution) => Promise<T>;
  commit: (execution: ToolCallExecution, result: T) => Promise<ToolScheduleCommitDecision>;
  notExecuted: (execution: ToolCallExecution, reason: string) => Promise<T>;
}

export interface ToolCallScheduleResult {
  cancelled: boolean;
  halted: boolean;
}

/**
 * 并发默认拒绝：普通工具必须显式声明当前参数安全，且只能是读操作。
 * Harness 内置工具中仅 read_tool_result 不会改父状态，允许并发。
 */
export function classifyToolExecutionMode(
  call: ToolCall,
  tools: ToolDefinition[],
): ToolExecutionMode {
  if (isHarnessBuiltin(call.name)) {
    return call.name === READ_TOOL_RESULT_TOOL_ID ? "parallel" : "exclusive";
  }

  const tool = tools.find((candidate) => candidate.id === call.name);
  if (!tool) return "exclusive";

  const args = parseToolCallArgs(call);
  try {
    const effectKind = resolveEffectKind(tool, args);
    if (effectKind !== "read" && effectKind !== "verification") return "exclusive";
    if (resolveSideEffect(tool, args) !== "read_only") return "exclusive";
  } catch {
    return "exclusive";
  }

  try {
    return tool.isConcurrencySafe?.(args) === true ? "parallel" : "exclusive";
  } catch {
    return "exclusive";
  }
}

/**
 * 按模型顺序调度工具：连续安全调用使用滚动池；独占调用前后形成屏障。
 * 完成顺序不影响 commit 顺序，因此模型消息和 Harness 状态可保持稳定。
 */
export async function scheduleToolCalls<T>(
  options: ToolCallSchedulerOptions<T>,
): Promise<ToolCallScheduleResult> {
  const maxParallel = Math.max(1, Math.trunc(options.maxParallel) || 1);
  let index = 0;
  const executionAt = (toolCallIndex: number): ToolCallExecution => ({
    toolCallIndex,
    call: options.calls[toolCallIndex]!,
  });

  const commitNotStarted = async (from: number, reason: string): Promise<void> => {
    for (let cursor = from; cursor < options.calls.length; cursor++) {
      const execution = executionAt(cursor);
      const result = await options.notExecuted(execution, reason);
      await options.commit(execution, result);
    }
  };

  while (index < options.calls.length) {
    if (options.signal?.aborted) {
      await commitNotStarted(index, "aborted_before_dispatch");
      return { cancelled: true, halted: false };
    }

    const first = options.calls[index];
    if (options.classify(first) === "exclusive") {
      const execution = executionAt(index);
      let result: T;
      try {
        result = await options.execute(execution);
      } catch (error) {
        if (options.signal?.aborted) {
          // 当前调用已进入 execute（runStore 已记 started、非幂等副作用可能已派发）：
          // 不能闭合为 not_executed，保留 started 交取消闭合写 unknown + uncertainEffects；
          // 只有 index 之后真正未派发的调用才记 aborted_before_dispatch。
          await commitNotStarted(index + 1, "aborted_before_dispatch");
          return { cancelled: true, halted: false };
        }
        // 与并行组一致：execute 抛错的槽位以合成失败结果提交（transcript 闭合），
        // 其余未执行调用补 not_executed，再把错误上抛给工具轮统一转 error 终态。
        const synthetic = await options.notExecuted(execution, "execution_error");
        await options.commit(execution, synthetic);
        await commitNotStarted(index + 1, "not_executed_after_error");
        throw error;
      }
      const decision = await options.commit(execution, result);
      index++;
      if (decision === "halt") {
        await commitNotStarted(index, "not_executed_after_halt");
        return { cancelled: false, halted: true };
      }
      continue;
    }

    const groupStart = index;
    while (index < options.calls.length && options.classify(options.calls[index]) === "parallel") {
      index++;
    }
    const group = options.calls.slice(groupStart, index).map((call, offset) => ({
      toolCallIndex: groupStart + offset,
      call,
    }));
    const groupResult = await runParallelGroup(group, maxParallel, options);

    if (groupResult.cancelled) {
      await commitNotStarted(groupStart + groupResult.started, "aborted_before_dispatch");
      return { cancelled: true, halted: false };
    }
    if (groupResult.error !== undefined) {
      // 出错路径：为本组未发射调用（及后续所有调用）补 not_executed 闭合 transcript，再上抛
      await commitNotStarted(groupStart + groupResult.started, "not_executed_after_error");
      throw groupResult.error;
    }
    if (groupResult.halted) {
      // halt 只停止发射；已发射调用的结果（含 halt 后完成的）在组内已全部按序提交，
      // 这里只补从未发射的调用。
      await commitNotStarted(groupStart + groupResult.started, "not_executed_after_halt");
      return { cancelled: false, halted: true };
    }
  }

  return { cancelled: false, halted: false };
}

interface ParallelGroupResult {
  started: number;
  cancelled: boolean;
  halted: boolean;
  /** 首个非取消错误（execute / commit）；drain 完毕后由调用方闭合 transcript 再上抛。 */
  error?: unknown;
}

async function runParallelGroup<T>(
  calls: ToolCallExecution[],
  maxParallel: number,
  options: ToolCallSchedulerOptions<T>,
): Promise<ParallelGroupResult> {
  type Settled = { index: number; result?: T; error?: unknown };
  // synthetic = execute 抛错的槽位：以合成失败结果提交，让 commitIndex 能推进到底（transcript 闭合）
  const settled: Array<{ ready: boolean; synthetic: boolean; result?: T }> =
    calls.map(() => ({ ready: false, synthetic: false }));
  const active = new Map<number, Promise<Settled>>();
  let launchIndex = 0;
  let commitIndex = 0;
  let halted = false;
  let cancelled = false;
  let firstError: unknown;

  const launch = (callIndex: number): void => {
    const promise = Promise.resolve()
      .then(() => options.execute(calls[callIndex]!))
      .then(
        (result): Settled => ({ index: callIndex, result }),
        (error): Settled => ({ index: callIndex, error }),
      );
    active.set(callIndex, promise);
  };

  while (launchIndex < calls.length && active.size < maxParallel && !options.signal?.aborted) {
    launch(launchIndex++);
  }

  try {
    while (active.size > 0) {
      const next = await Promise.race(active.values());
      active.delete(next.index);
      if (next.error !== undefined) {
        if (options.signal?.aborted) {
          // abort 拒绝的槽位永不 ready：commitIndex 停在其前（恢复路径按 toolCalls 记录兜底）
          cancelled = true;
          continue;
        }
        if (firstError === undefined) firstError = next.error;
        // 出错槽位标记合成后直接落入提交循环：错误若是组内最后结算的
        //（含单调用组），没有后续兄弟触发提交，合成结果必须在此刻落账。
        settled[next.index] = { ready: true, synthetic: true };
      } else {
        settled[next.index] = { ready: true, synthetic: false, result: next.result };
        if (options.signal?.aborted) cancelled = true;
      }

      // 提交循环：无 halted 门 —— 已执行/已合成的事实一律按原始顺序提交。
      // halt / 出错 / 取消只停止“发射”，不丢弃已产生的事实。
      while (commitIndex < calls.length && settled[commitIndex].ready) {
        const execution = calls[commitIndex]!;
        const payload = settled[commitIndex].synthetic
          ? await options.notExecuted(execution, "execution_error")
          : settled[commitIndex].result as T;
        try {
          const decision = await options.commit(execution, payload);
          halted = halted || decision === "halt";
        } catch (error) {
          // commit 消费方故障：记录错误并继续提交后续槽位（该槽位成为唯一接受的洞）
          if (firstError === undefined) firstError = error;
        }
        commitIndex++;
      }

      // 发射循环：halt / 取消 / 出错后不再发射新调用
      while (!halted && !cancelled && firstError === undefined
        && launchIndex < calls.length && active.size < maxParallel && !options.signal?.aborted) {
        launch(launchIndex++);
      }
    }
  } finally {
    // 结构化并发兜底：任何提前退出（含上述代码自身异常）都不留下无人消费的在飞 promise
    if (active.size > 0) await Promise.allSettled([...active.values()]);
  }

  if (firstError !== undefined) {
    return { started: launchIndex, cancelled, halted, error: firstError };
  }
  return { started: launchIndex, cancelled, halted };
}
