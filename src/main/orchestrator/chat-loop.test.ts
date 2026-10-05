import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
  recordRequest: vi.fn(),
}));

// 跨循环测试需要真实跑一轮 Harness：仅替换 streamChatWithSdk 为可控实现，
// 其余导出（createSseReader / getAdapterForConfig 等）保持真实。
const { fakeStreamChatWithSdk } = vi.hoisted(() => ({ fakeStreamChatWithSdk: vi.fn() }));
vi.mock("./vendors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vendors")>();
  return { ...actual, streamChatWithSdk: fakeStreamChatWithSdk };
});

import { runChatLoop as runChatLoopProduction, type ChatLoopOptions } from "./chat-loop";
import * as timeoutManager from "../timeout-manager";
import { DEFAULT_TIMEOUT_SETTINGS } from "../../shared/timeout-types";
import { createSseReader } from "./vendors";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { materializeTranscript } from "./conversation-transcript-context";
import { createTranscriptSink, type TranscriptSink } from "./transcript-sink";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatVendorAdapter,
  HttpRequest,
  ProviderCapability,
  StreamChunk,
  StreamEvent,
  ToolExecutionResult,
} from "./vendors/types";

const capability: ProviderCapability = {
  id: "test",
  displayName: "test",
  transport: "openai",
  baseUrl: "https://test/",
  authStyle: "bearer",
  defaultModel: "m",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
};

class FakeAdapter implements ChatVendorAdapter {
  readonly id: string;
  readonly transport = "openai" as const;
  capability: ProviderCapability;
  readonly requests: ChatRequest[] = [];

  constructor(id = "test") {
    this.id = id;
    this.capability = { ...capability, id, displayName: id };
  }

  buildRequest(req: ChatRequest): HttpRequest {
    this.requests.push(req);
    return { url: "https://fake/", method: "POST", headers: {}, body: "{}" };
  }

  parseResponse(raw?: unknown): ChatResponse {
    const text = typeof (raw as { text?: unknown })?.text === "string"
      ? String((raw as { text: string }).text)
      : "只是陪你聊聊。";
    const thinking = typeof (raw as { thinking?: unknown })?.thinking === "string"
      ? String((raw as { thinking: string }).thinking)
      : undefined;
    return {
      assistantMessage: { role: "assistant", content: text, thinking },
      text,
      thinking,
      toolCalls: [],
      finishReason: "stop",
      raw: {},
      usage: { input: 12, output: 6 },
    };
  }

  appendToolResults(messages: ChatMessage[], _results: ToolExecutionResult[]): ChatMessage[] {
    return messages;
  }

