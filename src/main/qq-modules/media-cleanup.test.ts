import { mkdtemp, readFile, readdir, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";
import { QQ_MEDIA_LIMITS } from "../../shared/qq-module";
import { QqMediaBroker } from "./media-broker";
import { QqModuleRuntime } from "./runtime";

const fault = vi.hoisted(() => ({ denyUnlink: false, closeError: false, holdUnlink: undefined as Promise<void> | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: vi.fn(async (...args: Parameters<typeof actual.unlink>) => {
      await fault.holdUnlink;
      if (fault.denyUnlink) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return actual.unlink(...args);
    }),
    open: async (...args: Parameters<typeof actual.open>) => {
      const fd = await actual.open(...args);
      if (fault.closeError && args[1] === "wx") {
        const close = fd.close.bind(fd);
        vi.spyOn(fd, "close").mockImplementation(async () => { await close(); throw new Error("close failed"); });
      }
      return fd;
    },
  };
});
const roots: string[] = [];
const runtimes: QqModuleRuntime[] = [];
afterEach(async () => {
  fault.denyUnlink = false; fault.closeError = false; fault.holdUnlink = undefined;
  vi.clearAllMocks(); vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(freeBytes: number) {
  const root = await mkdtemp(join(tmpdir(), "qq-cleanup-test-")); roots.push(root);
  const cache = join(root, "cache"); await new QqMediaBroker(cache).cleanup();
  // Sparse, fresh retained history leaves a small, observable admission budget.
  const retained = join(cache, "qq-media-00000000-0000-0000-0000-000000000000");
  await writeFile(retained, ""); await truncate(retained, QQ_MEDIA_LIMITS.cacheBytes - freeBytes);
  const broker = new QqMediaBroker(cache);
  const peer = new FakeTransport(); const fallback = peer.behavior;
  const sizes = new Map<string, number>();
  peer.behavior = (request) => {
    if (request.method !== "mediaRead") return fallback(request);
    if (request.payload.mediaId === "broken" && request.payload.offset > 0) {
      peer.emit({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch,
        kind: "response", responseTo: request.requestId, ok: false, error: { code: "unsupported" } });
      return;
    }
    const block = Buffer.alloc(request.payload.limit, 42);
    peer.reply(request, { data: block.toString("base64"), eof: request.payload.offset + block.length === (sizes.get(request.payload.mediaId) ?? freeBytes) });
  };
  const runtime = new QqModuleRuntime(peer, 1, 100); runtimes.push(runtime);
  const context = { runtime, connectionEpoch: 1, assertAuthorized() {} };
  const download = (size: number, mediaId = "good", signal?: AbortSignal) => {
    sizes.set(mediaId, size);
    return broker.download({ ...context, signal }, "event", { kind: "file", mediaId, size, filename: "fixture.txt" });
  };
  const partials = async () => (await readdir(cache)).filter((name) => join(cache, name) !== retained);
  return { cache, retained, broker, peer, context, download, partials };
}

it("retains failed partial files and their quota after EACCES, retries cleanup, then admits a fresh transfer", async () => {
  const size = QQ_MEDIA_LIMITS.chunkBytes + 1;
  const { cache, broker, peer, download, partials } = await setup(size);
  fault.denyUnlink = true;
  await expect(download(size, "broken")).rejects.toThrow("QQ_MODULE_REMOTE");
  const [name] = await partials();
  expect(await partials()).toHaveLength(1);
  expect((await stat(join(cache, name))).size).toBe(65536);
  const reads = peer.messages.filter((r) => r.method === "mediaRead").length;
  for (let attempt = 0; attempt < 3; attempt++) await expect(download(size, "broken")).rejects.toThrow("QQ_MEDIA_LIMIT");
  expect(peer.messages.filter((r) => r.method === "mediaRead")).toHaveLength(reads);
  expect(await partials()).toEqual([name]);
  expect(vi.mocked(unlink)).toHaveBeenCalledTimes(4);
  fault.denyUnlink = false;
  const attachment = await download(size);
  expect(await partials()).toHaveLength(1);
  expect(attachment.filePath).not.toBe(join(cache, name));
  expect(await readFile(attachment.filePath!)).toEqual(Buffer.alloc(size, 42));
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
  expect(peer.messages.filter((r) => r.method === "mediaRelease")).toHaveLength(6);
  await broker.discard(attachment);
  await expect(download(size)).resolves.toHaveProperty("filePath");
});

it("retries a failed explicit discard before TTL and releases absent-file quota only once", async () => {
  const { broker, download, partials } = await setup(5);
  const attachment = await download(5);
  fault.denyUnlink = true;
  await broker.discard(attachment);
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
  expect(await partials()).toHaveLength(1);
  // Another actor already removed the file; ENOENT confirms no bytes remain.
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await actual.unlink(attachment.filePath!); fault.denyUnlink = false;
  await Promise.all([broker.cleanup(), broker.discard(attachment), broker.cleanup()]);
  expect(await partials()).toEqual([]);
  await expect(download(5)).resolves.toHaveProperty("filePath");
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
});

it.each([false, true])("keeps quota while concurrent cleanup/discard deletion is pending (failure=%s)", async (fail) => {
  const { broker, download, partials } = await setup(5);
  const attachment = await download(5);
  let finish!: () => void;
  fault.holdUnlink = new Promise<void>((resolve) => { finish = resolve; }); fault.denyUnlink = fail;
  const discard = broker.discard(attachment);
  const cleanup = broker.cleanup();
  const secondDiscard = broker.discard(attachment);
  let settled = false;
  const next = download(5).then((value) => ({ value }), (error: Error) => ({ error })).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(unlink).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); expect(await partials()).toHaveLength(1);
  } finally { finish(); }
  await Promise.all([discard, cleanup, secondDiscard]);
  const result = await next;
  if (fail) {
    expect(result).toMatchObject({ error: { message: "QQ_MEDIA_LIMIT" } });
    fault.denyUnlink = false; fault.holdUnlink = undefined;
    await broker.cleanup(); await expect(download(5)).resolves.toHaveProperty("filePath");
  } else { expect(result).toHaveProperty("value.filePath"); }
  // A duplicate release would let this exceed the one-transfer free budget.
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
  expect(await partials()).toHaveLength(1);
});

it("leaves active downloads alone and retains a revoked partial when deletion fails", async () => {
  const size = QQ_MEDIA_LIMITS.chunkBytes + 1;
  const { cache, broker, peer, download, partials } = await setup(size);
  const fallback = peer.behavior;
  let waiting = false;
  peer.behavior = (request) => {
    if (request.method === "mediaRead" && request.payload.offset > 0) { waiting = true; return; }
    fallback(request);
  };
  const abort = new AbortController();
  const pending = download(size, "broken", abort.signal);
  const rejected = expect(pending).rejects.toThrow("QQ_MODULE_CANCELLED");
  await vi.waitFor(() => expect(waiting).toBe(true));
  await broker.cleanup();
  expect((await stat(join(cache, (await partials())[0]))).size).toBe(65536);
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
  fault.denyUnlink = true; abort.abort(); await rejected;
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
  fault.denyUnlink = false; await broker.cleanup();
  expect(await partials()).toEqual([]);
  peer.behavior = fallback;
  await expect(download(size)).resolves.toHaveProperty("filePath");
});

it("tracks files even when close throws and unlink also fails", async () => {
  const { broker, download, partials } = await setup(5);
  fault.closeError = true; fault.denyUnlink = true;
  await expect(download(5)).rejects.toThrow("close failed");
  expect(await partials()).toHaveLength(1);
  await expect(download(1)).rejects.toThrow("QQ_MEDIA_LIMIT");
  fault.closeError = false; fault.denyUnlink = false;
  await broker.cleanup(); expect(await partials()).toEqual([]);
  await expect(download(5)).resolves.toHaveProperty("filePath");
});

it("reconstructs quota for partial files on restart and expires them using the existing cache rules", async () => {
  const size = QQ_MEDIA_LIMITS.chunkBytes + 1;
  const { cache, peer, context, download, partials } = await setup(size);
  fault.denyUnlink = true;
  await expect(download(size, "broken")).rejects.toThrow("QQ_MODULE_REMOTE");
  const restarted = new QqMediaBroker(cache);
  await expect(restarted.download(context, "event", { kind: "file", mediaId: "good", size: 2 })).rejects.toThrow("QQ_MEDIA_LIMIT");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await actual.utimes(join(cache, (await partials())[0]), 0, 0);
  const expired = new QqMediaBroker(cache); fault.denyUnlink = false;
  await expired.cleanup(); expect(await partials()).toEqual([]);
  await expect(expired.download(context, "event", { kind: "file", mediaId: "good", size })).resolves.toHaveProperty("filePath");
  expect(peer.messages.at(-1)?.method).toBe("mediaRelease");
});
