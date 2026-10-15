import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRetryStatus } from "../../../shared/model-retry";
import type { ChatMessage, ChatResponse, ChatVendorAdapter, VendorConfig } from "../vendors/types";
import { AgentRuntimeError } from "../agent-runtime-error";

const { fakeStreamChat, fakeRecordUsage, fakeRecordRequest, fakeGetAdapter } = vi.hoisted(() => ({
  fakeStreamChat: vi.fn(),
  fakeRecordUsage: vi.fn(),
  fakeRecordRequest: vi.fn(),
  fakeGetAdapter: vi.fn(),
}));

vi.mock("../vendors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vendors")>();
  return { ...actual, getAdapterForConfig: fakeGetAdapter, streamChatWithSdk: fakeStreamChat };
});
vi.mock("../../token-usage-store", () => ({ recordUsage: fakeRecordUsage, recordRequest: fakeRecordRequest }));

import { callLLM, summarizeHistory } from "./harness-llm";
import { DEFAULT_HARNESS_CONFIG } from "./types";

const vendorConfig: VendorConfig = {
  provider: "chatgpt", baseUrl: "https://example.test/v1", model: "m", apiKey: "key", explicitTransport: "openai",
};

function makeResponse(text = "done"): ChatResponse {
  return {
    assistantMessage: { role: "assistant", content: text }, text, toolCalls: [], finishReason: "stop", raw: {},
    usage: { input: 3, output: 2 },
  };
}

const adapter: ChatVendorAdapter = {
  id: "chatgpt",
  transport: "openai",
  capability: { id: "chatgpt", displayName: "OpenAI", transport: "openai", baseUrl: "https://example.test/v1", authStyle: "bearer", defaultModel: "m", supportsTools: true, supportsThinking: true, thinkingField: null, cacheStrategy: "none", testStrategy: "text" },
  buildRequest: (request) => ({ url: "https://example.test/v1/chat/completions", method: "POST", headers: {}, body: JSON.stringify(request) }),
  buildStreamRequest: (request) => ({ url: "https://example.test/v1/chat/completions", method: "POST", headers: {}, body: JSON.stringify(request) }),
  parseResponse: (raw) => makeResponse(typeof (raw as { text?: unknown })?.text === "string" ? String((raw as { text: string }).text) : "summary"),
  parseStreamEvent: () => null,
  appendToolResults: (messages) => messages,
  testConnection: async () => ({ ok: true, latency: 0 }),
} as unknown as ChatVendorAdapter;

const promptLayers = { stablePrefix: "system", runtimeContext: "", mode: "work" } as never;
const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
const harnessConfig = {
  ...DEFAULT_HARNESS_CONFIG,
  modelRequestMaxRetries: 1,
  modelRequestIdleTimeoutMs: 60_000,
};

function transientError() {
  return new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "服务暂时不可用", {
    modelFailure: { provider: "chatgpt", model: "m", category: "SERVER_ERROR", retryable: true },
    retryAfterMs: 0,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  fakeGetAdapter.mockReturnValue(adapter);
  globalThis.fetch = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("callLLM retries", () => {
  it("没有可见增量时，接收数据活动仍能保持 Harness 模型请求运行", async () => {
    vi.useFakeTimers();
    try {
      fakeStreamChat.mockImplementationOnce((input) => new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        input.signal.addEventListener("abort", onAbort, { once: true });
        setTimeout(() => input.onStreamActivity?.(), 40);
        setTimeout(() => input.onStreamActivity?.(), 80);
        setTimeout(() => {
          input.signal.removeEventListener("abort", onAbort);
          resolve(makeResponse("done"));
        }, 120);
      }));
      const outcome = callLLM(vendorConfig, promptLayers, messages, [], {
        ...harnessConfig, modelRequestIdleTimeoutMs: 100, modelRequestMaxRetries: 0,
      }).then((response) => ({ response }), (error) => ({ error }));

      await vi.advanceTimersByTimeAsync(130);
      expect(await outcome).toMatchObject({ response: { text: "done" } });
      expect(fakeRecordRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a MiniMax-style 529 even when its vendor code is classified as unknown", async () => {
    const minimax529 = new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "HTTP 529 server_error", {
      modelFailure: { provider: "minimax", model: "MiniMax-M3", category: "UNKNOWN", status: 529, vendorCode: "server_error" },
    });
    fakeStreamChat.mockRejectedValueOnce(Object.assign(minimax529, { retryAfterMs: 0 })).mockResolvedValueOnce(makeResponse("recovered"));

    await expect(callLLM({ ...vendorConfig, provider: "minimax", model: "MiniMax-M3" }, promptLayers, messages, [], harnessConfig))
      .resolves.toMatchObject({ text: "recovered" });
    expect(fakeStreamChat).toHaveBeenCalledTimes(2);
  });

  it("retries a zero-output server error and records usage only for the successful response", async () => {
    fakeStreamChat.mockRejectedValueOnce(transientError()).mockResolvedValueOnce(makeResponse("recovered"));
    const statuses: ModelRetryStatus[] = [];

    const result = await callLLM(vendorConfig, promptLayers, messages, [], harnessConfig, undefined, undefined, undefined, (status) => statuses.push(status));

    expect(result.text).toBe("recovered");
    expect(fakeStreamChat).toHaveBeenCalledTimes(2);
    expect(fakeRecordRequest).toHaveBeenCalledTimes(1);
    expect(fakeRecordUsage).toHaveBeenCalledTimes(1);
    expect(statuses.map((status) => status.phase)).toEqual(["waiting", "attempting", "cleared"]);
  });

  it("does not retry after a reasoning delta was delivered", async () => {
    fakeStreamChat.mockImplementationOnce(async (input) => {
      input.onDelta({ type: "reasoning_delta", delta: "thinking" });
      throw transientError();
    });

    await expect(callLLM(vendorConfig, promptLayers, messages, [], harnessConfig, undefined, undefined, undefined))
      .rejects.toThrow("服务暂时不可用");
    expect(fakeStreamChat).toHaveBeenCalledTimes(1);
    expect(fakeRecordRequest).not.toHaveBeenCalled();
  });

  it("falls back from unsupported streaming once, then retries directly as non-streaming", async () => {
    fakeStreamChat.mockRejectedValueOnce(Object.assign(new Error("streaming is not supported"), { status: 400 }));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await callLLM(vendorConfig, promptLayers, messages, [], harnessConfig);

    expect(result.text).toBe("recovered");
    expect(fakeStreamChat).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("summarizeHistory retries", () => {
  it("retries a zero-output 503 response", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const statuses: ModelRetryStatus[] = [];

    await expect(summarizeHistory(vendorConfig, "system", messages, [], undefined, {
      maxRetries: harnessConfig.modelRequestMaxRetries,
      idleTimeoutMs: harnessConfig.modelRequestIdleTimeoutMs,
      onStatus: (status) => statuses.push(status),
    }))
      .resolves.toBe("summary");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(statuses.map((status) => status.phase)).toEqual(["waiting", "attempting", "cleared"]);
  });

  it("retries an explicit quota business code under HTTP 429 within the configured budget", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":{"code":"organization_usage_limit_exceeded"}}', {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "0" },
    })) as unknown as typeof fetch;

    await expect(summarizeHistory(vendorConfig, "system", messages, [], undefined, {
      maxRetries: harnessConfig.modelRequestMaxRetries,
      idleTimeoutMs: harnessConfig.modelRequestIdleTimeoutMs,
    })).rejects.toThrow("HTTP 429");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
