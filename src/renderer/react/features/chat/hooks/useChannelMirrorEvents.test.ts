// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useChannelMirrorEvents } from "./useChannelMirrorEvents";
import type { ChatMessageItem } from "../components/ChatMessageList";

type EventCallback = (event: unknown) => void;

interface BindingSnapshot {
  externalChats: Array<{ sessionId: string; channel: string; chatId: string }>;
  bindings: Array<{ sessionId: string; conversationId: string }>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let listener: EventCallback | null = null;
let activeSessionId: string | undefined = "session-a";
let appended: Array<{ sessionId: string; items: ChatMessageItem[] }> = [];
let bindingSnapshot: BindingSnapshot | null = null;

function emit(event: unknown): void {
  act(() => {
    listener?.(event);
  });
}

function emitMirror(
  type: "bot:incoming" | "bot:outgoing",
  overrides: Partial<{
    channel: string;
    senderId: string;
    senderName: string;
    chatId: string;
    text: string;
    at: number;
  }> = {},
): void {
  emit({
    type: "CUSTOM",
    name: "cyrene.botMessage",
    value: {
      type,
      channel: "wechat",
      senderId: "wx-user-1",
      senderName: "张三",
      chatId: "chat-1",
      text: "今晚吃啥",
      at: 1788619000000,
      ...overrides,
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  listener = null;
  activeSessionId = "session-a";
  appended = [];
  bindingSnapshot = null;
  (window as unknown as { agui?: unknown }).agui = {
    onEvent: (callback: EventCallback) => {
      listener = callback;
      return () => { listener = null; };
    },
  };
  (window as unknown as { settings?: unknown }).settings = {
    channelsContextBindingsGet: async () => bindingSnapshot,
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function Probe() {
    useChannelMirrorEvents({
      getActiveSessionId: () => activeSessionId,
      appendMessages: (sessionId, items) => { appended.push({ sessionId, items }); },
    });
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(Probe));
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (host) {
    host.remove();
    host = null;
  }
  delete (window as unknown as { agui?: unknown }).agui;
  delete (window as unknown as { settings?: unknown }).settings;
});

describe("useChannelMirrorEvents", () => {
  it("入站消息以系统消息追加到当前会话", async () => {
    emitMirror("bot:incoming");
    await flush();

    expect(appended).toHaveLength(1);
    expect(appended[0].sessionId).toBe("session-a");
    const item = appended[0].items[0];
    expect(item.role).toBe("system");
    expect(item.content).toBe("[微信] 张三：今晚吃啥");
  });

  it("出站消息展示为回复格式", async () => {
    emitMirror("bot:outgoing");
    await flush();

    expect(appended[0].items[0].content).toBe("[微信] 回复 张三：今晚吃啥");
  });

  it("无激活会话时不追加", async () => {
    activeSessionId = undefined;
    emitMirror("bot:incoming");
    await flush();

    expect(appended).toHaveLength(0);
  });

  it("绑定到当前查看的会话时跳过（落库镜像会另行展示）", async () => {
    bindingSnapshot = {
      externalChats: [{ sessionId: "ext-1", channel: "wechat", chatId: "chat-1" }],
      bindings: [{ sessionId: "ext-1", conversationId: "session-a" }],
    };
    emitMirror("bot:incoming");
    await flush();

    expect(appended).toHaveLength(1);
  });

  it("仅更新内存 projection，不查询或写入 chats-store", async () => {
    let bindingReads = 0;
    (window as unknown as { settings?: unknown }).settings = {
      channelsContextBindingsGet: async () => {
        bindingReads += 1;
        return bindingSnapshot;
      },
    };
    emitMirror("bot:incoming");
    await flush();
    expect(bindingReads).toBe(0);
    expect(appended).toHaveLength(1);
  });

  it("绑定到其他会话时仍展示", async () => {
    bindingSnapshot = {
      externalChats: [{ sessionId: "ext-1", channel: "wechat", chatId: "chat-1" }],
      bindings: [{ sessionId: "ext-1", conversationId: "session-b" }],
    };
    emitMirror("bot:incoming");
    await flush();

    expect(appended).toHaveLength(1);
  });

  it("超长文本截断到上限", async () => {
    emitMirror("bot:incoming", { text: "长".repeat(300) });
    await flush();

    const content = appended[0].items[0].content;
    expect(content.length).toBeLessThanOrEqual(160 + "[微信] 张三：…".length);
    expect(content.endsWith("…")).toBe(true);
  });

  it("缺 senderName 时回退用 chatId 展示", async () => {
    emitMirror("bot:incoming", { senderName: "", chatId: "wx-chat-42" });
    await flush();

    expect(appended[0].items[0].content).toBe("[微信] wx-chat-42：今晚吃啥");
  });

  it("载荷形状非法时忽略", async () => {
    emit({ type: "CUSTOM", name: "cyrene.botMessage", value: { type: "bot:weird" } });
    emit({ type: "CUSTOM", name: "cyrene.botMessage", value: null });
    emit({ type: "TEXT_MESSAGE_CONTENT", name: "cyrene.botMessage", value: {} });
    emit({ type: "CUSTOM", name: "other.event", value: {} });
    await flush();

    expect(appended).toHaveLength(0);
  });

  it("卸载后解除监听", async () => {
    act(() => {
      root!.unmount();
    });
    root = null;
    emitMirror("bot:incoming");
    await flush();

    expect(appended).toHaveLength(0);
  });
});
