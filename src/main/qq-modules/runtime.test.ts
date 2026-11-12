import { describe, expect, it } from "vitest";
import { QQ_CONTRACT_LIMITS, validateSendRequest, type QqSendRequestV1 } from "../../shared/qq-module";
import { QqModuleRuntime } from "./runtime";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";

describe("QQ private process RPC", () => {
  it("matches replies, ignores stale epochs and duplicate terminal replies", async () => {
    const peer = new FakeTransport(); peer.behavior = () => {};
    const runtime = new QqModuleRuntime(peer, 7, 100);
    const result = runtime.request("ping", {});
    const req = peer.messages[0];
    peer.emit({ ...req, kind: "response", responseTo: req.requestId, requestId: undefined });
    // Malformed frames fail closed, including undefined rather than absent fields.
    await expect(result).rejects.toMatchObject({ code: "protocol", transmitted: true });
    expect(peer.killed).toBe(true);
    const fresh = new FakeTransport(); fresh.behavior = () => {};
    const next = new QqModuleRuntime(fresh, 8);
    const promise = next.request("ping", {}); const request = fresh.messages[0];
    const response = { apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: 7, kind: "response", responseTo: request.requestId, ok: true, payload: {} };
    fresh.emit(response); expect(next.pendingCount).toBe(1);
    fresh.emit({ ...response, runtimeEpoch: 8 });
    await expect(promise).resolves.toEqual({});
    fresh.emit({ ...response, runtimeEpoch: 8 }); expect(next.isClosed).toBe(false);
    await next.close(); expect(fresh.listeners.size).toBe(0); expect(fresh.exits.size).toBe(0);
  });
  it("settles timeout, cancellation, crash and all pending requests without retries", async () => {
    const peer = new FakeTransport(); peer.behavior = () => {};
    const runtime = new QqModuleRuntime(peer, 1, 10);
    await expect(runtime.request("ping", {})).rejects.toMatchObject({ code: "timeout", transmitted: true });
    const controller = new AbortController();
    const cancelled = runtime.request("ping", {}, controller.signal); controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled", transmitted: true });
    await expect(runtime.request("ping", {}, controller.signal)).rejects.toMatchObject({ code: "cancelled", transmitted: false });
    const pending = runtime.request("ping", {}); peer.crash();
    await expect(pending).rejects.toMatchObject({ code: "closed", transmitted: true });
    expect(runtime.pendingCount).toBe(0); expect(peer.messages).toHaveLength(3);
  });
  it("bounds concurrent RPC and rejects incompatible or unknown frames", async () => {
    const peer = new FakeTransport(); peer.behavior = () => {};
    const runtime = new QqModuleRuntime(peer, 1);
    const promises = Array.from({ length: 64 }, () => runtime.request("ping", {}).catch((e) => e.code));
    await expect(runtime.request("ping", {})).rejects.toMatchObject({ code: "busy", transmitted: false });
    peer.event("unknown", {});
    expect(await Promise.all(promises)).toEqual(Array(64).fill("protocol"));
    expect(runtime.pendingCount).toBe(0);
  });
  it("rejects oversized complete envelopes before sending even when the payload alone fits", async () => {
    const peer = new FakeTransport(); const runtime = new QqModuleRuntime(peer, 1);
    const request: QqSendRequestV1 = { operationId: "op", runtimeEpoch: 1, connectionEpoch: 1, selfId: "10000", conversation: { type: "private", peerId: "30000" }, parts: Array.from({ length: 8 }, () => ({ kind: "text", text: "x".repeat(32768) })) };
    const excess = JSON.stringify(request).length - QQ_CONTRACT_LIMITS.maxJsonBytes + 1;
    request.parts[7] = { kind: "text", text: "x".repeat(32768 - excess) };
    expect(validateSendRequest(request)).toBe(true);
    await expect(runtime.request("send", request)).rejects.toMatchObject({ code: "protocol", transmitted: false });
    expect(peer.messages).toHaveLength(0); await runtime.close();
  });
  it("contains transport fatal errors and settles in-flight requests", async () => {
    const peer = new FakeTransport(); peer.behavior = () => {};
    let fatal = () => {};
    const runtime = new QqModuleRuntime(Object.assign(peer, { onError: (listener: () => void) => { fatal = listener; return () => { fatal = () => {}; }; } }), 1);
    const pending = runtime.request("ping", {}); fatal();
    await expect(pending).rejects.toMatchObject({ code: "closed", transmitted: true });
    await runtime.close(); expect(runtime.hasExited).toBe(true);
  });
  it("checks send result operation ID and exact part coverage", async () => {
    const peer = new FakeTransport(); peer.behavior = (req) => peer.reply(req, { operationId: "wrong", outcome: "sent", parts: [{ partIndex: 0, outcome: "sent" }] });
    const runtime = new QqModuleRuntime(peer, 1);
    await expect(runtime.request("send", { operationId: "op", runtimeEpoch: 1, connectionEpoch: 1, selfId: "10000", conversation: { type: "private", peerId: "30000" }, parts: [{ kind: "text", text: "x" }] })).rejects.toMatchObject({ code: "protocol" });
  });
});
