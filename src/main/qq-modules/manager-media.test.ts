import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutgoingMessage } from "../channels/types";
import type { QqRequest } from "../../shared/qq-module";
import { FakeTransport, capabilities, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
import { QqModuleManager } from "./manager";
import { QqMediaBroker } from "./media-broker";
const roots: string[] = []; const managers: QqModuleManager[] = [];
const tick = () => new Promise<void>((r) => setImmediate(r));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-media-")); roots.push(root);
  const peer = new FakeTransport(); const original = peer.behavior;
  peer.behavior = (request) => request.method === "initialize" ? peer.reply(request, { capabilities: { ...capabilities, messages: { ...capabilities.messages, image: true, file: true, maxFileBytes: 1000 } } })
    : request.method === "mediaBeginUpload" ? peer.reply(request, { mediaId: "upload-id" })
      : request.method === "mediaRead" ? peer.reply(request, { data: "aGVsbG8=", eof: true }) : original(request);
  const manager = new QqModuleManager({ getConfiguration: configuration, createTransport: () => peer, mediaBroker: new QqMediaBroker(join(root, "cache")), requestTimeoutMs: 100, drainTimeoutMs: 100 }); managers.push(manager);
  await manager.start(); const source = join(root, "source.txt"); await writeFile(source, "hello");
  const message = { channel: "qq" as const, chatType: "group" as const, targetId: "20000", parts: [{ kind: "file" as const, filePath: source, name: "report.txt" }] };
  return { root, peer, manager, message };
}
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.stop())); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
describe("QQ manager media authorization", () => {
  it("keeps host paths out of IPC and releases uploaded handles after delivery", async () => {
    const { root, peer, manager, message } = await setup(); expect(manager.getCapabilities().messages.file).toBe(true); expect(manager.getCapabilities().messages.card).toBe(false);
    expect((await manager.send(message)).outcome).toBe("sent"); expect(JSON.stringify(peer.messages)).not.toContain(root);
    expect(peer.messages.find((r) => r.method === "send")?.payload).toMatchObject({ parts: [{ mediaId: "upload-id", filename: "report.txt" }] });
    expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("rechecks policy after upload and never sends revoked prepared media", async () => {
    const { peer, manager, message } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => { original(request); if (request.method === "mediaWrite") manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] }); };
    expect((await manager.send(message)).outcome).toBe("failed"); expect(peer.messages.some((r) => r.method === "send")).toBe(false);
  });
  it("snapshots caller inputs across awaits and refuses backend capability downgrade", async () => {
    const { peer, manager, message } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => { original(request); if (request.method === "mediaBeginUpload") { message.targetId = "999"; message.parts[0].filePath = "/secret"; } };
    expect((await manager.send(message)).outcome).toBe("sent"); expect(peer.messages.find((r) => r.method === "send")?.payload).toMatchObject({ conversation: { groupId: "20000" } });
    message.targetId = "20000"; peer.event("capability-changed", capabilities); expect((await manager.send(message)).outcome).toBe("failed");
  });
  it("acknowledges media only after preparation and keeps IDs out of incoming/history", async () => {
    const { peer, manager } = await setup(); let read: QqRequest | undefined; const original = peer.behavior;
    peer.behavior = (request) => request.method === "mediaRead" ? read = request : original(request);
    const handler = vi.fn(async () => null); manager.onMessage = handler;
    peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "incoming-id", size: 5, filename: "test.txt" }] });
    await vi.waitFor(() => expect(read).toBeDefined());
    expect(peer.messages.some((r) => r.method === "ackInbound")).toBe(false);
    peer.reply(read!, { data: "aGVsbG8=", eof: true }); await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const incoming = handler.mock.calls[0][0]; expect(incoming).toMatchObject({ attachments: [{ kind: "file", filePath: expect.stringMatching(/\.txt$/) }] }); expect(JSON.stringify(incoming)).not.toContain("incoming-id");
    peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "incoming-id", size: 5 }] }); await tick(); expect(handler).toHaveBeenCalledOnce();
  });
  it("keeps incoming text on ordinary attachment failure", async () => {
    const { peer, manager } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => { if (request.method === "mediaRead") peer.emit({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch, kind: "response", responseTo: request.requestId, ok: false, error: { code: "unsupported" } }); else original(request); };
    const handler = vi.fn(async () => null); manager.onMessage = handler;
    peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "incoming-id", size: 5 }] });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce()); expect(handler.mock.calls[0][0]).toMatchObject({ text: "hello\n[附件加载失败]" });
  });
  it("cancels a held incoming download on stop and removes partial cache", async () => {
    const { root, peer, manager } = await setup(); let read: QqRequest | undefined; const original = peer.behavior;
    peer.behavior = (request) => request.method === "mediaRead" ? read = request : original(request);
    const handler = vi.fn(async () => null); manager.onMessage = handler;
    peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "incoming-id", size: 5 }] });
    await vi.waitFor(() => expect(read).toBeDefined()); await manager.stop();
    expect(handler).not.toHaveBeenCalled(); expect(await readdir(join(root, "cache"))).toEqual([]);
  });
  it("rejects an upload prepared across backend reconnection", async () => {
    const { peer, manager, message } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => {
      original(request);
      if (request.method === "mediaWrite") {
        peer.event("status", { phase: "waiting-backend" });
        peer.event("status", { phase: "running", selfId: "10000", connectionEpoch: 2 });
      }
    };
    expect((await manager.send(message)).outcome).toBe("failed");
    expect(manager.getState().phase).toBe("running"); expect(peer.messages.some((r) => r.method === "send")).toBe(false);
  });
  it("removes already downloaded files when a later attachment loses authorization", async () => {
    const { root, peer, manager } = await setup(); const original = peer.behavior;
    let secondRead: QqRequest | undefined;
    peer.behavior = (request) => request.method === "mediaRead" && request.payload.mediaId === "second-id" ? secondRead = request : original(request);
    const handler = vi.fn(async () => null); manager.onMessage = handler;
    peer.event("inbound", { ...inbound(), attachments: [{ kind: "file", mediaId: "first-id", size: 5 }, { kind: "file", mediaId: "second-id", size: 5 }] });
    await vi.waitFor(() => expect(secondRead).toBeDefined());
    manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] });
    await vi.waitFor(async () => expect(await readdir(join(root, "cache"))).toEqual([]));
    expect(handler).not.toHaveBeenCalled();
  });
  it("blocks files larger than the current backend limit before upload", async () => {
    const { peer, manager, message } = await setup(); await writeFile(message.parts[0].filePath, Buffer.alloc(1001));
    expect((await manager.send(message)).outcome).toBe("failed");
    expect(peer.messages.some((r) => r.method === "mediaBeginUpload" || r.method === "send")).toBe(false);
  });

  it("sends text despite a missing file and preserves original partial indices", async () => {
    const { root, peer, manager, message } = await setup();
    const mixed: OutgoingMessage = { ...message, parts: [{ kind: "file", filePath: join(root, "missing") }, { kind: "text", text: "still delivered" }] };
    const result = await manager.send(mixed);
    expect(result).toMatchObject({ outcome: "partial", parts: [{ partIndex: 0, outcome: "failed" }, { partIndex: 1, outcome: "sent", messageId: "999" }] });
    const sent = peer.messages.find((r) => r.method === "send");
    expect(sent?.payload).toMatchObject({ operationId: result.operationId, parts: [{ kind: "text", text: "still delivered" }] });
    expect(sent?.method === "send" && sent.payload.parts).toHaveLength(1);
  });
  it("keeps a good media part after a missing media part and releases its handle", async () => {
    const { root, peer, manager, message } = await setup();
    const result = await manager.send({ ...message, parts: [{ kind: "file", filePath: join(root, "missing") }, ...message.parts] });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ partIndex: 0, outcome: "failed" }, { partIndex: 1, outcome: "sent" }] });
    expect(peer.messages.find((r) => r.method === "send")?.payload).toMatchObject({ parts: [{ mediaId: "upload-id" }] });
    expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("rejects the whole message when policy is revoked after a local part failure", async () => {
    const { root, peer, manager, message } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => { original(request); if (request.method === "mediaWrite") manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] }); };
    const result = await manager.send({ ...message, parts: [{ kind: "file", filePath: join(root, "missing") }, { kind: "text", text: "do not deliver" }, ...message.parts] });
    expect(result.outcome).toBe("failed"); expect(result.parts).toHaveLength(3); expect(result.parts.every((p) => p.outcome === "failed")).toBe(true);
    expect(peer.messages.some((r) => r.method === "send")).toBe(false);
  });
  it("maps unknown only to transmitted parts and keeps local failures known", async () => {
    const { root, peer, manager, message } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => request.method === "send" ? peer.crash() : original(request);
    const result = await manager.send({ ...message, parts: [{ kind: "text", text: "uncertain" }, { kind: "file", filePath: join(root, "missing") }, ...message.parts] });
    expect(result).toMatchObject({ outcome: "unknown", parts: [{ partIndex: 0, outcome: "unknown" }, { partIndex: 1, outcome: "failed" }, { partIndex: 2, outcome: "unknown" }] });
    expect(peer.messages.filter((r) => r.method === "send")).toHaveLength(1);
  });
  it("locally rejects unsupported card/sticker but still sends text", async () => {
    const { peer, manager, message } = await setup();
    const result = await manager.send({ ...message, parts: [{ kind: "card", title: "no" }, { kind: "text", text: "yes" }, { kind: "sticker", stickerId: "x", imagePath: "never-open" }] });
    expect(result).toMatchObject({ outcome: "partial", parts: [{ partIndex: 0, outcome: "failed", errorCode: "unsupported" }, { partIndex: 1, outcome: "sent" }, { partIndex: 2, outcome: "failed", errorCode: "unsupported" }] });
    expect(peer.messages.some((r) => r.method === "mediaBeginUpload")).toBe(false);
  });

  it("releases policy-rejected handles before ACK and never starts a host download", async () => {
    const { peer, manager } = await setup(); const original = peer.behavior; let release: QqRequest | undefined;
    peer.behavior = (request) => request.method === "mediaRelease" ? release = request : original(request);
    manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] });
    peer.event("inbound", { ...inbound("rejected-media"), attachments: [{ kind: "file", mediaId: "unused", size: 5 }] });
    expect(release).toBeDefined(); expect(peer.messages.some((request) => ["ackInbound", "mediaRead"].includes(request.method))).toBe(false);
    peer.reply(release!, {});
    await vi.waitFor(() => expect(peer.messages.find((request) => request.method === "ackInbound")?.payload).toMatchObject({ outcome: "rejected-policy" }));
  });
  it("does not release an active duplicate's handles, even after policy changes its rejection reason", async () => {
    const { peer, manager } = await setup(); const original = peer.behavior; let read: QqRequest | undefined;
    peer.behavior = (request) => request.method === "mediaRead" ? read = request : original(request);
    manager.onMessage = async () => null;
    const event = { ...inbound("same-event"), attachments: [{ kind: "file" as const, mediaId: "still-reading", size: 5 }] };
    peer.event("inbound", event); await vi.waitFor(() => expect(read).toBeDefined());
    peer.event("inbound", event);
    expect(peer.messages.filter((request) => request.method === "mediaRelease")).toHaveLength(0);
    manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] });
    peer.event("inbound", event); await tick();
    // Only the original broker may release this handle when its abort settles.
    await vi.waitFor(() => expect(peer.messages.filter((request) => request.method === "mediaRelease")).toHaveLength(1));
  });
  it("releases unstarted later attachments after a preparation-time authorization revocation", async () => {
    const { peer, manager } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => {
      original(request);
      if (request.method === "mediaRead") manager.updateAccessPolicy({ ...configuration().config, configRevision: 2, allowedGroupIds: [] });
    };
    const handler = vi.fn(async () => null); manager.onMessage = handler;
    peer.event("inbound", { ...inbound("unclaimed-handles"), attachments: ["first", "second", "third"].map((mediaId) => ({ kind: "file", mediaId, size: 5 })) });
    await vi.waitFor(() => expect(peer.messages.some((request) => request.method === "ackInbound")).toBe(true));
    expect(peer.messages.filter((request) => request.method === "mediaRelease").map((request) => request.payload.mediaId).sort()).toEqual(["first", "second", "third"]);
    expect(peer.messages.filter((request) => request.method === "mediaRead")).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

});
