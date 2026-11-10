import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdapterForConfig, PROVIDER_CAPABILITIES } from "./index";
import { generateChatWithAiSdk } from "./model-runtime";
import { prepareModelCall } from "./model-factory";
import { setVendorRuntimeSettingsGetter } from "./runtime-settings";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../../../shared/custom-endpoint-state";
import type { ChatMessage, ChatRequest, VendorConfig } from "./types";
import { jsonResponse, responseBody, weatherTool } from "./sdk-stream/model-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  setVendorRuntimeSettingsGetter(() => ({}));
});

describe("AI SDK 厂商策略兼容", () => {
  it.each(PROVIDER_CAPABILITIES)("$displayName 保留端点、鉴权、推理、采样与预算策略", async capability => {
    const config: VendorConfig = { provider: capability.displayName, baseUrl: capability.baseUrl,
      model: capability.defaultModel, apiKey: "test-key", explicitTransport: capability.transport,
      reasoning: { mode: "on", effort: "high" } };
    const adapter = getAdapterForConfig(config);
    const base: ChatRequest = { model: config.model, messages: [{ role: "system", content: "系统" }, { role: "user", content: "天气" }],
      tools: [weatherTool], maxTokens: 32000, temperature: 0.8, topP: 0.9, stream: false };
    const request = adapter.applyCacheHints?.(base, config) ?? base;
    const legacy = adapter.buildRequest(request, config);
    const expected = JSON.parse(legacy.body);
    const sent: { url: string; body: any; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return jsonResponse(responseBody(adapter.transport));
    }));
    await generateChatWithAiSdk({ adapter, config, request, timeoutMs: 2000 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(legacy.url);
    for (const [name, value] of Object.entries(legacy.headers)) expect(sent[0].headers.get(name)).toBe(value);
    for (const key of ["thinking", "reasoning", "reasoning_effort", "enable_thinking", "temperature", "top_p", "max_tokens", "max_output_tokens", "tool_choice", "prompt_cache_key", "output_config"]) {
      expect(sent[0].body[key]).toEqual(expected[key]);
    }
    if (adapter.transport === "responses") expect(sent[0].body.store).toBe(false);
    if (adapter.transport === "anthropic" && capability.cacheStrategy === "cache_control") {
      expect(sent[0].body.system[0].cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("Anthropic 兼容地址保留查询参数与 bearer 鉴权", async () => {
    const capability = PROVIDER_CAPABILITIES.find(capability => capability.id === "mimo")!;
    const config: VendorConfig = { provider: capability.displayName, explicitTransport: "anthropic", model: "test",
      baseUrl: "https://proxy.test/custom/messages?route=1", apiKey: "bearer-key" };
    const adapter = getAdapterForConfig(config);
    let sent: Request | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      sent = new Request(url, init);
      return jsonResponse(responseBody("anthropic"));
    }));
    await generateChatWithAiSdk({ adapter, config, request: { model: config.model, messages: [{ role: "user", content: "hi" }] }, timeoutMs: 2000 });
    expect(sent?.url).toContain("route=1");
    expect(sent?.headers.get("authorization")).toBe("Bearer bearer-key");
    expect(sent?.headers.has("x-api-key")).toBe(false);
  });

  it.each(["openai", "responses", "anthropic"] as const)("%s 图片保持原生 URL，不额外下载", async transport => {
    const config: VendorConfig = { provider: "自定义", model: "test", explicitTransport: transport, baseUrl: "https://proxy.test/v1", apiKey: "key" };
    const network = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const content = transport === "responses" ? body.input[0].content : body.messages[0].content;
      expect(content[0]).toEqual(transport === "anthropic"
        ? { type: "image", source: { type: "url", url: "https://image.test/example.png" } }
        : transport === "responses" ? { type: "input_image", image_url: "https://image.test/example.png" }
          : { type: "image_url", image_url: { url: "https://image.test/example.png" } });
      return jsonResponse(responseBody(transport));
    });
    vi.stubGlobal("fetch", network);
    await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, request: { model: config.model,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.test/example.png" } }] }] }, timeoutMs: 2000 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("不允许额外参数绕过历史投影", () => {
    const config: VendorConfig = { provider: "自定义", model: "test", explicitTransport: "responses", baseUrl: "https://proxy.test", apiKey: "key" };
    expect(() => prepareModelCall({ adapter: getAdapterForConfig(config), config, stream: false,
      request: { model: config.model, messages: [], extraBody: { input: [] } } })).toThrow("额外参数不能覆盖会话结构");
  });

  it("仅在启用的 Responses 主请求中注册 OpenAI 图片生成工具", async () => {
    const config: VendorConfig = { provider: "ChatGPT", model: "gpt-test", explicitTransport: "responses",
      baseUrl: "https://proxy.test/v1", apiKey: "key" };
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse(responseBody("responses"));
    }));

    await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, timeoutMs: 2000, request: {
      model: config.model,
      messages: [{ role: "user", content: "画一只猫" }],
      imageGeneration: { enabled: true, model: "gpt-image-2.5-flare" },
    } });

    const imageTool = sent.tools.find((tool: any) => tool.type === "image_generation");
    expect(imageTool).toMatchObject({ type: "image_generation", model: "gpt-image-2.5-flare",
      output_format: "png", size: "auto", quality: "auto", partial_images: 0 });
  });

  it("不在关闭或辅助请求中注册图片生成工具", async () => {
    const config: VendorConfig = { provider: "ChatGPT", model: "gpt-test", explicitTransport: "responses",
      baseUrl: "https://proxy.test/v1", apiKey: "key" };
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return jsonResponse(responseBody("responses"));
    }));

    for (const imageGeneration of [undefined, { enabled: false, model: "gpt-image-2.5-flare" }]) {
      await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, timeoutMs: 2000,
        request: { model: config.model, messages: [{ role: "user", content: "你好" }], imageGeneration } });
    }

    expect(sent.every(body => !body.tools?.some((tool: any) => tool.type === "image_generation"))).toBe(true);
  });

  it("拒绝图片生成工具名与本地工具冲突", () => {
    const config: VendorConfig = { provider: "ChatGPT", model: "gpt-test", explicitTransport: "responses",
      baseUrl: "https://proxy.test/v1", apiKey: "key" };
    expect(() => prepareModelCall({ adapter: getAdapterForConfig(config), config, stream: false, request: {
      model: config.model, messages: [], imageGeneration: { enabled: true, model: "gpt-image-2.5-flare" },
      tools: [{ ...weatherTool, name: "image_generation" }],
    } })).toThrow("image_generation");
  });
});

