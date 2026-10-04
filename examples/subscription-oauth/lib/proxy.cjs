"use strict";

/**
 * 订阅 OAuth 本地代理服务器。
 *
 * 对外按订阅原生协议暴露三个端点，由 Cyrene 档案选择对应 transport：
 *  - /v1/responses        → ChatGPT Codex / xAI（Responses API）
 *  - /v1/messages         → Claude Code（Messages API）
 *  - /v1/chat/completions → xAI（OpenAI Chat Completions）
 * token 由调用方（index.cjs）通过 getTokens 闭包注入，过期自动刷新。
 */
const http = require("node:http");
const { sanitizeLogText } = require("./privacy.cjs");
const { PROVIDERS, authHeaders, chatBodyFrom, providerForModel, decodeJwtPayload } = require("./vendor-http.cjs");

const DEFAULT_PORT = 6231;
const PORT_FALLBACK_ATTEMPTS = 20;
const HOST_WEB_SEARCH_TOOL = "web_search";
const HOST_MINIMAX_SEARCH_PREFIXES = ["minimax-web-search-", "minimax_web_search_"];

function clientToolName(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  if (tool.type === "function") {
    if (typeof tool.name === "string") return tool.name;
    if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  }
  // Anthropic 客户端工具没有 type，靠 name + input_schema 区分。
  if (!tool.type && tool.input_schema && typeof tool.name === "string") return tool.name;
  return undefined;
}

function isHostWebSearchTool(tool) {
  const name = clientToolName(tool);
  return name === HOST_WEB_SEARCH_TOOL
    || HOST_MINIMAX_SEARCH_PREFIXES.some((prefix) => String(name || "").startsWith(prefix));
}

function isNativeWebSearchTool(providerId, tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  if (providerId === "claude") {
    return typeof tool.type === "string"
      && tool.type.startsWith("web_search_")
      && tool.name === "web_search";
  }
  return tool.type === "web_search";
}

function nativeWebSearchTool(providerId) {
  if (providerId === "claude") {
    // 基础版本兼容 Claude 4.x；服务端自行执行并把引用写入最终文本。
    return { type: "web_search_20250305", name: "web_search", max_uses: 5 };
  }
  if (providerId === "chatgpt") {
    // 允许模型在检索已有角色、人物、地点等视觉主体时同时取得文字资料和
    // 参考图；是否真正搜索仍由模型按本轮任务决定。
    return {
      type: "web_search",
      search_content_types: ["image", "text"],
      image_settings: { max_results: 4, caption: true },
    };
  }
  // xAI Responses 的网页搜索可按需搜索图片，并理解网页中遇到的参考图。
  return {
    type: "web_search",
    enable_image_search: true,
    enable_image_understanding: true,
  };
}

function mergeNativeWebSearchTool(providerId, existingTool) {
  const defaults = nativeWebSearchTool(providerId);
  if (providerId === "claude") return { ...defaults, ...existingTool };
  if (providerId === "chatgpt") {
    return {
      ...defaults,
      ...existingTool,
      image_settings: {
        ...defaults.image_settings,
        ...(existingTool.image_settings && typeof existingTool.image_settings === "object"
          ? existingTool.image_settings
          : {}),
      },
    };
  }
  return { ...defaults, ...existingTool };
}

function toolChoiceTargetsHostSearch(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return false;
  const name = typeof toolChoice.name === "string"
    ? toolChoice.name
    : toolChoice.function && typeof toolChoice.function.name === "string"
      ? toolChoice.function.name
      : undefined;
  return name === HOST_WEB_SEARCH_TOOL
    || HOST_MINIMAX_SEARCH_PREFIXES.some((prefix) => String(name || "").startsWith(prefix));
}

/**
 * 去掉 Cyrene 第三方搜索函数，并注入厂商服务端原生网页搜索。
 * 其它宿主工具保持不变，可与服务端搜索混用。
 */
