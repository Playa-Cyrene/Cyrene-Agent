import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.directory } }));
vi.mock("../channels/settings-store", () => ({ loadChannelsSettings: () => ({ qq: {
  enabled: true, listenMode: "loopback", port: 0, allowedPrivateUserIds: ["1000"], allowedGroupIds: [], groupRequireMention: true,
  groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
} }) }));
import { NapCatAdapter } from "../channels/adapters/qq/napcat-adapter";
import { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import { createQqCurrentHostLegacyAdoptionPort } from "./adoption-legacy-port";
let adapter: NapCatAdapter | undefined, socket: WebSocket | undefined;
afterEach(async () => { socket?.terminate(); await adapter?.stop(); if (fixture.directory) rmSync(fixture.directory, { recursive: true, force: true }); });
it("observes actual synthetic OneBot listener stop and current-host turn drain through the adoption port", async () => {
  fixture.directory = mkdtempSync(join(tmpdir(), "qq-adoption-live-"));
  adapter = new NapCatAdapter(); const router = new QqRoutingAdapter(adapter); await router.start();
  socket = new WebSocket(String(adapter.getConnectionInfo().listenUrl), { headers: { "X-Self-ID": "9000" } });
  socket.on("message", raw => {
    const request = JSON.parse(raw.toString());
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo,
      data: request.action === "get_login_info" ? { user_id: "9000" } : request.action === "get_version_info" ? { app_version: "synthetic" } : { message_id: "sent" } }));
  });
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  await expect.poll(() => router.getMigrationIdentity(), { timeout: 3000 }).not.toBeNull();
  const port = createQqCurrentHostLegacyAdoptionPort(router, router.getMigrationIdentity()!);
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  router.onMessage = async () => { entered(); await gate; return null; };
  socket.send(JSON.stringify({ self_id: "9000", post_type: "message", message_type: "private", message_id: "one", user_id: "1000", time: 1700000000, message: [{ type: "text", data: { text: "synthetic" } }] }));
  await arrived;
  let settled = false;
  const stopping = port.stopAndDrain({ platform: "win32", scopeId: "test", sessionEpoch: "test", mode: "validated-upgrade", previousHostSha256: "c".repeat(64), hostSha256: "a".repeat(64), moduleSha256: "b".repeat(64) }).then(value => { settled = true; return value; });
  try { await expect(router.start()).rejects.toThrow(); expect(settled).toBe(false); }
  finally { release(); }
  expect(await stopping).toBe(true); expect(router.getDriver()).toBe("blocked");
  await expect(router.start()).rejects.toThrow();
});
