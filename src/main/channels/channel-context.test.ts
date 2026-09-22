import { describe, expect, it, vi } from "vitest";
import {
  createChannelContext,
  formatChannelUserText,
  lookupOriginalSender,
  makeSessionId,
  resolveChannelConversationTarget,
} from "./channel-context";
import type { IncomingMessage } from "./types";

function makeIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channel: "qq",
    chatType: "private",
    senderId: "user-1",
    senderName: "测试用户",
    chatId: "chat-1",
    text: "你好",
    at: new Date(0),
    ...overrides,
  };
}

describe("渠道上下文", () => {
  it("绑定渠道使用桌面对话 journal，未绑定渠道使用逻辑 channel sessionId", () => {
    expect(resolveChannelConversationTarget({
      sessionId: "channel:wechat:private:42",
      boundConversationId: "desktop-1",
    })).toEqual({ conversationId: "desktop-1" });
    expect(resolveChannelConversationTarget({
      sessionId: "channel:wechat:private:42",
      boundConversationId: null,
    })).toEqual({ conversationId: "channel:wechat:private:42" });
  });
  it("为同一渠道会话生成稳定标识", () => {
    expect(makeSessionId("feishu", "ou_abc123"))
      .toBe(makeSessionId("feishu", "ou_abc123"));
  });

  it("隔离不同渠道和不同聊天", () => {
    expect(makeSessionId("feishu", "user-x"))
      .not.toBe(makeSessionId("wechat", "user-x"));
    expect(makeSessionId("qq", "10001"))
      .not.toBe(makeSessionId("qq", "10002"));
  });

  it("生成带渠道前缀和 16 位摘要的标识", () => {
    expect(makeSessionId("feishu", "ou_abc"))
      .toMatch(/^channel:feishu:[0-9a-f]{16}$/);
  });

  it("未知会话无法反查发送者", () => {
    expect(lookupOriginalSender("channel:feishu:0000000000000000")).toBeNull();
  });

  it("群聊文本保留发送者和引用上下文", () => {
    expect(formatChannelUserText(makeIncoming({
      chatType: "group",
      senderId: "10001",
      senderName: "小明",
      chatId: "20001",
      text: "你好",
      reply: {
        messageId: "message-1",
        senderId: "10002",
        senderName: "小红",
        text: "前一条消息",
      },
    }))).toBe("[群聊发送者：小明 (10001)]\n引用 小红：前一条消息\n你好");
  });

  it("记录会话时迁移旧发送者键并支持反查", () => {
    const migrateHistory = vi.fn();
    const context = createChannelContext({
      migrateHistory,
    });
    const msg = makeIncoming({
      channel: "feishu",
      senderId: "ou_sender",
      chatId: "oc_chat",
    });
    const sessionId = makeSessionId(msg.channel, msg.chatId);

    context.recordIncomingSession(msg, { sessionId, boundConversationId: null });

    expect(migrateHistory).toHaveBeenCalledWith(
      makeSessionId("feishu", "ou_sender"),
      sessionId,
    );
    expect(lookupOriginalSender(sessionId)).toEqual({
      channel: "feishu",
      senderId: "ou_sender",
    });
  });

});