function withNativeWebSearch(providerId, requestBody) {
  const sourceTools = Array.isArray(requestBody.tools) ? requestBody.tools : [];
  const tools = sourceTools.filter((tool) => !isHostWebSearchTool(tool));
  const removedHostTools = tools.length !== sourceTools.length;
  let injected = false;
  const nativeIndex = tools.findIndex((tool) => isNativeWebSearchTool(providerId, tool));
  if (nativeIndex < 0) {
    tools.push(nativeWebSearchTool(providerId));
    injected = true;
  } else {
    // 客户端已带原生搜索时补齐图片检索能力，同时保留调用方显式设置。
    tools[nativeIndex] = mergeNativeWebSearchTool(providerId, tools[nativeIndex]);
  }
  const body = { ...requestBody, tools };
  if (removedHostTools && toolChoiceTargetsHostSearch(body.tool_choice)) {
    delete body.tool_choice;
  }
  return { body, injected, enabled: true, removedHostTools };
}

function withoutNativeWebSearch(providerId, requestBody) {
  const body = { ...requestBody };
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter((tool) => !isNativeWebSearchTool(providerId, tool));
    if (tools.length > 0) body.tools = tools;
    else delete body.tools;
  }
  if (toolChoiceTargetsHostSearch(body.tool_choice)) delete body.tool_choice;
  return body;
}

function nativeSearchRejected(status, detail) {
  return [400, 422].includes(status)
    && /web[_ -]?search|server[_ -]?side search|search tool/i.test(detail)
    && /unsupported|unknown variant|not (?:enabled|supported|available)|disabled/i.test(detail);
}

function isRetryableListenError(error) {
  return error && (error.code === "EADDRINUSE" || error.code === "EACCES");
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListen);
      reject(error);
    };
    const onListen = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, "127.0.0.1");
  });
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** Bound error reads; do not copy OAuth headers or an HTML challenge into model output. */
async function readErrorText(response, maxBytes = 16 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const part = Buffer.from(value).subarray(0, maxBytes - size);
      chunks.push(part);
      size += part.length;
    }
  } finally {
    if (size >= maxBytes) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function publicError(response, providerId, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* Non-JSON responses are summarized, never exposed verbatim. */ }
  const upstreamError = parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object"
    ? parsed.error : parsed;
  const safeField = (value) => typeof value === "string" && /^[A-Za-z0-9_.:\[\]-]{1,160}$/.test(value) ? value : undefined;
  const requestId = safeField(response.headers.get("x-request-id") || response.headers.get("request-id"))
    || safeField(parsed && parsed.request_id) || safeField(upstreamError && upstreamError.request_id);
  const message = upstreamError && (upstreamError.message || upstreamError.detail || (typeof parsed.error === "string" ? parsed.error : undefined));
  const safeMessage = typeof message === "string" && !/<(?:!doctype|html|script|body)\b/i.test(message)
    ? sanitizeLogText(message.slice(0, 4096))
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted-key]")
      .replace(/((?:authorization|cookie|set-cookie)\b\s*["']?\s*[:=]\s*["']?)[^\r\n"',;}\]]+/gi, "$1[redacted]")
      .replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1000)
    : `上游 ${providerId} 返回 HTTP ${response.status}（${parsed ? "未提供错误说明" : "非 JSON 错误响应"}）`;
  const error = { message: safeMessage, provider: providerId };
  for (const key of ["code", "type", "param"]) {
    const value = safeField(upstreamError && upstreamError[key]);
    if (value) error[key] = value;
  }
  if (requestId) error.request_id = requestId;
  const headers = {};
  if (requestId) headers["x-request-id"] = requestId;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && retryAfter.length <= 128 && !/[\r\n]/.test(retryAfter)) headers["retry-after"] = retryAfter;
  return { payload: { error }, headers };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * ChatGPT Codex 的 Responses SSE 在 `response.output_item.done` 中给出完整
 * output item，但部分版本的终态 `response.completed.response.output` 为空。
 * Cyrene 依赖终态 output 保存 function_call 供工具续轮回放；这里边收集边补齐，
 * 不缓存整条响应，也不改动正常（终态 output 非空）的事件。
 */
