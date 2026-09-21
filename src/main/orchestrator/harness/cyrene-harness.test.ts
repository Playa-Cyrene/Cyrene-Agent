/**
 * CyreneHarness 完成语义测试：模型不再调用工具时立即结束
 *
 * 验收不变量：
 * - Model no-tool response -> final immediately
 * - Runtime has no continue_agent settlement
 * - UncertainEffectGuard never blocks honest final
 *
 * 核心断言：模型不再调用工具时立即结束，
 * Runtime 不再因 completionObligations 或 uncertainEffects 否决 final。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks（必须在 import SUT 之前）──────────────

const { fakeAdapter, fakeStreamChatWithSdk, recordUsage, recordRequest } = vi.hoisted(() => {
  const adapter = {
    id: "fake",
    buildRequest: (req: unknown) => ({
      url: "https://fake.local/chat",
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),
    parseResponse: (raw: unknown) => raw,
  };
  return {
    fakeAdapter: adapter,
    recordUsage: vi.fn(),
    recordRequest: vi.fn(),
    fakeStreamChatWithSdk: vi.fn(async (input: {
      adapter: typeof adapter;
      request: unknown;
      config: unknown;
      signal?: AbortSignal;
    }) => {
      const http = input.adapter.buildRequest(input.request);
      const response = await fetch(http.url, {
        method: "POST",
        headers: http.headers,
        body: http.body,
        signal: input.signal,
      });
      return input.adapter.parseResponse(await response.json());
    }),
  };
});

vi.mock("../vendors", () => ({
  getAdapterForConfig: vi.fn(() => fakeAdapter),
  streamChatWithSdk: fakeStreamChatWithSdk,
  resolveTransport: vi.fn(() => "openai"),
}));

vi.mock("./tool-dispatcher", () => ({
  dispatchToolCall: vi.fn(),
  persistToolDispatchResult: vi.fn(async (_call: unknown, result: unknown) => result),
}));

vi.mock("../../token-usage-store", () => ({ recordUsage, recordRequest }));

import { runCyreneHarness } from "./cyrene-harness";
import { getAdapterForConfig } from "../vendors";
import { dispatchToolCall } from "./tool-dispatcher";
import type { ToolDispatchResult } from "./tool-dispatcher";
import type { HarnessCacheDiagnostic, HarnessCheckpoint, HarnessEvent, HarnessInput, HarnessToolFinishedEvent, HarnessToolLifecycleEvent, RunAdjustmentMessage } from "./types";
import type { ChatMessage, ChatResponse, ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import { projectCacheRelevantChatRequest } from "../prompt-layers";
import type { TranscriptSink } from "../transcript-sink";

const mockedDispatch = vi.mocked(dispatchToolCall);

// ── Helpers ────────────────────────────────────────────

function assistantResponse(opts: { text?: string; toolCalls?: ToolCall[] }): ChatResponse {
  const text = opts.text ?? "";
  const toolCalls = opts.toolCalls ?? [];
  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  return {
    assistantMessage,
    text,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    raw: {},
  };
}

function assistantResponseWithUsage(usage: NonNullable<ChatResponse["usage"]>): ChatResponse {
  return { ...assistantResponse({ text: "完成" }), usage };
}

function fakeFetchSequencer(responses: ChatResponse[]) {
  const calls: unknown[] = [];
  const fn = vi.fn(async (_url: unknown, _init?: unknown) => {
    const next = responses.shift();
    if (!next) {
      throw new Error("test: fetch sequencer exhausted");
    }
    return {
      ok: true,
      json: async () => next,
    } as unknown as Response;
  });
  return { fn, calls };
}

function mutationToolCall(id = "call-1"): ToolCall {
  return {
    id,
    name: "write_file",
    arguments: JSON.stringify({ path: "/tmp/x", content: "hello" }),
  };
}

function successDispatchResult(callId = "call-1"): ToolDispatchResult {
  return {
    outcome: "success",
    tool: "write_file",
    target: "/tmp/x",
    message: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
    output: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
    truncated: false,
    preview: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
    rawResult: {
      toolId: "write_file",
      args: { path: "/tmp/x", content: "hello" },
      output: '{"success":true,"path":"/tmp/x","sizeBytes":5}',
      status: "succeeded",
      terminal: true,
      retryable: false,
    },
  };
}

function unknownDispatchResult(callId = "call-1"): ToolDispatchResult {
  return {
    outcome: "unknown",
    tool: "send_email",
    target: "x@y",
    message: "副作用已发起，但 Runtime 无法确认是否生效",
    rawResult: {
      toolId: "send_email",
      args: { to: "x@y" },
      output: "",
      status: "failed",
      terminal: true,
      retryable: false,
    },
  };
}

const vendorConfig = {
  provider: "fake",
  baseUrl: "https://fake.local",
  model: "fake-model",
  apiKey: "fake-key",
} as unknown as Parameters<typeof runCyreneHarness>[0]["vendorConfig"];

function sendEmailTool(): ToolDefinition {
  return {
    id: "send_email",
    name: "Send Email",
    description: "send an email",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    },
    effectKind: "external_side_effect",
    execute: vi.fn(),
  };
}

function safeReadTool(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: "safe read",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    effectKind: "read",
    isConcurrencySafe: () => true,
    execute: vi.fn(),
  };
}

function mutationTool(id = "write_file"): ToolDefinition {
  return {
    id,
    name: id,
    description: "safe local mutation",
    enabled: true,
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    effectKind: "mutation",
    execute: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────

describe("CyreneHarness completion", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
    fakeStreamChatWithSdk.mockClear();
    recordUsage.mockReset();
  });

  it("uses the SDK stream runner with native tools enabled", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "直接完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [mutationTool()],
      vendorConfig,
    });

    expect(result.finalAnswer).toBe("直接完成。");
    expect(fakeStreamChatWithSdk).toHaveBeenCalledTimes(1);
    expect(fakeStreamChatWithSdk).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ stream: true, tools: expect.any(Array) }),
    }));
  });

  it("OpenAI 协议请求不再携带固定 maxTokens（避免思维链被 8192 预算截断）", async () => {
    fakeStreamChatWithSdk.mockResolvedValueOnce(assistantResponse({ text: "完成。" }));

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    const request = fakeStreamChatWithSdk.mock.calls[0][0].request as Record<string, unknown>;
    expect("maxTokens" in request).toBe(false);
  });

  it("最终回复 finishReason=length 时在尾部追加截断提示，不再静默", async () => {
    fakeStreamChatWithSdk.mockResolvedValueOnce({
      ...assistantResponse({ text: "写了一半的回复" }),
      finishReason: "length",
    });

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.finalAnswer).toContain("写了一半的回复");
    expect(result.finalAnswer.endsWith("以上回复可能不完整。")).toBe(true);
  });

  it("callLLM 链路注入 applyCacheHints（Kimi prompt_cache_key 等不再漏发）", async () => {
    const adapterWithHints = {
      ...fakeAdapter,
      applyCacheHints: (req: Record<string, unknown>) => ({ ...req, extraBody: { prompt_cache_key: "kimi-cache-key" } }),
    };
    vi.mocked(getAdapterForConfig).mockReturnValueOnce(adapterWithHints as never);
    fakeStreamChatWithSdk.mockResolvedValueOnce(assistantResponse({ text: "完成。" }));

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(fakeStreamChatWithSdk).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ extraBody: { prompt_cache_key: "kimi-cache-key" } }),
    }));
  });

  it("records each Harness model response and preserves its provider-reported cache tokens", async () => {
    fakeStreamChatWithSdk.mockResolvedValueOnce(assistantResponseWithUsage({
      input: 20,
      output: 7,
      cachedInput: 12,
    }));

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(recordUsage).toHaveBeenCalledWith(20, 7, 1, 12, "fake-model", undefined);
  });

  it("forwards only provider-returned reasoning deltas to the process stream", async () => {
    fakeStreamChatWithSdk.mockImplementationOnce(async (input: {
      adapter: typeof fakeAdapter;
      request: unknown;
      config: unknown;
      signal?: AbortSignal;
      onDelta?: (delta: { type: "reasoning_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "reasoning_delta", delta: "先检查" });
      input.onDelta?.({ type: "reasoning_delta", delta: "，再回答" });
      return assistantResponse({ text: "完成。" });
    });
    const events: HarnessEvent[] = [];

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type.startsWith("reasoning_")).slice(0, 3)).toEqual([
      { type: "reasoning_start", messageId: "reasoning-0" },
      { type: "reasoning_delta", messageId: "reasoning-0", delta: "先检查" },
      { type: "reasoning_delta", messageId: "reasoning-0", delta: "，再回答" },
    ]);
    expect(events).toContainEqual({ type: "reasoning_end", messageId: "reasoning-0" });
  });

  it("forwards filtered model text deltas as round-scoped candidate events before final settlement", async () => {
    fakeStreamChatWithSdk.mockImplementationOnce(async (input: {
      onDelta?: (delta: { type: "text_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "text_delta", delta: "[2026-09-15 10:00, Asia/Shanghai] " });
      input.onDelta?.({ type: "text_delta", delta: "你好，" });
      input.onDelta?.({ type: "text_delta", delta: "世界" });
      return assistantResponse({ text: "你好，世界" });
    });
    const events: HarnessEvent[] = [];

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type === "candidate_text_delta")).toEqual([
      { type: "candidate_text_delta", roundId: "round-0", delta: "你好，" },
      { type: "candidate_text_delta", roundId: "round-0", delta: "世界" },
    ]);
    expect(events.findIndex((event) => event.type === "candidate_text_delta"))
      .toBeLessThan(events.findIndex((event) => event.type === "final_answer"));
  });

  it("forwards each candidate text chunk before the provider releases the next chunk", async () => {
    let releaseSecondChunk!: () => void;
    let releaseFinalChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
    const finalChunkGate = new Promise<void>((resolve) => { releaseFinalChunk = resolve; });
    fakeStreamChatWithSdk.mockImplementationOnce(async (input: {
      onDelta?: (delta: { type: "text_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "text_delta", delta: "好的伙伴，" });
      await secondChunkGate;
      input.onDelta?.({ type: "text_delta", delta: "人家先去摸清这边项目的底，" });
      await finalChunkGate;
      input.onDelta?.({ type: "text_delta", delta: "再决定怎么跑测试♪" });
      return assistantResponse({ text: "好的伙伴，人家先去摸清这边项目的底，再决定怎么跑测试♪" });
    });
    const events: HarnessEvent[] = [];

    const running = runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
      onEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "candidate_text_delta")).toEqual([
        { type: "candidate_text_delta", roundId: "round-0", delta: "好的伙伴，" },
      ]);
    });

    releaseSecondChunk();
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "candidate_text_delta")).toEqual([
        { type: "candidate_text_delta", roundId: "round-0", delta: "好的伙伴，" },
        { type: "candidate_text_delta", roundId: "round-0", delta: "人家先去摸清这边项目的底，" },
      ]);
    });
    expect(events.some((event) => event.type === "final_answer")).toBe(false);

    releaseFinalChunk();
    await running;

    expect(events.filter((event) => event.type === "candidate_text_delta")).toEqual([
      { type: "candidate_text_delta", roundId: "round-0", delta: "好的伙伴，" },
      { type: "candidate_text_delta", roundId: "round-0", delta: "人家先去摸清这边项目的底，" },
      { type: "candidate_text_delta", roundId: "round-0", delta: "再决定怎么跑测试♪" },
    ]);
  });

  it("falls back to a non-stream request only when the provider explicitly rejects streaming", async () => {
    fakeStreamChatWithSdk.mockRejectedValueOnce(Object.assign(
      new Error("streaming is not supported; stream must be false"),
      { status: 400 },
    ));
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "降级完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.finalAnswer).toBe("降级完成。");
    expect(fakeStreamChatWithSdk).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({ stream: false });
  });

  it("never retries after any partial stream delta", async () => {
    fakeStreamChatWithSdk.mockImplementationOnce(async (input: {
      adapter: typeof fakeAdapter;
      request: unknown;
      config: unknown;
      signal?: AbortSignal;
      onDelta?: (delta: { type: "reasoning_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "reasoning_delta", delta: "已经开始" });
      throw Object.assign(new Error("streaming is not supported"), { status: 400 });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.terminateReason).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts model final immediately after a mutation tool succeeds, without runtime_feedback", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "已创建文件。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    mockedDispatch.mockResolvedValue(successDispatchResult("call-1"));

    const events: HarnessEvent[] = [];
    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [],
      vendorConfig,
      onEvent: (e) => events.push(e),
    });

    // 只调用过两次模型；不再有第三次循环
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 不再有 runtime_feedback 事件
    expect(events.filter((e) => e.type === "runtime_feedback")).toEqual([]);
    // final 被接受
    expect(result.finalAnswer).toBe("已创建文件。");
    // finalState 不再拥有 completionObligations 字段
    expect("completionObligations" in result.finalState).toBe(false);
    // 自然结束（非超时、非取消）
    expect(result.terminated).toBe(false);
    expect(result.terminateReason).toBeUndefined();
    expect(events.filter((event) => event.type === "round_start" || event.type === "round_end")).toEqual([
      { type: "round_start", roundId: "round-0" },
      { type: "round_end", roundId: "round-0" },
      { type: "round_start", roundId: "round-1" },
      { type: "round_end", roundId: "round-1" },
    ]);
    expect(events.findIndex((event) => event.type === "round_end" && event.roundId === "round-1"))
      .toBeLessThan(events.findIndex((event) => event.type === "final_answer"));
  });

  it("runs explicit-safe reads concurrently but commits their observations in model order", async () => {
    const calls: ToolCall[] = [
      { id: "read-a", name: "read_a", arguments: "{}" },
      { id: "read-b", name: "read_b", arguments: "{}" },
    ];
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: calls }),
      assistantResponse({ text: "读取完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    let resolveA!: () => void;
    let resolveB!: () => void;
    const gateA = new Promise<void>((resolve) => { resolveA = resolve; });
    const gateB = new Promise<void>((resolve) => { resolveB = resolve; });
    const started: string[] = [];
    mockedDispatch.mockImplementation(async (toolCall) => {
      started.push(toolCall.id);
      if (toolCall.id === "read-a") await gateA;
      if (toolCall.id === "read-b") await gateB;
      return {
        outcome: "success",
        tool: toolCall.name,
        message: toolCall.name,
        output: toolCall.name,
        preview: toolCall.name,
        truncated: false,
      };
    });

    const events: HarnessEvent[] = [];
    const running = runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "并行读取" }],
      tools: [safeReadTool("read_a"), safeReadTool("read_b")],
      vendorConfig,
      config: { maxParallelToolCalls: 2 },
      onEvent: (event) => events.push(event),
    });

    await expect.poll(() => started).toEqual(["read-a", "read-b"]);
    resolveB();
    await Promise.resolve();
    expect(events.filter((event) => event.type === "tool_end")).toEqual([]);
    resolveA();
    const result = await running;

    expect(result.finalAnswer).toBe("读取完成。");
    expect(events.filter((event) => event.type === "tool_end").map((event) => (event as { toolCallId: string }).toolCallId))
      .toEqual(["read-a", "read-b"]);
    const nextRequest = fakeStreamChatWithSdk.mock.calls[1]?.[0].request as { messages: ChatMessage[] };
    expect(nextRequest.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId))
      .toEqual(["read-a", "read-b"]);
  });

  it("continues beyond fifty tool rounds until the model returns a final answer", async () => {
    const toolRounds = Array.from({ length: 51 }, (_, index) => (
      assistantResponse({ toolCalls: [mutationToolCall(`call-${index + 1}`)] })
    ));
    const { fn: fetchMock } = fakeFetchSequencer([
      ...toolRounds,
      assistantResponse({ text: "第 51 轮工具完成后自然收尾。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult());

    const result = await runCyreneHarness({
      systemPrompt: "you are a long-running test agent",
      messages: [{ role: "user", content: "执行一个超过五十轮的任务" }],
      tools: [],
      vendorConfig,
    });

    expect(result.finalAnswer).toBe("第 51 轮工具完成后自然收尾。");
    expect(result.rounds).toBe(51);
    expect(result.terminateReason).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(52);
  });

  it("stops at maxRounds before issuing the next model request", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ toolCalls: [mutationToolCall("call-2")] }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult());

    const result = await runCyreneHarness({
      systemPrompt: "you are a bounded test agent",
      messages: [{ role: "user", content: "执行受轮次限制的任务" }],
      tools: [],
      vendorConfig,
      config: { maxRounds: 1 },
    });

    expect(result.rounds).toBe(1);
    expect(result.terminateReason).toBe("max_rounds");
    expect(result.finalAnswer).toContain("工具轮次上限");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同工具连续失败达到阈值后熔断：不再 dispatch,合成 not_executed 引导模型换方案", async () => {
    // 模型连续 6 轮调用同一 write_file 工具,dispatch 每次都失败(semantic_failure 不重试)
    const toolRounds = Array.from({ length: 6 }, (_, index) => (
      assistantResponse({ toolCalls: [mutationToolCall(`call-${index + 1}`)] })
    ));
    const { fn: fetchMock } = fakeFetchSequencer([
      ...toolRounds,
      assistantResponse({ text: "换方案完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue({
      outcome: "failure",
      category: "semantic_failure",
      tool: "write_file",
      message: "E_INVALID_ARGS: 缺少 filename",
    });

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "反复调用同一个失败工具" }],
      tools: [mutationTool()],
      vendorConfig,
    });

    expect(result.finalAnswer).toBe("换方案完成。");
    // 前 5 次真实 dispatch,第 6 次被熔断拦截(不再进入 dispatch)
    expect(mockedDispatch).toHaveBeenCalledTimes(5);
    // 第 6 轮工具结果为合成的 not_executed:最后一次模型请求里能看到熔断提示
    const lastRequest = fakeStreamChatWithSdk.mock.calls[6]?.[0].request as { messages: ChatMessage[] };
    const lastToolMessage = lastRequest.messages.filter((message) => message.role === "tool").at(-1);
    expect(lastToolMessage?.toolCallId).toBe("call-6");
    expect(String(lastToolMessage?.content)).toContain("not_executed");
    expect(String(lastToolMessage?.content)).toContain("熔断");
  });

  it("persists a structured compaction checkpoint before the next model request", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "## 原始任务与意图\n- 完成历史任务\n\n## 下一步\n- 继续回答" }),
      assistantResponse({ text: "已在保留上下文的基础上完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const checkpoints: HarnessCheckpoint[] = [];
    const compactions: Array<{ status: string; messageCountBefore: number; messageCountAfter?: number }> = [];
    const historicalMessages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index === 0 ? "旧任务" : "旧历史"}`.repeat(100),
    }));

    await runCyreneHarness({
      systemPrompt: "test system prompt",
      messages: [
        ...historicalMessages,
        { role: "user", content: "请继续完成".repeat(40) },
      ],
      tools: [],
      vendorConfig,
      config: {
        contextWindowTokens: 200,
        reservedOutputTokens: 20,
        safetyMarginTokens: 0,
        compactionThreshold: 0.3,
        compactionRetainRatio: 0.16,
      },
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onCompactionLifecycle: (event) => compactions.push(event),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const summaryRequest = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      messages: ChatMessage[];
    };
    expect(summaryRequest.messages.some((entry) => entry.content === "旧任务".repeat(100))).toBe(true);
    expect(summaryRequest.messages.at(-1)?.content).toContain("## 原始任务与意图");
    expect(checkpoints.at(-1)?.messages[0]?.content).toContain("<cyrene_compaction_checkpoint>");
    expect(checkpoints.at(-1)?.cache).toEqual({ cacheEpoch: 2, epochReason: "compaction" });
    expect(compactions).toEqual([
      expect.objectContaining({ status: "started", messageCountBefore: historicalMessages.length + 1 }),
      expect.objectContaining({ status: "committed", cache: { cacheEpoch: 2, epochReason: "compaction" } }),
    ]);
  });

  it("halts before the next model request when the post-compaction checkpoint fails", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "## 原始任务与意图\n- 完成历史任务\n\n## 下一步\n- 继续回答" }),
      assistantResponse({ text: "不应到达这里。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const historicalMessages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index === 0 ? "旧任务" : "旧历史"}`.repeat(100),
    }));

    const result = await runCyreneHarness({
      systemPrompt: "test system prompt",
      messages: [
        ...historicalMessages,
        { role: "user", content: "请继续完成".repeat(40) },
      ],
      tools: [],
      vendorConfig,
      config: {
        contextWindowTokens: 200,
        reservedOutputTokens: 20,
        safetyMarginTokens: 0,
        compactionThreshold: 0.3,
        compactionRetainRatio: 0.16,
      },
      onCheckpoint: () => { throw new Error("disk unavailable"); },
    });

    // 第一次 fetch 是压缩摘要请求；checkpoint 失败后不得再发起模型请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
  });

  it("routes a tool round failure to a unified error terminal settlement", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("boom-call")] }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockRejectedValue(new Error("dispatch infrastructure exploded"));
    const events: HarnessEvent[] = [];
    const checkpoints: HarnessCheckpoint[] = [];

    // 工具轮抛出的非取消错误不得冲出 runCyreneHarness：
    // 统一走 finishRun（terminal 快照 + checkpoint + error 终态）
    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [mutationTool()],
      vendorConfig,
      onEvent: (event) => events.push(event),
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("工具执行异常");
    const usageEvents = events.filter((event): event is Extract<HarnessEvent, { type: "context_usage" }> => event.type === "context_usage");
    expect(usageEvents.at(-1)?.snapshot.phase).toBe("terminal");
    expect(checkpoints.length).toBeGreaterThan(0);
    // 工具轮失败后不再发起模型请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // transcript 已闭合：合成失败结果已写回
    expect(checkpoints.at(-1)?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("passes live transcript references to onCheckpoint instead of cloning", async () => {
    // 克隆契约：harness 侧不 deepClone，传活引用，
    // 由消费方（run-store / task-session-store）在回调返回前同步 clone。
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult());
    const snapshots: HarnessCheckpoint[] = [];
    // 活引用共享同一数组，断言时两者 length 恒等；增长需在回调时刻记录
    const lengthsAtCheckpoint: number[] = [];

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [mutationTool()],
      vendorConfig,
      onCheckpoint: (checkpoint) => {
        snapshots.push(checkpoint);
        lengthsAtCheckpoint.push(checkpoint.messages.length);
      },
    });

    // 同一 run 内多次 checkpoint 传递同一活引用，且内容随轮次增长
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const first = snapshots[0]!;
    const last = snapshots.at(-1)!;
    expect(last.messages).toBe(first.messages);
    expect(lengthsAtCheckpoint.at(-1)!).toBeGreaterThan(lengthsAtCheckpoint[0]!);
    expect(last.state).toBe(first.state);
    expect(last.toolOutputs).toBe(first.toolOutputs);
  });

  it("keeps mid-loop content as progress and commits only the last no-tool reply as final answer", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "我先看看文件。", toolCalls: [mutationToolCall("inspect-call")] }),
      assistantResponse({ text: "发现一个问题，我继续检查。", toolCalls: [mutationToolCall("fix-call")] }),
      assistantResponse({ text: "最终结论是……" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult("inspect-call"));
    const events: HarnessEvent[] = [];

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "检查并修复" }],
      tools: [mutationTool()],
      vendorConfig,
      onEvent: (event) => events.push(event),
    });

    // finalAnswer 只含最后一轮无工具回复，不混入中途内容
    expect(result.finalAnswer).toBe("最终结论是……");
    // 中途两轮 content 全部以 progress_text 事件流出（UI 折叠执行区）
    const progressTexts = events
      .filter((event): event is Extract<HarnessEvent, { type: "progress_text" }> => event.type === "progress_text")
      .map((event) => event.content);
    expect(progressTexts).toEqual(["我先看看文件。", "发现一个问题，我继续检查。"]);
    const finalAnswers = events.filter(
      (event): event is Extract<HarnessEvent, { type: "final_answer" }> => event.type === "final_answer",
    );
    expect(finalAnswers).toHaveLength(1);
    expect(finalAnswers[0]?.content).toBe("最终结论是……");
  });

  it("does not erase the transcript when the compaction request fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => assistantResponse({ text: "仍然可以继续回答。" }) });
    vi.stubGlobal("fetch", fetchMock);
    const checkpoints: HarnessCheckpoint[] = [];
    const originalHistory = "旧任务".repeat(100);
    const historicalMessages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 0 ? originalHistory : "旧历史".repeat(100),
    }));

    const result = await runCyreneHarness({
      systemPrompt: "test system prompt",
      messages: [
        ...historicalMessages,
        { role: "user", content: "请继续完成".repeat(40) },
      ],
      tools: [],
      vendorConfig,
      config: {
        contextWindowTokens: 200,
        reservedOutputTokens: 20,
        safetyMarginTokens: 0,
        compactionThreshold: 0.3,
        compactionRetainRatio: 0.16,
      },
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(result.finalAnswer).toBe("仍然可以继续回答。");
    expect(checkpoints.at(-1)?.messages.some((entry) => entry.content === originalHistory)).toBe(true);
    expect(checkpoints.at(-1)?.cache).toEqual({ cacheEpoch: 1, epochReason: "run_start" });
  });

  it("writes only the pruned tool observation into the next model request", async () => {
    const rawOutput = [
      "HEAD_MARKER",
      "a".repeat(4_500),
      "MIDDLE_SECRET_MARKER",
      "b".repeat(4_500),
      "TAIL_MARKER",
    ].join("\n");
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("long-output-call")] }),
      assistantResponse({ text: "已根据工具结果完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue({
      ...successDispatchResult("long-output-call"),
      message: "HEAD_MARKER\n\n[... tool result middle pruned ...]\n\nTAIL_MARKER",
      preview: "HEAD_MARKER\n\n[... tool result middle pruned ...]\n\nTAIL_MARKER",
      output: rawOutput,
      truncated: true,
      toolOutputRef: {
        recordId: "e".repeat(64), resultRef: `tool-result://v1/${"e".repeat(64)}`,
        runId: "run-1", toolCallId: "long-output-call", toolName: "write_file",
        bytes: rawOutput.length, codePoints: Array.from(rawOutput).length, truncatedForModel: true, createdAt: 1,
      },
    });

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "检查长工具输出" }],
      tools: [],
      vendorConfig,
    });

    const secondRequest = fakeStreamChatWithSdk.mock.calls[1]?.[0].request as { messages: ChatMessage[] };
    const toolMessage = secondRequest.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("HEAD_MARKER");
    expect(toolMessage?.content).toContain("TAIL_MARKER");
    expect(toolMessage?.content).not.toContain("MIDDLE_SECRET_MARKER");
    expect(toolMessage?.content).not.toContain("toolOutputRef");
  });

  it("checkpoints the transcript after tool work and before terminal settlement", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("checkpoint-call")] }),
      assistantResponse({ text: "检查完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue({
      ...successDispatchResult("checkpoint-call"),
      toolOutputRef: {
        recordId: "c".repeat(64),
        resultRef: `tool-result://v1/${"c".repeat(64)}`,
        runId: "run-1",
        toolCallId: "checkpoint-call",
        toolName: "write_file",
        bytes: 42,
        codePoints: 42,
        truncatedForModel: false,
        createdAt: 1,
      },
    });
    const checkpoints: HarnessCheckpoint[] = [];

    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "检查任务" }],
      tools: [],
      vendorConfig,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(checkpoints.some((checkpoint) => checkpoint.messages.some((message) => message.role === "tool"))).toBe(true);
    expect(checkpoints.some((checkpoint) => checkpoint.toolOutputs?.[0]?.toolCallId === "checkpoint-call")).toBe(true);
    expect(checkpoints.at(-1)).toMatchObject({ rounds: 1 });
    // 克隆契约：Harness 传活引用（不克隆），隔离由消费方 clone 保证。
    // run 结束后 Harness 不再持有 transcript，消费方回调内同步克隆即可保证不串扰。
    expect(checkpoints.at(-1)?.messages).toBe(checkpoints.at(-2)?.messages);
  });

  it("records a durable lifecycle before dispatch and after committing a tool observation", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("durable-call")] }),
      assistantResponse({ text: "完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult("durable-call"));
    const lifecycle: Array<{ toolCallId: string; status: string }> = [];

    await runCyreneHarness({
      systemPrompt: "test",
      messages: [{ role: "user", content: "写入文件" }],
      tools: [mutationTool()],
      vendorConfig,
      onToolLifecycle: (event) => lifecycle.push(event),
    });

    expect(lifecycle).toEqual([
      expect.objectContaining({ toolCallId: "durable-call", status: "started", toolSideEffect: "idempotent_mutation" }),
      expect.objectContaining({ toolCallId: "durable-call", status: "committed", toolSideEffect: "idempotent_mutation" }),
    ]);
  });

  it("emits a read-only tool finished observation after the model-visible result is committed", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("obs-call")] }),
      assistantResponse({ text: "完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult("obs-call"));
    const finished: HarnessToolFinishedEvent[] = [];

    await runCyreneHarness({
      systemPrompt: "test",
      messages: [{ role: "user", content: "写入文件" }],
      tools: [{ ...mutationTool(), risk: "fs-write" }],
      vendorConfig,
      runId: "obs-run",
      onToolFinished: (event) => finished.push(event),
    });

    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      toolId: "write_file",
      toolCallId: "obs-call",
      runId: "obs-run",
      status: "success",
      risk: "fs-write",
    });
    expect(finished[0].durationMs).toBeGreaterThanOrEqual(0);
    // 不携带参数与输出正文：事件字段集合是稳定白名单
    expect(Object.keys(finished[0]).sort()).toEqual(
      ["durationMs", "risk", "runId", "status", "toolCallId", "toolId"],
    );
  });

  it("emits not_executed tool finished observations for calls displaced by ask_user", async () => {
    const askCall: ToolCall = { id: "ask-1", name: "ask_user", arguments: JSON.stringify({ question: "继续吗" }) };
    const readCall: ToolCall = { id: "read-1", name: "read_file", arguments: "{}" };
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [askCall, readCall] }),
      assistantResponse({ text: "好的，继续。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue({
      outcome: "success",
      tool: "ask_user",
      message: "继续",
    } as ToolDispatchResult);
    const finished: HarnessToolFinishedEvent[] = [];
    const events: HarnessEvent[] = [];

    await runCyreneHarness({
      systemPrompt: "test",
      messages: [{ role: "user", content: "执行任务" }],
      tools: [safeReadTool("read_file")],
      vendorConfig,
      runId: "obs-run-2",
      onToolFinished: (event) => finished.push(event),
      onEvent: (event) => events.push(event),
    });

    // read_file 被 ask_user 排他挤掉：not_executed 且无耗时；ask_user 正常完成带耗时
    expect(finished).toEqual([
      expect.objectContaining({ toolId: "read_file", toolCallId: "read-1", status: "not_executed", risk: "safe" }),
      expect.objectContaining({ toolId: "ask_user", toolCallId: "ask-1", status: "success", risk: "safe" }),
    ]);
    expect("durationMs" in finished[0]).toBe(false);
    expect(finished[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(events).toContainEqual({ type: "candidate_text_discard", roundId: "round-0" });
  });

  it("settles as a runtime error when a required checkpoint cannot be persisted", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "不能假装已经保存。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "执行任务" }],
      tools: [],
      vendorConfig,
      onCheckpoint: () => { throw new Error("disk unavailable"); },
    });

    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
  });

  it("accepts honest final after an unknown non-idempotent side effect; uncertainEffects retained", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({
        toolCalls: [
          { id: "call-1", name: "send_email", arguments: JSON.stringify({ to: "x@y", subject: "s", body: "b" }) },
        ],
      }),
      assistantResponse({ text: "我无法确认刚才的外部操作是否成功。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    mockedDispatch.mockResolvedValue(unknownDispatchResult("call-1"));

    const events: HarnessEvent[] = [];
    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "发邮件" }],
      tools: [sendEmailTool()],
      vendorConfig,
      onEvent: (e) => events.push(e),
    });

    // 只调用过两次模型
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 没有 runtime_feedback 阻止 final
    expect(events.filter((e) => e.type === "runtime_feedback")).toEqual([]);
    // 模型的诚实 final 被接受
    expect(result.finalAnswer).toBe("我无法确认刚才的外部操作是否成功。");
    // finalState 没有 completionObligations
    expect("completionObligations" in result.finalState).toBe(false);
    // uncertainEffects 仍作为事实保留
    expect(result.finalState.uncertainEffects).toHaveLength(1);
    expect(result.finalState.uncertainEffects[0]?.toolName).toBe("send_email");
    // 自然结束
    expect(result.terminated).toBe(false);
    expect(result.terminateReason).toBeUndefined();
  });

  it("makes the next model request an append-only extension after update_todo", async () => {
    const updateCall: ToolCall = {
      id: "todo-1",
      name: "update_todo",
      arguments: JSON.stringify({
        todos: [{ id: "inspect", content: "检查项目结构", status: "in_progress" }],
      }),
    };
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "先记一下步骤。", toolCalls: [updateCall] }),
      assistantResponse({ text: "现在继续检查。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockImplementation(async (_call, ctx) => {
      ctx.state.todoItems = [{ id: "inspect", content: "检查项目结构", status: "in_progress" }];
      return {
        outcome: "success",
        tool: "update_todo",
        message: "待办列表已更新",
        output: "{}",
      };
    });

    await runCyreneHarness({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: "检查并修复这个项目" }],
      tools: [],
      vendorConfig,
    });

    const firstRequest = fakeStreamChatWithSdk.mock.calls[0][0].request as Parameters<typeof projectCacheRelevantChatRequest>[0];
    const secondRequest = fakeStreamChatWithSdk.mock.calls[1][0].request as Parameters<typeof projectCacheRelevantChatRequest>[0];
    const first = projectCacheRelevantChatRequest(firstRequest);
    const second = projectCacheRelevantChatRequest(secondRequest);

    expect(second.stableSystem).toEqual(first.stableSystem);
    expect(second.tools).toEqual(first.tools);
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.some((message) => String(message.content).includes("CURRENT_TODO_NOTEBOOK"))).toBe(false);
  });

  it("emits non-sensitive cache diagnostics for every model request", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("cache-1")] }),
      assistantResponse({ text: "完成" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult("cache-1"));
    const diagnostics: HarnessCacheDiagnostic[] = [];

    await runCyreneHarness({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: "执行两步任务" }],
      tools: [],
      vendorConfig,
      runId: "run-cache",
      onCacheDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toMatchObject({
      runId: "run-cache",
      cacheEpoch: 1,
      round: 1,
      stablePromptFingerprint: diagnostics[0]?.stablePromptFingerprint,
      toolSchemaFingerprint: diagnostics[0]?.toolSchemaFingerprint,
    });
    expect(diagnostics[1]?.messageCount).toBeGreaterThan(diagnostics[0]?.messageCount as number);
    expect(diagnostics[0]?.messagePrefixFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("materializes a restored Todo notebook once as a metadata-free internal message", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "继续检查。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await runCyreneHarness({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: "继续上一次子任务" }],
      tools: [],
      vendorConfig,
      initialState: {
        todoItems: [{ id: "inspect", content: "检查取消链路", status: "in_progress" }],
        uncertainEffects: [],
      },
      initialInternalContext: {
        kind: "recovery",
        content: "<internal_context type=\"recovery\">已从中断任务恢复</internal_context>",
      },
    });

    const firstRequest = fakeStreamChatWithSdk.mock.calls[0][0].request as { messages: ChatMessage[] };
    expect(firstRequest.messages[0].content).toBe("base prompt");
    expect(firstRequest.messages.some((message) => String(message.content).includes("已从中断任务恢复"))).toBe(true);
    expect(firstRequest.messages.some((message) => String(message.content).includes("[in_progress] inspect: 检查取消链路"))).toBe(true);
    expect(firstRequest.messages.every((message) => message.visibility === undefined && message.internal === undefined)).toBe(true);
  });

  it("resumes the same Harness run after a complete Ask observation", async () => {
    const askCall: ToolCall = {
      id: "ask-mixed",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [
          { id: "format", question: "格式？", type: "single_select", options: [{ label: "Markdown", value: "md" }, { label: "Word", value: "docx" }] },
          { id: "sections", question: "章节？", type: "multi_select", options: [{ label: "摘要", value: "summary" }, { label: "风险", value: "risks" }] },
          { id: "note", question: "补充要求？", type: "text" },
        ],
      }),
    };
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "先确认几个选择。", toolCalls: [askCall] }),
      assistantResponse({ text: "已经按你的选择继续完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue({
      outcome: "success",
      tool: "ask_user",
      message: "用户已回答 3 个问题",
      output: JSON.stringify({
        answers: [
          { questionId: "format", selectedValues: ["md"], selectedLabels: ["Markdown"] },
          { questionId: "sections", selectedValues: ["summary", "risks"], selectedLabels: ["摘要", "风险"] },
          { questionId: "note", customInput: "停止当前任务" },
        ],
      }),
    });

    const result = await runCyreneHarness({
      systemPrompt: "base prompt",
      messages: [{ role: "user", content: "完成方案" }],
      tools: [],
      vendorConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.finalAnswer).toBe("已经按你的选择继续完成。");
    const secondRequest = fakeStreamChatWithSdk.mock.calls[1][0].request as { messages: ChatMessage[] };
    expect(JSON.stringify(secondRequest.messages)).toContain("停止当前任务");
  });
});

describe("CyreneHarness run adjustments", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
    fakeStreamChatWithSdk.mockClear();
    recordUsage.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("工具批次结束后：插话在下一次模型请求前按入队顺序进入上下文（核心事件顺序）", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "已按插话调整方案完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    // 用户在工具执行期间标记插话（模拟 dispatch 进行中点击"插入当前运行下一步"）
    const adjustments: RunAdjustmentMessage[] = [];
    mockedDispatch.mockImplementation(async () => {
      adjustments.push({ id: "q-adj-1", rawContent: "插话：先看另一个文件" });
      adjustments.push({ id: "q-adj-2", rawContent: "插话：顺便加上注释" });
      return successDispatchResult("call-1");
    });
    const poll = vi.fn((): Promise<RunAdjustmentMessage[]> | undefined =>
      adjustments.length > 0 ? Promise.resolve(adjustments.splice(0)) : undefined);
    const checkpoints: HarnessCheckpoint[] = [];

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [mutationTool()],
      vendorConfig,
      pollRunAdjustments: poll,
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    // 轮询点共三次：round-0 请求前（无标记）、round-1 请求前（取走插话）、最终结算前（空）
    expect(poll).toHaveBeenCalledTimes(3);
    // 第二次模型请求看到两条插话：位于 transcript 尾部、按入队顺序
    const secondRequest = fakeStreamChatWithSdk.mock.calls[1]?.[0].request as { messages: ChatMessage[] };
    expect(secondRequest.messages.slice(-2).map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "插话：先看另一个文件" },
      { role: "user", content: "插话：顺便加上注释" },
    ]);
    // 插话紧跟工具结果之后（当前操作结束 → 插话 → 下一次模型请求）
    const toolMessageIndex = secondRequest.messages.findIndex((message) => message.role === "tool");
    expect(toolMessageIndex).toBe(secondRequest.messages.length - 3);
    // 注入后、下一次请求前落盘 checkpoint（崩溃恢复不丢插话）
    expect(checkpoints.some((checkpoint) =>
      checkpoint.messages.some((message) => message.role === "user" && message.content === "插话：先看另一个文件"),
    )).toBe(true);
    expect(result.finalAnswer).toBe("已按插话调整方案完成。");
  });

  it("模型准备结束但有插话：最终结算前检查，本轮回复转中间过程并继续处理", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ text: "我准备收尾了。" }),
      assistantResponse({ text: "结合插话后的最终回答。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    // 插话在 round-0 请求前不存在，模型回复后、最终结算前被标记
    let pollCount = 0;
    const poll = vi.fn((): Promise<RunAdjustmentMessage[]> | undefined => {
      pollCount++;
      return pollCount === 2
        ? Promise.resolve([{ id: "q-adj", rawContent: "插话：再补充一点" }])
        : undefined;
    });
    const events: HarnessEvent[] = [];

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "完成任务" }],
      tools: [],
      vendorConfig,
      pollRunAdjustments: poll,
      onEvent: (event) => events.push(event),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 原本要结束的回复转为中间过程（progress_text），绝不作为 final
    const progressTexts = events
      .filter((event): event is Extract<HarnessEvent, { type: "progress_text" }> => event.type === "progress_text")
      .map((event) => event.content);
    expect(progressTexts).toEqual(["我准备收尾了。"]);
    expect(result.finalAnswer).toBe("结合插话后的最终回答。");
    // 第二次请求的上下文尾部是插话用户消息
    const secondRequest = fakeStreamChatWithSdk.mock.calls[1]?.[0].request as { messages: ChatMessage[] };
    expect(secondRequest.messages.at(-1)).toMatchObject({ role: "user", content: "插话：再补充一点" });
    // 插话轮按工具轮口径计数（轮次上限能正确约束插话续轮）
    expect(result.rounds).toBe(1);
    // 事件顺序：round_end(0) → progress_text（中间过程）→ round_start(1) → final_answer
    const roundEndIdx = events.findIndex((event) => event.type === "round_end" && event.roundId === "round-0");
    const progressIdx = events.findIndex((event) => event.type === "progress_text");
    const roundStartIdx = events.findIndex((event) => event.type === "round_start" && event.roundId === "round-1");
    const finalIdx = events.findIndex((event) => event.type === "final_answer");
    expect(roundEndIdx).toBeLessThan(progressIdx);
    expect(progressIdx).toBeLessThan(roundStartIdx);
    expect(roundStartIdx).toBeLessThan(finalIdx);
  });

  it("取消：工具执行中被取消后不再轮询/注入插话，也不再有模型请求", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "不应被请求。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const adjustments: RunAdjustmentMessage[] = [];
    mockedDispatch.mockImplementation(async () => {
      // 工具执行中用户标记插话又立刻取消：插话尚未注入
      adjustments.push({ id: "q-adj", rawContent: "插话：来不及了" });
      controller.abort();
      return successDispatchResult("call-1");
    });
    const poll = vi.fn((): Promise<RunAdjustmentMessage[]> | undefined =>
      adjustments.length > 0 ? Promise.resolve(adjustments.splice(0)) : undefined);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [mutationTool()],
      vendorConfig,
      signal: controller.signal,
      pollRunAdjustments: poll,
    });

    expect(result.terminateReason).toBe("cancelled");
    // 取消后不再有模型请求，也不再有轮询（插话未被消费，标记留给运行结束复位）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("轮次上限不被插话绕过：达到上限直接结算，不注入插话、不再请求模型", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "不应被请求。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const adjustments: RunAdjustmentMessage[] = [];
    mockedDispatch.mockImplementation(async () => {
      // 工具执行期间标记插话，但本运行轮次即将达上限
      adjustments.push({ id: "q-adj", rawContent: "插话：改需求" });
      return successDispatchResult("call-1");
    });
    const poll = vi.fn((): Promise<RunAdjustmentMessage[]> | undefined =>
      adjustments.length > 0 ? Promise.resolve(adjustments.splice(0)) : undefined);

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "执行受轮次限制的任务" }],
      tools: [mutationTool()],
      vendorConfig,
      config: { maxRounds: 1 },
      pollRunAdjustments: poll,
    });

    expect(result.terminateReason).toBe("max_rounds");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 上限检查先于插话注入：插话未被消费（仍留在标记里，由运行结束复位回普通队列）
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("插话双写失败（poll 抛错）：fail-closed 终止运行，不注入、不再请求模型", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "不应被请求。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockImplementation(async () => successDispatchResult("call-1"));
    // 模拟插话双写失败（轨迹或聊天历史任一步写失败，poller 上抛）：
    // round-0 请求前无标记同步直达；工具轮结束后第二次轮询 reject
    let pollCount = 0;
    const poll = vi.fn((): Promise<RunAdjustmentMessage[]> | undefined => {
      pollCount++;
      return pollCount === 1
        ? undefined
        : Promise.reject(new Error("PENDING_ADJUST_COMMIT_FAILED:q-adj:write-failed"));
    });

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [mutationTool()],
      vendorConfig,
      pollRunAdjustments: poll,
    });

    // fail-closed：pending 保留、运行终止，不得带着失败插话继续执行
    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("插话提交失败");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("插话注入后 checkpoint 失败：按既有的状态保存失败语义熔断，不得静默继续", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "不应被请求。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const adjustments: RunAdjustmentMessage[] = [];
    mockedDispatch.mockImplementation(async () => {
      adjustments.push({ id: "q-adj", rawContent: "插话：写盘会失败" });
      return successDispatchResult("call-1");
    });
    const poll = vi.fn((): Promise<RunAdjustmentMessage[]> | undefined =>
      adjustments.length > 0 ? Promise.resolve(adjustments.splice(0)) : undefined);
    let failed = false;
    const checkpoints: HarnessCheckpoint[] = [];

    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [mutationTool()],
      vendorConfig,
      pollRunAdjustments: poll,
      // 只在插话注入后的 checkpoint 抛错（普通轮次 checkpoint 正常）
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
        if (!failed && checkpoint.messages.some((message) => message.content === "插话：写盘会失败")) {
          failed = true;
          throw new Error("disk unavailable");
        }
      },
    });

    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("执行状态保存失败");
    // 熔断发生在下一次模型请求之前
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("CyreneHarness context usage snapshots", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
    fakeStreamChatWithSdk.mockClear();
    recordUsage.mockReset();
  });

  function conversationTokens(event: Extract<HarnessEvent, { type: "context_usage" }>): number {
    return event.snapshot.categories.find((category) => category.key === "conversation")?.tokens ?? -1;
  }

  it("emits growing preRequest snapshots each round and a terminal snapshot containing the final answer", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "已创建文件，任务完成。" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    mockedDispatch.mockResolvedValue(successDispatchResult("call-1"));

    const events: HarnessEvent[] = [];
    await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [],
      vendorConfig,
      onEvent: (event) => events.push(event),
    });

    const usageEvents = events.filter((event): event is Extract<HarnessEvent, { type: "context_usage" }> => event.type === "context_usage");
    // 两轮各一次 preRequest + finish() 一次 terminal。
    expect(usageEvents.map((event) => event.snapshot.phase)).toEqual(["preRequest", "preRequest", "terminal"]);

    const [firstPre, secondPre, terminal] = usageEvents;
    // 工具轮后对话历史 token 增长。
    expect(conversationTokens(secondPre)).toBeGreaterThan(conversationTokens(firstPre));
    // 终态快照包含 final assistant 回复，conversation 大于最后一次 preRequest。
    expect(conversationTokens(terminal)).toBeGreaterThan(conversationTokens(secondPre));
    // 快照携带轮次与窗口字段。
    expect(terminal.snapshot.round).toBe(1);
    expect(terminal.snapshot.contextWindowTokens).toBeGreaterThan(0);
    expect(terminal.snapshot.totalTokens).toBe(terminal.snapshot.categories.reduce((sum, category) => sum + category.tokens, 0));
  });

  it("emits a terminal snapshot when the run is cancelled", async () => {
    const { fn: fetchMock } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    mockedDispatch.mockImplementation(async () => {
      controller.abort();
      return successDispatchResult("call-1");
    });

    const events: HarnessEvent[] = [];
    const result = await runCyreneHarness({
      systemPrompt: "you are a test agent",
      messages: [{ role: "user", content: "创建一个文件" }],
      tools: [],
      vendorConfig,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    expect(result.terminateReason).toBe("cancelled");
    // cancelled 与其他终态共享统一结算：同样获得 terminal 快照（上下文环终态数据）
    const usageEvents = events.filter((event): event is Extract<HarnessEvent, { type: "context_usage" }> => event.type === "context_usage");
    expect(usageEvents.map((event) => event.snapshot.phase)).toEqual(["preRequest", "terminal"]);
  });
});

// ── 轨迹提交端集成（CTA Phase 1 Task 4）──────────────────

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** 轨迹提交端替身：默认全成功，按需覆写失败/挂起行为。 */
function fakeSink(overrides: Partial<TranscriptSink> = {}): TranscriptSink {
  const appendAssistant = vi.fn(overrides.appendAssistant ?? (async () => "assistant-entry"));
  const appendToolResult = vi.fn(overrides.appendToolResult ?? (async () => undefined));
  const closeInterruption = vi.fn(overrides.closeInterruption ?? (async () => undefined));
  const checkpoint = vi.fn(overrides.checkpoint ?? (async () => undefined));
  return { appendAssistant, appendToolResult, closeInterruption, checkpoint };
}

