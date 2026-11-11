import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { QqModuleManager } from "./manager";
import { QqMediaBroker } from "./media-broker";
import type { QqProcessTransport } from "./runtime";
import type { IncomingMessage } from "../channels/types";
import { configuration } from "../../../scripts/verify/qq-module/fixtures";
const candidateEntry = process.env.QFCA_ENTRY;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
interface Action { action: string; params: Record<string, any>; echo: string }
async function startPair(options: { stream?: boolean; corruptDownload?: boolean; broker?: boolean; quarantine?: boolean } = {}) {
  if (!candidateEntry || !isAbsolute(candidateEntry)) throw new Error("QFCA_ENTRY must identify a reviewed local build");
  const directory = await mkdtemp(join(tmpdir(), "qq-media-integration-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const config = configuration(); config.config.listen.port = port;
  const envelopes: unknown[] = [];
  let child: ReturnType<typeof fork> | undefined;
  let exited: Promise<void> | undefined;
  const manager = new QqModuleManager({ getConfiguration: () => config, requestTimeoutMs: 2500, drainTimeoutMs: 200,
    ...(options.broker === false ? {} : { mediaBroker: new QqMediaBroker(join(directory, "cache")) }),
    createTransport: (): QqProcessTransport => {
      child = fork(candidateEntry, [], { execArgv: [], env: { TMPDIR: directory, TMP: directory, TEMP: directory }, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
      const peer = child; exited = new Promise<void>((resolve) => peer.once("exit", () => resolve()));
      return { postMessage: (message) => { envelopes.push(message); peer.send(message as object); },
        onMessage: (listener) => { const receive = (value: unknown) => { envelopes.push(value); listener(value); }; peer.on("message", receive); return () => { peer.removeListener("message", receive); }; },
        onExit: (listener) => { peer.on("exit", listener); return () => { peer.removeListener("exit", listener); }; },
        onError: (listener) => { peer.on("error", listener); return () => { peer.removeListener("error", listener); }; },
        terminate: async () => { peer.kill(); await exited; } };
    } });
  cleanups.push(async () => { await manager.stop(); child?.kill(); await exited; });
  const received: IncomingMessage[] = []; manager.onMessage = async (message) => { received.push(message); return null; };
  if (options.quarantine) await manager.stageForMigration(); else await manager.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: `Bearer ${config.credentials.accessToken}`, "X-Self-ID": "10000" } });
  cleanups.push(async () => { socket.terminate(); });
  const actions: Action[] = [];
  const uploads = new Map<string, { chunks: Buffer[]; size: number; sha256: string; filename: string }>();
  const media = new Map<string, Buffer>([["picture.png", Buffer.alloc(70001, 42)], ["sound", Buffer.from("audio fixture")], ["document", Buffer.from("file fixture")], ["movie", Buffer.from("video fixture")]]);
  socket.on("message", (raw) => {
    const a: Action = JSON.parse(raw.toString()); actions.push(a);
    const respond = (data: unknown) => socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: a.echo, data }));
    if (a.action === "get_login_info") return respond({ user_id: "10000" });
    if (a.action === "get_version_info") return respond({ app_name: "NapCat.Onebot", app_version: "0.0.0-not-used" });
    if (["can_send_image", "can_send_record"].includes(a.action)) return respond({ yes: true });
    if (a.action === "test_download_stream") {
      if (options.stream === false) return socket.send(JSON.stringify({ status: "failed", retcode: 1404, echo: a.echo, data: null }));
      for (let i = 1; i <= 10; i++) respond({ type: "stream", data_type: "data_chunk", data: `Index-> ${i}` });
      return respond({ type: "response", data_type: "data_complete", data: "Stream transmission complete" });
    }
    if (a.action === "upload_file_stream") {
      const p = a.params;
      if (p.reset) return respond({ type: "response" });
      if (!p.is_complete) {
        const state = uploads.get(p.stream_id) ?? { chunks: [], size: p.file_size, sha256: p.expected_sha256, filename: p.filename };
        state.chunks.push(Buffer.from(p.chunk_data, "base64")); uploads.set(p.stream_id, state);
        return respond({ type: "stream", status: "chunk_received", stream_id: p.stream_id, received_chunks: state.chunks.length, total_chunks: p.total_chunks });
      }
      const state = uploads.get(p.stream_id)!;
      const bytes = Buffer.concat(state.chunks);
      return respond({ type: "response", status: "file_complete", stream_id: p.stream_id, file_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), file_path: `/backend-private/${p.stream_id}/${state.filename}` });
    }
    if (/^download_file(?:_image|_record)?_stream$/.test(a.action)) {
      const bytes = media.get(a.params.file_id ?? a.params.file);
      if (!bytes) return socket.send(JSON.stringify({ status: "failed", retcode: 1200, echo: a.echo, data: null }));
      respond({ type: "stream", data_type: "file_info", file_name: "fixture.bin", file_size: bytes.length, chunk_size: 65536 });
      let chunks = 0;
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const block = bytes.subarray(offset, offset + 65536);
        respond({ type: "stream", data_type: "file_chunk", index: options.corruptDownload ? 999 : chunks, data: block.toString("base64"), size: block.length }); chunks++;
      }
      return respond({ type: "response", data_type: "file_complete", total_chunks: chunks, total_bytes: bytes.length });
    }
    if (a.action === "get_group_member_info") return respond({ nickname: "Member" });
    return respond({ message_id: actions.length });
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  await vi.waitFor(() => expect(manager.getState().phase).toBe("running"), { timeout: 5000 });
  const incoming = (id: number, message: unknown[]) => socket.send(JSON.stringify({ self_id: 10000, post_type: "message", message_type: "private", message_id: id, user_id: 30000, time: 1700000000, sender: { nickname: "Isolated fixture" }, message }));
  return { manager, socket, directory, envelopes, actions, uploads, media, received, incoming, config };
}
it.skipIf(!candidateEntry)("transfers image/audio/file/video through real child IPC while retaining text, route and bounded handles", async () => {
  const p = await startPair();
  await vi.waitFor(() => expect(p.manager.getCapabilities().messages.image).toBe(true));
  p.incoming(321, [{ type: "text", data: { text: "media with text" } }, ...["image", "record", "file", "video"].map((type, index) => ({ type, data: { file: ["picture.png", "sound", "document", "movie"][index] } }))]);
  await vi.waitFor(() => expect(p.received).toHaveLength(1), { timeout: 5000 });
  expect(p.received[0]).toMatchObject({ channel: "qq", chatId: "30000", chatType: "private", senderId: "30000", messageId: "321", text: "media with text" });
  expect(p.received[0].attachments?.map((a) => a.kind)).toEqual(["image", "audio", "file", "video"]);
  for (const [index, bytes] of [...p.media.values()].entries()) expect(await readFile(p.received[0].attachments![index].filePath!)).toEqual(bytes);
  const source = join(p.directory, "host-selected.txt"); const bytes = Buffer.alloc(70001, 52); await writeFile(source, bytes);
  const result = await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "reply" }, { kind: "image", filePath: source }, { kind: "audio", filePath: source, mime: "audio/mpeg" }, { kind: "file", filePath: source, name: "report.txt" }, { kind: "video", filePath: source, name: "clip.mp4" }] });
  expect(result.outcome).toBe("sent"); expect(result.parts).toHaveLength(5);
  expect([...p.uploads.values()].filter((u) => u.size === bytes.length)).toHaveLength(4);
  for (const upload of [...p.uploads.values()].filter((u) => u.size === bytes.length)) expect(Buffer.concat(upload.chunks)).toEqual(bytes);
  const wire = JSON.stringify(p.envelopes);
  expect(wire).not.toContain(source); expect(wire).not.toContain("/backend-private/"); expect(wire).not.toContain("filePath");
  for (const envelope of p.envelopes) expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(256 * 1024);
  await p.manager.stop();
  // Host-owned attachment files survive module stop for the existing history path.
  expect(await readFile(p.received[0].attachments![0].filePath!)).toEqual(p.media.get("picture.png"));
}, 15000);
it.skipIf(!candidateEntry)("keeps text working when real media probe is unsupported", async () => {
  const p = await startPair({ stream: false });
  expect(p.manager.getCapabilities().messages.image).toBe(false);
  p.incoming(322, [{ type: "text", data: { text: "fallback" } }, { type: "image", data: { file: "picture.png" } }]);
  await vi.waitFor(() => expect(p.received).toHaveLength(1));
  expect(p.received[0].text).toContain("fallback"); expect(p.received[0].attachments).toBeUndefined();
  expect((await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "still text" }] })).outcome).toBe("sent");
  expect(p.actions.some((a) => /^download_file/.test(a.action))).toBe(false);
}, 10000);
it.skipIf(!candidateEntry)("keeps text and discards malformed streams and backend paths without opening host files", async () => {
  const p = await startPair({ corruptDownload: true });
  p.incoming(323, [{ type: "text", data: { text: "must survive" } }, { type: "image", data: { file: "picture.png" } }, { type: "file", data: { file: "/etc/passwd", url: "http://127.0.0.1/private" } }]);
  await vi.waitFor(() => expect(p.received).toHaveLength(1), { timeout: 5000 });
  expect(p.received[0].text).toContain("must survive"); expect(p.received[0].attachments).toBeUndefined();
  expect(p.actions.some((a) => JSON.stringify(a.params).includes("/etc/passwd"))).toBe(false);
  expect(p.actions.some((a) => JSON.stringify(a.params).includes("http://127.0.0.1/private"))).toBe(false);
  expect(await readdir(join(p.directory, "cache")).catch(() => [])).toHaveLength(0);
}, 10000);