function createResponsesSseRepair() {
  const outputItems = new Map();
  let pending = "";

  function transformFrame(frame) {
    const lineBreak = frame.includes("\r\n") ? "\r\n" : "\n";
    const lines = frame.split(/\r?\n/);
    const dataIndexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith("data:")) dataIndexes.push(index);
    }
    // Responses 事件均为单行 JSON。遇到扩展 SSE 形状时原样透传。
    if (dataIndexes.length !== 1) return frame;
    const dataIndex = dataIndexes[0];
    const raw = lines[dataIndex].slice(5).trimStart();
    if (!raw || raw === "[DONE]") return frame;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return frame;
    }

    if (event && event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      const index = Number.isInteger(event.output_index) ? event.output_index : outputItems.size;
      outputItems.set(index, event.item);
    }

    if (event && (event.type === "response.completed" || event.type === "response.incomplete")) {
      const response = event.response;
      const collected = [...outputItems.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);
      if (response && typeof response === "object"
        && (!Array.isArray(response.output) || response.output.length === 0)
        && collected.length > 0) {
        response.output = collected;
        lines[dataIndex] = `data: ${JSON.stringify(event)}`;
        return lines.join(lineBreak);
      }
    }

    return frame;
  }

  return {
    push(text) {
      pending += text;
      let output = "";
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        const frame = pending.slice(0, separator.index);
        output += transformFrame(frame) + separator[0];
        pending = pending.slice(separator.index + separator[0].length);
      }
      return output;
    },
    flush() {
      if (!pending) return "";
      const output = transformFrame(pending);
      pending = "";
      return output;
    },
  };
}

/** 从 token 的 JWT 解析 tier，用于用量展示降级。 */
function tierOf(tokens) {
  const claims = decodeJwtPayload(tokens.accessToken || tokens.idToken);
  if (claims && claims.tier) return String(claims.tier);
  if (claims && claims.plan) return String(claims.plan);
  return undefined;
}

/**
 * 创建代理服务器。
 * @param {object} options
 * @param {(providerId: string) => Promise<{tokens: object} | null>} options.getTokens
 *   token 解析器：返回 null 表示未登录；内部负责刷新。
 * @param {(message: string) => void} options.log
 * @param {(providerId: string) => Promise<object>} options.fetchUsage  （可选）用量查询
 * @param {(providerId: string) => Promise<object>} options.fetchCatalog （可选）模型目录查询
 * @param {{tryServe: (req: object, res: object, url: URL) => boolean}} options.mediaStore
 *   （可选）插件私有图片的只读本地服务
 * @returns {{ server: import('node:http').Server, port: () => number, start: () => Promise<number>, stop: () => Promise<void> }}
 */
