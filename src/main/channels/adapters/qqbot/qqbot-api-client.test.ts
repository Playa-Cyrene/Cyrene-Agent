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
});
