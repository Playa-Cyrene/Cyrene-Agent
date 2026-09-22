// CyreneAgent —— 把两条 Agent 循环包进 AG-UI 的 AbstractAgent。
//
// - 持有 runWithEvents 入口：Chat 使用 chat-loop，其余模式使用 CyreneHarness。
// - Harness 单循环：每轮携带同一份 stablePrefix（人设+工具规则）+ tools schema + transcript；
//   工具结果以 role:tool 消息写回 transcript。
// - runWithEvents 把 AgentLoopEvent 包装成 AG-UI BaseEvent 转发给渲染端。
//
// 设计要点：
// - Chat 循环流式输出（SDK 流 + 非流式兜底）；Harness 每轮流式调用 LLM。
// - run() 不做副作用（不写记忆、不推断表情）。那些在桥层 runAgent 完成后做，
//   保持 agent 纯粹只管"产出事件流"。
// - 错误用 observer.error() 抛，桥层捕获。
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { AgentRuntimeError } from "./agent-runtime-error";
import { AgentExecutionError, type RunPhase } from "./run-execution-status";
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tools/registry/tool-registry";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { getAdapterForConfig, type ChatMessage } from "./vendors";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "./tools/registry/tool-context";
import { runChatLoop } from "./chat-loop";
import type { RunCapabilities } from "./run-capabilities";
import { runHarnessWithAdapter } from "./harness-adapter";

/** Skill 路由条目（类型本地定义，不再依赖 task-router 模块） */
export interface SkillRouteInfo {
  id: string;
  description: string;
  defaultExecutionMode?: "direct" | "plan";
}

/**
 * 两个 Agent loop 共同使用的结果形状。
 */
export interface AgentLoopResult {
  reply: string;
  toolResults: import("./types").ToolCallResult[];
  completionReason: "no_tool" | "timeout" | "max_rounds" | "tool_error";
  totalUsage?: { input: number; output: number };
  /**
   * Canonical 终态结算（exactly-once，见 run-settlement.ts）。
   * 由 harness-adapter 根据 HarnessResult.terminateReason 填充；
   * CyreneAgent.runWithEvents 据此决定 RUN_FINISHED.result 的形状。
   * 未设置时由 CyreneAgent 通过 completionReason 推断（兼容旧调用方）。
   */
  terminal?: CyreneRunTerminalResult;
}

/** 两个 Agent loop 共用的展示事件。 */
export interface AgentLoopEvent {
  type: string;
  messageId?: string;
  role?: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  stepName?: string;
  totalUsage?: unknown;
  content?: string;
  status?: string;
  snapshot?: unknown;
  taskPlan?: unknown;
  /** 上下文容量快照（chat-loop 发射；type 为 "context_usage"）。 */
  contextUsage?: import("../../shared/context-usage").ContextUsageSnapshot;
}

import type { SocialAtom } from "../social-context/types";
import { ExecutionLedgerStore, type ExecutionLedger } from "./execution-ledger";
import { perf } from "../perf-trace";
import { debugLog, flowLog } from "../agent-log";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { requestUserClarification } from "../user-choice";
import type { ConversationMode } from "../../shared/chat-types";
import type { CyreneRunTerminalResult } from "../../shared/run-terminal";
import { executeToolDefinition } from "./tools/registry/tool-executor";

const executionLedgers = new ExecutionLedgerStore();

export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  reasoning?: import("../../shared/reasoning").ReasoningPreference;
  /** 用户设置的模型上下文窗口（Token）。用于非 code 模式的对话压缩触发阈值。 */
  contextWindowTokens: number;
}

export type AgentExecutionMode = "work" | "chat";

