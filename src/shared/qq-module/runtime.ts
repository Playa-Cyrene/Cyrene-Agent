import { validateMediaBeginUpload, validateMediaWrite, validateMediaRead, validateMediaRelease, validateMediaChunk, type QqMediaBeginUpload, type QqMediaWrite, type QqMediaRead, type QqMediaRelease, type QqMediaChunk } from "./media";
import type { QqApiSupport, QqApiVersion, QqCapabilitySnapshot, QqInboundMessageV1, QqSendRequestV1, QqSendResultV1 } from "./types";
import { isBoundedJson, strictObject, validateCapabilitySnapshot, validateInboundMessage, validateSendRequest, validateSendResult } from "./validation";
import { validateApiSupport } from "./version";

/** Same-machine bounded operation budget, including module queue time. */
export const QQ_RUNTIME_TIMEOUTS = Object.freeze({ controlMs: 5000, sendBudgetMs: 120000, sendResponseMs: 130000 });

/** Candidate 1.0 process protocol. Not a manifest, package trust check or plugin API. */
export interface QqRuntimeConfig {
  configRevision: number;
  listen: { host: string; port: number };
  expectedSelfId: string;
  allowedPrivateUserIds: string[];
  allowedGroupIds: string[];
  groupRequireMention: boolean;
}
export interface QqInitialize {
  config: QqRuntimeConfig;
  credentials: { accessToken: string };
  /** Trusted host opt-in only. Omission preserves text-only behavior with older hosts. */
  mediaTransfer?: "chunked-v1";
}
export type QqBackendStatus =
  | { phase: "waiting-backend" }
  | { phase: "running"; selfId: string; connectionEpoch: number };
export type QqInboundAck = { eventId: string; outcome: "accepted" | "rejected-policy" | "busy" | "stale-instance" | "unsupported" | "duplicate" };
export interface QqRequestPayloads {
  hello: Record<string, never>;
  initialize: QqInitialize;
  start: Record<string, never>;
  send: QqSendRequestV1;
  mediaBeginUpload: QqMediaBeginUpload;
  mediaWrite: QqMediaWrite;
  mediaRead: QqMediaRead;
  mediaRelease: QqMediaRelease;
  ackInbound: QqInboundAck;
  quiesce: Record<string, never>;
  stop: Record<string, never>;
  ping: Record<string, never>;
}
export interface QqResponsePayloads {
  hello: { moduleId: "qfca"; moduleVersion: string; apiSupport: QqApiSupport };
  initialize: { capabilities: QqCapabilitySnapshot };
  start: QqBackendStatus;
  send: QqSendResultV1;
  mediaBeginUpload: { mediaId: string };
  mediaWrite: Record<string, never>;
  mediaRead: QqMediaChunk;
  mediaRelease: Record<string, never>;
  ackInbound: Record<string, never>;
  quiesce: Record<string, never>;
  stop: Record<string, never>;
  ping: Record<string, never>;
}
export interface QqEventPayloads { status: QqBackendStatus; inbound: QqInboundMessageV1; "capability-changed": QqCapabilitySnapshot }
export type QqMethod = keyof QqRequestPayloads;
export type QqRuntimeErrorCode = "invalid-request" | "incompatible" | "not-initialized" | "not-running" | "account-mismatch" | "internal" | "unsupported" | "busy";
interface EnvelopeIdentity { apiVersion: QqApiVersion; instanceId: string; runtimeEpoch: number }
export type QqRequest = { [K in QqMethod]: EnvelopeIdentity & { kind: "request"; requestId: string; method: K; payload: QqRequestPayloads[K] } }[QqMethod];
export type QqResponse = EnvelopeIdentity & { kind: "response"; responseTo: string } & ({ ok: true; payload: unknown } | { ok: false; error: { code: QqRuntimeErrorCode } });
export type QqEvent = { [K in keyof QqEventPayloads]: EnvelopeIdentity & { kind: "event"; event: K; payload: QqEventPayloads[K] } }[keyof QqEventPayloads];
export type QqEnvelope = QqRequest | QqResponse | QqEvent;

