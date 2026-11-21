import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeTransport, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
import { QqMediaBroker } from "./media-broker";
import { QqModuleManager } from "./manager";

const fault = vi.hoisted(() => ({ afterClose: false, close: undefined as (() => Promise<void>) | undefined, unlink: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fd = await actual.open(...args); const close = fd.close.bind(fd);
      fd.close = async () => {
        await fault.close?.(); await close();
        if (fault.afterClose) throw new Error("reported after closing");
      };
      return fd;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => { await fault.unlink?.(); return actual.unlink(...args); },
  };
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { fault.afterClose = false; fault.close = undefined; fault.unlink = undefined; vi.useRealTimers(); for (const task of cleanup.splice(0)) await task(); });
async function setup(multiple = false) {
  const root = await mkdtemp(join(tmpdir(), "qq-stop-media-"));
  const broker = new QqMediaBroker(join(root, "cache")); const peers: FakeTransport[] = [];
  const entered = deferred();
  const manager = new QqModuleManager({ getConfiguration: configuration, mediaBroker: broker, requestTimeoutMs: 100, drainTimeoutMs: 100,
    createTransport: () => {
      const peer = new FakeTransport(); peers.push(peer); const original = peer.behavior;
      peer.behavior = (request) => {
        if (multiple && request.method === "quiesce") {
          peer.emit({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch,
            kind: "response", responseTo: request.requestId, ok: false, error: { code: "unsupported" } });
        } else if (request.method === "mediaRead") {
          if (request.payload.mediaId === "first-id") peer.reply(request, { data: "aGVsbG8=", eof: true });
          else entered.resolve();
        } else original(request);
      };
      return peer;
    },
  });
  const handler = vi.fn(async () => null); manager.onMessage = handler;
  await manager.start();
  peers[0].event("inbound", { ...inbound(), attachments: [...(multiple ? [{ kind: "file" as const, mediaId: "first-id", size: 5 }] : []), { kind: "file", mediaId: "incoming-id", size: 5 }] });
  await entered.promise;
  cleanup.push(async () => { await broker.settleForShutdown(); await manager.stop(); await rm(root, { recursive: true, force: true }); });
  return { manager, broker, peers, handler, files: () => readdir(join(root, "cache")) };
}
it.each(["close", "unlink"] as const)("keeps stalled %s bounded, fails closed and prevents restart until cleanup completes", async (stage) => {
  const { manager, broker, peers, handler, files } = await setup();
  const entered = deferred(); const release = deferred();
  fault[stage] = async () => { entered.resolve(); await release.promise; };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = manager.stop();
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100); await stopping;
    expect(manager.getState().phase).toBe("failed");
    expect(manager.isStoppedForMigration()).toBe(false);
    expect(await files()).toHaveLength(1);
    const restarting = manager.start(); await vi.advanceTimersByTimeAsync(100); await restarting;
    expect(peers).toHaveLength(1); expect(manager.getState().phase).toBe("failed");
  } finally { release.resolve(); vi.useRealTimers(); }
  await broker.settleForShutdown();
  expect(await files()).toEqual([]); expect(handler).not.toHaveBeenCalled();
  await manager.start(); expect(peers).toHaveLength(2); expect(manager.getState().phase).toBe("running");
});
it("retains deletion failure across stop/start and recovers only after a successful retry", async () => {
  const { manager, broker, peers, handler, files } = await setup();
  fault.unlink = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await manager.stop();
    expect(manager.getState().phase).toBe("failed"); expect(manager.isStoppedForMigration()).toBe(false);
    expect(await files()).toHaveLength(1); expect(broker.hasPendingCleanup).toBe(true);
    await manager.start(); expect(peers).toHaveLength(1); expect(manager.getState().phase).toBe("failed");
    fault.unlink = undefined;
    await manager.start(); expect(peers).toHaveLength(2); expect(manager.getState().phase).toBe("running");
    expect(await files()).toEqual([]); expect(handler).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("tracks later discard of earlier attachments even when quiesce rejects", async () => {
  const { manager, broker, peers, handler, files } = await setup(true);
  const entered = deferred(); const release = deferred();
  fault.unlink = async () => { entered.resolve(); await release.promise; };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = manager.stop();
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100); await stopping;
    expect(manager.getState().phase).toBe("failed");
    expect(await files()).toHaveLength(2); expect(handler).not.toHaveBeenCalled();
  } finally { release.resolve(); vi.useRealTimers(); }
  await broker.settleForShutdown();
  await manager.stop();
  expect(manager.isStoppedForMigration()).toBe(true); expect(await files()).toEqual([]);
  await manager.start(); expect(peers).toHaveLength(2);
});

it("retains a genuinely unclosed handle after close rejection, even if unlink succeeds", async () => {
  const { manager, broker, peers } = await setup();
  // The hook rejects BEFORE actual.close, unlike a post-close error simulation.
  fault.close = async () => { throw Object.assign(new Error("close failed"), { code: "EIO" }); };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await manager.stop();
    expect(manager.getState().phase).toBe("failed"); expect(broker.hasPendingCleanup).toBe(true);
    await manager.start(); expect(peers).toHaveLength(1);
    fault.close = undefined;
    await manager.start(); expect(peers).toHaveLength(2); expect(broker.hasPendingCleanup).toBe(false);
  } finally { fault.close = undefined; vi.useRealTimers(); }
});

it("recognizes a confirmed closed descriptor despite a post-close error", async () => {
  const { manager, broker, files } = await setup(); fault.afterClose = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await manager.stop();
    expect(manager.isStoppedForMigration()).toBe(true);
    expect(broker.hasPendingCleanup).toBe(false); expect(await files()).toEqual([]);
  } finally { fault.afterClose = false; vi.useRealTimers(); }
});
