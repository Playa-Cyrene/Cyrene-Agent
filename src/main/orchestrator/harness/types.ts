/**
 * CyreneHarness 核心类型定义。
 *
 * 本文件只定义 Harness 特有的类型，复用现有类型：
 * - ChatMessage / ToolCall / ToolSpec 来自 vendors/types
 * - ToolDefinition 来自 tool-registry
 * - ToolCallResult 来自 orchestrator/types
 */

import type { ChatMessage, ToolCall, ToolSpec } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { CyreneRunTerminalResult } from "../../../shared/run-terminal";
import type { TodoItem } from "../../../shared/task-session";
import type { ToolErrorCategory } from "../tools/registry/tool-execution-error";
import type { ToolRiskLevel } from "../../permission-policy";
import type { ToolFileChange } from "../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../shared/context-usage";
import type { ToolOutputRef, ToolOutputStore } from "./tool-output/tool-output-store";
export type { ToolErrorCategory } from "../tools/registry/tool-execution-error";
export type { TodoItem, TodoStatus } from "../../../shared/task-session";

// ── 工具调用结果 ──────────────────────────────────────────

/**
 * 工具执行结果的四态 outcome。
 * - success: Runtime 明确知道工具成功
 * - failure: Runtime 明确知道工具失败
 * - unknown: Runtime 不知道工具到底怎么样了（主要是 non_idempotent timeout）
 * - not_executed: Runtime 主动决定不执行（协议性结果）
 */
export type ToolCallOutcome = "success" | "failure" | "unknown" | "not_executed";

/** 副作用分类：只读 / 幂等修改 / 非幂等副作用（用于重试与重复执行防护） */
export type SideEffectKind =
  | "read_only"
  | "idempotent_mutation"
  | "non_idempotent_side_effect";

/** 重试决策 */
export type RetryDecision = "retry" | "no_retry";

/** 工具执行后的结构化 observation（面向模型的结果对象） */
export interface ToolObservation {
  outcome: ToolCallOutcome;
  category?: ToolErrorCategory;
  toolSideEffect?: SideEffectKind;
  retryDecision?: RetryDecision;
  retryCount?: number;
  tool: string;
  target?: string;
  message: string;
  suggestion?: string;
  /** 截断信息（长输出按软/硬预算截断后的标记与 preview） */
  truncated?: boolean;
  preview?: string;
  fullOutputRef?: string;
  /** Runtime-only 完整输出记录；写入 Checkpoint，不进入模型消息。 */
  toolOutputRef?: ToolOutputRef;
  /** 工具返回的原始输出（未截断前），可能被截断后只保留 preview */
  output?: string;
}

// ── Uncertain Effect（结果不确定的副作用追踪）────────────

export interface UncertainEffect {
  id: string;
  toolCallId: string;
  fingerprint: string;
  toolName: string;
  message: string;
  repeatAuthorization?: { source: "user"; grantedAt: number };
}

// ── Agent State（Agent 运行期可恢复状态）────────────────

export interface AgentState {
  todoItems: TodoItem[];
  uncertainEffects: UncertainEffect[];
  /**
   * 同工具连续失败计数（熔断用）：failure 递增、success 清零、not_executed/unknown 不动。
   * 可选字段：旧持久化状态无此字段，运行时按需创建。
   */
  toolFailureStreaks?: Record<string, number>;
}

export type HarnessCacheEpochReason =
  | "run_start"
  | "compaction"
  | "recovery"
  | "model_changed"
  | "tool_catalog_changed"
  | "prompt_version_changed";

/** 模型可见上下文最后一次发生结构性重建的缓存周期。 */
export interface HarnessCacheState {
  cacheEpoch: number;
  epochReason: HarnessCacheEpochReason;
}

