import type { QqInboundMessageV1, QqSendRequestV1, QqSendResultV1, QqCapabilitySnapshot } from "./types";

/** 候选契约上限，不代表后端实际支持；传输必须在解码前另限帧大小。 */
export const QQ_CONTRACT_LIMITS = Object.freeze({
  maxJsonBytes: 256 * 1024,
  maxTextLength: 32 * 1024,
  maxParts: 64,
  maxAttachments: 16,
  maxMentions: 64,
  maxMediaBytes: 100 * 1024 * 1024,
});
type Check = (value: unknown) => boolean;
const integer = (max = Number.MAX_SAFE_INTEGER): Check => (v) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const string = (max: number, min = 0): Check => (v) => typeof v === "string" && v.length >= min && v.length <= max;
const oneOf = (...values: string[]): Check => (v) => typeof v === "string" && values.includes(v);
const id = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const text = string(QQ_CONTRACT_LIMITS.maxTextLength);
const name = string(256);
const array = (check: Check, max: number, min = 0): Check => (v) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
export function strictObject(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(required).every((key) => Object.hasOwn(record, key) && required[key](record[key]))
    && Object.keys(record).every((key) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](record[key])));
}
/** Reject non-JSON objects, accessors, cycles, sparse arrays and silently lost properties. */
export function isBoundedJson(value: unknown): boolean {
  const seen = new Set<object>();
  let nodes = 0;
  // Lower bound on encoded JSON size. Account before stringify so a wide object
  // cannot allocate an unbounded serialized string merely to discover its size.
  let minimumBytes = 0;
  function account(bytes: number): boolean {
    minimumBytes += bytes;
    return minimumBytes <= QQ_CONTRACT_LIMITS.maxJsonBytes;
  }
  function visit(v: unknown, depth: number): boolean {
    if (++nodes > 10000 || depth > 12 || !account(1)) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "string") return account(v.length);
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object" || seen.has(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    seen.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.length > 10000) return false;
    if (Array.isArray(v) && (v.length > 10000 || keys.length !== v.length + 1)) return false;
    for (const key of keys) {
      if (Array.isArray(v) && key === "length") continue;
      if (typeof key !== "string") return false;
      if (!Array.isArray(v) && !account(key.length)) return false;
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || !visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(v);
    return true;
  }
  try {
    return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= QQ_CONTRACT_LIMITS.maxJsonBytes;
  } catch { return false; }
}
const conversation: Check = (v) => strictObject(v, { type: oneOf("private"), peerId: id }) || strictObject(v, { type: oneOf("group"), groupId: id });
const mention: Check = (v) => strictObject(v, { userId: id }, { name });
const reply: Check = (v) => strictObject(v, { messageId: id }, { senderId: id, senderName: name, text });
const filename: Check = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\\/:\x00-\x1f]/.test(v) && v !== "." && v !== "..";
const media: Check = (v) => strictObject(v, { kind: oneOf("image", "audio", "file", "video", "sticker"), mediaId: id }, {
  mime: (v) => typeof v === "string" && v.length <= 128 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(v), caption: text, filename, size: integer(QQ_CONTRACT_LIMITS.maxMediaBytes),
});
const part: Check = (v) => media(v) || strictObject(v, { kind: oneOf("text"), text }) || strictObject(v, { kind: oneOf("card"), title: name }, {
  markdown: text, fields: array((f) => strictObject(f, { key: name, value: string(4096) }), 32),
});
export function validateInboundMessage(v: unknown): v is QqInboundMessageV1 {
  return isBoundedJson(v) && strictObject(v, {
    eventId: id, backendMessageId: id, selfId: id, connectionEpoch: integer(), configRevision: integer(),
    conversation, senderId: id, timestampMs: integer(8640000000000000), text,
  }, { senderName: name, mentions: array(mention, QQ_CONTRACT_LIMITS.maxMentions), reply, attachments: array(media, QQ_CONTRACT_LIMITS.maxAttachments) });
}
export function validateSendRequest(v: unknown): v is QqSendRequestV1 {
  return isBoundedJson(v) && strictObject(v, {
    operationId: id, runtimeEpoch: integer(), connectionEpoch: integer(), selfId: id, conversation, parts: array(part, QQ_CONTRACT_LIMITS.maxParts, 1),
  }, { replyContext: (r) => strictObject(r, { messageId: id }, { mentionUserId: id }) });
}
const errorCode = oneOf("backend-unavailable", "unsupported", "rejected", "timeout", "disconnected", "internal");
const partResult: Check = (v) => strictObject(v, { partIndex: integer(QQ_CONTRACT_LIMITS.maxParts - 1), outcome: oneOf("sent") }, { messageId: id })
  || strictObject(v, { partIndex: integer(QQ_CONTRACT_LIMITS.maxParts - 1), outcome: oneOf("failed", "unknown"), errorCode });
/** Optional expected request also checks operation identity and exact part coverage. */
export function validateSendResult(v: unknown, expected?: QqSendRequestV1): v is QqSendResultV1 {
  if (!isBoundedJson(v) || !strictObject(v, { operationId: id, outcome: oneOf("sent", "partial", "failed", "unknown"), parts: array(partResult, QQ_CONTRACT_LIMITS.maxParts, 1) })) return false;
  const result = v as QqSendResultV1;
  if (result.parts.some((p, index) => p.partIndex !== index)) return false;
  if (expected && (!validateSendRequest(expected) || result.operationId !== expected.operationId || result.parts.length !== expected.parts.length)) return false;
  const states = result.parts.map((p) => p.outcome);
  const aggregate = states.includes("unknown") ? "unknown" : states.every((s) => s === "sent") ? "sent" : states.includes("sent") ? "partial" : "failed";
  return result.outcome === aggregate;
}

export function validateCapabilitySnapshot(v: unknown): v is QqCapabilitySnapshot {
  const boolean: Check = (value) => typeof value === "boolean";
  return isBoundedJson(v) && strictObject(v, {
    messages: (value) => strictObject(value, {
      text: boolean, image: boolean, audio: boolean, file: boolean, video: boolean,
      markdown: boolean, card: boolean, sticker: boolean, reply: boolean, mention: boolean,
      maxTextLength: integer(QQ_CONTRACT_LIMITS.maxTextLength),
      maxFileBytes: integer(QQ_CONTRACT_LIMITS.maxMediaBytes),
    }),
    backend: (value) => strictObject(value, { napcatStream: boolean }),
  });
}
