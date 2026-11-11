import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";
import { pngFixture } from "../../../scripts/verify/qq-module/image-fixtures";
import { QqModuleRuntime } from "./runtime";
import { QqMediaBroker } from "./media-broker";

const fault = vi.hoisted(() => ({ failWrite: false, fd: undefined as import("node:fs/promises").FileHandle | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fd = await actual.open(...args);
      if (fault.failWrite && args[1] === "wx") {
        fault.fd = fd;
        vi.spyOn(fd, "write").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      }
      return fd;
    },
  };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const roots: string[] = [];
const runtimes: QqModuleRuntime[] = [];
afterEach(async () => {
  fault.failWrite = false; fault.fd = undefined;
  vi.mocked(randomUUID).mockReset();
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qq-image-failure-")); roots.push(root);
  const cache = join(root, "cache");
  const peer = new FakeTransport(); const fallback = peer.behavior;
  peer.behavior = (request) => {
    if (request.method !== "mediaRead") return fallback(request);
    const bytes = pngFixture.subarray(request.payload.offset, request.payload.offset + request.payload.limit);
    peer.reply(request, { data: bytes.toString("base64"), eof: request.payload.offset + bytes.length === pngFixture.length });
  };
  const runtime = new QqModuleRuntime(peer, 1, 100); runtimes.push(runtime);
  const broker = new QqMediaBroker(cache);
  const context = { runtime, connectionEpoch: 1, assertAuthorized() {} };
  const media = { kind: "image" as const, mediaId: "image-handle", size: pngFixture.length };
  return { cache, peer, broker, context, media };
}

it("closes the file and removes incomplete images after ENOSPC, then permits a fresh download", async () => {
  const { cache, peer, broker, context, media } = await setup();
  fault.failWrite = true;
  await expect(broker.download(context, "event", media)).rejects.toMatchObject({ code: "ENOSPC" });
  expect(fault.fd).toBeDefined();
  await expect(fault.fd!.stat()).rejects.toMatchObject({ code: "EBADF" });
  expect(await readdir(cache)).toEqual([]);
  fault.failWrite = false;
  const attachment = await broker.download(context, "event", media);
  expect(attachment.mime).toBe("image/png");
  expect(await readFile(attachment.filePath!)).toEqual(pngFixture);
  expect(peer.messages.filter((request) => request.method === "mediaRelease")).toHaveLength(2);
});

it("does not overwrite or unlink an existing cache file when the random wx path collides", async () => {
  const { cache, peer, broker, context, media } = await setup();
  await broker.cleanup();
  const id = "00000000-0000-0000-0000-000000000001";
  const existingPath = join(cache, `qq-media-${id}.png`);
  const retainedBytes = Buffer.from("existing file must survive exclusive-open failure");
  await writeFile(existingPath, retainedBytes);
  // Runtime request IDs also use randomUUID; keep the override through the probe.
  vi.mocked(randomUUID).mockReturnValue(id);
  await expect(broker.download(context, "event", media)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(existingPath)).toEqual(retainedBytes);
  expect(await readdir(cache)).toEqual([`qq-media-${id}.png`]);
  vi.mocked(randomUUID).mockReset();
  const attachment = await broker.download(context, "event", media);
  expect(attachment.filePath).not.toBe(existingPath);
  expect(await readFile(attachment.filePath!)).toEqual(pngFixture);
  expect(await readFile(existingPath)).toEqual(retainedBytes);
  expect(peer.messages.filter((request) => request.method === "mediaRelease")).toHaveLength(2);
});
