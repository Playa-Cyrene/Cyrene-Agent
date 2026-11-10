import { describe, expect, it, vi } from "vitest";
import { createChannelDeliveryService } from "./delivery-service";
import type { OutgoingMessage } from "./types";

const message: OutgoingMessage = {
  channel: "qq",
  targetId: "chat-1",
  parts: [{ kind: "text", text: "回复" }],
};

describe("channels/delivery-service", () => {
  it("重启后的新连接不能发送旧轮次结果，正常的新轮次可发送", async () => {
    const old = new AbortController();
    old.abort();
    const current = new AbortController();
    const send = vi.fn(async () => ({ ok: true }));
    const service = createChannelDeliveryService({
      getAdapter: () => ({ send, getStatus: () => ({ enabled: true, phase: "running" }) }) as never,
      getActivitySignal: () => current.signal,
    });
    await expect(service.send({ ...message, signal: old.signal })).resolves.toEqual({ ok: false, error: "channel_stopped" });
    expect(send).not.toHaveBeenCalled();
    await expect(service.send({ ...message, signal: current.signal })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it("停用或尚未启动的渠道不能发送", async () => {
    const send = vi.fn();
    const service = createChannelDeliveryService({
      getAdapter: () => ({ send, getStatus: () => ({ enabled: false, phase: "offline" }) }) as never,
      getActivitySignal: () => undefined,
    });
    await expect(service.send(message)).resolves.toEqual({ ok: false, error: "channel_stopped" });
    expect(send).not.toHaveBeenCalled();
  });

  it("找不到渠道适配器时返回标准失败结果", async () => {
    const service = createChannelDeliveryService({
      getAdapter: () => undefined,
    });

    await expect(service.send(message)).resolves.toEqual({
      ok: false,
      error: "adapter_not_found",
    });
  });

  it("适配器抛出异常时将异常消息转换成失败结果", async () => {
    const service = createChannelDeliveryService({
      getAdapter: () => ({
        getStatus: () => ({ enabled: true, phase: "running" }),
        send: vi.fn(async () => {
          throw new Error("offline");
        }),
      }) as never,
    });

    await expect(service.send(message)).resolves.toEqual({
      ok: false,
      error: "offline",
    });
  });

  it("适配器未提供失败原因时补充标准错误码", async () => {
    const service = createChannelDeliveryService({
      getAdapter: () => ({
        getStatus: () => ({ enabled: true, phase: "running" }),
        send: vi.fn(async () => ({ ok: false })),
      }) as never,
    });

    await expect(service.send(message)).resolves.toEqual({
      ok: false,
      error: "send_failed",
    });
  });

  it("发送成功时返回成功确认", async () => {
    const service = createChannelDeliveryService({
      getAdapter: () => ({
        getStatus: () => ({ enabled: true, phase: "running" }),
        send: vi.fn(async () => ({ ok: true })),
      }) as never,
    });

    await expect(service.send(message)).resolves.toEqual({ ok: true });
  });
});
