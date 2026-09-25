// Anthropic transport —— MiniMax（主推）/ Claude
// 请求体协议：POST {baseUrl}/v1/messages（baseUrl 已含 /v1 时只加 /messages）
// system 顶层 + messages[].content 为 content block 数组 + tools[].input_schema
//
// 鉴权由 authHeaderFor 根据 capability.authStyle 决定——Anthropic transport
// 也可以配 bearer（如 MiMo /anthropic 端点）。
import {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter,
  ChatMessageContent, HttpRequest, ProviderCapability, StreamChunk, StreamEvent,
  TestConnectionResult, ToolCall, ToolExecutionResult, VendorConfig,
} from "./types";
import { authHeaderFor } from "./auth";
import { applyManualReasoningBody, normalizeManualReasoningConfig, resolveConfiguredReasoningCapability } from "../../../shared/manual-reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

/**
 * 消息级缓存断点的模型门控（官方显式缓存支持列表，2026-08）：
 * - Claude：全系支持 content block 上的 cache_control；
 * - MiniMax：显式缓存仅 M2.x 系列（M2 / M2.1 / M2.5 / M2.7，含 highspeed/Stable 变体）；
 *   M3 靠被动缓存（服务端自动前缀匹配，无需断点），保守起见不对其发送。
 */
function supportsMessageCacheBreakpoint(adapterId: string, model: string): boolean {
  if (adapterId === "claude") return true;
  if (adapterId === "minimax") return /^minimax-m2(?:$|[.-])/i.test(model.trim());
  return false;
}

/** 给一条 wire message 的最后一个 content block 打 ephemeral 缓存断点；返回是否成功。 */
function markMessageCacheBreakpoint(message: Record<string, unknown>): boolean {
  if (typeof message.content === "string" && message.content.length > 0) {
    message.content = [{
      type: "text",
      text: message.content,
      cache_control: { type: "ephemeral" },
    }];
    return true;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    // 浅拷贝 block 数组再打标记，避免污染 rawAssistant 等持久化引用
    const blocks = (message.content as ContentBlock[]).map(block => ({ ...block }));
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    message.content = blocks;
    return true;
  }
  return false;
}

/** Anthropic image source 白名单（官方协议仅支持这四种 media_type）。 */
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * OpenAI 风格 content → Anthropic content blocks。
 * - text 块照搬；
 * - image_url 块：data URL → source.type=base64；http(s) URL → source.type=url
 *   （原生协议两者都支持）；
 * - data URL 的 media_type 不在 Anthropic 白名单时降级为文本占位块，避免 400。
 */
function toAnthropicContent(content: ChatMessageContent): string | ContentBlock[] {
  if (typeof content === "string") return content;
  const blocks: ContentBlock[] = [];
  let imageBase64Count = 0;
  let imageUrlCount = 0;
  let imageDowngradedCount = 0;
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image_url") {
      const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(block.image_url.url);
      if (dataMatch) {
        if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(dataMatch[1])) {
          imageDowngradedCount += 1;
          blocks.push({ type: "text", text: `[图片格式 ${dataMatch[1]} 暂不支持直发，已跳过]` });
        } else {
          imageBase64Count += 1;
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] },
          });
        }
      } else {
        imageUrlCount += 1;
        blocks.push({
          type: "image",
          source: { type: "url", url: block.image_url.url },
        });
      }
    }
  }
  // [image-send] 链路日志③：wire 转换统计（无图不打印；含全部历史图片块）。
  if (imageBase64Count + imageUrlCount + imageDowngradedCount > 0) {
    console.log(
      `[image-send] anthropic wire: image 块 ${imageBase64Count} base64 / ${imageUrlCount} url`
      + (imageDowngradedCount > 0 ? ` / ${imageDowngradedCount} 个 MIME 不在白名单已降级文本` : ""),
    );
  }
  return blocks.length > 0 ? blocks : "";
}

/**
 * 把统一消息翻译成 Anthropic wire messages。
 * system 抽出来单独返回（Anthropic system 是顶层字段）。
 * 关键：assistant 若带 rawAssistant（上一轮原始 content block 数组）则原样回传，
 * 保证 thinking / tool_use block 完整回灌（MiniMax 多轮强制要求）。
 * tool 结果：Anthropic 用 user 角色的 tool_result block，同轮多个合并到同一条 user message。
 */