/** 只包含 hash 和计数的缓存诊断，禁止携带提示词或工具输出正文。 */
export interface HarnessCacheDiagnostic {
  runId?: string;
  cacheEpoch: number;
  round: number;
  stablePromptFingerprint: string;
  toolSchemaFingerprint: string;
  messagePrefixFingerprint: string;
  messageCount: number;
}

export const INITIAL_HARNESS_CACHE_STATE: HarnessCacheState = {
  cacheEpoch: 1,
  epochReason: "run_start",
};

// ── Harness 配置 ─────────────────────────────────────────

export interface HarnessConfig {
  /** 已声明为安全的工具最多可同时执行几个；1 表示串行。 */
  maxParallelToolCalls: number;
  /** 工具轮上限；0 表示不限。达到上限后不再发起下一次模型请求。 */
  maxRounds: number;
  /** 总超时（毫秒） */
  totalTimeoutMs: number;
  /** 用户等待超时（毫秒，ask_user 等待期间不计入执行超时） */
  userWaitTimeoutMs: number;
  /** 上下文窗口大小（token） */
  contextWindowTokens: number;
  /**
   * 为 LLM 回复预留的 token 预算（仅参与压缩预算计算 computeTokenBudget，
   * 不再作为请求 maxTokens 限流——见 harness-llm.ts 输出上限策略）。
   */
  reservedOutputTokens: number;
  /** 固定安全余量（token） */
  safetyMarginTokens: number;
  /** 压缩触发阈值比例（默认 0.7） */
  compactionThreshold: number;
  /** 压缩后原样保留的近期 transcript 占上下文窗口比例（默认 0.16）。 */
  compactionRetainRatio: number;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  maxParallelToolCalls: 4,
  maxRounds: 0,
  totalTimeoutMs: 0,
  userWaitTimeoutMs: 120_000,
  contextWindowTokens: 256_000,
  reservedOutputTokens: 8_192,
  safetyMarginTokens: 512,
  compactionThreshold: 0.7,
  compactionRetainRatio: 0.16,
};

// ── Harness 事件（给 UI / 桥层）──────────────────────────

export type HarnessEvent =
  | { type: "round_start"; roundId: string }
  | { type: "round_end"; roundId: string }
  | { type: "candidate_text_delta"; roundId: string; delta: string }
  | { type: "candidate_text_discard"; roundId: string }
  | { type: "progress_text"; content: string }
  | { type: "final_answer"; content: string }
  | { type: "reasoning_start"; messageId: string }
  | { type: "reasoning_delta"; messageId: string; delta: string }
  | { type: "reasoning_end"; messageId: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown>; displayName?: string }
  | { type: "tool_end"; toolCallId: string; outcome: ToolCallOutcome; preview: string; changes?: ToolFileChange[] }
  | { type: "todo_update"; items: TodoItem[] }
  | { type: "context_usage"; snapshot: ContextUsageSnapshot }
  | { type: "ask_user"; card: unknown }
  | { type: "plan_mode_changed"; state: import("../plan-mode").PlanStateName }
  | { type: "plan_written"; planPath: string }
  | { type: "runtime_feedback"; message: string }
  | { type: "error"; message: string };

/** 仅供持久层记账的工具调用边界；不直接暴露给聊天 UI。 */
export interface HarnessToolLifecycleEvent {
  toolCallId: string;
  toolName: string;
  toolSideEffect: SideEffectKind;
  status: "started" | "committed" | "unknown" | "not_executed";
}

/**
 * 工具完成观察事件：工具结果已确定后的只读通知。
 * 只携带稳定元数据（不含参数、输出与内部异常正文），供宿主旁路转发给插件；
 * 观察者不得参与权限判断、重试、提交或恢复。
 */
export interface HarnessToolFinishedEvent {
  toolId: string;
  toolCallId: string;
  runId: string;
  status: ToolCallOutcome;
  risk: ToolRiskLevel;
  /** 工具开始执行到结果确定的耗时；未真正执行（not_executed）时不存在。 */
  durationMs?: number;
}

