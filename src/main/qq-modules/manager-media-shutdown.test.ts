import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeTransport, capabilities, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
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
  const peer = peers[0]; const original = peer.behavior;
  peer.behavior = (request) => { if (request.method !== "mediaRelease") original(request); };
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

async function setupIdle(outbound = false) {
  const root = await mkdtemp(join(tmpdir(), "qq-stop-media-"));
  const cache = join(root, "cache");
  const broker = new QqMediaBroker(cache);
  const peers: FakeTransport[] = [];
  const manager = new QqModuleManager({
    getConfiguration: configuration, mediaBroker: broker,
    createTransport: () => {
      const peer = new FakeTransport(); peers.push(peer);
      if (outbound) {
        const original = peer.behavior;
        peer.behavior = (request) => request.method === "initialize"
          ? peer.reply(request, { capabilities: { ...capabilities, messages: { ...capabilities.messages, file: true, maxFileBytes: 1024 } } })
          : original(request);
      }
      return peer;
    },
  });
  cleanup.push(async () => { await manager.stop(); await rm(root, { recursive: true, force: true }); });
  const handler = vi.fn(async () => null);
  manager.onMessage = handler;
  await manager.start();
  return { root, broker, manager, handler, peers, files: () => readdir(cache) };
}

it("confirms stop after local preparation is revoked even without a reply to mediaRelease", async () => {
  const { broker, manager, handler, peers, files } = await setupIdle();
  const entered = deferred(); const releaseRequested = deferred();
  const peer = peers[0]; const original = peer.behavior;
  peer.behavior = (request) => {
    if (request.method === "mediaRead") { entered.resolve(); return; }
    if (request.method === "mediaRelease") { releaseRequested.resolve(); return; }
    if (request.method !== "quiesce") original(request);
  };
  peer.event("inbound", { ...inbound(), attachments: [{ kind: "image", mediaId: "picture-id", size: 24 }] });
  await entered.promise;
  expect(await files()).toEqual([]); // image header must be read before opening a file
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stopping = manager.stop();
  await releaseRequested.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await stopping;
  expect(await files()).toEqual([]);
  expect(broker.hasPendingCleanup).toBe(false);
  expect(peer.killed).toBe(true);
  expect(manager.isStoppedForMigration()).toBe(true);
  expect(handler).not.toHaveBeenCalled();
  await manager.start();
  expect(peers).toHaveLength(2);
});

it("does not block stop or restart when expiry unlink of a delivered file fails", async () => {
  const { broker, manager, handler, peers, files } = await setupIdle();
  const peer = peers[0]; const original = peer.behavior;
  peer.behavior = (request) => request.method === "mediaRead" ? peer.reply(request, { data: "aGVsbG8=", eof: true }) : original(request);
  peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "delivered", size: 5 }] });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  fault.unlink = vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
  await broker.cleanup(); // create an actual background expiry debt first
  expect(fault.unlink).toHaveBeenCalledOnce();
  expect(await files()).toHaveLength(1);
  await manager.stop();
  expect(manager.isStoppedForMigration()).toBe(true);
  expect(fault.unlink).toHaveBeenCalledOnce();
  expect(broker.hasPendingCleanup).toBe(false);
  await manager.start();
  expect(peers).toHaveLength(2);
  fault.unlink = undefined;
  await broker.cleanup();
  expect(await files()).toEqual([]);
});

it("does not wait for an in-flight expiry unlink when canceling a new attachment", async () => {
  const { broker, manager, handler, peers, files } = await setupIdle();
  const peer = peers[0]; const original = peer.behavior;
  peer.behavior = (request) => request.method === "mediaRead" ? peer.reply(request, { data: "aGVsbG8=", eof: true }) : original(request);
  peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "delivered", size: 5 }] });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  const entered = deferred(); const release = deferred();
  fault.unlink = async () => { entered.resolve(); await release.promise; };
  peer.event("inbound", { ...inbound("another"), attachments: [{ kind: "file", mediaId: "second", size: 5 }] });
  await entered.promise;
  const stopping = manager.stop();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.isStoppedForMigration()).toBe(true);
    expect(broker.hasPendingCleanup).toBe(false);
    expect(await files()).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(peer.messages.filter((request) => request.method === "mediaRead")).toHaveLength(1);
  } finally {
    release.resolve();
    await broker.cleanup();
    await stopping;
  }
  expect(await files()).toEqual([]);
});

it("still waits for mediaRelease before acknowledging successfully received media", async () => {
  const { handler, peers } = await setupIdle();
  const peer = peers[0]; const original = peer.behavior;
  let release: (() => void) | undefined;
  peer.behavior = (request) => {
    if (request.method === "mediaRead") peer.reply(request, { data: "aGVsbG8=", eof: true });
    else if (request.method === "mediaRelease") release = () => peer.reply(request, {});
    else original(request);
  };
  peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "ordered", size: 5 }] });
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(handler).not.toHaveBeenCalled();
  expect(peer.messages.some((request) => request.method === "ackInbound")).toBe(false);
  release!();
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  expect(peer.messages.find((request) => request.method === "ackInbound")?.payload).toMatchObject({ outcome: "accepted" });
});

it("does not spend a second stop budget in one restart when local cleanup is still stalled", async () => {
  const { manager, broker, peers } = await setup();
  const entered = deferred(), release = deferred();
  fault.close = async () => { entered.resolve(); await release.promise; };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const restarting = manager.restart().then(() => { finished = true; });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(true);
    expect(manager.getState().phase).toBe("failed");
    expect(manager.isStoppedForMigration()).toBe(false);
    expect(peers).toHaveLength(1);
  } finally { release.resolve(); await restarting; vi.useRealTimers(); }
  await broker.settleForShutdown();
  await manager.start(); // a later explicit operation may retry
  expect(peers).toHaveLength(2);
  expect(manager.getState().phase).toBe("running");
});

it("releases a failed outbound handle while close is still pending, without opening the local shutdown gate", async () => {
  const { root, broker, manager, peers } = await setupIdle(true);
  const filePath = join(root, "source.txt"); await writeFile(filePath, "hello");
  const peer = peers[0], original = peer.behavior;
  peer.behavior = (request) => {
    if (request.method === "mediaBeginUpload") peer.reply(request, { mediaId: "failed-upload" });
    else if (request.method === "mediaWrite") peer.emit({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch,
      kind: "response", responseTo: request.requestId, ok: false, error: { code: "unsupported" } });
    else original(request);
  };
  const entered = deferred(), release = deferred();
  fault.close = async () => { entered.resolve(); await release.promise; };
  const sending = manager.send({ channel: "qq", chatType: "group", targetId: "20000", parts: [{ kind: "file", filePath }] });
  try {
    await entered.promise;
    expect(peer.messages.filter(request => request.method === "mediaRelease").map(request => request.payload))
      .toEqual([{ connectionEpoch: 1, mediaId: "failed-upload" }]);
    expect(broker.hasPendingCleanup).toBe(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(manager.getState().phase).toBe("failed");
    expect(manager.isStoppedForMigration()).toBe(false);
    expect(peer.messages.some(request => request.method === "send")).toBe(false);
  } finally { release.resolve(); vi.useRealTimers(); }
  expect((await sending).outcome).toBe("failed");
  expect(peer.messages.filter(request => request.method === "mediaRelease")).toHaveLength(1);
  await manager.start();
  expect(peers).toHaveLength(2);
});
