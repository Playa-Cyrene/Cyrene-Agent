import type { ChatMessage, PendingChatMessage } from "./chat-types";

/** 展示与最终轨迹共用标识；待注入期间只是持久化队列的消息投影。 */
export function pendingAdjustmentUserMessage(item: PendingChatMessage): ChatMessage {
  return {
    id: item.id,
    role: "user",
    content: item.visibleContent,
    at: item.adjustAcceptedAt ?? item.enqueuedAt,
    ...(item.userSticker ? { sticker: item.userSticker } : {}),
  };
}
