import { afterEach, describe, expect, it, vi } from "vitest";
import type { QqBotChannelConfig } from "../../settings-store";

const mockedSettings = vi.hoisted(() => ({
  wechat: { enabled: false },
  feishu: { enabled: false },
  qq: {
    enabled: false,
    listenMode: "loopback" as const,
    port: 0,
    allowedPrivateUserIds: [],
    allowedGroupIds: [],
    groupRequireMention: true as const,
    groupReplyStyle: "reply-and-mention" as const,
    groupToolPolicy: "off" as const,
    groupMemoryPolicy: "shared-personal" as const,
  },
  qqbot: {
    enabled: true,
    appId: "102146862",
    appSecret: "test-secret",
    allowAnyPrivate: false,
    allowedUserOpenids: ["OPENUSER0000000000000000000001"],
    allowedGroupOpenids: ["OPENGROUP0000000000000000000001"],
  } satisfies QqBotChannelConfig,
  inboundPort: 0,
  sharedSecret: "",
  rateLimitPerUser: 10,
  rateLimitPerChannel: 100,
  ttsEnabled: false,
  stickerEnabled: false,
  mirrorToDesktop: false,
  toolSandbox: "all" as const,
}));

vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP ?? process.cwd() },
}));

vi.mock("../../settings-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../settings-store")>();
  return { ...actual, loadChannelsSettings: () => mockedSettings };
});

const apiState = vi.hoisted(() => ({
  sent: [] as Array<{ target: string; content: string; msgId: string; msgSeq: number }>,
}));

vi.mock("./qqbot-api-client", () => ({
  QqBotApiError: class extends Error {},
  QqBotApiClient: class {
    async getGatewayUrl(): Promise<string> {
      return "wss://fake-gateway";
    }
    async getAccessToken(): Promise<string> {
      return "fake-token";
    }
    async sendText(
      target: { openid: string; chatType: string },
      content: string,
      options: { msgId: string; msgSeq: number },
    ): Promise<void> {
      apiState.sent.push({ target: `${target.chatType}:${target.openid}`, content, msgId: options.msgId, msgSeq: options.msgSeq });
    }
  },
}));

const wsState = vi.hoisted(() => ({
  options: null as unknown as {
    onDispatch: (type: string, data: Record<string, unknown>) => void;
    onReadyChange: (ready: boolean) => void;
    onError: (error: Error) => void;
  },
}));

vi.mock("./qqbot-ws-client", () => ({
  QqBotWsClient: class {
    isReady = false;
    constructor(options: unknown) {
      wsState.options = options as typeof wsState.options;
    }
    async start(): Promise<void> {
      this.isReady = true;
      wsState.options.onReadyChange(true);
    }
    async stop(): Promise<void> {
      this.isReady = false;
      wsState.options.onReadyChange(false);
    }
  },
}));

import { QqBotAdapter, isQqBotEventAllowed, normalizeQqBotEvent } from "./qqbot-adapter";
import { QqBotApiClient } from "./qqbot-api-client";
import { createChannelDeliveryService } from "../../delivery-service";
import type { IncomingMessage, OutgoingMessage } from "../../types";

const adapters: QqBotAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  apiState.sent.length = 0;
  vi.restoreAllMocks();
});

function c2cEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ROBOT1.0_c2c_msg_001",
    author: { user_openid: "OPENUSER0000000000000000000001" },
    content: "你好",
    timestamp: "2026-08-28T12:00:00+08:00",
    ...overrides,
  };
}

function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ROBOT1.0_group_msg_001",
    author: { member_openid: "OPENUSER0000000000000000000002" },
    group_openid: "OPENGROUP0000000000000000000001",
    content: " 在吗",
    timestamp: "2026-08-28T12:00:00+08:00",
    ...overrides,
  };
}

