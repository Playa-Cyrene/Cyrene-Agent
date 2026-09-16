import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "../../agent-runtime-error";
import { AnthropicAdapter } from "../anthropic-adapter";
import { OpenAICompatAdapter } from "../openai-adapter";
import { ResponsesAdapter } from "../responses-adapter";
import type { ChatRequest, ProviderCapability, VendorConfig } from "../types";
import { streamChatWithSdk, type SdkStreamRuntimeDeps } from "./runtime";
import type { UnifiedStreamDelta } from "./types";

const openAICapability: ProviderCapability = {
  id: "chatgpt",
  displayName: "OpenAI",
  transport: "openai",
  baseUrl: "https://api.openai.com/v1",
  authStyle: "bearer",
  defaultModel: "gpt-test",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "reasoning_content",
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: true,
};

const anthropicCapability: ProviderCapability = {
  ...openAICapability,
  id: "claude",
  displayName: "Claude",
  transport: "anthropic",
  authStyle: "x-api-key",
  thinkingField: "thinking",
};

const request: ChatRequest = {
  model: "model-test",
  messages: [{ role: "user", content: "hi" }],
};

const openAIConfig: VendorConfig = {
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "model-test",
  apiKey: "sk-test",
  explicitTransport: "openai",
};

const anthropicConfig: VendorConfig = {
  provider: "Claude",
  baseUrl: "https://api.anthropic.com",
  model: "model-test",
  apiKey: "sk-test",
  explicitTransport: "anthropic",
};

const responsesCapability: ProviderCapability = {
  ...openAICapability,
  transport: "responses",
};

const responsesConfig: VendorConfig = {
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "model-test",
  apiKey: "sk-test",
  explicitTransport: "responses",
};

async function* iterableOf(...values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value;
}

