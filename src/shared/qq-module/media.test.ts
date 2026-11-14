import { describe, expect, it } from "vitest";
import { QQ_MEDIA_LIMITS, isQqMediaBase64, validateMediaBeginUpload, validateMediaChunk, validateMediaRead, validateMediaRelease, validateMediaWrite } from "./media";
import { validateEnvelope, validateRequestPayload, validateResponsePayload } from "./runtime";
const begin = { connectionEpoch: 1, operationId: "operation", conversation: { type: "private", peerId: "30000" }, media: { kind: "image", size: 3, filename: "photo.png", mime: "image/png" }, sha256: "a".repeat(64) };
const write = { connectionEpoch: 1, mediaId: "media", offset: 0, data: "YWJj" };
const read = { connectionEpoch: 1, mediaId: "media", eventId: "event", offset: 0, limit: 3 };
const release = { connectionEpoch: 1, mediaId: "media" };
describe("QQ bounded media transport contract", () => {
  it("requires a recognized explicit media transport and keeps omitted initialize compatible", () => {
    const initialize = { config: { configRevision: 1, listen: { host: "127.0.0.1", port: 12345 }, expectedSelfId: "10000", allowedPrivateUserIds: [], allowedGroupIds: [], groupRequireMention: true }, credentials: { accessToken: "fake-token" } };
    expect(validateRequestPayload("initialize", initialize)).toBe(true);
    expect(validateRequestPayload("initialize", { ...initialize, mediaTransfer: "chunked-v1" })).toBe(true);
    expect(validateRequestPayload("initialize", { ...initialize, mediaTransfer: "raw-paths" })).toBe(false);
    expect(validateRequestPayload("initialize", { ...initialize, mediaTransfer: true })).toBe(false);
  });
  it("round trips bounded media without host or backend paths", () => {
    for (const [method, payload] of [["mediaBeginUpload", begin], ["mediaWrite", write], ["mediaRead", read], ["mediaRelease", release]] as const) {
      expect(validateRequestPayload(method, payload)).toBe(true);
      expect(validateEnvelope({ kind: "request", apiVersion: { major: 1, minor: 0 }, instanceId: "instance", runtimeEpoch: 1, requestId: method, method, payload })).toBe(true);
    }
    expect(validateResponsePayload("mediaBeginUpload", { mediaId: "opaque-id" }, begin)).toBe(true);
    expect(validateResponsePayload("mediaWrite", {})).toBe(true);
    expect(validateResponsePayload("mediaRelease", {})).toBe(true);
    expect(validateResponsePayload("mediaRead", { data: "YWJj", eof: true }, read)).toBe(true);
  });
  it.each([
    { ...begin, path: "/private/file" }, { ...begin, connectionEpoch: -1 }, { ...begin, sha256: "A".repeat(64) },
    { ...begin, sha256: "a".repeat(63) }, { ...begin, operationId: "../operation" },
    { ...begin, conversation: { type: "private", peerId: "https://host" } },
    { ...begin, media: { ...begin.media, mediaId: "chosen-by-host" } },
    { ...begin, media: { ...begin.media, filePath: "/host/file" } },
    { ...begin, media: { ...begin.media, url: "https://host" } },
    { ...begin, media: { ...begin.media, size: 0 } }, { ...begin, media: { ...begin.media, size: QQ_MEDIA_LIMITS.maxFileBytes + 1 } },
    { ...begin, media: { ...begin.media, size: 1.5 } }, { ...begin, media: { ...begin.media, filename: "../host" } },
    { ...begin, media: { ...begin.media, filename: "C:\\host" } }, { ...begin, media: { ...begin.media, mime: "image/png\r\nX: y" } },
  ])("rejects malformed upload metadata: %j", (value) => expect(validateMediaBeginUpload(value)).toBe(false));
  it("permits the advertised maximum size and Unicode safe basename", () => {
    expect(validateMediaBeginUpload({ ...begin, media: { ...begin.media, size: QQ_MEDIA_LIMITS.maxFileBytes, filename: "图片.png" } })).toBe(true);
  });
  it.each(["YQ", "YR==", "YWJ=", "YQ===", " YQ==", "YQ==\n", "YQ--", "YQ__", "YWJj!", "YWJj===="])("rejects noncanonical base64 %j", (data) => {
    expect(isQqMediaBase64(data)).toBe(false);
    expect(validateMediaWrite({ ...write, data })).toBe(false);
  });
  it.each(["", "YQ==", "YWI=", "YWJj", Buffer.alloc(QQ_MEDIA_LIMITS.chunkBytes).toString("base64")])("checks canonical base64 boundaries", (data) => expect(isQqMediaBase64(data)).toBe(true));
  it("limits decoded bytes, not only encoded string length", () => {
    const data = Buffer.alloc(QQ_MEDIA_LIMITS.chunkBytes + 1).toString("base64");
    expect(isQqMediaBase64(data)).toBe(false);
    expect(validateMediaWrite({ ...write, data: "" })).toBe(false);
    expect(validateMediaWrite({ ...write, data: new Uint8Array([1]) })).toBe(false);
    expect(validateMediaWrite({ ...write, offset: QQ_MEDIA_LIMITS.maxFileBytes + 1 })).toBe(false);
    expect(validateMediaWrite({ ...write, offset: -1 })).toBe(false);
  });
  it("requires scoped read requests and bounded requested chunks", () => {
    expect(validateMediaRead({ ...read, eventId: undefined })).toBe(false);
    expect(validateMediaRead({ ...read, eventId: "../other" })).toBe(false);
    expect(validateMediaRead({ ...read, limit: 0 })).toBe(false);
    expect(validateMediaRead({ ...read, limit: QQ_MEDIA_LIMITS.chunkBytes + 1 })).toBe(false);
    expect(validateMediaRead({ ...read, path: "/etc/passwd" })).toBe(false);
    expect(validateMediaRelease({ ...release, mediaId: "/etc/passwd" })).toBe(false);
    expect(validateMediaRelease({ ...release, connectionEpoch: Infinity })).toBe(false);
  });
  it("correlates response size and rejects a zero-progress nonterminal chunk", () => {
    expect(validateMediaChunk({ data: "", eof: false }, read)).toBe(false);
    expect(validateMediaChunk({ data: "", eof: true }, read)).toBe(true);
    expect(validateMediaChunk({ data: "YWJj", eof: false }, { ...read, limit: 2 })).toBe(false);
    expect(validateMediaChunk({ data: "YWJj", eof: true, path: "/backend/file" }, read)).toBe(false);
    expect(validateResponsePayload("mediaBeginUpload", { mediaId: "file:///host" })).toBe(false);
    expect(validateResponsePayload("mediaWrite", { accepted: true })).toBe(false);
  });
  it("rejects accessors and non-JSON input before traversing metadata", () => {
    let called = false;
    expect(validateMediaBeginUpload({ ...begin, get media() { called = true; return begin.media; } })).toBe(false);
    expect(called).toBe(false);
  });
});
