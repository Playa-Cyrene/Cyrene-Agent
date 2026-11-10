import { afterEach, describe, expect, it, vi } from "vitest";
import { createLarkChannel, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { createCancellableLarkHttp } from "./cancellable-http";

afterEach(() => vi.restoreAllMocks());

describe("飞书 SDK 内部请求撤销", () => {
  it.each([false, true])("真实 SDK 上传完成后发送遵守撤销状态 cancelled=%s", async (cancelled) => {
    const activity = new AbortController();
    const requested: string[] = [];
    vi.spyOn(defaultHttpInstance, "request").mockImplementation(async (options) => {
      const url = String(typeof options === "string" ? options : options.url);
      requested.push(url);
      if (url.includes("/auth/")) return { code: 0, tenant_access_token: "synthetic", expire: 7200 };
      if (url.endsWith("/images")) {
        if (cancelled) activity.abort(new Error("channel_stopped"));
        return { code: 0, data: { image_key: "synthetic-image" } };
      }
      if (url.includes("/messages")) return { code: 0, data: { message_id: "synthetic-message" } };
      throw new Error(`Unexpected SDK request: ${url}`);
    });
    const channel = createLarkChannel({
      appId: `synthetic-${cancelled}`, appSecret: "synthetic", transport: "webhook",
      httpInstance: createCancellableLarkHttp(activity.signal),
    });
    try {
      const sending = channel.send("oc_synthetic", { image: { source: Buffer.from("synthetic-image") } });
      if (cancelled) await expect(sending).rejects.toThrow();
      else await expect(sending).resolves.toMatchObject({ messageId: "synthetic-message" });
      expect(requested.some((url) => url.endsWith("/images"))).toBe(true);
      expect(requested.some((url) => url.includes("/messages"))).toBe(!cancelled);
    } finally { await channel.disconnect(); }
  });
});
