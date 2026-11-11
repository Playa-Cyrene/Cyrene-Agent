import { describe, expect, it } from "vitest";
import { validateEnvelope, validateRequestPayload, validateRuntimeConfig } from "./runtime";
const config = { configRevision: 1, listen: { host: "127.0.0.1", port: 30001 }, expectedSelfId: "10000", allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true };
const request = { apiVersion: { major: 1, minor: 0 }, instanceId: "instance-1", runtimeEpoch: 1, kind: "request", requestId: "request-1", method: "initialize", payload: { config, credentials: { accessToken: "test-token" } } };
describe("QQ versioned process envelopes", () => {
  it("round trips explicit configuration and credentials only inside initialize", () => {
    expect(validateEnvelope(JSON.parse(JSON.stringify(request)))).toBe(true);
    expect(validateRequestPayload("hello", { accessToken: "secret" })).toBe(false);
    expect(validateRequestPayload("ping", { arbitraryAction: "delete_msg" })).toBe(false);
    expect(validateRequestPayload("ackInbound", { eventId: "1", outcome: "accepted" })).toBe(true);
  });
  it.each([
    { ...request, apiVersion: { major: 2, minor: 0 } }, { ...request, apiVersion: { major: 1, minor: 1 } },
    { ...request, instanceId: "../host" }, { ...request, runtimeEpoch: -1 }, { ...request, method: "executeAction" },
    { ...request, permissionMode: "full" }, { ...request, responseTo: "mixed-envelope" },
    { ...request, payload: { ...request.payload, userData: "/private" } },
    { ...request, payload: { ...request.payload, config: { ...config, trusted: true } } },
    { ...request, payload: { ...request.payload, credentials: { accessToken: "x", password: "y" } } },
    { ...request, payload: { ...request.payload, credentials: { accessToken: "x".repeat(4097) } } },
  ])("rejects incompatible, unknown, unauthorized and oversized fields", (value) => expect(validateEnvelope(value)).toBe(false));
  it.each([
    { ...config, expectedSelfId: "" }, { ...config, allowedGroupIds: ["1", "1"] }, { ...config, allowedPrivateUserIds: new Array(1025).fill("1") },
    { ...config, groupRequireMention: undefined }, { ...config, listen: { host: "http://example.com", port: 30001 } },
    { ...config, listen: { host: "127.0.0.1", port: 0 } }, { ...config, listen: { host: "127.0.0.1", port: 65536 } },
  ])("rejects unsafe config: %j", (value) => expect(validateRuntimeConfig(value)).toBe(false));
  it("accepts stable error codes and rejects freeform leaked diagnostics", () => {
    const identity = { apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: 1, kind: "response", responseTo: "request-1", ok: false };
    expect(validateEnvelope({ ...identity, error: { code: "account-mismatch" } })).toBe(true);
    expect(validateEnvelope({ ...identity, error: { code: "internal", message: "token=secret" } })).toBe(false);
    expect(validateEnvelope({ ...identity, error: { code: "arbitrary" } })).toBe(false);
  });
});
