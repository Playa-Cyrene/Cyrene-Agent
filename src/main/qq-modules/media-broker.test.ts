import { renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QQ_MEDIA_LIMITS } from "../../shared/qq-module";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";
import { QqMediaBroker } from "./media-broker";
import { QqModuleRuntime } from "./runtime";
const roots: string[] = [];
const runtimes: QqModuleRuntime[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-broker-test-")); roots.push(root);
  const peer = new FakeTransport(); const runtime = new QqModuleRuntime(peer, 1, 40); runtimes.push(runtime);
  const broker = new QqMediaBroker(join(root, "cache"));
  const context = { runtime, connectionEpoch: 1, assertAuthorized: () => {} };
  const original = peer.behavior;
  peer.behavior = (request) => request.method === "mediaBeginUpload" ? peer.reply(request, { mediaId: "upload-1" }) : original(request);
  return { root, peer, broker, context };
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((r) => r.close())); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
describe("QQ host-owned media broker", () => {
  it("uploads a hashed immutable snapshot using bounded chunks, never host paths", async () => {
    const { root, peer, broker, context } = await setup(); const source = join(root, "private.bin"); const bytes = Buffer.alloc(QQ_MEDIA_LIMITS.chunkBytes + 7, 91); await writeFile(source, bytes);
    const original = peer.behavior; peer.behavior = (request) => { if (request.method === "mediaBeginUpload") void writeFile(source, "changed"); original(request); };
    const media = await broker.upload(context, "operation", { type: "private", peerId: "30000" }, { kind: "file", filePath: source });
    expect(media.mediaId).toBe("upload-1");
    expect(peer.messages.find((r) => r.method === "mediaBeginUpload")?.payload).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex") });
    const writes = peer.messages.filter((r) => r.method === "mediaWrite");
    expect(writes).toHaveLength(2); expect(Buffer.concat(writes.map((r) => Buffer.from(r.payload.data, "base64")))).toEqual(bytes);
    expect(JSON.stringify(peer.messages)).not.toContain(root);
  });
  it("rejects URL-only, empty, oversized and nonregular outgoing sources", async () => {
    const { root, peer, broker, context } = await setup(); const source = join(root, "source"); await writeFile(source, "x");
    for (const filePath of [root]) await expect(broker.upload(context, "op", { type: "private", peerId: "1" }, { kind: "file", filePath })).rejects.toThrow();
    await expect(broker.upload(context, "op", { type: "private", peerId: "1" }, { kind: "image", url: "https://example.org/x" })).rejects.toThrow();
    for (const size of [0, QQ_MEDIA_LIMITS.maxFileBytes + 1]) { await truncate(source, size); await expect(broker.upload(context, "op", { type: "private", peerId: "1" }, { kind: "file", filePath: source })).rejects.toThrow(); }
    expect(peer.messages).toHaveLength(0);
  });
  it("rejects outgoing symlinks independently of O_NOFOLLOW support", async (test) => {
    const { root, peer, broker, context } = await setup(); const source = join(root, "source"); const link = join(root, "link"); await writeFile(source, "x");
    try { await symlink(source, link); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { test.skip("Windows account cannot create symlinks"); return; }
      throw error;
    }
    await expect(broker.upload(context, "op", { type: "private", peerId: "1" }, { kind: "file", filePath: link })).rejects.toThrow("QQ_MEDIA_NOT_FILE");
    expect(peer.messages).toHaveLength(0);
  });
  it("rejects source replacement between lstat and open before reading/uploading", async () => {
    const { root, peer, broker, context } = await setup(); const source = join(root, "source"); await writeFile(source, "original"); let checks = 0;
    context.assertAuthorized = () => { if (++checks === 3) { renameSync(source, join(root, "original")); writeFileSync(source, "replacement"); } };
    await expect(broker.upload(context, "op", { type: "private", peerId: "1" }, { kind: "file", filePath: source })).rejects.toThrow("QQ_MEDIA_CHANGED");
    expect(peer.messages).toHaveLength(0);
  });
  it("rejects a symlink cache ancestor", async (test) => {
    const { root } = await setup(); const alias = `${root}-alias`; roots.push(alias);
    try { await symlink(root, alias, "dir"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { test.skip("Windows account cannot create directory symlinks"); return; }
      throw error;
    }
    await expect(new QqMediaBroker(join(alias, "cache")).cleanup()).rejects.toThrow("QQ_MEDIA_UNSAFE_CACHE");
  });
  it.skipIf(process.platform !== "win32")("accepts Windows drive/component case normalization", async () => {
    const { root } = await setup();
    await expect(new QqMediaBroker(join(root.toUpperCase(), "CACHE")).cleanup()).resolves.toBeUndefined();
  });
  it("downloads only to random host cache files and supports expiry cleanup", async () => {
    const { root, peer, broker, context } = await setup(); const original = peer.behavior;
    peer.behavior = (request) => request.method === "mediaRead" ? peer.reply(request, { data: Buffer.from("hello").toString("base64"), eof: true }) : original(request);
    const attachment = await broker.download(context, "event", { kind: "file", mediaId: "id", size: 5, filename: "irrelevant.txt", mime: "text/plain" });
    expect(await readFile(attachment.filePath!, "utf8")).toBe("hello"); expect(attachment).not.toHaveProperty("mediaId"); expect(attachment.filePath).toMatch(/qq-media-[a-f0-9-]+\.txt$/);
    expect(peer.messages.some((r) => r.method === "mediaRelease")).toBe(true);
    await utimes(attachment.filePath!, 0, 0); await new QqMediaBroker(join(root, "cache")).cleanup(); expect(await readdir(join(root, "cache"))).toEqual([]);
  });
  it("rejects truncated/noncanonical chunks and cleans incomplete downloads", async () => {
    for (const data of ["aGVsbG8=\n", "aGVsbG9=", "", "aGVsbG8="]) {
      const { root, peer, broker, context } = await setup(); const original = peer.behavior;
      peer.behavior = (request) => request.method === "mediaRead" ? peer.reply(request, { data, eof: false }) : original(request);
      await expect(broker.download(context, "event", { kind: "file", mediaId: "id", size: 5 })).rejects.toThrow();
      expect(await readdir(join(root, "cache"))).toEqual([]);
    }
  });
  it("revokes in-progress upload before writing another chunk and releases its handle", async () => {
    const { root, peer, broker, context } = await setup(); const source = join(root, "source"); await writeFile(source, "hello"); let revoked = false; context.assertAuthorized = () => { if (revoked) throw new Error("revoked"); };
    const original = peer.behavior; peer.behavior = (request) => { original(request); if (request.method === "mediaBeginUpload") revoked = true; };
    await expect(broker.upload(context, "op", { type: "private", peerId: "1" }, { kind: "file", filePath: source })).rejects.toThrow("revoked");
    expect(peer.messages.filter((r) => r.method === "mediaWrite")).toHaveLength(0); expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("accounts for persistent cache quota before accepting new transfers", async () => {
    const { root, peer, broker, context } = await setup(); await broker.cleanup();
    const file = join(root, "cache", "qq-media-00000000-0000-0000-0000-000000000000"); await writeFile(file, ""); await truncate(file, QQ_MEDIA_LIMITS.cacheBytes);
    await expect(new QqMediaBroker(join(root, "cache")).download(context, "event", { kind: "file", mediaId: "id", size: 1 })).rejects.toThrow("QQ_MEDIA_LIMIT"); expect(peer.messages.map((r) => r.method)).toEqual(["mediaRelease"]);
  });
});