const id = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const integer = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const empty = (v: unknown): boolean => strictObject(v, {});
const bool = (v: unknown): boolean => typeof v === "boolean";
const ids = (v: unknown): boolean => Array.isArray(v) && v.length <= 1024 && v.every(id) && new Set(v).size === v.length;
export function validateRuntimeConfig(v: unknown): v is QqRuntimeConfig {
  return isBoundedJson(v) && strictObject(v, {
    configRevision: integer, expectedSelfId: id, allowedPrivateUserIds: ids, allowedGroupIds: ids, groupRequireMention: bool,
    listen: (x) => strictObject(x, {
      host: (h) => typeof h === "string" && h.length > 0 && h.length <= 253 && !/[\s/\\@?#]/.test(h),
      port: (p) => integer(p) && (p as number) > 0 && (p as number) <= 65535,
    }),
  });
}
export function validateBackendStatus(v: unknown): v is QqBackendStatus {
  return strictObject(v, { phase: (p) => p === "waiting-backend" }) || strictObject(v, { phase: (p) => p === "running", selfId: id, connectionEpoch: integer });
}
export function validateRequestPayload(method: QqMethod, v: unknown): boolean {
  if (!isBoundedJson(v)) return false;
  switch (method) {
    case "initialize": return strictObject(v, { config: validateRuntimeConfig, credentials: (c) => strictObject(c, { accessToken: (s) => typeof s === "string" && s.length <= 4096 }) }, { mediaTransfer: (m) => m === "chunked-v1" });
    case "send": return validateSendRequest(v);
    case "mediaBeginUpload": return validateMediaBeginUpload(v);
    case "mediaWrite": return validateMediaWrite(v);
    case "mediaRead": return validateMediaRead(v);
    case "mediaRelease": return validateMediaRelease(v);
    case "ackInbound": return strictObject(v, { eventId: id, outcome: (o) => ["accepted", "rejected-policy", "busy", "stale-instance", "unsupported", "duplicate"].includes(o as string) });
    default: return empty(v);
  }
}
export function validateResponsePayload(method: QqMethod, v: unknown, request?: unknown): boolean {
  if (!isBoundedJson(v)) return false;
  switch (method) {
    case "hello": return strictObject(v, { moduleId: (id) => id === "qfca", moduleVersion: (s) => typeof s === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(s) && s.length <= 64, apiSupport: validateApiSupport });
    case "initialize": return strictObject(v, { capabilities: validateCapabilitySnapshot });
    case "start": return validateBackendStatus(v);
    case "send": return validateSendResult(v, request as QqSendRequestV1);
    case "mediaBeginUpload": return strictObject(v, { mediaId: id });
    case "mediaRead": return validateMediaChunk(v, request as QqMediaRead);
    default: return empty(v);
  }
}
const methods = ["hello", "initialize", "start", "send", "mediaBeginUpload", "mediaWrite", "mediaRead", "mediaRelease", "ackInbound", "quiesce", "stop", "ping"];
const identity = {
  apiVersion: (v: unknown) => strictObject(v, { major: (n) => n === 1, minor: (n) => n === 0 }),
  instanceId: id, runtimeEpoch: integer,
};
/** Response payload is checked against its pending request separately. */
export function validateEnvelope(v: unknown): v is QqEnvelope {
  if (!isBoundedJson(v) || v === null || typeof v !== "object") return false;
  const value = v as Record<string, unknown>;
  if (value.kind === "request") return strictObject(v, { ...identity, kind: (k) => k === "request", requestId: id, method: (m) => methods.includes(m as string), payload: () => true }) && validateRequestPayload(value.method as QqMethod, value.payload);
  if (value.kind === "response") return value.ok === true
    ? strictObject(v, { ...identity, kind: (k) => k === "response", responseTo: id, ok: (o) => o === true, payload: () => true })
    : strictObject(v, { ...identity, kind: (k) => k === "response", responseTo: id, ok: (o) => o === false, error: (e) => strictObject(e, { code: (c) => ["invalid-request", "incompatible", "not-initialized", "not-running", "account-mismatch", "internal", "unsupported", "busy"].includes(c as string) }) });
  if (value.kind !== "event") return false;
  return strictObject(v, { ...identity, kind: (k) => k === "event", event: (e) => ["status", "inbound", "capability-changed"].includes(e as string), payload: () => true })
    && (value.event === "inbound" ? validateInboundMessage(value.payload) : value.event === "status" ? validateBackendStatus(value.payload) : validateCapabilitySnapshot(value.payload));
}
