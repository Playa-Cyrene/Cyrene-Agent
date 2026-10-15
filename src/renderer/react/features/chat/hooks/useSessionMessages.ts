import { useState } from "react";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerAttachment } from "../components/ChatComposer";
import type { ConversationMode } from "../../../../../shared/chat-types";
import { isConversationMode } from "../pages/chat-page-normalizers";
import { hydrateSessionMessages, patchSessionMessage } from "../pages/session-runtime-state";

export interface SessionMessagesApi {
  /** 按会话 id 存储的渲染态消息 */
  messagesBySession: Record<string, ChatMessageItem[]>;
  /**
   * 消息补丁通道：targetScope 传会话 id 时直接路由；
   * 传模式时先按消息 id 全局查找归属会话，找不到再回退该模式的激活会话。
   */
  patchMessage: (targetScope: ConversationMode | string, id: string, patch: Partial<ChatMessageItem>) => void;
  /** 会话切换/重载：存储态消息灌入渲染态；该会话有活跃 run 且已有渲染态时保留现状 */
  hydrateMessages: (sessionId: string, storedMessages: ChatMessageItem[], hasActiveRun: boolean) => void;
  /** 编辑重发：截断结果 + 新助手占位整体替换该会话的消息 */
  replaceSessionMessages: (sessionId: string, next: ChatMessageItem[]) => void;
  /** 发送：向该会话追加用户消息与助手占位 */
  appendMessages: (sessionId: string, items: ChatMessageItem[]) => void;
  /** 附件预处理结果写回消息上的附件条目（附件域注入的消息通道） */
  patchMessageAttachments: (
    sessionId: string,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) => void;
}

/**
 * 消息域：渲染态消息按会话存储。
 * 写路径收口为补丁、灌入、整体替换、追加四种；读取直接暴露 messagesBySession。
 * 模式路由的兜底（激活会话）由外部注入 getter，hook 不持有会话选择状态。
 */
export function useSessionMessages(
  getActiveSessionId: (mode: ConversationMode) => string | undefined,
): SessionMessagesApi {
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessageItem[]>>({});

  function patchMessage(targetScope: ConversationMode | string, id: string, patch: Partial<ChatMessageItem>) {
    setMessagesBySession((current) => {
      const ownerSessionId = isConversationMode(targetScope)
        ? Object.entries(current).find(([, items]) => items.some((item) => item.id === id))?.[0]
          ?? getActiveSessionId(targetScope)
        : targetScope;
      return ownerSessionId ? patchSessionMessage(current, ownerSessionId, id, patch) : current;
    });
  }

  function hydrateMessages(sessionId: string, storedMessages: ChatMessageItem[], hasActiveRun: boolean) {
    setMessagesBySession((current) => hydrateSessionMessages(current, sessionId, storedMessages, hasActiveRun));
  }

  function replaceSessionMessages(sessionId: string, next: ChatMessageItem[]) {
    setMessagesBySession((current) => ({ ...current, [sessionId]: next }));
  }

  function appendMessages(sessionId: string, items: ChatMessageItem[]) {
    setMessagesBySession((current) => {
      const existing = current[sessionId] ?? [];
      const ids = new Set(existing.map((item) => item.id));
      const additions = items.filter((item) => {
        if (ids.has(item.id)) return false;
        ids.add(item.id);
        return true;
      });
      return additions.length ? { ...current, [sessionId]: [...existing, ...additions] } : current;
    });
  }

  function patchMessageAttachments(
    sessionId: string,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) => (
        item.id === messageId
          ? { ...item, attachments: updater(item.attachments ?? []) }
          : item
      )),
    }));
  }

  return {
    messagesBySession,
    patchMessage,
    hydrateMessages,
    replaceSessionMessages,
    appendMessages,
    patchMessageAttachments,
  };
}