/** CyreneAgent.run() 需要的输入——桥层构造好后塞进 input.state 或 forwardedProps。 */
export interface CyreneRunOptions {
  settings: AgentLoopSettings;
  /** 本 Run 快照的 Harness 安全工具并发上限。 */
  maxParallelToolCalls?: number;
  /**
   * Canonical runId。
   * - 由 AG-UI bridge 在 IPC 入口创建，并通过本字段一路传给 Agent、Harness adapter、ToolContext、所有 AG-UI 事件。
   * - 非 bridge 调用方允许不传：CyreneAgent.runWithEvents 会 fallback 生成一次。
   * - 一旦本字段被设置，下游（runHarnessWithAdapter / ToolContext / RUN_STARTED.runId）必须使用同一值，
   *   不得再各自生成 harness-${Date.now()} 等本地 ID。
   */
  runId?: string;
  /** 用户明确要求继续的旧 Harness Run；仅由恢复入口注入。 */
  resumeFromRunId?: string;
  /** 原始消息（不含 system）。system 由 chat-loop / harness-adapter 按 promptLayers 组装，不随消息持久化。 */
  messages: ChatMessage[];
  conversationId?: string;
  /** CITA 保留的用户原始 Query；旧调用方未传时从最后一条 user 消息读取。 */
  originalQuery?: string;
  /** CITA 生成的上下文化理解，供模型上下文拼装显式使用。 */
  contextualizedQuery?: string;
  /** 独立 CITA 证据块；原始 user 消息不会被替换。 */
  citaContextBlock?: string;
  /** CITA 本地校验后允许模型引用的不透明引用集合。 */
  trustedRefs?: string[];
  /** Chat 跳过 CITA/Native FC；默认 Work。 */
  executionMode?: AgentExecutionMode;
  /** 原始 UI 模式（work / learn / chat / code），供工具做模式隔离。 */
  conversationMode?: ConversationMode;
  timeoutMs: number;
  /** 可选：本次 run 的工具集合。未传时使用当前所有已启用工具。 */
  tools?: ToolDefinition[];
  /** 本轮冻结的模式能力；bridge 创建的 Run 必须提供。 */
  capabilities?: RunCapabilities;
  /** Harness 是否公布需要桌面交互卡片的内置工具；默认开启。 */
  harnessInteractiveTools?: boolean;
  /** 工具权限结算方式；手机端全部开启使用 allow_all 跳过逐项审批。 */
  permissionMode?: "normal" | "allow_all";
  /** 直发图片被主模型接口拒绝时，懒加载 caption fallback 消息并重试。 */
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  /** 工具规则与目录 system prompt（进入 harness stablePrefix）。 */
  toolSystemContent: string;
  /** toolSystemContent 中 Skill 目录段（skillCatalog + 自动注入 skill 上下文）的独立副本，
   *  供上下文容量快照把"技能"从"工具"里拆出来单独计量；不参与请求拼装。 */
  skillLayerContent?: string;
  /** 人设基础 system prompt（仅人设/渠道；环境/记忆/关系/附件在 soulRuntimeContext，随请求尾部注入）。 */
  soulSystemBaseContent: string;
  /** 每次请求才附加给 Soul 的可变运行时上下文；不参与稳定缓存前缀。 */
  soulRuntimeContext?: string;
  /** Plan Mode 时注入的 cyrene-plan-mode skill 正文；可变，不参与稳定缓存前缀，
   *  在 harness runtimeParts 里拼，避免进/出 plan mode 打断 stablePrefix 缓存。 */
  planSkillContext?: string;
  /** 只应用到 Soul 最终自然语言回复，禁止影响 CITA 与 Native FC。 */
  soulSampling?: ApprovedStyleSampling;
  /** 不带时间戳前缀的 messages，给 CITA 等决策层用。未传时回退到 messages。 */
  cleanMessages?: ChatMessage[];
  /** [RESPONSE_CONTEXT] 文本，从 CITA 结果生成，给 Soul 动态追加。 */
  responseContext?: string;
  /** 本地主进程生成的可信默认城市、桌面等运行环境信息。 */
  runtimeEnvironmentContext?: string;
  /** 上一次异常中断 Run 的只读 Todo/执行检查点；只用于帮助模型恢复方向。 */
  recoveryContext?: string;
  /** 由 AG-UI bridge 注入，确保 Ask 卡片回到实际发起本轮的渲染窗口。 */
  requestUserClarification?: (
    card: import("../../shared/ask-clarification").AskClarificationCard,
    signal?: AbortSignal,
  ) => Promise<import("../../shared/ask-clarification").AskUserAnswer>;
  /** 仅 Chat：异步社交原子抽取所需的已校验证据元数据。 */
  socialContext?: {
    enabled: true;
    conversationId: string;
    userTurnId: string;
    assistantTurnId: string;
    retrievedAtoms: SocialAtom[];
    now: number;
  };
  /** 可用 Skill 列表（feature flag 开启时使用）。Skill 路由层不依赖该字段是否存在。 */
  availableSkills?: SkillRouteInfo[];
  /**
   * ExecutionLedger：同进程工具去重缓存（设计稿 v3 §5.5.1.1，
   * 指 docs/design/2026-08-08-cyreneHarnessloopdesign.md）。
   * CyreneAgent 内部默认从 ExecutionLedgerStore 取，调用方一般不用传。
   */
  executionLedger?: ExecutionLedger;
  /**
   * 可信工作区根目录（来自 Conversation Workspace Binding）。
   * Work 工具和 run_verification 必须使用此目录。
   * 不能从用户消息、模型输出或 process.cwd() 推导。
   */
  resolvedWorkspaceRoot?: string;
  /**
   * 外部取消信号。
   * - 由 AG-UI bridge 创建的 AbortController 注入，AGUI_CANCEL 调用 abort()。
   * - CyreneAgent.runWithEvents 把它连接到内部 abortController（first-source-wins）。
   * - 一旦 abort，markAbort("user_cancelled") 触发，harness 收到 signal.aborted 后返回 cancelled。
   */
  signal?: AbortSignal;
  /**
   * 工具结果确定后的只读观察回调（透传给 harness 的 onToolFinished）。
   * 只携带稳定元数据供插件事件旁路使用，不参与执行决策。
   */
  onToolFinished?: (event: import("./harness/types").HarnessToolFinishedEvent) => void;
  /**
   * 插话轮询（AG-UI bridge 注入，透传给 harness）：
   * 返回待插入当前运行的用户消息；harness 在每轮模型请求前与最终结算前调用。
   * Chat 无工具链路是单请求运行，不消费该回调。
   */
  pollRunAdjustments?: () => Promise<import("./harness/types").RunAdjustmentMessage[]> | undefined;
  /**
   * Run 级轨迹提交端（CTA Phase 1）：canonical 消息权威落盘。
   * 桌面链路由上游创建并注入；缺省（渠道/插件/测试）不写轨迹。
   */
  transcriptSink?: import("./transcript-sink").TranscriptSink;
}

