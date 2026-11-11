import { readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";
import { imageFixtures, pngFixture } from "../../../scripts/verify/qq-module/image-fixtures";
import { buildImageOptions } from "../../../scripts/verify/qq-module/image-options";
import { QQ_MEDIA_LIMITS, type QqMedia } from "../../shared/qq-module";
import { validateCaptionImagePath } from "../chat/image-caption";
import { QQ_IMAGE_HEADER_BYTES } from "./image-format";
import { QqMediaBroker } from "./media-broker";
import { QqModuleRuntime } from "./runtime";

const roots: string[] = []; const runtimes: QqModuleRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(bytes = pngFixture, chunkSize = QQ_MEDIA_LIMITS.chunkBytes) {
  const root = await mkdtemp(join(tmpdir(), "qq-image-test-")); roots.push(root);
  const cache = join(root, "cache"); const broker = new QqMediaBroker(cache);
  const peer = new FakeTransport(); const fallback = peer.behavior;
  peer.behavior = (request) => {
    if (request.method !== "mediaRead") return fallback(request);
    const { offset, limit } = request.payload;
    const block = bytes.subarray(offset, offset + Math.min(limit, chunkSize));
    peer.reply(request, { data: block.toString("base64"), eof: offset + block.length === bytes.length });
  };
  const runtime = new QqModuleRuntime(peer, 1, 100); runtimes.push(runtime);
  const context = { runtime, connectionEpoch: 1, assertAuthorized: () => {} };
  const media: QqMedia = { kind: "image", mediaId: "image-handle", size: bytes.length };
  return { root, cache, broker, peer, context, media };
}

describe("QQ inbound image content identity", () => {
  it.each([undefined, "fixture.bin", "picture.png", "photo.jpg", "photo.png.exe", "../../escape.png", "C:\\outside\\photo.gif"])("routes actual PNG bytes into production vision options despite filename %s", async (filename) => {
    const { cache, broker, peer, context, media } = await setup();
    const output = await broker.download(context, "event", { ...media, filename, mime: "image/jpeg", caption: "fixture caption" });
    expect(dirname(output.filePath!)).toBe(cache);
    expect(basename(output.filePath!)).toMatch(/^qq-media-[a-f0-9-]{36}\.png$/);
    expect(output).toMatchObject({ kind: "image", mime: "image/png", caption: "fixture caption" });
    expect(await readFile(output.filePath!)).toEqual(pngFixture);
    expect(validateCaptionImagePath(output.filePath)).toMatchObject({ ok: true, mime: "image/png", buffer: pngFixture });
    const result = await buildImageOptions(output);
    expect(result.options.messages.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${pngFixture.toString("base64")}` } });
    expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
    expect(JSON.stringify(peer.messages)).not.toContain(cache);
  });
  it.each(imageFixtures)("identifies $mime independently of absent/misleading metadata and short chunks", async ({ bytes, extension, mime }) => {
    const { broker, peer, context, media } = await setup(bytes, 1);
    const output = await broker.download(context, "event", { ...media, mime: "application/x-msdownload", filename: "payload.exe" });
    expect(extname(output.filePath!)).toBe(extension); expect(output.mime).toBe(mime);
    expect(await readFile(output.filePath!)).toEqual(bytes);
    expect(validateCaptionImagePath(output.filePath)).toMatchObject({ ok: true, mime, buffer: bytes });
    const result = await buildImageOptions(output);
    expect(result.options.messages.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
    const reads = peer.messages.filter((request) => request.method === "mediaRead");
    expect(reads[0].payload.limit).toBe(Math.min(bytes.length, QQ_IMAGE_HEADER_BYTES));
    expect(reads.map((request) => request.payload.offset)).toEqual(Array.from({ length: bytes.length }, (_, index) => index));
  });
  it.each([
    Buffer.from("MZ executable, not an image"), Buffer.from('<svg onload="alert(1)"></svg>'),
    Buffer.from("<html>not an image</html>"), Buffer.from("GIF89a"), pngFixture.subarray(0, 8), pngFixture.subarray(0, 33),
  ])("rejects unsupported/truncated content even with image metadata", async (bytes) => {
    const { cache, broker, peer, context, media } = await setup(bytes);
    await expect(broker.download(context, "event", { ...media, filename: "picture.png", mime: "image/png" })).rejects.toThrow("QQ_MEDIA_UNSUPPORTED_IMAGE");
    expect(await readdir(cache)).toEqual([]); expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("does not reinterpret high-bit bytes as ASCII image magic", async () => {
    const bytes = Buffer.from(imageFixtures[2].bytes); bytes[0] |= 0x80;
    const { broker, context, media } = await setup(bytes);
    await expect(broker.download(context, "event", media)).rejects.toThrow("QQ_MEDIA_UNSUPPORTED_IMAGE");
  });
  it("rejects inconsistent container lengths rather than trusting a claimed WebP/BMP name", async () => {
    for (const fixture of imageFixtures.slice(3)) {
      const bytes = fixture.bytes.subarray(0, fixture.bytes.length - 1);
      const { broker, context, media } = await setup(bytes);
      await expect(broker.download(context, "event", { ...media, filename: `picture${fixture.extension}`, mime: fixture.mime })).rejects.toThrow("QQ_MEDIA_UNSUPPORTED_IMAGE");
    }
  });
  it("releases reservations after repeated format failures before the cache file is opened", async () => {
    const { cache, broker, peer, context, media } = await setup(Buffer.alloc(QQ_IMAGE_HEADER_BYTES));
    // A sparse retained file leaves exactly one maximum transfer of quota free.
    await broker.cleanup(); const retained = join(cache, "qq-media-00000000-0000-0000-0000-000000000000");
    await writeFile(retained, ""); await truncate(retained, QQ_MEDIA_LIMITS.cacheBytes - QQ_MEDIA_LIMITS.maxFileBytes);
    const restarted = new QqMediaBroker(cache); const fallback = peer.behavior;
    peer.behavior = (request) => request.method === "mediaRead" ? peer.reply(request, { data: Buffer.alloc(request.payload.limit).toString("base64"), eof: false }) : fallback(request);
    for (let index = 0; index < 3; index++) await expect(restarted.download(context, "event", { ...media, size: QQ_MEDIA_LIMITS.maxFileBytes })).rejects.toThrow("QQ_MEDIA_UNSUPPORTED_IMAGE");
    expect(await readdir(cache)).toEqual([basename(retained)]);
    expect(peer.messages.filter((request) => request.method === "mediaRelease")).toHaveLength(3);
  });
  it.each(["probe", "write"])("cleans files and releases handles after authorization is revoked during %s", async (stage) => {
    const { cache, broker, peer, context, media } = await setup(); const fallback = peer.behavior; let revoked = false;
    peer.behavior = (request) => { fallback(request); if (stage === "probe" && request.method === "mediaRead") revoked = true; };
    context.assertAuthorized = () => {
      if (revoked || stage === "write" && readdirSync(cache).some((name) => statSync(join(cache, name)).size > 0)) throw new Error("revoked");
    };
    // Initialize before the synchronous guard inspects the cache.
    await broker.cleanup();
    await expect(broker.download(context, "event", media)).rejects.toThrow("revoked");
    expect(await readdir(cache)).toEqual([]); expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("removes partially written images when a later chunk times out", async () => {
    const { cache, broker, peer, context, media } = await setup(); const fallback = peer.behavior;
    peer.behavior = (request) => { if (request.method !== "mediaRead" || request.payload.offset === 0) fallback(request); };
    await expect(broker.download(context, "event", media)).rejects.toThrow();
    expect(await readdir(cache)).toEqual([]); expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("rejects truncated streams after a valid image header and removes the partial file", async () => {
    const { cache, broker, peer, context, media } = await setup(); const fallback = peer.behavior;
    peer.behavior = (request) => request.method === "mediaRead" && request.payload.offset > 0 ? peer.reply(request, { data: "", eof: true }) : fallback(request);
    await expect(broker.download(context, "event", media)).rejects.toThrow();
    expect(await readdir(cache)).toEqual([]); expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
  });
  it("keeps content-named image files discoverable by restart expiry cleanup", async () => {
    const { cache, broker, context, media } = await setup();
    const output = await broker.download(context, "event", media);
    await utimes(output.filePath!, 0, 0); await new QqMediaBroker(cache).cleanup();
    expect(await readdir(cache)).toEqual([]);
  });
});
