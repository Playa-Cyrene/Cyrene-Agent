import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { ChannelId } from "./types";

const mocks = vi.hoisted(() => {
  const settings: Record<string, any> = {};
  const adapters = new Map<string, any>();
  class Adapter {
    onMessage = null;
    capability = {};
    displayName: string;
    running = false;
    constructor(readonly id: string) { this.displayName = id; adapters.set(id, this); }
    start = vi.fn(async () => { this.running = settings[this.id].enabled; });
    stop = vi.fn(async () => { this.running = false; });
    send = vi.fn(async () => ({ ok: true }));
    login = vi.fn(async () => ({ ilinkBotId: "synthetic-bot" }));
    logout = vi.fn(async () => { this.running = false; });
    getStatus() { return { enabled: this.running, phase: this.running ? "running" : "offline" }; }
  }
  return { settings, adapters, Adapter };
});

vi.mock("electron", () => ({
  app: {}, BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock("./settings-store", () => ({
  loadChannelsSettings: () => structuredClone(mocks.settings),
  saveChannelsSettings: (patch: Record<string, any>) => {
    for (const [key, value] of Object.entries(patch)) mocks.settings[key] = { ...mocks.settings[key], ...value };
    return structuredClone(mocks.settings);
  },
}));
vi.mock("./adapters/feishu", () => ({ FeishuAdapter: class extends mocks.Adapter { constructor() { super("feishu"); } } }));
vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({
  ILinkBotAdapter: class extends mocks.Adapter { constructor() { super("wechat"); } }, loadCredentials: vi.fn(),
}));
vi.mock("./adapters/qq/napcat-adapter", () => ({ NapCatAdapter: class extends mocks.Adapter { constructor() { super("qq"); } } }));
vi.mock("./adapters/qqbot/qqbot-adapter", () => ({ QqBotAdapter: class extends mocks.Adapter { constructor() { super("qqbot"); } } }));
vi.mock("./adapters/qq/onebot-reverse-ws", () => ({ resolveQqListenAuthRequirement: vi.fn() }));
vi.mock("./adapters/wechat/ilink-protocol-client.js", () => ({ fetchQrCode: async () => ({ qrcode: "synthetic", qrcode_img_content: "synthetic" }) }));
vi.mock("./adapters/wechat/qr.js", () => ({ createQrDataUrl: async () => "synthetic-image" }));
vi.mock("./inbound-server", () => ({ startInboundServer: async () => ({ port: 0 }), stopInboundServer: vi.fn() }));
vi.mock("./message-log", () => ({ reloadLogFromDisk: vi.fn(), getRecentLog: vi.fn(), clearLog: vi.fn() }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ listSessions: async () => [], getSession: vi.fn() }));

describe("渠道设置与管理操作的生命周期", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let init: typeof import("./init");
  let manager: typeof import("./manager")["channelManager"];
  const reload = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    handlers.clear();
    mocks.adapters.clear();
    reload.mockClear();
    for (const id of ["wechat", "feishu", "qq", "qqbot"]) mocks.settings[id] = { enabled: true };
    init = await import("./init");
    manager = (await import("./manager")).channelManager;
    init.initializeChannels({
      ipc: { handle: (id: string, fn: (...args: any[]) => any) => handlers.set(id, fn) } as never,
      handleIncoming: async () => null,
      reloadDispatcherSettings: reload,
    });
    await init.startChannels();
  });
  afterEach(async () => { await init.shutdownChannels(); });

  it("保存停用配置立即撤销且只停止对应渠道，重新启用恢复新连接", async () => {
    const old = manager.getActivitySignal("wechat")!;
    const other = manager.getActivitySignal("qq")!;
    const saving = handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { wechat: { enabled: false } });
    expect(old.aborted).toBe(true);
    await saving;
    expect(mocks.adapters.get("wechat").running).toBe(false);
    expect(other.aborted).toBe(false);
    expect(mocks.adapters.get("qq").stop).not.toHaveBeenCalled();
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { wechat: { enabled: true } });
    expect(mocks.adapters.get("wechat").running).toBe(true);
    expect(manager.getActivitySignal("wechat")?.aborted).toBe(false);
    expect(old.aborted).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("通用设置不重启连接，内置设置不影响插件渠道", async () => {
    const plugin = new mocks.Adapter("plugin-channel");
    mocks.settings[plugin.id] = { enabled: true };
    manager.register(plugin as never);
    await manager.startOne(plugin.id as ChannelId);
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, {});
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { feishu: { enabled: false } });
    expect(plugin.stop).not.toHaveBeenCalled();
    expect(plugin.running).toBe(true);
    expect(mocks.adapters.get("qq").start).toHaveBeenCalledOnce();
  });

  it.each(["qq", "qqbot"] as const)("%s 启动失败后原配置可显式重试，其他渠道不受影响", async (id) => {
    const plugin = new mocks.Adapter("plugin-channel");
    mocks.settings[plugin.id] = { enabled: true };
    manager.register(plugin as never);
    await manager.startOne(plugin.id as ChannelId);
    const adapter = mocks.adapters.get(id);
    await manager.stopOne(id);
    adapter.start.mockRejectedValueOnce(new Error("temporary_start_failure"));
    await expect(manager.startOne(id)).rejects.toThrow("temporary_start_failure");
    const other = manager.getActivitySignal("wechat")!;
    const starts = adapter.start.mock.calls.length;

    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { [id]: { enabled: true } });
    expect(adapter.start).toHaveBeenCalledTimes(starts);
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { [id]: { enabled: true } }, true);

    expect(adapter.start).toHaveBeenCalledTimes(starts + 1);
    expect(adapter.running).toBe(true);
    expect(manager.getActivitySignal(id)?.aborted).toBe(false);
    expect(other.aborted).toBe(false);
    expect(mocks.adapters.get("wechat").stop).not.toHaveBeenCalled();
    expect(mocks.adapters.get("feishu").start).toHaveBeenCalledOnce();
    expect(plugin.stop).not.toHaveBeenCalled();
    expect(plugin.start).toHaveBeenCalledOnce();
  });

  it("显式连接与配置变化合并为一次重建，不启动未启用或未指定的渠道", async () => {
    const qq = mocks.adapters.get("qq");
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { qq: { port: 6201 } }, true);
    expect(qq.stop).toHaveBeenCalledOnce();
    expect(qq.start).toHaveBeenCalledTimes(2);
    expect(qq.running).toBe(true);
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { qq: { enabled: false } }, true);
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { qq: { enabled: false } }, true);
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, {}, true);
    expect(qq.start).toHaveBeenCalledTimes(2);
    expect(qq.running).toBe(false);
    expect(mocks.adapters.get("wechat").stop).not.toHaveBeenCalled();
    expect(mocks.adapters.get("qqbot").stop).not.toHaveBeenCalled();
  });

  it("停用时仍可扫码和退出登录，但登录完成及安装不启动业务连接", async () => {
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { wechat: { enabled: false } });
    const wx = mocks.adapters.get("wechat");
    wx.start.mockClear();
    await expect(handlers.get(IPC.CHANNELS_WECHAT_LOGIN_START)!()).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(wx.login).toHaveBeenCalledOnce());
    await handlers.get(IPC.CHANNELS_WECHAT_INSTALL)!();
    expect(wx.start).not.toHaveBeenCalled();
    expect(handlers.get(IPC.CHANNELS_WECHAT_LOGIN_RESULT)).toBeTypeOf("function");
    await expect(handlers.get(IPC.CHANNELS_WECHAT_LOGOUT)!()).resolves.toEqual({ ok: true });
    expect(wx.logout).toHaveBeenCalledOnce();
    expect(wx.start).not.toHaveBeenCalled();
  });
});
