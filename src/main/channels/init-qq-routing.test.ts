import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChannelManager } from "./manager";
import type { QqRoutingAdapter } from "./adapters/qq-routing-adapter";
import type { QqModuleActionPort } from "../qq-modules/action-gateway";
import { QqModuleManager } from "../qq-modules/manager";
import { FakeTransport, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
const state = vi.hoisted(() => ({ mode: "legacy" as "legacy" | "blocked", adapters: [] as any[], legacy: undefined as any,
  manager: undefined as ChannelManager | undefined, stopAll: vi.fn(async () => {}),
  restartAll: vi.fn(async (_preserve: (id: any) => boolean, _signal?: AbortSignal): Promise<ReadonlySet<string>> => new Set()),
  stopInboundServer: vi.fn(async () => {}), handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock("electron", () => ({ app: { getPath: () => "/synthetic-user-data" }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../qq-modules/startup-recovery", () => ({ getQqStartupMode: () => state.mode }));
vi.mock("../application/ipc-scope", () => ({ createIpcScope: () => ({ handle: (key: string, fn: any) => state.handlers.set(key, fn) }) }));
vi.mock("./manager", () => ({ channelManager: {
  setDispatcher: (fn: Parameters<ChannelManager["setDispatcher"]>[0]) => state.manager?.setDispatcher(fn),
  stopAll: state.stopAll, restartAll: state.restartAll, startAll: () => state.manager?.startAll(),
  hasLiveDispatcher: (a: QqRoutingAdapter) => state.manager?.hasLiveDispatcher(a),
  register: (...args: Parameters<ChannelManager["register"]>) => { state.adapters.push(args[0]); state.manager?.register(...args); },
  getAllStatus: () => ({}), listChannels: () => state.adapters.map(a => a.id),
} }));
vi.mock("./adapters/qq/napcat-adapter", () => ({ NapCatAdapter: class {
  id = "qq"; displayName = "QQ"; onMessage = null; capability = {};
  start = vi.fn(async () => {}); stop = vi.fn(async () => {}); testConnection = vi.fn(async () => ({ ok: true }));
  getStatus = () => ({ enabled: false, phase: "offline" }); getMigrationIdentity = () => null;
  prepareMigrationStop = async () => ({ safeToSwitch: false, drained: false, stopped: false });
  send = async () => ({ ok: true }); constructor() { state.legacy = this; }
} }));
vi.mock("./adapters/feishu", () => ({ FeishuAdapter: class { id = "feishu"; start = vi.fn(async () => {}); stop = vi.fn(async () => {}); } }));
vi.mock("./adapters/wechat/ilink-bot-adapter", () => ({ ILinkBotAdapter: class { id = "wechat"; start = vi.fn(async () => {}); stop = vi.fn(async () => {}); }, loadCredentials: vi.fn() }));
vi.mock("./adapters/qqbot/qqbot-adapter", () => ({ QqBotAdapter: class { id = "qqbot"; start = vi.fn(async () => {}); stop = vi.fn(async () => {}); } }));
vi.mock("./settings-store", () => ({ loadChannelsSettings: vi.fn(), readQqModulePreflightToken: vi.fn(), saveChannelsSettings: vi.fn() }));
vi.mock("./conversation-binding-store", () => ({ getChannelConversationBindingStore: vi.fn() }));
vi.mock("../chats/chats-store", () => ({ listSessions: vi.fn(), getSession: vi.fn() }));
vi.mock("./conversation-binding-api", () => ({ bindContextConversation: vi.fn(), getContextBindingSnapshot: vi.fn(), unbindContextConversation: vi.fn() }));
vi.mock("./inbound-server", () => ({ startInboundServer: vi.fn(), stopInboundServer: state.stopInboundServer }));
vi.mock("./message-log", () => ({ getRecentLog: vi.fn(), clearLog: vi.fn(), reloadLogFromDisk: vi.fn() }));
vi.mock("../logger", () => ({ logger: { info: vi.fn() }, LogTag: { Channels: "Channels" } }));
import { IPC } from "../../shared/ipc-channels";
beforeEach(() => {
  vi.resetModules(); state.adapters = []; state.manager = undefined;
  state.stopAll.mockReset().mockImplementation(async () => state.manager?.stopAll());
  state.restartAll.mockReset().mockImplementation(async (preserve, signal) => (await state.manager?.restartAll(preserve, signal)) ?? new Set());
  state.stopInboundServer.mockClear(); state.handlers.clear(); state.mode = "legacy";
});
async function useRealManager() {
  const { ChannelManager } = await vi.importActual<typeof import("./manager")>("./manager");
  return state.manager = new ChannelManager();
}
function trustedAction() {
  const mainFrame = {};
  const sender = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false });
  return (command: unknown) => state.handlers.get(IPC.CHANNELS_QQ_MODULE_ACTION)!({ sender, senderFrame: mainFrame }, command);
}
const firstSetupPreview = { operationId: "setup", packageId: `pkg-${"a".repeat(64)}`, accountId: "10000" };
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


it("shuts down during a hung restart connection without waiting for it and cleans up late success", async () => {
  const manager = await useRealManager();
  const { initializeChannels, shutdownChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  const feishu = state.adapters.find(a => a.id === "feishu");
  const wechat = state.adapters.find(a => a.id === "wechat");
  await manager.startAll();
  const entered = Promise.withResolvers<void>(), connect = Promise.withResolvers<void>();
  feishu.start.mockImplementationOnce(() => { entered.resolve(); return connect.promise; });
  const restart = state.handlers.get(IPC.CHANNELS_RESTART)!;
  const accepted = restart(null);
  await entered.promise;
  let finished = false;
  const shutdown = shutdownChannels().then(() => { finished = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(finished).toBe(true);
    expect(state.stopAll).toHaveBeenCalledOnce();
    expect(state.stopInboundServer).toHaveBeenCalledOnce();
    expect(await accepted).toEqual({ ok: false, error: "CHANNELS_SHUTTING_DOWN" });
    expect(await restart(null)).toEqual({ ok: false, error: "CHANNELS_SHUTTING_DOWN" });
    expect(wechat.start).toHaveBeenCalledOnce();
    expect(feishu.stop).toHaveBeenCalledOnce(); // only ordinary pre-restart stop so far
  } finally { connect.resolve(); await shutdown; }
  await vi.waitFor(() => expect(feishu.stop).toHaveBeenCalledTimes(2));
  expect(wechat.start).toHaveBeenCalledOnce();
});

it("never resumes the start or remaining stop phase of a restart accepted before shutdown", async () => {
  const manager = await useRealManager();
  const { initializeChannels, shutdownChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  const feishu = state.adapters.find(a => a.id === "feishu");
  const wechat = state.adapters.find(a => a.id === "wechat");
  await manager.startAll();
  const entered = Promise.withResolvers<void>(), disconnect = Promise.withResolvers<void>();
  feishu.stop.mockImplementationOnce(() => { entered.resolve(); return disconnect.promise; });
  const restart = state.handlers.get(IPC.CHANNELS_RESTART)!;
  const accepted = restart(null);
  await entered.promise;
  let finished = false;
  const shutdown = shutdownChannels().then(() => { finished = true; });
  try {
    await vi.waitFor(() => expect(wechat.stop).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(feishu.stop).toHaveBeenCalledOnce(); // join existing stop; never issue it twice
    expect(state.stopInboundServer).not.toHaveBeenCalled();
  } finally { disconnect.resolve(); await shutdown; }
  expect(state.stopInboundServer).toHaveBeenCalledOnce();
  expect(await accepted).toEqual({ ok: false, error: "CHANNELS_SHUTTING_DOWN" });
  expect(wechat.stop).toHaveBeenCalledOnce();
  expect(feishu.start).toHaveBeenCalledOnce();
  expect(wechat.start).toHaveBeenCalledOnce();
});

it("dispatches an explicitly activated module before background channel startup, but not before activation or after teardown", async () => {
  await useRealManager();
  const { initializeChannels, shutdownChannels } = await import("./init");
  const peer = new FakeTransport();
  const module = new QqModuleManager({ getConfiguration: configuration, createTransport: () => peer });
  const incoming = vi.fn(async () => null);
  let registered: QqRoutingAdapter | undefined;
  initializeChannels({
    qqStartupMode: "blocked", handleIncoming: incoming, reloadDispatcherSettings: vi.fn(),
    configureQqRouting: (router) => {
      registered = router;
      const port: QqModuleActionPort = { async execute(command) {
        if (command.action === "preview-setup") return { ok: true, state: "preview-setup", preview: firstSetupPreview };
        expect(command.action).toBe("confirm-setup");
        expect(await router.prepareFirstSetup(async () => true)).toBe(true);
        router.attachModule(module);
        await module.stageForMigration();
        peer.event("inbound", inbound("quarantined"));
        expect(incoming).not.toHaveBeenCalled();
        expect(module.activateMigration()).toBe(true);
        return { ok: true, state: "committed" };
      } };
      return { port, isTrustedSender: () => true, shutdown: () => router.shutdown() };
    },
  });
  const invoke = trustedAction();
  try {
    expect(await invoke({ action: "preview-setup", accountId: "10000" })).toMatchObject({ ok: true, state: "preview-setup" });
    expect(await invoke({ action: "confirm-setup", operationId: "setup", accountId: "10000", userConfirmed: true })).toEqual({ ok: true, state: "committed" });
    const saved = registered!.onMessage!;
    peer.event("inbound", inbound("active"));
    await vi.waitFor(() => expect(incoming).toHaveBeenCalledOnce());
    expect(peer.messages.filter(request => request.method === "ackInbound").map(request => request.payload))
      .toEqual([{ eventId: "quarantined", outcome: "stale-instance" }, { eventId: "active", outcome: "accepted" }]);
    expect(state.legacy.start).not.toHaveBeenCalled();
    await shutdownChannels();
    await saved({ channel: "qq", chatId: "20000", senderId: "30000", text: "late", at: new Date(0) });
    expect(incoming).toHaveBeenCalledOnce();
  } finally { await module.stop(); }
});

it("preserves the confirmed QQ migration before and during legacy drain despite ordinary channel restarts", async () => {
  const manager = await useRealManager();
  const { initializeChannels, shutdownChannels } = await import("./init");
  const peer = new FakeTransport();
  const module = new QqModuleManager({ getConfiguration: configuration, createTransport: () => peer });
  const beforeDrain = Promise.withResolvers<void>(), enterDrain = Promise.withResolvers<void>();
  const duringDrain = Promise.withResolvers<void>(), finishDrain = Promise.withResolvers<void>();
  let route!: QqRoutingAdapter;
  initializeChannels({
    handleIncoming: async () => null, reloadDispatcherSettings: vi.fn(),
    configureQqRouting: (router) => {
      route = router;
      const port: QqModuleActionPort = { async execute(command) {
        if (command.action === "preview-migration") return { ok: true, state: "preview-migration", preview: firstSetupPreview };
        expect(command.action).toBe("confirm-migration");
        beforeDrain.resolve();
        await enterDrain.promise;
        const proof = await router.prepareMigrationStop({ accountId: "10000", connectionEpoch: 1 });
        expect(proof).toEqual({ safeToSwitch: true, drained: true, stopped: true });
        router.attachModule(module);
        await module.stageForMigration();
        expect(module.activateMigration()).toBe(true);
        return { ok: true, state: "committed" };
      } };
      return { port, isTrustedSender: () => true, shutdown: () => router.shutdown() };
    },
  });
  state.legacy.prepareMigrationStop = async () => {
    duringDrain.resolve();
    await finishDrain.promise;
    return { safeToSwitch: true, drained: true, stopped: true };
  };
  await manager.startAll();
  const invoke = trustedAction(), restart = state.handlers.get(IPC.CHANNELS_RESTART)!;
  let migration: Promise<unknown> | undefined;
  try {
    expect(await invoke({ action: "preview-migration" })).toMatchObject({ ok: true, state: "preview-migration" });
    migration = invoke({ action: "confirm-migration", operationId: "setup", accountId: "10000", userConfirmed: true });
    await beforeDrain.promise;
    expect(route.isLegacyBlocked()).toBe(false); // controller owns the pending confirm before router drain
    expect(await restart(null)).toEqual({ ok: true });
    expect(state.legacy.stop).not.toHaveBeenCalled();
    expect(state.legacy.start).toHaveBeenCalledOnce();
    enterDrain.resolve();
    await duringDrain.promise;
    expect(route.isLegacyBlocked()).toBe(false); // still reports legacy until independent stop proof
    expect(await restart(null)).toEqual({ ok: true });
    expect(state.legacy.stop).not.toHaveBeenCalled();
    finishDrain.resolve();
    expect(await migration).toEqual({ ok: true, state: "committed" });
    expect(route.getDriver()).toBe("module");
    expect(peer.messages.filter(request => request.method === "start")).toHaveLength(1);
  } finally {
    enterDrain.resolve(); finishDrain.resolve();
    await migration;
    await shutdownChannels();
  }
});

it("does not enter a trusted activation when an ordinary restart has detached the QQ dispatcher", async () => {
  const manager = await useRealManager();
  const { initializeChannels, shutdownChannels } = await import("./init");
  const routeStopping = Promise.withResolvers<void>(), releaseStop = Promise.withResolvers<void>();
  const execute = vi.fn<QqModuleActionPort["execute"]>(async command => command.action === "preview-setup"
    ? { ok: true, state: "preview-setup", preview: firstSetupPreview }
    : { ok: true, state: "committed" });
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn(),
    configureQqRouting: (router) => ({ port: { execute }, isTrustedSender: () => true, shutdown: () => router.shutdown() }),
  });
  await manager.startAll();
  state.legacy.stop.mockImplementationOnce(() => { routeStopping.resolve(); return releaseStop.promise; });
  const restart = state.handlers.get(IPC.CHANNELS_RESTART)!(null);
  try {
    await routeStopping.promise;
    const invoke = trustedAction();
    const preview = { action: "preview-setup", accountId: "10000" };
    const confirm = { action: "confirm-setup", operationId: "setup", accountId: "10000", userConfirmed: true };
    expect(await invoke(preview)).toMatchObject({ ok: true });
    expect(await invoke(confirm)).toEqual({ ok: false, error: "busy" });
    expect(execute).toHaveBeenCalledExactlyOnceWith(preview);
    releaseStop.resolve(); await restart;
    expect(await invoke(preview)).toMatchObject({ ok: true });
    expect(await invoke(confirm)).toEqual({ ok: true, state: "committed" });
    expect(execute).toHaveBeenLastCalledWith(confirm);
  } finally { releaseStop.resolve(); await restart; await shutdownChannels(); }
});

it("blocks QQ writes during confirmed handoff and reports an earlier saved change that was skipped even if migration settles first", async () => {
  const manager = await useRealManager();
  const { initializeChannels, shutdownChannels } = await import("./init");
  const settings = await import("./settings-store");
  vi.mocked(settings.loadChannelsSettings).mockReturnValue({ qq: {}, qqbot: {} } as any);
  vi.mocked(settings.saveChannelsSettings).mockClear();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let route!: QqRoutingAdapter;
  initializeChannels({
    handleIncoming: async () => null, reloadDispatcherSettings: vi.fn(),
    configureQqRouting(router) {
      route = router;
      const port: QqModuleActionPort = { async execute(command) {
        if (command.action === "preview-migration") return { ok: true, state: "preview-migration", preview: firstSetupPreview };
        entered.resolve(); await finish.promise;
        // Synthetic failed pre-stop proof: old listener remains in legacy mode.
        return { ok: true, state: "rolled-back" };
      } };
      return { port, isTrustedSender: () => true, shutdown: () => router.shutdown() };
    },
  });
  await manager.startAll();
  const save = state.handlers.get(IPC.CHANNELS_SAVE_CONFIG)!;
  const restart = state.handlers.get(IPC.CHANNELS_RESTART)!;
  const invoke = trustedAction();
  const feishu = state.adapters.find(a => a.id === "feishu");
  const stopping = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  feishu.stop.mockImplementationOnce(async () => { stopping.resolve(); await resume.promise; });
  let migration: Promise<unknown> | undefined, applying: Promise<unknown> | undefined;
  try {
    save(null, { qq: { port: 6201 } });
    expect(settings.saveChannelsSettings).toHaveBeenCalledExactlyOnceWith({ qq: { port: 6201 } });
    expect(await invoke({ action: "preview-migration" })).toMatchObject({ ok: true, state: "preview-migration" });
    migration = invoke({ action: "confirm-migration", operationId: "setup", accountId: "10000", userConfirmed: true });
    await entered.promise;
    expect(route.isLegacyBlocked()).toBe(false);
    expect(() => save(null, { qq: { port: 6202 } })).toThrow("QQ_MODULE_SETTINGS_BUSY");
    expect(settings.saveChannelsSettings).toHaveBeenCalledOnce();
    save(null, { feishu: { enabled: false } });
    expect(settings.saveChannelsSettings).toHaveBeenCalledTimes(2);
    applying = restart(null, "qq");
    await stopping.promise;
    finish.resolve(); expect(await migration).toEqual({ ok: true, state: "rolled-back" });
    expect(route.shouldPreserveForSettingsRestart()).toBe(false);
    resume.resolve(); expect(await applying).toEqual({ ok: false, error: "QQ_MODULE_SETTINGS_BUSY" });
    expect(state.legacy.stop).not.toHaveBeenCalled(); expect(state.legacy.start).toHaveBeenCalledOnce();
    expect(await restart(null, "qq")).toEqual({ ok: true });
    expect(state.legacy.stop).toHaveBeenCalledOnce(); expect(state.legacy.start).toHaveBeenCalledTimes(2);
  } finally { finish.resolve(); resume.resolve(); await migration; await applying; await shutdownChannels(); }
});

it("reports QQ cannot be applied to a blocked route, but an ordinary restart remains valid", async () => {
  await useRealManager();
  state.mode = "blocked";
  const { initializeChannels, shutdownChannels } = await import("./init");
  initializeChannels({ handleIncoming: async () => null, reloadDispatcherSettings: vi.fn() });
  const restart = state.handlers.get(IPC.CHANNELS_RESTART)!;
  try {
    expect(await restart(null, "qq")).toEqual({ ok: false, error: "QQ_MODULE_SETTINGS_REQUIRE_EXPLICIT_RECONFIGURATION" });
    expect(await restart(null)).toEqual({ ok: true });
    expect(state.legacy.start).not.toHaveBeenCalled();
  } finally { await shutdownChannels(); }
});
