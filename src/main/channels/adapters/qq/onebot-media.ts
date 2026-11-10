import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";
import type { ChannelAttachment } from "../../types";
import { OneBotActionClient, OneBotActionError } from "./onebot-action-client";
import type { OneBotSegment, OneBotStreamPacket } from "./onebot-types";

export const ONEBOT_STREAM_MIN_VERSION = "4.8.115";
export const ONEBOT_STREAM_CHUNK_BYTES = 64 * 1024;
export const ONEBOT_BASE64_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const ONEBOT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const ONEBOT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
export const ONEBOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type MediaKind = "image" | "audio" | "file" | "video";

function sanitizeFilename(value: string, fallback: string): string {
  const base = path.basename(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return (base || fallback).slice(0, 120);
}

function extensionFor(kind: MediaKind, name?: string): string {
  const ext = name ? path.extname(name).slice(0, 12) : "";
  if (ext) return ext;
  if (kind === "image") return ".png";
  if (kind === "audio") return ".mp3";
  if (kind === "video") return ".mp4";
  return ".bin";
}

function mimeFor(kind: MediaKind, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (kind === "image") {
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    return "image/png";
  }
  if (kind === "audio") return ext === ".wav" ? "audio/wav" : "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false;
  const parse = (value: string) => value.match(/\d+(?:\.\d+){1,3}/)?.[0]
    .split(".")
    .map((item) => Number(item)) ?? [];
  const actual = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < Math.max(actual.length, required.length); i++) {
    const left = actual[i] ?? 0;
    const right = required[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export class OneBotMediaManager {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getClient: () => OneBotActionClient | null,
    private readonly cacheDir = path.join(app.getPath("userData"), "channels", "cache", "qq"),
    private readonly onStreamUnavailable?: (error: Error) => void,
  ) {}

  async start(): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    await this.cleanupCache();
    this.cleanupTimer = setInterval(() => void this.cleanupCache(), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  async downloadSegment(segment: OneBotSegment, supportsStream: boolean, signal?: AbortSignal): Promise<ChannelAttachment> {
    signal?.throwIfAborted();
    const kind = this.segmentKind(segment.type);
    const data = segment.data;
    const file = String(data.file_id ?? data.file ?? data.url ?? "");
    if (!file) throw new Error(`${segment.type} 消息缺少 file/file_id`);

    let filePath: string;
    if (supportsStream) {
      const action = kind === "image"
        ? "download_file_image_stream"
        : kind === "audio"
          ? "download_file_record_stream"
          : "download_file_stream";
      try {
        filePath = await this.downloadStream(action, file, kind, signal);
      } catch (error) {
        this.reportStreamUnavailable(error);
        throw error;
      }
    } else {
      const url = typeof data.url === "string" ? data.url : "";
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("当前 NapCat 不支持 Stream API，且消息没有可下载 URL");
      }
      filePath = await this.downloadUrl(url, kind, signal);
    }
    signal?.throwIfAborted();
    await this.cleanupCache(new Set([filePath]));

    return {
      kind,
      filePath,
      mime: mimeFor(kind, filePath),
      caption: typeof data.file_name === "string"
        ? data.file_name
        : typeof data.file === "string"
          ? path.basename(data.file)
          : undefined,
    };
  }

  async encodeOutbound(filePath: string, kind: MediaKind, supportsStream: boolean, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const resolved = await fs.promises.realpath(filePath);
    const stat = await fs.promises.stat(resolved);
    signal?.throwIfAborted();
    if (!stat.isFile()) throw new Error(`QQ 媒体路径不是文件: ${filePath}`);
    if (stat.size > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 单文件不能超过 100 MiB");

    if ((kind === "image" || kind === "audio") && stat.size <= ONEBOT_BASE64_THRESHOLD_BYTES) {
      return `base64://${(await fs.promises.readFile(resolved, { signal })).toString("base64")}`;
    }
    if (!supportsStream) {
      throw new Error("NapCat Stream API 不可用，无法跨 WSL 发送此媒体");
    }
    try {
      return await this.uploadStream(resolved, stat.size, signal);
    } catch (error) {
      this.reportStreamUnavailable(error);
      throw error;
    }
  }

  async cleanupCache(protectedPaths: ReadonlySet<string> = new Set()): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    const now = Date.now();
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const item of await fs.promises.readdir(this.cacheDir, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const itemPath = path.join(this.cacheDir, item.name);
      try {
        const stat = await fs.promises.stat(itemPath);
        if (now - stat.mtimeMs > ONEBOT_CACHE_TTL_MS) {
          await fs.promises.unlink(itemPath);
          continue;
        }
        entries.push({ path: itemPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件可能刚被其他清理任务删除。
      }
    }
    let total = entries.reduce((sum, item) => sum + item.size, 0);
    for (const item of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= ONEBOT_CACHE_MAX_BYTES) break;
      if (protectedPaths.has(item.path)) continue;
      try {
        await fs.promises.unlink(item.path);
        total -= item.size;
      } catch {
        // best effort
      }
    }
  }

  private segmentKind(type: string): MediaKind {
    if (type === "image" || type === "mface") return "image";
    if (type === "record") return "audio";
    if (type === "video") return "video";
    if (type === "file") return "file";
    throw new Error(`不支持的 QQ 媒体类型: ${type}`);
  }

  private async downloadStream(action: string, file: string, kind: MediaKind, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const client = this.getClient();
    if (!client) throw new Error("NapCat 未连接");

    let targetPath = "";
    const state: { handle?: fs.promises.FileHandle } = {};
    let expectedSize = 0;
    let chunkSize = ONEBOT_STREAM_CHUNK_BYTES;
    let bytesWritten = 0;
    const indexes = new Set<number>();
    try {
      const payload: Record<string, unknown> = { file, chunk_size: ONEBOT_STREAM_CHUNK_BYTES };
      if (kind === "audio") payload.out_format = "mp3";
      const completed = await client.callStream<OneBotStreamPacket>(action, payload, async (packet) => {
        signal?.throwIfAborted();
        if (packet.data_type === "file_info") {
          if (state.handle || targetPath) throw new Error("Duplicate stream file_info packet");
          expectedSize = Number(packet.file_size ?? 0);
          if (!Number.isFinite(expectedSize) || expectedSize < 0) throw new Error("Invalid stream file_size");
          if (expectedSize > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 入站文件超过 100 MiB");
          chunkSize = Number(packet.chunk_size ?? ONEBOT_STREAM_CHUNK_BYTES);
          if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024 * 1024) {
            throw new Error("Invalid stream chunk_size");
          }
          const safeName = sanitizeFilename(packet.file_name ?? "", `media${extensionFor(kind)}`);
          const ext = extensionFor(kind, safeName);
          targetPath = path.join(this.cacheDir, `qq-${Date.now()}-${randomUUID()}${ext}`);
          state.handle = await fs.promises.open(targetPath, "w");
          return;
        }
        if (packet.data_type !== "file_chunk") return;
        if (!state.handle || !targetPath) throw new Error("Stream chunk arrived before file_info");
        const index = Number(packet.index);
        if (!Number.isInteger(index) || index < 0 || indexes.has(index)) {
          throw new Error(`Invalid or duplicate stream chunk index: ${packet.index}`);
        }
        const buffer = Buffer.from(packet.data ?? "", "base64");
        if (buffer.length !== Number(packet.size ?? buffer.length)) throw new Error("Stream chunk size mismatch");
        if (bytesWritten + buffer.length > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 入站文件超过 100 MiB");
        // 写入前校验偏移上界：异常/恶意的超大 index 会先造出 GB 级稀疏文件才被终验拦截
        const offset = index * chunkSize;
        if (offset + buffer.length > ONEBOT_MAX_FILE_BYTES) throw new Error("QQ 入站 chunk 偏移越界");
        if (expectedSize > 0 && offset + buffer.length > expectedSize) throw new Error("Stream chunk offset exceeds file size");
        await state.handle.write(buffer, 0, buffer.length, offset);
        indexes.add(index);
        bytesWritten += buffer.length;
      });
      signal?.throwIfAborted();
      await state.handle?.close();
      state.handle = undefined;
      if (!targetPath) throw new Error("Stream did not provide file_info");
      if (expectedSize > 0 && bytesWritten !== expectedSize) {
        throw new Error(`Stream byte count mismatch: ${bytesWritten}/${expectedSize}`);
      }
      if (completed.total_chunks !== undefined && indexes.size !== completed.total_chunks) {
        throw new Error(`Stream chunk count mismatch: ${indexes.size}/${completed.total_chunks}`);
      }
      if (completed.total_bytes !== undefined && bytesWritten !== completed.total_bytes) {
        throw new Error(`Stream completed byte mismatch: ${bytesWritten}/${completed.total_bytes}`);
      }
      // 连续性校验：字节总数与 chunk 总数都正确也可能存在"空洞"（跳写的稀疏文件），
      // 必须确认索引集合恰为 {0..n-1}，否则损坏的附件会被当作正常文件交给 agent
      if (indexes.size > 0) {
        let maxIndex = -1;
        for (const idx of indexes) {
          if (idx > maxIndex) maxIndex = idx;
        }
        if (maxIndex !== indexes.size - 1) {
          throw new Error(`Stream chunk indexes not contiguous: ${indexes.size} chunks, max index ${maxIndex}`);
        }
      }
      return targetPath;
    } catch (error) {
      await state.handle?.close().catch(() => undefined);
      if (targetPath) await fs.promises.unlink(targetPath).catch(() => undefined);
      throw error;
    }
  }

  private async downloadUrl(url: string, kind: MediaKind, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const requestSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok) throw new Error(`QQ 媒体下载失败: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > ONEBOT_BASE64_THRESHOLD_BYTES) throw new Error("旧版 NapCat URL 媒体超过 8 MiB");
    // 流式读取：content-length 缺失或伪造（chunked 传输）时 arrayBuffer() 会无上限整读进内存，
    // 累计超过阈值立即中止，避免主进程 OOM
    let buffer: Buffer;
    if (response.body) {
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = response.body.getReader();
      let exceeded = false;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > ONEBOT_BASE64_THRESHOLD_BYTES) {
            exceeded = true;
            throw new Error("旧版 NapCat URL 媒体超过 8 MiB");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        if (exceeded || signal?.aborted) void reader.cancel().catch(() => undefined);
      }
      buffer = Buffer.concat(chunks);
    } else {
      buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > ONEBOT_BASE64_THRESHOLD_BYTES) throw new Error("旧版 NapCat URL 媒体超过 8 MiB");
    }
    signal?.throwIfAborted();
    const ext = extensionFor(kind, new URL(url).pathname);
    const targetPath = path.join(this.cacheDir, `qq-${Date.now()}-${randomUUID()}${ext}`);
    await fs.promises.writeFile(targetPath, buffer, { signal });
    return targetPath;
  }

  private async uploadStream(filePath: string, fileSize: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const client = this.getClient();
    if (!client) throw new Error("NapCat 未连接");
    if (fileSize === 0) throw new Error("QQ 不支持发送空文件");
    const streamId = randomUUID();
    const totalChunks = Math.max(1, Math.ceil(fileSize / ONEBOT_STREAM_CHUNK_BYTES));
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath, { signal })) hash.update(chunk as Buffer);
    const expectedSha256 = hash.digest("hex");
    let index = 0;
    for await (const rawChunk of fs.createReadStream(filePath, { highWaterMark: ONEBOT_STREAM_CHUNK_BYTES, signal })) {
      signal?.throwIfAborted();
      const chunk = rawChunk as Buffer;
      const packet = await client.call<OneBotStreamPacket>("upload_file_stream", {
        stream_id: streamId,
        chunk_data: chunk.toString("base64"),
        chunk_index: index,
        total_chunks: totalChunks,
        file_size: fileSize,
        expected_sha256: expectedSha256,
        filename: path.basename(filePath),
        file_retention: 10 * 60 * 1000,
      }, 10 * 60_000);
      if (packet.status && packet.status !== "chunk_received" && packet.status !== "file_created") {
        throw new Error(`NapCat upload rejected chunk ${index}: ${packet.status}`);
      }
      index++;
    }
    signal?.throwIfAborted();
    const completed = await client.call<OneBotStreamPacket>("upload_file_stream", {
      stream_id: streamId,
      is_complete: true,
      file_retention: 10 * 60 * 1000,
    }, 10 * 60_000);
    if (completed.status !== "file_complete" || !completed.file_path) {
      throw new Error("NapCat upload did not return file_path");
    }
    if (completed.sha256 && completed.sha256 !== expectedSha256) {
      throw new Error("NapCat upload SHA-256 mismatch");
    }
    return completed.file_path;
  }

  private reportStreamUnavailable(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof OneBotActionError)
      || (error.retcode !== 1404 && !/(?:not found|unsupported|not support|未找到|不支持)/iu.test(message))) {
      return;
    }
    this.onStreamUnavailable?.(error);
  }
}
