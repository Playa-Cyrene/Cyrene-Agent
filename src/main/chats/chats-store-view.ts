import { CHAT_SCHEMA_VERSION, type ChatSessionRecord, type ChatSession, type ChatMessage } from "../../shared/chat-types";
import { pendingAdjustmentUserMessage } from "../../shared/pending-adjustment";
export function composeSession(record: ChatSessionRecord, messages: ChatMessage[]): ChatSession {
  if (record.schemaVersion === 1)
    return { ...record, messages: [...messages] };
  const { messageCount: _messageCount, schemaVersion: _schemaVersion, ...metadata } = record;
  const restoredMessages = messages.map((message) => {
    if (message.role !== "user")
      return message;
    if (message.id.startsWith("migration:v2:") && message.id.endsWith(":canonical")) {
      return {
        ...message,
        id: message.id.slice("migration:v2:".length, -":canonical".length),
      };
    }
    if (message.id.startsWith("user:v1:") && message.id.endsWith(":r1")) {
      return {
        ...message,
        id: message.id.slice("user:v1:".length, -":r1".length),
      };
    }
    return {
      ...message,
    };
  });
  const ids = new Set(restoredMessages.map((message) => message.id));
  const accepted = (record.pendingMessages ?? []).filter((item) => item.adjustAcceptedAt !== undefined && !ids.has(item.id))
    .sort((left, right) => left.adjustAcceptedAt! - right.adjustAcceptedAt!)
    .map(pendingAdjustmentUserMessage);
  return { ...metadata, messages: [...restoredMessages, ...accepted], schemaVersion: CHAT_SCHEMA_VERSION };
}
