import { fork } from "node:child_process";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { QqModuleManager } from "./manager";
import type { QqProcessTransport } from "./runtime";
import { configuration } from "../../../scripts/verify/qq-module/fixtures";

// Explicit opt-in against a locally reviewed and built candidate, never download
// or execute a release automatically. The peer below is fake QQ on loopback only.
const candidateEntry = process.env.QFCA_ENTRY;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it.skipIf(!candidateEntry)("interoperates with the real QFCA candidate through parent IPC and a fake loopback backend", async () => {
  if (!candidateEntry || !isAbsolute(candidateEntry)) throw new Error("QFCA_ENTRY must be an absolute reviewed candidate entry");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const config = configuration(); config.config.listen.port = port;
  let child: ReturnType<typeof fork> | undefined;
  let exited: Promise<void> | undefined;
  const manager = new QqModuleManager({ getConfiguration: () => config, requestTimeoutMs: 1500, drainTimeoutMs: 200,
    createTransport: (): QqProcessTransport => {
      child = fork(candidateEntry, [], { execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
      const peer = child;
      exited = new Promise<void>((resolve) => peer.once("exit", () => resolve()));
      return {
        postMessage: (message) => { peer.send(message as object); },
        onMessage: (listener) => { peer.on("message", listener); return () => { peer.removeListener("message", listener); }; },
        onExit: (listener) => { peer.on("exit", listener); return () => { peer.removeListener("exit", listener); }; },
        terminate: async () => { peer.kill(); await exited; },
      };
    },
  });
  cleanups.push(async () => { await manager.stop(); child?.kill(); await exited; });
  const received = vi.fn(async () => null); manager.onMessage = received;
  await manager.start(); expect(manager.getState().phase).toBe("waiting-backend");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: `Bearer ${config.credentials.accessToken}`, "X-Self-ID": "10000" } });
  cleanups.push(async () => { socket.terminate(); });
  const actions: { action: string; params: Record<string, unknown>; echo: string }[] = [];
  socket.on("message", (data) => {
    const action = JSON.parse(data.toString()); actions.push(action);
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo, data: action.action === "get_login_info" ? { user_id: "10000" } : { message_id: 777 } }));
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  await vi.waitFor(() => expect(manager.getState().phase).toBe("running"));
  socket.send(JSON.stringify({ self_id: 10000, post_type: "message", message_type: "group", message_id: 123, group_id: 20000, user_id: 30000, time: 1700000000, sender: { nickname: "Fake sender" }, message: [{ type: "at", data: { qq: "10000" } }, { type: "text", data: { text: "compatibility" } }] }));
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  expect(received.mock.calls[0]?.[0]).toMatchObject({ channel: "qq", chatType: "group", senderId: "30000", chatId: "20000", text: "compatibility", mentions: [{ userId: "10000", isBot: true }] });
  const result = await manager.send({ channel: "qq", chatType: "group", targetId: "20000", replyContext: { messageId: "123", mentionUserId: "30000" }, parts: [{ kind: "text", text: "reply" }] });
  expect(result.outcome).toBe("sent");
  expect(actions.filter((a) => a.action === "send_group_msg")).toHaveLength(1);
  expect(actions.find((a) => a.action === "send_group_msg")?.params.message).toMatchObject([{ type: "reply", data: { id: "123" } }, { type: "at", data: { qq: "30000" } }, { type: "text", data: { text: " " } }, { type: "text", data: { text: "reply" } }]);
  manager.updateAccessPolicy({ ...config.config, configRevision: 2, allowedGroupIds: [] });
  socket.send(JSON.stringify({ self_id: 10000, post_type: "message", message_type: "group", message_id: 124, group_id: 20000, user_id: 30000, time: 1700000001, message: [{ type: "at", data: { qq: "10000" } }, { type: "text", data: { text: "revoked" } }] }));
  await new Promise((resolve) => setTimeout(resolve, 40)); expect(received).toHaveBeenCalledOnce();
  await manager.stop(); await exited; expect(manager.getState().phase).toBe("stopped");
}, 10_000);