/** Agent run 最终结果（供桥层做副作用用）。 */
export interface CyreneRunResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
  soulPhaseReason?: "no_tool" | "max_rounds" | "timeout" | "tool_error";
  executionMode?: AgentExecutionMode;
  socialContext?: CyreneRunOptions["socialContext"];
  /**
   * Canonical 终态结算（exactly-once，见 run-settlement.ts）。
   * 桥层据此决定是否跑成功收尾副作用、是否走 RUN_ERROR 兜底等。
   * 未设置时视为 success（兼容旧调用方）。
   */
  terminal?: CyreneRunTerminalResult;
}

const LOG_PREFIX = "[CyreneAgent]";

/**
 * 生成 fallback runId（仅在调用方未通过 CyreneRunOptions.runId 注入时使用）。
 * Bridge 必须传 options.runId，确保 ack.runId 与 RUN_STARTED.runId 一致。
 */
function createRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把 AgentLoopResult.completionReason 映射为 canonical 终态结算。
 * - no_tool / tool_error → success（harness 正常返回，已产出 final answer）
 * - max_rounds → timeout, reason="max_rounds"
 * - timeout → timeout, reason="timeout"
 *
 * 注意：cancelled 不经由 completionReason 上报（catch 块单独处理）。
 */
function terminalFromCompletionReason(
  completionReason: "no_tool" | "max_rounds" | "timeout" | "tool_error" | undefined,
): CyreneRunTerminalResult {
  switch (completionReason) {
    case "max_rounds":
      return { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true };
    case "timeout":
      return { status: "timeout", reason: "timeout", externalEffectsMayContinue: true };
    default:
      // 普通成功：无 unresolved uncertainty。
      return { status: "success", externalEffectsMayContinue: false };
  }
}

export function resolveExecutionMode(mode: unknown): AgentExecutionMode {
  // 兼容尚未重启的旧 renderer 与历史内部调用。
  return mode === "chat" || mode === "soul-only" ? "chat" : "work";
}

/**
 * 把 AgentLoopEvent 包装成 AG-UI BaseEvent。
 */
