import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";

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
  it("unregister releases bulk startup before a hung adapter resolves", async () => {
    const manager = new ChannelManager();
    const port = manager.createPluginPort();
    const slow = fakeAdapter("slow");
    const next = fakeAdapter("next");
    let release!: () => void;
    slow.start = () => new Promise<void>(resolve => { release = resolve; });
    slow.stop = vi.fn(async () => {});
    next.start = vi.fn(async () => {});
    port.register(slow);
    manager.register(next);
    const one = port.startOne(slow.id).catch(() => {});
    const all = manager.startAll();
    await Promise.resolve();
    await port.unregister(slow.id);
    await all;
    await one;
    expect(next.start).toHaveBeenCalledOnce();
    expect(slow.stop).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(slow.stop).toHaveBeenCalledOnce());
    await manager.stopAll();
  });
  it.each([true, false])("shares startup between plugin and background (plugin first=%s)", async (pluginFirst) => {
    const manager = new ChannelManager();
    const port = manager.createPluginPort();
    const adapter = fakeAdapter("plugin-test");
    let release!: () => void;
    adapter.start = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    port.register(adapter);
    const first = pluginFirst ? port.startOne(adapter.id) : manager.startAll();
    const second = pluginFirst ? manager.startAll() : port.startOne(adapter.id);
    await Promise.resolve();
    expect(adapter.start).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    await manager.stopAll();
  });

  it.each(["unregister", "stopAll"] as const)("stops a late startup after %s without marking it running", async (action) => {
    const manager = new ChannelManager();
    const port = manager.createPluginPort();
    const adapter = fakeAdapter("plugin-test");
    let release!: () => void;
    adapter.start = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    adapter.stop = vi.fn(async () => {});
    port.register(adapter);
    const starting = port.startOne(adapter.id);
    const rejected = expect(starting).rejects.toThrow(/cancelled/);
    await Promise.resolve();
    if (action === "unregister") await port.unregister(adapter.id);
    else await manager.stopAll();
    release();
    await rejected;
    expect(adapter.stop).toHaveBeenCalledOnce();
    if (action === "unregister") expect(manager.has(adapter.id)).toBe(false);
    else {
      adapter.start = vi.fn(async () => {});
      await port.startOne(adapter.id);
      expect(adapter.start).toHaveBeenCalledOnce();
      await manager.stopAll();
    }
  });

  it("does not continue starting further adapters after stopAll", async () => {
    const manager = new ChannelManager();
    const first = fakeAdapter("first");
    const second = fakeAdapter("second");
    let release!: () => void;
    first.start = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    first.stop = vi.fn(async () => {});
    second.start = vi.fn(async () => {});
    manager.register(first);
    manager.register(second);
    const starting = manager.startAll();
    await Promise.resolve();
    await manager.stopAll();
    release();
    await starting;
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.start).not.toHaveBeenCalled();
  });

  it("shares a failed startup and allows a later retry", async () => {
    const manager = new ChannelManager();
    const adapter = fakeAdapter("plugin-test");
    let reject!: (error: Error) => void;
    adapter.start = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    manager.register(adapter);
    const first = manager.startOne(adapter.id);
    const second = manager.startAll();
    const rejected = expect(first).rejects.toThrow("offline");
    await Promise.resolve();
    reject(new Error("offline"));
    await Promise.all([rejected, second]);
    expect(adapter.start).toHaveBeenCalledOnce();
    adapter.start = vi.fn(async () => {});
    await manager.startOne(adapter.id);
    expect(adapter.start).toHaveBeenCalledOnce();
    await manager.stopAll();
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

describe("ChannelManager 宿主身份边界", () => {
  it.each(["qq", "qqbot"])("即使空槽也拒绝普通插件管理保留身份 %s", async (id) => {
    const mgr = new ChannelManager();
    const plugins = mgr.createPluginPort();
    const adapter = fakeAdapter(id);
    expect(() => plugins.register(adapter)).toThrow(/宿主保留身份/);
    await expect(plugins.startOne(adapter.id)).rejects.toThrow(/宿主保留身份/);
    await expect(plugins.unregister(adapter.id)).rejects.toThrow(/宿主保留身份/);
    expect(mgr.has(adapter.id)).toBe(false);

    // 宿主仍能正常注册、启动、停止既有普通 QQ/官方 QQ。
    mgr.register(adapter);
    await mgr.startOne(adapter.id);
    await expect(plugins.unregister(adapter.id)).rejects.toThrow(/宿主保留身份/);
    expect(mgr.getAdapter(adapter.id)).toBe(adapter);
    expect(adapter.getStatus().phase).toBe("running");
    expect(await mgr.unregister(adapter.id)).toBe(true);
  });

  it("注册归属由端口持有，另一端口或宿主单项操作不能注销它", async () => {
    const mgr = new ChannelManager();
    const first = mgr.createPluginPort();
    const other = mgr.createPluginPort();
    const adapter = fakeAdapter("custom-plugin");
    first.register(adapter);
    await first.startOne(adapter.id);
    await expect(other.startOne(adapter.id)).rejects.toThrow(/不属于/);
    await expect(other.unregister(adapter.id)).rejects.toThrow(/不属于/);
    await expect(mgr.unregister(adapter.id)).rejects.toThrow(/不属于/);
    expect(mgr.getAdapter(adapter.id)).toBe(adapter);
    // 全局启停仍覆盖插件渠道，且不改变归属。
    await mgr.stopAll();
    await mgr.startAll();
    expect(adapter.getStatus().phase).toBe("running");
    expect(await first.unregister(adapter.id)).toBe(true);
    expect(await first.unregister(adapter.id)).toBe(false);
  });

  it("普通插件不能注销由宿主注册的非 QQ 渠道", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("feishu");
    mgr.register(adapter);
    await expect(mgr.createPluginPort().unregister(adapter.id)).rejects.toThrow(/不属于/);
    expect(mgr.getAdapter(adapter.id)).toBe(adapter);
  });

  it("拒绝入站渠道冒充，但保留合法消息中的 mentions/reply", async () => {
    const mgr = new ChannelManager();
    const plugins = mgr.createPluginPort();
    const adapter = fakeAdapter("custom-plugin");
    const dispatch = vi.fn(async () => null);
    plugins.register(adapter);
    mgr.setDispatcher(dispatch);
    await plugins.startOne(adapter.id);
    const message = {
      channel: adapter.id,
      chatType: "group" as const,
      chatId: "group-1",
      senderId: "sender-1",
      text: "你好",
      mentions: [{ userId: "bot-1", isBot: true }],
      reply: { messageId: "message-0", text: "原消息" },
      at: new Date(0),
    };
    await adapter.onMessage?.({ ...message, channel: "qq" });
    expect(dispatch).not.toHaveBeenCalled();
    await adapter.onMessage?.(message);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(message);
  });

  it("注销后保存的旧回调不能向同 ID 的新实例注入消息", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    const dispatch = vi.fn(async () => null);
    mgr.register(adapter);
    mgr.setDispatcher(dispatch);
    await mgr.startOne(adapter.id);
    const oldHandler = adapter.onMessage!;
    await mgr.unregister(adapter.id);
    expect(adapter.onMessage).toBeNull();
    mgr.register(fakeAdapter("qq"));
    await oldHandler({ channel: "qq", chatId: "1", senderId: "1", text: "late", at: new Date(0) });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
