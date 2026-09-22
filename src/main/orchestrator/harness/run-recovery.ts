import type { ToolCall } from "../vendors/types";
import { toolCallFingerprint, type AgentState, type HarnessCacheState, type UncertainEffect } from "./types";
import type { HarnessRunSession } from "./run-store";

export interface HarnessRecoveryEnvironment {
  conversationId?: string;
  workspaceRoot?: string;
  provider?: string;
  model?: string;
  enabledToolIds?: string[];
  promptFingerprint?: string;
  toolSchemaFingerprint?: string;
}

export interface PreparedHarnessRecoveryState {
  state: AgentState;
  cacheState: HarnessCacheState;
  recoveryContext?: string;
  uncertainEffects: UncertainEffect[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findPersistedToolCall(session: HarnessRunSession, toolCallId: string): ToolCall | undefined {
  let found: ToolCall | undefined;
  for (const message of session.messages) {
    const call = message.toolCalls?.find((candidate) => candidate.id === toolCallId);
    if (call) found = call;
  }
  return found;
}

function fingerprintPersistedCall(session: HarnessRunSession, toolCallId: string, toolName: string): string {
  const call = findPersistedToolCall(session, toolCallId);
  // 不确定参数时使用按工具名的 fail-safe 标记；uncertain-effect-guard 会阻止该工具的任何重试。
  if (!call || call.name !== toolName) return `${toolName}(*)`;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `${toolName}(*)`;
    return toolCallFingerprint(toolName, parsed as Record<string, unknown>);
  } catch {
    return `${toolName}(*)`;
  }
}

/**
 * 只恢复 Harness 的执行状态，不重放或修补旧 run 的消息。
 * 会话消息始终由 journal 提供；这里仅消费 runStore 的状态、缓存和工具执行分类。
 */
export function prepareHarnessRecoveryState(
  session: HarnessRunSession,
  environment: HarnessRecoveryEnvironment,
): PreparedHarnessRecoveryState {
  if (session.status !== "interrupted") throw new Error("HARNESS_RECOVERY_NOT_INTERRUPTED");
  if (environment.conversationId && environment.conversationId !== session.conversationId) {
    throw new Error("HARNESS_RECOVERY_CONVERSATION_MISMATCH");
  }
  if (session.request.workspaceRoot && environment.workspaceRoot !== session.request.workspaceRoot) {
    throw new Error("HARNESS_RECOVERY_WORKSPACE_MISMATCH");
  }

  const state = clone(session.state);
  const differences: string[] = [];
  if ((environment.provider && environment.provider !== session.request.provider)
    || (environment.model && environment.model !== session.request.model)) {
    differences.push(`模型已变化：原为 ${session.request.provider}/${session.request.model}，当前为 ${environment.provider ?? session.request.provider}/${environment.model ?? session.request.model}。`);
  }
  const previousToolIds = session.request.enabledToolIds ?? [];
  if (environment.enabledToolIds && previousToolIds.length > 0) {
    const currentTools = new Set(environment.enabledToolIds);
    const missing = previousToolIds.filter((id) => !currentTools.has(id));
    if (missing.length > 0) differences.push(`恢复时不可用的旧工具：${missing.join(", ")}。不得假装调用成功。`);
  }
  if (environment.promptFingerprint && environment.promptFingerprint !== session.request.promptFingerprint) {
    differences.push("恢复时提示词指纹已变化，缓存上下文将重新建立。");
  }
  if (environment.toolSchemaFingerprint && environment.toolSchemaFingerprint !== session.request.toolSchemaFingerprint) {
    differences.push("恢复时工具目录指纹已变化，缓存上下文将重新建立。");
  }

  const plannedTools: string[] = [];
  for (const persisted of session.toolCalls) {
    if (persisted.status === "planned") {
      plannedTools.push(persisted.toolName);
      continue;
    }
    if (persisted.status !== "started" && persisted.status !== "unknown") continue;
    if (persisted.sideEffect !== "non_idempotent_side_effect") continue;
    if (!state.uncertainEffects.some((effect) => effect.toolCallId === persisted.toolCallId)) {
      state.uncertainEffects.push({
        id: `${session.runId}:${persisted.toolCallId}`,
        toolCallId: persisted.toolCallId,
        fingerprint: fingerprintPersistedCall(session, persisted.toolCallId, persisted.toolName),
        toolName: persisted.toolName,
        message: "该外部副作用在应用中断时尚未确认结果",
      });
    }
  }

  return {
    state,
    cacheState: { cacheEpoch: session.cache.cacheEpoch + 1, epochReason: "recovery" },
    recoveryContext: [
      `这是从意外中断的运行 ${session.runId} 恢复的任务。`,
      `已完成轮数：${session.rounds}；Todo 是可变工作笔记，应据真实进展更新。`,
      "中断中的外部副作用已标为未知：不得自动重放，必须先查证、询问用户，或诚实说明无法确认。",
      ...(plannedTools.length > 0 ? [`尚未启动的工具调用（${plannedTools.join(", ")}）保持 not_executed，不自动执行。`] : []),
      ...differences,
    ].join("\n"),
    uncertainEffects: clone(state.uncertainEffects),
  };
}
