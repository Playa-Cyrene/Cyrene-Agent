import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OneBotActionClient } from "./onebot-action-client";
import { OneBotActionError } from "./onebot-action-client";
import { normalizeOneBotMessage } from "./onebot-normalizer";
import { OneBotMediaManager, versionAtLeast, ONEBOT_BASE64_THRESHOLD_BYTES, ONEBOT_CACHE_TTL_MS, ONEBOT_MAX_FILE_BYTES } from "./onebot-media";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OneBotMediaManager", () => {
  it("首附件下载途中撤销后不写缓存，也不开始第二附件", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-cancel-"));
    tempDirs.push(dir);
    const activity = new AbortController();
    const fetch = vi.fn(async () => {
      activity.abort(new Error("channel_stopped"));
      return new Response("synthetic");
    });
    vi.stubGlobal("fetch", fetch);
    const media = new OneBotMediaManager(() => null, dir);
    await expect(normalizeOneBotMessage({
      message_type: "private", user_id: "peer", message_id: "synthetic",
      message: [1, 2].map((id) => ({ type: "image", data: { url: `https://example.test/${id}` } })),
    } as never, { selfId: "bot", client: {} as never, media, supportsStream: false, signal: activity.signal })).rejects.toThrow("channel_stopped");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("文件路径解析期间重启不能借用新客户端上传旧文件", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-cancel-"));
    tempDirs.push(dir);
    const file = path.join(dir, "synthetic.bin");
    fs.writeFileSync(file, "synthetic");
    const activity = new AbortController();
    const newClient = { call: vi.fn() };
    vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async () => {
      activity.abort(new Error("channel_stopped"));
      return file;
    });
    const media = new OneBotMediaManager(() => newClient as never, dir);
    await expect(media.encodeOutbound(file, "file", true, activity.signal)).rejects.toThrow("channel_stopped");
    expect(newClient.call).not.toHaveBeenCalled();
  });
  it("compares NapCat semantic versions", () => {
    expect(versionAtLeast("4.8.115", "4.8.115")).toBe(true);
    expect(versionAtLeast("NapCat 4.18.4", "4.8.115")).toBe(true);
    expect(versionAtLeast("4.8.99", "4.8.115")).toBe(false);
  });

  it("writes out-of-order download chunks at their declared offsets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const client = {
      callStream: vi.fn(async (_action, _params, onPacket) => {
        await onPacket({ type: "stream", data_type: "file_info", file_name: "a.bin", file_size: 6, chunk_size: 3 });
        await onPacket({ type: "stream", data_type: "file_chunk", index: 1, data: Buffer.from("def").toString("base64"), size: 3 });
        await onPacket({ type: "stream", data_type: "file_chunk", index: 0, data: Buffer.from("abc").toString("base64"), size: 3 });
        return { type: "response", data_type: "file_complete", total_chunks: 2, total_bytes: 6 };
      }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir);
    const attachment = await manager.downloadSegment({ type: "file", data: { file_id: "f-1" } }, true);
    expect(fs.readFileSync(attachment.filePath!, "utf8")).toBe("abcdef");
  });

  it("uses base64 for a small outbound image", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const image = path.join(dir, "a.png");
    fs.writeFileSync(image, Buffer.from("png-data"));
    const manager = new OneBotMediaManager(() => null, dir);
    await expect(manager.encodeOutbound(image, "image", false)).resolves.toBe(`base64://${Buffer.from("png-data").toString("base64")}`);
  });

  it("rejects invalid stream metadata before writing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const client = {
      callStream: vi.fn(async (_action, _params, onPacket) => {
        await onPacket({ type: "stream", data_type: "file_info", file_name: "a.bin", file_size: 6, chunk_size: 0 });
        return { type: "response", data_type: "file_complete" };
      }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir);
    await expect(manager.downloadSegment({ type: "file", data: { file_id: "f-1" } }, true)).rejects.toThrow(/chunk_size/);
  });

  it("rejects a stream whose chunk indexes skip a position (silent hole passes byte counts)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const client = {
      // file_size=9, chunk_size=3：发 index 0（超长 6 字节）和 index 2（3 字节，跳过 1）——
      // 偏移上界、字节总数、chunk 总数、total_bytes 全部对得上，但 index 1 的区间是稀疏零洞，必须被连续性校验拦下
      callStream: vi.fn(async (_action, _params, onPacket) => {
        await onPacket({ type: "stream", data_type: "file_info", file_name: "a.bin", file_size: 9, chunk_size: 3 });
        await onPacket({ type: "stream", data_type: "file_chunk", index: 0, data: Buffer.from("aaaaaa").toString("base64"), size: 6 });
        await onPacket({ type: "stream", data_type: "file_chunk", index: 2, data: Buffer.from("ccc").toString("base64"), size: 3 });
        return { type: "response", data_type: "file_complete", total_chunks: 2, total_bytes: 9 };
      }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir);
    await expect(manager.downloadSegment({ type: "file", data: { file_id: "f-1" } }, true)).rejects.toThrow(/not contiguous/);
  });

  it("rejects chunk offsets beyond the declared file size", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const client = {
      callStream: vi.fn(async (_action, _params, onPacket) => {
        await onPacket({ type: "stream", data_type: "file_info", file_name: "a.bin", file_size: 6, chunk_size: 3 });
        await onPacket({ type: "stream", data_type: "file_chunk", index: 5, data: Buffer.from("abc").toString("base64"), size: 3 });
        return { type: "response", data_type: "file_complete", total_chunks: 1, total_bytes: 3 };
      }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir);
    await expect(manager.downloadSegment({ type: "file", data: { file_id: "f-1" } }, true)).rejects.toThrow(/offset exceeds file size/);
  });

  it("rejects a stream with missing chunks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const client = {
      callStream: vi.fn(async (_action, _params, onPacket) => {
        await onPacket({ type: "stream", data_type: "file_info", file_name: "a.bin", file_size: 6, chunk_size: 3 });
        await onPacket({ type: "stream", data_type: "file_chunk", index: 0, data: Buffer.from("abc").toString("base64"), size: 3 });
        return { type: "response", data_type: "file_complete", total_chunks: 2, total_bytes: 6 };
      }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir);
    await expect(manager.downloadSegment({ type: "file", data: { file_id: "f-1" } }, true)).rejects.toThrow(/byte count mismatch/);
  });

  it("downloads small URL media to the cache via streaming", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const payload = Buffer.from("png-url-data");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(payload))));
    const manager = new OneBotMediaManager(() => null, dir);
    const attachment = await manager.downloadSegment(
      { type: "image", data: { url: "http://127.0.0.1:1/a.png" } },
      false,
    );
    expect(fs.readFileSync(attachment.filePath!, "utf8")).toBe("png-url-data");
  });

  it("rejects URL media whose streamed body exceeds 8 MiB without content-length", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    // 无 content-length 的 chunked 响应：旧实现 arrayBuffer() 会先整读进内存再检查
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(ONEBOT_BASE64_THRESHOLD_BYTES + 1));
          controller.close();
        },
      }),
      { status: 200 },
    )));
    const manager = new OneBotMediaManager(() => null, dir);
    await expect(manager.downloadSegment(
      { type: "image", data: { url: "http://127.0.0.1:1/a.png" } },
      false,
    )).rejects.toThrow(/8 MiB/);
    // 中止后不应在缓存目录留下半截文件
    expect(fs.readdirSync(dir).length).toBe(0);
  });

  it("uploads files in chunks and validates the returned SHA-256", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const file = path.join(dir, "payload.bin");
    fs.writeFileSync(file, Buffer.from("stream-upload"));
    let expectedSha256 = "";
    const client = {
      call: vi.fn(async (_action: string, params: Record<string, unknown>) => {
        if (params.is_complete) {
          return { status: "file_complete", file_path: "/app/cache/payload.bin", sha256: expectedSha256 };
        }
        expectedSha256 = String(params.expected_sha256);
        expect(params).toMatchObject({ chunk_index: 0, total_chunks: 1, file_size: 13, filename: "payload.bin" });
        return { status: "chunk_received" };
      }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir);
    await expect(manager.encodeOutbound(file, "file", true)).resolves.toBe("/app/cache/payload.bin");
    expect((client.call as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("removes expired cache files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const expired = path.join(dir, "expired.bin");
    fs.writeFileSync(expired, "old");
    const old = new Date(Date.now() - ONEBOT_CACHE_TTL_MS - 1_000);
    fs.utimesSync(expired, old, old);
    const manager = new OneBotMediaManager(() => null, dir);
    await manager.cleanupCache();
    expect(fs.existsSync(expired)).toBe(false);
  });

  it("reports an unavailable Stream action for runtime downgrade", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const unavailable = vi.fn();
    const client = {
      callStream: vi.fn(async () => { throw new OneBotActionError("action not found", 1404); }),
    } as unknown as OneBotActionClient;
    const manager = new OneBotMediaManager(() => client, dir, unavailable);
    await expect(manager.downloadSegment({ type: "image", data: { file: "image-id" } }, true)).rejects.toThrow("action not found");
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("rejects outbound files above the 100 MiB limit before reading them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-qq-media-"));
    tempDirs.push(dir);
    const file = path.join(dir, "too-large.bin");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, ONEBOT_MAX_FILE_BYTES + 1);
    const manager = new OneBotMediaManager(() => null, dir);
    await expect(manager.encodeOutbound(file, "file", true)).rejects.toThrow(/100 MiB/);
  });
});
