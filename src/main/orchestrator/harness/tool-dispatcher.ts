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
import type { AgentState, HarnessEvent, SideEffectKind, TodoItem, ToolObservation } from "./types";
import { parseToolCallArgs, toolCallFingerprint } from "./types";
import {
  CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
  UPDATE_TODO_TOOL_ID,
  ASK_USER_TOOL_ID,
  isHarnessBuiltin,
  isInteractiveHarnessBuiltin,
  TASK_TOOL_ID,
  CLOSE_TASK_TOOL_ID,
} from "./builtin-tools";
import {
  executeUpdateTodo,
  executeAskUser,
  executeTask,
  executeCloseTask,
  executeConfirmUncertainEffect,
} from "./builtin-tools";
import {
  ENTER_PLAN_MODE_TOOL_ID,
  WRITE_PLAN_TOOL_ID,
  SUBMIT_PLAN_TOOL_ID,
  executeEnterPlanMode,
  executeWritePlan,
  executeSubmitPlan,
} from "./plan-tools";
import { executeReadToolResult, READ_TOOL_RESULT_TOOL_ID } from "./tool-output/read-tool-result";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tools/registry/tool-evidence";
import { isBlockedByUncertainEffect } from "./uncertain-effect-guard";
import { ExecutionLedger } from "../execution-ledger";
import type { ToolExecutionOutcome } from "../types";
import { executeToolDefinition } from "../tools/registry/tool-executor";
import { toolRegistry } from "../tools/registry/tool-registry";
import type { ToolOutputStore } from "./tool-output/tool-output-store";
import { ToolOutputPersistenceError } from "./tool-output/file-tool-output-store";
import { parseGeneratedImageResult } from "../../../shared/generated-image";

const READ_ONLY_BUILTINS = new Set([
  ASK_USER_TOOL_ID,
  CONFIRM_UNCERTAIN_EFFECT_TOOL_ID,
  READ_TOOL_RESULT_TOOL_ID,
  SUBMIT_PLAN_TOOL_ID,
]);
const IDEMPOTENT_BUILTINS = new Set([
  UPDATE_TODO_TOOL_ID,
  CLOSE_TASK_TOOL_ID,
  ENTER_PLAN_MODE_TOOL_ID,
  WRITE_PLAN_TOOL_ID,
]);

