import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

const mocks = vi.hoisted(() => {
  const adapters = new Map<string, any>();
  class Adapter {
    onMessage = null;
    capability = {};
    displayName = "synthetic";
    running = false;
    constructor(readonly id: "qq" | "qqbot" | "feishu") { adapters.set(id, this); }
    start = vi.fn(async () => {
      const { loadChannelsSettings } = await import("./settings-store");
      this.running = loadChannelsSettings()[this.id].enabled;
    });
    stop = vi.fn(async () => { this.running = false; });
    getStatus() { return { enabled: this.running, phase: this.running ? "running" : "offline" }; }
  }
  return { root: "", adapters, Adapter, send: vi.fn(), clientCreated: vi.fn() };
});
vi.mock("electron", () => ({
  app: { getPath: () => mocks.root, isReady: () => true, getName: () => "synthetic" },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => ({ webContents: { send: mocks.send } }) },
}));
vi.mock("./adapters/feishu", () => ({ FeishuAdapter: class extends mocks.Adapter { constructor() { super("feishu"); } } }));
vi.mock("./adapters/qq/napcat-adapter", () => ({ NapCatAdapter: class extends mocks.Adapter { constructor() { super("qq"); } } }));
vi.mock("./adapters/qqbot/qqbot-adapter", () => ({ QqBotAdapter: class extends mocks.Adapter { constructor() { super("qqbot"); } } }));
vi.mock("./adapters/wechat/ilink-protocol-client", async (original) => ({
  ...await original<typeof import("./adapters/wechat/ilink-protocol-client")>(),
  fetchQrCode: async () => ({ qrcode: "synthetic", qrcode_img_content: "synthetic" }),
  pollQrStatus: async () => ({ status: "confirmed", bot_token: "synthetic-token", ilink_bot_id: "synthetic-bot" }),
  ILinkClient: class {
    constructor() { mocks.clientCreated(); }
    getUpdates(_buf: string, signal: AbortSignal) {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true }));
    }
  },
}));
vi.mock("./adapters/wechat/qr.js", () => ({ createQrDataUrl: async () => "synthetic-image" }));
vi.mock("./inbound-server", () => ({ startInboundServer: async () => ({ port: 0 }), stopInboundServer: vi.fn() }));
vi.mock("./message-log", () => ({ reloadLogFromDisk: vi.fn(), getRecentLog: vi.fn(), clearLog: vi.fn() }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ listSessions: async () => [], getSession: vi.fn() }));
vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: {} }));

describe("真实持久化与渠道管理边界", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let init: typeof import("./init");
  let manager: typeof import("./manager")["channelManager"];
  async function initialize() {
    vi.resetModules();
    handlers.clear();
    mocks.adapters.clear();
    init = await import("./init");
    manager = (await import("./manager")).channelManager;
    init.initializeChannels({
      ipc: { handle: (id: string, fn: (...args: any[]) => any) => handlers.set(id, fn) } as never,
      handleIncoming: async () => null, reloadDispatcherSettings: () => {},
    });
    await init.startChannels();
  }
  beforeEach(async () => {
    mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-persistence-"));
    mocks.send.mockClear();
    mocks.clientCreated.mockClear();
    const defaults = loadChannelsSettings();
    saveChannelsSettings({
      qq: { ...defaults.qq, enabled: true, listenMode: "loopback" },
      feishu: { enabled: true, appId: "synthetic", appSecret: "synthetic" },
    });
    await initialize();
  });
  afterEach(async () => {
    await init.shutdownChannels();
    fs.rmSync(mocks.root, { recursive: true, force: true });
  });

  it("无 token 的回环监听不因全局或其他渠道设置保存而重启，显式重试和真实变化仍生效", async () => {
    const qq = mocks.adapters.get("qq");
    const original = manager.getActivitySignal("qq")!;
    expect(loadChannelsSettings().qq.accessToken).toBeUndefined();
    for (const patch of [{ ttsEnabled: false }, { rateLimitPerUser: 17 }, { feishu: { appId: "synthetic-updated" } }, {}]) {
      await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, patch);
      expect(qq.stop).not.toHaveBeenCalled();
      expect(original.aborted).toBe(false);
    }
    const other = manager.getActivitySignal("feishu")!;
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { qq: { enabled: true } }, true);
    expect(qq.start).toHaveBeenCalledTimes(2);
    expect(qq.stop).toHaveBeenCalledOnce();
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { qq: { port: 6201 } });
    expect(qq.start).toHaveBeenCalledTimes(3);
    expect(other.aborted).toBe(false);
  });

  it("停用时扫码和冷启动均保留凭证状态，启停连接不等于注销", async () => {
    const result = () => handlers.get(IPC.CHANNELS_WECHAT_LOGIN_RESULT)!();
    await expect(result()).resolves.toMatchObject({ loggedIn: false, connected: false });
    await handlers.get(IPC.CHANNELS_WECHAT_LOGIN_START)!();
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: true, botId: "synthetic-bot" }));
    await expect(result()).resolves.toEqual({ loggedIn: true, connected: false, running: false });
    expect(mocks.clientCreated).not.toHaveBeenCalled();
    await init.shutdownChannels();
    await initialize();
    await expect(result()).resolves.toEqual({ loggedIn: true, connected: false, running: false });
    expect(mocks.clientCreated).not.toHaveBeenCalled();
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { wechat: { enabled: true } });
    await expect(result()).resolves.toMatchObject({ loggedIn: true, connected: true });
    expect(mocks.clientCreated).toHaveBeenCalledOnce();
    await handlers.get(IPC.CHANNELS_SAVE_CONFIG)!(null, { wechat: { enabled: false } });
    await expect(result()).resolves.toEqual({ loggedIn: true, connected: false, running: false });
    await handlers.get(IPC.CHANNELS_WECHAT_LOGOUT)!();
    await expect(result()).resolves.toMatchObject({ loggedIn: false, connected: false });
    expect(mocks.clientCreated).toHaveBeenCalledOnce();
  });
});
