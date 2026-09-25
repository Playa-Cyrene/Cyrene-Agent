import { describe, expect, test } from "vitest";
import {
  ResponsesAdapter,
  isOfficialOpenAIEndpoint,
  shouldIncludeEncryptedReasoning,
} from "./responses-adapter";
import type { ChatMessage, ChatRequest, ProviderCapability, VendorConfig } from "./types";

const capability: ProviderCapability = {
  id: "test-openai",
  displayName: "Test OpenAI",
  transport: "openai",
  baseUrl: "https://example.test/v1",
  authStyle: "bearer",
  defaultModel: "test-model",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: true,
};

const cfg: VendorConfig = {
  provider: "p",
  baseUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: "sk-test",
};

function makeAdapter(cap: ProviderCapability = capability): ResponsesAdapter {
  return new ResponsesAdapter(cap.id, cap);
}

function makeBody(
  messages: ChatMessage[],
  options: {
    cap?: ProviderCapability;
    config?: Partial<VendorConfig>;
    extra?: Partial<Pick<ChatRequest, "maxTokens" | "temperature" | "topP" | "tools" | "structuredOutput" | "stream">>;
  } = {},
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const adapter = makeAdapter(options.cap);
  const config: VendorConfig = { ...cfg, ...options.config };
  const req = adapter.buildRequest({
    model: config.model,
    messages,
    ...options.extra,
  }, config);
  return { url: req.url, headers: req.headers as Record<string, string>, body: JSON.parse(req.body) as Record<string, unknown> };
}

describe("ResponsesAdapter — URL 与基础字段", () => {
  test("baseUrl 追加 /responses 后缀", () => {
    const { url } = makeBody([{ role: "user", content: "hi" }]);
    expect(url).toBe("https://example.test/v1/responses");
  });

  test("已以 /responses 结尾的地址原样使用", () => {
    const { url } = makeBody([{ role: "user", content: "hi" }], {
      config: { baseUrl: "https://example.test/v1/responses" },
    });
    expect(url).toBe("https://example.test/v1/responses");
  });

  test("鉴权走 Authorization Bearer", () => {
    const { headers } = makeBody([{ role: "user", content: "hi" }]);
    expect((headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  test("store:false 恒定发送（无状态调用）", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }]);
    expect((body as Record<string, unknown>).store).toBe(false);
  });

  test("maxTokens 映射为 max_output_tokens，temperature/top_p 透传", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      extra: { maxTokens: 1024, temperature: 0.7, topP: 0.9 },
    });
    expect(body.max_output_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body).not.toHaveProperty("max_tokens");
  });
});

describe("ResponsesAdapter — 消息形态映射", () => {
  test("system 消息聚合为顶层 instructions，不进 input", () => {
    const { body } = makeBody([
      { role: "system", content: "规则一" },
      { role: "system", content: "规则二" },
      { role: "user", content: "hi" },
    ]);
    expect(body.instructions).toBe("规则一\n\n规则二");
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe("user");
  });

  test("user 文本转 input_text block", () => {
    const { body } = makeBody([{ role: "user", content: "你好" }]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "你好" }],
    });
  });

  test("user 图片 block 转 input_image", () => {
    const { body } = makeBody([{
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "https://img.test/a.png" } },
      ],
    }]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "看图" },
        { type: "input_image", image_url: "https://img.test/a.png" },
      ],
    });
  });

  test("无 rawAssistant 的 assistant 消息退化构造（input_text + function_call）", () => {
    const { body } = makeBody([
      { role: "user", content: "搜歌" },
      {
        role: "assistant",
        content: "我来搜",
        toolCalls: [{ id: "call_1", name: "music_search", arguments: "{\"q\":\"歌\"}" }],
      },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[1]).toEqual({
      role: "assistant",
      content: [{ type: "input_text", text: "我来搜" }],
    });
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "music_search",
      arguments: "{\"q\":\"歌\"}",
    });
  });

  test("tool 消息转 function_call_output（call_id 对齐 toolCallId）", () => {
    const { body } = makeBody([
      { role: "tool", toolCallId: "call_1", name: "music_search", content: "{\"ok\":true}" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "{\"ok\":true}",
    });
  });
});

describe("ResponsesAdapter — tools 扁平格式", () => {
  const tools = [{ name: "music_search", description: "搜索", parameters: { type: "object" } }];

  test("工具定义无 function 嵌套层", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }], { extra: { tools } });
    const wireTools = body.tools as Array<Record<string, unknown>>;
    expect(wireTools).toHaveLength(1);
    expect(wireTools[0]).toMatchObject({
      type: "function",
      name: "music_search",
      description: "搜索",
      parameters: { type: "object" },
    });
    expect(wireTools[0]).not.toHaveProperty("function");
  });
});

