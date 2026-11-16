import type { QqConversation, QqMedia } from "./types";
import { isBoundedJson, strictObject, validateSendRequest } from "./validation";

/** Bounded private IPC. No path, URL, generic action or authority travels here. */
export const QQ_MEDIA_LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  cacheBytes: 512 * 1024 * 1024,
  handleTtlMs: 5 * 60 * 1000,
  transferTimeoutMs: 120000,
});
export interface QqMediaBeginUpload {
  connectionEpoch: number;
  operationId: string;
  conversation: QqConversation;
  media: Omit<QqMedia, "mediaId"> & { size: number };
  sha256: string;
}
export interface QqMediaWrite { connectionEpoch: number; mediaId: string; offset: number; data: string }
export interface QqMediaRead { connectionEpoch: number; mediaId: string; eventId: string; offset: number; limit: number }
export interface QqMediaRelease { connectionEpoch: number; mediaId: string }
export interface QqMediaChunk { data: string; eof: boolean }
const id = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const integer = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const offset = (v: unknown): boolean => integer(v) && (v as number) <= QQ_MEDIA_LIMITS.maxFileBytes;
/** Canonical RFC4648 only: prevents permissive decoders hiding truncation or junk. */
export function isQqMediaBase64(v: unknown): v is string {
  if (typeof v !== "string" || v.length > Math.ceil(QQ_MEDIA_LIMITS.chunkBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (v.endsWith("==") && alphabet.indexOf(v[v.length - 3]) % 16 !== 0) return false;
  if (!v.endsWith("==") && v.endsWith("=") && alphabet.indexOf(v[v.length - 2]) % 4 !== 0) return false;
  return (v.length / 4) * 3 - (v.endsWith("==") ? 2 : v.endsWith("=") ? 1 : 0) <= QQ_MEDIA_LIMITS.chunkBytes;
}
export function validateMediaBeginUpload(v: unknown): v is QqMediaBeginUpload {
  if (!isBoundedJson(v) || !strictObject(v, {
    connectionEpoch: integer, operationId: id, conversation: () => true,
    sha256: (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s),
    media: (m) => m !== null && typeof m === "object" && !Array.isArray(m)
      && !Object.hasOwn(m, "mediaId") && offset((m as QqMedia).size) && ((m as QqMedia).size ?? 0) > 0,
  })) return false;
  const value = v as QqMediaBeginUpload;
  return validateSendRequest({ operationId: value.operationId, runtimeEpoch: 0, connectionEpoch: value.connectionEpoch,
    selfId: "validation", conversation: value.conversation, parts: [{ ...value.media, mediaId: "validation" }] });
}
export function validateMediaWrite(v: unknown): v is QqMediaWrite {
  return isBoundedJson(v) && strictObject(v, { connectionEpoch: integer, mediaId: id, offset,
    data: (d) => isQqMediaBase64(d) && d.length > 0 });
}
export function validateMediaRead(v: unknown): v is QqMediaRead {
  return isBoundedJson(v) && strictObject(v, { connectionEpoch: integer, mediaId: id, eventId: id, offset,
    limit: (n) => integer(n) && (n as number) > 0 && (n as number) <= QQ_MEDIA_LIMITS.chunkBytes });
}
export function validateMediaRelease(v: unknown): v is QqMediaRelease {
  return isBoundedJson(v) && strictObject(v, { connectionEpoch: integer, mediaId: id });
}
export function validateMediaChunk(v: unknown, request?: QqMediaRead): v is QqMediaChunk {
  if (!isBoundedJson(v) || !strictObject(v, { data: isQqMediaBase64, eof: (b) => typeof b === "boolean" })) return false;
  const value = v as QqMediaChunk;
  const bytes = (value.data.length / 4) * 3 - (value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0);
  return (value.eof || bytes > 0) && (!request || bytes <= request.limit);
}
