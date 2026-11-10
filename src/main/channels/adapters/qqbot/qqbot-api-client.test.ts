import { describe, expect, it, vi } from "vitest";
import { QqBotApiClient } from "./qqbot-api-client";

describe("QQ Bot 令牌刷新与撤销", () => {
  it.each([false, true])("取令牌期间撤销不会开始消息 POST cancelled=%s", async (cancelled) => {
    const activity = new AbortController();
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("getAppAccessToken")) {
        if (cancelled) activity.abort(new Error("channel_stopped"));
        return new Response(JSON.stringify({ access_token: "synthetic", expires_in: 7200 }));
      }
      return new Response("{}");
    });
    const client = new QqBotApiClient({ appId: "synthetic", clientSecret: "synthetic" }, fetch);
    const sending = client.sendText({ openid: "peer", chatType: "private" }, "hello", { msgId: "synthetic", msgSeq: 1, signal: activity.signal });
    if (cancelled) await expect(sending).rejects.toThrow("channel_stopped");
    else await expect(sending).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(cancelled ? 1 : 2);
  });

  it("单条消息取消不撤销共享令牌刷新，其他消息仍正常发送", async () => {
    const connection = new AbortController();
    const message = new AbortController();
    const token = Promise.withResolvers<Response>();
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("getAppAccessToken")) {
        expect(init?.signal).toBe(connection.signal);
        return token.promise;
      }
      return Promise.resolve(new Response("{}"));
    });
    const client = new QqBotApiClient({ appId: "synthetic", clientSecret: "synthetic", signal: connection.signal }, fetch);
    const cancelled = client.sendText({ openid: "one", chatType: "private" }, "one", { msgId: "one", msgSeq: 1, signal: message.signal });
    const cancelledResult = expect(cancelled).rejects.toThrow("message_cancelled");
    const active = client.sendText({ openid: "two", chatType: "private" }, "two", { msgId: "two", msgSeq: 1 });
    message.abort(new Error("message_cancelled"));
    token.resolve(new Response(JSON.stringify({ access_token: "synthetic", expires_in: 7200 })));
    await cancelledResult;
    await expect(active).resolves.toBeUndefined();
    expect(connection.signal.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain("/users/two/messages");
  });

  it.each(["token", "gateway"])("读取 %s 响应体期间撤销会中断等待", async (stage) => {
    const activity = new AbortController();
    let bodySignal: AbortSignal | null | undefined;
    const entered = Promise.withResolvers<void>();
    const body = Promise.withResolvers<string>();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const isToken = url.includes("getAppAccessToken");
      const payload = JSON.stringify(isToken ? { access_token: "synthetic", expires_in: 7200 } : { url: "wss://synthetic.invalid" });
      if (isToken === (stage === "token")) {
        bodySignal = init?.signal;
        bodySignal?.addEventListener("abort", () => body.reject(bodySignal!.reason), { once: true });
        return { ok: true, json: () => { entered.resolve(); return body.promise.then(JSON.parse); }, text: () => { entered.resolve(); return body.promise; } } as Response;
      }
      return new Response(payload);
    });
    const client = new QqBotApiClient({ appId: "synthetic", clientSecret: "synthetic", signal: activity.signal }, fetch);
    const pending = client.getGatewayUrl();
    const settled = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      activity.abort(new Error("channel_stopped"));
      expect(bodySignal?.aborted).toBe(true);
      expect(await settled).toMatchObject({ message: "channel_stopped" });
    } finally {
      body.resolve(JSON.stringify({ access_token: "synthetic", url: "wss://synthetic.invalid" }));
      await settled;
    }
  });
});
