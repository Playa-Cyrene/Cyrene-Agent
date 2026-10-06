import { closeConversationDatabases } from "../../storage/conversation-database-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationTranscriptStore } from "../conversation-transcript-store";
import { getAdapterForConfig, PROVIDER_CAPABILITIES } from "./index";
import { streamChatWithSdk } from "./sdk-stream/runtime";
import type { ChatMessage, VendorConfig } from "./types";
import { generateChatWithAiSdk, streamChatWithAiSdk } from "./model-runtime";
import { modelMessageOrigin } from "./model-factory";
import { projectModelHistory } from "./model-history";
import { jsonResponse, responseBody, sseResponse, streamEvents, weatherTool } from "./sdk-stream/model-fixtures";

const config: VendorConfig = {
  provider: "Claude", model: "claude-test", baseUrl: "https://example.test/v1", apiKey: "test-key",
  explicitTransport: "anthropic",
};

function anthropicStream(): Response {
  const events = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "继续" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const roots: string[] = [];
afterEach(async () => {
  await closeConversationDatabases();
  vi.unstubAllGlobals();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe("#167 模型执行历史互通", () => {
  const configs: VendorConfig[] = [
    { ...config, provider: PROVIDER_CAPABILITIES.find(cap => cap.id === "chatgpt")!.displayName, explicitTransport: "openai", model: "gpt-5.6", baseUrl: "https://compatible.test/v1" },
    { ...config, provider: PROVIDER_CAPABILITIES.find(cap => cap.id === "chatgpt")!.displayName, explicitTransport: "responses", model: "gpt-5.6", baseUrl: "https://api.openai.com/v1" },
    { ...config, provider: PROVIDER_CAPABILITIES.find(cap => cap.id === "claude")!.displayName, model: "claude-sonnet-4-6" },
  ];

  it.each(configs.flatMap(source => configs.filter(target => target !== source).map(target => ({ source, target }))))(
    "$source.explicitTransport 到 $target.explicitTransport 的文本与工具往返", async ({ source, target }) => {
      const sourceAdapter = getAdapterForConfig(source);
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(responseBody(sourceAdapter.transport, { tool: true, reasoning: true }))));
      const first = await generateChatWithAiSdk({ adapter: sourceAdapter, config: source,
        request: { model: source.model, messages: [{ role: "user", content: "天气" }], tools: [weatherTool] }, timeoutMs: 2000 });
      const messages: ChatMessage[] = [{ role: "user", content: "天气" }, first.assistantMessage,
        { role: "tool", toolCallId: "call_test", content: "晴", name: "weather" }, { role: "user", content: "继续" }];
      const original = JSON.stringify(messages);
      let sent: any;
      vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
        sent = JSON.parse(init.body);
        return jsonResponse(responseBody(target.explicitTransport as any));
      }));
      const next = await generateChatWithAiSdk({ adapter: getAdapterForConfig(target), config: target,
        request: { model: target.model, messages, tools: [weatherTool] }, timeoutMs: 2000 });
      expect(next.text).toBe("answer");
      const wire = JSON.stringify(sent);
      expect(wire).toContain("answer");
      expect(wire).toContain("call_test");
      expect(wire).toContain("晴");
      expect(wire).not.toContain("sig_private");
      expect(wire).not.toContain("encrypted_private");
      expect(JSON.stringify(messages)).toBe(original);
    });

  it.each(configs.slice(1))("$explicitTransport 同来源重放签名或加密推理", async source => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(responseBody(source.explicitTransport as any, { reasoning: true }))));
    const adapter = getAdapterForConfig(source);
    const first = await generateChatWithAiSdk({ adapter, config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }] }, timeoutMs: 2000 });
    const restored = JSON.parse(JSON.stringify(first.assistantMessage)) as ChatMessage;
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse(responseBody(source.explicitTransport as any));
    }));
    await generateChatWithAiSdk({ adapter, config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }, restored, { role: "user", content: "继续" }] }, timeoutMs: 2000 });
    expect(JSON.stringify(sent)).toContain(source.explicitTransport === "anthropic" ? "sig_private" : "encrypted_private");
    expect(restored.rawAssistant).toBeUndefined();
  });

  it("工具标识转换保持配对，原历史不变", () => {
    const messages: ChatMessage[] = [{ role: "assistant", toolCalls: [{ id: "调用/一", name: "weather", arguments: '{"city":"北京"}' }] },
      { role: "tool", toolCallId: "调用/一", content: "晴" }];
    const projected = projectModelHistory(messages, modelMessageOrigin(getAdapterForConfig(config), config));
    const call = (projected[0].content as any[])[0];
    const result = (projected[1].content as any[])[0];
    expect(call.toolCallId).toMatch(/^call_[a-f0-9]+$/);
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(messages[0].toolCalls?.[0].id).toBe("调用/一");
  });

  it.each(["model", "baseUrl", "apiKey"] as const)("同协议更换 %s 后不重放私有推理，切回后仍可重放", async field => {
    const source = configs[2];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(responseBody("anthropic", { reasoning: true }))));
    const first = await generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }] }, timeoutMs: 2000 });
    const original = JSON.stringify(first.assistantMessage);
    const target = { ...source, [field]: field === "baseUrl" ? "https://another.test/v1" : "changed" };
    expect(JSON.stringify(projectModelHistory([first.assistantMessage], modelMessageOrigin(getAdapterForConfig(target), target)))).not.toContain("sig_private");
    expect(JSON.stringify(projectModelHistory([first.assistantMessage], modelMessageOrigin(getAdapterForConfig(source), source)))).toContain("sig_private");
    expect(JSON.stringify(first.assistantMessage)).toBe(original);
  });

  it("非流式兼容接口的 thinking 字段仍进入推理展示和同来源重放", async () => {
    const body = responseBody("openai");
    (body.choices as any[])[0].message.thinking = "别名推理";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    const source = configs[0];
    const result = await generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }] }, timeoutMs: 2000 });
    expect(result.thinking).toBe("别名推理");
    expect(result.assistantMessage.providerReplay?.content).toContainEqual({ type: "reasoning", text: "别名推理" });
  });

  it("保存、检查点和重启后仍保留来源及有序重放内容", async () => {
    const source = configs[2];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(responseBody("anthropic", { tool: true, reasoning: true }))));
    const first = await generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }], tools: [weatherTool] }, timeoutMs: 2000 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sdk-history-"));
    roots.push(root);
    const store = new ConversationTranscriptStore(root);
    await store.append("sdk-test", { id: "assistant-1", at: 1000, kind: "assistant", payload: first.assistantMessage });
    await store.checkpoint("sdk-test");
    const restored = (await new ConversationTranscriptStore(root).read("sdk-test")).entries[0];
    expect(restored.kind).toBe("assistant");
    if (restored.kind !== "assistant") throw new Error("unexpected entry");
    expect(restored.payload).toEqual(first.assistantMessage);
    const replay = projectModelHistory([restored.payload], modelMessageOrigin(getAdapterForConfig(source), source));
    expect((replay[0].content as any[]).map(part => part.type)).toEqual(["reasoning", "text", "tool-call"]);
    expect(JSON.stringify(replay)).toContain("sig_private");
  });

  it("重放补充数据损坏时仍使用通用内容", () => {
    const origin = modelMessageOrigin(getAdapterForConfig(config), config);
    const message: ChatMessage = { role: "assistant", content: "正文", providerReplay: {
      version: 1, origin, content: [null] as any,
    } };
    expect(projectModelHistory([message], origin)).toEqual([{ role: "assistant", content: [{ type: "text", text: "正文" }] }]);
  });

  it("非流式无效终态不能提交成功回复", async () => {
    const body = responseBody("openai");
    (body.choices as any[])[0].finish_reason = "unknown";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    const source = configs[0];
    await expect(generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }] }, timeoutMs: 2000 })).rejects.toThrow();
  });

  it.each(configs.flatMap(source => [false, true].map(streaming => ({ source, streaming }))))(
    "$source.explicitTransport streaming=$streaming 未开放工具仍交付调度层反馈", async ({ source, streaming }) => {
      const adapter = getAdapterForConfig(source);
      vi.stubGlobal("fetch", vi.fn(async () => streaming
        ? sseResponse(JSON.parse(JSON.stringify(streamEvents(adapter.transport, { tool: true })).replaceAll("weather", "browser_click")), adapter.transport === "openai")
        : jsonResponse(JSON.parse(JSON.stringify(responseBody(adapter.transport, { tool: true })).replaceAll("weather", "browser_click")))));
      const run = streaming ? streamChatWithSdk : generateChatWithAiSdk;
      const result = await run({ adapter, config: source, request: { model: source.model,
        messages: [{ role: "user", content: "天气" }], tools: [weatherTool] }, timeoutMs: 2000 });
      expect(result.toolCalls).toEqual([{ id: "call_test", name: "browser_click", arguments: '{"city":"北京"}' }]);
      expect(result.assistantMessage.providerReplay?.content).toContainEqual(expect.objectContaining({
        type: "tool-call", toolName: "browser_click", input: { city: "北京" },
      }));
    });

  it("未知工具的非法参数仍明确失败", async () => {
    const body = responseBody("openai", { tool: true });
    const call = (body.choices as any[])[0].message.tool_calls[0].function;
    call.name = "missing_tool";
    call.arguments = "{";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    const source = configs[0];
    await expect(generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }], tools: [weatherTool] }, timeoutMs: 2000 })).rejects.toThrow();
  });

  it.each(configs.flatMap(source => [false, true].flatMap(streaming => [[], null, 1].map(toolInput => ({ source, streaming, toolInput })))))(
    "$source.explicitTransport streaming=$streaming 拒绝非对象工具参数 $toolInput", async ({ source, streaming, toolInput }) => {
      const adapter = getAdapterForConfig(source);
      vi.stubGlobal("fetch", vi.fn(async () => streaming
        ? sseResponse(streamEvents(adapter.transport, { tool: true, toolInput }), adapter.transport === "openai")
        : jsonResponse(responseBody(adapter.transport, { tool: true, toolInput }))));
      const run = streaming ? streamChatWithSdk : generateChatWithAiSdk;
      await expect(run({ adapter, config: source, request: { model: source.model,
        messages: [{ role: "user", content: "天气" }], tools: [weatherTool] }, timeoutMs: 2000 })).rejects.toThrow();
    });

  it.each(["ECONNRESET", "ENOTFOUND", "ETIMEDOUT"])("SDK 包装的 %s 保留底层错误分类", async code => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("network failure"), { code }) });
    }));
    const source = configs[0];
    await expect(generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source,
      request: { model: source.model, messages: [{ role: "user", content: "你好" }] }, timeoutMs: 2000 })).rejects.toMatchObject({
      modelFailure: { category: code === "ETIMEDOUT" ? "TIMEOUT" : "NETWORK", vendorCode: code },
    });
  });

  it("未知旧数据恢复可见正文和工具，非法工具参数明确失败", () => {
    const origin = modelMessageOrigin(getAdapterForConfig(config), config);
    const history: ChatMessage[] = [{ role: "assistant", rawAssistant: [
      { type: "message", content: [{ type: "output_text", text: "旧正文" }] },
      { type: "function_call", call_id: "call_old", name: "weather", arguments: '{"city":"北京"}' },
    ] }, { role: "tool", toolCallId: "call_old", content: "晴" }];
    expect(JSON.stringify(projectModelHistory(history, origin))).toContain("旧正文");
    expect(() => projectModelHistory([{ role: "assistant", toolCalls: [{ id: "a", name: "weather", arguments: "{" }] }], origin)).toThrow("历史工具参数无效");
  });
  it("Responses 旧原始消息切到 Anthropic 时只发送通用内容", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      body = JSON.parse(init.body);
      return anthropicStream();
    }));
    const messages: ChatMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好", thinking: "旧推理", rawAssistant: [
        { type: "reasoning", id: "rs_old", encrypted_content: "private" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] },
      ] },
      { role: "user", content: "继续" },
    ];
    const response = await streamChatWithSdk({ adapter: getAdapterForConfig(config), config,
      request: { model: config.model, messages }, timeoutMs: 2000 });
    expect(response.text).toBe("继续");
    expect(body.messages[1].content).toEqual([{ type: "text", text: "你好" }]);
    expect(JSON.stringify(messages)).toContain("private");
  });

  it("新回复保存带版本和来源的重放数据", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => anthropicStream()));
    const response = await streamChatWithSdk({ adapter: getAdapterForConfig(config), config,
      request: { model: config.model, messages: [{ role: "user", content: "继续" }] }, timeoutMs: 2000 });
    expect(response.assistantMessage).toMatchObject({
      providerReplay: { version: 1, origin: { transport: "anthropic", model: "claude-test" }, content: [{ type: "text", text: "继续" }] },
    });
    expect(response.assistantMessage.rawAssistant).toBeUndefined();
    expect(JSON.stringify(response.assistantMessage)).not.toContain("test-key");
  });

  it("非流式纯图片响应返回图片且不把原生调用交给本地调度器", async () => {
    const source = configs[1];
    const base64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");
    const body = { id: "resp_image", model: source.model, created_at: 1, status: "completed",
      output: [{ id: "image_call_1", type: "image_generation_call", result: base64 }],
      usage: { input_tokens: 3, output_tokens: 2 } };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));

    const response = await generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source, timeoutMs: 2000,
      request: { model: source.model, messages: [{ role: "user", content: "画一朵花" }],
        imageGeneration: { enabled: true, model: "gpt-image-2.5-flare" } } });

    expect(response.text).toBe("");
    expect(response.generatedImages).toEqual([{ id: "image_call_1", toolCallId: "image_call_1", base64, mime: "image/png" }]);
    expect(response.toolCalls).toEqual([]);
    expect(JSON.stringify(response.assistantMessage.providerReplay)).not.toContain(base64);
    expect(JSON.stringify(response.assistantMessage.providerReplay)).not.toContain("image_generation");
    expect(JSON.stringify(response.raw)).not.toContain(base64);
  });

  it("流式和非流式 Responses 输出得到相同的多图片列表", async () => {
    const source = configs[1];
    const base64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]).toString("base64");
    const output = ["image_call_1", "image_call_2"].map(id => ({ id, type: "image_generation_call", result: base64 }));
    const body = { id: "resp_image", model: source.model, created_at: 1, status: "completed", output,
      usage: { input_tokens: 3, output_tokens: 2 } };
    const events = [
      { type: "response.created", response: { id: body.id, model: body.model, created_at: 1, status: "in_progress" } },
      ...output.flatMap((item, output_index) => [
        { type: "response.output_item.added", output_index, item: { id: item.id, type: item.type } },
        { type: "response.output_item.done", output_index, item },
      ]),
      { type: "response.completed", response: body },
    ];
    const request = { model: source.model, messages: [{ role: "user" as const, content: "画两朵花" }],
      imageGeneration: { enabled: true, model: "gpt-image-2.5-flare" } };
    const onDelta = vi.fn();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    const generated = await generateChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source, timeoutMs: 2000, request });
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(events)));
    const streamed = await streamChatWithAiSdk({ adapter: getAdapterForConfig(source), config: source, timeoutMs: 2000, request, onDelta });

    expect(streamed.generatedImages).toEqual(generated.generatedImages);
    expect(streamed.toolCalls).toEqual([]);
    expect(onDelta.mock.calls.flat().some(value => (value as any)?.name === "image_generation")).toBe(false);
  });

  it("同来源历史只向模型说明已生成图片，不发送本地文件路径", () => {
    const source = configs[1];
    const origin = modelMessageOrigin(getAdapterForConfig(source), source);
    const projected = projectModelHistory([{ role: "assistant", content: "好了", attachments: [{
      id: "generated-1", kind: "image", name: "generated-1.png", filePath: "C:/private/generated-1.png",
      mime: "image/png", source: "model", byteLength: 20, status: "done",
    }] }], origin);

    expect(JSON.stringify(projected)).toContain("已生成图片：generated-1.png");
    expect(JSON.stringify(projected)).not.toContain("C:/private");
  });
});
