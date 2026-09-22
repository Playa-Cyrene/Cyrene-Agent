import { createHash } from "crypto";
import type { ChannelId, IncomingMessage } from "./types";

const LOG = "[ChannelContext]";

/** 单条入站消息已经确定的上下文快照。 */
export interface DispatchContext {
  sessionId: string;
  boundConversationId: string | null;
}

/** 队列内冻结的会话目标；后续绑定变化不得影响本轮 journal。 */
export interface ChannelConversationTarget {
  conversationId: string;
  boundConversationId?: string;
}

export function resolveChannelConversationTarget(
  context: DispatchContext,
): ChannelConversationTarget {
  return context.boundConversationId
    ? { conversationId: context.boundConversationId }
    : { conversationId: context.sessionId };
}

export interface ChannelContext {
  /** 解析一次绑定并生成本条消息使用的上下文快照。 */
  resolveDispatchContext(sessionId: string): DispatchContext;
  /** 迁移旧历史键并记录会话与原始发送者的关系。 */
  recordIncomingSession(msg: IncomingMessage, context: DispatchContext): void;
}

export interface CreateChannelContextOptions {
  resolveBoundConversationId?: (sessionId: string) => string | null;
  migrateHistory: (fromSessionId: string, toSessionId: string) => void;
}

/** 会话标识到原始发送者的调试索引。 */
const sessionIndex = new Map<
  string,
  { channel: ChannelId; senderId: string; lastAt: number }
>();

/** 计算稳定且匿名的渠道会话标识。 */
export function makeSessionId(channel: ChannelId, chatId: string): string {
  const hash = createHash("sha256")
    .update(`${channel}:${chatId}`)
    .digest("hex")
    .slice(0, 16);
  return `channel:${channel}:${hash}`;
}

/** 生成供模型和渠道历史使用的用户文本。 */
export function formatChannelUserText(msg: IncomingMessage): string {
  if (msg.chatType !== "group") return msg.text;
  const sender = msg.senderName
    ? `${msg.senderName} (${msg.senderId})`
    : msg.senderId;
  const reply = msg.reply?.text
    ? `\n引用 ${msg.reply.senderName || msg.reply.senderId || "未知用户"}：${msg.reply.text}`
    : "";
  return `[群聊发送者：${sender}]${reply}\n${msg.text}`;
}

/** 按会话标识反查原始发送者，仅用于调试。 */
export function lookupOriginalSender(
  sessionId: string,
): { channel: ChannelId; senderId: string } | null {
  const entry = sessionIndex.get(sessionId);
  return entry ? { channel: entry.channel, senderId: entry.senderId } : null;
}

export function createChannelContext(
  options: CreateChannelContextOptions,
): ChannelContext {
  return {
    resolveDispatchContext(sessionId): DispatchContext {
      let requestedBoundConversationId: string | null = null;
      try {
        requestedBoundConversationId = options.resolveBoundConversationId?.(sessionId) ?? null;
      } catch (err) {
        // 绑定存储故障不能阻断渠道消息，当前消息退回独立渠道上下文。
        console.warn(LOG, "绑定查询失败，继续使用渠道上下文:", err);
      }

      return {
        sessionId,
        boundConversationId: requestedBoundConversationId,
      };
    },

    recordIncomingSession(msg, context): void {
      options.migrateHistory(
        makeSessionId(msg.channel, msg.senderId),
        context.sessionId,
      );
      recordSession(msg.channel, msg.senderId, context.sessionId);
    },

  };
}

/** 更新调试索引，并限制进程内缓存规模。 */
function recordSession(
  channel: ChannelId,
  senderId: string,
  sessionId: string,
): void {
  sessionIndex.set(sessionId, { channel, senderId, lastAt: Date.now() });
  if (sessionIndex.size <= 5000) return;

  const oldest = [...sessionIndex.entries()]
    .sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
  if (oldest) sessionIndex.delete(oldest[0]);
}
