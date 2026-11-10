import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelManager } from "../../manager";
import { QqBotAdapter } from "./qqbot-adapter";

vi.mock("electron", () => ({ app: {} }));
vi.mock("../../settings-store", () => ({
  loadChannelsSettings: () => ({ qqbot: { enabled: true, appId: "synthetic", appSecret: "synthetic" } }),
}));
vi.mock("../qq/napcat-adapter", () => ({ splitQqText: (text: string) => [text] }));

const sockets = vi.hoisted(() => ({ created: 0, closed: 0 }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); sockets.created += 1; }
    close() { this.readyState = 3; sockets.closed += 1; }
  } };
});

afterEach(() => { vi.unstubAllGlobals(); sockets.created = 0; sockets.closed = 0; });

describe("QQ Bot 启动请求的完整取消链", () => {
  it.each(["token", "gateway"])("%s 请求挂起时停止能释放队列，其他渠道保持可用且可以重新连接", async (stage) => {
    const manager = new ChannelManager();
    const adapter = new QqBotAdapter();
    manager.register(adapter);
    const other = {
      id: "feishu" as const, displayName: "synthetic", capability: adapter.capability,
      onMessage: null, start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      send: vi.fn(async () => ({ ok: true })),
      getStatus: () => ({ enabled: true, phase: "running" as const }),
    };
    manager.register(other);
    await manager.startOne("feishu");
    const otherSignal = manager.getActivitySignal("feishu")!;
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<Response>();
    let requestSignal: AbortSignal | null | undefined;
    let hold = true;
    const response = (url: string) => new Response(JSON.stringify(url.includes("getAppAccessToken")
      ? { access_token: "synthetic-token", expires_in: 7200 }
      : { url: "wss://synthetic.invalid" }));
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (hold && (stage === "token" ? url.includes("getAppAccessToken") : url.endsWith("/gateway"))) {
        requestSignal = init?.signal;
        requestSignal?.addEventListener("abort", () => held.reject(requestSignal!.reason), { once: true });
        entered.resolve();
        return held.promise;
      }
      return Promise.resolve(response(url));
    }));
    const starting = manager.startOne("qqbot").catch(() => {});
    let stopping: Promise<void> | undefined;
    try {
      await entered.promise;
      stopping = manager.stopOne("qqbot");
      expect(requestSignal?.aborted).toBe(true);
      await stopping;
      await starting;
      expect(sockets.created).toBe(0);
      expect(manager.getActivitySignal("qqbot")).toBeUndefined();
      expect(otherSignal.aborted).toBe(false);
      expect(other.stop).not.toHaveBeenCalled();
      await expect(other.send()).resolves.toEqual({ ok: true });

      hold = false;
      await manager.startOne("qqbot");
      expect(sockets.created).toBe(1);
      expect(manager.getActivitySignal("qqbot")?.aborted).toBe(false);
      await manager.stopAll();
      expect(sockets.closed).toBe(1);
    } finally {
      // 失败时也释放模拟请求，避免回归测试自身留下挂起队列。
      held.resolve(response(stage === "token" ? "getAppAccessToken" : "/gateway"));
      await starting;
      await stopping;
      await manager.stopAll();
    }
  });
});
