import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  MemoryLlmTimeoutError,
  MemoryLlmHttpError,
  MemoryLlmProtocolError,
  MemoryLlmConfigurationError,
} from "./memory-llm-errors";

// ── Hoisted mock state ──
const mockConfig = vi.hoisted(() => ({
  value: { provider: "test", baseUrl: "https://test.api/v1", model: "test-model", apiKey: "sk-test" },
  requests: [] as Array<Record<string, unknown>>,
}));

// ── Mocks ──
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/test-user-data" },
}));

vi.mock("../runtime-policy", () => ({
  resolveTimeoutPolicy: () => ({ totalMs: 30_000 }),
  resolveMaxOutputTokens: ({ stage }: { stage: string }) => {
    const map: Record<string, number> = {
      "memory-judge": 800,
      "memory-compressor": 500,
      "memory-reflect": 500,
      "memory-resolver": 700,
    };
    return map[stage] ?? 500;
  },
}));

vi.mock("./memory-llm-shared", () => ({
  loadMemoryModelConfig: () => mockConfig.value,
  stripThinkBlocks: (t: string) => t,
}));

vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
  recordRequest: vi.fn(),
}));

vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: (req: Record<string, unknown>, cfg: { model: string }) => {
      mockConfig.requests.push(req);
      return {
        url: `https://test.api/v1/chat/completions`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model }),
      };
    },
    parseResponse: (data: unknown) => {
      const d = data as { text?: string; finishReason?: string; usage?: { input: number; output: number } };
      return { text: d.text ?? "", finishReason: d.finishReason ?? "stop", usage: d.usage };
    },
  }),
}));

// ── Import after mocks ──
import {
  getDefaultMaxOutputTokens,
  invokeMemoryLlm,
  invokeMemoryStructuredOutput,
} from "./memory-llm-client";
import {
  parseMemoryJudgeResult,
  validateMemoryJudgeBusiness,
  parseMemoryReflectionResult,
  validateMemoryReflectionBusiness,
} from "./memory-schemas";

// ── Tests ──

beforeEach(() => {
  vi.restoreAllMocks();
  mockConfig.value = { provider: "test", baseUrl: "https://test.api/v1", model: "test-model", apiKey: "sk-test" };
  mockConfig.requests = [];
});

describe("invokeMemoryStructuredOutput — repair context", () => {
  it("adds validation feedback to a judge repair request", async () => {
    const responses = [
      { text: "not json", finishReason: "stop" },
      { text: '{"candidates":[]}', finishReason: "stop" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift(),
    })));

    await expect(invokeMemoryStructuredOutput({
      operation: "judge",
      systemPrompt: "system",
      userPrompt: "conversation",
      maxOutputTokens: 800,
      parseSchema: parseMemoryJudgeResult,
      validateBusiness: validateMemoryJudgeBusiness,
    })).resolves.toEqual({ candidates: [], entities: [] });

    const repairMessages = mockConfig.requests[1]?.messages as Array<{ role: string; content: string }>;
    expect(repairMessages.at(-1)?.content).toContain("NO_JSON_OBJECT");
    expect(repairMessages.at(-1)?.content).toContain('{"candidates":[],"entities":[]}');
  });

  it("reflect repair instructs updates format, not groups", async () => {
    const responses = [
      { text: "bad", finishReason: "stop" },
      { text: '{"updates":[]}', finishReason: "stop" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift(),
    })));

    await expect(invokeMemoryStructuredOutput({
      operation: "reflect",
      systemPrompt: "system",
      userPrompt: "conversation",
      maxOutputTokens: 500,
      parseSchema: parseMemoryReflectionResult,
      validateBusiness: validateMemoryReflectionBusiness,
    })).resolves.toEqual([]);

    const repairMessages = mockConfig.requests[1]?.messages as Array<{ role: string; content: string }>;
    expect(repairMessages.at(-1)?.content).toContain('{"updates":[...]}');
    expect(repairMessages.at(-1)?.content).not.toContain('{"groups":[...]}');
  });
});

describe("getDefaultMaxOutputTokens", () => {
  it("returns correct defaults for each operation", () => {
    expect(getDefaultMaxOutputTokens("judge")).toBe(800);
    expect(getDefaultMaxOutputTokens("compress")).toBe(500);
    expect(getDefaultMaxOutputTokens("reflect")).toBe(500);
    expect(getDefaultMaxOutputTokens("resolve")).toBe(700);
  });
});