  buildStreamRequest(req: ChatRequest): HttpRequest {
    return this.buildRequest(req);
  }

  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    if (event.data === "[DONE]") return { done: true };
    const parsed = JSON.parse(event.data) as {
      delta?: string;
      thinking?: string;
      usage?: { input: number; output: number };
    };
    return {
      ...(parsed.delta ? { deltaText: parsed.delta } : {}),
      ...(parsed.thinking ? { deltaThinking: parsed.thinking } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  }

  async testConnection() {
    return { ok: true, latency: 0 };
  }
}

const testSdkStream: NonNullable<ChatLoopOptions["streamChat"]> = async (input) => {
  const http = input.adapter.buildStreamRequest(input.request, input.config);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal: input.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`HTTP ${response.status}${body ? ` - ${body}` : ""}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (response.headers.get("content-type")?.includes("application/json")) {
    return input.adapter.parseResponse(await response.json());
  }
  if (!response.body) throw new Error("empty stream");

  let text = "";
  let thinking = "";
  let usage: { input: number; output: number } | undefined;
  for await (const event of createSseReader(input.adapter, response.body)) {
    const chunk = input.adapter.parseStreamEvent(event);
    if (!chunk) continue;
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.deltaThinking) {
      thinking += chunk.deltaThinking;
      input.onDelta?.({ type: "reasoning_delta", delta: chunk.deltaThinking });
    }
    if (chunk.deltaText) {
      text += chunk.deltaText;
      input.onDelta?.({ type: "text_delta", delta: chunk.deltaText });
    }
    if (chunk.usage) {
      usage = {
        input: Math.max(usage?.input ?? 0, chunk.usage.input),
        output: Math.max(usage?.output ?? 0, chunk.usage.output),
      };
    }
    if (chunk.done) break;
  }
  return {
    assistantMessage: { role: "assistant", content: text, ...(thinking ? { thinking } : {}) },
    text,
    ...(thinking ? { thinking } : {}),
    toolCalls: [],
    finishReason: "stop",
    raw: {},
    ...(usage ? { usage } : {}),
  };
};

function runChatLoop(options: ChatLoopOptions) {
  return runChatLoopProduction({
    ...options,
    streamChat: options.streamChat ?? testSdkStream,
    generateChat: options.generateChat ?? (async input => {
      const http = input.adapter.buildRequest(input.request, input.config);
      const response = await fetch(http.url, { method: "POST", headers: http.headers, body: http.body, signal: input.signal });
      if (!response.ok) {
        const error = Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, retryAfterMs: 0 });
        throw error;
      }
      return input.adapter.parseResponse(await response.json());
    }),
  });
}

/** 可断言的假轨迹提交端：默认全部成功。 */
function fakeSink(overrides: Partial<TranscriptSink> = {}): TranscriptSink {
  return {
    appendAssistant: vi.fn(overrides.appendAssistant ?? (async () => "assistant-entry")),
    appendToolResult: vi.fn(overrides.appendToolResult ?? (async () => undefined)),
    closeInterruption: vi.fn(overrides.closeInterruption ?? (async () => undefined)),
    checkpoint: vi.fn(overrides.checkpoint ?? (async () => undefined)),
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

describe("runChatLoop", () => {
  it("接收数据活动能让普通聊天请求跨过默认空闲期限", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter();
      const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = (input) => new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        input.signal!.addEventListener("abort", onAbort, { once: true });
        setTimeout(() => input.onStreamActivity?.(), 20_000);
        setTimeout(() => input.onStreamActivity?.(), 40_000);
        setTimeout(() => {
          input.signal!.removeEventListener("abort", onAbort);
          input.onDelta?.({ type: "text_delta", delta: "done" });
          resolve(adapter.parseResponse({ text: "done" }));
        }, 80_000);
      });
      vi.spyOn(timeoutManager, "getTimeoutSettings").mockReturnValue({
        ...DEFAULT_TIMEOUT_SETTINGS,
        modelRequestTimeoutSec: 60,
      });
      const outcome = runChatLoop({
        settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 0 },
        adapter, messages: [{ role: "user", content: "hi" }], soulSystemBaseContent: "system",
        timeoutMs: 120_000, fallbackRevealIntervalMs: 0, streamChat,
      }).then((response) => ({ response }), (error) => ({ error }));

      await vi.advanceTimersByTimeAsync(90_000);
      expect(await outcome).toMatchObject({ response: { reply: "done" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the chat system prefix stable while appending runtime context as a wire-only suffix", async () => {
    const adapter = new FakeAdapter();
    await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      runtimeContext: "[RUNTIME] 当前时间与附件",
      timeoutMs: 0,
      fallbackRevealIntervalMs: 0,
      recordUsage: vi.fn(),
      streamChat: async (input) => {
        adapter.buildStreamRequest(input.request);
        return {
          assistantMessage: { role: "assistant", content: "你好" },
          text: "你好",
          toolCalls: [],
          finishReason: "stop",
          raw: {},
          usage: { input: 1, output: 1 },
        };
      },
    });

    expect(adapter.requests[0].messages[0]).toEqual({ role: "system", content: "SOUL_SYSTEM" });
    expect(adapter.requests[0].messages.at(-1)).toEqual({
      role: "user",
      content: "<runtime_context>\n[RUNTIME] 当前时间与附件\n</runtime_context>",
    });
  });

  it("emits preRequest and terminal context usage snapshots, terminal includes the final reply", async () => {
    const adapter = new FakeAdapter();
    const usageSnapshots: Array<{
      phase: string;
      messageCount: number;
      conversationTokens: number;
      runtimeAndToolLogsTokens: number;
    }> = [];

    await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "陪我聊聊" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      runtimeContext: "[RUNTIME] 当前时间",
      timeoutMs: 30_000,
      onEvent: (event) => {
        if (event.type !== "context_usage" || !event.contextUsage) return;
        usageSnapshots.push({
          phase: event.contextUsage.phase,
          messageCount: event.contextUsage.messageCount,
          conversationTokens: event.contextUsage.categories.find((category) => category.key === "conversation")?.tokens ?? -1,
          runtimeAndToolLogsTokens: event.contextUsage.categories.find((category) => category.key === "runtimeAndToolLogs")?.tokens ?? -1,
        });
      },
      recordUsage: vi.fn(),
    });

    // 请求前一次 + 拿到回复后一次。
    expect(usageSnapshots.map((snapshot) => snapshot.phase)).toEqual(["preRequest", "terminal"]);
    // preRequest：仅 1 条 user 消息；runtime_context 尾部注入不进 messages（避免双重计数），
    // 由 runtimeAndToolLogs 单独计量。
    expect(usageSnapshots[0].messageCount).toBe(1);
    expect(usageSnapshots[0].runtimeAndToolLogsTokens).toBeGreaterThan(0);
    // terminal：并入最终 assistant 回复，消息数 +1，对话历史 token 增长。
    expect(usageSnapshots[1].messageCount).toBe(2);
    expect(usageSnapshots[1].conversationTokens).toBeGreaterThan(usageSnapshots[0].conversationTokens);
  });

  it("uses the SDK stream runner for a Chat request", async () => {
    const adapter = new FakeAdapter();
    const streamChat = vi.fn(async (input: {
      onDelta?: (delta: { type: "text_delta"; delta: string }) => void;
    }) => {
      input.onDelta?.({ type: "text_delta", delta: "SDK 真流式" });
      return {
        assistantMessage: { role: "assistant" as const, content: "SDK 真流式" },
        text: "SDK 真流式",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
        usage: { input: 3, output: 2 },
      };
    });

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      streamChat: streamChat as never,
      recordUsage: vi.fn(),
    });

    expect(streamChat).toHaveBeenCalledOnce();
    expect(result.reply).toBe("SDK 真流式");
  });

  it("makes one plain Soul request without tools or structured output", async () => {
    const adapter = new FakeAdapter();
    const onEvent = vi.fn();
    const recordUsage = vi.fn();

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "陪我聊聊" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      soulSampling: { temperature: 0.82, frequencyPenalty: 0.2 },
      timeoutMs: 30_000,
      onEvent,
      recordUsage,
    });

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].stream).toBe(true);
    expect(adapter.requests[0].messages[0]).toEqual({ role: "system", content: "SOUL_SYSTEM" });
    expect(adapter.requests[0].messages[1]).toEqual({ role: "user", content: "陪我聊聊" });
    expect(adapter.requests[0].tools).toBeUndefined();
    expect(adapter.requests[0].structuredOutput).toBeUndefined();
    expect(adapter.requests[0].temperature).toBe(0.82);
    expect(adapter.requests[0].frequencyPenalty).toBe(0.2);
    expect(result.toolResults).toEqual([]);
    expect(result.reply).toBe("只是陪你聊聊。");
    expect(result.totalUsage).toEqual({ input: 12, output: 6 });
    expect(recordUsage).toHaveBeenCalledWith(12, 6, 1, undefined, undefined);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "text_message_start" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "text_message_end" }));
  });

  it("forwards real provider stream chunks as they arrive", async () => {
    const adapter = new FakeAdapter();
    const onEvent = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response([
      'data: {"delta":"昔涟"}',
      "",
      'data: {"delta":"来啦♪","usage":{"input":4,"output":3}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      onEvent,
      recordUsage: vi.fn(),
    });

    const deltas = onEvent.mock.calls
      .map(([event]) => event as { type: string; delta?: string })
      .filter((event) => event.type === "text_message_content")
      .map((event) => event.delta)
      .join("");
    expect(deltas).toBe("昔涟来啦♪");
    expect(result.reply).toBe("昔涟来啦♪");
    expect(result.totalUsage).toEqual({ input: 4, output: 3 });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].stream).toBe(true);
  });

  it("emits reasoning before creating the visible assistant message", async () => {
    const adapter = new FakeAdapter();
    const events: Array<{ type: string; delta?: string }> = [];
    globalThis.fetch = vi.fn(async () => new Response([
      'data: {"thinking":"先分析"}', "",
      'data: {"thinking":"问题"}', "",
      'data: {"delta":"正式回答"}', "",
      "data: [DONE]", "",
    ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "为什么" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      onEvent: (event) => events.push(event),
      recordUsage: vi.fn(),
    });

    expect(events.map((event) => event.type)).toEqual([
      "context_usage",
      "step_started",
      "reasoning_message_start",
      "reasoning_message_content",
      "reasoning_message_content",
      "reasoning_message_end",
      "text_message_start",
      "text_message_content",
      "context_usage",
      "text_message_end",
      "step_finished",
    ]);
    expect(events.filter((event) => event.type === "reasoning_message_content").map((event) => event.delta).join(""))
      .toBe("先分析问题");
  });

  it("exposes non-stream reasoning before paced fallback text", async () => {
    const adapter = new FakeAdapter();
    const events: Array<{ type: string; delta?: string }> = [];
    globalThis.fetch = vi.fn(async () => new Response('{"text":"答案","thinking":"非流式分析"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "为什么" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      fallbackRevealIntervalMs: 0,
      onEvent: (event) => events.push(event),
      recordUsage: vi.fn(),
    });

    expect(events.map((event) => event.type)).toEqual([
      "context_usage",
      "step_started",
      "reasoning_message_start",
      "reasoning_message_content",
      "reasoning_message_end",
      "context_usage",
      "text_message_start",
      "text_message_content",
      "text_message_end",
      "step_finished",
    ]);
  });

  it("falls back to a non-stream request before the first visible chunk", async () => {
    const adapter = new FakeAdapter();
    const onEvent = vi.fn();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("stream unsupported", { status: 400 }))
      .mockResolvedValueOnce(new Response('{"text":"降级回复"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      fallbackRevealIntervalMs: 0,
      onEvent,
      recordUsage: vi.fn(),
    });

    expect(result.reply).toBe("降级回复");
    expect(adapter.requests.map((request) => request.stream)).toEqual([true, false]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("remembers stream-unavailable fallback across a later retry", async () => {
    const adapter = new FakeAdapter("chatgpt");
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("stream unsupported", { status: 400 }))
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response('{"text":"恢复回复"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 1 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      fallbackRevealIntervalMs: 0,
    });

    expect(result.reply).toBe("恢复回复");
    expect(adapter.requests.map((request) => request.stream)).toEqual([true, false, false]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not start image caption fallback after a quota rejection", async () => {
    const adapter = new FakeAdapter("chatgpt");
    const imageCaptionFallback = vi.fn(async () => [{ role: "user" as const, content: "caption" }]);
    let attempts = 0;
    const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = async () => {
      attempts += 1;
      throw Object.assign(new Error("HTTP 429"), {
        status: 429,
        response: { data: { error: { code: "organization_usage_limit_exceeded" } } },
      });
    };

    await expect(runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 1 },
      adapter,
      messages: [{ role: "user", content: "看这张图" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      imageCaptionFallback,
      streamChat,
    })).rejects.toThrow("HTTP 429");

    expect(attempts).toBe(2);
    expect(imageCaptionFallback).not.toHaveBeenCalled();
  });

  it("does not wait past the remaining chat-run budget", async () => {
    const adapter = new FakeAdapter("chatgpt");
    let attempts = 0;
    const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error("HTTP 503"), {
        status: 503,
        headers: new Headers({ "retry-after": "0.5" }),
      });
    };

    await expect(runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 1 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 100,
      streamChat,
    })).rejects.toThrow("超过本轮剩余时间");
    expect(attempts).toBe(1);
  });

  it("does not retry after a stream has already emitted visible text", async () => {
    const adapter = new FakeAdapter();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"delta":"已经开始"}\n\n'));
          return;
        }
        controller.error(new Error("connection dropped"));
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    await expect(runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
    })).rejects.toThrow("模型服务请求失败");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(adapter.requests).toHaveLength(1);
  });

  it("retries an authentication failure within the configured budget", async () => {
    const status = 401;
    const adapter = new FakeAdapter("chatgpt");
    globalThis.fetch = vi.fn(async () => new Response("request failed", { status })) as unknown as typeof fetch;

    await expect(runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 1 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
    })).rejects.toThrow(`HTTP ${status}`);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(adapter.requests.map((request) => request.stream)).toEqual([true, true]);
  });

  it.each([429, 500])("retries an empty-output transient HTTP %s and reports progress", async (status) => {
    const adapter = new FakeAdapter("chatgpt");
    const events: Array<{ type: string; status?: unknown }> = [];
    let attempts = 0;
    const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = async (input) => {
      adapter.buildStreamRequest(input.request);
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error(`HTTP ${status}`), {
          status,
          headers: new Headers({ "retry-after": "0" }),
        });
      }
      return adapter.parseResponse({ text: "恢复了" });
    };

    const result = await runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 1 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      fallbackRevealIntervalMs: 0,
      streamChat,
      onEvent: (event) => events.push({ type: event.type, status: event.status }),
    });

    expect(result.reply).toBe("恢复了");
    expect(attempts).toBe(2);
    expect(events.filter((event) => event.type === "model_retry").map((event) => (event.status as { phase: string }).phase))
      .toEqual(["waiting", "attempting", "cleared"]);
  });

  it("retries an explicit quota failure returned as HTTP 429 within the configured budget", async () => {
    const adapter = new FakeAdapter("chatgpt");
    let attempts = 0;
    const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = async () => {
      attempts += 1;
      throw Object.assign(new Error("HTTP 429"), {
        status: 429,
        response: { data: { error: { code: "organization_usage_limit_exceeded" } } },
      });
    };

    await expect(runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 1 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      streamChat,
    })).rejects.toThrow("HTTP 429");

    expect(attempts).toBe(2);
  });

  it("does not retry after a reasoning delta became visible", async () => {
    const adapter = new FakeAdapter("chatgpt");
    let attempts = 0;
    const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = async (input) => {
      attempts += 1;
      input.onDelta?.({ type: "reasoning_delta", delta: "正在分析" });
      throw Object.assign(new Error("connection dropped"), { code: "ECONNRESET" });
    };

    await expect(runChatLoop({
      settings: { provider: "chatgpt", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000, modelRequestMaxRetries: 5 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      streamChat,
    })).rejects.toThrow("模型服务请求失败");
    expect(attempts).toBe(1);
  });

  it("merges Anthropic-style usage split across stream events", async () => {
    const adapter = new FakeAdapter();
    globalThis.fetch = vi.fn(async () => new Response([
      'data: {"usage":{"input":9,"output":0}}', "",
      'data: {"delta":"完成","usage":{"input":0,"output":5}}', "",
      "data: [DONE]", "",
    ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      recordUsage: vi.fn(),
    });

    expect(result.totalUsage).toEqual({ input: 9, output: 5 });
  });

  it("persists the normalized visible reply while preserving rawAssistant and thinking", async () => {
    const adapter = new FakeAdapter();
    const sink = fakeSink();
    const rawAssistant = [{ type: "text", text: "provider payload" }];
    // 泄漏的时间戳前缀必须在落盘前被归一剥离，但原始协议块原样保留
    const leakedText = "[2026-09-21 10:00, Asia/Shanghai] visible";

    await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      fallbackRevealIntervalMs: 0,
      recordUsage: vi.fn(),
      transcriptSink: sink,
      streamChat: async () => ({
        assistantMessage: { role: "assistant" as const, content: leakedText, thinking: "reasoning", rawAssistant },
        text: leakedText,
        thinking: "reasoning",
        toolCalls: [],
        finishReason: "stop" as const,
        raw: {},
      }),
    });

    expect(sink.appendAssistant).toHaveBeenCalledWith({
      message: expect.objectContaining({ role: "assistant", content: "visible", thinking: "reasoning", rawAssistant }),
    });
  });

  it("commits a pure generated image before emitting its attachment event", async () => {
    const adapter = new FakeAdapter();
    const attachment = {
      id: "image-1", kind: "image" as const, name: "generated-image.png", filePath: "managed/generated-image.png",
      mime: "image/png", source: "model" as const, byteLength: 20, status: "done" as const,
    };
    const order: string[] = [];
    const sink = fakeSink({ appendAssistant: async () => { order.push("persist"); return "assistant-entry"; } });
    const generatedImageStore = {
      save: vi.fn(async () => attachment),
      deleteConversation: vi.fn(async () => undefined),
      readManagedPng: vi.fn(async () => Buffer.alloc(0)),
    };

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "画一只猫" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      recordUsage: vi.fn(),
      conversationId: "conversation-1",
      assistantTurnId: "assistant-1",
      generatedImageStore,
      transcriptSink: sink,
      onEvent: (event) => { if (event.type === "image_attachments") order.push("image-event"); },
      streamChat: async () => ({
        assistantMessage: { role: "assistant" as const, content: "" },
        text: "",
        toolCalls: [],
        finishReason: "stop" as const,
        raw: {},
        generatedImages: [{ id: "image-1", toolCallId: "tool-1", base64: "AA==", mime: "image/png" as const }],
      }),
    });

    expect(result.reply).toBe("");
    expect(generatedImageStore.save).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      image: expect.objectContaining({ id: "image-1", toolCallId: "tool-1" }),
    });
    expect(sink.appendAssistant).toHaveBeenCalledWith({
      message: expect.objectContaining({ content: "", attachments: [attachment] }),
    });
    expect(order).toEqual(["persist", "image-event"]);
  });

  it("shows a save error instead of an image attachment when generated image persistence fails", async () => {
    const events: string[] = [];
    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter: new FakeAdapter(),
      messages: [{ role: "user", content: "画一只猫" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      recordUsage: vi.fn(),
      generatedImageStore: {
        save: vi.fn(async () => { throw new Error("disk full"); }),
        deleteConversation: vi.fn(async () => undefined),
        readManagedPng: vi.fn(async () => Buffer.alloc(0)),
      },
      onEvent: (event) => events.push(event.type),
      streamChat: async () => ({
        assistantMessage: { role: "assistant" as const, content: "" },
        text: "",
        toolCalls: [],
        finishReason: "stop" as const,
        raw: {},
        generatedImages: [{ id: "image-1", toolCallId: "tool-1", base64: "AA==", mime: "image/png" as const }],
      }),
    });

    expect(result.reply).toContain("图片生成失败，图片未能保存");
    expect(events).not.toContain("image_attachments");
  });

  it("appends an image save error after streamed assistant text", async () => {
    const deltas: string[] = [];
    const streamChat: NonNullable<ChatLoopOptions["streamChat"]> = async (input) => {
      input.onDelta?.({ type: "text_delta", delta: "图片已经生成。" });
      return {
        assistantMessage: { role: "assistant" as const, content: "图片已经生成。" },
        text: "图片已经生成。",
        toolCalls: [],
        finishReason: "stop" as const,
        raw: {},
        generatedImages: [{ id: "image-1", toolCallId: "tool-1", base64: "AA==", mime: "image/png" as const }],
      };
    };

    const result = await runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter: new FakeAdapter(),
      messages: [{ role: "user", content: "画一只猫" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      fallbackRevealIntervalMs: 0,
      recordUsage: vi.fn(),
      generatedImageStore: {
        save: vi.fn(async () => { throw new Error("disk full"); }),
        deleteConversation: vi.fn(async () => undefined),
        readManagedPng: vi.fn(async () => Buffer.alloc(0)),
      },
      onEvent: (event) => { if (event.type === "text_message_content") deltas.push(event.delta); },
      streamChat,
    });

    expect(result.reply).toBe("图片已经生成。\n\n图片生成失败，图片未能保存，请重试。");
    expect(deltas.join("")).toBe(result.reply);
  });

  it("rejects the turn when ChatLoop assistant persistence fails", async () => {
    const adapter = new FakeAdapter();

    await expect(runChatLoop({
      settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
      adapter,
      messages: [{ role: "user", content: "在吗" }],
      soulSystemBaseContent: "SOUL_SYSTEM",
      timeoutMs: 30_000,
      recordUsage: vi.fn(),
      transcriptSink: fakeSink({ appendAssistant: async () => { throw new Error("disk full"); } }),
      streamChat: async () => ({
        assistantMessage: { role: "assistant" as const, content: "好的" },
        text: "好的",
        toolCalls: [],
        finishReason: "stop" as const,
        raw: {},
      }),
    })).rejects.toThrow("disk full");
  });
});

describe("ChatLoop transcript cross-loop continuity", () => {
  /** 跨循环测试占位工具：模型不调用它，仅让 Harness 轮"带工具"语义成立。 */
  function crossLoopTool(): ToolDefinition {
    return {
      id: "cross_loop_probe",
      name: "cross_loop_probe",
      description: "测试占位工具",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
    };
  }

  /** 协调器写入 user 条目的测试替身（生产由 coordinator 负责）。 */
  async function seedUserEntry(
    store: ConversationTranscriptStore,
    conversationId: string,
    input: { runId: string; turnId: string; text: string },
  ): Promise<void> {
    await store.append(conversationId, {
      id: `user-${input.turnId}`,
      at: 1,
      runId: input.runId,
      turnId: input.turnId,
      revision: 1,
      kind: "user",
      payload: { text: input.text },
    });
  }

  it("feeds a chat turn's canonical assistant into the next tools-enabled round", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-crossloop-a-"));
    const store = new ConversationTranscriptStore(root);
    const conversationId = "conv-cross-chat-work";
    try {
      await seedUserEntry(store, conversationId, { runId: "run-chat-1", turnId: "turn-1", text: "在吗" });

      // 上一轮：ChatLoop 提交 canonical assistant（泄漏时间戳被归一剥离）
      const chatSink = createTranscriptSink({ store, conversationId, runId: "run-chat-1" });
      await runChatLoop({
        settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
        adapter: new FakeAdapter(),
        messages: [{ role: "user", content: "在吗" }],
        soulSystemBaseContent: "SOUL_SYSTEM",
        timeoutMs: 30_000,
        fallbackRevealIntervalMs: 0,
        recordUsage: vi.fn(),
        transcriptSink: chatSink,
        streamChat: async () => ({
          assistantMessage: {
            role: "assistant" as const,
            content: "[2026-09-21 10:00, Asia/Shanghai] 你好呀",
            thinking: "reasoning",
            rawAssistant: [{ type: "text", text: "provider payload" }],
          },
          text: "[2026-09-21 10:00, Asia/Shanghai] 你好呀",
          toolCalls: [],
          finishReason: "stop" as const,
          raw: {},
        }),
      });

      // 轨迹层：物化得到 user + canonical assistant（归一内容，原始字段保留）
      const snapshot = await store.read(conversationId);
      const materialized = materializeTranscript(snapshot.entries, { get: () => null });
      expect(materialized.messages).toEqual([
        { role: "user", content: "在吗" },
        expect.objectContaining({ role: "assistant", content: "你好呀", thinking: "reasoning" }),
      ]);

      // 下一轮：追加新 user，喂给带工具的 Harness 轮，模型请求必须收到完整 canonical 上下文
      fakeStreamChatWithSdk.mockResolvedValueOnce({
        assistantMessage: { role: "assistant", content: "已接上对话。" },
        text: "已接上对话。",
        toolCalls: [],
        finishReason: "stop",
        raw: {},
      });
      const workSink = createTranscriptSink({ store, conversationId, runId: "run-work-1" });
      const result = await runCyreneHarness({
        systemPrompt: "you are a test agent",
        messages: [...materialized.messages, { role: "user", content: "帮我查天气" }],
        tools: [crossLoopTool()],
        vendorConfig: {
          provider: "test",
          baseUrl: "https://test",
          model: "m",
          apiKey: "k",
        } as unknown as Parameters<typeof runCyreneHarness>[0]["vendorConfig"],
        transcriptSink: workSink,
      });
      expect(result.finalAnswer).toBe("已接上对话。");

      const requestMessages = (fakeStreamChatWithSdk.mock.calls[0][0] as {
        request: { messages: Array<{ role: string; content: string }> };
      }).request.messages;
      expect(requestMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "在吗" }),
        expect.objectContaining({ role: "assistant", content: "你好呀" }),
        expect.objectContaining({ role: "user", content: "帮我查天气" }),
      ]));

      // 双向连续性：两轮 assistant 共存于同一权威轨迹
      const finalSnapshot = await store.read(conversationId);
      expect(finalSnapshot.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("feeds a tools round's tool messages into the next tools-disabled chat turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-crossloop-b-"));
    const store = new ConversationTranscriptStore(root);
    const conversationId = "conv-cross-work-chat";
    try {
      await seedUserEntry(store, conversationId, { runId: "run-work-1", turnId: "turn-1", text: "查一下天气" });

      // 上一轮：用真实 sink 复现带工具的 Harness 写入（提交路径已由 Task 4 覆盖）
      const workSink = createTranscriptSink({ store, conversationId, runId: "run-work-1" });
      const assistantEntryId = await workSink.appendAssistant({
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "get_weather", arguments: JSON.stringify({ city: "上海" }) }],
        },
        roundId: "round-1",
      });
      await workSink.appendToolResult({
        assistantEntryId,
        message: { role: "tool", toolCallId: "call-1", name: "get_weather", content: "上海 晴 26℃" },
        outcome: "success",
        roundId: "round-1",
      });

      // 轨迹层：物化得到 user + assistant(toolCalls) + 工具结果
      const snapshot = await store.read(conversationId);
      const materialized = materializeTranscript(snapshot.entries, { get: () => null });
      expect(materialized.messages).toEqual([
        { role: "user", content: "查一下天气" },
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ id: "call-1", name: "get_weather" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "上海 晴 26℃" }),
      ]);

      // 下一轮：关闭工具的 ChatLoop 轮收到完整工具历史
      let chatRequestMessages: ChatMessage[] = [];
      await runChatLoop({
        settings: { provider: "test", baseUrl: "https://test", model: "m", apiKey: "k", contextWindowTokens: 256000 },
        adapter: new FakeAdapter(),
        messages: [...materialized.messages, { role: "user", content: "谢谢，再聊聊" }],
        soulSystemBaseContent: "SOUL_SYSTEM",
        timeoutMs: 30_000,
        fallbackRevealIntervalMs: 0,
        recordUsage: vi.fn(),
        streamChat: async (input) => {
          chatRequestMessages = input.request.messages;
          return {
            assistantMessage: { role: "assistant" as const, content: "好的" },
            text: "好的",
            toolCalls: [],
            finishReason: "stop" as const,
            raw: {},
          };
        },
      });

      expect(chatRequestMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "上海 晴 26℃" }),
        expect.objectContaining({ role: "user", content: "谢谢，再聊聊" }),
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
