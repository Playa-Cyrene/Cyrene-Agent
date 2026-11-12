import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { OutgoingMessage } from "../../types";

const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.directory } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ qq: {
  enabled: true, listenMode: "loopback", port: 0,
  allowedPrivateUserIds: ["1000"], allowedGroupIds: [], groupRequireMention: true,
  groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
} }) }));
import { NapCatAdapter } from "./napcat-adapter";
import { OneBotReverseWsServer } from "./onebot-reverse-ws";

const adapters: NapCatAdapter[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];
const reply: OutgoingMessage = { channel: "qq", chatType: "private", targetId: "1000", parts: [{ kind: "text", text: "reply" }] };
const event = (id: string) => ({ self_id: "9000", post_type: "message", message_type: "private", message_id: id,
  user_id: "1000", time: 1700000000, message: [{ type: "text", data: { text: "hello" } }] });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fake WS condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function setup() {
  fixture.directory = mkdtempSync(join(tmpdir(), "napcat-migration-"));
  directories.push(fixture.directory);
  const adapter = new NapCatAdapter();
  adapters.push(adapter);
  await adapter.start();
  return adapter;
}
async function connect(adapter: NapCatAdapter, holdAction?: string) {
  const socket = new WebSocket(String(adapter.getConnectionInfo().listenUrl), { headers: { "X-Self-ID": "9000" } });
  sockets.push(socket);
  const actions: string[] = [];
  const held: Array<() => void> = [];
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    actions.push(request.action);
    const respond = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo,
        data: request.action === "get_login_info" ? { user_id: "9000" }
          : request.action === "get_version_info" ? { app_version: "4.8.115" } : { message_id: "sent" } }));
    };
    if (request.action === holdAction) held.push(respond); else respond();
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  if (holdAction !== "get_login_info") await until(() => adapter.getMigrationIdentity() !== null);
  return { socket, actions, held };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const adapter of adapters.splice(0)) await adapter.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("NapCat migration stop (isolated legacy settings and fake WS)", () => {
  it("waits for the complete handler and its send acknowledgement, rejects new inbound/outbound, confirms listener close", async () => {
    const adapter = await setup();
    const peer = await connect(adapter, "send_private_msg");
    const identity = adapter.getMigrationIdentity()!;
    expect(Object.isFrozen(identity)).toBe(true);
    const handlerGate = gate();
    let entered = 0;
    adapter.onMessage = async () => { entered++; await handlerGate.promise; await adapter.send(reply); return null; };
    peer.socket.send(JSON.stringify(event("first")));
    await until(() => entered === 1);
    const stopping = adapter.prepareMigrationStop({ ...identity, timeoutMs: 1000 });
    let settled = false;
    void stopping.then(() => { settled = true; });
    expect(adapter.prepareMigrationStop(identity)).toBe(stopping);
    expect(adapter.getMigrationIdentity()).toBeNull();
    expect((await adapter.send(reply)).ok).toBe(false);
    peer.socket.send(JSON.stringify(event("second")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(1);
    expect(settled).toBe(false);
    handlerGate.resolve();
    await until(() => peer.held.length === 1);
    expect(settled).toBe(false);
    peer.held[0]();
    expect(await stopping).toEqual({ safeToSwitch: true, drained: true, stopped: true });
    await expect(adapter.start()).rejects.toThrow("停收");
    expect(await adapter.prepareMigrationStop({ ...identity, accountId: "different-account" }))
      .toMatchObject({ safeToSwitch: false, reason: "identity-changed" });
  });

  it("tracks standalone send promises even without a handler", async () => {
    const adapter = await setup();
    const peer = await connect(adapter, "send_private_msg");
    const send = adapter.send(reply);
    await until(() => peer.held.length === 1);
    const stopping = adapter.prepareMigrationStop({ ...adapter.getMigrationIdentity()!, timeoutMs: 1000 });
    peer.held[0]();
    expect((await send).ok).toBe(true);
    expect((await stopping).safeToSwitch).toBe(true);
  });

  it("times out an unfinished handler and never upgrades its terminal result", async () => {
    const adapter = await setup();
    const peer = await connect(adapter);
    const held = gate();
    let entered = false;
    let lateSend: boolean | undefined;
    adapter.onMessage = async () => { entered = true; await held.promise; lateSend = (await adapter.send(reply)).ok; return null; };
    peer.socket.send(JSON.stringify(event("held")));
    await until(() => entered);
    const identity = adapter.getMigrationIdentity()!;
    const result = await adapter.prepareMigrationStop({ ...identity, timeoutMs: 20 });
    expect(result).toMatchObject({ safeToSwitch: false, drained: false, reason: "timeout" });
    held.resolve();
    await until(() => lateSend !== undefined);
    expect(lateSend).toBe(false);
    expect(await adapter.prepareMigrationStop(identity)).toEqual(result);
    expect(peer.actions.filter((action) => action.startsWith("send_"))).toEqual([]);
  });

  it("rejects stale identity and prevents old handler replies from crossing an ordinary restart", async () => {
    const adapter = await setup();
    const first = await connect(adapter);
    const identity = adapter.getMigrationIdentity()!;
    const held = gate();
    let entered = false;
    let sent: boolean | undefined;
    adapter.onMessage = async () => { entered = true; await held.promise; sent = (await adapter.send(reply)).ok; return null; };
    first.socket.send(JSON.stringify(event("old")));
    await until(() => entered);
    await adapter.stop();
    await adapter.start();
    const second = await connect(adapter);
    expect(adapter.getMigrationIdentity()!.connectionEpoch).toBeGreaterThan(identity.connectionEpoch);
    expect(await adapter.prepareMigrationStop(identity)).toMatchObject({ safeToSwitch: false, reason: "identity-changed" });
    held.resolve();
    await until(() => sent !== undefined);
    expect(sent).toBe(false);
    expect(second.actions.filter((action) => action.startsWith("send_"))).toEqual([]);
    expect((await adapter.send(reply)).ok).toBe(true);
  });

  it("invalidates authentication while replacement handshake is pending and rejects stale events", async () => {
    const adapter = await setup();
    const first = await connect(adapter);
    const identity = adapter.getMigrationIdentity()!;
    const second = await connect(adapter, "get_login_info");
    await until(() => second.held.length === 1);
    expect(adapter.getMigrationIdentity()).toBeNull();
    expect((await adapter.send(reply)).ok).toBe(false);
    expect(await adapter.prepareMigrationStop(identity)).toMatchObject({ safeToSwitch: false });
    second.held[0]();
    await until(() => adapter.getMigrationIdentity() !== null);
    expect(adapter.getMigrationIdentity()!.connectionEpoch).toBeGreaterThan(identity.connectionEpoch);
    expect(first.actions.filter((action) => action.startsWith("send_"))).toEqual([]);
  });

  it("does not mistake a resolved legacy stop promise for an actual listener close", async () => {
    const adapter = await setup();
    await connect(adapter);
    const server = (adapter as unknown as { server: OneBotReverseWsServer }).server;
    const realStop = server.stop.bind(server);
    vi.spyOn(server, "stop").mockResolvedValue();
    const result = await adapter.prepareMigrationStop({ ...adapter.getMigrationIdentity()!, timeoutMs: 20 });
    expect(result).toMatchObject({ safeToSwitch: false, drained: true, stopped: false, reason: "timeout" });
    await realStop();
  });
  it("fails closed when a connection disappears during drain", async () => {
    const adapter = await setup();
    const peer = await connect(adapter);
    const held = gate();
    let entered = false;
    adapter.onMessage = async () => { entered = true; await held.promise; return null; };
    peer.socket.send(JSON.stringify(event("disconnect")));
    await until(() => entered);
    const stopping = adapter.prepareMigrationStop({ ...adapter.getMigrationIdentity()!, timeoutMs: 1000 });
    peer.socket.terminate();
    await until(() => adapter.getConnectionInfo().selfId === undefined);
    held.resolve();
    expect(await stopping).toEqual({ safeToSwitch: false, drained: true, stopped: true, reason: "connection-changed" });
  });

  it("surfaces stop failures instead of reporting a safe switch", async () => {
    const adapter = await setup();
    await connect(adapter);
    const server = (adapter as unknown as { server: OneBotReverseWsServer }).server;
    vi.spyOn(server, "stop").mockRejectedValueOnce(new Error("fake close failure"));
    expect(await adapter.prepareMigrationStop(adapter.getMigrationIdentity()!)).toEqual({
      safeToSwitch: false, drained: true, stopped: false, reason: "fake close failure",
    });
  });

  it("does not publish a stale handshake after a newer connection authenticated", async () => {
    const adapter = await setup();
    const old = await connect(adapter, "get_login_info");
    await until(() => old.held.length === 1);
    const fresh = await connect(adapter);
    const identity = adapter.getMigrationIdentity();
    old.held[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.getMigrationIdentity()).toEqual(identity);
    expect((await adapter.send(reply)).ok).toBe(true);
    expect(fresh.actions).toContain("send_private_msg");
  });

});
