import { afterEach, expect, it, vi } from "vitest";
import { QqRoutingAdapter } from "./qq-routing-adapter";
import type { ChannelAdapter } from "./base";
import { QqModuleManager } from "../../qq-modules/manager";
import { FakeTransport, capabilities, configuration, inbound } from "../../../../scripts/verify/qq-module/fixtures";
import type { IncomingMessage, OutgoingMessage } from "../types";
const managers: QqModuleManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.stop())); });
function setup(initial: "legacy" | "blocked" = "legacy") {
  const legacy = { id: "qq" as const, displayName: "legacy", capability: capabilities.messages, onMessage: null as ChannelAdapter["onMessage"],
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), send: vi.fn(async () => ({ ok: true })), getStatus: () => ({ enabled: true, phase: "running" as const }),
    getMigrationIdentity: () => ({ accountId: "10000", connectionEpoch: 1 }), prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, drained: true, stopped: true })) };
  const router = new QqRoutingAdapter(legacy, initial);
  const peer = new FakeTransport(); const manager = new QqModuleManager({ getConfiguration: configuration, createTransport: () => peer }); managers.push(manager);
  return { legacy, router, peer, manager };
}
const outgoing: OutgoingMessage = { channel: "qq", chatType: "group", targetId: "20000", parts: [{ kind: "text", text: "reply" }] };
const incoming: IncomingMessage = { channel: "qq", senderId: "30000", chatId: "20000", text: "hello", at: new Date() };
it("delegates default legacy behavior with one channel identity and no double send", async () => {
  const s = setup(); s.router.onMessage = vi.fn(async () => outgoing);
  await s.router.start(); await s.legacy.onMessage!(incoming);
  expect(s.router.onMessage).toHaveBeenCalledOnce(); expect(s.legacy.send).not.toHaveBeenCalled();
  await s.router.send(outgoing); expect(s.legacy.send).toHaveBeenCalledOnce(); await s.router.stop();
  expect(s.legacy.start).toHaveBeenCalledOnce(); expect(s.legacy.stop).toHaveBeenCalledOnce();
});
it("requires independent legacy stop proof and never restarts selected module automatically", async () => {
  const s = setup(); await s.router.stop(); expect(() => s.router.attachModule(s.manager)).toThrow("SWITCH_UNCONFIRMED"); await s.router.start();
  await s.router.prepareMigrationStop({ accountId: "10000", connectionEpoch: 1 }); s.router.attachModule(s.manager);
  const handler = vi.fn(async () => null); s.router.onMessage = handler;
  await s.manager.stageForMigration(); s.peer.event("inbound", inbound("quarantined")); expect(handler).not.toHaveBeenCalled();
  expect(s.manager.activateMigration()).toBe(true); s.peer.event("inbound", inbound("active")); expect(handler).toHaveBeenCalledOnce();
  await expect(s.router.start()).rejects.toThrow("EXPLICIT_ACTIVATION_REQUIRED");
  expect((await s.router.send(outgoing)).ok).toBe(true); expect(s.legacy.send).not.toHaveBeenCalled();
  await s.router.stop(); await expect(s.router.start()).rejects.toThrow("EXPLICIT_ACTIVATION_REQUIRED");
});
it("keeps failure and startup recovery blocked without assuming old driver exited", async () => {
  const s = setup("blocked"); await expect(s.router.start()).rejects.toThrow(); expect(() => s.router.attachModule(s.manager)).toThrow();
  expect(await s.router.prepareFirstSetup(async () => false)).toBe(false); expect(() => s.router.attachModule(s.manager)).toThrow();
  expect(s.legacy.start).not.toHaveBeenCalled();
  const other = setup(); other.legacy.prepareMigrationStop.mockResolvedValue({ safeToSwitch: false, drained: false, stopped: false });
  await other.router.prepareMigrationStop({ accountId: "10000", connectionEpoch: 1 });
  await expect(other.router.start()).rejects.toThrow(); expect(() => other.router.attachModule(other.manager)).toThrow();
});
it("reserves first setup before awaiting proof and refuses parallel starts or attachment", async () => {
  const s = setup("blocked"); let release!: () => void;
  const claim = s.router.prepareFirstSetup(() => new Promise(resolve => { release = () => resolve(true); }));
  await expect(s.router.start()).rejects.toThrow("BUSY"); expect(() => s.router.attachModule(s.manager)).toThrow();
  release(); expect(await claim).toBe(true); s.router.attachModule(s.manager); expect(s.router.getDriver()).toBe("module");
  expect(s.manager.getState().phase).toBe("disabled"); expect(s.legacy.start).not.toHaveBeenCalled();
});
it("revokes old asynchronous replies and saved callbacks across a driver switch", async () => {
  const s = setup(); let release!: () => void; let result: unknown;
  s.router.onMessage = async () => { await new Promise<void>(r => { release = r; }); result = await s.router.send(outgoing); return null; };
  const saved = s.legacy.onMessage!; const task = saved(incoming);
  await s.router.prepareMigrationStop({ accountId: "10000", connectionEpoch: 1 }); s.router.attachModule(s.manager);
  await s.manager.stageForMigration(); s.manager.activateMigration(); release(); await task;
  expect(result).toMatchObject({ ok: false, error: "QQ_ROUTING_REVOKED" }); expect(s.legacy.send).not.toHaveBeenCalled();
  const handler = vi.fn(async () => null); s.router.onMessage = handler; await saved(incoming); expect(handler).not.toHaveBeenCalled();
});
it("permits existing legacy turn to drain but refuses new inbound and proactive sends during stop", async () => {
  const s = setup(); let releaseTurn!: () => void, releaseStop!: () => void;
  s.router.onMessage = async () => { await new Promise<void>(r => { releaseTurn = r; }); await s.router.send(outgoing); return null; };
  const turn = s.legacy.onMessage!(incoming);
  s.legacy.prepareMigrationStop.mockImplementation(() => new Promise(resolve => { releaseStop = () => resolve({ safeToSwitch: true, drained: true, stopped: true }); }));
  const stop = s.router.prepareMigrationStop({ accountId: "10000", connectionEpoch: 1 });
  await Promise.resolve();
  expect((await s.router.send(outgoing)).ok).toBe(false); expect(await s.legacy.onMessage!(incoming)).toBeNull();
  releaseTurn(); await turn; expect(s.legacy.send).toHaveBeenCalledOnce(); releaseStop(); await stop;
});