/** Keep built-in lifecycle metadata accurate when no registry definition exists. */
export function resolveToolDispatchSideEffect(
  toolName: string,
  args: Record<string, unknown>,
  tools: ToolDefinition[],
): SideEffectKind {
  const registered = tools.find((tool) => tool.id === toolName);
  if (registered) return resolveSideEffect(registered, args);
  if (READ_ONLY_BUILTINS.has(toolName)) return "read_only";
  if (IDEMPOTENT_BUILTINS.has(toolName)) return "idempotent_mutation";
  // Delegated work can outlive a caller crash, so it remains conservative.
  if (toolName === TASK_TOOL_ID) return "non_idempotent_side_effect";
  return "non_idempotent_side_effect";
}

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
  signal?: AbortSignal;
  checkPermission?: (toolId: string, args: Record<string, unknown>) => Promise<boolean>;
  toolContext?: import("../tools/registry/tool-context").ToolContext;
  truncation?: TruncationConfig;
  /** 完整工具输出持久化；生产 Harness 必须注入。 */
  toolOutputStore?: ToolOutputStore;
  /** Harness 内部重试时延后保存，确保最终 observation 对应唯一 record。 */
  deferOutputPersistence?: boolean;
  executionLedger?: ExecutionLedger;
  taskExecutor?: import("../task-runtime").TaskExecuteRequest extends infer _T ? (request: import("../task-runtime").TaskExecuteRequest) => Promise<import("../task-runtime").TaskExecuteResult> : never;
  closeTaskExecutor?: (request: import("../task-runtime").TaskCloseRequest) => import("../task-runtime").TaskCloseResult | Promise<import("../task-runtime").TaskCloseResult>;
  /** Persist the dispatch boundary before emitting lifecycle or invoking the tool. */
  onToolStarted?: (input: {
    toolCallId: string;
    toolName: string;
    sideEffect: SideEffectKind;
    fingerprint: string;
    repeatAuthorizationId?: string;
  }) => Promise<void>;
  /** Persist one-shot user authorization before it becomes available to dispatch. */
  onEffectResolution?: (input: {
    effectId: string;
    authorizationId: string;
    fingerprint: string;
    grantedAt: number;
  }) => Promise<void>;
  onTaskState?: (input: { toolCallId: string; items: TodoItem[] }) => Promise<void>;
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
  const args = parseToolCallArgs(call);
  const fingerprint = toolCallFingerprint(call.name, args);
  const failSafeFingerprint = `${call.name}(*)`;
  const blockingEffect = ctx.state.uncertainEffects.find((effect) =>
    effect.fingerprint === fingerprint || effect.fingerprint === failSafeFingerprint,
  );
  if (isBlockedByUncertainEffect(ctx.state, fingerprint)) {
    return {
      outcome: "not_executed",
      category: "runtime_safety",
      tool: call.name,
      message:
        `该副作用已有一次未确认结果（${blockingEffect?.id ?? "unknown"}），在 reconcile 或 ask 用户前不能重复执行`,
    };
  }

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
    const sideEffect = resolveToolDispatchSideEffect(call.name, args, ctx.tools);
    const repeatAuthorization = blockingEffect?.repeatAuthorization;
    if (repeatAuthorization) delete blockingEffect.repeatAuthorization;
    await ctx.onToolStarted?.({
      toolCallId: call.id,
      toolName: call.name,
      sideEffect,
      fingerprint,
      ...(repeatAuthorization ? { repeatAuthorizationId: repeatAuthorization.id } : {}),
    });
    if (ctx.signal?.aborted) {
      return {
        outcome: "not_executed",
        category: "runtime_safety",
        tool: call.name,
        message: "工具已记录开始，但在实际派发前被取消",
      };
    }
    ctx.onEvent?.({ type: "tool_start", toolCallId: call.id, toolName: call.name, args });
    const result = await executeHarnessBuiltin(call, ctx);
    return ctx.deferOutputPersistence ? result : persistToolDispatchResult(call, result, ctx);
  }

  // ── 普通工具 ──
  const tool = ctx.tools.find((t) => t.id === call.name);

  // 工具不存在
  if (!tool) {
    const registeredTool = toolRegistry.getById(call.name);
    if (registeredTool?.browserControlPhase === "active") {
      return {
        outcome: "failure",
        category: "not_found",
        tool: call.name,
        message:
          `浏览器交互工具“${call.name}”当前没有开放给本轮。请先调用 browser_control_start 并确认控制已开启；` +
          "只有后续模型请求的可用工具列表中出现该工具后，才能调用它。",
      };
    }
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

  // Reserve a matching one-shot authorization synchronously so parallel calls
  // cannot both consume it. If persistence fails, the next recovery projection
  // restores it because no authorized tool_started event was committed.
  const repeatAuthorization = blockingEffect?.repeatAuthorization;
  if (repeatAuthorization) delete blockingEffect.repeatAuthorization;
  const sideEffect = resolveToolDispatchSideEffect(call.name, args, ctx.tools);
  await ctx.onToolStarted?.({
    toolCallId: call.id,
    toolName: call.name,
    sideEffect,
    fingerprint,
    ...(repeatAuthorization ? { repeatAuthorizationId: repeatAuthorization.id } : {}),
  });
  if (ctx.signal?.aborted) {
    return {
      outcome: "not_executed",
      category: "runtime_safety",
      tool: call.name,
      message: "工具已记录开始，但在实际派发前被取消",
    };
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

  const shellContext = call.name === "run_shell" && ctx.onEvent
    ? {
        ...ctx.toolContext,
        userQuery: ctx.toolContext?.userQuery ?? "",
        onShellOutput: (update: import("../tools/registry/tool-context").ShellOutputUpdate) => {
          try { ctx.toolContext?.onShellOutput?.(update); } catch { /* 观察者不能中断命令 */ }
          try { ctx.onEvent?.({ type: "tool_output", toolCallId: call.id, ...update }); } catch { /* UI 事件不能中断命令 */ }
        },
      }
    : ctx.toolContext;
  let acceptingProgress = true;
  const executionContext = {
    ...shellContext,
    userQuery: shellContext?.userQuery ?? "",
    reportProgress: (message: string) => {
      if (!acceptingProgress || ctx.signal?.aborted || shellContext?.signal?.aborted || typeof message !== "string" || !message.trim()) return;
      try { ctx.onEvent?.({ type: "progress_text", content: message.slice(0, 300) }); } catch { /* UI cannot interrupt generation */ }
    },
  };
  const run = async (): Promise<ToolExecutionOutcome> => executeToolDefinition(tool, args, executionContext);
  try {
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
  } finally {
    acceptingProgress = false;
  }

  // 截断输出（长输出按预算截断，只把可消费的 preview 交给模型）
  const truncationConfig = ctx.truncation ?? DEFAULT_TRUNCATION;
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
      preview: parseGeneratedImageResult(preview) ? preview : preview.slice(0, 200),
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
      return executeUpdateTodo(call, ctx.state, ctx.onEvent, (items) =>
        ctx.onTaskState?.({ toolCallId: call.id, items }) ?? Promise.resolve(),
      );

    case "ask_user":
      return executeAskUser(call, ctx.requestUserClarification, ctx.onEvent);
    case CONFIRM_UNCERTAIN_EFFECT_TOOL_ID: {
      const runId = ctx.toolContext?.runId ?? "unknown-run";
      return executeConfirmUncertainEffect(
        call,
        ctx.state,
        ctx.requestUserClarification,
        {
          authorizationId: `${runId}:repeat:${call.id}`,
          onAuthorized: (authorization) => ctx.onEffectResolution?.(authorization),
        },
      );
    }
    case ENTER_PLAN_MODE_TOOL_ID:
      return executeEnterPlanMode(call, ctx.toolContext, ctx.onEvent);
    case WRITE_PLAN_TOOL_ID:
      return executeWritePlan(call, ctx.toolContext, ctx.onEvent);
    case SUBMIT_PLAN_TOOL_ID:
      return executeSubmitPlan(call, ctx.toolContext, ctx.requestUserClarification, ctx.onEvent);
    case "task":
      return executeTask(call, ctx.taskExecutor);
    case CLOSE_TASK_TOOL_ID:
      return executeCloseTask(call, ctx.closeTaskExecutor);
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
