import { describe, expect, it, vi } from "vitest";
import { QQ_API_SUPPORT, QQ_CONTRACT_LIMITS, negotiateQqApi, validateInboundMessage, validateSendRequest, validateSendResult, validateCapabilitySnapshot } from "./index";
import type { QqInboundMessageV1, QqSendRequestV1 } from "./index";
import { isBoundedJson } from "./validation";

const inbound = (): QqInboundMessageV1 => ({
  eventId: "event-1", backendMessageId: "-124", selfId: "10000", connectionEpoch: 1, configRevision: 2,
  conversation: { type: "group", groupId: "20000" }, senderId: "30000", senderName: "昵称", timestampMs: 1700000000000,
  text: "@小助手 看图片", mentions: [{ userId: "10000", name: "小助手" }],
  reply: { messageId: "-123", senderId: "30000", senderName: "昵称", text: "上一条" },
  attachments: [{ kind: "image", mediaId: "media_abc-123", mime: "image/png", filename: "图片.png", size: 42 }],
});
const outbound = (): QqSendRequestV1 => ({
  operationId: "send-1", runtimeEpoch: 1, selfId: "10000", conversation: { type: "group", groupId: "20000" },
  parts: [{ kind: "text", text: "回复" }, { kind: "image", mediaId: "media-image" }],
  replyContext: { messageId: "-124", mentionUserId: "30000" },
});

