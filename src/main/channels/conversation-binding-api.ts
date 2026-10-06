import type { ChatSessionMeta } from "../../shared/chat-types";
import type {
  ChannelConversationBindingSnapshot,
  ChannelConversationBindingStore,
} from "./conversation-binding-store";

export interface ContextConversationSummary {
  id: string;
  title: string;
  mode: string;
  updatedAt: number;
}

export interface ContextBindingSnapshot extends ChannelConversationBindingSnapshot {
  conversations: ContextConversationSummary[];
}

export interface ContextBindingResult {
  ok: boolean;
  error?: string;
}

export function getContextBindingSnapshot(
  store: ChannelConversationBindingStore,
  sessions: ChatSessionMeta[] | ContextConversationSummary[],
): ContextBindingSnapshot {
  const snapshot = store.list();
  return {
    externalChats: snapshot.externalChats,
    bindings: snapshot.bindings,
    conversations: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      mode: session.mode ?? "work",
      updatedAt: session.updatedAt,
    })),
  };
}

export async function bindContextConversation(
  store: ChannelConversationBindingStore,
  payload: unknown,
  conversationExists: (conversationId: string) => boolean | Promise<boolean>,
): Promise<ContextBindingResult> {
  if (!payload || typeof payload !== "object") return { ok: false, error: "请求格式无效" };
  const value = payload as { sessionId?: unknown; conversationId?: unknown };
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 128) {
    return { ok: false, error: "外部聊天标识无效" };
  }
  if (typeof value.conversationId !== "string" || value.conversationId.length === 0 || value.conversationId.length > 128) {
    return { ok: false, error: "桌面对话标识无效" };
  }
  if (!store.list().externalChats.some((chat) => chat.sessionId === value.sessionId)) {
    return { ok: false, error: "外部聊天不存在" };
  }
  if (!conversationExists(value.conversationId)) return { ok: false, error: "桌面对话不存在" };
  try {
    store.bind(value.sessionId, value.conversationId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function unbindContextConversation(
  store: ChannelConversationBindingStore,
  sessionId: unknown,
): ContextBindingResult {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
    return { ok: false, error: "外部聊天标识无效" };
  }
  store.unbind(sessionId);
  return { ok: true };
}