describe("normalizeQqBotEvent", () => {
  it("normalizes C2C events to private messages", () => {
    const msg = normalizeQqBotEvent("C2C_MESSAGE_CREATE", c2cEvent());
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe("qqbot");
    expect(msg!.chatType).toBe("private");
    expect(msg!.senderId).toBe("OPENUSER0000000000000000000001");
    expect(msg!.chatId).toBe("OPENUSER0000000000000000000001");
    expect(msg!.text).toBe("你好");
    expect(msg!.messageId).toBe("ROBOT1.0_c2c_msg_001");
    expect(msg!.at.getTime()).toBe(Date.parse("2026-08-28T12:00:00+08:00"));
  });

  it("normalizes group @ events and trims the leading space", () => {
    const msg = normalizeQqBotEvent("GROUP_AT_MESSAGE_CREATE", groupEvent());
    expect(msg!.chatType).toBe("group");
    expect(msg!.senderId).toBe("OPENUSER0000000000000000000002");
    expect(msg!.chatId).toBe("OPENGROUP0000000000000000000001");
    expect(msg!.text).toBe("在吗");
  });

  it("parses image attachments and prefers wav url for voice", () => {
    const msg = normalizeQqBotEvent("C2C_MESSAGE_CREATE", c2cEvent({
      content: "",
      attachments: [
        { content_type: "image/png", url: "https://cdn.qq.com/img", filename: "a.png" },
        { content_type: "voice", url: "https://cdn.qq.com/silk", voice_wav_url: "https://cdn.qq.com/wav" },
      ],
    }));
    expect(msg!.attachments).toHaveLength(2);
    expect(msg!.attachments![0]).toMatchObject({ kind: "image", url: "https://cdn.qq.com/img", mime: "image/png" });
    expect(msg!.attachments![1]).toMatchObject({ kind: "audio", url: "https://cdn.qq.com/wav" });
  });

  it("rejects unknown event types and events without openid", () => {
    expect(normalizeQqBotEvent("FRIEND_ADD", {})).toBeNull();
    expect(normalizeQqBotEvent("C2C_MESSAGE_CREATE", { content: "x" })).toBeNull();
    expect(normalizeQqBotEvent("GROUP_AT_MESSAGE_CREATE", { author: { member_openid: "U" }, content: "x" })).toBeNull();
  });
});

describe("isQqBotEventAllowed", () => {
  const config = mockedSettings.qqbot;

  it("enforces private allowlist unless allowAnyPrivate", () => {
    expect(isQqBotEventAllowed({ chatType: "private", senderId: "OPENUSER0000000000000000000001", chatId: "OPENUSER0000000000000000000001" }, config)).toBe(true);
    expect(isQqBotEventAllowed({ chatType: "private", senderId: "STRANGER000000000000000000001", chatId: "STRANGER000000000000000000001" }, config)).toBe(false);
    expect(isQqBotEventAllowed(
      { chatType: "private", senderId: "STRANGER000000000000000000001", chatId: "STRANGER000000000000000000001" },
      { ...config, allowAnyPrivate: true },
    )).toBe(true);
  });

  it("enforces group allowlist", () => {
    expect(isQqBotEventAllowed({ chatType: "group", senderId: "U1", chatId: "OPENGROUP0000000000000000000001" }, config)).toBe(true);
    expect(isQqBotEventAllowed({ chatType: "group", senderId: "U1", chatId: "OTHERGROUP0000000000000000000001" }, config)).toBe(false);
  });
});