function createProxy({ getTokens, log = () => {}, fetchUsage, fetchCatalog, mediaStore }) {
  /** 当前监听端口；0 表示未启动或已停止。 */
  let currentPort = 0;
  let server = null;

  /**
 * 协议端点 → 上游路由表。
 * 关键：每种订阅用其**原生协议**直通，代理注入认证头并只做必要的
 * 上游兼容性校正，不做跨协议转换——Cyrene 的对应 transport 本来就发对格式
 * （Responses transport 恒定发 store:false + instructions，见
 *  src/main/orchestrator/vendors/responses-adapter.ts 头注释）。
 */
const ENDPOINTS = {
  "/v1/chat/completions": {
    upstreams: { grok: "https://api.x.ai/v1/chat/completions" },
  },
  "/v1/responses": {
    upstreams: {
      chatgpt: "https://chatgpt.com/backend-api/codex/responses",
      grok: "https://api.x.ai/v1/responses",
    },
  },
  "/v1/messages": {
    upstreams: { claude: "https://api.anthropic.com/v1/messages?beta=true" },
  },
};

/** 按模型名解析端点内的订阅商与上游地址（防串线）。 */
function resolveEndpointRoute(endpoint, model) {
  const providerId = providerForModel(model);
  const upstream = providerId && endpoint.upstreams[providerId];
  return upstream ? { providerId, upstream } : undefined;
}

async function handleChatCompletions(req, res, endpoint) {
    const body = await readBody(req).catch((error) => {
      json(res, 400, { error: { message: error.message } });
      return null;
    });
    if (!body) return;
    const model = String(body.model || "");
    const route = resolveEndpointRoute(endpoint, model);
    if (!route) {
      const accepted = Object.keys(endpoint.upstreams).map((id) => PROVIDERS[id].displayName).join(" / ");
      json(res, 400, {
        error: {
          message: `该端点只接受 ${accepted} 模型（收到 ${model || "(空)"}）`,
        },
      });
      return;
    }
    const { providerId, upstream: upstreamUrl } = route;
    const auth = await getTokens(providerId).catch((error) => {
      json(res, 502, { error: { message: `读取订阅 token 失败：${error.message}` } });
      return null;
    });
    if (!auth || !auth.tokens) {
      json(res, 401, { error: { message: `${PROVIDERS[providerId].displayName} 订阅未登录，请打开插件登录后再试` } });
      return;
    }
    const tokens = auth.tokens;
    const headers = authHeaders(providerId, tokens);
    headers["content-type"] = "application/json";

    // 原样透传请求体，仅做必要的防御性修正。网页搜索统一交给厂商服务端：
    // 清掉宿主第三方搜索函数，保留其它客户端工具，再注入原生搜索工具。
    const nativeSearch = withNativeWebSearch(providerId, body);
    let upstreamBody = nativeSearch.body;
    if (providerId === "chatgpt") {
      // Codex 端点强制要求 store:false（Cyrene 的 Responses transport 已带，
      // 这里兜底以防其它客户端省略）
      upstreamBody.store = false;
      // Codex 端点校验比官方 Responses API 更严：assistant 历史消息的
      // content part 只接受 output_text / refusal，收到 input_text 直接 400。
      // 注意：不能要求 item.type === "message"——通用客户端（含 Cyrene）发的
      // assistant 历史项可能不带该字段，只按 role 判定。
      if (Array.isArray(upstreamBody.input)) {
        for (const item of upstreamBody.input) {
          if (!item || item.role !== "assistant") continue;
          if (!Array.isArray(item.content)) continue;
          for (const part of item.content) {
            if (part && part.type === "input_text") part.type = "output_text";
          }
        }
      }
      headers["openai-beta"] = "responses=experimental";
    }

    log(`[proxy] ${model} → ${providerId} ${upstreamUrl.split("?")[0]} (stream=${Boolean(body.stream)}, native-search=on)`);

    const disconnect = new AbortController();
    res.once("close", () => disconnect.abort());
    const requestSignal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(300_000)]);
    const requestUpstream = (payload) => fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
    let upstream = await requestUpstream(upstreamBody);
    let errorText;
    // 个别账号/组织可能在服务端关闭原生搜索。只在错误明确指向搜索工具时
    // 无搜索重试，避免一个可选能力拖垮所有普通对话。
    if (!upstream.ok && nativeSearch.enabled && [400, 422].includes(upstream.status)) {
      errorText = await readErrorText(upstream).catch(() => "");
      if (nativeSearchRejected(upstream.status, errorText)) {
        log(`[proxy] ${providerId} 原生网页搜索不可用，本轮降级为无搜索请求`);
        upstreamBody = withoutNativeWebSearch(providerId, upstreamBody);
        upstream = await requestUpstream(upstreamBody);
        errorText = undefined;
      }
    }

    if (!upstream.ok) {
      const detail = errorText ?? await readErrorText(upstream).catch(() => "");
      const failure = publicError(upstream, providerId, detail);
      log(`[proxy] ${providerId} HTTP ${upstream.status} code=${failure.payload.error.code || "unknown"} request-id=${failure.headers["x-request-id"] || "unavailable"}`);
      if (!res.destroyed) json(res, upstream.status, failure.payload, failure.headers);
      return;
    }

    if (body.stream) {
      // SSE 真流式转发；ChatGPT 只缓存已完成 output item，并在空终态中补回，
      // 让 Cyrene 能保存 function_call 后继续发送工具结果。
      res.writeHead(upstream.status, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const repair = providerId === "chatgpt" ? createResponsesSseRepair() : null;
        const decoder = repair ? new TextDecoder() : null;
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              if (repair && decoder) {
                const repaired = repair.push(decoder.decode(value, { stream: true }));
                if (repaired) res.write(repaired);
              } else {
                res.write(Buffer.from(value));
              }
            }
          } catch {
            // 客户端断开或上游中断：直接结束
          } finally {
            if (repair && decoder) {
              const repaired = repair.push(decoder.decode()) + repair.flush();
              if (repaired) res.write(repaired);
            }
            res.end();
          }
        };
        await pump();
      } else {
        res.end();
      }
      return;
    }

    const text = await upstream.text().catch(() => "");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      json(res, 502, { error: { message: `上游 ${providerId} 返回了非 JSON 内容` } });
      return;
    }
    json(res, 200, parsed);
  }

  async function handleModels(res) {
    if (!fetchCatalog) {
      const models = [];
      for (const key of Object.keys(PROVIDERS)) {
        const auth = await getTokens(key).catch(() => null);
        if (auth && auth.tokens) models.push({ id: `${key}-default`, object: "model" });
      }
      json(res, 200, { object: "list", data: models });
      return;
    }
    const out = [];
    for (const key of Object.keys(PROVIDERS)) {
      const auth = await getTokens(key).catch(() => null);
      if (!auth || !auth.tokens) continue;
      const catalog = await fetchCatalog(key).catch(() => null);
      if (catalog && Array.isArray(catalog.models)) {
        for (const m of catalog.models) out.push({ id: m.id, object: "model", owned_by: key, name: m.name });
      }
    }
    json(res, 200, { object: "list", data: out });
  }

  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${currentPort || DEFAULT_PORT}`);
    if (mediaStore && mediaStore.tryServe(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, port: currentPort });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      handleModels(res).catch((error) => json(res, 500, { error: { message: error.message } }));
      return;
    }
    if (req.method === "POST" && ENDPOINTS[url.pathname]) {
      handleChatCompletions(req, res, ENDPOINTS[url.pathname]).catch((error) => {
        if (res.destroyed) return;
        if (res.headersSent) { res.end(); return; }
        json(res, 502, { error: { message: sanitizeLogText(error.message), code: "upstream_connection_error" } });
      });
      return;
    }
    json(res, 404, {
      error: {
        message: `未知端点 ${url.pathname}（支持 POST ${Object.keys(ENDPOINTS).join(" / ")}，GET /v1/models，GET /health，GET /media/...）`,
      },
    });
  });

  return {
    server,
    port: () => currentPort,
    async start(preferredPort = DEFAULT_PORT) {
      if (server && currentPort) return currentPort;
      const firstPort = Number.isInteger(preferredPort) && preferredPort >= 0 && preferredPort <= 65535
        ? preferredPort
        : DEFAULT_PORT;
      const candidates = firstPort === 0
        ? [0]
        : Array.from(
            { length: Math.min(PORT_FALLBACK_ATTEMPTS, 65536 - firstPort) },
            (_, index) => firstPort + index,
          );
      // 极端情况下连续 20 个固定端口都不可用，最后交给系统分配一个空闲端口。
      if (firstPort !== 0) candidates.push(0);

      let firstFailure = null;
      for (const candidate of candidates) {
        try {
          currentPort = await listenOnce(server, candidate);
          if (firstFailure) {
            log(`[proxy] 端口 ${firstPort} 不可用（${firstFailure.code || "listen_failed"}），已自动改用 ${currentPort}`);
          }
          log(`[proxy] 已监听 127.0.0.1:${currentPort}`);
          return currentPort;
        } catch (error) {
          if (!firstFailure) firstFailure = error;
          if (!isRetryableListenError(error) || candidate === 0) throw error;
        }
      }
      throw firstFailure || new Error("没有可用的本地代理端口");
    },
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      currentPort = 0;
      await new Promise((resolve) => s.close(() => resolve()));
    },
  };
}

module.exports = {
  createProxy,
  createResponsesSseRepair,
  withNativeWebSearch,
  withoutNativeWebSearch,
  DEFAULT_PORT,
  tierOf,
};
