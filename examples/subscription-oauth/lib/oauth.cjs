"use strict";

/**
 * 订阅 OAuth 登录核心：PKCE + 本地回调监听 + token 交换与刷新。
 * 移植自 Cyrene 内置实现（备份提交 803d3eca 的 pkce.ts / loopback.ts / providers.ts）。
 */
const http = require("node:http");
const { createHash, randomBytes } = require("node:crypto");
const { PROVIDERS, decodeJwtPayload } = require("./vendor-http.cjs");
const { sanitizeLogText } = require("./privacy.cjs");

const OAUTH_SPECS = {
  chatgpt: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    host: "127.0.0.1",
    redirectHost: "localhost",
    port: 1455,
    pathname: "/auth/callback",
    tokenContentType: "form",
    includeStateInTokenExchange: false,
    scopes: ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"],
    extraAuthorizeParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
      prompt: "login",
    },
    extraHeaders: { originator: "codex_cli_rs" },
  },
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    host: "127.0.0.1",
    redirectHost: "localhost",
    port: 54545,
    pathname: "/callback",
    tokenContentType: "json",
    includeStateInTokenExchange: true,
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    extraHeaders: {
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-cli/2.1.110 (external, cli)",
    },
  },
  grok: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    host: "127.0.0.1",
    redirectHost: "127.0.0.1",
    port: 56121,
    pathname: "/callback",
    tokenContentType: "form",
    includeStateInTokenExchange: false,
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    extraAuthorizeParams: {
      plan: "generic",
      referrer: "opencode",
    },
    extraHeaders: { Accept: "application/json" },
  },
};

function randomUrlSafe(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function redirectUriFor(spec) {
  return `http://${spec.redirectHost || spec.host}:${spec.port}${spec.pathname}`;
}

function buildAuthorizeUrl(spec, state, challenge) {
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", spec.clientId);
  url.searchParams.set("redirect_uri", redirectUriFor(spec));
  url.searchParams.set("scope", spec.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(spec.extraAuthorizeParams || {})) {
    url.searchParams.set(key, key === "nonce" && !value ? randomUrlSafe(16) : value);
  }
  return url.toString();
}

const SUCCESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>订阅登录成功</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1b1020; color: #fce7f3; }
    .card { text-align: center; padding: 32px 40px; border-radius: 20px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,182,220,.24); }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0; color: #fbcfe8; }
  </style>
</head>
<body>
  <div class="card"><h1>登录成功</h1><p>可以关闭此窗口，返回 Cyrene。</p></div>
  <script>setTimeout(function(){ window.close(); }, 1500);</script>
</body>
</html>`;

function errorHtml(message) {
  const safe = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>订阅登录失败</title></head>
<body style="font-family:system-ui;padding:40px;background:#1b1020;color:#fecdd3">
  <h1>登录失败</h1><p>${safe}</p>
</body></html>`;
}

/**
 * 本地监听 OAuth 回调；只接受期望 pathname + state。
 * @returns {Promise<{code: string}>}
 */
function listenForOAuthCallback({ host, port, pathname, expectedState, timeoutMs, signal }) {
  const expectedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      try {
        // Grok/X 的 x.ai 会做 CORS 预检
        const origin = req.headers.origin;
        if (origin === "https://accounts.x.ai" || origin === "https://auth.x.ai") {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        }
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        const url = new URL(req.url || "/", `http://${host}:${port}`);
        if (url.pathname !== expectedPath) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        if (error) {
          const message = errorDescription || error;
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml(message));
          finish(new Error(`订阅登录被拒绝：${message}`));
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml("state 校验失败"));
          finish(new Error("订阅登录失败：state 校验失败"));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml("缺少 authorization code"));
          finish(new Error("订阅登录失败：缺少 authorization code"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SUCCESS_HTML);
        finish(undefined, { code });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Error");
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      server.close(() => {
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new Error("订阅登录已取消"));
      });
    };

    const onAbort = () => finish(new Error("订阅登录已取消"));
    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => finish(new Error("订阅登录超时，请重试")), timeoutMs);
    server.on("error", (error) => {
      finish(new Error(`无法监听登录回调端口 ${port}：${error.message}`));
    });
    // 不绑死 127.0.0.1：redirect_uri 是 localhost 时浏览器可能走 IPv4 或 IPv6
    server.listen(port);
  });
}