describe("MemoryLlmError types", () => {
  it("MemoryLlmTimeoutError has correct message and fields", () => {
    const err = new MemoryLlmTimeoutError(30000, "judge");
    expect(err.name).toBe("MemoryLlmTimeoutError");
    expect(err.timeoutMs).toBe(30000);
    expect(err.operation).toBe("judge");
    expect(err.message).toContain("judge");
    expect(err.message).toContain("30000");
  });

  it("MemoryLlmHttpError preserves status code and operation", () => {
    const err = new MemoryLlmHttpError(401, "compress", "Unauthorized");
    expect(err.name).toBe("MemoryLlmHttpError");
    expect(err.statusCode).toBe(401);
    expect(err.operation).toBe("compress");
    expect(err.responseBody).toBe("Unauthorized");
    expect(err.message).toContain("401");
    expect(err.message).toContain("compress");
  });

  it("MemoryLlmHttpError works without responseBody", () => {
    const err = new MemoryLlmHttpError(500, "resolve");
    expect(err.responseBody).toBeUndefined();
  });

  it("MemoryLlmProtocolError preserves detail", () => {
    const err = new MemoryLlmProtocolError("resolve", "null text");
    expect(err.name).toBe("MemoryLlmProtocolError");
    expect(err.operation).toBe("resolve");
    expect(err.detail).toBe("null text");
  });

  it("MemoryLlmConfigurationError has detail message", () => {
    const err = new MemoryLlmConfigurationError("missing API key");
    expect(err.name).toBe("MemoryLlmConfigurationError");
    expect(err.message).toContain("missing API key");
  });

  it("all error types extend Error", () => {
    expect(new MemoryLlmTimeoutError(1000, "j")).toBeInstanceOf(Error);
    expect(new MemoryLlmHttpError(500, "c")).toBeInstanceOf(Error);
    expect(new MemoryLlmProtocolError("r", "d")).toBeInstanceOf(Error);
    expect(new MemoryLlmConfigurationError("d")).toBeInstanceOf(Error);
  });
});

describe("invokeMemoryLlm — configuration validation", () => {
  it("throws MemoryLlmConfigurationError when API key is missing", async () => {
    mockConfig.value = { provider: "test", baseUrl: "https://test.api/v1", model: "test-model", apiKey: "" };

    await expect(
      invokeMemoryLlm({
        operation: "judge",
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 800,
      }),
    ).rejects.toThrow(MemoryLlmConfigurationError);
  });
});

describe("invokeMemoryLlm — error distinction", () => {
  it("external signal abort is NOT wrapped as MemoryLlmTimeoutError", async () => {
    // fetch hangs until signal aborts
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }));

    const controller = new AbortController();
    const promise = invokeMemoryLlm({
      operation: "judge",
      messages: [{ role: "user", content: "test" }],
      maxOutputTokens: 800,
      signal: controller.signal,
    });

    // Abort externally after a short delay
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toThrow(/cancelled by external signal/);
    await expect(promise).rejects.not.toThrow(MemoryLlmTimeoutError);
  });

  it("HTTP error body is truncated to 1500 chars", async () => {
    const longMessage = "x".repeat(5000);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: longMessage } }),
    })));

    try {
      await invokeMemoryLlm({
        operation: "compress",
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 500,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryLlmHttpError);
      const httpErr = err as MemoryLlmHttpError;
      expect(httpErr.responseBody).toContain("…(truncated)");
      // 1500 chars of content + "…(truncated)" suffix
      expect(httpErr.responseBody!.length).toBeLessThanOrEqual(1520);
    }
  });
});

// 条款门禁不取消在飞请求，只在出队和每次新请求（含结构修复/限流重试）前拒绝。
import { configureTermsExecutionGate, TermsConsentRequiredError } from "../terms/terms-runtime";
import { enqueueLLMTask } from "../llm-queue";

function pendingResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const memoryRequest = { operation: "summary" as const, messages: [{ role: "user" as const, content: "summary" }], maxOutputTokens: 500 };
const structuredRequest = {
  operation: "judge" as const, systemPrompt: "system", userPrompt: "conversation", maxOutputTokens: 800,
  parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness,
};

describe("条款变化后的记忆请求边界", () => {
  it("队列等待期间失效后拒绝尚未开始的记忆请求", async () => {
    let accepted = true;
    const restore = configureTermsExecutionGate(() => accepted);
    const blocker = pendingResult<void>();
    const first = enqueueLLMTask("terms-test-blocker", () => blocker.promise, { log: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const next = enqueueLLMTask("terms-test-memory", () => invokeMemoryLlm(memoryRequest), { log: false });
    const rejected = expect(next).rejects.toBeInstanceOf(TermsConsentRequiredError);
    try {
      accepted = false;
      blocker.resolve();
      await first;
      await rejected;
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("结构修复前失效后保留专用门禁错误且不再请求", async () => {
    let accepted = true;
    const restore = configureTermsExecutionGate(() => accepted);
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => {
      accepted = false;
      return { text: "invalid json", finishReason: "stop" };
    } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(invokeMemoryStructuredOutput(structuredRequest)).rejects.toBeInstanceOf(TermsConsentRequiredError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it("限流退避期间失效后不发第二次请求", async () => {
    vi.useFakeTimers();
    let accepted = true;
    const restore = configureTermsExecutionGate(() => accepted);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "rate limit" } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const request = enqueueLLMTask("terms-test-retry", () => invokeMemoryLlm(memoryRequest), { log: false });
    const rejected = expect(request).rejects.toBeInstanceOf(TermsConsentRequiredError);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      accepted = false;
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { restore(); vi.useRealTimers(); }
  });

  it.each([false, true])("已派发的有效结果仍可交给持久化收尾（structured=%s）", async structured => {
    let accepted = true;
    const restore = configureTermsExecutionGate(() => accepted);
    const response = pendingResult<{ text: string; finishReason: string }>();
    const fetchMock = vi.fn(async () => ({ ok: true, json: () => response.promise }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = structured ? invokeMemoryStructuredOutput(structuredRequest) : invokeMemoryLlm(memoryRequest);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      accepted = false;
      response.resolve({ text: '{"candidates":[]}', finishReason: "stop" });
      if (structured) await expect(result).resolves.toEqual({ candidates: [], entities: [] });
      else await expect(result).resolves.toMatchObject({ text: '{"candidates":[]}' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });
});
