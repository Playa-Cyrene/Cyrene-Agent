import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../../settings/model-settings";
import type { Transport } from "../../orchestrator/vendors/types";
import { getAdapterForConfig, streamChatWithSdk } from "../../orchestrator/vendors";
import { jsonResponse, responseBody, sseResponse, streamEvents } from "../../orchestrator/vendors/sdk-stream/model-fixtures";
import { recordRequest, recordUsage } from "../../token-usage-store";
import { appendApiLog } from "../../chat-api-utils";
import { createLlmClient } from "./llm-client";

vi.mock("../../token-usage-store", () => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));
vi.mock("../../chat-api-utils", () => ({ appendApiLog: vi.fn() }));

const transports: Transport[] = ["openai", "responses", "anthropic"];
const messages = [
  { role: "system" as const, content: "系统提示" },
  { role: "user" as const, content: "用户输入" },
];

function settings(transport: Transport, overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    provider: transport === "anthropic" ? "claude" : "chatgpt",
    baseUrl: "https://example.test/v1",
    model: "model-test",
    apiKey: "test-key",
    explicitTransport: transport,
    ...overrides,
  } as ModelSettings;
}

function installFetch(response: () => Response) {
  const network = vi.fn(async (_url: unknown, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", network);
  return network;
}

function requestBody(network: ReturnType<typeof installFetch>): Record<string, unknown> {
  return JSON.parse(network.mock.calls[0][1]?.body as string);
}

function responsesRefusalBody(refusal = "不能提供该内容"): Record<string, unknown> {
  return { ...responseBody("responses"), output: [{
    id: "msg_test", type: "message", role: "assistant", status: "completed",
    content: [{ type: "refusal", refusal }],
  }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("统一模型客户端的 SDK 集成", () => {
  it.each(transports)("%s 流式交付正文并只记录一次用量", async transport => {
    const network = installFetch(() => sseResponse(streamEvents(transport, { reasoning: true }), transport === "openai"));
    const onChunk = vi.fn();
    const before = structuredClone(messages);
    const text = await createLlmClient().stream(settings(transport), messages, 0.2, 2000, "流式测试", onChunk, false);

    expect(text).toBe("answer");
    expect(onChunk.mock.calls.map(([chunk]) => chunk).join("")).toBe(text);
    expect(network).toHaveBeenCalledTimes(1);
    expect(requestBody(network)).toMatchObject({ model: "model-test", stream: true, temperature: 0.2 });
    expect(JSON.stringify(requestBody(network))).toContain("用户输入");
    expect(messages).toEqual(before);
    expect(recordRequest).toHaveBeenCalledExactlyOnceWith("model-test");
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordUsage).mock.calls[0].slice(0, 3)).toEqual([3, 2, 1]);
    expect(appendApiLog).toHaveBeenCalledExactlyOnceWith("流式测试", messages, "answer", "answer");
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(transports)("%s chat 沿用流式执行入口", async transport => {
    const network = installFetch(() => sseResponse(streamEvents(transport), transport === "openai"));
    expect(await createLlmClient().chat(settings(transport), messages, undefined, 2000, "聊天测试", false)).toBe("answer");
    expect(requestBody(network).stream).toBe(true);
    expect(requestBody(network)).not.toHaveProperty("temperature");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it.each(transports)("%s 非流式返回正文、推理和结束原因", async transport => {
    installFetch(() => jsonResponse(responseBody(transport, { reasoning: true })));
    const result = await createLlmClient().chatNonStream(settings(transport), messages, undefined, 2000, "非流式测试");
    expect(result).toMatchObject({ text: "answer", thinking: "reason", finishReason: "stop" });
    expect(result.refusal).toBeUndefined();
    expect(recordRequest).toHaveBeenCalledExactlyOnceWith("model-test");
    expect(recordUsage).toHaveBeenCalledTimes(1);
    // SDK 的输入总量包含普通输入、缓存读取和缓存写入。
    if (transport === "anthropic") expect(recordUsage).toHaveBeenCalledWith(6, 2, 1, 1, "model-test", 2);
    if (transport === "responses") expect(recordUsage).toHaveBeenCalledWith(3, 2, 1, 1, "model-test", undefined);
    expect(appendApiLog).not.toHaveBeenCalled();
  });

  it("跨增量的 think 标签和正文中间的思考块不进入可见输出", async () => {
    const chunks = ["<thi", "nk>开头思考</think>可见", "<thi", "nk>中间思考</think>", "正文"];
    installFetch(() => sseResponse([
      ...chunks.map(content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ], true));
    const onChunk = vi.fn();
    expect(await createLlmClient().stream(settings("openai"), messages, undefined, 2000, "思考过滤", onChunk, false)).toBe("可见正文");
    expect(onChunk.mock.calls.map(([chunk]) => chunk).join("")).toBe("可见正文");
  });

  it.each(transports)("%s 非流式透传结构化输出、预算和额外参数", async transport => {
    const network = installFetch(() => jsonResponse(responseBody(transport, { text: '{"title":"标题"}' })));
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
    const result = await createLlmClient().chatNonStream(settings(transport), messages, 0.1, 2000, "结构化测试", undefined, {
      structuredOutput: { mode: "json_schema", name: "title", schema, strict: true },
      maxTokens: 321,
      extraBody: { custom_flag: "透传" },
    });
    const body = requestBody(network);
    expect(result.text).toBe('{"title":"标题"}');
    expect(body).toMatchObject({ custom_flag: "透传", temperature: 0.1 });
    expect(body.stream).not.toBe(true);
    if (transport === "responses") {
      expect(body.max_output_tokens).toBe(321);
      expect(body.text).toMatchObject({ format: { type: "json_schema", name: "title", schema, strict: true } });
      expect(body.store).toBe(false);
    } else {
      expect(body.max_tokens).toBe(321);
      if (transport === "openai") expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "title", schema, strict: true } });
    }
  });

  it("推理覆盖优先于模型配置且不修改原配置", async () => {
    const config = settings("openai", { provider: "deepseek", model: "deepseek-v4-flash", reasoning: { mode: "on", effort: "high" } });
    const before = structuredClone(config);
    const network = installFetch(() => jsonResponse(responseBody("openai")));
    await createLlmClient().chatNonStream(config, messages, undefined, 2000, "推理覆盖", { mode: "off" });
    expect(requestBody(network).thinking).toEqual({ type: "disabled" });
    expect(config).toEqual(before);
  });

  it.each(["compatible", "official", "responses"])("%s 非流式保留厂商明确的拒答标记", async mode => {
    const config = mode === "responses" ? settings("responses") : settings("openai", mode === "official" ? { baseUrl: "https://api.openai.com/v1" } : {});
    const body = mode === "responses" ? responsesRefusalBody() : {
      ...responseBody("openai"), choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "不能提供该内容" }, finish_reason: "stop" }],
    };
    installFetch(() => jsonResponse(body));
    const result = await createLlmClient().chatNonStream(config, messages, undefined, 2000, "拒答测试");
    expect(result).toMatchObject({ text: "", refusal: "不能提供该内容", finishReason: "stop" });
    expect(recordRequest).toHaveBeenCalledTimes(1);
  });

  it("Responses 拒答兼容仍交由 SDK 校验其余字段", async () => {
    installFetch(() => jsonResponse({ ...responsesRefusalBody(), usage: { input_tokens: "非法用量", output_tokens: 2 } }));
    await expect(createLlmClient().chatNonStream(settings("responses"), messages, undefined, 2000, "无效拒答响应"))
      .rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED" });
    expect(recordRequest).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each(["compatible", "official", "responses"])("%s 流式拒答累积后仍保留明确标记", async mode => {
    const config = mode === "responses" ? settings("responses") : settings("openai", mode === "official" ? { baseUrl: "https://api.openai.com/v1" } : {});
    const events = mode === "responses" ? [
      { type: "response.created", response: { id: "resp_test", model: "model-test", created_at: 1 } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_test", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.refusal.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "不能提供" },
      { type: "response.refusal.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "该内容" },
      { type: "response.output_item.done", output_index: 0, item: (responsesRefusalBody().output as unknown[])[0] },
      { type: "response.completed", response: responsesRefusalBody() },
    ] : [
      { choices: [{ index: 0, delta: { refusal: "不能提供" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { refusal: "该内容" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    installFetch(() => sseResponse(events, mode !== "responses"));
    const response = await streamChatWithSdk({ adapter: getAdapterForConfig(config), config, request: { model: config.model, messages }, timeoutMs: 2000 });
    expect(response).toMatchObject({ text: "", refusal: "不能提供该内容", finishReason: "stop" });
  });

  it("Responses 只有终态快照时也保留拒答", async () => {
    const config = settings("responses");
    installFetch(() => sseResponse([
      { type: "response.created", response: { id: "resp_test", model: "model-test", created_at: 1 } },
      { type: "response.completed", response: responsesRefusalBody() },
    ]));
    const response = await streamChatWithSdk({ adapter: getAdapterForConfig(config), config, request: { model: config.model, messages }, timeoutMs: 2000 });
    expect(response).toMatchObject({ text: "", refusal: "不能提供该内容", finishReason: "stop" });
  });

  it("Responses 混合正文和多个拒答块时保留正文及完整拒答", async () => {
    const output = [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [
      { type: "output_text", text: "可提供的部分", annotations: [] },
      { type: "refusal", refusal: "不能提供" },
      { type: "refusal", refusal: "该内容" },
    ] }];
    installFetch(() => jsonResponse({ ...responseBody("responses"), output }));
    expect(await createLlmClient().chatNonStream(settings("responses"), messages, undefined, 2000, "混合拒答"))
      .toMatchObject({ text: "可提供的部分", refusal: "不能提供该内容", finishReason: "stop" });
  });

  it("Responses 无效拒答块不会被兼容层吞掉", async () => {
    installFetch(() => jsonResponse({ ...responseBody("responses"), output: [{
      id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: 123 }],
    }] }));
    await expect(createLlmClient().chatNonStream(settings("responses"), messages, undefined, 2000, "无效拒答块"))
      .rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED" });
    expect(recordRequest).not.toHaveBeenCalled();
  });

  it.each(["non-stream", "stream"])("%s 将内容过滤结束原因归一化为项目枚举", async mode => {
    if (mode === "non-stream") {
      installFetch(() => jsonResponse({ ...responseBody("openai"), choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "content_filter" }] }));
      expect((await createLlmClient().chatNonStream(settings("openai"), messages, undefined, 2000, "过滤结束")).finishReason).toBe("content_filter");
    } else {
      const events = streamEvents("openai");
      events[events.length - 1] = { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] };
      installFetch(() => sseResponse(events, true));
      const config = settings("openai");
      const response = await streamChatWithSdk({ adapter: getAdapterForConfig(config), config, request: { model: config.model, messages }, timeoutMs: 2000 });
      expect(response.finishReason).toBe("content_filter");
    }
  });

  it.each(transports)("%s 缺少终态的流不能返回成功或记录用量", async transport => {
    const events = streamEvents(transport);
    const incomplete = transport === "anthropic" ? events.slice(0, -2) : events.slice(0, -1);
    installFetch(() => sseResponse(incomplete, transport === "openai"));
    await expect(createLlmClient().chat(settings(transport), messages, undefined, 2000, "截断流", false)).rejects.toThrow();
    expect(recordRequest).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(appendApiLog).not.toHaveBeenCalled();
  });

  it.each(["non-stream", "stream"])("%s 保留 HTTP 错误、重试期限且不自行重试", async mode => {
    const network = installFetch(() => new Response('{"error":{"message":"busy","type":"rate_limit_error"}}', {
      status: 429, headers: { "content-type": "application/json", "retry-after": "2" },
    }));
    const client = createLlmClient();
    const pending = mode === "stream" ? client.chat(settings("openai"), messages, undefined, 2000, "错误测试", false)
      : client.chatNonStream(settings("openai"), messages, undefined, 2000, "错误测试");
    await expect(pending).rejects.toMatchObject({ code: "E_MODEL_REQUEST_FAILED", modelFailure: { status: 429 }, retryAfterMs: 2000 });
    expect(network).toHaveBeenCalledTimes(1);
    expect(recordRequest).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("提前取消时不发起网络请求", async () => {
    const network = installFetch(() => jsonResponse(responseBody("openai")));
    const controller = new AbortController();
    const reason = new DOMException("已取消", "AbortError");
    controller.abort(reason);
    await expect(createLlmClient().chatNonStream(settings("openai"), messages, undefined, 2000, "提前取消", undefined, undefined, controller.signal))
      .rejects.toBe(reason);
    expect(network).not.toHaveBeenCalled();
    expect(recordRequest).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("CANCELLED"));
  });

  it("进行中的取消保留调用方原因", async () => {
    const controller = new AbortController();
    const reason = new DOMException("已取消", "AbortError");
    const network = vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", network);
    const pending = createLlmClient().chatNonStream(settings("openai"), messages, undefined, 2000, "进行中取消", undefined, undefined, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    await rejected;
    expect(recordRequest).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("CANCELLED"));
  });

  it.each(["non-stream", "stream"])("%s 超时保留运行时错误码", async mode => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    const client = createLlmClient();
    const pending = mode === "stream" ? client.chat(settings("openai"), messages, undefined, 100, "超时测试")
      : client.chatNonStream(settings("openai"), messages, undefined, 100, "超时测试");
    await expect(pending).rejects.toMatchObject({ code: "E_MODEL_REQUEST_TIMEOUT" });
    expect(recordRequest).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("TIMEOUT"));
  });

  it.each(["non-stream", "stream"])("%s 超时设为零时允许请求正常完成", async mode => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return mode === "stream" ? sseResponse(streamEvents("openai"), true) : jsonResponse(responseBody("openai"));
    }));
    const client = createLlmClient();
    const result = mode === "stream" ? await client.chat(settings("openai"), messages, undefined, 0, "无期限测试", false)
      : (await client.chatNonStream(settings("openai"), messages, undefined, 0, "无期限测试")).text;
    expect(result).toBe("answer");
    expect(recordRequest).toHaveBeenCalledTimes(1);
  });
});
