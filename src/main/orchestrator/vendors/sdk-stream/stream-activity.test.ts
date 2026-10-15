import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../anthropic-adapter";
import { OpenAICompatAdapter } from "../openai-adapter";
import { ResponsesAdapter } from "../responses-adapter";
import { runModelRequestWithRetry } from "../model-retry-runner";
import type { ChatResponse, ChatVendorAdapter, ProviderCapability, VendorConfig } from "../types";
import { streamChatWithSdk } from "./runtime";

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const capability: ProviderCapability = {
  id: "chatgpt", displayName: "OpenAI", transport: "openai",
  baseUrl: "https://api.openai.com/v1", authStyle: "bearer", defaultModel: "model-test",
  supportsTools: true, supportsThinking: true, thinkingField: "reasoning_content",
  cacheStrategy: "none", testStrategy: "text",
};

const anthropicCapability: ProviderCapability = {
  ...capability, id: "claude", displayName: "Claude", transport: "anthropic",
  baseUrl: "https://api.anthropic.com", authStyle: "x-api-key", thinkingField: "thinking",
};

interface StreamFixture {
  name: string;
  adapter: ChatVendorAdapter;
  start: string;
  activity: string;
  complete: string;
}

const fixtures: StreamFixture[] = [
  {
    name: "OpenAI Chat Completions 的 SSE 保活注释",
    adapter: new OpenAICompatAdapter("chatgpt", capability),
    start: ": connected\n\n", activity: ": still working\n\n",
    complete: 'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n',
  },
  {
    name: "Responses 的原生网页搜索进度",
    adapter: new ResponsesAdapter("chatgpt", { ...capability, transport: "responses" }),
    start: sse("response.created", { type: "response.created", response: { id: "resp-test", model: "model-test", created_at: 1 } }),
    activity: sse("response.web_search_call.searching", {
      type: "response.web_search_call.searching", output_index: 0, item_id: "search-test",
    }),
    complete: sse("response.output_item.added", { type: "response.output_item.added", output_index: 0,
      item: { id: "message-test", type: "message", role: "assistant", content: [] } })
      + sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "message-test", output_index: 0, content_index: 0, delta: "done" })
      + sse("response.completed", {
        type: "response.completed",
        response: {
          id: "resp-test", status: "completed",
          output: [{ id: "message-test", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
  },
  {
    name: "Anthropic SDK 会过滤的 ping",
    adapter: new AnthropicAdapter("claude", anthropicCapability),
    start: sse("message_start", {
      type: "message_start", message: {
        id: "message-test", type: "message", role: "assistant", model: "model-test", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    activity: sse("ping", { type: "ping" }),
    complete: sse("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    }) + sse("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" },
    }) + sse("content_block_stop", { type: "content_block_stop", index: 0 })
      + sse("message_delta", {
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) + sse("message_stop", { type: "message_stop" }),
  },
];

/** 仅替换网络：保留真实 SDK、事件适配器和空闲计时器。 */
function installNetwork(fixture: StreamFixture, options: { complete?: boolean; emptyActivity?: boolean } = {}) {
  const requests: Request[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = () => {
          stopped = true;
          for (const timer of timers) clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          if (stopped) return;
          cleanup();
          controller.error(new DOMException("aborted", "AbortError"));
        };
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) { abort(); return; }
        if (fixture.start) controller.enqueue(encoder.encode(fixture.start));
        for (const at of [40, 80]) {
          timers.push(setTimeout(() => {
            if (!stopped) controller.enqueue(options.emptyActivity ? new Uint8Array() : encoder.encode(fixture.activity));
          }, at));
        }
        if (options.complete !== false) {
          timers.push(setTimeout(() => {
            if (stopped) return;
            controller.enqueue(encoder.encode(fixture.complete));
            controller.close();
            cleanup();
          }, 120));
        }
      },
      cancel() { stopped = true; for (const timer of timers) clearTimeout(timer); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "request-id": "test" } });
  });
  return requests;
}

function startRequest(fixture: StreamFixture, options: { signal?: AbortSignal; totalTimeoutMs?: number; baseUrl?: string } = {}) {
  const config: VendorConfig = {
    provider: fixture.adapter.id, baseUrl: options.baseUrl ?? fixture.adapter.capability.baseUrl,
    model: "model-test", apiKey: "sk-test", explicitTransport: fixture.adapter.transport,
  };
  let visible = "";
  const pending = runModelRequestWithRetry((attempt) => streamChatWithSdk({
    adapter: fixture.adapter, request: { model: "model-test", messages: [{ role: "user", content: "hi" }] },
    config, timeoutMs: options.totalTimeoutMs ?? 0, signal: attempt.signal,
    onStreamActivity: attempt.onStreamActivity,
    onDelta(delta) {
      attempt.onStreamActivity();
      if ((delta.type === "text_delta" || delta.type === "reasoning_delta") && delta.delta) {
        visible += delta.delta;
        attempt.onVisibleDelta();
      }
    },
  }), { provider: fixture.adapter.id, model: "model-test", maxRetries: 0, idleTimeoutMs: 100, signal: options.signal });
  // 立即接住拒绝，避免推进假时钟期间的未处理异常。
  const outcome = pending.then(
    (response): { response: ChatResponse; error?: never } => ({ response }),
    (error): { response?: never; error: unknown } => ({ error }),
  );
  return { outcome, visible: () => visible };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("收到响应数据即重置空闲计时", () => {
  it.each(fixtures)("$name 能让超过空闲时限的请求正常完成", async (fixture) => {
    const requests = installNetwork(fixture);
    const run = startRequest(fixture);
    await vi.advanceTimersByTimeAsync(90);
    expect(run.visible()).toBe("");
    await vi.advanceTimersByTimeAsync(40);
    expect(await run.outcome).toMatchObject({ response: { text: "done" } });
    expect(requests).toHaveLength(1);
  });

  it("自定义 Anthropic 地址仍然生效并接收保活数据", async () => {
    const fixture = fixtures[2]!;
    const requests = installNetwork(fixture);
    const run = startRequest(fixture, { baseUrl: "https://proxy.test/custom/messages" });
    await vi.advanceTimersByTimeAsync(130);
    expect(await run.outcome).toMatchObject({ response: { text: "done" } });
    expect(requests[0]?.url).toBe("https://proxy.test/custom/messages");
  });

  it("持续收到空数据块不能延长空闲期限", async () => {
    const fixture = { ...fixtures[1]!, start: "" };
    installNetwork(fixture, { complete: false, emptyActivity: true });
    const run = startRequest(fixture);
    await vi.advanceTimersByTimeAsync(110);
    expect(await run.outcome).toMatchObject({ error: { code: "E_MODEL_REQUEST_TIMEOUT" } });
  });

  it("收到进度后断流，仍在最后一次数据的空闲期限结束时中断", async () => {
    installNetwork(fixtures[1]!, { complete: false });
    const run = startRequest(fixtures[1]!);
    await vi.advanceTimersByTimeAsync(170);
    let settled = false;
    void run.outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await run.outcome).toMatchObject({ error: { code: "E_MODEL_REQUEST_TIMEOUT" } });
  });

  it("持续保活不能延长显式设置的请求总时限", async () => {
    installNetwork(fixtures[1]!, { complete: false });
    const run = startRequest(fixtures[1]!, { totalTimeoutMs: 75 });
    await vi.advanceTimersByTimeAsync(90);
    expect(await run.outcome).toMatchObject({ error: { code: "E_MODEL_REQUEST_TIMEOUT" } });
  });

  it("持续保活期间用户取消仍然立即中断", async () => {
    const controller = new AbortController();
    const requests = installNetwork(fixtures[1]!, { complete: false });
    const run = startRequest(fixtures[1]!, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(60);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await run.outcome).toMatchObject({ error: { name: "AbortError" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(true);
  });
});