function harnessInput(overrides: Partial<HarnessInput> & { tool?: ToolDefinition } = {}): HarnessInput {
  const { tool, ...rest } = overrides;
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "do work" }],
    tools: tool ? [tool] : [],
    vendorConfig,
    ...rest,
  };
}

function sendEmailCall(id = "call-1"): ToolCall {
  return {
    id,
    name: "send_email",
    arguments: JSON.stringify({ to: "x@y", subject: "hi", body: "hello" }),
  };
}

describe("CyreneHarness transcript sink", () => {
  beforeEach(() => {
    mockedDispatch.mockReset();
    fakeStreamChatWithSdk.mockClear();
    recordUsage.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("awaits assistant persistence before dispatching any tool", async () => {
    const { fn: modelFetch } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
      assistantResponse({ text: "完成" }),
    ]);
    vi.stubGlobal("fetch", modelFetch);
    mockedDispatch.mockResolvedValue(successDispatchResult("call-1"));

    const release = deferred<void>();
    const sink = fakeSink({ appendAssistant: () => release.promise.then(() => "assistant-entry") });
    const runPromise = runCyreneHarness(harnessInput({ transcriptSink: sink }));
    await vi.waitFor(() => expect(sink.appendAssistant).toHaveBeenCalledOnce());
    // assistant 尚未落盘：任何工具都不得开始执行
    expect(mockedDispatch).not.toHaveBeenCalled();
    release.resolve();
    await runPromise;
    expect(mockedDispatch).toHaveBeenCalledOnce();
  });

  it("turns assistant persistence failure into an error run without tool execution", async () => {
    const { fn: modelFetch } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [mutationToolCall("call-1")] }),
    ]);
    vi.stubGlobal("fetch", modelFetch);

    const result = await runCyreneHarness(harnessInput({
      transcriptSink: fakeSink({ appendAssistant: async () => { throw new Error("disk full"); } }),
    }));

    expect(result.terminateReason).toBe("error");
    expect(result.finalAnswer).toContain("会话轨迹保存失败");
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("does not mark a tool committed or issue another model request when tool_result persistence fails", async () => {
    const { fn: modelFetch } = fakeFetchSequencer([
      assistantResponse({ toolCalls: [sendEmailCall("call-1")] }),
      assistantResponse({ text: "不应到达" }),
    ]);
    vi.stubGlobal("fetch", modelFetch);
    mockedDispatch.mockResolvedValue({
      outcome: "success",
      tool: "send_email",
      target: "x@y",
      message: "sent",
      output: "sent",
      truncated: false,
      preview: "sent",
    });

    const lifecycle: HarnessToolLifecycleEvent[] = [];
    const result = await runCyreneHarness({
      ...harnessInput({ tool: sendEmailTool() }),
      transcriptSink: fakeSink({ appendToolResult: async () => { throw new Error("disk full"); } }),
      onToolLifecycle: (event) => lifecycle.push(event),
    });

    // 失败后不再有模型请求，工具不得被标记 committed
    expect(modelFetch).toHaveBeenCalledTimes(1);
    expect(lifecycle).toContainEqual(expect.objectContaining({ status: "started" }));
    expect(lifecycle).not.toContainEqual(expect.objectContaining({ status: "committed" }));
    // 非幂等副作用已执行但结果未持久化：必须保留不确定效果
    expect(result.finalState.uncertainEffects).toContainEqual(expect.objectContaining({ toolName: "send_email" }));
    expect(result.terminateReason).toBe("error");
  });
});
