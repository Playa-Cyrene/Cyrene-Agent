// OpenAI 兼容 transport —— 覆盖 豆包 / DeepSeek / GLM / Kimi / Qwen / ChatGPT
// 请求体协议：POST {baseUrl}/chat/completions，messages + tools[].type=function
import {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter,
  HttpRequest, ProviderCapability, StreamChunk, StreamEvent,
  TestConnectionResult, ToolCall, ToolExecutionResult, VendorConfig,
} from "./types";
import { authHeaderFor } from "./auth";
import { applyManualReasoningBody, normalizeManualReasoningConfig, resolveConfiguredReasoningCapability } from "../../../shared/manual-reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";
import { buildStableCacheFingerprint } from "../prompt-layers";

/** 把统一消息翻译成 OpenAI wire messages。 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === "system") return { role: "system", content: m.content ?? "" };
    if (m.role === "user") return { role: "user", content: m.content ?? "" };
    if (m.role === "tool") {
      const wire: Record<string, unknown> = {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content ?? "",
      };
      if (m.name) wire.name = m.name;
      return wire;
    }
    // assistant：回传 content + tool_calls（OpenAI 多轮要求 assistant 消息带 tool_calls）
    const wire: Record<string, unknown> = { role: "assistant", content: m.content || null };
    if (m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return wire;
  });
}

function toWireTools(tools?: ChatRequest["tools"]): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OpenAICompatAdapter implements ChatVendorAdapter {
  readonly transport = "openai" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toWireMessages(req.messages),
      stream: req.stream ?? false,
    };
    // OpenAI 流式协议默认不返回 usage；显式开启 include_usage 让最后一个 chunk 带 usage。
    if (req.stream) {
      body.stream_options = { include_usage: true };
    }
    // temperature 只在调用方显式传时才塞进 body。
    // 不传时让厂商用默认值——不同型号约束不同（如 Kimi k2.6 只允许 1），
    // 硬编码兜底值会在某些模型上报错。
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.frequencyPenalty !== undefined) body.frequency_penalty = req.frequencyPenalty;
    if (req.repetitionPenalty !== undefined) body.repetition_penalty = req.repetitionPenalty;
    // maxTokens：调用方显式传时才塞（流式场景下通常不传）
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (getVendorRuntimeSettings().disableMaxToken) body.max_tokens = undefined;
    const tools = toWireTools(req.tools);
    if (tools) {
      body.tools = tools;
      if (req.toolChoiceIntent) {
        const policy = resolveToolChoicePolicy({
          providerId: this.capability.id,
          model: cfg.model,
          transport: this.transport,
          reasoning: cfg.reasoning ?? { mode: "auto" },
          manualReasoning: cfg.manualReasoning,
          requestedToolName: req.toolChoiceIntent.toolName,
          supportedModes: this.capability.toolChoiceModes,
        });
        if (policy.kind === "named") body.tool_choice = { type: "function", function: { name: policy.name } };
        else if (policy.kind === "required") body.tool_choice = "required";
        else if (policy.kind === "auto") body.tool_choice = "auto";
      } else if (resolveAutomaticToolChoicePolicy({
        providerId: this.capability.id,
        model: cfg.model,
        transport: this.transport,
        reasoning: cfg.reasoning ?? { mode: "auto" },
        manualReasoning: cfg.manualReasoning,
        supportedModes: this.capability.toolChoiceModes,
      }) === "auto") {
        body.tool_choice = "auto";
      }
    }
    if (req.extraBody) Object.assign(body, req.extraBody);
    if (req.structuredOutput?.mode === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.structuredOutput.name,
          strict: req.structuredOutput.strict,
          schema: req.structuredOutput.schema,
        },
      };
    } else if (
      req.structuredOutput?.mode === "json_object"
      || req.structuredOutput?.mode === "prompt_json" && req.structuredOutput.sendJsonObjectHint
    ) {
      body.response_format = { type: "json_object" };
    }
    // 推理控制：按 (providerId, model) 解析 capability，调用 applyReasoningPreference 转换 body。
    // cfg.reasoning 缺省视为旧 auto，由能力表解析为可调模型的默认档位。
    const manualReasoning = normalizeManualReasoningConfig(cfg.manualReasoning);
    const reasoningCap = resolveConfiguredReasoningCapability(this.capability.id, cfg.model, manualReasoning);
    const finalBody = applyReasoningPreference(
      body,
      cfg.reasoning ?? { mode: "auto" },
      reasoningCap,
      {
        hasTools: Boolean(req.tools?.length),
        providerId: this.capability.id,
        model: cfg.model,
        ignoreThinkingOverride: Boolean(manualReasoning),
      },
    );
    const wireBody = applyManualReasoningBody(finalBody, manualReasoning, cfg.reasoning ?? { mode: "auto" });
    return {
      url: resolveApiEndpoint(cfg.baseUrl, "openai").url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaderFor(this.capability, cfg.apiKey, "openai"),
      },
      body: JSON.stringify(wireBody),
    };
  }

  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    // 复用 buildRequest：adapter 内部已按 req.stream 写 body，强制 stream=true
    return this.buildRequest({ ...req, stream: true }, cfg);
  }

  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    // OpenAI 流式：eventType 始终是 "data"（createSseReader 已统一）
    const jsonStr = event.data.trim();
    if (!jsonStr) return null;
    if (jsonStr === "[DONE]") return { done: true };
    let parsed: {
      choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; thinking?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      error?: { message?: unknown };
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }
    if (parsed.error) {
      return { error: typeof parsed.error.message === "string" ? parsed.error.message : "模型流式响应返回错误" };
    }
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;
    const chunk: StreamChunk = {};
    if (typeof delta?.content === "string") chunk.deltaText = delta.content;
    const thinking = delta?.reasoning_content ?? delta?.thinking ?? delta?.reasoning;
    if (typeof thinking === "string") chunk.deltaThinking = thinking;
    if (typeof choice?.finish_reason === "string") chunk.finishReason = choice.finish_reason;
    if (parsed.usage) {
      chunk.usage = {
        input: parsed.usage.prompt_tokens ?? 0,
        output: parsed.usage.completion_tokens ?? 0,
        ...(typeof parsed.usage.prompt_tokens_details?.cached_tokens === "number"
          ? { cachedInput: parsed.usage.prompt_tokens_details.cached_tokens }
          : {}),
      };
    }
    // 暂不实现：if (Array.isArray(delta.tool_calls)) chunk.deltaToolCalls = ...
    // 当前三个调用点（MemoryJudge / memory-compressor / 心情观察器）都不带 tools，
    // 未来若需要流式 tool_call 增量，单独实现 + 加测试即可。
    return Object.keys(chunk).length > 0 ? chunk : null;
  }

  parseResponse(raw: unknown): ChatResponse {
    const data = raw as {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
          reasoning_content?: string;
          thinking?: string;
          refusal?: string | null;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const text = msg?.content ?? "";
    const thinking = msg?.reasoning_content || msg?.thinking || undefined;
    const refusal = msg?.refusal || undefined;

    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(thinking ? { thinking } : {}),
    };

    // 提取 token 用量（OpenAI 协议: prompt_tokens/completion_tokens）
    const usage = data.usage
      ? {
          input: data.usage.prompt_tokens ?? 0,
          output: data.usage.completion_tokens ?? 0,
          ...(typeof data.usage.prompt_tokens_details?.cached_tokens === "number"
            ? { cachedInput: data.usage.prompt_tokens_details.cached_tokens }
            : {}),
        }
      : undefined;

    return {
      assistantMessage,
      text,
      thinking,
      refusal,
      toolCalls,
      finishReason: choice?.finish_reason ?? "stop",
      raw,
      usage,
    };
  }

  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      next.push({
        role: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        content: r.output,
      });
    }
    return next;
  }

  // Kimi：cache key 只反映可缓存前缀和工具定义，绝不包含用户输入、Todo 或 runId。
  applyCacheHints(req: ChatRequest, _cfg: VendorConfig): ChatRequest {
    if (this.capability.cacheStrategy !== "prompt_cache_key") return req;
    const layers = req.promptLayers;
    const fingerprint = layers
      ? buildStableCacheFingerprint({
          provider: this.id,
          model: req.model,
          mode: layers.mode,
          promptVersion: layers.promptVersion,
          stablePrefix: layers.stablePrefix,
          sessionPrefix: layers.sessionPrefix,
          tools: req.tools ?? [],
        })
      : "legacy";
    const extraBody = { ...(req.extraBody ?? {}), prompt_cache_key: `cyrene:${this.id}:${fingerprint}` };
    return { ...req, extraBody };
  }

  async testConnection(cfg: VendorConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getTimeoutSettings().testTimeout);
    try {
      const req: ChatRequest = {
        model: cfg.model,
        messages: [{ role: "user", content: "ping，请只回复两个字符：ok" }],
        // 不传 temperature：某些模型（如 Kimi k2.6）只允许特定值，传 0 会报错
        stream: false,
      };
      const http = this.buildRequest(req, cfg);
      const res = await fetch(http.url, {
        method: "POST",
        signal: controller.signal,
        headers: http.headers,
        body: http.body,
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, latency, error: `HTTP ${res.status} ${t.slice(0, 200)}` };
      }
      const data = await res.json();
      const parsed = this.parseResponse(data);
      return { ok: true, latency, sample: parsed.text.slice(0, 80) || "(空回复)" };
    } catch (e) {
      return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
