import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../shared/chat-types";
import type { ModelSettings } from "../settings/model-settings";
import { createConversationTitleService } from "./conversation-title-service";

const settings = {
  provider: "openai",
  baseUrl: "https://example.test/v1",
  model: "title-model",
  apiKey: "test-key",
} as ModelSettings;

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-a",
    title: "新对话",
    identityId: null,
    messages: [{
      id: "user-1",
      role: "user",
      content: "帮我设计一个待办事项管理应用",
      at: 1,
    }],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    mode: "work",
    ...overrides,
  };
}

/**
 * 覆盖"不守着会话"的后台生成语义：
 * 标题服务运行在主进程，schedule 时 sessionId 已固定，
 * 渲染端切走会话不应影响生成的触发、执行与写回。
 */
describe("conversation title service — 发出消息后切走会话", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("发出首条消息后立刻切到其他会话并发消息，两个会话各自恰好生成一次且标题写回原会话", async () => {
    vi.useFakeTimers();
    let storedA = session({ id: "session-a" });
    let storedB = session({ id: "session-b", messages: [{ id: "user-b1", role: "user" as const, content: "B 会话的首条消息", at: 1 }] });
    const modelCalls: string[] = [];
    const writes: Array<{ sessionId: string; title: string }> = [];
    const service = createConversationTitleService({
      getSession: (id) => (id === "session-a" ? storedA : id === "session-b" ? storedB : null),
      setGeneratedTitle: (id, _messageId, title) => {
        writes.push({ sessionId: id, title });
        if (id === "session-a") storedA = { ...storedA, title };
        else storedB = { ...storedB, title };
        return true;
      },
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async () => {
          modelCalls.push("call");
          return { text: "待办应用设计", finishReason: "stop" };
        },
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    // 用户在 A 发出首条消息（对应主进程 CHATS_PENDING_CLAIM 触发 schedule）
    expect((await service.schedule({
      sessionId: "session-a",
      userMessageId: "user-1",
      text: "帮我设计一个待办事项管理应用",
    }))).toBe(true);
    // 立刻切到 B 并在 B 发消息：B 的操作不应挤掉 A 的后台生成
    expect((await service.schedule({
      sessionId: "session-b",
      userMessageId: "user-b1",
      text: "B 会话的首条消息",
    }))).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(modelCalls).toHaveLength(2);
    expect(writes.map((write) => write.sessionId).sort()).toEqual(["session-a", "session-b"]);
    expect(storedA.title).toBe("待办应用设计");
    expect(storedB.title).toBe("待办应用设计");
  });

  it("生成期间原会话收到 agent 回复（消息数增长），仍恰好调用一次模型并写回原会话", async () => {
    vi.useFakeTimers();
    let stored = session();
    const modelCalls: string[] = [];
    const writes: Array<{ sessionId: string; userMessageId: string }> = [];
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: (id, userMessageId, _title) => {
        writes.push({ sessionId: id, userMessageId });
        return true;
      },
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async () => {
          modelCalls.push("call");
          return { text: "待办应用设计", finishReason: "stop" };
        },
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    (await service.schedule({
      sessionId: stored.id,
      userMessageId: "user-1",
      text: "帮我设计一个待办事项管理应用",
    }));
    // 延迟窗口内 agent 回复完成落盘：会话消息增长（用户已切走，主进程照常写入）
    stored = {
      ...stored,
      messages: [...stored.messages, { id: "assistant-1", role: "assistant" as const, content: "好的，方案如下……", at: 2 }],
      updatedAt: 2,
    };

    await vi.advanceTimersByTimeAsync(3_000);
    expect(modelCalls).toHaveLength(1);
    expect(writes).toEqual([{ sessionId: "session-a", userMessageId: "user-1" }]);
  });

  it("切走后原会话被删除（ getSession 返回 null ），不再发起模型调用", async () => {
    vi.useFakeTimers();
    let stored: ChatSession | null = session();
    const modelCalls: string[] = [];
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: () => true,
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async () => {
          modelCalls.push("call");
          return { text: "待办应用设计", finishReason: "stop" };
        },
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    (await service.schedule({
      sessionId: "session-a",
      userMessageId: "user-1",
      text: "帮我设计一个待办事项管理应用",
    }));
    // 延迟窗口内用户在其他会话里删掉了 A
    stored = null;

    await vi.advanceTimersByTimeAsync(3_000);
    expect(modelCalls).toHaveLength(0);
  });
});