function unusedFactory(): never {
  throw new Error("unexpected transport factory");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("streamChatWithSdk", () => {
  it("streams OpenAI deltas before returning the accumulated response", async () => {
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    const seen: UnifiedStreamDelta[] = [];
    let factoryInput: Parameters<SdkStreamRuntimeDeps["openAI"]>[0] | undefined;
    const deps: SdkStreamRuntimeDeps = {
      openAI: async (input) => {
        factoryInput = input;
        return iterableOf(
          { choices: [{ delta: { reasoning_content: "think" }, finish_reason: null }] },
          { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
        );
      },
      responses: unusedFactory,
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => seen.push(delta),
    }, deps);

    expect(factoryInput?.body).toMatchObject({ model: "model-test", stream: true });
    expect(factoryInput?.client).toMatchObject({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      maxRetries: 0,
    });
    expect(factoryInput?.signal.aborted).toBe(false);
    expect(seen).toEqual([
      { type: "reasoning_delta", delta: "think" },
      { type: "text_delta", delta: "answer" },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "finish", reason: "stop" },
    ]);
    expect(response).toMatchObject({
      text: "answer",
      thinking: "think",
      finishReason: "stop",
      usage: { input: 5, output: 2 },
    });
  });

  it("promotes leading <think> content from text deltas into reasoning without leaking it into the answer", async () => {
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    const seen: UnifiedStreamDelta[] = [];
    const deps: SdkStreamRuntimeDeps = {
      openAI: async () => iterableOf(
        { choices: [{ delta: { content: "<thi" }, finish_reason: null }] },
        { choices: [{ delta: { content: "nk>先检查项目" }, finish_reason: null }] },
        { choices: [{ delta: { content: "结构</think>找到结果" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ),
      responses: unusedFactory,
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => seen.push(delta),
    }, deps);

    expect(seen
      .filter((delta) => delta.type === "reasoning_delta")
      .map((delta) => delta.delta)
      .join(""))
      .toBe("先检查项目结构");
    expect(seen
      .filter((delta) => delta.type === "text_delta")
      .map((delta) => delta.delta)
      .join(""))
      .toBe("找到结果");
    expect(response).toMatchObject({
      text: "找到结果",
      thinking: "先检查项目结构",
    });
  });

  it("delivers Anthropic raw deltas before asking the SDK for finalMessage", async () => {
    const adapter = new AnthropicAdapter("claude", anthropicCapability);
    const order: string[] = [];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: unusedFactory,
      anthropic: async () => ({
        events: iterableOf(
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ),
        finalMessage: async () => {
          order.push("finalMessage");
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2 },
            content: [
              { type: "thinking", thinking: "think", signature: "sig" },
              { type: "text", text: "answer" },
            ],
          };
        },
      }),
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: anthropicConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => {
        if (delta.type === "reasoning_delta" || delta.type === "text_delta") order.push(delta.type);
      },
    }, deps);

    expect(order).toEqual(["reasoning_delta", "text_delta", "finalMessage"]);
    expect(response.assistantMessage.rawAssistant).toEqual([
      { type: "thinking", thinking: "think", signature: "sig" },
      { type: "text", text: "answer" },
    ]);
  });

  it("delivers each Anthropic text delta while the provider stream is still open", async () => {
    const adapter = new AnthropicAdapter("claude", anthropicCapability);
    let releaseSecondChunk!: () => void;
    let releaseStreamEnd!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
    const streamEndGate = new Promise<void>((resolve) => { releaseStreamEnd = resolve; });
    const seen: string[] = [];

    async function* gatedEvents(): AsyncIterable<unknown> {
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的伙伴，" } };
      await secondChunkGate;
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "人家先去摸清这边项目的底，" } };
      await streamEndGate;
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "再决定怎么跑测试♪" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
      yield { type: "message_stop" };
    }

    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: unusedFactory,
      anthropic: async () => ({
        events: gatedEvents(),
        finalMessage: async () => ({
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
          content: [{ type: "text", text: "好的伙伴，人家先去摸清这边项目的底，再决定怎么跑测试♪" }],
        }),
      }),
    };

    const running = streamChatWithSdk({
      adapter,
      request,
      config: anthropicConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => {
        if (delta.type === "text_delta") seen.push(delta.delta);
      },
    }, deps);

    await vi.waitFor(() => expect(seen).toEqual(["好的伙伴，"]));
    releaseSecondChunk();
    await vi.waitFor(() => expect(seen).toEqual([
      "好的伙伴，",
      "人家先去摸清这边项目的底，",
    ]));

    releaseStreamEnd();
    await running;
    expect(seen).toEqual([
      "好的伙伴，",
      "人家先去摸清这边项目的底，",
      "再决定怎么跑测试♪",
    ]);
  });

  it("streams Responses deltas and attaches rawAssistant from the terminal event", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const seen: UnifiedStreamDelta[] = [];
    let factoryInput: Parameters<SdkStreamRuntimeDeps["responses"]>[0] | undefined;
    const output = [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "answer" }] },
    ];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async (input) => {
        factoryInput = input;
        return iterableOf(
          { type: "response.reasoning_summary_text.delta", delta: "think" },
          { type: "response.output_text.delta", delta: "answer" },
          {
            type: "response.completed",
            response: { id: "resp_1", output, usage: { input_tokens: 5, output_tokens: 2 } },
          },
        );
      },
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: responsesConfig,
      timeoutMs: 1_000,
      onDelta: (delta) => seen.push(delta),
    }, deps);

    expect(factoryInput?.body).toMatchObject({ model: "model-test", stream: true, store: false });
    expect(factoryInput?.client).toMatchObject({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      maxRetries: 0,
    });
    expect(seen).toEqual([
      { type: "reasoning_delta", delta: "think" },
      { type: "text_delta", delta: "answer" },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "finish", reason: "stop" },
    ]);
    expect(response).toMatchObject({
      text: "answer",
      thinking: "think",
      finishReason: "stop",
      usage: { input: 5, output: 2 },
    });
    expect(response.assistantMessage.rawAssistant).toEqual(output);
  });

  it("captures response.incomplete as a terminal event (max_output_tokens → length)", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const output = [{ type: "message", content: [{ type: "output_text", text: "partial" }] }];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async () => iterableOf(
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.incomplete",
          response: {
            output,
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      ),
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: responsesConfig,
      timeoutMs: 1_000,
    }, deps);

    expect(response).toMatchObject({ text: "partial", finishReason: "length", usage: { input: 3, output: 1 } });
    expect(response.assistantMessage.rawAssistant).toEqual(output);
  });

  it("omits rawAssistant when the stream breaks without a terminal event", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async () => iterableOf(
        { type: "response.output_text.delta", delta: "partial" },
      ),
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: responsesConfig,
      timeoutMs: 1_000,
    }, deps);

    expect(response).toMatchObject({ text: "partial", finishReason: "unknown" });
    expect(response.assistantMessage.rawAssistant).toBeUndefined();
  });

  it("closes unclosed Responses tool calls on finish and replays them via rawAssistant", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const output = [
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"BJ"}' },
    ];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async () => iterableOf(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"city"' },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: ':"BJ"}' },
        {
          type: "response.completed",
          response: { output, usage: { input_tokens: 8, output_tokens: 4 } },
        },
      ),
      anthropic: unusedFactory,
    };

    const response = await streamChatWithSdk({
      adapter,
      request,
      config: responsesConfig,
      timeoutMs: 1_000,
    }, deps);

    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", arguments: '{"city":"BJ"}' },
    ]);
    expect(response.assistantMessage.rawAssistant).toEqual(output);
  });

  it("does not create a request deadline when timeoutMs is zero", async () => {
    vi.useFakeTimers();
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    const deps: SdkStreamRuntimeDeps = {
      openAI: async () => ({
        [Symbol.asyncIterator]() {
          let sent = false;
          return {
            next: () => new Promise<IteratorResult<unknown>>((resolve) => {
              setTimeout(() => {
                if (sent) resolve({ done: true, value: undefined });
                else {
                  sent = true;
                  resolve({
                    done: false,
                    value: { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
                  });
                }
              }, 10);
            }),
          };
        },
      }),
      responses: unusedFactory,
      anthropic: unusedFactory,
    };

    const pending = streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 0,
    }, deps);

    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({ text: "ok" });
  });

  it("turns only the runtime-owned deadline into E_MODEL_REQUEST_TIMEOUT", async () => {
    vi.useFakeTimers();
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    let capturedSignal: AbortSignal | undefined;
    const deps: SdkStreamRuntimeDeps = {
      openAI: async ({ signal }) => {
        capturedSignal = signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            };
          },
        };
      },
      responses: unusedFactory,
      anthropic: unusedFactory,
    };
    const pending = streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 25,
    }, deps);
    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<AgentRuntimeError>>({ code: "E_MODEL_REQUEST_TIMEOUT" }),
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("preserves caller cancellation instead of classifying it as timeout", async () => {
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    const caller = new AbortController();
    const cancelled = new DOMException("user cancelled", "AbortError");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const deps: SdkStreamRuntimeDeps = {
      openAI: async ({ signal }) => {
        markStarted?.();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
            };
          },
        };
      },
      responses: unusedFactory,
      anthropic: unusedFactory,
    };
    const pending = streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 10_000,
      signal: caller.signal,
    }, deps);

    await started;
    caller.abort(cancelled);

    await expect(pending).rejects.toBe(cancelled);
  });

  it("clears the deadline after a successful stream", async () => {
    vi.useFakeTimers();
    const adapter = new OpenAICompatAdapter("chatgpt", openAICapability);
    let capturedSignal: AbortSignal | undefined;
    const deps: SdkStreamRuntimeDeps = {
      openAI: async ({ signal }) => {
        capturedSignal = signal;
        return iterableOf({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
      },
      responses: unusedFactory,
      anthropic: unusedFactory,
    };

    await streamChatWithSdk({
      adapter,
      request,
      config: openAIConfig,
      timeoutMs: 25,
    }, deps);
    await vi.advanceTimersByTimeAsync(100);

    expect(capturedSignal?.aborted).toBe(false);
  });
});