function toWireMessages(messages: ChatMessage[], options?: { cacheBreakpoints?: boolean }): {
  system: string | undefined;
  messages: Array<Record<string, unknown>>;
} {
  const systemText = messages
    .filter(m => m.role === "system")
    .map(m => m.content ?? "")
    .join("\n\n")
    .trim();
  const system = systemText || undefined;

  const wire: Array<Record<string, unknown>> = [];
  for (const m of messages.filter(x => x.role !== "system")) {
    if (m.role === "user") {
      wire.push({ role: "user", content: toAnthropicContent(m.content ?? "") });
    } else if (m.role === "assistant") {
      if (m.rawAssistant !== undefined) {
        wire.push({ role: "assistant", content: m.rawAssistant });
      } else {
        const blocks: ContentBlock[] = [];
        if (m.thinking) blocks.push({ type: "thinking", thinking: m.thinking });
        if (m.content) blocks.push({ type: "text", text: m.content });
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.arguments || "{}");
            } catch {
              input = {};
            }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
          }
        }
        wire.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      }
    } else if (m.role === "tool") {
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content ?? "",
      };
      const last = wire[wire.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as ContentBlock[]).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
    }
  }
  if (options?.cacheBreakpoints) {
    // 从尾部向前给两条消息打断点（连同 system 断点共 3 个，低于 Claude 4 个上限）：
    // - 最后一条：滚动断点，下一轮请求把它整体当作可复用前缀（工具循环逐轮命中）；
    // - 倒数第二条：兜底断点——ChatLoop 尾部注入 runtime_context 时最后一条每轮都变，
    //   真正稳定的"历史末尾"在倒数第二条。
    let marked = 0;
    for (let i = wire.length - 1; i >= 0 && marked < 2; i -= 1) {
      if (markMessageCacheBreakpoint(wire[i])) marked += 1;
    }
  }
  return { system, messages: wire };
}

