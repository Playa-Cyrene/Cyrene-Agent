import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "../../agent-runtime-error";
import { AnthropicAdapter } from "../anthropic-adapter";
import { OpenAICompatAdapter } from "../openai-adapter";
import { ResponsesAdapter } from "../responses-adapter";
import { runModelRequestWithRetry } from "../model-retry-runner";
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
  it("keeps native search progress alive without treating it as visible output", async () => {
    vi.useFakeTimers();
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const visible = vi.fn();
    const statuses = vi.fn();
    const factory = vi.fn(async ({ signal }: Parameters<SdkStreamRuntimeDeps["responses"]>[0]) => {
      return (async function* () {
        for (const type of ["response.created", "response.web_search_call.in_progress", "response.web_search_call.searching"]) {
          await new Promise((resolve) => setTimeout(resolve, 35_000));
          if (signal.aborted) throw signal.reason;
          yield { type };
        }
        await new Promise((resolve) => setTimeout(resolve, 35_000));
        if (signal.aborted) throw signal.reason;
        yield { type: "response.completed", response: { status: "completed", output: [] } };
      })();
    });
    const result = runModelRequestWithRetry((attempt) => streamChatWithSdk({
      adapter, request, config: responsesConfig, timeoutMs: 300_000, signal: attempt.signal,
      onStreamActivity: attempt.onStreamActivity,
      onDelta: (delta) => {
        if (delta.type === "text_delta" || delta.type === "reasoning_delta") {
          visible();
          attempt.onVisibleDelta();
        }
      },
    }, { responses: factory, openAI: unusedFactory, anthropic: unusedFactory }), {
      provider: "chatgpt", model: request.model, maxRetries: 0, idleTimeoutMs: 60_000, onStatus: statuses,
    });
    const checked = expect(result).resolves.toMatchObject({ text: "" });
    await vi.advanceTimersByTimeAsync(140_000);
    await checked;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(visible).not.toHaveBeenCalled();
    expect(statuses).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["openai", "responses", "anthropic"] as const)("reports raw %s activity even when there is no display delta", async (transport) => {
    const activity = vi.fn();
    const adapter = transport === "openai" ? new OpenAICompatAdapter("chatgpt", openAICapability)
      : transport === "responses" ? new ResponsesAdapter("chatgpt", responsesCapability)
        : new AnthropicAdapter("claude", anthropicCapability);
    await streamChatWithSdk({
      adapter, request, config: transport === "anthropic" ? anthropicConfig : openAIConfig,
      timeoutMs: 1_000, onStreamActivity: activity,
    }, {
      openAI: async () => iterableOf({ choices: [] }),
      responses: async () => iterableOf(
        { type: "response.web_search_call.searching" },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ),
      anthropic: async () => ({ events: iterableOf({ type: "ping" }), finalMessage: async () => ({ content: [] }) }),
    });
    expect(activity).toHaveBeenCalledTimes(transport === "responses" ? 2 : 1);
  });

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

  it("fails the Responses stream when it ends without a terminal event", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async () => iterableOf(
        { type: "response.output_text.delta", delta: "partial" },
      ),
      anthropic: unusedFactory,
    };

    await expect(streamChatWithSdk({
      adapter,
      request,
      config: responsesConfig,
      timeoutMs: 1_000,
    }, deps)).rejects.toMatchObject({
      code: "E_MODEL_RESPONSE_PARSE_FAILED",
      message: expect.stringContaining("未收到终态事件"),
    });
  });

  it("fails when a Responses terminal event has no output array", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async () => iterableOf({ type: "response.completed", response: { id: "resp_1" } }),
      anthropic: unusedFactory,
    };

    await expect(streamChatWithSdk({
      adapter,
      request,
      config: responsesConfig,
      timeoutMs: 1_000,
    }, deps)).rejects.toMatchObject({
      code: "E_MODEL_RESPONSE_PARSE_FAILED",
      message: expect.stringContaining("缺少 output 项"),
    });
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

  it("recovers a Responses tool call whose name arrives only in the terminal item", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const output = [
      { type: "reasoning", summary: [] },
      {
        type: "function_call",
        call_id: "call-image",
        name: "subscription-oauth_generate_image",
        arguments: '{"prompt":"Cyrene"}',
      },
    ];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      responses: async () => iterableOf(
        {
          type: "response.output_item.added",
          output_index: 8,
          item: { type: "function_call", call_id: "call-image", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 8,
          delta: '{"prompt":',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 8,
          arguments: '{"prompt":"Cyrene"}',
        },
        {
          type: "response.output_item.done",
          output_index: 8,
          item: output[1],
        },
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

    expect(response.toolCalls).toEqual([{
      id: "call-image",
      name: "subscription-oauth_generate_image",
      arguments: '{"prompt":"Cyrene"}',
    }]);
    expect(response.assistantMessage.rawAssistant).toEqual(output);
  });

  it("recovers a delayed function name at index 18 and retains the call for the next tool round", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const reasoning = { type: "reasoning", id: "rs-image", encrypted_content: "opaque-test-context", summary: [] };
    const call = { type: "function_call", id: "fc-image", call_id: "call-image", arguments: "" };
    const args = '{"prompt":"portrait"}';
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      anthropic: unusedFactory,
      responses: async () => iterableOf(
        { type: "response.output_item.done", output_index: 17, item: reasoning },
        { type: "response.output_item.added", output_index: 18, item: call },
        { type: "response.function_call_arguments.delta", output_index: 18, item_id: call.id, delta: args },
        { type: "response.function_call_arguments.done", output_index: 18, item_id: call.id, name: "subscription-oauth_generate_image", arguments: args },
        { type: "response.completed", response: { status: "completed", output: [reasoning] } },
      ),
    };
    const response = await streamChatWithSdk({ adapter, request, config: responsesConfig, timeoutMs: 1_000 }, deps);
    expect(response.toolCalls).toEqual([{
      id: call.call_id, name: "subscription-oauth_generate_image", arguments: args,
    }]);
    expect(response.assistantMessage.rawAssistant).toEqual([
      reasoning, { ...call, name: "subscription-oauth_generate_image", arguments: args },
    ]);
  });

  it("matches parallel compacted terminal calls by item ID when call_id was delayed", async () => {
    const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
    const output = [
      { type: "function_call", id: "fc-second", call_id: "call-second", name: "second", arguments: '{"value":2}' },
      { type: "function_call", id: "fc-first", call_id: "call-first", name: "first", arguments: '{"value":1}' },
    ];
    const deps: SdkStreamRuntimeDeps = {
      openAI: unusedFactory,
      anthropic: unusedFactory,
      responses: async () => iterableOf(
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-first" } },
        { type: "response.output_item.added", output_index: 18, item: { type: "function_call", id: "fc-second" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-first", delta: '{"value":1}' },
        { type: "response.function_call_arguments.delta", output_index: 18, item_id: "fc-second", delta: '{"value":2}' },
        { type: "response.completed", response: { status: "completed", output } },
      ),
    };
    const response = await streamChatWithSdk({ adapter, request, config: responsesConfig, timeoutMs: 1_000 }, deps);
    expect(response.toolCalls).toEqual([
      { id: "call-first", name: "first", arguments: '{"value":1}' },
      { id: "call-second", name: "second", arguments: '{"value":2}' },
    ]);
    expect(response.assistantMessage.rawAssistant).toEqual(output);
  });

  it.each(["missing call_id", "missing terminal marker", "incomplete arguments", "terminal incomplete"])(
    "still rejects an actually incomplete Responses call: %s", async (failure) => {
      const adapter = new ResponsesAdapter("chatgpt", responsesCapability);
      const call = { type: "function_call", id: "fc-only", name: "generate_image",
        ...(failure !== "missing call_id" ? { call_id: "call-only" } : {}), arguments: "" };
      const args = failure === "incomplete arguments" ? '{"prompt":' : '{"prompt":"x"}';
      const events = [
        { type: "response.output_item.added", output_index: 18, item: call },
        { type: "response.function_call_arguments.delta", output_index: 18, item_id: call.id, delta: args },
        ...(failure === "missing terminal marker" ? [] : [{
          type: "response.function_call_arguments.done", output_index: 18, item_id: call.id, name: call.name, arguments: args,
        }]),
        { type: "response.completed", response: { status: "completed", output: failure === "terminal incomplete"
          ? [{ ...call, arguments: args, status: "incomplete" }] : [] } },
      ];
      await expect(streamChatWithSdk({ adapter, request, config: responsesConfig, timeoutMs: 1_000 }, {
        openAI: unusedFactory, anthropic: unusedFactory, responses: async () => iterableOf(...events),
      })).rejects.toMatchObject({ modelFailure: { vendorCode: "E_TOOL_CALL_INCOMPLETE" } });
    },
  );

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
