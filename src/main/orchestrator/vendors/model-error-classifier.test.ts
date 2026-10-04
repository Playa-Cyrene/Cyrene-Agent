import { describe, expect, it } from "vitest";
import { classifyModelFailure } from "./model-error-classifier";
import { isModelFailureInfo } from "../../../shared/model-error";

describe("model failure diagnostics", () => {
  it("classifies HTTP 403 even for an unknown provider and retains the SDK requestID", () => {
    const failure = classifyModelFailure({ provider: "unknown", model: "m", error: {
      status: 403, requestID: "req-diagnostic-1", error: { message: "Permission denied", code: "forbidden", type: "permission_error" },
    } });
    expect(failure).toMatchObject({ category: "PERMISSION", retryable: false, status: 403,
      requestId: "req-diagnostic-1", vendorCode: "forbidden", providerMessage: "Permission denied" });
    expect(isModelFailureInfo(failure)).toBe(true);
  });

  it.each([
    ["subscription_sharing_usage_limit_exceeded", 429, "QUOTA", false],
    ["subscription_sharing_usage_unavailable", 503, "UNAVAILABLE", true],
    ["subscription_sharing_user_not_eligible", 403, "PERMISSION", false],
    ["subscription_sharing_invalid_user", 401, "AUTH", false],
    ["chatpass_v2_scope_not_authorized", 403, "PERMISSION", false],
    ["subscription_sharing_unsupported_capability", 400, "INVALID_REQUEST", false],
  ])("maps the structured subscription code %s", (code, status, category, retryable) => {
    expect(classifyModelFailure({ provider: "chatgpt", model: "m", error: { status, error: { code } } }))
      .toMatchObject({ category, retryable, vendorCode: code, status });
  });

  it("redacts credentials and personal information while retaining a bounded error explanation", () => {
    const failure = classifyModelFailure({ provider: "chatgpt", model: "m", error: {
      detail: "Denied Bearer secret-token-value sk-privatekey account_id: account-private, email test@example.com cookie: session-secret\n" + "x".repeat(2000), status: 403,
    } });
    expect(failure.providerMessage).not.toMatch(/secret-token-value|sk-privatekey|account-private|test@example.com|session-secret/);
    expect(failure.providerMessage?.length).toBeLessThanOrEqual(1000);
    expect(failure.providerMessage).toContain("Denied");
  });

  it("does not show HTML challenges or treat an unrelated response ID as a request ID", () => {
    const failure = classifyModelFailure({ provider: "unknown", model: "m", error: { status: 403, id: "acct-private", message: "<!doctype html><script>private</script>" } });
    expect(failure.providerMessage).toBeUndefined();
    expect(failure.requestId).toBeUndefined();
    expect(failure.category).toBe("PERMISSION");
  });
});
