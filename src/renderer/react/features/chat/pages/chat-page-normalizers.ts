import type { ChatMessageChannelSource, ChatSession, ConversationMode } from "../../../../../shared/chat-types";
import type { ChatMessageItem } from "../components/ChatMessageList";
import {
  describePermissionRequest,
  type AgentRunStage,
  type ComposerInteraction,
} from "../components/run-presentation";
import type { WeatherData } from "../components/weather/weather-types";
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

export function normalizeWeatherData(value: unknown): WeatherData | undefined {
  const card = asRecord(value);
  if (!card) return undefined;

  const source = asNonEmptyString(card.source);
  const location = asRecord(card.location);
  const province = asNonEmptyString(location?.province);
  const city = asNonEmptyString(location?.city);
  const temp = typeof card.temp === "number" ? card.temp : undefined;
  const humidity = typeof card.humidity === "number" ? card.humidity : undefined;

  if (!source || !province || !city || temp === undefined || humidity === undefined) {
    return undefined;
  }

  if (source === "open-meteo") {
    const weatherCode = typeof card.weatherCode === "number" ? card.weatherCode : undefined;
    const windDeg = typeof card.windDeg === "number" ? card.windDeg : undefined;
    const windSpeed = typeof card.windSpeed === "number" ? card.windSpeed : undefined;
    if (weatherCode === undefined || windDeg === undefined || windSpeed === undefined) return undefined;
    return {
      source: "open-meteo",
      location: { province, city },
      weatherCode,
      temp,
      feelsLike: typeof card.feelsLike === "number" ? card.feelsLike : temp,
      humidity,
      windDeg,
      windSpeed,
      precipitation: typeof card.precipitation === "number" ? card.precipitation : 0,
      pressure: typeof card.pressure === "number" ? card.pressure : 0,
    };
  }

  if (source === "amap") {
    const weather = asNonEmptyString(card.weather);
    const windDirection = asNonEmptyString(card.windDirection);
    const windPower = asNonEmptyString(card.windPower);
    const reporttime = asNonEmptyString(card.reporttime);
    if (!weather || !windDirection || !windPower || !reporttime) return undefined;
    return {
      source: "amap",
      location: { province, city },
      weather,
      temp,
      humidity,
      windDirection,
      windPower,
      reporttime,
    };
  }

  return undefined;
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
      modelContext: message.modelContext,
      channelSource: normalizeChannelSource(message.channelSource),
      reasoning: message.reasoning,
      reasoningBlocks: message.reasoningBlocks,
      processMessages: message.processMessages,
      agentRounds: message.agentRounds,
      runActivity: message.runActivity,
      ttsCacheKey: message.ttsCacheKey,
      ttsCacheVersion: message.ttsCacheVersion,
      responseStarted: message.role === "model" && Boolean(message.content.trim() || message.sticker),
      sticker: message.sticker,
      toolExecutions: message.toolExecutions,
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