function expiresAtFrom(json, fallbackSeconds) {
  const seconds = typeof json.expires_in === "number" ? json.expires_in : (fallbackSeconds || 3600);
  return Date.now() + Math.max(60, seconds) * 1000;
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chatgptAccountId(json) {
  const auth = json.auth && typeof json.auth === "object" ? json.auth : undefined;
  const direct = asString(auth && auth.chatgpt_account_id) || asString(json.chatgpt_account_id);
  if (direct) return direct;
  const claims = decodeJwtPayload(asString(json.id_token) || asString(json.access_token));
  const authClaim = claims && claims["https://api.openai.com/auth"];
  return asString(authClaim && authClaim.chatgpt_account_id) || asString(claims && claims.chatgpt_account_id);
}

function chatgptLabel(json, tokens) {
  const claims = decodeJwtPayload(asString(json.id_token) || tokens.idToken);
  return asString(claims && claims.email) || asString(claims && claims.name) || tokens.accountId;
}

/** 各家 token 响应 → 统一 token 结构。 */
function parseTokens(providerId, json) {
  const accessToken = asString(json.access_token);
  if (!accessToken) throw new Error(`${PROVIDERS[providerId].displayName} 登录未返回 access_token`);
  const tokens = {
    accessToken,
    refreshToken: asString(json.refresh_token),
    expiresAt: expiresAtFrom(json, providerId === "claude" ? 8 * 3600 : 3600),
    tokenType: asString(json.token_type) || "Bearer",
    idToken: asString(json.id_token),
    accountId: undefined,
    accountLabel: undefined,
  };
  if (providerId === "chatgpt") {
    tokens.accountId = chatgptAccountId(json);
    tokens.accountLabel = chatgptLabel(json, tokens);
  } else if (providerId === "claude") {
    const account = json.account && typeof json.account === "object" ? json.account : undefined;
    tokens.accountLabel = asString(account && account.email) || "Claude Pro / Max";
  } else {
    const claims = decodeJwtPayload(tokens.idToken);
    tokens.accountLabel = asString(claims && claims.email) || asString(claims && claims.name) || "SuperGrok";
  }
  return tokens;
}

async function requestTokens(spec, providerId, params) {
  const bodyParams = { client_id: spec.clientId, ...params };
  const headers = { Accept: "application/json", ...(spec.extraHeaders || {}) };
  let body;
  if (spec.tokenContentType === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(bodyParams);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(bodyParams).toString();
  }
  const response = await fetch(spec.tokenUrl, { method: "POST", headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${PROVIDERS[providerId].displayName} token 请求失败：HTTP ${response.status} ${sanitizeLogText(text.slice(0, 240))}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${PROVIDERS[providerId].displayName} token 响应不是 JSON`);
  }
  return parseTokens(providerId, json);
}

/**
 * 完整登录流程：开浏览器 → 等待回调 → 交换 token。
 * @param {string} providerId
 * @param {object} deps - { shell, ctx, storage } 等宿主注入
 */
async function login(providerId, logger, openExternal) {
  const spec = OAUTH_SPECS[providerId];
  if (!spec) throw new Error(`未知订阅厂商: ${providerId}`);
  const verifier = randomUrlSafe(32);
  const challenge = pkceChallenge(verifier);
  const state = randomUrlSafe(24);
  const authorizeUrl = buildAuthorizeUrl(spec, state, challenge);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    await openExternal(authorizeUrl);
    const callback = await listenForOAuthCallback({
      host: spec.host,
      port: spec.port,
      pathname: spec.pathname,
      expectedState: state,
      timeoutMs: 5 * 60 * 1000,
      signal: controller.signal,
    });
    const params = {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirectUriFor(spec),
      code_verifier: verifier,
    };
    if (spec.includeStateInTokenExchange) params.state = state;
    return await requestTokens(spec, providerId, params);
  } finally {
    clearTimeout(timer);
    logger(`[oauth:${providerId}] 登录流程结束`);
  }
}

/**
 * 用 refresh_token 换新 token；refreshToken 为空直接抛错。
 */
async function refresh(providerId, refreshToken, logger) {
  const spec = OAUTH_SPECS[providerId];
  if (!spec) throw new Error(`未知订阅厂商: ${providerId}`);
  if (!refreshToken) throw new Error("没有 refresh_token，请重新登录");
  const tokens = await requestTokens(spec, providerId, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  logger(`[oauth:${providerId}] refresh 成功`);
  return tokens;
}

module.exports = {
  OAUTH_SPECS,
  redirectUriFor,
  login,
  refresh,
  parseTokens,
};