it.skipIf(!candidateEntry)("omits media opt-in without a broker and preserves legacy host text behavior", async () => {
  const p = await startPair({ broker: false });
  p.incoming(324, [{ type: "text", data: { text: "legacy host text" } }, { type: "image", data: { file: "picture.png" } }]);
  await vi.waitFor(() => expect(p.received).toHaveLength(1));
  expect(p.received[0].text).toContain("legacy host text"); expect(p.received[0].attachments).toBeUndefined();
  expect(p.actions.some((a) => a.action === "test_download_stream")).toBe(false);
  const initialize = p.envelopes.find((v: any) => v.method === "initialize") as any;
  expect(initialize.payload).not.toHaveProperty("mediaTransfer");
  expect((await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "legacy reply" }] })).outcome).toBe("sent");
}, 10000);
it.skipIf(!candidateEntry)("releases rejected migration media before ACK so activation retains full handle capacity", async () => {
  const p = await startPair({ quarantine: true });
  await vi.waitFor(() => expect(p.manager.getCapabilities().messages.file).toBe(true));
  p.media.set("document", Buffer.from("x"));
  // Respect the backend's 64-event queue; exercise cumulative handle retention,
  // not queue overflow. Each ACK must make capacity available for the next event.
  for (let index = 0; index < 257; index++) {
    p.incoming(1000 + index, [{ type: "file", data: { file: "document" } }]);
    await vi.waitFor(() => expect(p.envelopes.filter((value: any) => value.method === "ackInbound")).toHaveLength(index + 1), { timeout: 1000, interval: 2 });
  }
  expect(p.received).toEqual([]);
  const events = p.envelopes.filter((value: any) => value.event === "inbound") as any[];
  expect(events).toHaveLength(257); expect(events.every((value) => value.payload.attachments?.length === 1)).toBe(true);
  expect(p.envelopes.filter((value: any) => value.method === "mediaRelease")).toHaveLength(257);
  expect(p.envelopes.filter((value: any) => value.method === "mediaRead")).toHaveLength(0);
  for (const event of events) {
    const releasedAt = p.envelopes.findIndex((value: any) => value.method === "mediaRelease" && value.payload.mediaId === event.payload.attachments[0].mediaId);
    const acknowledgedAt = p.envelopes.findIndex((value: any) => value.method === "ackInbound" && value.payload.eventId === event.payload.eventId);
    expect(releasedAt).toBeGreaterThanOrEqual(0); expect(releasedAt).toBeLessThan(acknowledgedAt);
  }
  expect(p.manager.activateMigration()).toBe(true);
  p.incoming(2000, [{ type: "text", data: { text: "activated" } }, { type: "file", data: { file: "document" } }]);
  await vi.waitFor(() => expect(p.received).toHaveLength(1));
  expect(p.received[0].text).toBe("activated"); await expect(readFile(p.received[0].attachments![0].filePath!)).resolves.toEqual(Buffer.from("x"));
}, 15000);
it.skipIf(!candidateEntry || process.env.QFCA_LARGE_MEDIA_TEST !== "1")("sends an actual 100 MiB fixture through bounded IPC and backend chunks", async () => {
  const p = await startPair({ quarantine: true });
  await vi.waitFor(() => expect(p.manager.getCapabilities().messages.file).toBe(true));
  expect(p.manager.activateMigration()).toBe(true);
  const source = join(p.directory, "large.bin"); const bytes = Buffer.alloc(100 * 1024 * 1024, 47); await writeFile(source, bytes);
  const result = await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "file", filePath: source, name: "large.bin" }] });
  expect(result.outcome).toBe("sent");
  const upload = [...p.uploads.values()].find((u) => u.size === bytes.length)!;
  expect(upload.chunks).toHaveLength(1600);
  expect(createHash("sha256").update(Buffer.concat(upload.chunks)).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  const writes = p.envelopes.filter((v: any) => v.method === "mediaWrite"); expect(writes).toHaveLength(1600);
  for (const message of writes) expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(90 * 1024);
}, 60000);
