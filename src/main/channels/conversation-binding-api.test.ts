import { describe, expect, it } from "vitest";
import { makeSessionId } from "./dispatcher";
import { ChannelConversationBindingStore } from "./conversation-binding-store";
import {
  bindContextConversation,
  getContextBindingSnapshot,
  unbindContextConversation,
} from "./conversation-binding-api";

function makeStore() {
  const store = new ChannelConversationBindingStore(`${process.env.TEMP ?? "/tmp"}/cyrene-binding-api-${Date.now()}-${Math.random()}.json`);
  const sessionId = makeSessionId("qq", "chat-1");
  store.observe({ sessionId, channel: "qq", chatId: "chat-1", chatType: "private", lastAt: 1 });
  return { store, sessionId };
}

describe("conversation binding IPC API", () => {
  it("returns metadata only and includes available conversations", async () => {
    const { store, sessionId } = makeStore();
    const result = getContextBindingSnapshot(store, [
      { id: "conversation-1", title: "主线", mode: "chat", updatedAt: 10 },
    ]);
    expect(result.externalChats[0].sessionId).toBe(sessionId);
    expect(result.conversations).toEqual([
      { id: "conversation-1", title: "主线", mode: "chat", updatedAt: 10 },
    ]);
    expect(result).not.toHaveProperty("messages");
  });

  it("rejects unknown external chats and missing conversations", async () => {
    const { store, sessionId } = makeStore();
    expect(await bindContextConversation(store, { sessionId: "unknown", conversationId: "conversation-1" }, () => true)).toEqual({ ok: false, error: "外部聊天不存在" });
    expect(await bindContextConversation(store, { sessionId, conversationId: "missing" }, () => false)).toEqual({ ok: false, error: "桌面对话不存在" });
  });

  it("binds only validated ids and unbinds the selected external chat", async () => {
    const { store, sessionId } = makeStore();
    const secondSessionId = makeSessionId("wechat", "chat-2");
    store.observe({ sessionId: secondSessionId, channel: "wechat", chatId: "chat-2", chatType: "private", lastAt: 2 });
    expect(await bindContextConversation(store, { sessionId, conversationId: "conversation-1" }, () => true)).toEqual({ ok: true });
    expect(await bindContextConversation(store, { sessionId: secondSessionId, conversationId: "conversation-2" }, () => true)).toEqual({ ok: true });
    expect(unbindContextConversation(store, sessionId)).toEqual({ ok: true });
    expect(store.resolve(sessionId)).toBeNull();
    expect(store.resolve(secondSessionId)).toBe("conversation-2");
  });
});
