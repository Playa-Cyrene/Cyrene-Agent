import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdapterForConfig } from "../index";
import type { Transport, VendorConfig } from "../types";
import { streamChatWithSdk } from "./runtime";
import { responseBody, sseResponse, streamEvents, weatherTool } from "./model-fixtures";
import type { UnifiedStreamDelta } from "./types";

const transports: Transport[] = ["openai", "responses", "anthropic"];
function setup(transport: Transport) {
  const config: VendorConfig = { provider: transport === "anthropic" ? "claude" : "chatgpt", model: "model-test",
    baseUrl: "https://example.test/v1", apiKey: "test-key", explicitTransport: transport };
  return { adapter: getAdapterForConfig(config), config,
    request: { model: config.model, messages: [{ role: "user" as const, content: "hi" }], tools: [weatherTool] }, timeoutMs: 2000 };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("统一 AI SDK 流执行", () => {
  it.each(transports)("%s 归一化文本、推理、工具参数和用量", async transport => {
    const seen: UnifiedStreamDelta[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents(transport, { tool: true, reasoning: true }), transport === "openai")));
    const response = await streamChatWithSdk({ ...setup(transport), onDelta: delta => seen.push(delta) });
    expect(response).toMatchObject({ text: "answer", thinking: "reason", finishReason: "tool_calls",
      toolCalls: [{ id: "call_test", name: "weather", arguments: '{"city":"北京"}' }], usage: { input: 3, output: 2 } });
    expect(seen).toContainEqual({ type: "text_delta", delta: "answer" });
    expect(seen.filter(delta => delta.type === "finish")).toHaveLength(1);
    expect(response.assistantMessage.providerReplay?.origin.transport).toBe(transport);
    expect(response.assistantMessage.rawAssistant).toBeUndefined();
  });

  it("文本中的 think 标签只进入推理展示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents("openai", { text: "<think>分析</think>答案" }), true)));
    const response = await streamChatWithSdk(setup("openai"));
    expect(response.text).toBe("答案");
    expect(response.thinking).toBe("分析");
  });

  it("Anthropic 流尚未结束时就交付文本增量", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const events = streamEvents("anthropic");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { streamController = controller; } }), {
      headers: { "content-type": "text/event-stream" },
    })));
    const seen: UnifiedStreamDelta[] = [];
    const pending = streamChatWithSdk({ ...setup("anthropic"), onDelta: delta => seen.push(delta) });
    await vi.waitFor(() => expect(streamController).toBeDefined());
    for (const event of events.slice(0, 3)) streamController.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    await vi.waitFor(() => expect(seen).toContainEqual({ type: "text_delta", delta: "answer" }));
    for (const event of events.slice(3)) streamController.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    streamController.close();
    expect((await pending).text).toBe("answer");
  });

  it("Responses 输出预算截断按 length 结算", async () => {
    const events = streamEvents("responses");
    events[events.length - 1] = { type: "response.incomplete", response: { ...responseBody("responses"),
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    expect(await streamChatWithSdk(setup("responses"))).toMatchObject({ text: "answer", finishReason: "length" });
  });

  it("Responses 缺终态不能提交成功回复", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(streamEvents("responses").slice(0, -1))));
    await expect(streamChatWithSdk(setup("responses"))).rejects.toThrow();
  });

  it("Responses 终态缺 output 不能提交成功回复", async () => {
    const events = streamEvents("responses");
    events[events.length - 1] = { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } };
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    await expect(streamChatWithSdk(setup("responses"))).rejects.toThrow();
  });

  it("Responses 未完成的工具调用不能执行", async () => {
    const events = streamEvents("responses", { tool: true });
    for (const event of events) {
      if ((event.item as any)?.type === "function_call") (event.item as any).status = "incomplete";
      if (event.type === "response.completed") ((event.response as any).output as any[]).find(item => item.type === "function_call").status = "incomplete";
    }
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    await expect(streamChatWithSdk(setup("responses"))).rejects.toThrow();
  });

  it("Responses 只在终态出现的完整工具仍能恢复", async () => {
    const events = streamEvents("responses");
    events[events.length - 1] = { type: "response.completed", response: responseBody("responses", { tool: true }) };
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    const seen: UnifiedStreamDelta[] = [];
    await expect(streamChatWithSdk({ ...setup("responses"), onDelta: delta => seen.push(delta) })).resolves.toMatchObject({ toolCalls: [{ id: "call_test", name: "weather", arguments: '{"city":"北京"}' }] });
    expect(seen.at(-1)?.type).toBe("finish");
  });

  it("兼容接口的 thinking 推理别名不会丢失或重复", async () => {
    const events = streamEvents("openai", { reasoning: true });
    (events[0] as any).choices[0].delta = { thinking: "别名推理" };
    const seen: UnifiedStreamDelta[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events, true)));
    const result = await streamChatWithSdk({ ...setup("openai"), onDelta: delta => seen.push(delta) });
    expect(result.thinking).toBe("别名推理");
    expect(seen.filter(delta => delta.type === "reasoning_delta")).toEqual([{ type: "reasoning_delta", delta: "别名推理" }]);
    expect(result.assistantMessage.providerReplay?.content).toContainEqual({ type: "reasoning", text: "别名推理" });
  });

  it("Responses 推理密文只在终态出现时补入已有重放片段", async () => {
    const events = streamEvents("responses", { reasoning: true }).filter(event =>
      !(event.type === "response.output_item.done" && (event.item as any)?.type === "reasoning"));
    for (const event of events) if (event.type === "response.output_item.added" && (event.item as any)?.type === "reasoning") {
      (event.item as any).encrypted_content = null;
    }
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    const response = await streamChatWithSdk(setup("responses"));
    expect(response.assistantMessage.providerReplay?.content).toContainEqual(expect.objectContaining({
      type: "reasoning", text: "reason", providerOptions: { openai: { itemId: "rs_test", reasoningEncryptedContent: "encrypted_private" } },
    }));
  });

  it("Responses 稀疏终态的工具补全也拒绝非对象参数", async () => {
    const events = streamEvents("responses");
    events[events.length - 1] = { type: "response.completed", response: responseBody("responses", { tool: true, toolInput: [] }) };
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    await expect(streamChatWithSdk(setup("responses"))).rejects.toThrow();
  });

  it("流式工具参数不是合法 JSON 时明确失败", async () => {
    const events = streamEvents("openai", { tool: true });
    (events[1] as any).choices[0].delta.tool_calls[0].function.arguments = "{";
    (events[2] as any).choices[0].delta.tool_calls[0].function.arguments = "";
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events, true)));
    await expect(streamChatWithSdk(setup("openai"))).rejects.toThrow();
  });

  it("SDK 不自行重试失败请求", async () => {
    const network = vi.fn(async () => new Response("busy", { status: 503, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", network);
    await expect(streamChatWithSdk(setup("openai"))).rejects.toMatchObject({ modelFailure: { status: 503 }, retryAfterMs: 0 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(["deadline", "caller", "unlimited"])("%s 的取消与期限行为", async mode => {
    const caller = new AbortController();
    const network = vi.fn(async (_url, init) => new Promise<Response>((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      if (mode === "unlimited") setTimeout(() => resolve(sseResponse(streamEvents("openai"), true)), 40);
    }));
    vi.stubGlobal("fetch", network);
    const pending = streamChatWithSdk({ ...setup("openai"), timeoutMs: mode === "unlimited" ? 0 : mode === "caller" ? 2000 : 20, signal: caller.signal });
    if (mode === "caller") {
      setTimeout(() => caller.abort(new DOMException("cancelled", "AbortError")), 10);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } else if (mode === "deadline") {
      await expect(pending).rejects.toMatchObject({ code: "E_MODEL_REQUEST_TIMEOUT" });
    } else {
      expect((await pending).text).toBe("answer");
    }
  });
});