describe("ResponsesAdapter — include 端点级判定", () => {
  const chatgptCap: ProviderCapability = {
    ...capability,
    id: "chatgpt",
    responsesEncryptedReasoning: true,
  };

  test("isOfficialOpenAIEndpoint 只认 api.openai.com", () => {
    expect(isOfficialOpenAIEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isOfficialOpenAIEndpoint("https://api.openai.com")).toBe(true);
    expect(isOfficialOpenAIEndpoint("https://proxy.example.com/v1")).toBe(false);
    expect(isOfficialOpenAIEndpoint("https://api.openai.com.evil.test/v1")).toBe(false);
    expect(isOfficialOpenAIEndpoint("not a url")).toBe(false);
  });

  test("官方域名 + capability 标记 → 发送 include", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { baseUrl: "https://api.openai.com/v1" },
    });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("capability 标记 + 第三方域名（中转站）→ 不发送 include", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { baseUrl: "https://proxy.example.com/v1" },
    });
    expect(body).not.toHaveProperty("include");
  });

  test("官方域名但无 capability 标记 → 不发送 include", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      config: { baseUrl: "https://api.openai.com/v1" },
    });
    expect(body).not.toHaveProperty("include");
  });

  test("shouldIncludeEncryptedReasoning 双条件缺一不可", () => {
    expect(shouldIncludeEncryptedReasoning(
      { baseUrl: "https://api.openai.com/v1", provider: "p", model: "m", apiKey: "k" },
      chatgptCap,
    )).toBe(true);
    expect(shouldIncludeEncryptedReasoning(
      { baseUrl: "https://api.openai.com/v1", provider: "p", model: "m", apiKey: "k" },
      capability,
    )).toBe(false);
    expect(shouldIncludeEncryptedReasoning(
      { baseUrl: "https://api.deepseek.com", provider: "p", model: "m", apiKey: "k" },
      chatgptCap,
    )).toBe(false);
  });
});

describe("ResponsesAdapter — parseResponse", () => {
  const adapter = makeAdapter();

  test("message output_text → text；refusal → refusal；完整 items 存 rawAssistant", () => {
    const output = [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "思考中" }] },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "你好" }],
      },
    ];
    const parsed = adapter.parseResponse({ output, status: "completed" });
    expect(parsed.text).toBe("你好");
    expect(parsed.thinking).toBe("思考中");
    expect(parsed.refusal).toBeUndefined();
    expect(parsed.assistantMessage.rawAssistant).toEqual(output);
    expect(parsed.finishReason).toBe("stop");
  });

  test("refusal content 归入 refusal 字段", () => {
    const parsed = adapter.parseResponse({
      output: [{
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "refusal", refusal: "无法回答" }],
      }],
    });
    expect(parsed.text).toBe("");
    expect(parsed.refusal).toBe("无法回答");
  });

  test("function_call → toolCalls（call_id 语义）", () => {
    const parsed = adapter.parseResponse({
      output: [{
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "music_search",
        arguments: "{\"q\":\"歌\"}",
      }],
    });
    expect(parsed.toolCalls).toEqual([
      { id: "call_1", name: "music_search", arguments: "{\"q\":\"歌\"}" },
    ]);
    expect(parsed.assistantMessage.toolCalls).toEqual(parsed.toolCalls);
  });

  test("usage 映射 input_tokens / output_tokens / cached_tokens", () => {
    const parsed = adapter.parseResponse({
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 40 },
      },
    });
    expect(parsed.usage).toEqual({ input: 100, output: 50, cachedInput: 40 });
  });

  test("status incomplete + max_output_tokens → finishReason length", () => {
    const parsed = adapter.parseResponse({
      output: [],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(parsed.finishReason).toBe("length");
  });
});

describe("ResponsesAdapter — rawAssistant 多轮回放", () => {
  const chatgptCap: ProviderCapability = {
    ...capability,
    id: "chatgpt",
    responsesEncryptedReasoning: true,
  };

  const reasoningWithEncrypted = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "思考" }],
    encrypted_content: "enc-blob",
  };
  const messageItem = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: "回复" }],
  };
  const functionCallItem = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "music_search",
    arguments: "{}",
  };

  test("官方端点：带 encrypted_content 的 reasoning 原顺序保留回放", () => {
    const { body } = makeBody([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", rawAssistant: [reasoningWithEncrypted, messageItem, functionCallItem] },
      { role: "user", content: "继续" },
    ], { cap: chatgptCap, config: { baseUrl: "https://api.openai.com/v1" } });
    const input = body.input as Array<Record<string, unknown>>;
    // 用户消息 + 三个回放 item + 用户消息
    expect(input).toHaveLength(5);
    expect(input[1]).toMatchObject({ type: "reasoning", id: "rs_1" });
    expect(input[2]).toMatchObject({ type: "message", id: "msg_1" });
    expect(input[3]).toMatchObject({ type: "function_call", call_id: "call_1" });
  });

  test("第三方端点：reasoning 无 encrypted_content 可引用 → 丢弃，其余保留", () => {
    const { body } = makeBody([
      { role: "assistant", content: "", rawAssistant: [reasoningWithEncrypted, messageItem] },
    ], { config: { baseUrl: "https://api.deepseek.com" } });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "message", id: "msg_1" });
  });

  test("官方端点但 reasoning 缺 encrypted_content → 丢弃", () => {
    const bare = { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "裸思考" }] };
    const { body } = makeBody([
      { role: "assistant", content: "", rawAssistant: [bare, messageItem] },
    ], { cap: chatgptCap, config: { baseUrl: "https://api.openai.com/v1" } });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "message" });
  });

  test("未知 item 类型防御性丢弃，不阻断其余回放", () => {
    const { body } = makeBody([
      { role: "assistant", content: "", rawAssistant: [{ type: "mystery_item" }, messageItem] },
    ], { config: { baseUrl: "https://api.deepseek.com" } });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "message" });
  });

  test("rawAssistant 优先于 content/toolCalls 退化构造", () => {
    // 有 rawAssistant 时不再从 content 退化构造 assistant input_text
    const { body } = makeBody([
      { role: "assistant", content: "旧正文", rawAssistant: [messageItem] },
    ], { config: { baseUrl: "https://api.deepseek.com" } });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "message", id: "msg_1" });
  });
});

