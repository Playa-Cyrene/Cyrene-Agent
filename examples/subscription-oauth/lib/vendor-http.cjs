"use strict";

/**
 * 订阅 OAuth 与各家后端的共享 HTTP 工具。
 * 从 Cyrene 内置实现移植（备份提交 803d3eca），去除 TS 类型后保持行为一致。
 */

/** 三家订阅商的显示名 / 默认模型建议 / 后端路由前缀。 */
const PROVIDERS = {
  chatgpt: {
    id: "chatgpt",
    displayName: "ChatGPT",
    defaultModel: "gpt-5.6-sol",
    modelPrefix: "gpt-",
    apiBase: "https://chatgpt.com/backend-api/codex",
    responsesMode: "responses",
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    defaultModel: "claude-sonnet-4-6",
    modelPrefix: "claude-",
    apiBase: "https://api.anthropic.com/v1",
    responsesMode: "anthropic",
  },
  grok: {
    id: "grok",
    displayName: "Grok",
    defaultModel: "grok-4.6",
    modelPrefix: "grok-",
    apiBase: "https://api.x.ai/v1",
    responsesMode: "openai",
  },
};

/**
 * 按模型名判断应路由到哪家订阅后端。
 * @param {string} model
 * @returns {string | undefined} providerId
 */
function providerForModel(model) {
  const m = String(model || "").toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "chatgpt";
  if (m.startsWith("claude-")) return "claude";
  if (m.startsWith("grok-")) return "grok";
  return undefined;
}

/** 三家后端都只认 Bearer，外加各自的特殊头。 */
function authHeaders(providerId, tokens) {
  const base = {
    authorization: `Bearer ${tokens.accessToken}`,
    accept: "application/json",
    // 各家后端会按 UA 识别客户端；保持官方 CLI 的 UA 减少风控概率
    "user-agent":
      providerId === "chatgpt"
        ? "codex_cli_rs/0.147.0"
        : providerId === "claude"
          ? "claude-cli/2.1.110 (external, cli)"
          : "grok-build-cli/0.1",
  };
  if (providerId === "chatgpt") {
    base.originator = "codex_cli_rs";
    if (tokens.accountId) base["chatgpt-account-id"] = tokens.accountId;
  }
  if (providerId === "claude") {
    base["anthropic-beta"] = "oauth-2025-04-20";
    base["anthropic-dangerous-direct-browser-access"] = "true";
  }
  if (providerId === "grok") {
    base["x-xai-token-auth"] = "xai-grok-cli";
  }
  return base;
}

/** OpenAI 兼容 /v1/chat/completions 请求体（代理端→上游）的最小字段。 */
function chatBodyFrom(reqBody, upstreamMode) {
  const model = reqBody.model;
  if (upstreamMode === "anthropic") {
    // Claude Messages API：把 OpenAI 助手/系统消息转 Anthropic 结构
    const system = [];
    const messages = [];
    for (const msg of reqBody.messages || []) {
      if (msg.role === "system") {
        system.push({ type: "text", text: String(msg.content || ""), cache_control: { type: "ephemeral" } });
      } else {
        messages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: [{ type: "text", text: String(msg.content || "") }],
        });
      }
    }
    return {
      model,
      max_tokens: reqBody.max_tokens || 8192,
      stream: Boolean(reqBody.stream),
      ...(system.length ? { system } : {}),
      messages,
      ...(reqBody.temperature !== undefined ? { temperature: reqBody.temperature } : {}),
    };
  }
  // openai / responses：Chat Completions 直接透传（Grok 是 OpenAI 兼容）
  const body = {
    model,
    messages: reqBody.messages || [],
    stream: Boolean(reqBody.stream),
  };
  if (reqBody.max_tokens) body.max_tokens = reqBody.max_tokens;
  if (reqBody.temperature !== undefined) body.temperature = reqBody.temperature;
  if (reqBody.top_p !== undefined) body.top_p = reqBody.top_p;
  if (reqBody.reasoning_effort) body.reasoning_effort = reqBody.reasoning_effort;
  return body;
}

/** 解析 JWT 负载（不校验签名，仅取账号信息展示）。 */
function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  PROVIDERS,
  providerForModel,
  authHeaders,
  chatBodyFrom,
  decodeJwtPayload,
};
