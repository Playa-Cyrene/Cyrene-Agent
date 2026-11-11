import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { QqChannelConfig } from "../../settings-store";
import type { IncomingMessage } from "../../types";
import type { QqInitialize } from "../../../../shared/qq-module";

const fixture = vi.hoisted(() => ({ directory: "", config: {} as QqChannelConfig }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.directory } }));
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ qq: fixture.config }) }));
import { NapCatAdapter } from "./napcat-adapter";
import { ChannelConversationBindingStore } from "../../conversation-binding-store";
import { makeSessionId } from "../../channel-context";
import { getRecentLog, type LogEntry } from "../../message-log";
import { ConversationDatabase } from "../../../storage/conversation-database";
import { QqMigrationCoordinator } from "../../../qq-modules/migration";
import { QqMigrationStore } from "../../../qq-modules/migration-store";
import { QqModuleManager } from "../../../qq-modules/manager";
import { QqMediaBroker } from "../../../qq-modules/media-broker";
import { QqModuleAdapter } from "../qq-module-adapter";
import { capabilities, FakeTransport, inbound } from "../../../../../scripts/verify/qq-module/fixtures";

let history: ConversationDatabase | undefined;
let old: NapCatAdapter | undefined;
let manager: QqModuleManager | undefined;
let socket: WebSocket | undefined;
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("migration integration timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
afterEach(async () => {
  socket?.terminate();
  await old?.stop();
  await manager?.stop();
  history?.close();
  if (fixture.directory) rmSync(fixture.directory, { recursive: true, force: true });
});

it("rehearses a confirmed legacy WS migration without changing original data or dispatching quarantined input", async () => {
  fixture.directory = mkdtempSync(join(tmpdir(), "qq-old-migration-e2e-"));
  fixture.config = { enabled: true, listenMode: "loopback", port: 0,
    allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true,
    groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal" };
  old = new NapCatAdapter();
  await old.start();
  const listener = (old as unknown as { server: { httpServer: Server } }).server.httpServer;
  const url = String(old.getConnectionInfo().listenUrl);
  fixture.config.port = Number(new URL(url).port);
  const sessionId = makeSessionId("qq", "20000");
  const conversationId = "existing-desktop-conversation";
  const bindingPath = join(fixture.directory, "channels", "context-bindings.json");
  mkdirSync(join(fixture.directory, "channels"), { recursive: true });
  const bindings = new ChannelConversationBindingStore(bindingPath);
  bindings.observe({ sessionId, channel: "qq", chatId: "20000", chatType: "group", lastAt: 1700000000000 });
  bindings.bind(sessionId, conversationId, 1700000000001);
  expect(JSON.parse(readFileSync(bindingPath, "utf8")).version).toBe(1);
  const logEntry: LogEntry = { at: "2023-11-14T22:13:20.000Z", dir: "incoming", channel: "qq",
    senderId: "30000", chatId: "20000", text: "迁移前的群聊日志", hasAttachments: false };
  // 通过实际历史仓储创建临时 SQLite，不自定义或模拟数据库 schema。
  history = new ConversationDatabase(fixture.directory);
  const savedEntry = history.append(conversationId, { id: "user:old-turn:r1", kind: "user", turnId: "old-turn",
    revision: 1, at: 1700000000000, payload: { text: "迁移前的真实 transcript 记录" } });
  history.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const originalFiles: Record<string, Buffer> = {
    "channels-settings.json": Buffer.from(JSON.stringify({ qq: fixture.config, unrelated: { marker: "keep" } }, null, 2) + "\n"),
    "channels/log.jsonl": Buffer.from(JSON.stringify(logEntry) + "\n"),
    "channels/context-bindings.json": readFileSync(bindingPath),
    "cyrene.sqlite": readFileSync(join(fixture.directory, "cyrene.sqlite")),
    "cyrene.sqlite-wal": readFileSync(join(fixture.directory, "cyrene.sqlite-wal")),
  };
  // 数据库与绑定由各自仓储写入；这里只写旧配置与真实格式的日志样例。
  for (const name of ["channels-settings.json", "channels/log.jsonl"]) {
    writeFileSync(join(fixture.directory, name), originalFiles[name]);
  }
  expect(bindings.resolve(sessionId)).toBe(conversationId);
  expect(history.entries(conversationId)).toEqual([savedEntry]);
  const order: string[] = [];
  listener.once("close", () => order.push("legacy-listener-closed"));
  socket = new WebSocket(url, { headers: { "X-Self-ID": "10000" } });
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    socket!.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo,
      data: request.action === "get_login_info" ? { user_id: "10000" }
        : request.action === "get_version_info" ? { app_version: "4.8.115" } : { message_id: "old-reply" } }));
  });
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  await until(() => old!.getMigrationIdentity() !== null);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  old.onMessage = async (message) => {
    entered = true;
    await held;
    expect(await old!.send({ channel: "qq", chatType: "private", targetId: message.senderId,
      parts: [{ kind: "text", text: "最后一条旧回复" }] })).toEqual({ ok: true });
    order.push("legacy-handler-finished");
    return null;
  };
  socket.send(JSON.stringify({ time: 1700000000, self_id: "10000", post_type: "message", message_type: "private",
    user_id: "30000", message_id: "old-pending", message: [{ type: "text", data: { text: "old" } }] }));
  await until(() => entered);
  const peer = new FakeTransport();
  const behavior = peer.behavior;
  peer.behavior = (request) => request.method === "initialize" ? peer.reply(request, {
    capabilities: { ...capabilities, messages: { ...capabilities.messages, file: true, maxFileBytes: 1000 } } })
    : request.method === "mediaRead" ? peer.reply(request, { data: "aGVsbG8=", eof: true })
      : request.method === "mediaBeginUpload" ? peer.reply(request, { mediaId: "host-upload" }) : behavior(request);
  const media = { kind: "file" as const, mediaId: "module-file", size: 5, filename: "history.txt" };
  const source = join(fixture.directory, "selected-reply.txt"); writeFileSync(source, "hello");
  const dispatched: IncomingMessage[] = [];
  const stagedSends: Array<ReturnType<QqModuleManager["send"]>> = [];
  const store = new QqMigrationStore(join(fixture.directory, "migration-sidecar"), (record) => {
    if (record.phase === "module-staged" || record.phase === "committed") {
      peer.event("inbound", { ...inbound(`quarantine-${record.phase}`), attachments: [{ ...media, mediaId: `${media.mediaId}-${record.phase}` }] });
      stagedSends.push(manager!.send({ channel: "qq", chatType: "group", targetId: "20000", parts: [{ kind: "text", text: "blocked" }, { kind: "file", filePath: source }] }));
      expect(dispatched).toEqual([]);
    }
  });
  const createTransport = vi.fn(() => {
    expect(order).toEqual(["legacy-handler-finished", "legacy-listener-closed"]);
    expect(listener.listening).toBe(false);
    order.push("new-fake-process-started");
    return peer;
  });
  const createModule = vi.fn((input: QqInitialize) => {
    expect(input.config.expectedSelfId).toBe("10000");
    manager = new QqModuleManager({ getConfiguration: () => input, createTransport, requestTimeoutMs: 100,
      mediaBroker: new QqMediaBroker(join(fixture.directory, "module-media-cache")) });
    manager.onMessage = async (message) => { dispatched.push(message); return null; };
    return manager;
  });
  const coordinator = new QqMigrationCoordinator({ store,
    readLegacySettings: () => readFileSync(join(fixture.directory, "channels-settings.json")), legacy: old,
    secureStorage: { isSecureAvailable: () => false, decryptString: () => { throw new Error("no credentials in fixture"); } },
    legacyMachine: { userDataPath: fixture.directory, appName: "Cyrene" }, verifyCandidate: vi.fn(), createModule });
  const preview = coordinator.previewMigration(`pkg-${"a".repeat(64)}`);
  expect(preview).toMatchObject({ channelId: "qq", accountId: "10000", preserved: ["settings", "history", "bindings"] });
  expect(createModule).not.toHaveBeenCalled();
  const confirmation = coordinator.confirmMigration({ previewId: preview.previewId, accountId: preview.accountId, userConfirmed: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(store.read()?.phase).toBe("prepared");
  expect(createModule).not.toHaveBeenCalled();
  expect(listener.listening).toBe(true);
  release();
  expect(await confirmation).toEqual({ outcome: "committed", legacyData: "unchanged", legacyRuntime: "not-restarted" });
  expect(createTransport).toHaveBeenCalledOnce();
  expect(store.read()).toMatchObject({ phase: "committed", plan: { channelId: "qq", identity: { selfId: "10000" } } });
  expect(stagedSends).toHaveLength(2);
  for (const result of await Promise.all(stagedSends)) expect(result.outcome).toBe("failed");
  expect(dispatched).toEqual([]);
  expect(peer.messages.filter((message) => ["send", "mediaRead", "mediaBeginUpload"].includes(message.method))).toEqual([]);
  const newAdapter = new QqModuleAdapter(manager!);
  expect(old.id).toBe("qq");
  expect(newAdapter.id).toBe("qq");
  peer.event("inbound", { ...inbound("after-commit"), attachments: [media] });
  await until(() => dispatched.length === 1);
  expect(dispatched[0]).toMatchObject({ channel: "qq", chatId: "20000", senderId: "30000", text: "hello" });
  const cachedAttachment = dispatched[0].attachments![0].filePath!;
  expect(readFileSync(cachedAttachment).toString()).toBe("hello");
  expect((await manager!.send({ channel: "qq", chatType: "group", targetId: "20000",
    parts: [{ kind: "text", text: "new reply" }, { kind: "file", filePath: source }] })).outcome).toBe("sent");
  expect(JSON.stringify(peer.messages)).not.toContain(fixture.directory);
  expect(manager!.getMigrationIdentity()).toEqual({ selfId: "10000", connectionEpoch: 1 });
  const migratedSessionId = makeSessionId(dispatched[0].channel, dispatched[0].chatId);
  expect(migratedSessionId).toBe(sessionId);
  const reloadedBindings = new ChannelConversationBindingStore(bindingPath);
  expect(reloadedBindings.resolve(migratedSessionId)).toBe(conversationId);
  expect(history.entries(reloadedBindings.resolve(migratedSessionId)!)).toEqual([savedEntry]);
  expect(getRecentLog()).toEqual([logEntry]);
  for (const [name, bytes] of Object.entries(originalFiles)) expect(readFileSync(join(fixture.directory, name))).toEqual(bytes);
  await manager!.stop();
  expect(readFileSync(cachedAttachment).toString()).toBe("hello");
});