describe("Claude Fable 5.2 思考块前缀校验", () => {
  const claude = PROVIDER_CAPABILITIES.find(capability => capability.id === "claude")!;
  const configFor = (model: string): VendorConfig => ({ provider: claude.displayName, baseUrl: claude.baseUrl,
    model, apiKey: "test-key", explicitTransport: "anthropic", reasoning: { mode: "on", effort: "high" } });

  // 第二轮请求的前缀与第一轮不同：Chat 模式换了尾部运行时上下文，或历史压缩把早期消息换成摘要；
  // 第一轮带签名的思考块照常重放，服务端按 drop_block 丢弃失效的块，而不是返回 400。
  it.each([
    ["连续聊天时更换运行时上下文", (assistant: ChatMessage): ChatMessage[] => [
      { role: "system", content: "系统" }, { role: "user", content: "你好" }, assistant,
      { role: "user", content: "继续\n<runtime_context>第二轮</runtime_context>" },
    ]],
    ["历史压缩替换早期消息", (assistant: ChatMessage): ChatMessage[] => [
      { role: "system", content: "系统" }, { role: "user", content: "[早期对话摘要]" }, assistant,
      { role: "user", content: "继续" },
    ]],
  ] as const)("%s：重放签名思考块并请服务端丢弃失效的块", async (_case, history) => {
    const config = configFor("claude-fable-5-2");
    const adapter = getAdapterForConfig(config);
    const sent: { body: any; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return jsonResponse(responseBody("anthropic", { reasoning: true }));
    }));
    const first = await generateChatWithAiSdk({ adapter, config, timeoutMs: 2000,
      request: { model: config.model, messages: [{ role: "system", content: "系统" }, { role: "user", content: "你好\n<runtime_context>第一轮</runtime_context>" }] } });
    await generateChatWithAiSdk({ adapter, config, timeoutMs: 2000,
      request: { model: config.model, messages: history(first.assistantMessage) } });

    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(request.headers.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01");
    }
    expect(JSON.stringify(sent[1].body.messages)).toContain("sig_private");
  });

  it.each(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-4-6"])("%s 不发送 block_binding 和对应 beta", async model => {
    const config = configFor(model);
    let sent: { body: any; headers: Headers } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = { body: JSON.parse(init.body), headers: new Headers(init.headers) };
      return jsonResponse(responseBody("anthropic"));
    }));
    await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, timeoutMs: 2000,
      request: { model, messages: [{ role: "user", content: "你好" }] } });
    expect(sent?.body.thinking?.block_binding).toBeUndefined();
    expect(sent?.headers.has("anthropic-beta")).toBe(false);
  });

  // 自定义端点关闭推理字段注入（thinkingOverride=-1）后，不能再自行补出 thinking 或 beta 头。
  it("自定义端点禁止注入推理字段时，claude-fable-5-2 不发送 thinking 和 beta", async () => {
    setVendorRuntimeSettingsGetter(() => ({ thinkingOverride: -1 }));
    const config: VendorConfig = { provider: CUSTOM_ENDPOINT_PROVIDERS.cloud, baseUrl: "https://proxy.test/v1", model: "claude-fable-5-2",
      apiKey: "test-key", explicitTransport: "anthropic" };
    let sent: { body: any; headers: Headers } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = { body: JSON.parse(init.body), headers: new Headers(init.headers) };
      return jsonResponse(responseBody("anthropic"));
    }));
    await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, timeoutMs: 2000,
      request: { model: config.model, messages: [{ role: "user", content: "你好" }] } });
    expect(sent?.body.thinking).toBeUndefined();
    expect(sent?.headers.has("anthropic-beta")).toBe(false);
  });
});
