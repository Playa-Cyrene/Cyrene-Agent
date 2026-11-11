import { afterEach, describe, expect, it, vi } from "vitest";
import { QqModuleAdapter } from "../channels/adapters/qq-module-adapter";
import { QqModuleManager } from "./manager";
import { FakeTransport, capabilities, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
import type { OutgoingMessage } from "../channels/types";

const outgoing = (): OutgoingMessage => ({ channel: "qq", chatType: "group", targetId: "20000", parts: [{ kind: "text", text: "response" }] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const managers: QqModuleManager[] = [];
function setup(options: Partial<ConstructorParameters<typeof QqModuleManager>[0]> = {}) {
  const peer = new FakeTransport();
  const manager = new QqModuleManager({ getConfiguration: configuration, createTransport: () => peer, requestTimeoutMs: 40, drainTimeoutMs: 40, ...options });
  managers.push(manager); return { peer, manager };
}
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.stop())); });
describe("QQ host runtime manager", () => {
  it("does no work on construction; missing/disabled modules do not start or download", async () => {
    const getConfiguration = vi.fn(configuration); const createTransport = vi.fn(() => new FakeTransport());
    const { manager } = setup({ getConfiguration, createTransport });
    expect(getConfiguration).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
    const missing = setup({ createTransport: undefined }); await missing.manager.start();
    expect(missing.manager.getState().phase).toBe("module-missing");
    const disabled = setup({ getConfiguration: () => null }); await disabled.manager.start();
    expect(disabled.manager.getState().phase).toBe("disabled"); expect(disabled.peer.messages).toHaveLength(0);
    await Promise.all([manager.start(), manager.start()]); expect(createTransport).toHaveBeenCalledOnce();
    expect(manager.getState().phase).toBe("running");
  });
  it("does not release credentials before compatible hello, and requires pin/non-loopback token", async () => {
    const { peer, manager } = setup();
    peer.behavior = (req) => peer.reply(req, { moduleId: "qfca", moduleVersion: "0.1.0", apiSupport: { major: 2, minMinor: 0, maxMinor: 0 } });
    await manager.start(); expect(manager.getState().phase).toBe("incompatible");
    expect(peer.messages.map((m) => m.method)).toEqual(["hello"]);
    expect(JSON.stringify(peer.messages)).not.toContain("test-only-token");
    for (const config of [{ ...configuration().config, expectedSelfId: "" }, { ...configuration().config, listen: { host: "0.0.0.0", port: 30001 } }]) {
      const broken = setup({ getConfiguration: () => ({ config, credentials: { accessToken: "" } }) });
      await broken.manager.start(); expect(broken.manager.getState().phase).toBe("config-missing"); expect(broken.peer.messages).toHaveLength(0);
    }
  });
  it("owns channel identity, derives mentions and awaits full dispatch without resending return value", async () => {
    const { peer, manager } = setup(); const adapter = new QqModuleAdapter(manager);
    const handler = vi.fn(async () => outgoing()); adapter.onMessage = handler;
    await adapter.start(); peer.event("inbound", { ...inbound(), reply: { messageId: "12", text: "quoted" } }); await tick();
    expect(handler).toHaveBeenCalledOnce(); expect(handler.mock.calls[0]?.[0]).toMatchObject({ channel: "qq", chatType: "group", chatId: "20000", threadId: "20000", mentions: [{ userId: "10000", isBot: true }], at: new Date(1700000000000) });
    expect(peer.messages.filter((m) => m.method === "send")).toHaveLength(0);
    expect(peer.messages.filter((m) => m.method === "ackInbound").at(-1)?.payload).toMatchObject({ outcome: "accepted" });
    expect(adapter.capability.text).toBe(true); expect(adapter.capability.image).toBe(false);
    expect(adapter.getStatus().phase).toBe("running");
  });
  it("enforces current whitelist, self ID, private identity, mentions, media and dedupe", async () => {
    const { peer, manager } = setup(); const handler = vi.fn(async () => null); manager.onMessage = handler;
    await manager.start();
    for (const message of [ { ...inbound("wrong-self"), selfId: "999" }, { ...inbound("old-connection"), connectionEpoch: 0 }, { ...inbound("old-revision"), configRevision: 0 }, { ...inbound("no-mention"), mentions: [] }, { ...inbound("unknown-group"), conversation: { type: "group", groupId: "999" } }, { ...inbound("fake-private"), conversation: { type: "private", peerId: "30000" }, senderId: "999" }, { ...inbound("media"), attachments: [{ kind: "image", mediaId: "x" }] } ]) peer.event("inbound", message);
    await tick(); expect(handler).not.toHaveBeenCalled();
    peer.event("inbound", inbound()); peer.event("inbound", inbound()); await tick(); expect(handler).toHaveBeenCalledOnce();
    manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] });
    peer.event("inbound", inbound("revoked")); await tick(); expect(handler).toHaveBeenCalledOnce();
    expect((await manager.send(outgoing())).outcome).toBe("failed");
  });
  it("keeps accepted turns sending while draining, then terminates and removes listeners", async () => {
    const { peer, manager } = setup(); let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let sent: unknown;
    manager.onMessage = async () => { await gate; sent = await manager.send(outgoing()); return null; };
    await manager.start(); peer.event("inbound", inbound()); await tick();
    const stopped = manager.stop(); await tick(); expect(manager.getState().phase).toBe("draining");
    expect((await manager.send(outgoing())).outcome).toBe("failed");
    peer.event("inbound", inbound("late"));
    finish(); await stopped;
    expect(sent).toMatchObject({ outcome: "sent" }); expect(peer.killed).toBe(true); expect(peer.listeners.size).toBe(0);
    expect(peer.messages.filter((m) => m.method === "send")).toHaveLength(1);
  });
  it("expires old async send leases across restart and ignores old process events", async () => {
    const peers: FakeTransport[] = [];
    const { manager } = setup({ createTransport: () => { const peer = new FakeTransport(); peers.push(peer); return peer; }, drainTimeoutMs: 10 });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let result: unknown;
    manager.onMessage = async () => { await gate; result = await manager.send(outgoing()); return null; };
    await manager.start(); peers[0].event("inbound", inbound()); await tick();
    await manager.restart(); expect(manager.getState().runtimeEpoch).toBe(2);
    release(); await tick(); expect(result).toMatchObject({ outcome: "failed" });
    expect(peers[1].messages.filter((m) => m.method === "send")).toHaveLength(0);
    peers[0].event("status", { phase: "running", selfId: "999", connectionEpoch: 9 });
    expect(manager.getState().phase).toBe("running");
  });
  it("reports post-dispatch timeout/crash as unknown without retrying", async () => {
    const { peer, manager } = setup({ requestTimeoutMs: 10, sendTimeoutMs: 10 }); await manager.start();
    const original = peer.behavior; peer.behavior = (request) => { if (request.method !== "send") original(request); };
    expect((await manager.send(outgoing())).outcome).toBe("unknown");
    const pending = manager.send(outgoing()); peer.crash(); expect((await pending).outcome).toBe("unknown");
    expect(manager.getState().phase).toBe("crashed"); expect(peer.messages.filter((m) => m.method === "send")).toHaveLength(2);
  });
  it("rejects account switches and disconnected epoch reuse", async () => {
    const first = setup(); await first.manager.start(); first.peer.event("status", { phase: "running", selfId: "999", connectionEpoch: 2 });
    expect(first.manager.getState().phase).toBe("account-mismatch"); await tick(); expect(first.peer.killed).toBe(true);
    const second = setup(); await second.manager.start(); second.peer.event("status", { phase: "waiting-backend" }); second.peer.event("status", { phase: "running", selfId: "10000", connectionEpoch: 1 });
    expect(second.manager.getState().phase).toBe("crashed");
  });
  it("bounds inbound work and rejects capability downgrade or local-path parts", async () => {
    const { peer, manager } = setup({ drainTimeoutMs: 10 }); manager.onMessage = () => new Promise(() => {}); await manager.start();
    for (let i = 0; i < 17; i++) peer.event("inbound", inbound(`event-${i}`));
    expect(peer.messages.filter((m) => m.method === "ackInbound").at(-1)?.payload).toMatchObject({ outcome: "busy" });
    expect((await manager.send({ ...outgoing(), parts: [{ kind: "file", filePath: "/secret" }] })).outcome).toBe("failed");
    peer.event("capability-changed", { ...capabilities, messages: { ...capabilities.messages, text: false } });
    expect((await manager.send(outgoing())).outcome).toBe("failed");
    expect(peer.messages.filter((m) => m.method === "send")).toHaveLength(0);
  });
  it("keeps latest start-time status over a stale start reply, without early inbound", async () => {
    const { peer, manager } = setup(); const handler = vi.fn(async () => null); manager.onMessage = handler;
    const original = peer.behavior;
    peer.behavior = (request) => {
      if (request.method !== "start") { original(request); return; }
      peer.event("status", { phase: "running", selfId: "10000", connectionEpoch: 1 });
      peer.event("inbound", inbound("too-early"));
      peer.reply(request, { phase: "waiting-backend" });
    };
    await manager.start(); expect(manager.getState().phase).toBe("running"); expect(handler).not.toHaveBeenCalled();
    peer.event("inbound", inbound("after-start")); await tick(); expect(handler).toHaveBeenCalledOnce();
  });
  it("enforces dynamic text length limits before crossing IPC", async () => {
    const { peer, manager } = setup(); await manager.start();
    peer.event("capability-changed", { ...capabilities, messages: { ...capabilities.messages, maxTextLength: 1 } });
    expect((await manager.send(outgoing())).outcome).toBe("failed");
    expect(peer.messages.filter((m) => m.method === "send")).toHaveLength(0);
    expect((await manager.send({ ...outgoing(), parts: [{ kind: "text", text: "x" }] })).outcome).toBe("sent");
  });
  it("uses a delivery budget separate from fast control RPC and sends the pinned connection epoch", async () => {
    const { peer, manager } = setup({ requestTimeoutMs: 5, sendTimeoutMs: 100 }); await manager.start();
    const original = peer.behavior;
    peer.behavior = (request) => { if (request.method === "send") setTimeout(() => original(request), 20); else original(request); };
    expect((await manager.send(outgoing())).outcome).toBe("sent");
    expect(peer.messages.find((m) => m.method === "send")?.payload).toMatchObject({ connectionEpoch: 1 });
  });
  it("never starts a replacement until old process exit is confirmed", async () => {
    const peer = new FakeTransport();
    peer.terminate = async () => { throw new Error("still running"); };
    const createTransport = vi.fn(() => peer);
    const { manager } = setup({ createTransport }); await manager.start();
    await manager.restart(); expect(manager.getState().phase).toBe("failed"); expect(createTransport).toHaveBeenCalledOnce();
    // A late real exit releases the old lease; only then may a new process start.
    peer.crash(); const next = new FakeTransport(); createTransport.mockReturnValue(next);
    await manager.start(); expect(createTransport).toHaveBeenCalledTimes(2); expect(manager.getState().phase).toBe("running");
  });
  it("preserves partial-success adapter compatibility without changing precise results", async () => {
    const { peer, manager } = setup(); const adapter = new QqModuleAdapter(manager); await manager.start();
    const original = peer.behavior; peer.behavior = (request) => {
      if (request.method !== "send") { original(request); return; }
      peer.reply(request, { operationId: request.payload.operationId, outcome: "partial", parts: [{ partIndex: 0, outcome: "sent" }, { partIndex: 1, outcome: "failed", errorCode: "rejected" }] });
    };
    const message = { ...outgoing(), parts: [...outgoing().parts, ...outgoing().parts] };
    expect((await manager.send(message)).outcome).toBe("partial"); expect(await adapter.send(message)).toEqual({ ok: true });
  });
});
