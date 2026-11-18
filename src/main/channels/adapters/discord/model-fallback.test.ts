import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeError,
  classifyModelRetry,
  RetryableModelRunError,
} from "../../../orchestrator/agent-runtime-error";
import { runDiscordChatWithFallback } from "./model-fallback";

describe("Discord model fallback", () => {
  it("recognizes quota and transient errors without forwarding provider details", () => {
    const providerError = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "failed", {
      cause: Object.assign(new Error("private response body"), { status: 429 }),
    });
    expect(classifyModelRetry(providerError)).toBe("quota");
    expect(classifyModelRetry(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "HTTP 503"))).toBe("transient");
    expect(classifyModelRetry(new AgentRuntimeError("E_MODEL_HTTP_ERROR", "HTTP 403"))).toBeUndefined();
  });

  it("switches to the alternate saved profile when the primary runs out of quota", async () => {
    const run = vi.fn().mockRejectedValueOnce(new RetryableModelRunError("failed", "quota")).mockResolvedValueOnce("ok");
    await expect(runDiscordChatWithFallback(run, "primary", "backup")).resolves.toBe("ok");
    expect(run.mock.calls).toEqual([["primary"], ["backup"]]);
  });

  it("retries a transient failure on the same profile before any quota fallback", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new RetryableModelRunError("failed", "transient"))
      .mockRejectedValueOnce(new RetryableModelRunError("failed", "quota"))
      .mockResolvedValueOnce("ok");
    await expect(runDiscordChatWithFallback(run, "primary", "backup")).resolves.toBe("ok");
    expect(run.mock.calls).toEqual([["primary"], ["primary"], ["backup"]]);
  });

  it("makes only one attempt when fallback is unavailable", async () => {
    const error = new RetryableModelRunError("failed", "quota");
    const run = vi.fn().mockRejectedValue(error);
    await expect(runDiscordChatWithFallback(run, "primary")).rejects.toBe(error);
    expect(run.mock.calls).toEqual([["primary"]]);
  });
});