export function toAguiEvent(event: AgentLoopEvent): BaseEvent {
  switch (event.type) {
    case "step_started":
      return { type: EventType.STEP_STARTED, stepName: event.stepName };
    case "step_finished":
      return { type: EventType.STEP_FINISHED, stepName: event.stepName };
    case "tool_call_start": {
      // 查注册表补中文展示名；查不到不填，前端回退原始 ID
      const registryTool = toolRegistry.getById(event.toolCallName ?? "");
      return {
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolCallName,
        toolCallDisplayName: registryTool?.name,
      };
    };
    case "tool_call_args":
      return {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: event.toolCallId,
        delta: event.delta,
      };
    case "tool_call_result":
      return {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: event.toolCallId,
        messageId: event.messageId,
        content: event.content,
        // AG-UI 标准事件不定义执行成败；保留扩展字段给本地 React 工具卡使用。
        status: event.status,
      } as BaseEvent;
    case "tool_call_end":
      return { type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId };
    case "text_message_start":
      return {
        type: EventType.TEXT_MESSAGE_START,
        messageId: event.messageId,
        role: event.role,
      };
    case "text_message_content":
      return {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: event.messageId,
        delta: event.delta,
      };
    case "text_message_end":
      return { type: EventType.TEXT_MESSAGE_END, messageId: event.messageId };
    case "reasoning_message_start":
      return { type: EventType.REASONING_MESSAGE_START, messageId: event.messageId, role: event.role };
    case "reasoning_message_content":
      return { type: EventType.REASONING_MESSAGE_CONTENT, messageId: event.messageId, delta: event.delta };
    case "reasoning_message_end":
      return { type: EventType.REASONING_MESSAGE_END, messageId: event.messageId };
    case "compressing_context":
      return { type: EventType.CUSTOM, name: "cyrene.compressingContext", value: { text: "昔涟正在压缩上下文…" } };
    case "context_usage":
      // 上下文容量快照：与 harness-adapter 的同名 CUSTOM 事件对齐。
      return {
        type: EventType.CUSTOM,
        name: "cyrene.context.usage",
        value: event.contextUsage,
      } as BaseEvent;
    default:
      // v3: 未知事件类型转为 CUSTOM 占位，不再抛错
      return { type: EventType.CUSTOM, name: "cyrene.unknown", value: event } as BaseEvent;
  }
}

/**
 * 执行一个工具调用，封装权限检查 + toolRegistry 调用 + 异常转 output。
 * 由 Harness 工具调度通过 executeTool 注入回调调用。
 */
async function executeToolCall(
  tc: { id: string; name: string; arguments: string },
  runnableToolIds: Set<string>,
  ctx?: ToolContext,
): Promise<ToolExecutionOutcome> {
  const failed = (errorCode: string, output: string): ToolExecutionOutcome => ({
    status: "failed",
    errorCode,
    output,
  });
  const displayTool = toolRegistry.getById(tc.name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.arguments || "{}");
  } catch {
    return failed("E_TOOL_ARGS_INVALID", "工具参数解析失败");
  }

  if (!runnableToolIds.has(tc.name)) {
    return failed("E_TOOL_UNAVAILABLE", "工具不可用: " + tc.name);
  }
  const tool = displayTool;
  if (!tool || !tool.enabled) {
    return failed("E_TOOL_UNAVAILABLE", "工具不可用: " + tc.name);
  }

  const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
  const perm = await checkPermission({
    toolId: tc.name,
    toolName: tool.name,
    toolDescription: tool.description,
    args,
    risk,
    runId: ctx?.runId,
  });
  if (!perm.allowed) {
    return failed("E_PERMISSION_DENIED", perm.reason || "权限不足");
  }

  return executeToolDefinition(tool, args, ctx);
}

/**
 * CyreneAgent —— 单次对话一个实例。
 *
 * 用法：
 *   const agent = new CyreneAgent({ threadId });
 *   const result = await agent.runAgentWith(options);  // 跑循环 + 事件流
 */
export class CyreneAgent extends AbstractAgent {
  /** 跑循环结果，run() 完成后可取（供桥层做副作用）。 */
  lastResult?: CyreneRunResult;

