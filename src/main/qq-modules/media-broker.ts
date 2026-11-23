import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { QQ_MEDIA_LIMITS, type QqConversation, type QqMedia } from "../../shared/qq-module";
import type { ChannelAttachment, OutgoingPart } from "../channels/types";
import type { QqModuleRuntime } from "./runtime";
import { identifyQqImage, QQ_IMAGE_HEADER_BYTES } from "./image-format";

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
interface CachedFile {
  size: number;
  created: number;
  deletion?: "expiry" | "required";
  removing?: Promise<void>;
}
/** Keep ordinary ordering, without waiting for best-effort work after revocation. */
async function waitWhileActive(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  let aborted!: () => void;
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  try { await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", aborted); }
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
  private active = new Set<Promise<unknown>>();
  private pendingClosures = new Set<FileHandle>();
  private closing = new Map<FileHandle, Promise<void>>();
  private closeFile(fd: FileHandle): Promise<void> {
    const existing = this.closing.get(fd); if (existing) return existing;
    this.pendingClosures.add(fd);
    const work = (async () => {
      try { await fd.close(); }
      catch (error) {
        // FileHandle.fd is -1 after a confirmed close; a post-close error must
        // not permanently block recovery, unlike an actually open descriptor.
        if (fd.fd === -1) this.pendingClosures.delete(fd);
        throw error;
      }
      this.pendingClosures.delete(fd);
    })();
    this.closing.set(fd, work);
    return work.finally(() => { this.closing.delete(fd); });
  }
  /** Local media work must settle before a stopped generation can be discarded. */
  get hasPendingCleanup(): boolean {
    return this.active.size > 0 || this.pendingClosures.size > 0 || [...this.files.values()].some((file) => file.deletion === "required");
  }
  private async track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    try { return await work; } finally { this.active.delete(work); }
  }
  async settleForShutdown(): Promise<void> {
    await Promise.allSettled([...this.active]);
    await Promise.allSettled([...this.pendingClosures].map((fd) => this.closeFile(fd)));
    // Expired, already delivered cache files retain quota and retry on the next
    // housekeeping pass, but are not unfinished transfer/discard work.
    for (const [path, info] of this.files) {
      if (info.deletion === "required") await this.removeFile(path, info, true);
    }
  }
  private initialized?: Promise<void>;
  private files = new Map<string, CachedFile>();
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
    await this.prune();
  }
  private async cleanupBeforeTransfer(signal?: AbortSignal): Promise<void> {
    await (this.initialized ??= this.initialize());
    // A best-effort expiry unlink may be slow, but no new file has been opened.
    // Required removals remain separately tracked even if this wait is canceled.
    await waitWhileActive(this.prune(signal), signal);
  }
  private async prune(signal?: AbortSignal): Promise<void> {
    for (const [path, info] of this.files) {
      if (signal?.aborted) return;
      if (!info.deletion && Date.now() - info.created < CACHE_TTL_MS) continue;
      await this.removeFile(path, info, false);
    }
  }
  discard(attachment: ChannelAttachment): Promise<void> {
    return this.track(this.discardInternal(attachment));
  }
  private async discardInternal(attachment: ChannelAttachment): Promise<void> {
    const path = attachment.filePath; if (!path) return;
    const info = this.files.get(path); if (!info) return;
    await this.removeFile(path, info, true);
  }
  private async removeFile(path: string, info: CachedFile, required: boolean): Promise<void> {
    // Keep both tracking and quota until deletion is confirmed. An explicit
    // discard can upgrade a TTL unlink that is already in progress.
    info.deletion = required ? "required" : info.deletion ?? "expiry";
    if (info.removing) return info.removing;
    info.removing = (async () => {
      try { await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
      this.files.delete(path);
      this.reserved -= info.size;
    })();
    try { await info.removing; }
    finally { info.removing = undefined; }
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
  upload(context: QqMediaTransferContext, operationId: string, conversation: QqConversation, part: Exclude<OutgoingPart, { kind: "text" | "card" | "sticker" }>): Promise<QqMedia> {
    return this.track(this.uploadInternal(context, operationId, conversation, part));
  }
  private async uploadInternal(context: QqMediaTransferContext, operationId: string, conversation: QqConversation, part: Exclude<OutgoingPart, { kind: "text" | "card" | "sticker" }>): Promise<QqMedia> {
    context = { ...context, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(QQ_MEDIA_LIMITS.transferTimeoutMs)]) };
    const check = this.guard(context); check(); await this.cleanupBeforeTransfer(context.signal); check();
    if (!part.filePath) throw new Error("QQ_MEDIA_LOCAL_FILE_REQUIRED");
    // Windows does not guarantee O_NOFOLLOW. Check lstat before opening, match
    // exact file identity to the fd, and recheck the path before reading any bytes.
    const source = await lstat(part.filePath, { bigint: true }); check();
    if (source.isSymbolicLink() || !source.isFile()) throw new Error("QQ_MEDIA_NOT_FILE");
    const fd = await open(part.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let reserved = 0; let mediaId: string | undefined; let uploaded = false;
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
      uploaded = true;
      return { ...media, mediaId };
    } finally {
      this.reserved -= reserved;
      try { await this.closeFile(fd); }
      finally { if (!uploaded && mediaId) await waitWhileActive(this.release(context, mediaId), context.signal); }
    }
  }
  async download(context: QqMediaTransferContext, eventId: string, media: QqMedia): Promise<ChannelAttachment> {
    try { return await this.track(this.receive(context, eventId, media)); }
    finally {
      // Request release even after cancellation, without making its ACK a
      // prerequisite for handling local files (or shutting down) once revoked.
      await waitWhileActive(this.release(context, media.mediaId), context.signal);
    }
  }
  private async receive(context: QqMediaTransferContext, eventId: string, media: QqMedia): Promise<ChannelAttachment> {
    context = { ...context, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(QQ_MEDIA_LIMITS.transferTimeoutMs)]) };
    const check = this.guard(context); check(); await this.cleanupBeforeTransfer(context.signal); check();
    if (media.kind === "sticker" || media.size === undefined) throw new Error("QQ_MEDIA_UNSUPPORTED");
    this.reserve(media.size); let path: string | undefined; let complete = false;
    try {
      const read = async (offset: number, limit: number): Promise<Buffer> => {
        check();
        const chunk = await context.runtime.request("mediaRead", { connectionEpoch: context.connectionEpoch, mediaId: media.mediaId, eventId, offset, limit }, context.signal); check();
        const bytes = Buffer.from(chunk.data, "base64");
        if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== chunk.data || chunk.eof !== (offset + bytes.length === media.size)) throw new Error("QQ_MEDIA_INVALID_CHUNK");
        return bytes;
      };
      let prefix = Buffer.alloc(0); let mime = media.mime; let extension = safeExtension(media.filename);
      if (media.kind === "image") {
        // Probe only a bounded prefix, including peers that return short chunks.
        // Open the final random path exclusively: no rename/overwrite window and
        // no path or executable suffix supplied by the module can select it.
        const headerSize = Math.min(QQ_IMAGE_HEADER_BYTES, media.size);
        while (prefix.length < headerSize) {
          const bytes = await read(prefix.length, headerSize - prefix.length); check();
          prefix = Buffer.concat([prefix, bytes]);
        }
        const format = identifyQqImage(prefix, media.size);
        extension = format.extension; mime = format.mime;
      }
      const target = join(this.cacheDir, `qq-media-${randomUUID()}${extension}`);
      const fd = await open(target, "wx", 0o600); path = target;
      try {
        check(); let offset = 0;
        while (offset < media.size) {
          const bytes = offset === 0 && prefix.length ? prefix : await read(offset, Math.min(QQ_MEDIA_LIMITS.chunkBytes, media.size - offset)); check();
          let written = 0;
          while (written < bytes.length) { const result = await fd.write(bytes, written, bytes.length - written, offset + written); check(); if (!result.bytesWritten) throw new Error("QQ_MEDIA_WRITE_FAILED"); written += result.bytesWritten; }
          offset += bytes.length;
        }
      } finally { await this.closeFile(fd); }
      check(); this.files.set(path, { size: media.size, created: Date.now() }); complete = true;
      return { kind: media.kind, filePath: path, ...(mime ? { mime } : {}), ...(media.caption ? { caption: media.caption } : {}) };
    } finally {
      if (!complete) {
        if (path) {
          // Conservatively retain the full reservation, including after partial
          // writes or close errors. Restart reconstructs actual sizes from disk.
          const info: CachedFile = { size: media.size, created: Date.now() };
          this.files.set(path, info);
          await this.removeFile(path, info, true);
        } else { this.reserved -= media.size; }
      }
    }
  }
}