describe("ResponsesAdapter — appendToolResults", () => {
  test("追加 role:tool 消息，下轮 buildRequest 转 function_call_output", () => {
    const adapter = makeAdapter();
    const results = [{
      toolCall: { id: "call_1", name: "music_search", arguments: "{}" },
      output: "{\"ok\":true}",
    }];
    const next = adapter.appendToolResults([], results as never);
    expect(next).toEqual([
      { role: "tool", toolCallId: "call_1", name: "music_search", content: "{\"ok\":true}" },
    ]);

    const { body } = makeBody(next);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "{\"ok\":true}",
    });
  });
});

describe("ResponsesAdapter — structuredOutput 与推理控制", () => {
  test("json_schema 映射到 text.format", () => {
    const schema = { type: "object", properties: { decision: { type: "string" } } };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      extra: { structuredOutput: { mode: "json_schema", name: "decision", schema, strict: true } },
    });
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "decision", strict: true, schema },
    });
  });

  test("json_object 映射到 text.format", () => {
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      extra: { structuredOutput: { mode: "json_object" } },
    });
    expect(body.text).toEqual({ format: { type: "json_object" } });
  });

  test("reasoning effort 翻译为 reasoning:{effort}，不残留 reasoning_effort", () => {
    const chatgptCap: ProviderCapability = { ...capability, id: "chatgpt" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { model: "gpt-5.1", reasoning: { mode: "on", effort: "low" } },
    });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
  });

  test("proMode 翻译为 reasoning:{mode:'pro'}，effort 缺省填 defaultEffort（gpt-5.6）", () => {
    const chatgptCap: ProviderCapability = { ...capability, id: "chatgpt" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { model: "gpt-5.6", reasoning: { mode: "on", proMode: true } },
    });
    expect(body.reasoning).toEqual({ effort: "medium", mode: "pro" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("proMode + 显式 effort 共存：reasoning:{effort, mode:'pro'}", () => {
    const chatgptCap: ProviderCapability = { ...capability, id: "chatgpt" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { model: "gpt-5.6-sol", reasoning: { mode: "on", effort: "high", proMode: true } },
    });
    expect(body.reasoning).toEqual({ effort: "high", mode: "pro" });
  });

  // GPT-6 Astra 官方迁移指南确认继续支持 pro mode（与 5.6 一致）
  test("gpt-6-astra + proMode → reasoning:{effort, mode:'pro'}", () => {
    const chatgptCap: ProviderCapability = { ...capability, id: "chatgpt" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { model: "gpt-6-astra", reasoning: { mode: "on", effort: "max", proMode: true } },
    });
    expect(body.reasoning).toEqual({ effort: "max", mode: "pro" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("proMode 不被支持的模型（gpt-5.1）→ 不发 reasoning.mode", () => {
    const chatgptCap: ProviderCapability = { ...capability, id: "chatgpt" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: chatgptCap,
      config: { model: "gpt-5.1", reasoning: { mode: "on", effort: "low", proMode: true } },
    });
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  // ── MiniMax-M3（anthropic-adaptive）：Responses 协议下 thinking → reasoning.effort 映射 ──
  // 官方 Responses API：省略 reasoning = 默认 effort:"none"（关闭）；非 none 值开启推理但不调深度。

  test("MiniMax-M3 + on → thinking.type=adaptive 翻译为 reasoning:{effort:'minimal'}", () => {
    const minimaxCap: ProviderCapability = { ...capability, id: "minimax" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: minimaxCap,
      config: { model: "MiniMax-M3", reasoning: { mode: "on" } },
    });
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body).not.toHaveProperty("thinking");
  });

  test("MiniMax-M3 + off → reasoning.effort=none 明确关闭", () => {
    const minimaxCap: ProviderCapability = { ...capability, id: "minimax" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: minimaxCap,
      config: { model: "MiniMax-M3", reasoning: { mode: "off" } },
    });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body).not.toHaveProperty("thinking");
  });

  test("MiniMax-M3 + 旧 auto 偏好 → 发送滑块默认关闭档", () => {
    const minimaxCap: ProviderCapability = { ...capability, id: "minimax" };
    const { body } = makeBody([{ role: "user", content: "hi" }], {
      cap: minimaxCap,
      config: { model: "MiniMax-M3", reasoning: { mode: "auto" } },
    });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body).not.toHaveProperty("thinking");
  });
});