  /**
   * 跑 Agent 循环并返回事件流。桥层订阅这个流转发给渲染进程。
   * 传入的 options 会原样跑——settings/messages/timeout 都在这里。
   */
  runWithEvents(options: CyreneRunOptions): Observable<BaseEvent> {
    const threadId = this.threadId;
    // canonical runId。Bridge 必须通过 options.runId 注入，
    // 保证 ack.runId / RUN_STARTED.runId / Harness adapter / ToolContext 全链路一致。
    // 非 bridge 调用方未传时由 createRunId() fallback 生成一次。
    // 不要写回 options.runId——若调用方复用同一 options 对象跑第二次，
    // 会污染旧 ID。构造本轮局部副本，原始 options 保持不变。
    const runId = options.runId ?? createRunId();
    const runOptions: CyreneRunOptions = {
      ...options,
      runId,
      executionLedger: options.executionLedger ?? executionLedgers.forScope(runId),
    };
    const conversationId = runOptions.conversationId ?? "default";
    const abortController = new AbortController();
    // first-source-wins：谁先触发 abort，谁就是最终分类
    let abortSource: AbortSource | undefined;
    const markAbort = (source: AbortSource) => {
      if (abortSource) return; // 已有来源，不覆盖
      abortSource = source;
      abortController.abort({ source });
    };

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      let finished = false;
      const onExternalAbort = () => markAbort("user_cancelled");
      const detachExternalAbort = () => {
        runOptions.signal?.removeEventListener("abort", onExternalAbort);
      };

      // 把外部 signal 连接到内部 controller（first-source-wins）。
      if (runOptions.signal?.aborted) {
        onExternalAbort();
      } else {
        runOptions.signal?.addEventListener("abort", onExternalAbort, { once: true });
      }

      (async () => {
        try {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

          const adapterTimer = perf.begin("get_adapter");
          const adapter = getAdapterForConfig(options.settings);
          adapterTimer.end();

          const onEvent = (event: AgentLoopEvent) => {
            if (cancelled) return;
            subscriber.next(toAguiEvent(event));
          };
          const executionMode = resolveExecutionMode(options.executionMode);
          // Chat 工具增强：chat 会话在设置里勾选了工具（options.tools 非空）时
          // 改走 CyreneHarness（native function calling）；否则维持无工具 ChatLoop。
          const chatToolCount = (options.tools ?? []).length;
          const chatWithTools = executionMode === "chat" && chatToolCount > 0;
          debugLog(
            `${LOG_PREFIX} executionMode=${executionMode} loop=${executionMode === "chat" && !chatWithTools ? "chat" : "harness"} provider=${options.settings.provider} model=${options.settings.model}`,
          );
          const enabledToolCount = executionMode === "chat"
            ? chatToolCount
            : (options.tools ?? toolRegistry.getEnabledTools()).filter((tool) => tool.enabled).length;
          flowLog("── 新请求 ─────────────────────────");
          flowLog(`1. 准备上下文：${executionMode === "chat" ? "Chat" : "Work"} 模式，模型 ${options.settings.model}，${enabledToolCount} 个工具可用`);
          flowLog(`2. 理解用户请求：${executionMode === "chat" ? "Chat 模式无需工具上下文" : `完成，可信引用 ${(options.trustedRefs ?? []).length} 个`}`);

          let result: AgentLoopResult;
          if (executionMode === "chat" && !chatWithTools) {
            flowLog("3. Chat 模式：生成回复");
            result = await perf.track("chat_loop", () => runChatLoop({
              settings: options.settings,
              adapter,
              messages: options.messages,
              soulSystemBaseContent: options.soulSystemBaseContent,
              runtimeContext: [options.soulRuntimeContext, options.citaContextBlock, options.responseContext].filter(Boolean).join("\n\n---\n\n"),
              soulSampling: options.soulSampling,
              timeoutMs: options.timeoutMs,
              imageCaptionFallback: options.imageCaptionFallback,
              onEvent,
              signal: abortController.signal,
              mode: options.conversationMode,
              transcriptSink: options.transcriptSink,
            }));
          } else {
            const executeTool = (tc: Parameters<typeof executeToolCall>[0], runnableToolIds: Set<string>) => executeToolCall(tc, runnableToolIds, {
              userQuery: extractLastUserQuery(options.messages),
              conversationId: options.conversationId ?? "default",
              runId,
              contextRefs: contextRefRegistry,
              signal: abortController.signal,
              resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
              mode: options.conversationMode,
              allowedSkillIds: options.capabilities?.skillIds,
            });
            const conversationId = options.conversationId ?? "default";
            // Work / Learn / Code 统一通过 CyreneHarness。
            // 传 runOptions（含 canonical runId），不传原始 options。
            result = await perf.track("harness_loop", () => runHarnessWithAdapter(
              runOptions,
              abortController.signal,
              (baseEvent: BaseEvent) => {
                if (!cancelled) subscriber.next(baseEvent);
              },
            ));
          }

          this.lastResult = {
            reply: result.reply,
            toolResults: result.toolResults,
            totalUsage: result.totalUsage,
            soulPhaseReason: result.completionReason,
            executionMode,
            socialContext: options.socialContext,
            // 优先使用 harness-adapter 上报的 terminal；否则按 completionReason 推断
            terminal: result.terminal ?? terminalFromCompletionReason(result.completionReason),
          };
          flowLog("── 本轮完成 ────────────────────────");

          if (cancelled) return;
          // timeout 属系统侧未完成（非用户取消）：写 runtime_error interruption 边界。
          // Harness 路径已在 adapter 内按 runStore 闭合过，这里幂等重写不产生重复条目
          if (this.lastResult.terminal?.status === "timeout") {
            try {
              await options.transcriptSink?.closeInterruption({ reason: "runtime_error", runSession: null });
            } catch (closureError) {
              console.error(LOG_PREFIX, "transcript timeout closure failed:", closureError);
            }
          }
          // success / timeout 都通过 RUN_FINISHED.result 上报 canonical 终态。
          // Bridge 据此决定是否跑 sticker / memory 等成功收尾副作用。
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            result: this.lastResult.terminal,
          });
          finished = true;
          detachExternalAbort();
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          // 从 AgentExecutionError 提取真实执行状态
          const execStatus = err instanceof AgentExecutionError ? err.executionStatus : undefined;
          const hasToolResults = (execStatus?.successfulTools.length ?? 0) > 0;
          const phase = execStatus?.phase ?? "unknown";
          const classification = classifyRunError(
            err, abortSource, runId, conversationId, phase, hasToolResults,
          );
          console.error(LOG_PREFIX, `run 失败 [${classification.source}]:`, classification.diagnostics);
          if (classification.source === "user_cancelled") {
            // 权威轨迹：取消边界先于终态事件落盘。
            // ChatLoop 无工具调用，runSession 传空只写 interruption 边界；
            // Harness 路径已在 adapter 内按 runStore 状态闭合，这里幂等不重复。
            try {
              await options.transcriptSink?.closeInterruption({ reason: "user_cancel", runSession: null });
            } catch (closureError) {
              // 闭合失败不得伪装成取消成功：按运行时错误上报
              console.error(LOG_PREFIX, "transcript interruption closure failed:", closureError);
              subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId,
                runId,
                result: {
                  status: "runtime_error",
                  reason: "transcript_interruption_closure_failed",
                  externalEffectsMayContinue: true,
                },
              });
              finished = true;
              detachExternalAbort();
              subscriber.complete();
              return;
            }
            // 取消走 RUN_FINISHED + result.status="cancelled"，
            // 不伪装成 AG-UI interrupt，也不写 outcome。
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId,
              runId,
              result: {
                status: "cancelled",
                reason: "user_cancelled",
                externalEffectsMayContinue: true,
              },
            });
            finished = true;
            detachExternalAbort();
            subscriber.complete();
            return;
          }
          // 权威轨迹：运行失败（含 ChatLoop 抛错）同样写 runtime_error interruption
          // 边界，下一轮上下文能区分「系统没完成」与「用户主动取消」；
          // 闭合失败只记日志——终态本身就是失败，不再改写
          try {
            await options.transcriptSink?.closeInterruption({ reason: "runtime_error", runSession: null });
          } catch (closureError) {
            console.error(LOG_PREFIX, "transcript failure closure failed:", closureError);
          }
          const safeErr = new Error(classification.userMessage);
          finished = true;
          detachExternalAbort();
          subscriber.error(safeErr);
        }
      })();

      return () => {
        cancelled = true;
        detachExternalAbort();
        if (!finished && !abortController.signal.aborted) {
          markAbort("upstream_cleanup");
        }
      };
    });
  }

  // AbstractAgent 要求实现 run(input)，但我们用 runWithEvents 更直接。
  // 保留 run 作为一个薄封装，供标准 AG-UI 调用路径（暂不用）。
  protected _runOptions?: CyreneRunOptions;
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this._runOptions) {
      return new Observable<BaseEvent>((s) => {
        s.error(new Error("CyreneAgent.run 被直接调用，但未设置 _runOptions。请用 runWithEvents。"));
      });
    }
    void input;
    return this.runWithEvents(this._runOptions);
  }
}