it("revokes pending attachment if shutdown races with first-setup proof", async () => {
  const s = setup("blocked"); let release!: () => void;
  const claim = s.router.prepareFirstSetup(() => new Promise(resolve => { release = () => resolve(true); }));
  const stopped = s.router.stop(); await Promise.resolve(); release(); await claim; await stopped;
  expect(() => s.router.attachModule(s.manager)).toThrow("SWITCH_UNCONFIRMED");
});

it("waits for an in-flight legacy start then actually stops it before resolving shutdown", async () => {
  const s = setup(); let release!: () => void; let closed = false;
  s.legacy.start.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const starting = s.router.start(); await Promise.resolve();
  const stopped = s.router.stop().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(s.legacy.stop).not.toHaveBeenCalled();
  await expect(s.router.start()).rejects.toThrow("BUSY"); release(); await starting; await stopped;
  expect(s.legacy.stop).toHaveBeenCalledOnce(); expect(closed).toBe(true);
});
it("waits for migration draining before shutdown and never permits its late attachment", async () => {
  const s = setup(); let release!: () => void;
  s.legacy.prepareMigrationStop.mockImplementation(() => new Promise(resolve => { release = () => resolve({ safeToSwitch: true, drained: true, stopped: true }); }));
  const draining = s.router.prepareMigrationStop({ accountId: "10000", connectionEpoch: 1 }); await Promise.resolve();
  const stopped = s.router.stop(); expect(s.legacy.stop).not.toHaveBeenCalled(); release(); await draining; await stopped;
  expect(s.legacy.stop).toHaveBeenCalledOnce(); expect(() => s.router.attachModule(s.manager)).toThrow("SWITCH_UNCONFIRMED");
});