/** 压缩事务边界；只有 committed 才表示 transcript 已被替换。 */
export interface HarnessCompactionLifecycleEvent {
  status: "started" | "committed";
  messageCountBefore: number;
  messageCountAfter?: number;
  cache?: HarnessCacheState;
}

/** 供持久化执行者保存可恢复子运行状态的只读快照。 */
export interface HarnessCheckpoint {
  messages: ChatMessage[];
  state: AgentState;
  /** 完整工具输出的引用，不复制 output.txt 内容。 */
  toolOutputs: ToolOutputRef[];
  rounds: number;
  cache: HarnessCacheState;
  at: number;
}

// ── Harness 输入与输出 ───────────────────────────────────

/** 插入当前运行的用户调整消息（宿主已提交为正式用户消息，harness 只负责进上下文）。 */
export interface RunAdjustmentMessage {
  /** 队列条目稳定标识（与正式用户消息 id 一致）。 */
  id: string;
  /** 模型可见的原始文字。 */
  rawContent: string;
}

export interface HarnessToolSpec extends ToolSpec {
  /** Harness 内置工具标记（不进 registry） */
  harnessBuiltin?: boolean;
}

export interface HarnessInput {
  /**
   * 兼容旧调用方的扁平系统提示词。新调用方应使用 promptLayers，
   * 让稳定前缀与每轮运行时上下文分离。
   */
  systemPrompt: string;
  /** 缓存友好的提示词分层；Todo 等每轮状态不得放入 stablePrefix。 */
  promptLayers?: import("../prompt-layers").PromptLayers;
  /**
   * stablePrefix 的人设层/工具层文本拆分，供上下文容量快照分类；
   * 缺省时整个 stablePrefix 计入系统提示词类。
   */
  usageParts?: {
    personaContent: string;
    toolLayerContent: string;
    /** Skill 目录段（含 toolLayerContent 中的 Skill 部分），快照拆"技能"类用；缺省归零。 */
    skillLayerContent?: string;
  };
  /** 初始消息（不含 system） */
  messages: ChatMessage[];
  /** canonical runId；仅用于内部 transcript 元数据，永不进入 Provider 请求。 */
  runId?: string;
  /** 首次请求前物化一次的内部事实；后续轮次不得重新注入。 */
  initialInternalContext?: {
    kind: "run_start" | "recovery";
    content: string;
  };
  /** 恢复或上下文重建后的初始缓存周期。 */
  initialCache?: HarnessCacheState;
  /** 从可恢复会话还原的初始状态；Harness 会取得自己的深拷贝。 */
  initialState?: AgentState;
  /** 普通工具列表（从 registry 获取） */
  tools: ToolDefinition[];
  /** 厂商适配器 ID（用于 LLM 调用） */
  vendorConfig: import("../vendors/types").VendorConfig;
  /** 配置 */
  config?: Partial<HarnessConfig>;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 事件回调 */
  onEvent?: (event: HarnessEvent) => void;
  /** 每轮和终态时发送的可持久化 transcript 快照。
   *  契约：Harness 传活引用（不克隆）；消费方必须在回调返回前同步完成克隆或落盘，
   *  不得持有跨 await 的活引用。payload 必须严格 JSON-serializable
   *  （不得含 Date / Map / Set / BigInt / class instance），否则克隆与持久化都会失真。 */
  onCheckpoint?: (checkpoint: HarnessCheckpoint) => void;
  /** 工具执行前与模型可见结果提交后的持久化边界。 */
  onToolLifecycle?: (event: HarnessToolLifecycleEvent) => void;
  /** 工具结果确定后的只读观察回调；只读稳定元数据，不参与执行决策。 */
  onToolFinished?: (event: HarnessToolFinishedEvent) => void;
  /** 压缩前后持久化事务边界。 */
  onCompactionLifecycle?: (event: HarnessCompactionLifecycleEvent) => void;
  /** 每次模型请求前的非敏感缓存结构诊断。 */
  onCacheDiagnostic?: (diagnostic: HarnessCacheDiagnostic) => void;
  /**
   * 插话轮询：返回 undefined 表示当前没有标记插入本运行的消息（同步快速路径，
   * 不产生 await 挂起点）；返回 Promise 表示有待提交的插话，resolve 值为
   * 已提交消息（提交失败的条目由宿主保留标记，不在返回值中）。
   * harness 在（a）每轮模型请求前、（b）模型准备结束运行的最终结算前调用；
   * 结束路径拿到非空数组时不得结算，须把本轮回复转为中间过程并继续循环。
   */
  pollRunAdjustments?: () => Promise<RunAdjustmentMessage[]> | undefined;
  /** 用户澄清函数（ask_user 内置工具使用） */
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  /** 是否向模型公布并允许 Ask/不确定副作用确认工具；默认 true。 */
  includeInteractiveTools?: boolean;
  /** 计划模式状态；控制计划工具组可见性（undefined = 不注入计划工具，兼容旧调用方/子任务）。 */
  planState?: import("../plan-mode").PlanStateName;
  /** 工具上下文（权限检查等） */
  toolContext?: import("../tools/registry/tool-context").ToolContext;
  /** 权限检查函数 */
  checkPermission?: (toolId: string, args: Record<string, unknown>) => Promise<boolean>;
  /** ExecutionLedger：可选的同进程工具去重缓存（用于副作用重复执行防护） */
  executionLedger?: import("../execution-ledger").ExecutionLedger;
  /** ToolOutputStore：生产 Harness 注入的完整工具结果存储。 */
  toolOutputStore?: ToolOutputStore;
  /**
   * Run 级轨迹提交端（CTA Phase 1）：canonical 消息权威落盘。
   * assistant 先于工具 dispatch、tool_result 先于生命周期 committed 写入；
   * 写失败 fail-closed（终态 error），缺省不写轨迹。
   */
  transcriptSink?: import("../transcript-sink").TranscriptSink;
  /** 父会话注入的前台子任务执行器；子 Harness 不会继续注入它。 */
  taskExecutor?: (request: import("../task-runtime").TaskExecuteRequest) => Promise<import("../task-runtime").TaskExecuteResult>;
}

