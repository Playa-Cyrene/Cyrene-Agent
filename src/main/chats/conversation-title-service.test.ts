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
    id: "session-1",
    title: "帮我设计一个待办事项管理应用",
    identityId: null,
    messages: [{
      id: "user-1",
      role: "user",
      content: "帮我设计一个待办事项管理应用[sticker:wave]",
      at: 1,
      attachments: [{
        kind: "image",
        name: "reference.png",
        filePath: "C:\\tmp\\reference.png",
        mime: "image/png",
        status: "pending",
      }],
    }],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    mode: "work",
    ...overrides,
  };
}

describe("conversation title service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits before generating from only the first user's visible text", async () => {
    vi.useFakeTimers();
    let stored = session();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const temperatures: Array<number | undefined> = [];
    const reasoningOverrides: Array<ModelSettings["reasoning"]> = [];
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: (_id, _messageId, title) => {
        stored = { ...stored, title };
        return true;
      },
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async (_settings, messages, temperature, _timeout, _label, reasoningOverride) => {
          requests.push(messages);
          temperatures.push(temperature);
          reasoningOverrides.push(reasoningOverride);
          return { text: "待办应用设计", finishReason: "stop" };
        },
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    expect(service.schedule({
      sessionId: stored.id,
      userMessageId: "user-1",
      text: "帮我设计一个待办事项管理应用",
    })).toBe(true);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.at(-1)).toEqual({
      role: "user",
      content: "帮我设计一个待办事项管理应用",
    });
    expect(requests[0]?.map((message) => message.content).join("\n")).not.toContain("reference.png");
    expect(requests[0]?.map((message) => message.content).join("\n")).not.toContain("sticker:wave");
    expect(temperatures).toEqual([undefined]);
    expect(reasoningOverrides).toEqual([{ mode: "off" }]);
    expect(stored.title).toBe("待办应用设计");
  });

  it("schedules a session only once even when persistence paths report it repeatedly", () => {
    vi.useFakeTimers();
    const stored = session();
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: () => true,
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async () => ({ text: "待办应用设计", finishReason: "stop" }),
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });
    const request = { sessionId: stored.id, userMessageId: "user-1", text: "帮我设计一个待办事项管理应用" };

    expect(service.schedule(request)).toBe(true);
    expect(service.schedule(request)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("removes common model wrappers before persisting a valid title", async () => {
    vi.useFakeTimers();
    let stored = session();
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: (_id, _messageId, title) => {
        stored = { ...stored, title };
        return true;
      },
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async () => ({ text: "标题：**「待办应用设计」**\n", finishReason: "stop" }),
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    service.schedule({ sessionId: stored.id, userMessageId: "user-1", text: "帮我设计待办应用" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(stored.title).toBe("待办应用设计");
  });

  it("keeps the temporary title when the model output is outside 5-8 characters", async () => {
    vi.useFakeTimers();
    const stored = session();
    let writes = 0;
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: () => {
        writes += 1;
        return true;
      },
      resolveSettings: () => settings,
      llmClient: {
        chatNonStream: async () => ({ text: "待办", finishReason: "stop" }),
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    service.schedule({ sessionId: stored.id, userMessageId: "user-1", text: "帮我设计待办应用" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(writes).toBe(0);
    expect(stored.title).toBe("帮我设计一个待办事项管理应用");
  });

  it("does not send a background request when the session has no usable model endpoint", async () => {
    vi.useFakeTimers();
    const stored = session();
    let requests = 0;
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: () => true,
      resolveSettings: () => ({ ...settings, baseUrl: "" }),
      llmClient: {
        chatNonStream: async () => {
          requests += 1;
          return { text: "待办应用设计", finishReason: "stop" };
        },
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    service.schedule({ sessionId: stored.id, userMessageId: "user-1", text: "帮我设计待办应用" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(requests).toBe(0);
  });

  it("waits until the primary conversation run is idle before entering the background queue", async () => {
    vi.useFakeTimers();
    const stored = session();
    let busy = true;
    let requests = 0;
    const service = createConversationTitleService({
      getSession: () => stored,
      setGeneratedTitle: () => true,
      resolveSettings: () => settings,
      isPrimaryModelBusy: () => busy,
      llmClient: {
        chatNonStream: async () => {
          requests += 1;
          return { text: "待办应用设计", finishReason: "stop" };
        },
      },
      enqueueTask: async (_label, task) => task(),
      onTitleChanged: () => {},
    });

    service.schedule({ sessionId: stored.id, userMessageId: "user-1", text: "帮我设计待办应用" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requests).toBe(0);

    busy = false;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(requests).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toBe(1);
  });
});