describe("QQ dedicated contract candidate", () => {
  it("round trips mentions, one-level reply and opaque media as JSON", () => {
    const message = JSON.parse(JSON.stringify(inbound()));
    expect(validateInboundMessage(message)).toBe(true);
    expect(message).toEqual(inbound());
    expect(validateSendRequest(JSON.parse(JSON.stringify(outbound())))).toBe(true);
    expect(validateInboundMessage({ ...inbound(), conversation: { type: "private", peerId: "30000" } })).toBe(true);
  });
  it.each([{}, { peerId: "30000" }, { type: "group", peerId: "30000" }, { type: "private", peerId: "30000", groupId: "20000" }, { type: "channel", groupId: "20000" }])("never defaults malformed conversation to private: %j", (conversation) => {
    expect(validateInboundMessage({ ...inbound(), conversation })).toBe(false);
    expect(validateSendRequest({ ...outbound(), conversation })).toBe(false);
  });
  it.each(["channel", "permissionMode", "trusted", "sessionId", "conversationId", "workspaceBindingSessionId", "filePath", "_raw", "__proto__"])("rejects unauthorized field %s rather than stripping it", (field) => {
    expect(validateInboundMessage({ ...inbound(), [field]: "qq" })).toBe(false);
    expect(validateSendRequest({ ...outbound(), [field]: "qq" })).toBe(false);
  });
  it("rejects nested authorization and expanded replies", () => {
    expect(validateInboundMessage({ ...inbound(), mentions: [{ userId: "10000", isBot: true }] })).toBe(false);
    expect(validateInboundMessage({ ...inbound(), reply: { messageId: "1", reply: { messageId: "2" } } })).toBe(false);
    expect(validateSendRequest({ ...outbound(), replyContext: { messageId: "1", trusted: true } })).toBe(false);
  });
  it.each(["/etc/passwd", "../../secret", "C:\\Users\\secret", "file:///tmp/a", "https://host/a", "\\\\server\\share"])("does not accept a media path or URL: %s", (mediaId) => {
    expect(validateInboundMessage({ ...inbound(), attachments: [{ kind: "file", mediaId }] })).toBe(false);
    expect(validateSendRequest({ ...outbound(), parts: [{ kind: "file", mediaId }] })).toBe(false);
  });
  it("rejects path fields and unsafe filenames even beside a valid handle", () => {
    for (const extra of [{ filePath: "/etc/passwd" }, { imagePath: "secret" }, { url: "http://localhost" }, { filename: "../secret" }, { filename: "C:secret" }]) {
      expect(validateSendRequest({ ...outbound(), parts: [{ kind: "file", mediaId: "valid", ...extra }] })).toBe(false);
    }
  });
  it("rejects objects that cannot faithfully cross a JSON boundary", () => {
    const accessor = { ...inbound() };
    Object.defineProperty(accessor, "text", { enumerable: true, get: () => { throw new Error("must not execute"); } });
    const cyclic: Record<string, unknown> = { ...inbound() }; cyclic.reply = cyclic;
    const hidden = { ...inbound() }; Object.defineProperty(hidden, "secret", { value: "hidden" });
    const symbolic = { ...inbound(), [Symbol("secret")]: "hidden" };
    for (const value of [accessor, cyclic, hidden, symbolic, { ...inbound(), timestampMs: new Date() }, { ...inbound(), timestampMs: NaN }, { ...inbound(), timestampMs: Infinity }, { ...inbound(), senderName: undefined }, { ...inbound(), mentions: new Array(1) }, Object.assign(Object.create({ trusted: true }), inbound())]) {
      expect(validateInboundMessage(value)).toBe(false);
    }
  });
  it.each(["4294967295", "4294967296", "9007199254740993", "9".repeat(40)])("rejects sparse arrays disguised by numeric property %s", (key) => {
    const sparse = Object.assign(new Array(1), { [key]: {} });
    expect(JSON.stringify(sparse)).toBe("[null]");
    expect(isBoundedJson(sparse)).toBe(false);
    expect(validateInboundMessage({ ...inbound(), mentions: sparse })).toBe(false);
    expect(validateInboundMessage({ ...inbound(), attachments: sparse })).toBe(false);
    expect(validateSendRequest({ ...outbound(), parts: sparse })).toBe(false);
    expect(validateSendRequest({ ...outbound(), parts: [{ kind: "card", title: "title", fields: sparse }] })).toBe(false);
    expect(validateSendResult({ operationId: "send-1", outcome: "sent", parts: sparse })).toBe(false);
  });
  it("preserves dense arrays, empty optional arrays and traversal bounds", () => {
    expect(isBoundedJson([null, { nested: [1, true, "ok"] }, []])).toBe(true);
    expect(validateInboundMessage({ ...inbound(), mentions: [], attachments: [] })).toBe(true);
    expect(validateSendRequest({ ...outbound(), parts: [{ kind: "card", title: "title", fields: [] }] })).toBe(true);
    expect(isBoundedJson(Array(9999).fill(null))).toBe(true);
    expect(isBoundedJson(Array(10000).fill(null))).toBe(false);
    expect(isBoundedJson(new Array(4294967295))).toBe(false);
  });
  it("enforces bounds including aggregate UTF-8 size", () => {
    expect(validateInboundMessage({ ...inbound(), text: "a".repeat(QQ_CONTRACT_LIMITS.maxTextLength) })).toBe(true);
    expect(validateInboundMessage({ ...inbound(), text: "a".repeat(QQ_CONTRACT_LIMITS.maxTextLength + 1) })).toBe(false);
    expect(validateInboundMessage({ ...inbound(), mentions: Array(65).fill({ userId: "1" }) })).toBe(false);
    expect(validateInboundMessage({ ...inbound(), attachments: Array(17).fill({ kind: "file", mediaId: "x" }) })).toBe(false);
    expect(validateSendRequest({ ...outbound(), parts: Array(65).fill({ kind: "text", text: "x" }) })).toBe(false);
    expect(validateSendRequest({ ...outbound(), parts: Array(8).fill({ kind: "text", text: "图".repeat(32000) }) })).toBe(false);
    expect(validateSendRequest({ ...outbound(), parts: [{ kind: "file", mediaId: "x", size: QQ_CONTRACT_LIMITS.maxMediaBytes + 1 }] })).toBe(false);
    expect(validateInboundMessage({ ...inbound(), connectionEpoch: -1 })).toBe(false);
    expect(validateInboundMessage({ ...inbound(), configRevision: 1.5 })).toBe(false);
  });
  it("rejects aggregate oversized objects before allocating serialized JSON", () => {
    const message = {
      ...inbound(),
      attachments: Array.from({ length: 16 }, () => ({
        kind: "image", mediaId: "handle", caption: "a".repeat(QQ_CONTRACT_LIMITS.maxTextLength),
      })),
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(validateInboundMessage(message)).toBe(false);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
  it("accepts all specified outbound part variants without internal paths", () => {
    expect(validateSendRequest({ ...outbound(), parts: [
      { kind: "text", text: "hello" }, ...["image", "audio", "file", "video", "sticker"].map((kind) => ({ kind, mediaId: "handle" })),
      { kind: "card", title: "title", markdown: "body", fields: [{ key: "k", value: "v" }] },
    ] })).toBe(true);
  });
});

describe("API major/minor negotiation", () => {
  it("negotiates a highest shared minor without claiming package compatibility", () => {
    expect(negotiateQqApi(QQ_API_SUPPORT, QQ_API_SUPPORT)).toEqual({ ok: true, version: { major: 1, minor: 0 } });
    expect(negotiateQqApi({ major: 1, minMinor: 1, maxMinor: 4 }, { major: 1, minMinor: 2, maxMinor: 3 })).toEqual({ ok: true, version: { major: 1, minor: 3 } });
    expect(negotiateQqApi(QQ_API_SUPPORT, { major: 2, minMinor: 0, maxMinor: 0 })).toEqual({ ok: false, reason: "major-mismatch" });
    expect(negotiateQqApi(QQ_API_SUPPORT, { major: 1, minMinor: 1, maxMinor: 2 })).toEqual({ ok: false, reason: "minor-mismatch" });
  });
  it.each([null, "1.0", {}, { major: 1, maxMinor: 0 }, { major: "1", minMinor: 0, maxMinor: 0 }, { major: 0, minMinor: 0, maxMinor: 0 }, { major: 1, minMinor: 2, maxMinor: 1 }, { major: 1, minMinor: -1, maxMinor: 0 }, { major: 1, minMinor: 0, maxMinor: Infinity }, { major: 1, minMinor: 0, maxMinor: 0, trusted: true }])("fails closed on malformed support: %j", (value) => {
    expect(negotiateQqApi(QQ_API_SUPPORT, value)).toEqual({ ok: false, reason: "malformed" });
    expect(negotiateQqApi(value, QQ_API_SUPPORT)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("send results", () => {
  const sent = { partIndex: 0, outcome: "sent", messageId: "123" };
  it.each([
    ["sent", [sent, { ...sent, partIndex: 1 }]],
    ["partial", [sent, { partIndex: 1, outcome: "failed", errorCode: "rejected" }]],
    ["failed", [{ partIndex: 0, outcome: "failed", errorCode: "unsupported" }, { partIndex: 1, outcome: "failed", errorCode: "rejected" }]],
    ["unknown", [sent, { partIndex: 1, outcome: "unknown", errorCode: "timeout" }]],
  ])("validates %s and exact request correlation", (outcome, parts) => {
    const result = { operationId: "send-1", outcome, parts };
    expect(validateSendResult(JSON.parse(JSON.stringify(result)), outbound())).toBe(true);
  });
  it("rejects false success, missing/duplicate indices and leaked diagnostics", () => {
    for (const result of [
      { operationId: "send-1", outcome: "sent", parts: [sent, { partIndex: 1, outcome: "unknown", errorCode: "timeout" }] },
      { operationId: "send-1", outcome: "sent", parts: [sent, sent] },
      { operationId: "send-1", outcome: "sent", parts: [sent] },
      { operationId: "different", outcome: "sent", parts: [sent, { ...sent, partIndex: 1 }] },
      { operationId: "send-1", outcome: "failed", parts: [{ partIndex: 0, outcome: "failed", errorCode: "arbitrary", stack: "secret" }] },
      { operationId: "send-1", outcome: "unknown", parts: [] },
    ]) expect(validateSendResult(result, outbound())).toBe(false);
  });
});

describe("capability declarations", () => {
  const snapshot = {
    messages: { text: true, image: true, audio: false, file: true, video: false, markdown: false, card: false,
      sticker: true, reply: true, mention: true, maxTextLength: 4096, maxFileBytes: 1024 * 1024 },
    backend: { napcatStream: false },
  };
  it("round trips explicit message and backend capabilities", () => {
    expect(validateCapabilitySnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
  });
  it("rejects permission claims, unknown methods, missing flags and malformed limits", () => {
    for (const messages of [
      { ...snapshot.messages, trusted: true }, { ...snapshot.messages, tools: true },
      { ...snapshot.messages, text: "true" }, { ...snapshot.messages, reply: undefined },
      { ...snapshot.messages, maxTextLength: -1 }, { ...snapshot.messages, maxFileBytes: Infinity },
      { ...snapshot.messages, maxFileBytes: QQ_CONTRACT_LIMITS.maxMediaBytes + 1 },
    ]) expect(validateCapabilitySnapshot({ ...snapshot, messages })).toBe(false);
    expect(validateCapabilitySnapshot({ ...snapshot, backend: { napcatStream: true, executeAction: true } })).toBe(false);
    expect(validateCapabilitySnapshot({ ...snapshot, permissionMode: "full" })).toBe(false);
    expect(validateCapabilitySnapshot({ messages: snapshot.messages })).toBe(false);
  });
});