export interface HarnessResult {
  /** 最终回复文本 */
  finalAnswer: string;
  /** 最终 Agent State 快照 */
  finalState: AgentState;
  /** 是否因超时退出（兼容字段；新消费方请改用 terminal.status） */
  terminated: boolean;
  /** 终止原因（兼容字段；新消费方请改用 terminal.reason） */
  terminateReason?: "max_rounds" | "timeout" | "cancelled" | "error";
  /**
   * Canonical 终态结算（exactly-once，见 run-settlement.ts）。
   *
   * 新消费方（CyreneAgent.runWithEvents、agui-bridge settlement gate）必须读 terminal，
   * 不要再从 terminated / terminateReason 反推：
   *  - status="success"：模型自然收尾（无 tool call 或主动结束）。
   *  - status="timeout"：reason="timeout"。
   *  - status="cancelled"：reason="user_cancelled"。
   *  - status="error"：reason 来自 AgentRuntimeError.code 或工具 fatal。
   *
   * 由 harness-adapter 根据 terminateReason 映射填充；
   * cyrene-harness 内部仍只写 terminated / terminateReason。
   */
  terminal?: CyreneRunTerminalResult;
  /** 总执行轮数 */
  rounds: number;
}

// ── 辅助类型 ─────────────────────────────────────────────

/** 把 ToolCall 的 arguments JSON 字符串解析为对象 */
export function parseToolCallArgs(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 生成工具调用的 fingerprint（用于 uncertainEffects 重复拦截） */
export function toolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`)
    .join(",");
  return `${toolName}(${sortedArgs})`;
}