describe("QqBotAdapter", () => {
  it.each([false, true])("末段已发起后停用，仅完整成功可确认送达 rejected=%s", async (rejected) => {
    const activity = new AbortController();
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start(activity.signal);
    adapter.onMessage = vi.fn(async () => null);
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", c2cEvent());
    await vi.waitFor(() => expect(adapter.onMessage).toHaveBeenCalledOnce());
    const entered = Promise.withResolvers<void>();
    const last = Promise.withResolvers<void>();
    const send = vi.spyOn(QqBotApiClient.prototype, "sendText")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => { entered.resolve(); return last.promise; });
    const delivery = createChannelDeliveryService({ getAdapter: () => adapter, getActivitySignal: () => activity.signal });
    const sending = delivery.send({ channel: "qqbot", targetId: "OPENUSER0000000000000000000001", parts: [{ kind: "text", text: "one" }, { kind: "text", text: "two" }] });
    await entered.promise;
    activity.abort(new Error("channel_stopped"));
    await adapter.stop();
    if (rejected) last.reject(activity.signal.reason);
    else last.resolve();
    await expect(sending).resolves.toEqual(rejected ? { ok: false, error: "channel_stopped" } : { ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("starts, records rejected openid, and reports it in status detail", async () => {
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start();
    expect(adapter.getStatus().phase).toBe("running");

    // 未在白名单的单聊：被拒且 openid 进入状态详情（供 UI 展示）
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", c2cEvent({
      id: "msg-stranger",
      author: { user_openid: "STRANGER000000000000000000001" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.getStatus().detail?.lastRejectedOpenid).toBe("STRANGER000000000000000000001");
  });

  it("delivers whitelisted messages to onMessage and sends passive replies with msg_seq", async () => {
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start();

    let captured: IncomingMessage | null = null;
    adapter.onMessage = async (msg) => {
      captured = msg;
      return null;
    };
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", c2cEvent());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured!.senderId).toBe("OPENUSER0000000000000000000001");

    const outgoing: OutgoingMessage = {
      channel: "qqbot",
      chatType: "private",
      targetId: "OPENUSER0000000000000000000001",
      parts: [{ kind: "text", text: "第一段。第二段。" }],
    };
    const result = await adapter.send(outgoing);
    expect(result.ok).toBe(true);
    expect(apiState.sent).toHaveLength(1);
    expect(apiState.sent[0]).toMatchObject({
      target: "private:OPENUSER0000000000000000000001",
      msgId: "ROBOT1.0_c2c_msg_001",
      msgSeq: 1,
    });
  });

  it("increments msg_seq across sends and enforces the private reply limit", async () => {
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start();
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", c2cEvent());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const outgoing: OutgoingMessage = {
      channel: "qqbot",
      chatType: "private",
      targetId: "OPENUSER0000000000000000000001",
      parts: [{ kind: "text", text: "回复" }],
    };
    for (let i = 0; i < 4; i++) {
      const result = await adapter.send(outgoing);
      expect(result.ok).toBe(true);
    }
    expect(apiState.sent.map((s) => s.msgSeq)).toEqual([1, 2, 3, 4]);

    // 第 5 次：超出单聊被动回复上限
    const fifth = await adapter.send(outgoing);
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toContain("上限");
    expect(apiState.sent).toHaveLength(4);
  });

  it("deduplicates repeated event pushes", async () => {
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start();

    const seen: IncomingMessage[] = [];
    adapter.onMessage = async (msg) => {
      seen.push(msg);
      return null;
    };
    const event = c2cEvent();
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", event);
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
  });

  it("hands same-chat messages to the dispatcher without adapter serialization", async () => {
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start();

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handedOff: string[] = [];
    adapter.onMessage = async (msg) => {
      handedOff.push(msg.messageId!);
      if (msg.messageId === "handoff-1") await firstGate;
      return null;
    };

    wsState.options.onDispatch("C2C_MESSAGE_CREATE", c2cEvent({ id: "handoff-1" }));
    wsState.options.onDispatch("C2C_MESSAGE_CREATE", c2cEvent({ id: "handoff-2" }));
    await vi.waitFor(() => expect(handedOff).toEqual(["handoff-1", "handoff-2"]));
    releaseFirst();
  });

  it("refuses to send without a recent inbound message (no proactive push)", async () => {
    const adapter = new QqBotAdapter();
    adapters.push(adapter);
    await adapter.start();
    const result = await adapter.send({
      channel: "qqbot",
      chatType: "private",
      targetId: "NOBODY000000000000000000000001",
      parts: [{ kind: "text", text: "主动消息" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("被动回复");
  });
});
