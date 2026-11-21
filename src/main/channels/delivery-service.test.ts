import { describe, expect, it, vi } from "vitest";
import { createChannelDeliveryService } from "./delivery-service";
import type { OutgoingMessage } from "./types";

const message: OutgoingMessage = {
  channel: "qq",
  targetId: "chat-1",
  parts: [{ kind: "text", text: "回复" }],
};

describe("channels/delivery-service", () => {
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
        send: vi.fn(async () => ({ ok: true })),
      }) as never,
    });

    await expect(service.send(message)).resolves.toEqual({ ok: true });
  });
});

it("blocks new channel sends without aborting an in-flight send", async () => {
  const { configureTermsExecutionGate } = await import("../terms/terms-runtime");
  let accepted = true;
  const restore = configureTermsExecutionGate(() => accepted);
  let finish!: (value: { ok: boolean }) => void;
  const send = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
  const service = createChannelDeliveryService({ getAdapter: () => ({ send }) as never });
  try {
    const pending = service.send(message);
    accepted = false;
    expect(await service.send(message)).toEqual({ ok: false, error: "E_TERMS_CONSENT_REQUIRED" });
    finish({ ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  } finally { restore(); }
});
