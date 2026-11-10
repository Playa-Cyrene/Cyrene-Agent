import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "./index";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<any>,
  download: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => process.env.TEMP! } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ feishu: { enabled: true, appId: "synthetic", appSecret: "synthetic" } }) }));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "synthetic" }, LoggerLevel: { warn: "warn" },
  createLarkChannel: () => {
    const handlers = new Map();
    const channel = {
      handlers, on: (event: string, handler: unknown) => handlers.set(event, handler),
      connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), send: vi.fn(async () => ({ messageId: "sent" })),
      rawClient: { im: { v1: { messageResource: { get: mocks.download } } } },
    };
    mocks.channels.push(channel);
    return channel;
  },
}));

describe("飞书连接撤销", () => {
  beforeEach(() => { mocks.channels.length = 0; mocks.download.mockReset(); });

  it("旧连接的迟到消息在重启后仍被拒绝，新连接正常处理", async () => {
    const adapter = new FeishuAdapter();
    const handler = vi.fn(async () => null);
    adapter.onMessage = handler;
    await adapter.start();
    const old = mocks.channels[0];
    const message = { chatType: "p2p", rawContentType: "text", content: '{"text":"hello"}', chatId: "synthetic", senderId: "peer", messageId: "text" };
    await old.handlers.get("message")(message);
    expect(handler).toHaveBeenCalledOnce();
    await adapter.stop();
    await adapter.start();
    await old.handlers.get("message")(message);
    expect(handler).toHaveBeenCalledOnce();
    await mocks.channels[1].handlers.get("message")(message);
    expect(handler).toHaveBeenCalledTimes(2);
    await adapter.stop();
  });

  it("媒体请求途中撤销后不写文件、不把旧附件交给新连接", async () => {
    const pending = Promise.withResolvers<{ writeFile: () => Promise<void> }>();
    mocks.download.mockReturnValue(pending.promise);
    const adapter = new FeishuAdapter();
    adapter.onMessage = vi.fn(async () => null);
    await adapter.start();
    const processing = mocks.channels[0].handlers.get("message")({
      chatType: "p2p", rawContentType: "image", content: "", messageId: "cancelled-image",
      resources: [{ fileKey: "synthetic-file", type: "image" }],
    });
    await adapter.stop();
    await adapter.start();
    const writeFile = vi.fn(async () => {});
    pending.resolve({ writeFile });
    await processing;
    expect(writeFile).not.toHaveBeenCalled();
    expect(adapter.onMessage).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it("发送首段后撤销会停止其余分段", async () => {
    const adapter = new FeishuAdapter();
    await adapter.start();
    const channel = mocks.channels[0];
    channel.send.mockImplementation(async () => { await adapter.stop(); return { messageId: "sent" }; });
    await expect(adapter.send({ channel: "feishu", targetId: "peer", parts: [{ kind: "text", text: "one" }, { kind: "text", text: "two" }] }))
      .resolves.toEqual({ ok: false, error: "channel_stopped" });
    expect(channel.send).toHaveBeenCalledOnce();
  });
});
