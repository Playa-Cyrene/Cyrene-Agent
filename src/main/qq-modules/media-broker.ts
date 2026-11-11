import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { QQ_MEDIA_LIMITS, type QqConversation, type QqMedia } from "../../shared/qq-module";
import type { ChannelAttachment, OutgoingPart } from "../channels/types";
import type { QqModuleRuntime } from "./runtime";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_NAME = /^qq-media-[a-f0-9-]{36}(?:\.[a-z0-9]{1,8})?$/;
const EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "pdf", "txt", "csv", "docx", "xlsx", "pptx", "zip"]);
function safeExtension(filename?: string): string {
  const extension = extname(filename ?? "").slice(1).toLowerCase();
  return EXTENSIONS.has(extension) ? `.${extension}` : "";
}
function safeFilename(filename: string): string {
  return basename(filename.replaceAll("\\", "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-160).replace(/^\.+/, "_") || "attachment";
}
export interface QqMediaTransferContext {
  runtime: QqModuleRuntime;
  connectionEpoch: number;
  signal?: AbortSignal;
  maxFileBytes?: number;
  /** Host-owned authorization check; invoked after every asynchronous boundary. */
  assertAuthorized: () => void;
}
/** Construct only in trusted host composition. Module metadata never selects a path or URL. */
export class QqMediaBroker {
  private reserved = 0;
  private initialized?: Promise<void>;
  private files = new Map<string, { size: number; created: number }>();
  constructor(private cacheDir: string) {}
  private async initialize(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const requested = resolve(this.cacheDir);
    const before = await lstat(requested, { bigint: true });
    // Checking every component rejects symlinks/junctions without comparing path
    // spellings: Windows realpath may normalize drive/component casing or prefixes.
    for (let current = requested;; current = dirname(current)) {
      const component = await lstat(current);
      if (component.isSymbolicLink() || !component.isDirectory()) throw new Error("QQ_MEDIA_UNSAFE_CACHE");
      if (dirname(current) === current) break;
    }
    const canonical = await realpath(requested);
    const after = await lstat(requested, { bigint: true });
    const resolved = await lstat(canonical, { bigint: true });
    if (!before.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
      || before.dev !== after.dev || before.ino !== after.ino || before.dev !== resolved.dev || before.ino !== resolved.ino) throw new Error("QQ_MEDIA_UNSAFE_CACHE");
    this.cacheDir = canonical;
    for (const name of await readdir(this.cacheDir)) {
      if (!CACHE_NAME.test(name)) continue;
      const path = join(this.cacheDir, name); const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      this.files.set(path, { size: stat.size, created: stat.mtimeMs }); this.reserved += stat.size;
    }
  }
  async cleanup(): Promise<void> {
    await (this.initialized ??= this.initialize());
    for (const [path, info] of this.files) {
      if (Date.now() - info.created < CACHE_TTL_MS) continue;
      // Remove accounting before awaiting so concurrent cleanup cannot double release.
      this.files.delete(path);
      try { await unlink(path); this.reserved -= info.size; }
      catch { this.files.set(path, info); }
    }
  }
  async discard(attachment: ChannelAttachment): Promise<void> {
    const path = attachment.filePath; if (!path) return;
    const info = this.files.get(path); if (!info) return;
    this.files.delete(path);
    try { await unlink(path); this.reserved -= info.size; }
    catch { this.files.set(path, info); }
  }
  private reserve(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0 || size > QQ_MEDIA_LIMITS.maxFileBytes || this.reserved + size > QQ_MEDIA_LIMITS.cacheBytes) throw new Error("QQ_MEDIA_LIMIT");
    this.reserved += size;
  }
  private guard(context: QqMediaTransferContext): () => void {
    const started = Date.now();
    return () => { context.signal?.throwIfAborted(); context.assertAuthorized(); if (Date.now() - started >= QQ_MEDIA_LIMITS.transferTimeoutMs) throw new Error("QQ_MEDIA_TIMEOUT"); };
  }
  async release(context: QqMediaTransferContext, mediaId: string): Promise<void> {
    try { await context.runtime.request("mediaRelease", { connectionEpoch: context.connectionEpoch, mediaId }); } catch { /* disconnect/expiry also revokes handles */ }
  }
  async upload(context: QqMediaTransferContext, operationId: string, conversation: QqConversation, part: Exclude<OutgoingPart, { kind: "text" | "card" | "sticker" }>): Promise<QqMedia> {
    context = { ...context, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(QQ_MEDIA_LIMITS.transferTimeoutMs)]) };
    const check = this.guard(context); check(); await this.cleanup(); check();
    if (!part.filePath) throw new Error("QQ_MEDIA_LOCAL_FILE_REQUIRED");
    // Windows does not guarantee O_NOFOLLOW. Check lstat before opening, match
    // exact file identity to the fd, and recheck the path before reading any bytes.
    const source = await lstat(part.filePath, { bigint: true }); check();
    if (source.isSymbolicLink() || !source.isFile()) throw new Error("QQ_MEDIA_NOT_FILE");
    const fd = await open(part.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let reserved = 0; let mediaId: string | undefined;
    try {
      check(); const identity = await fd.stat({ bigint: true }); check();
      const pathIdentity = await lstat(part.filePath, { bigint: true }); check();
      if (!identity.isFile() || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()
        || source.dev !== identity.dev || source.ino !== identity.ino
        || source.dev !== pathIdentity.dev || source.ino !== pathIdentity.ino) throw new Error("QQ_MEDIA_CHANGED");
      const stat = await fd.stat(); check();
      if (stat.size > (context.maxFileBytes ?? QQ_MEDIA_LIMITS.maxFileBytes)) throw new Error("QQ_MEDIA_LIMIT");
      this.reserve(stat.size); reserved = stat.size;
      const bytes = Buffer.alloc(stat.size);
      for (let offset = 0; offset < bytes.length;) {
        const read = await fd.read(bytes, offset, Math.min(QQ_MEDIA_LIMITS.chunkBytes, bytes.length - offset), offset); check();
        if (!read.bytesRead) throw new Error("QQ_MEDIA_CHANGED"); offset += read.bytesRead;
      }
      const after = await fd.stat(); check();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("QQ_MEDIA_CHANGED");
      const media = { kind: part.kind, size: bytes.length, filename: safeFilename("name" in part && part.name ? part.name : part.filePath), ...("mime" in part && part.mime ? { mime: part.mime } : {}), ...("caption" in part && part.caption ? { caption: part.caption } : {}) };
      const result = await context.runtime.request("mediaBeginUpload", { connectionEpoch: context.connectionEpoch, operationId, conversation, media, sha256: createHash("sha256").update(bytes).digest("hex") }, context.signal);
      mediaId = result.mediaId; check();
      for (let offset = 0; offset < bytes.length; offset += QQ_MEDIA_LIMITS.chunkBytes) {
        await context.runtime.request("mediaWrite", { connectionEpoch: context.connectionEpoch, mediaId, offset, data: bytes.subarray(offset, offset + QQ_MEDIA_LIMITS.chunkBytes).toString("base64") }, context.signal); check();
      }
      return { ...media, mediaId };
    } catch (error) { if (mediaId) await this.release(context, mediaId); throw error; }
    finally { this.reserved -= reserved; await fd.close(); }
  }
  async download(context: QqMediaTransferContext, eventId: string, media: QqMedia): Promise<ChannelAttachment> {
    try { return await this.receive(context, eventId, media); }
    finally { await this.release(context, media.mediaId); }
  }
  private async receive(context: QqMediaTransferContext, eventId: string, media: QqMedia): Promise<ChannelAttachment> {
    context = { ...context, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(QQ_MEDIA_LIMITS.transferTimeoutMs)]) };
    const check = this.guard(context); check(); await this.cleanup(); check();
    if (media.kind === "sticker" || media.size === undefined) throw new Error("QQ_MEDIA_UNSUPPORTED");
    this.reserve(media.size); const path = join(this.cacheDir, `qq-media-${randomUUID()}${safeExtension(media.filename)}`); let complete = false;
    try {
      const fd = await open(path, "wx", 0o600);
      try {
        check(); let offset = 0;
        while (offset < media.size) {
          const limit = Math.min(QQ_MEDIA_LIMITS.chunkBytes, media.size - offset);
          const chunk = await context.runtime.request("mediaRead", { connectionEpoch: context.connectionEpoch, mediaId: media.mediaId, eventId, offset, limit }, context.signal); check();
          const bytes = Buffer.from(chunk.data, "base64");
          if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== chunk.data || chunk.eof !== (offset + bytes.length === media.size)) throw new Error("QQ_MEDIA_INVALID_CHUNK");
          let written = 0;
          while (written < bytes.length) { const result = await fd.write(bytes, written, bytes.length - written, offset + written); check(); if (!result.bytesWritten) throw new Error("QQ_MEDIA_WRITE_FAILED"); written += result.bytesWritten; }
          offset += bytes.length;
        }
      } finally { await fd.close(); }
      check(); this.files.set(path, { size: media.size, created: Date.now() }); complete = true;
      return { kind: media.kind, filePath: path, ...(media.mime ? { mime: media.mime } : {}), ...(media.caption ? { caption: media.caption } : {}) };
    } finally {
      if (!complete) { this.reserved -= media.size; await unlink(path).catch(() => {}); }
    }
  }
}