export class AnthropicAdapter implements ChatVendorAdapter {
  readonly transport = "anthropic" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    // system 断点覆盖"tools + system"前缀；消息级断点按模型门控（见 supportsMessageCacheBreakpoint）
    const useMessageBreakpoints = this.capability.cacheStrategy === "cache_control"
      && supportsMessageCacheBreakpoint(this.id, req.model);
    const { system, messages } = toWireMessages(req.messages, { cacheBreakpoints: useMessageBreakpoints });
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: getVendorRuntimeSettings().disableMaxToken ? undefined : req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: req.stream ?? false,
    };
    // temperature 只在调用方显式传时才塞进 body，让厂商用默认值避免型号约束冲突
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    // system + 主动缓存（MiniMax/Claude：cache_control: ephemeral 打在 system block 上）
    if (system) {
      if (this.capability.cacheStrategy === "cache_control") {
        body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      } else {
        body.system = system;
      }
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
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
        if (policy.kind === "named") body.tool_choice = { type: "tool", name: policy.name };
        else if (policy.kind === "required") body.tool_choice = { type: "any" };
        else if (policy.kind === "auto") body.tool_choice = { type: "auto" };
      } else if (resolveAutomaticToolChoicePolicy({
        providerId: this.capability.id,
        model: cfg.model,
        transport: this.transport,
        reasoning: cfg.reasoning ?? { mode: "auto" },
        manualReasoning: cfg.manualReasoning,
        supportedModes: this.capability.toolChoiceModes,
      }) === "auto") {
        body.tool_choice = { type: "auto" };
      }
    }
    if (req.extraBody) Object.assign(body, req.extraBody);
    if (req.structuredOutput?.mode === "json_schema") {
      body.output_config = {
        ...(
          body.output_config
          && typeof body.output_config === "object"
          && !Array.isArray(body.output_config)
            ? body.output_config as Record<string, unknown>
            : {}
        ),
        format: {
          type: "json_schema",
          schema: req.structuredOutput.schema,
        },
      };
    }
    // 推理控制：按 (providerId, model) 解析 capability，调用 applyReasoningPreference 转换 body。
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
      url: resolveApiEndpoint(cfg.baseUrl, "anthropic").url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaderFor(this.capability, cfg.apiKey, "anthropic"),
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(wireBody),
    };
  }

  parseResponse(raw: unknown): ChatResponse {
    const data = raw as {
      content?: ContentBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    const blocks = data.content ?? [];
    let text = "";
    let thinking: string | undefined;
    const toolCalls: ToolCall[] = [];

    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      } else if (
        (b.type === "thinking" || b.type === "reasoning" || b.type === "reasoning_details") &&
        typeof (b.thinking ?? b.reasoning) === "string"
      ) {
        thinking = (thinking ?? "") + String(b.thinking ?? b.reasoning);
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
    }

    const stopReason = data.stop_reason ?? "end_turn";
    // 调度层用 toolCalls.length>0 判断是否继续；finishReason 也映射成 OpenAI 习惯便于日志统一
    const finishReason =
      stopReason === "tool_use" ? "tool_calls"
      : stopReason === "end_turn" ? "stop"
      : stopReason === "max_tokens" ? "length"
      : stopReason;

    const assistantMessage: ChatMessage = {
      role: "assistant",
      ...(text ? { content: text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      // 关键：原样保留 content block 数组，下一轮 buildRequest 直接回传给厂商
      rawAssistant: blocks,
    };

    // 提取 token 用量（Anthropic 协议: input_tokens/output_tokens）
    const usage = data.usage
      ? {
          input: data.usage.input_tokens ?? 0,
          output: data.usage.output_tokens ?? 0,
          ...(typeof data.usage.cache_read_input_tokens === "number"
            ? { cachedInput: data.usage.cache_read_input_tokens }
            : {}),
          ...(typeof data.usage.cache_creation_input_tokens === "number"
            ? { cacheCreation: data.usage.cache_creation_input_tokens }
            : {}),
        }
      : undefined;

    return { assistantMessage, text, thinking, toolCalls, finishReason, raw, usage };
  }

  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    // 复用 buildRequest：adapter 内部已按 req.stream 写 body，强制 stream=true
    return this.buildRequest({ ...req, stream: true }, cfg);
  }

  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    // Anthropic 流式：eventType 是事件名，data 是 JSON
    let parsed: {
      type?: string;
      error?: { message?: unknown };
      message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return null;
    }

    const eventType = event.eventType === "data" && typeof parsed.type === "string"
      ? parsed.type
      : event.eventType;
    switch (eventType) {
      case "error":
        return { error: typeof parsed.error?.message === "string" ? parsed.error.message : "模型流式响应返回错误" };
      case "message_start": {
        const startUsage = parsed.message?.usage;
        return startUsage ? {
          usage: {
            input: startUsage.input_tokens ?? 0,
            output: startUsage.output_tokens ?? 0,
            ...(typeof startUsage.cache_read_input_tokens === "number"
              ? { cachedInput: startUsage.cache_read_input_tokens }
              : {}),
            ...(typeof startUsage.cache_creation_input_tokens === "number"
              ? { cacheCreation: startUsage.cache_creation_input_tokens }
              : {}),
          },
        } : null;
      }
      case "content_block_delta": {
        const d = parsed.delta;
        if (!d) return null;
        const chunk: StreamChunk = {};
        if (d.type === "text_delta" && typeof d.text === "string") chunk.deltaText = d.text;
        if (d.type === "thinking_delta" && typeof d.thinking === "string") chunk.deltaThinking = d.thinking;
        // 暂不实现：d.type === "input_json_delta" → 累积到 deltaToolCalls
        // 当前三个调用点都不带 tools；未来若需要流式 tool_use 增量，单独实现 + 加测试即可。
        return Object.keys(chunk).length > 0 ? chunk : null;
      }
      case "message_delta": {
        const chunk: StreamChunk = {};
        if (typeof parsed.delta?.stop_reason === "string") chunk.finishReason = parsed.delta.stop_reason;
        if (parsed.usage) chunk.usage = {
          input: parsed.usage.input_tokens ?? 0,
          output: parsed.usage.output_tokens ?? 0,
          ...(typeof parsed.usage.cache_read_input_tokens === "number"
            ? { cachedInput: parsed.usage.cache_read_input_tokens }
            : {}),
          ...(typeof parsed.usage.cache_creation_input_tokens === "number"
            ? { cacheCreation: parsed.usage.cache_creation_input_tokens }
            : {}),
        };
        return Object.keys(chunk).length > 0 ? chunk : null;
      }
      case "message_stop":
        return { done: true };
      // 其他事件（message_start / content_block_start / content_block_stop / ping 等）静默忽略
      default:
        return null;
    }
  }

  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    const next = messages.slice();
    for (const r of results) {
      // 统一层一律 push role:"tool"；Anthropic 的合并（同轮 tool_result 进同一条 user message）
      // 由 buildRequest 的 toWireMessages 负责，这里保持 transport 无关。
      next.push({
        role: "tool",
        toolCallId: r.toolCall.id,
        name: r.toolCall.name,
        content: r.output,
      });
    }
    return next;
  }

  async testConnection(cfg: VendorConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getTimeoutSettings().testTimeout);
    try {
      const req: ChatRequest = {
        model: cfg.model,
        messages: [{ role: "user", content: "ping，请只回复两个字符：ok" }],
        // 不传 temperature：某些模型只允许特定值，传 0 会报错
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
