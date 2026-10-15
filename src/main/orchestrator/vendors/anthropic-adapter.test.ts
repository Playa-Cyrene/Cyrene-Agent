import { describe, expect, test } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter";
import type { ProviderCapability } from "./types";

const anthropicCap: ProviderCapability = {
  id: "test-anthropic",
  displayName: "Test Anthropic",
  transport: "anthropic",
  baseUrl: "https://example.test/v1",
  authStyle: "x-api-key",
  defaultModel: "test-model",
  supportsTools: true,
  supportsThinking: true,
  thinkingField: "thinking",
  cacheStrategy: "cache_control",
  testStrategy: "text",
};

describe("AnthropicAdapter", () => {
  test("maps structured json_schema requests to output_config.format without OpenAI name", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const schema = {
      type: "object",
      properties: { decision: { type: "string", enum: ["respond"] } },
      required: ["decision"],
      additionalProperties: false,
    };
    const req = adapter.buildRequest({
      model: "m",
      maxTokens: 200,
      messages: [{ role: "user", content: "hi" }],
      structuredOutput: { mode: "json_schema", name: "ignored_by_anthropic", schema, strict: true },
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" });

    expect(JSON.parse(req.body).output_config).toEqual({
      format: { type: "json_schema", schema },
    });
  });

  test("does not invent structured output fields for prompt_json", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest({
      model: "m",
      maxTokens: 200,
      messages: [{ role: "user", content: "hi" }],
      structuredOutput: { mode: "prompt_json", sendJsonObjectHint: false },
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" });

    expect(JSON.parse(req.body).output_config).toBeUndefined();
  });

  test("keeps ordinary native Function Calling on auto", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest({
      model: "m", messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" });
    expect(JSON.parse(req.body).tool_choice).toEqual({ type: "auto" });
  });

  test("maps a must-call intent to named Anthropic tool_choice when reasoning is off", () => {
    const adapter = new AnthropicAdapter("claude", { ...anthropicCap, id: "claude" });
    const req = adapter.buildRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }, { provider: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", apiKey: "sk-test", reasoning: { mode: "off" } });

    expect(JSON.parse(req.body).tool_choice).toEqual({ type: "tool", name: "music_search" });
  });

  test("downgrades must-call to auto when reasoning=auto (server may default thinking on)", () => {
    const adapter = new AnthropicAdapter("claude", { ...anthropicCap, id: "claude" });
    const req = adapter.buildRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }, { provider: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", apiKey: "sk-test" });

    expect(JSON.parse(req.body).tool_choice).toEqual({ type: "auto" });
  });

  test("uses auto for must-call intent while extended thinking is enabled", () => {
    const adapter = new AnthropicAdapter("claude", { ...anthropicCap, id: "claude" });
    const req = adapter.buildRequest({
      model: "claude-sonnet-4-6", messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }, {
      provider: "Claude（Anthropic）", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6",
      apiKey: "k", reasoning: { mode: "on", effort: "high" },
    });
    expect(JSON.parse(req.body).tool_choice).toEqual({ type: "auto" });
  });

  test("maps a required-only provider policy to Anthropic any", () => {
    const adapter = new AnthropicAdapter("required-only", {
      ...anthropicCap,
      id: "required-only",
      toolChoiceModes: ["required"],
    });
    const req = adapter.buildRequest({
      model: "m", messages: [{ role: "user", content: "搜歌" }],
      tools: [{ name: "music_search", description: "搜索", parameters: { type: "object" } }],
      toolChoiceIntent: { mode: "must_call", toolName: "music_search" },
    }, { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k", reasoning: { mode: "off" } });
    expect(JSON.parse(req.body).tool_choice).toEqual({ type: "any" });
  });

  test("buildRequest uses x-api-key when authStyle=x-api-key (default Anthropic)", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "sk-test" },
    );
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(req.headers.Authorization).toBeUndefined();
    // anthropic-version 与 authStyle 无关，必须保留
    expect(req.headers["anthropic-version"]).toBeDefined();
  });

  test("buildRequest uses Authorization Bearer when authStyle=bearer (decoupled)", () => {
    const mimoCap: ProviderCapability = {
      ...anthropicCap,
      id: "mimo",
      displayName: "MiMo（小米）",
      authStyle: "bearer",
    };
    const adapter = new AnthropicAdapter("mimo", mimoCap);
    const req = adapter.buildRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { provider: "MiMo（小米）", baseUrl: "https://api.xiaomimimo.com/anthropic", model: "m", apiKey: "sk-test" },
    );
    // 关键：MiMo capability 传入 AnthropicAdapter，wire 上必须是 Authorization: Bearer
    expect(req.headers.Authorization).toBe("Bearer sk-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-version"]).toBeDefined();
  });

  // ─── 流式 / 非流式 thinking 解析（覆盖 Claude / MiniMax） ───

  test("parseStreamEvent: content_block_delta + thinking_delta → chunk.deltaThinking", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const chunk = adapter.parseStreamEvent({
      eventType: "content_block_delta",
      data: JSON.stringify({ delta: { type: "thinking_delta", thinking: "我在推理" } }),
    });
    expect(chunk?.deltaThinking).toBe("我在推理");
    expect(chunk?.deltaText).toBeUndefined();
  });

  test("parseStreamEvent: content_block_delta + text_delta → chunk.deltaText", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const chunk = adapter.parseStreamEvent({
      eventType: "content_block_delta",
      data: JSON.stringify({ delta: { type: "text_delta", text: "你好" } }),
    });
    expect(chunk?.deltaText).toBe("你好");
    expect(chunk?.deltaThinking).toBeUndefined();
  });

  test("parseStreamEvent: data-only compatible event uses JSON type and merges usage", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    expect(adapter.parseStreamEvent({
      eventType: "data",
      data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "兼容流" } }),
    })?.deltaText).toBe("兼容流");
    expect(adapter.parseStreamEvent({
      eventType: "message_start",
      data: JSON.stringify({ message: { usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 8 } } }),
    })?.usage).toEqual({ input: 11, output: 0, cachedInput: 8 });
    expect(adapter.parseStreamEvent({
      eventType: "message_delta",
      data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }),
    })).toMatchObject({ finishReason: "end_turn", usage: { input: 0, output: 8 } });
  });

  test("parseStreamEvent: protocol error is surfaced", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    expect(adapter.parseStreamEvent({
      eventType: "error",
      data: JSON.stringify({ type: "error", error: { message: "overloaded" } }),
    })?.error).toBe("overloaded");
  });

  test("parseResponse: thinking block + text block + tool_use block 完整解析", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const resp = adapter.parseResponse({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "需要查天气" },
        { type: "text", text: "我先查一下" },
        { type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } },
      ],
    });
    expect(resp.thinking).toBe("需要查天气");
    expect(resp.text).toBe("我先查一下");
    expect(resp.toolCalls).toEqual([
      { id: "t1", name: "get_weather", arguments: '{"city":"北京"}' },
    ]);
    expect(resp.finishReason).toBe("tool_calls");  // adapter 把 tool_use 映射成 tool_calls（OpenAI 习惯）
  });

  // ─── 多轮工具调用 + thinking block + signature：appendToolResults → buildRequest 端到端 ───
  // Claude 官方要求多轮 tool_calls 时必须完整回传 assistant.content 数组（含 thinking + tool_use），
  // 本 fixture 断言经过 appendToolResults + buildRequest 后 wire body 里这些 block 的顺序与字段完整。

  test("旧历史无来源时保留文本与工具，不重放推理签名", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const rawAssistantBlocks = [
      { type: "thinking", thinking: "我先想一下", signature: "sig-abc" },
      { type: "text", text: "需要查天气" },
      { type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } },
    ];
    // 输入 messages 不预先手写 tool 消息——appendToolResults() 会生成 tool_result，
    // 否则 wire 上会出现重复的 tool_result。
    const messages = [
      { role: "user" as const, content: "北京天气如何" },
      {
        role: "assistant" as const,
        content: undefined,
        rawAssistant: rawAssistantBlocks,  // 直接是 content block 数组（anthropic-adapter.ts:173 写入形态）
      },
      { role: "user" as const, content: "那上海呢" },
    ];

    const afterAppend = adapter.appendToolResults(messages, [
      { toolCall: { id: "t1", name: "get_weather", arguments: '{"city":"北京"}' }, output: "晴 25°C" },
    ]);

    const req = adapter.buildRequest(
      { model: "claude-test", messages: afterAppend },
      { provider: "Test", baseUrl: "https://e.test/v1", model: "claude-test", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    // 4 条 wire messages：user → assistant(blocks) → user(string) → user(tool_result array)
    // 工具结果 adapter 把 tool_result 嵌入"前一条 user 的 content 数组"——前一条 user 是
    // string content 时走 else 分支新建 user 消息，因此 tool_result 出现在最后一条。
    expect(body.messages).toHaveLength(4);

    // [0] user 原样
    expect(body.messages[0]).toEqual({ role: "user", content: "北京天气如何" });

    // [1] assistant.content 是 block 数组（不是 { content: [...] } 嵌套）
    expect(body.messages[1].role).toBe("assistant");
    expect(Array.isArray(body.messages[1].content)).toBe(true);
    const assistantBlocks = body.messages[1].content as Array<Record<string, unknown>>;
    expect(assistantBlocks).toEqual([
      { type: "text", text: "需要查天气" },
      { type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } },
    ]);

    // [2] 第二条 user（content 是 string，没被 tool_result 嵌入）
    expect(body.messages[2]).toEqual({ role: "user", content: "那上海呢" });

    // [3] tool_result 在 Anthropic 协议里嵌入新生成的 user 消息的 content 数组中
    expect(body.messages[3].role).toBe("user");
    expect(Array.isArray(body.messages[3].content)).toBe(true);
    expect(body.messages[3].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "晴 25°C" },
    ]);
  });

  // ─── 消息级缓存断点（cacheStrategy=cache_control + 模型门控） ───

  test("claude：消息级断点打在最后两条消息上，system 断点保留", () => {
    const adapter = new AnthropicAdapter("claude", { ...anthropicCap, id: "claude" });
    const req = adapter.buildRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "你是测试" },
          { role: "user", content: "第一轮" },
          { role: "assistant", content: "好的" },
          { role: "user", content: "第二轮" },
        ],
      },
      { provider: "Claude（Anthropic）", baseUrl: "https://e.test/v1", model: "claude-sonnet-4-6", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { system: unknown; messages: Array<{ role: string; content: unknown }> };

    expect(body.system).toEqual([
      { type: "text", text: "你是测试", cache_control: { type: "ephemeral" } },
    ]);
    // wire messages 共 3 条（system 是顶层字段）：[user, assistant, user]
    // 最后一条 user：string → text block + 断点
    expect(body.messages[2].content).toEqual([
      { type: "text", text: "第二轮", cache_control: { type: "ephemeral" } },
    ]);
    // 倒数第二条 assistant：blocks 最后一个 block 带断点
    const secondLast = body.messages[1].content as Array<Record<string, unknown>>;
    expect(secondLast[0].cache_control).toEqual({ type: "ephemeral" });
    // 第一条消息不动
    expect(body.messages[0].content).toBe("第一轮");
  });

  test("claude：工具循环的 tool_result 消息也能打断点（滚动断点逐轮命中）", () => {
    const adapter = new AnthropicAdapter("claude", { ...anthropicCap, id: "claude" });
    const afterAppend = adapter.appendToolResults(
      [
        { role: "user" as const, content: "北京天气如何" },
        {
          role: "assistant" as const,
          content: undefined,
          rawAssistant: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } }],
        },
      ],
      [{ toolCall: { id: "t1", name: "get_weather", arguments: "{}" }, output: "晴 25°C" }],
    );
    const req = adapter.buildRequest(
      { model: "claude-sonnet-4-6", messages: afterAppend },
      { provider: "Claude（Anthropic）", baseUrl: "https://e.test/v1", model: "claude-sonnet-4-6", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "晴 25°C", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("claude：打断点时浅拷贝 block 数组，不污染持久化的 rawAssistant", () => {
    const adapter = new AnthropicAdapter("claude", { ...anthropicCap, id: "claude" });
    const rawAssistant: Array<Record<string, unknown>> = [
      { type: "text", text: "需要查天气" },
      { type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } },
    ];
    const req = adapter.buildRequest(
      {
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "北京天气" },
          { role: "assistant", content: undefined, rawAssistant },
        ],
      },
      { provider: "Claude（Anthropic）", baseUrl: "https://e.test/v1", model: "claude-sonnet-4-6", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const blocks = body.messages[1].content;
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect(rawAssistant[1].cache_control).toBeUndefined();
  });

  test("MiniMax M2.7：在显式缓存支持列表内，消息级断点生效", () => {
    const adapter = new AnthropicAdapter("minimax", { ...anthropicCap, id: "minimax" });
    const req = adapter.buildRequest(
      { model: "MiniMax-M2.7", messages: [{ role: "user", content: "hi" }] },
      { provider: "MiniMax（稀宇科技）", baseUrl: "https://e.test/v1", model: "MiniMax-M2.7", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    // 单条消息只打 1 个断点
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("MiniMax M3：不在显式缓存支持列表，消息保持原样（靠被动缓存）", () => {
    const adapter = new AnthropicAdapter("minimax", { ...anthropicCap, id: "minimax" });
    const req = adapter.buildRequest(
      { model: "MiniMax-M3", messages: [{ role: "user", content: "hi" }] },
      { provider: "MiniMax（稀宇科技）", baseUrl: "https://e.test/v1", model: "MiniMax-M3", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  // ---- 图片块转换（known-issues 问题 1：Anthropic 协议发图 400）----

  test("image 块：data URL 转成 Anthropic base64 image block（不再直传 OpenAI image_url）", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      {
        model: "m",
        messages: [{
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }],
        }],
      },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });

  test("image 块：白名单外的 data URL MIME 降级为文本占位块，避免 400", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      {
        model: "m",
        messages: [{
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/bmp;base64,QQ==" } }],
        }],
      },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    const blocks = body.messages[0].content;
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("image/bmp");
  });

  test("image 块：http URL 转成 Anthropic url image block", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      {
        model: "m",
        messages: [{
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/cat.png" } }],
        }],
      },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.test/cat.png" } },
    ]);
  });

  test("image 块：混合 text + image 按序转换", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      {
        model: "m",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "看这张图" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
          ],
        }],
      },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "看这张图" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
    ]);
  });

  test("image 块：webp/gif 也在白名单内", () => {
    const adapter = new AnthropicAdapter("test-anthropic", anthropicCap);
    const req = adapter.buildRequest(
      {
        model: "m",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } },
            { type: "image_url", image_url: { url: "data:image/gif;base64,BBBB" } },
          ],
        }],
      },
      { provider: "p", baseUrl: "https://e.test/v1", model: "m", apiKey: "k" },
    );
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: Array<{ type: string }> }> };
    expect(body.messages[0].content.map((b) => b.type)).toEqual(["image", "image"]);
  });
});
