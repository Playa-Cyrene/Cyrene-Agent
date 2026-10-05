import type { ChatMessageChannelSource, ChatSession, ConversationMode } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";
import {
  describePermissionRequest,
  type AgentRunStage,
  type ComposerInteraction,
} from "../components/run-presentation";
import type { PermissionApprovalRequest } from "./chat-page-bridge";
import { recoverInterruptedMessage } from "./session-runtime-state";

const CONVERSATION_MODES: readonly ConversationMode[] = ["chat", "work", "code", "learn"];
const CHAT_MESSAGE_CHANNELS = new Set<ChatMessageChannelSource["channel"]>(["wechat", "feishu", "qq", "qqbot"]);
/** 最后停留模式的 localStorage 键：写入方（ChatPage）与读取方（getInitialMode）共用同一常量。 */
export const LAST_MODE_STORAGE_KEY = "cyrene-react-last-mode";

export function isConversationMode(value: string): value is ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode);
}

function normalizeChannelSource(value: unknown): ChatMessageChannelSource | undefined {
  const record = asRecord(value);
  if (!record || typeof record.channel !== "string" || !CHAT_MESSAGE_CHANNELS.has(record.channel as ChatMessageChannelSource["channel"])) {
    return undefined;
  }
  const senderName = asNonEmptyString(record.senderName);
  const chatType = record.chatType === "private" || record.chatType === "group"
    ? record.chatType
    : undefined;
  return {
    channel: record.channel as ChatMessageChannelSource["channel"],
    ...(chatType ? { chatType } : {}),
    ...(senderName ? { senderName } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseSessionRunActiveError(message: string): string | undefined {
  // Electron 会给 invoke 拒绝包一层 "Error invoking remote method 'agui:run': Error: ..."，
  // 守卫前缀不一定在消息开头；按 runId 模式匹配，顺带避免普通文本误触发。
  return /SESSION_RUN_ACTIVE:(run-[A-Za-z0-9-]+)/.exec(message)?.[1];
}

export function permissionInteraction(request: PermissionApprovalRequest): ComposerInteraction {
  const target = [request.args.path, request.args.filePath]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    kind: "permission",
    id: request.id,
    toolName: request.toolName || request.toolId,
    summary: describePermissionRequest(request),
    targetPath: target,
  };
}

export function stageForStep(stepName: string | undefined): AgentRunStage | undefined {
  if (stepName === "agent-graph-action-gate") return { kind: "understanding" };
  if (stepName === "agent-graph-plan") return { kind: "planning" };
  if (stepName === "agent-graph-soul") return { kind: "responding" };
  if (stepName?.startsWith("agent-graph-tool-")) {
    return { kind: "executing", detail: stepName.slice("agent-graph-tool-".length) };
  }
  return undefined;
}

export function toUiMessages(session: ChatSession): ChatMessageItem[] {
  return session.messages.map((message) => {
    const item: ChatMessageItem = {
      id: message.id,
      role: message.role === "model" ? "assistant" : "user",
      content: message.content,
      compaction: message.compaction,
      modelContext: message.modelContext,
      channelSource: normalizeChannelSource(message.channelSource),
      at: message.at,
      reasoning: message.reasoning,
      reasoningBlocks: message.reasoningBlocks,
      processMessages: message.processMessages,
      agentRounds: message.agentRounds,
      taskDelegations: message.taskDelegations,
      runActivity: message.runActivity,
      ttsCacheKey: message.ttsCacheKey,
      ttsCacheVersion: message.ttsCacheVersion,
      responseStarted: message.role === "model" && Boolean(message.content.trim() || message.sticker),
      sticker: message.sticker,
      toolExecutions: message.toolExecutions,
      emailDraftCards: message.emailDraftCards?.map((card) => card.status === "sending" ? { ...card, status: "unknown" } : card),
      attachments: message.attachments,
      contextUsage: message.contextUsage,
      runId: message.runSnapshot?.runId,
      runSnapshot: message.runSnapshot,
    };
    return message.runSnapshot ? recoverInterruptedMessage(item, message.runSnapshot) : item;
  });
}

export function getInitialMode(): ConversationMode {
  try {
    const saved = localStorage.getItem(LAST_MODE_STORAGE_KEY);
    if (saved && isConversationMode(saved)) return saved;
  } catch {
    // localStorage 不可用或数据异常时回退到默认值
  }
  return "chat";
}
