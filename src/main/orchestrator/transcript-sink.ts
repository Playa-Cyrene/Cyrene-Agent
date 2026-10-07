/**
 * Run 级轨迹提交端（CTA Phase 1 Task 4）。
 *
 * 把 Harness / ChatLoop 的 canonical 消息按协议写入 ConversationTranscriptStore：
 * - appendAssistant：assistant 声明先于任何工具 dispatch 落盘（fail-closed 由调用方保证）；
 * - appendToolResult：canonical 工具结果在生命周期 committed 之前落盘；
 * - closeInterruption：从轨迹声明和派发事实补工具闭合条目并写 interruption 边界；
 * - checkpoint：终态后刷新快照（失败上抛，由调用方降级为日志，不改 JSONL）。
 *
 * 幂等：所有 entryId 均由 (runId, 协议点) 确定性生成，
 * 不确定确认后的重试不会复制合成结果或边界。
 * 本文件只含类型与实现逻辑，无任何运行时依赖（store 由调用方注入）。
 */

import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { HarnessRunSession } from "./harness/run-store";
import type { SideEffectKind, TodoItem, ToolCallOutcome } from "./harness/types";
import type { ChatMessage } from "./vendors/types";

/** 轨迹写入失败：failedKind 标记断裂的协议点，cause 保留原始错误。 */
export class TranscriptWriteError extends Error {
  constructor(
    public readonly failedKind:
      | "assistant"
      | "tool_started"
      | "task_state"
      | "effect_resolution"
      | "tool_result"
      | "interruption",
    public readonly cause: unknown,
  ) {
    super(`${failedKind} 轨迹写入失败：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TranscriptWriteError";
  }
}

/** Run 绑定的轨迹提交端：一个 run 一个实例，entryId 全程确定性。 */
export interface TranscriptSink {
  /** 落盘一条 canonical assistant 消息，返回其 entryId（工具结果提交的锚点）。 */
  appendAssistant(input: { message: ChatMessage; roundId?: string }): Promise<string>;
  /** 落盘一条 canonical 工具结果消息（挂在所属 assistant 条目上）。 */
  appendToolResult(input: {
    assistantEntryId: string;
    message: ChatMessage;
    outcome: ToolCallOutcome;
    fullRef?: string;
    roundId?: string;
  }): Promise<void>;
  /** Dispatch boundary, committed after safety checks and before invoking a tool. */
  appendToolStarted?(input: {
    assistantEntryId: string;
    toolCallId: string;
    toolName: string;
    sideEffect: SideEffectKind;
    fingerprint: string;
    repeatAuthorizationId?: string;
  }): Promise<void>;
  /** Latest complete todo state, committed before the successful update_todo result. */
  appendTaskState?(input: {
    assistantEntryId: string;
    toolCallId: string;
    items: TodoItem[];
  }): Promise<void>;
  /** Durable one-shot authorization to repeat an unresolved external effect. */
  appendEffectResolution?(input: {
    assistantEntryId: string;
    effectId: string;
    authorizationId: string;
    fingerprint: string;
    grantedAt: number;
  }): Promise<void>;
  /**
   * 中断终态闭合：从 assistant 声明、tool_started 和已提交结果推导合成结果。
   * reason 区分「用户主动取消」与「系统侧失败/超时」——下一轮模型上下文据此
   * 选择不同姿态（不自行延续 vs 结合新消息决定是否继续）。
   */
  closeInterruption(input: {
    reason: "user_cancel" | "runtime_error";
    runSession: HarnessRunSession | null;
  }): Promise<void>;
  /** Last canonical assistant entry, used by derived presentation writers. */
  getLastAssistantEntryId?(): string | undefined;
}

export function createTranscriptSink(input: {
  store: ConversationTranscriptStore;
  conversationId: string;
  runId: string;
  assistantTurnId?: string;
}): TranscriptSink {
  const { store, conversationId, runId, assistantTurnId } = input;
  // toolCallId → 声明它的 assistant 条目（合成闭合需要锚点）
  const assistantEntryOfCall = new Map<string, string>();
  const startedToolCallIds = new Set<string>();
  // 无 roundId 的 assistant 追加序号（ChatLoop 单轮路径）
  let assistantCounter = 0;
  let lastAssistantEntryId: string | undefined;

  return {
    async appendAssistant({ message, roundId }) {
      const entryId = `${runId}:assistant:${roundId ?? `n${assistantCounter++}`}`;
      for (const call of message.toolCalls ?? []) {
        assistantEntryOfCall.set(call.id, entryId);
      }
      const entry = await store.append(conversationId, {
        kind: "assistant",
        id: entryId,
        at: Date.now(),
        runId,
        ...(assistantTurnId ? { turnId: assistantTurnId } : {}),
        ...(roundId ? { roundId } : {}),
        payload: message,
      });
      lastAssistantEntryId = entry.id;
      return entry.id;
    },

    async appendToolResult({ assistantEntryId, message, outcome, fullRef, roundId }) {
      const toolCallId = message.toolCallId ?? `unknown-${runId}-${assistantEntryId}`;
      await store.append(conversationId, {
        kind: "tool_result",
        id: `${runId}:tool:${toolCallId}`,
        at: Date.now(),
        runId,
        ...(roundId ? { roundId } : {}),
        payload: {
          assistantEntryId,
          toolCallId,
          outcome,
          message,
          ...(fullRef ? { fullRef } : {}),
        },
      });
    },

    async appendToolStarted({
      assistantEntryId,
      toolCallId,
      toolName,
      sideEffect,
      fingerprint,
      repeatAuthorizationId,
    }) {
      if (startedToolCallIds.has(toolCallId)) return;
      await store.append(conversationId, {
        kind: "tool_started",
        id: `${runId}:tool-start:${toolCallId}`,
        at: Date.now(),
        runId,
        ...(assistantTurnId ? { turnId: assistantTurnId } : {}),
        payload: {
          assistantEntryId,
          toolCallId,
          toolName,
          sideEffect,
          fingerprint,
          ...(repeatAuthorizationId ? { repeatAuthorizationId } : {}),
        },
      });
      startedToolCallIds.add(toolCallId);
    },

    async appendTaskState({ assistantEntryId, toolCallId, items }) {
      await store.append(conversationId, {
        kind: "task_state",
        id: `${runId}:task-state:${toolCallId}`,
        at: Date.now(),
        runId,
        ...(assistantTurnId ? { turnId: assistantTurnId } : {}),
        payload: { assistantEntryId, toolCallId, items },
      });
    },

    async appendEffectResolution({ assistantEntryId, effectId, authorizationId, fingerprint, grantedAt }) {
      await store.append(conversationId, {
        kind: "effect_resolution",
        id: `${runId}:effect-resolution:${authorizationId}`,
        at: grantedAt,
        runId,
        ...(assistantTurnId ? { turnId: assistantTurnId } : {}),
        payload: {
          assistantEntryId,
          effectId,
          action: "repeat_authorized",
          authorizationId,
          fingerprint,
          grantedAt,
        },
      });
    },

    async closeInterruption({ reason, runSession }) {
      // 幂等闭合：以权威轨迹为准（限本 run），已有结果的调用不重复补写
      const snapshot = await store.read(conversationId);
      const closedToolCallIds = new Set<string>();
      const declaredCalls = new Map<string, { assistantEntryId: string; toolName: string }>();
      const startedCalls = new Map<string, { assistantEntryId: string; toolName: string }>();
      for (const entry of snapshot.entries) {
        if (entry.kind === "tool_result" && entry.runId === runId) {
          closedToolCallIds.add(entry.payload.toolCallId);
          assistantEntryOfCall.set(entry.payload.toolCallId, entry.payload.assistantEntryId);
        } else if (entry.kind === "assistant" && entry.runId === runId) {
          for (const call of entry.payload.toolCalls ?? []) {
            assistantEntryOfCall.set(call.id, entry.id);
            declaredCalls.set(call.id, { assistantEntryId: entry.id, toolName: call.name });
          }
        }
        if (entry.kind === "tool_started" && entry.runId === runId) {
          startedToolCallIds.add(entry.payload.toolCallId);
          assistantEntryOfCall.set(entry.payload.toolCallId, entry.payload.assistantEntryId);
          startedCalls.set(entry.payload.toolCallId, {
            assistantEntryId: entry.payload.assistantEntryId,
            toolName: entry.payload.toolName,
          });
        }
      }
      // 文案按 reason 区分：取消 vs 系统侧失败（下一轮上下文能分辨两种语义）
      const userCancelled = reason === "user_cancel";
      const legacyCalls = new Map((runSession?.schemaVersion === 1 ? runSession.toolCalls : [])
        .map((call) => [call.toolCallId, call] as const));
      const toolCallIds = new Set([
        ...declaredCalls.keys(),
        ...startedCalls.keys(),
        ...legacyCalls.keys(),
      ]);
      for (const toolCallId of toolCallIds) {
        if (closedToolCallIds.has(toolCallId)) continue;
        const started = startedCalls.get(toolCallId);
        const declared = declaredCalls.get(toolCallId);
        const legacy = legacyCalls.get(toolCallId);
        // 新运行只依赖权威轨迹：tool_started 表示可能已经派发；assistant 声明
        // 没有 tool_started 则表示尚未派发。旧运行再用 v1 的状态文件兜底。
        const wasStarted = Boolean(started) || legacy?.status === "started" || legacy?.status === "unknown";
        const wasDeclared = Boolean(declared) || legacy?.status === "planned";
        const outcome: ToolCallOutcome | undefined = wasStarted
          ? "unknown"
          : wasDeclared
            ? "not_executed"
            : undefined;
        if (!outcome) continue;
        const toolName = started?.toolName ?? declared?.toolName ?? legacy?.toolName ?? "unknown_tool";
        const assistantEntryId = started?.assistantEntryId
          ?? declared?.assistantEntryId
          ?? assistantEntryOfCall.get(toolCallId)
          ?? "unknown-assistant";
        const message: ChatMessage = {
          role: "tool",
          toolCallId,
          name: toolName,
          content: JSON.stringify({
            outcome,
            tool: toolName,
            message: outcome === "unknown"
              ? (userCancelled ? "工具执行中被取消，结果未知" : "上一轮系统错误，工具已启动但结果未知")
              : (userCancelled ? "取消时未开始执行" : "上一轮系统错误时未开始执行"),
          }),
        };
        await store.append(conversationId, {
          kind: "tool_result",
          id: `${runId}:tool-close:${assistantEntryId}:${toolCallId}`,
          at: Date.now(),
          runId,
          payload: { assistantEntryId, toolCallId, outcome, message },
        });
      }
      await store.append(conversationId, {
        kind: "interruption",
        id: `${runId}:interruption:${reason}`,
        at: Date.now(),
        runId,
        payload: { reason },
      });
    },

    getLastAssistantEntryId() {
      return lastAssistantEntryId;
    },
  };
}
