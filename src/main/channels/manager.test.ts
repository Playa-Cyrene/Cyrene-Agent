import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelStatus } from "./types";

function fakeAdapter(id: string): ChannelAdapter {
  let started = false;
  return {
    id: id as never,
    displayName: id,
    capability: {} as never,
    onMessage: null,
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
    },
    send: async () => ({ ok: true }),
    getStatus: () => ({ enabled: started, phase: started ? "running" : "offline" }),
  };
}

describe("ChannelManager", () => {
  const incoming = { channel: "qq" as const, chatId: "chat", senderId: "user", text: "hello", at: new Date(0) };

  it("停止立即撤销当前轮次，重启后旧回调仍无效且其他渠道不受影响", async () => {
    const mgr = new ChannelManager();
    const qq = fakeAdapter("qq");
    const feishu = fakeAdapter("feishu");
    const dispatch = vi.fn(async () => null);
    mgr.register(qq);
    mgr.register(feishu);
    mgr.setDispatcher(dispatch);
    await mgr.startAll();
    const oldHandler = qq.onMessage!;
    await oldHandler(incoming);
    const signal = (dispatch.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal;
    const stopping = mgr.stopOne("qq");
    expect(signal.aborted).toBe(true);
    expect(mgr.getActivitySignal("feishu")?.aborted).toBe(false);
    await stopping;
    await mgr.startOne("qq");
    await oldHandler(incoming);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await qq.onMessage!(incoming);
    await feishu.onMessage!({ ...incoming, channel: "feishu" });
    expect(dispatch).toHaveBeenCalledTimes(3);
    await mgr.stopAll();
  });

  it("拒绝适配器冒用其他渠道及已撤销的连接消息", async () => {
    const mgr = new ChannelManager();
    const qq = fakeAdapter("qq");
    const dispatch = vi.fn(async () => null);
    mgr.register(qq);
    mgr.setDispatcher(dispatch);
    await mgr.startOne("qq");
    await qq.onMessage!({ ...incoming, channel: "wechat" });
    await qq.onMessage!({ ...incoming, signal: AbortSignal.abort() });
    expect(dispatch).not.toHaveBeenCalled();
    await mgr.stopAll();
  });

  it("启动尚未完成时停止，不会被迟到启动重新启用", async () => {
    const mgr = new ChannelManager();
    const qq = fakeAdapter("qq");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    qq.start = async () => { started.resolve(); await release.promise; };
    const stop = vi.spyOn(qq, "stop");
    mgr.register(qq);
    const starting = mgr.startOne("qq");
    await started.promise;
    const oldSignal = mgr.getActivitySignal("qq")!;
    const stopping = mgr.stopOne("qq");
    expect(oldSignal.aborted).toBe(true);
    release.resolve();
    await Promise.all([starting, stopping]);
    expect(stop).toHaveBeenCalledOnce();
    expect(qq.onMessage).toBeNull();
    expect(mgr.getActivitySignal("qq")).toBeUndefined();
  });

  it("启动失败也撤销回调并释放部分初始化资源", async () => {
    const mgr = new ChannelManager();
    const qq = fakeAdapter("qq");
    qq.start = async () => { throw new Error("connect failed"); };
    const stop = vi.spyOn(qq, "stop");
    mgr.register(qq);
    await expect(mgr.startOne("qq")).rejects.toThrow("connect failed");
    expect(mgr.getActivitySignal("qq")?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    await mgr.stopAll();
  });

  it("启动失败清理资源后仍显示原始诊断，重试或显式停止清除错误", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    let status: ChannelStatus = { enabled: true, phase: "starting" };
    adapter.getStatus = () => status;
    adapter.start = vi.fn(async () => { status = { enabled: true, phase: "error", message: "EADDRINUSE", detail: { port: 6200 } }; throw new Error("EADDRINUSE"); });
    adapter.stop = vi.fn(async () => { status = { enabled: false, phase: "offline", message: "已停止" }; });
    mgr.register(adapter);
    await mgr.startAll();
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(mgr.getActivitySignal("qq")?.aborted).toBe(true);
    expect(mgr.getAllStatus().qq).toMatchObject({ enabled: true, phase: "error", message: "EADDRINUSE", detail: { port: 6200 } });
    adapter.start = async () => { status = { enabled: true, phase: "running" }; };
    await mgr.startOne("qq");
    expect(mgr.getAllStatus().qq.phase).toBe("running");
    await mgr.stopOne("qq");
    expect(mgr.getAllStatus().qq.phase).toBe("offline");
  });

  it("用户在启动期间停用时不把取消记录为启动错误", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    const entered = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<void>();
    adapter.start = async () => { entered.resolve(); return failure.promise; };
    mgr.register(adapter);
    const starting = mgr.startOne("qq");
    const rejected = expect(starting).rejects.toThrow("channel_stopped");
    await entered.promise;
    const stopping = mgr.stopOne("qq");
    failure.reject(new Error("channel_stopped"));
    await rejected;
    await stopping;
    expect(mgr.getAllStatus().qq.phase).toBe("offline");
  });

  it("startOne 启动单个 adapter；unregister 先 stop 再移除", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    expect(mgr.getAdapter("qq" as never)).toBeDefined();
    expect(adapter.getStatus().phase).toBe("running");

    const removed = await mgr.unregister("qq" as never);
    expect(removed).toBe(true);
    expect(mgr.getAdapter("qq" as never)).toBeUndefined();
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("unregister 不存在的 id 返回 false", async () => {
    const mgr = new ChannelManager();
    expect(await mgr.unregister("nope" as never)).toBe(false);
  });

  it("注销与启动竞争时不会留下已经脱离注册表的连接", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    const start = vi.spyOn(adapter, "start");
    mgr.register(adapter);
    await mgr.startOne("qq");
    await Promise.all([mgr.unregister("qq"), mgr.startOne("qq")]);
    expect(start).toHaveBeenCalledOnce();
    expect(mgr.has("qq")).toBe(false);
    expect(mgr.getActivitySignal("qq")).toBeUndefined();
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("适配器停止抛错仍完成注销，允许插件重新注册", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await mgr.startOne("qq");
    const signal = mgr.getActivitySignal("qq")!;
    adapter.stop = async () => { throw new Error("broken transport"); };
    expect(await mgr.unregister("qq")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(adapter.onMessage).toBeNull();
    expect(mgr.has("qq")).toBe(false);
    expect(() => mgr.register(fakeAdapter("qq"))).not.toThrow();
  });

  it("并发注销的迟到清理不能删除同 id 的新适配器", async () => {
    const mgr = new ChannelManager();
    mgr.register(fakeAdapter("qq"));
    await mgr.startOne("qq");
    const first = mgr.unregister("qq");
    const second = mgr.unregister("qq");
    await first;
    const replacement = fakeAdapter("qq");
    mgr.register(replacement);
    await second;
    await mgr.startOne("qq");
    expect(mgr.getAdapter("qq")).toBe(replacement);
    expect(replacement.getStatus().phase).toBe("running");
    await mgr.stopAll();
  });

  it("startAll 跳过已启动的 adapter（避免渠道插件双启动）", async () => {
    const mgr = new ChannelManager();
    let startCount = 0;
    const adapter = fakeAdapter("qq");
    const origStart = adapter.start;
    adapter.start = async () => {
      startCount += 1;
      await origStart();
    };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    await mgr.startAll();
    expect(startCount).toBe(1);
  });

  it("拒绝重复 id，避免覆盖已启动 adapter 后留下错误状态", async () => {
    const mgr = new ChannelManager();
    const first = fakeAdapter("feishu");
    const second = fakeAdapter("feishu");
    mgr.register(first);
    await mgr.startOne("feishu" as never);
    expect(() => mgr.register(second)).toThrow(/禁止覆盖/);
    expect(mgr.getAdapter("feishu" as never)).toBe(first);
    expect(second.getStatus().phase).toBe("offline");
  });

  it("startOne 对已启动 adapter 幂等", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    let starts = 0;
    const original = adapter.start;
    adapter.start = async () => { starts += 1; await original(); };
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    await mgr.startOne("qq" as never);
    expect(starts).toBe(1);
  });

  it("只委托入站处理，不重复发送 dispatcher 返回的消息", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    const send = vi.spyOn(adapter, "send");
    mgr.register(adapter);
    mgr.setDispatcher(async () => ({
      channel: "qq",
      targetId: "chat-1",
      parts: [{ kind: "text", text: "已由 dispatcher 发送" }],
    }));
    await mgr.startOne("qq" as never);

    await adapter.onMessage?.({
      channel: "qq",
      chatId: "chat-1",
      senderId: "user-1",
      text: "你好",
      at: new Date(0),
    });

    expect(send).not.toHaveBeenCalled();
  });
});
