"use strict";

/**
 * 代理逻辑的自检脚本：不起真实端口，直接对 handleChatCompletions
 * 的纯函数部分做断言。
 * 运行：node examples/subscription-oauth/test/verify.cjs
 */
const assert = require("node:assert");
const { createProxy } = require("../lib/proxy.cjs");
const { providerForModel, chatBodyFrom, authHeaders, decodeJwtPayload } = require("../lib/vendor-http.cjs");

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("vendor-http.cjs");
ok("providerForModel 识别三家前缀", () => {
  assert.strictEqual(providerForModel("gpt-5.6-sol"), "chatgpt");
  assert.strictEqual(providerForModel("claude-sonnet-4-6"), "claude");
  assert.strictEqual(providerForModel("grok-4.6"), "grok");
  assert.strictEqual(providerForModel("llama-3"), undefined);
});

ok("chatBodyFrom openai 透传核心字段", () => {
  const body = chatBodyFrom({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }], stream: true, reasoning_effort: "high", temperature: 0.7 }, "openai");
  assert.strictEqual(body.model, "grok-4.6");
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.reasoning_effort, "high");
  assert.strictEqual(body.temperature, 0.7);
});

ok("chatBodyFrom anthropic 转换 system/messages", () => {
  const body = chatBodyFrom({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" },
    ],
  }, "anthropic");
  assert.strictEqual(body.model, "claude-sonnet-4-6");
  assert.ok(Array.isArray(body.system));
  assert.strictEqual(body.system[0].text, "你是助手");
  assert.strictEqual(body.messages.length, 2);
  assert.strictEqual(body.messages[0].role, "user");
});

ok("authHeaders 三家各自附头", () => {
  const g = authHeaders("chatgpt", { accessToken: "t", accountId: "acc-1" });
  assert.strictEqual(g["chatgpt-account-id"], "acc-1");
  assert.strictEqual(g.originator, "codex_cli_rs");
  const c = authHeaders("claude", { accessToken: "t" });
  assert.strictEqual(c["anthropic-beta"], "oauth-2025-04-20");
  assert.ok(c["user-agent"].includes("claude-cli"));
  const x = authHeaders("grok", { accessToken: "t" });
  assert.strictEqual(x["x-xai-token-auth"], "xai-grok-cli");
});

ok("decodeJwtPayload 解析 tier", () => {
  // 构造一个最小 JWT（payload 为 {"tier":4}）
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = `${b64({ alg: "none" })}.${b64({ tier: 4 })}.sig`;
  const claims = decodeJwtPayload(token);
  assert.strictEqual(claims.tier, 4);
});

console.log("proxy.cjs");
ok("createProxy 返回握手段（不启动端口）", () => {
  const proxy = createProxy({ getTokens: async () => null, log: () => {} });
  assert.strictEqual(typeof proxy.start, "function");
  assert.strictEqual(typeof proxy.stop, "function");
  assert.strictEqual(typeof proxy.port, "function");
  assert.strictEqual(proxy.port(), 0);
});

console.log(`\n${passed} 项断言全部通过`);