/** Abort 来源分类 */
export type AbortSource =
  | "user_cancelled"
  | "call_timeout"
  | "run_timeout"
  | "window_destroyed"
  | "upstream_cleanup";

/** 执行阶段（Abort 诊断用，引用 RunPhase + 旧节点名） */
export type AbortPhase = RunPhase | "decide" | "execute";

export interface AbortDiagnostic {
  source: AbortSource;
  phase: AbortPhase;
  userMessage: string;
  diagnostics: Record<string, unknown>;
}

/** 分类 abort/error 来源，返回用户安全消息和诊断信息 */
export function classifyRunError(
  err: unknown,
  abortSource: AbortSource | undefined,
  runId: string,
  conversationId: string,
  phase: AbortPhase,
  hasToolResults: boolean,
): AbortDiagnostic {
  const diagnostics: Record<string, unknown> = {
    runId,
    conversationId,
    abortSource,
    phase,
    hasToolResults,
    errorName: err instanceof Error ? err.name : undefined,
    errorMessage: err instanceof Error ? err.message : String(err),
  };

  // 图级超时（ensureBudget 抛 E_AGENT_GRAPH_TIMEOUT，不是 AbortError）
  if (err instanceof Error && err.message === "E_AGENT_GRAPH_TIMEOUT") {
    const userMessage = phase === "soul" && hasToolResults
      ? "工具结果已获得，但最终回复生成超时，请重试。"
      : "请求处理超时，请重试。";
    return { source: "run_timeout", phase, userMessage, diagnostics };
  }

  // 图级取消（ensureBudget 抛 E_AGENT_GRAPH_CANCELLED）
  if (err instanceof Error && err.message === "E_AGENT_GRAPH_CANCELLED") {
    if (abortSource === "user_cancelled") {
      return { source: "user_cancelled", phase, userMessage: "", diagnostics };
    }
    return { source: abortSource ?? "upstream_cleanup", phase, userMessage: "操作已中断，请重试。", diagnostics };
  }

  // 判断是否是 AbortError
  const isAbort =
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "AbortError");

  // AgentExecutionError：解包 cause 找真实错误类型（保留 diagnostics 中的 status 和 cause 链）
  if (err instanceof AgentExecutionError) {
    if (err.cause instanceof Error) {
      return classifyRunError(
        err.cause, abortSource, runId, conversationId, phase, hasToolResults,
      );
    }
  }

  // AgentRuntimeError（E_MODEL_REQUEST_FAILED 等）：映射为用户安全消息，避免泄露 HTTP 原始响应
  if (err instanceof AgentRuntimeError) {
    const safeMessages: Record<string, string> = {
      E_MODEL_REQUEST_FAILED: "模型服务暂时不可用，请稍后重试。",
      E_MODEL_REQUEST_TIMEOUT: "模型响应超时，请稍后重试。",
      E_MODEL_HTTP_ERROR: "模型服务请求失败，请稍后重试。",
      E_MODEL_RESPONSE_PARSE_FAILED: "模型返回格式异常，请重试。",
      E_AGENT_NO_PROGRESS: "请求处理遇到问题，请重试。",
      E_AGENT_GRAPH_ITERATION_LIMIT: "请求处理步骤过多，请简化问题后重试。",
    };
    const userMessage = safeMessages[err.code] ?? "请求处理出错，请重试。";
    // 从消息中提取 HTTP 状态码供诊断（不暴露给用户）
    const httpMatch = err.message.match(/HTTP\s+(\d{3})/);
    if (httpMatch) diagnostics.httpStatus = Number(httpMatch[1]);
    diagnostics.errorCode = err.code;
    return {
      source: abortSource ?? "upstream_cleanup",
      phase,
      userMessage,
      diagnostics,
    };
  }

  if (!isAbort) {
    // 未知 plain Error：使用白名单固定安全消息，绝不展示原始 message
    // （message 可能含 HTTP body、request_id、Authorization 等内部信息）
    return {
      source: abortSource ?? "upstream_cleanup",
      phase,
      userMessage: "请求处理失败，请重试。",
      diagnostics,
    };
  }

  // AbortError：使用触发时记录的 abortSource
  const source = abortSource ?? "unknown_abort" as AbortSource;

  if (source === "user_cancelled") {
    return { source, phase, userMessage: "", diagnostics };
  }
  if (source === "call_timeout") {
    const userMessage = phase === "soul" && hasToolResults
      ? "工具结果已获得，但最终回复生成超时，请重试。"
      : "请求处理超时，请重试。";
    return { source, phase, userMessage, diagnostics };
  }
  return { source, phase, userMessage: "操作已中断，请重试。", diagnostics };
}
