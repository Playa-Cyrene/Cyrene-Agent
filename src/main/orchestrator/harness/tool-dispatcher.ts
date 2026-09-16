/**
 * 工具分发器：统一 dispatch Harness 内置工具和普通工具。
 *
 * - 内置工具（update_todo / ask_user）：由 executeHarnessBuiltin 处理，能直接访问 state 和 emitter
 * - 普通工具：走 executeToolCall，含权限检查、预校验、输出截断
 *
 * 普通工具执行前检查 uncertainEffects fingerprint 拦截（防未确认副作用被自动重放）。
 * 普通工具执行后统一截断输出（软/硬双级预算）。
 */

import type { ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { ToolCallResult } from "../types";
import type { AgentState, HarnessEvent, ToolObservation } from "./types";
import { parseToolCallArgs, toolCallFingerprint } from "./types";
import { isHarnessBuiltin, isInteractiveHarnessBuiltin, TASK_TOOL_ID } from "./builtin-tools";
import { executeUpdateTodo, executeAskUser, executeTask } from "./builtin-tools";
import { ENTER_PLAN_MODE_TOOL_ID, WRITE_PLAN_TOOL_ID, executeEnterPlanMode, executeWritePlan } from "./plan-tools";
import { executeReadToolResult, READ_TOOL_RESULT_TOOL_ID } from "./tool-output/read-tool-result";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tools/registry/tool-evidence";
import { isBlockedByUncertainEffect } from "./uncertain-effect-guard";
import { ExecutionLedger } from "../execution-ledger";
import type { ToolExecutionOutcome } from "../types";
import { executeToolDefinition } from "../tools/registry/tool-executor";
import type { ToolOutputStore } from "./tool-output/tool-output-store";
import { ToolOutputPersistenceError } from "./tool-output/file-tool-output-store";

// ── 工具输出截断 ─────────────────────────────────────────

export interface TruncationConfig {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

// 截断参数：30K 触发阈值 + 20K 预览预算（≤30K 完整返回；>30K 留头 12K + 尾 8K）。
// 尾窗 8K 要装得下测试汇总行 + 数个失败用例 diff；头窗 12K 覆盖命令回显与早期报错。
// 8K~30K 的中等输出（单文件测试、build 日志）不再截断，直接全文给模型。
export const DEFAULT_TRUNCATION: TruncationConfig = {
  thresholdChars: 30_000,
  headChars: 12_000,
  tailChars: 8_000,
};

export const TOOL_RESULT_PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

/**
 * 剪枝模型可见的工具输出。
 * 超出阈值时保留头尾，避免遗失末尾错误、退出码和统计摘要。
 */
export function truncateOutput(
  output: string,
  config: TruncationConfig,
  _toolCallId: string,
): { preview: string; truncated: boolean; fullOutputRef?: string } {
  const points = Array.from(output);
  if (points.length <= config.thresholdChars) {
    return { preview: output, truncated: false };
  }

  // P0: 暂不实现 backing store，fullOutputRef 省略
  // P1: 如果有 ToolOutputStore，保存完整输出并返回引用
  const preview = points.slice(0, config.headChars).join("")
    + TOOL_RESULT_PRUNE_MARKER
    + points.slice(-config.tailChars).join("");

  return { preview, truncated: true, fullOutputRef: undefined };
}

// ── 工具执行接口 ─────────────────────────────────────────

export interface ToolDispatchContext {
  state: AgentState;
  tools: ToolDefinition[];
  onEvent?: (event: HarnessEvent) => void;
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  includeInteractiveTools?: boolean;
  checkPermission?: (toolId: string, args: Record<string, unknown>) => Promise<boolean>;
  toolContext?: import("../tools/registry/tool-context").ToolContext;
  truncation?: TruncationConfig;
  /** 完整工具输出持久化；生产 Harness 必须注入。 */
  toolOutputStore?: ToolOutputStore;
  /** Harness 内部重试时延后保存，确保最终 observation 对应唯一 record。 */
  deferOutputPersistence?: boolean;
  executionLedger?: ExecutionLedger;
  taskExecutor?: import("../task-runtime").TaskExecuteRequest extends infer _T ? (request: import("../task-runtime").TaskExecuteRequest) => Promise<import("../task-runtime").TaskExecuteResult> : never;
}

export interface ToolDispatchResult extends ToolObservation {
  /** 原始工具执行结果（如果有） */
  rawResult?: ToolCallResult;
}

/**
 * 统一 dispatch 工具调用。
 *
 * 1. 内置工具 → executeHarnessBuiltin
 * 2. 普通工具 → 先检查 fingerprint 拦截 → executeToolCall → 截断输出
 */
export async function dispatchToolCall(
  call: ToolCall,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  // ── 内置工具 ──
  if (isHarnessBuiltin(call.name)) {
    if (ctx.includeInteractiveTools === false && isInteractiveHarnessBuiltin(call.name)) {
      return {
        outcome: "failure",
        category: "not_found",
        tool: call.name,
        message: "当前渠道不支持交互式工具",
      };
    }
    const result = await executeHarnessBuiltin(call, ctx);
    return ctx.deferOutputPersistence ? result : persistToolDispatchResult(call, result, ctx);
  }

  // ── 普通工具 ──
  const args = parseToolCallArgs(call);
  const tool = ctx.tools.find((t) => t.id === call.name);

  // fingerprint 拦截（已不确定的副作用在授权前禁止自动重放）
  const fingerprint = toolCallFingerprint(call.name, args);
  const blockingEffect = ctx.state.uncertainEffects.find((effect) => effect.fingerprint === fingerprint);
  if (isBlockedByUncertainEffect(ctx.state, fingerprint)) {
    return {
      outcome: "not_executed",
      category: "runtime_safety",
      tool: call.name,
      message:
        `该副作用已有一次未确认结果（${blockingEffect?.id ?? "unknown"}），在 reconcile 或 ask 用户前不能重复执行`,
    };
  }

  // 工具不存在
  if (!tool) {
    return {
      outcome: "failure",
      category: "not_found",
      tool: call.name,
      message: `工具 "${call.name}" 未注册`,
    };
  }

  // 权限检查
  if (ctx.checkPermission) {
    const allowed = await ctx.checkPermission(tool.id, args);
    if (!allowed) {
      return {
        outcome: "failure",
        category: "permission_denied",
        tool: call.name,
        message: `工具 "${tool.id}" 被权限系统拒绝`,
      };
    }
  }

  // 执行工具
  ctx.onEvent?.({
    type: "tool_start",
    toolCallId: call.id,
    toolName: call.name,
    args,
    displayName: tool.name,
  });

  let result: ToolCallResult;
  // 提取 targetRefs 从 args（path / file / url / id 等常见字段）
  const targetRefs = args.path !== undefined ? [String(args.path)]
    : args.file !== undefined ? [String(args.file)]
    : args.url !== undefined ? [String(args.url)]
    : [];

  const run = async (): Promise<ToolExecutionOutcome> => executeToolDefinition(tool, args, ctx.toolContext);
  if (ctx.executionLedger) {
    const ledgerResult = await ctx.executionLedger.execute(
      { logicalInvocationId: `${ctx.toolContext?.runId ?? "unknown"}:${call.id}`, capability: tool.id, targetRefs, args },
      run,
    );
    result = {
      toolId: tool.id,
      args,
      ...ledgerResult.outcome,
      ...(ledgerResult.cached ? { deduplicated: true } : {}),
    };
  } else {
    result = { toolId: tool.id, args, ...await run() };
  }

  // 截断输出（长输出按预算截断，只把可消费的 preview 交给模型）
  const truncationConfig = ctx.truncation ?? DEFAULT_TRUNCATION;
  const sideEffect = resolveSideEffect(tool, args);
  const { preview, truncated } = truncateOutput(
    result.output,
    truncationConfig,
    call.id,
  );

  // 构造 observation 的真实 outcome；保存输出不能改变工具执行本身的事实。
  const outcome: ToolObservation["outcome"] = result.status === "succeeded"
    ? "success"
    : result.effectState === "unknown" && sideEffect === "non_idempotent_side_effect"
      ? "unknown"
      : "failure";
  if (outcome === "unknown") {
    const effectId = `${ctx.toolContext?.runId ?? "unknown-run"}:${call.id}`;
    if (!ctx.state.uncertainEffects.some((effect) => effect.id === effectId)) {
      ctx.state.uncertainEffects.push({
        id: effectId,
        toolCallId: call.id,
        fingerprint,
        toolName: call.name,
        message: "副作用已发起，但 Runtime 无法确认是否生效",
      });
    }
  }

  const observation: ToolDispatchResult = {
    outcome,
    category: result.category,
    toolSideEffect: sideEffect,
    retryDecision: result.retryable ? "retry" : "no_retry",
    tool: call.name,
    target: (args.path as string | undefined) ?? (args.command as string | undefined) ?? (args.query as string | undefined),
    message: preview,
    output: result.output,
    truncated,
    preview,
    rawResult: result,
  };
  const persisted = ctx.deferOutputPersistence
    ? observation
    : await persistToolDispatchResult(call, observation, ctx);

  if (!ctx.deferOutputPersistence) {
    ctx.onEvent?.({
      type: "tool_end",
      toolCallId: call.id,
      outcome: result.status === "succeeded" ? "success" : "failure",
      preview: preview.slice(0, 200),
      // Diff Review 卡片证据走独立字段，不受 preview 截断影响
      changes: extractFileChangesFromOutput(result.output),
    });
  }

  return persisted;
}

/**
 * Persists only the final model-facing observation for one logical invocation.
 * Harness retries call dispatch with deferOutputPersistence, then invoke this once.
 */
export async function persistToolDispatchResult(
  call: ToolCall,
  result: ToolDispatchResult,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  if (!shouldPersistResult(call, result) || !ctx.toolOutputStore || result.toolOutputRef) return result;
  const conversationId = ctx.toolContext?.conversationId;
  const runId = ctx.toolContext?.runId;
  if (!conversationId || !runId) {
    throw new ToolOutputPersistenceError("工具结果保存缺少会话或运行标识");
  }
  const output = result.output;
  if (output === undefined) return result;
  const projection = result.preview !== undefined && result.truncated !== undefined
    ? { preview: result.preview, truncated: result.truncated }
    : truncateOutput(output, ctx.truncation ?? DEFAULT_TRUNCATION, call.id);
  const ref = await ctx.toolOutputStore.put({
    conversationId,
    runId,
    toolCallId: call.id,
    toolName: call.name,
    outcome: result.outcome,
    output,
    truncatedForModel: projection.truncated,
  });
  return {
    ...result,
    preview: projection.preview,
    truncated: projection.truncated,
    fullOutputRef: ref.resultRef,
    toolOutputRef: ref,
  };
}

function shouldPersistResult(
  call: ToolCall,
  result: ToolDispatchResult,
): result is ToolDispatchResult & { output: string; outcome: "success" | "failure" | "unknown" } {
  return (call.name === TASK_TOOL_ID || !isHarnessBuiltin(call.name))
    && result.output !== undefined
    && (result.outcome === "success" || result.outcome === "failure" || result.outcome === "unknown");
}

// ── 内置工具执行 ─────────────────────────────────────────

async function executeHarnessBuiltin(
  call: ToolCall,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  switch (call.name) {
    case "update_todo":
      return executeUpdateTodo(call, ctx.state, ctx.onEvent);

    case "ask_user":
      return executeAskUser(call, ctx.requestUserClarification, ctx.onEvent);
    case ENTER_PLAN_MODE_TOOL_ID:
      return executeEnterPlanMode(call, ctx.toolContext, ctx.onEvent);
    case WRITE_PLAN_TOOL_ID:
      return executeWritePlan(call, ctx.toolContext, ctx.onEvent);
    case "task":
      return executeTask(call, ctx.taskExecutor);
    case READ_TOOL_RESULT_TOOL_ID:
      return executeReadToolResult(call, ctx.toolOutputStore, ctx.toolContext);

    default:
      return {
        outcome: "failure",
        category: "not_found",
        tool: call.name,
        message: `未知的 Harness 内置工具: ${call.name}`,
      };
  }
}
