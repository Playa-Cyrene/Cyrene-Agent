import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "./adapters/base";
import {
  createProactiveChannelRecipientRegistry,
  sendProactiveChannelMessage,
} from "./proactive-delivery";
import type { ChannelCapability, IncomingMessage } from "./types";

const capability: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: true,
  maxTextLength: 4000,
};

function incoming(channel: "wechat" | "feishu", senderId: string, chatId = senderId): IncomingMessage {
  return { channel, senderId, chatId, text: "你好", at: new Date() };
}

function fakeAdapter(phase: "running" | "offline" = "running"): ChannelAdapter {
  return {
    id: "wechat",
    displayName: "test",
    capability,
    onMessage: null,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: vi.fn(() => ({ enabled: phase === "running", phase })),
  };
}

describe("proactive channel delivery", () => {
  let registry = createProactiveChannelRecipientRegistry();

  beforeEach(() => {
    registry = createProactiveChannelRecipientRegistry();
  });

  it("keeps the latest recipient independently for each channel", () => {
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    registry.remember(incoming("feishu", "fs-1"), "session-fs-1");
    registry.remember(incoming("wechat", "wx-2", "wx-chat-2"), "session-wx-2");

    expect(registry.get("wechat")).toMatchObject({ targetId: "wx-chat-2", sessionId: "session-wx-2" });
    expect(registry.get("feishu")).toMatchObject({ targetId: "fs-1", sessionId: "session-fs-1" });
  });

  it("cancels while the selected channel is offline", async () => {
    const adapter = fakeAdapter("offline");
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "cancelled", reason: "channel_offline" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("cancels when the channel has no current-process recipient", async () => {
    const adapter = fakeAdapter();
    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "cancelled", reason: "recipient_unavailable" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("sends one complete text part when segmentation is off", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 1 });
    expect(adapter.send).toHaveBeenCalledWith({
      channel: "wechat",
      targetId: "wx-1",
      parts: [{ kind: "text", text: "第一句。第二句？" }],
    });
  });

  it("sends segmented text sequentially and caps it at ten parts", async () => {
    const adapter = fakeAdapter();
    const order: string[] = [];
    vi.mocked(adapter.send).mockImplementation(async (message) => {
      const part = message.parts[0];
      if (part.kind === "text") order.push(part.text);
      return { ok: true };
    });
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    const text = Array.from({ length: 12 }, (_, index) => `第${index + 1}句。`).join("");

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text,
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 10, totalParts: 10 });
    expect(order).toHaveLength(10);
    expect(order.slice(0, 2)).toEqual(["第1句。", "第2句。"]);
    expect(order[9]).toContain("第12句。");
  });

  it("cancels total failure but commits a partial delivery", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    vi.mocked(adapter.send).mockResolvedValue({ ok: false, error: "failed" });

    const failed = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
    });
    expect(failed).toEqual({ kind: "cancelled", reason: "send_failed" });

    vi.mocked(adapter.send)
      .mockReset()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "failed" });
    const appendHistory = vi.fn();
    const appendLog = vi.fn();
    const partial = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory,
      appendLog,
    });

    expect(partial).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 2 });
    expect(appendHistory).toHaveBeenCalledWith("session-wx-1", "assistant", "第一句。");
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ text: "第一句。" }));
  });

  it("通过统一传输服务发送并只提交实际送达的片段", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    let attempts = 0;
    let committedText = "";

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      delivery: {
        send: async () => {
          attempts += 1;
          return attempts === 1
            ? { ok: true }
            : { ok: false, error: "send_failed" };
        },
      },
      recipientRegistry: registry,
      appendHistory: (_sessionId, _role, text) => {
        committedText = text;
      },
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 2 });
    expect(committedText).toBe("第一句。");
  });

  it("stops before the next segment when the proactive generation becomes invalid", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    let allowed = true;
    vi.mocked(adapter.send).mockImplementation(async () => {
      allowed = false;
      return { ok: true };
    });

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
      canContinue: () => allowed,
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 2 });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failed segment instead of sending later fragments", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    vi.mocked(adapter.send)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "failed" })
      .mockResolvedValueOnce({ ok: true });

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？第三句！",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 3 });
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });
});
