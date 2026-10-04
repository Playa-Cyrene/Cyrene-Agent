"use strict";

/**
 * 代理端到端自检：真实起 127.0.0.1 端口，拦截全局 fetch 模拟三家上游。
 * 运行：node examples/subscription-oauth/test/e2e.cjs
 */
const assert = require("node:assert");
const http = require("node:http");
const { createProxy } = require("../lib/proxy.cjs");

/** 拦截 fetch 的记录器：返回可配置的响应。 */
const upstreamCalls = [];
global.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), init });
  const body = JSON.parse(String(init.body || "{}"));
  if (String(url).includes("chatgpt.com")) {
    if (body.stream) {
      const input = Array.isArray(body.input) ? body.input : [];
      const functionOutput = input.find((item) => item && item.type === "function_call_output");
      let outputItem;
      if (functionOutput) {
        const matchingCall = input.find((item) => item && item.type === "function_call" && item.call_id === functionOutput.call_id);
        if (!matchingCall) {
          return new Response(JSON.stringify({
            error: { message: `No tool call found for function call output with call_id ${functionOutput.call_id}.` },
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        outputItem = {
          id: "msg-tool-1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "工具续轮成功" }],
        };
      } else {
        outputItem = {
          id: "fc-tool-1",
          type: "function_call",
          status: "completed",
          arguments: "{}",
          call_id: "call-tool-1",
          name: "get_status",
        };
      }
      const frames = [
        { type: "response.output_item.done", output_index: 0, item: outputItem },
        {
          type: "response.completed",
          response: { id: "resp-tool-1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } },
        },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const bytes = new TextEncoder().encode(frames);
      // 故意从 JSON 中间切开，覆盖真实网络中任意分块的情况。
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 37));
          controller.enqueue(bytes.slice(37, 113));
          controller.enqueue(bytes.slice(113));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ id: "resp-1", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "来自 ChatGPT" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).includes("anthropic.com")) {
    return new Response(JSON.stringify({ id: "msg-1", model: body.model, content: [{ type: "text", text: "来自 Claude" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).includes("api.x.ai/v1/responses")) {
    return new Response(JSON.stringify({ id: "resp-grok-1", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "来自 Grok Responses" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  // 旧 Grok Chat Completions 不接受 Responses 的 web_search；代理应自动移除后重试，
  // 保证尚未完成档案迁移时普通对话不被可选搜索能力拖垮。
  if (Array.isArray(body.tools) && body.tools.some((tool) => tool && tool.type === "web_search")) {
    return new Response(JSON.stringify({ error: { message: "tools[0].type: unknown variant web_search" } }), { status: 422, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ id: "chatcmpl-1", model: body.model, choices: [{ message: { role: "assistant", content: "来自 Grok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
};

async function postJson(port, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function parseSse(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

(async () => {
  // 可变的 token 工厂：测试里能切换"未登录"状态
  let loggedIn = true;
  const proxy = createProxy({
    getTokens: async (providerId) => {
      if (!loggedIn) return null;
      if (providerId === "chatgpt") return { tokens: { accessToken: "t-chatgpt", accountId: "acc-1" } };
      if (providerId === "claude") return { tokens: { accessToken: "t-claude" } };
      return { tokens: { accessToken: "t-grok" } };
    },
    log: (m) => console.log(m),
  });
  const port = await proxy.start(0);
  console.log(`代理已启动 127.0.0.1:${port}`);

  let passed = 0;
  const ok = (name, fn) => { fn(); passed += 1; console.log(`  ok - ${name}`); };

  // 1) Grok：/v1/chat/completions 原生 OpenAI 兼容直通
  const grokRes = await postJson(port, "/v1/chat/completions", { model: "grok-4.6", messages: [{ role: "user", content: "hi" }], stream: false });
  ok("Grok /v1/chat/completions 直通且注入订阅头", () => {
    assert.strictEqual(grokRes.status, 200);
    const parsed = JSON.parse(grokRes.text);
    assert.strictEqual(parsed.choices[0].message.content, "来自 Grok");
    const call = upstreamCalls[upstreamCalls.length - 1];
    assert.ok(String(call.url).includes("api.x.ai/v1/chat/completions"));
    assert.strictEqual(call.init.headers.authorization, "Bearer t-grok");
    assert.strictEqual(call.init.headers["x-xai-token-auth"], "xai-grok-cli");
    assert.ok(!JSON.parse(call.init.body).tools, "旧 Chat Completions 搜索不兼容时应无搜索重试");
  });

  // 1b) Grok 新档案走 Responses，代理注入 xAI 服务端 web_search，宿主同名函数被移除。
  const grokResponsesRes = await postJson(port, "/v1/responses", {
    model: "grok-4.6",
    input: [{ role: "user", content: "查最新消息" }],
    tools: [
      { type: "function", name: "web_search", parameters: { type: "object" } },
      { type: "function", name: "get_status", parameters: { type: "object" } },
    ],
    stream: false,
  });
  ok("Grok /v1/responses 使用服务端原生搜索并保留其它宿主工具", () => {
    assert.strictEqual(grokResponsesRes.status, 200);
    assert.strictEqual(JSON.parse(grokResponsesRes.text).output[0].content[0].text, "来自 Grok Responses");
    const call = upstreamCalls[upstreamCalls.length - 1];
    assert.ok(String(call.url).includes("api.x.ai/v1/responses"));
    const sent = JSON.parse(call.init.body);
    const nativeSearch = sent.tools.find((tool) => tool.type === "web_search");
    assert.ok(nativeSearch);
    assert.strictEqual(nativeSearch.enable_image_search, true);
    assert.strictEqual(nativeSearch.enable_image_understanding, true);
    assert.ok(sent.tools.some((tool) => tool.type === "function" && tool.name === "get_status"));
    assert.ok(!sent.tools.some((tool) => tool.type === "function" && tool.name === "web_search"));
  });

  // 2) ChatGPT：/v1/responses 透传（Responses 协议）
  const responsesBody = {
    model: "gpt-5.6-sol",
    instructions: "你是助手",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] }],
    store: false,
    stream: false,
  };
  const chatgptRes = await postJson(port, "/v1/responses", responsesBody);
  ok("ChatGPT /v1/responses 透传 + account-id 注入 + store:false", () => {
    assert.strictEqual(chatgptRes.status, 200);
    const call = upstreamCalls[upstreamCalls.length - 1];
    assert.ok(String(call.url).includes("chatgpt.com/backend-api/codex/responses"));
    assert.strictEqual(call.init.headers["chatgpt-account-id"], "acc-1");
    const sent = JSON.parse(call.init.body);
    assert.strictEqual(sent.store, false);
    assert.strictEqual(sent.model, "gpt-5.6-sol");
    assert.ok(Array.isArray(sent.input));
    const nativeSearch = sent.tools.find((tool) => tool.type === "web_search");
    assert.ok(nativeSearch);
    assert.deepStrictEqual(nativeSearch.search_content_types, ["image", "text"]);
    assert.strictEqual(nativeSearch.image_settings.max_results, 4);
    assert.strictEqual(nativeSearch.image_settings.caption, true);
  });

  // 2b) Codex SSE 的终态 output 可能为空；代理必须用 output_item.done 补回，
  // 否则 Cyrene 下一轮只会发送 function_call_output，导致工具续轮 400。
  const toolStreamRes = await postJson(port, "/v1/responses", {
    model: "gpt-5.6-luna",
    input: [{ role: "user", content: [{ type: "input_text", text: "调用工具" }] }],
    tools: [{ type: "function", name: "get_status", parameters: { type: "object", properties: {} } }],
    store: false,
    stream: true,
  });
  ok("ChatGPT 工具流：空终态 output 用已完成 function_call 补齐", () => {
    assert.strictEqual(toolStreamRes.status, 200);
    const events = parseSse(toolStreamRes.text);
    const completed = events.find((event) => event.type === "response.completed");
    assert.ok(completed);
    assert.strictEqual(completed.response.output.length, 1);
    assert.strictEqual(completed.response.output[0].type, "function_call");
    assert.strictEqual(completed.response.output[0].call_id, "call-tool-1");
  });

  const firstCompleted = parseSse(toolStreamRes.text).find((event) => event.type === "response.completed");
  const replayedFunctionCall = firstCompleted.response.output[0];
  const toolFollowupRes = await postJson(port, "/v1/responses", {
    model: "gpt-5.6-luna",
    input: [
      { role: "user", content: [{ type: "input_text", text: "调用工具" }] },
      replayedFunctionCall,
      { type: "function_call_output", call_id: replayedFunctionCall.call_id, output: "{\"ok\":true}" },
    ],
    tools: [{ type: "function", name: "get_status", parameters: { type: "object", properties: {} } }],
    store: false,
    stream: true,
  });
  ok("ChatGPT 工具续轮：回放 function_call 后上游接受结果并返回正文", () => {
    assert.strictEqual(toolFollowupRes.status, 200);
    const completed = parseSse(toolFollowupRes.text).find((event) => event.type === "response.completed");
    assert.ok(completed);
    assert.strictEqual(completed.response.output.length, 1);
    assert.strictEqual(completed.response.output[0].type, "message");
    assert.strictEqual(completed.response.output[0].content[0].text, "工具续轮成功");
    const call = upstreamCalls[upstreamCalls.length - 1];
    const sent = JSON.parse(call.init.body);
    assert.ok(sent.input.some((item) => item.type === "function_call" && item.call_id === "call-tool-1"));
    assert.ok(sent.input.some((item) => item.type === "function_call_output" && item.call_id === "call-tool-1"));
  });

  // 3) Claude：/v1/messages 透传（Messages 协议）
  const messagesBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    tools: [{ name: "web_search", description: "宿主第三方搜索", input_schema: { type: "object" } }],
    stream: false,
  };
  const claudeRes = await postJson(port, "/v1/messages", messagesBody);
  ok("Claude /v1/messages 透传 + OAuth beta 头", () => {
    assert.strictEqual(claudeRes.status, 200);
    const call = upstreamCalls[upstreamCalls.length - 1];
    assert.ok(String(call.url).includes("api.anthropic.com/v1/messages"));
    assert.strictEqual(call.init.headers["anthropic-beta"], "oauth-2025-04-20");
    const sent = JSON.parse(call.init.body);
    assert.ok(sent.tools.some((tool) => tool.type === "web_search_20250305" && tool.name === "web_search"));
    assert.ok(!sent.tools.some((tool) => !tool.type && tool.name === "web_search"));
  });

  // 4) 端点串线防护
  const wrongEndpoint = await postJson(port, "/v1/responses", { model: "claude-sonnet-4-6", input: [], stream: false });
  ok("端点串线防护：Claude 模型打 responses 端点 → 400", () => {
    assert.strictEqual(wrongEndpoint.status, 400);
    assert.ok(JSON.parse(wrongEndpoint.text).error.message.includes("只接受"));
  });

  // 5) 未登录订阅 → 401
  loggedIn = false;
  const notLoggedRes = await postJson(port, "/v1/chat/completions", { model: "grok-4.6", messages: [{ role: "user", content: "hi" }], stream: false });
  ok("未登录返回 401", () => {
    assert.strictEqual(notLoggedRes.status, 401);
    assert.ok(JSON.parse(notLoggedRes.text).error.message.includes("未登录"));
  });
  loggedIn = true;

  // 6) 未知端点 → 404
  const unknownRes = await postJson(port, "/v1/unknown", { model: "grok-4.6" });
  ok("未知端点返回 404", () => {
    assert.strictEqual(unknownRes.status, 404);
  });

  // 6) /health
  const health = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve(JSON.parse(text)));
    }).on("error", reject);
  });
  ok("/health 正常", () => { assert.strictEqual(health.ok, true); });

  await proxy.stop();
  console.log(`\n${passed} 项端到端断言全部通过，代理已停止`);
})().catch((e) => { console.error("E2E 失败:", e); process.exit(1); });
