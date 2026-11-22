import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ mode: "legacy" as "legacy" | "blocked", adapters: [] as any[], legacy: undefined as any,
  stopAll: vi.fn(async () => {}), restartAll: vi.fn(async (_preserve: (id: any) => boolean) => {}), handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic-user-data" }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../qq-modules/startup-recovery", () => ({ getQqStartupMode: () => state.mode }));
vi.mock("../application/ipc-scope", () => ({ createIpcScope: () => ({ handle: (key: string, fn: any) => state.handlers.set(key, fn) }) }));
vi.mock("./manager", () => ({ channelManager: { setDispatcher: vi.fn(), stopAll: state.stopAll, restartAll: state.restartAll, register: (a: any) => state.adapters.push(a), getAllStatus: () => ({}), listChannels: () => state.adapters.map(a => a.id) } }));
vi.mock("./adapters/qq/napcat-adapter", () => ({ NapCatAdapter: class {
  id = "qq"; displayName = "QQ"; onMessage = null; capability = {};
  start = vi.fn(async () => {}); stop = vi.fn(async () => {}); testConnection = vi.fn(async () => ({ ok: true }));
  getStatus = () => ({ enabled: false, phase: "offline" }); getMigrationIdentity = () => null;
  prepareMigrationStop = async () => ({ safeToSwitch: false, drained: false, stopped: false });
  send = async () => ({ ok: true }); constructor() { state.legacy = this; }
} }));
vi.mock("./adapters/feishu", () => ({ FeishuAdapter: class { id = "feishu"; } }));
vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({ ILinkBotAdapter: class { id = "wechat"; }, loadCredentials: vi.fn() }));
vi.mock("./adapters/qqbot/qqbot-adapter", () => ({ QqBotAdapter: class { id = "qqbot"; } }));
vi.mock("./settings-store", () => ({ loadChannelsSettings: vi.fn(), readQqModulePreflightToken: vi.fn(), saveChannelsSettings: vi.fn() }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ listSessions: vi.fn(), getSession: vi.fn() }));
vi.mock("./conversation-binding-api", () => ({ bindContextConversation: vi.fn(), getContextBindingSnapshot: vi.fn(), unbindContextConversation: vi.fn() }));
vi.mock("./inbound-server", () => ({ startInboundServer: vi.fn(), stopInboundServer: vi.fn() }));
vi.mock("./message-log", () => ({ getRecentLog: vi.fn(), clearLog: vi.fn(), reloadLogFromDisk: vi.fn() }));
vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: { Channels: "Channels" } }));
import { IPC } from "../../shared/ipc-channels";
beforeEach(() => { vi.resetModules(); state.adapters = []; state.stopAll.mockClear(); state.restartAll.mockClear(); state.handlers.clear(); state.mode = "legacy"; });
it("registers one qq routing adapter and preserves default legacy start/test", async () => {
  const { initializeChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  const qq = state.adapters.filter(a => a.id === "qq"); expect(qq).toHaveLength(1); expect(qq[0]).not.toBe(state.legacy);
  await qq[0].start(); expect(state.legacy.start).toHaveBeenCalledOnce();
  expect(await state.handlers.get(IPC.CHANNELS_QQ_TEST_CONNECTION)!(null)).toEqual({ ok: true });
});
it("does not let a host option override durable startup blocking or bypass it through connection test", async () => {
  state.mode = "blocked";
  const { initializeChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn(), qqStartupMode: "legacy" });
  const qq = state.adapters.find(a => a.id === "qq"); await expect(qq.start()).rejects.toThrow("EXPLICIT_ACTIVATION_REQUIRED");
  expect(await state.handlers.get(IPC.CHANNELS_QQ_TEST_CONNECTION)!(null)).toMatchObject({ ok: false });
  expect(state.legacy.start).not.toHaveBeenCalled(); expect(state.legacy.testConnection).not.toHaveBeenCalled();
});

it("waits for trusted binding shutdown before adapter teardown and reinitialization", async () => {
  const { initializeChannels, shutdownChannels } = await import("./init");
  let release!: () => void;
  const binding = { port: {} as any, isTrustedSender: () => false, shutdown: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) };
  const options = { handleIncoming: async () => null, reloadDispatcherSettings: vi.fn(), configureQqRouting: () => binding };
  initializeChannels(options); const stopped = shutdownChannels();
  expect(binding.shutdown).toHaveBeenCalledOnce(); expect(state.stopAll).not.toHaveBeenCalled();
  initializeChannels(options); expect(state.adapters).toHaveLength(4);
  release(); await stopped; expect(state.stopAll).toHaveBeenCalledOnce();
  initializeChannels(options); expect(state.adapters).toHaveLength(8);
});
it("keeps action IPC unconfigured when no trusted binding is supplied", async () => {
  const { initializeChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  expect(await state.handlers.get(IPC.CHANNELS_QQ_MODULE_ACTION)!(null, { action: "preview-install" })).toEqual({ ok: false, error: "unconfigured" });
});

it("rejects legacy QQ setting edits while blocked without preventing other channel settings", async () => {
  state.mode = "blocked";
  const { initializeChannels } = await import("./init");
  const settings = await import("./settings-store");
  vi.mocked(settings.loadChannelsSettings).mockReturnValue({ qq: {}, qqbot: {} } as any);
  vi.mocked(settings.saveChannelsSettings).mockClear();
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  const save = state.handlers.get(IPC.CHANNELS_SAVE_CONFIG)!;
  expect(() => save(null, { qq: { enabled: false, allowedGroupIds: [] } })).toThrow("EXPLICIT_RECONFIGURATION");
  expect(settings.saveChannelsSettings).not.toHaveBeenCalled();
  save(null, { feishu: { enabled: false } });
  expect(settings.saveChannelsSettings).toHaveBeenCalledOnce();
});

it.each(["legacy", "blocked", "module"])("generic restart preserves only nonlegacy QQ (%s)", async (driver) => {
  const { initializeChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  const qq = state.adapters.find(a => a.id === "qq");
  vi.spyOn(qq, "isLegacyBlocked").mockReturnValue(driver !== "legacy");
  expect(await state.handlers.get(IPC.CHANNELS_RESTART)!(null)).toEqual({ ok: true });
  expect(state.stopAll).not.toHaveBeenCalled();
  expect(state.restartAll).toHaveBeenCalledOnce();
  const preserve = state.restartAll.mock.calls[0][0];
  expect(preserve("qq")).toBe(driver !== "legacy");
  expect(preserve("wechat")).toBe(false); expect(preserve("feishu")).toBe(false); expect(preserve("qqbot")).toBe(false);
});


it("waits for an accepted restart before full shutdown and rejects new restarts during shutdown", async () => {
  const { initializeChannels, shutdownChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  let release!: () => void;
  state.restartAll.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const restart = state.handlers.get(IPC.CHANNELS_RESTART)!;
  const accepted = restart(null);
  const shutdown = shutdownChannels();
  expect(state.stopAll).not.toHaveBeenCalled();
  expect(await restart(null)).toEqual({ ok: false, error: "CHANNELS_SHUTTING_DOWN" });
  expect(state.restartAll).toHaveBeenCalledOnce();
  release(); await accepted; await shutdown;
  expect(state.stopAll).toHaveBeenCalledOnce();
  expect(await restart(null)).toEqual({ ok: false, error: "CHANNELS_SHUTTING_DOWN" });
});
