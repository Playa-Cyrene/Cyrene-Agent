// OpenAI Responses transport —— 第三协议（docs/responses-transport-construction-plan.md）
// 请求体协议：POST {baseUrl}/responses，input items + instructions
//
// 与 Chat Completions 的关键 wire 差异（施工文档钉死，改前必读）：
//   1. tools 扁平格式：{type:'function', name, parameters, strict}（无 function 嵌套层）
//   2. tool_choice 少一层嵌套：named 直接 {type:'function', name}
//   3. 多轮回放：完整 output items 存 rawAssistant，下一轮经 replay policy + toResponseInputItems() 原顺序重放
//   4. store:false 恒定发送（无状态，不留服务端会话）
//   5. 加密 reasoning 回放：仅 OpenAI 官方端点 include reasoning.encrypted_content，第三方不发
//   6. maxTokens → max_output_tokens；reasoning_effort → reasoning:{effort}
//   7. system 消息聚合为顶层 instructions，不进 input
//
// rawAssistant 是 Responses 多轮保真的核心机制（不是性能优化）：
// 非流式从 response.output 捕获；流式由 sdk-stream runtime 在 response.completed/incomplete 补挂。
import {
  ChatMessage, ChatRequest, ChatResponse, ChatVendorAdapter,
  HttpRequest, ProviderCapability, StreamChunk, StreamEvent,
  TestConnectionResult, ToolCall, ToolExecutionResult, VendorConfig,
} from "./types";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { authHeaderFor } from "./auth";
import { resolveEffectiveReasoning } from "../../../shared/reasoning";
import { applyManualReasoningBody, normalizeManualReasoningConfig, resolveConfiguredReasoningCapability } from "../../../shared/manual-reasoning";
import { applyReasoningPreference } from "./reasoning";
import { getTimeoutSettings } from "../../timeout-manager";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";
import { getVendorRuntimeSettings } from "./runtime-settings";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";

// ── wire 形状（仅声明 adapter 实际读写的字段，与 SDK 类型保持手工对齐） ──

interface WireOutputText { type: "output_text"; text: string }
interface WireOutputRefusal { type: "refusal"; refusal: string }
interface WireMessageItem {
  type: "message";
  id: string;
  role: "assistant";
  status?: string;
  content: Array<WireOutputText | WireOutputRefusal>;
}
interface WireFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}
interface WireReasoningItem {
  type: "reasoning";
  id: string;
  summary?: Array<{ type: string; text?: string }>;
  content?: Array<{ type: string; text?: string }>;
  encrypted_content?: string | null;
}
type WireOutputItem = WireMessageItem | WireFunctionCallItem | WireReasoningItem | { type: string; [k: string]: unknown };

interface WireResponse {
  output?: WireOutputItem[];
  status?: "completed" | "incomplete" | "failed" | "in_progress" | string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/** 判断 baseUrl 是否 OpenAI 官方端点（include encrypted reasoning 的端点级门槛）。 */
export function isOfficialOpenAIEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

/** 该档案是否启用 encrypted reasoning 回放：capability 标记 + 官方端点双条件。 */
export function shouldIncludeEncryptedReasoning(cfg: VendorConfig, cap: ProviderCapability): boolean {
  return cap.responsesEncryptedReasoning === true && isOfficialOpenAIEndpoint(cfg.baseUrl);
}

// ── input items 构建 ──

/** OpenAIContentBlock[] → Responses 输入 content blocks（input_text / input_image）。 */
function toUserContentBlocks(content: NonNullable<ChatMessage["content"]>): Array<{ type: string; text?: string; image_url?: string }> {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map((block) => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    return { type: "input_image", image_url: block.image_url.url };
  });
}

/**
 * Responses 多轮回放策略（施工文档关键决策 #4）：
 *   rawAssistant → replay policy → toResponseInputItems() → input[]
 * - 官方端点：reasoning 带 encrypted_content 的保留
 * - 第三方：reasoning 一律丢弃（无加密内容可引用）
 * - message / function_call 恒定保留；未知类型防御性丢弃
 */
function replayRawAssistant(rawAssistant: unknown, includeEncryptedReasoning: boolean): Array<Record<string, unknown>> {
  if (!Array.isArray(rawAssistant)) return [];
  const replayable = rawAssistant.filter((item): item is WireOutputItem => {
    if (!item || typeof item !== "object") return false;
    const type = (item as { type?: unknown }).type;
    if (type === "message" || type === "function_call") return true;
    if (type === "reasoning") return includeEncryptedReasoning && typeof (item as WireReasoningItem).encrypted_content === "string";
    return false;
  });
  try {
    const converted = toResponseInputItems(replayable as unknown as Parameters<typeof toResponseInputItems>[0]);
    return converted as unknown as Array<Record<string, unknown>>;
  } catch {
    // SDK 对未知 item type 抛 TypeError → 逐个降级，只保留确定可回放的
    const fallback: Array<Record<string, unknown>> = [];
    for (const item of replayable) {
      try {
        const converted = toResponseInputItems([item] as unknown as Parameters<typeof toResponseInputItems>[0]);
        fallback.push(...(converted as unknown as Array<Record<string, unknown>>));
      } catch {
        // 单个 item 无法转换：跳过（保其余轮次可回放）
      }
    }
    return fallback;
  }
}

/**
 * 统一 ChatMessage[] → Responses input items + instructions。
 * system 聚合进 instructions；assistant 优先 rawAssistant 原样回放，
 * 缺失时退化构造（input_text + function_call items）；tool → function_call_output。
 */
function toWireInput(
  messages: ChatMessage[],
  includeEncryptedReasoning: boolean,
): { instructions: string | undefined; input: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "user") {
      input.push({ role: "user", content: toUserContentBlocks(m.content ?? "") });
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }
    // assistant：rawAssistant 存在 → 原顺序回放（function_call items 已含工具调用）
    if (m.rawAssistant !== undefined) {
      input.push(...replayRawAssistant(m.rawAssistant, includeEncryptedReasoning));
      continue;
    }
    // 退化构造：正文 + 工具调用分别落 input items
    const text = typeof m.content === "string" ? m.content : "";
    if (text) input.push({ role: "assistant", content: [{ type: "input_text", text }] });
    for (const tc of m.toolCalls ?? []) {
      input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments });
    }
  }

  return { instructions: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, input };
}

function toWireTools(tools?: ChatRequest["tools"]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  // Responses 扁平格式：无 function 嵌套层，strict 参数在顶层
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

// ── Adapter ──

export class ResponsesAdapter implements ChatVendorAdapter {
  readonly transport = "responses" as const;
  constructor(public readonly id: string, public capability: ProviderCapability) {}

  buildRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    const includeEncryptedReasoning = shouldIncludeEncryptedReasoning(cfg, this.capability);
    const { instructions, input } = toWireInput(req.messages, includeEncryptedReasoning);

    const body: Record<string, unknown> = {
      model: req.model,
      input,
      // 无状态调用：不留服务端会话，多轮全靠本地 rawAssistant 回放
      store: false,
      stream: req.stream ?? false,
    };
    if (instructions !== undefined) body.instructions = instructions;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    // Responses 无 frequency_penalty / repetition_penalty 字段，忽略
    if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
    if (getVendorRuntimeSettings().disableMaxToken) body.max_output_tokens = undefined;
    if (includeEncryptedReasoning) body.include = ["reasoning.encrypted_content"];

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
        if (policy.kind === "named") body.tool_choice = { type: "function", name: policy.name };
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

    // 推理控制：复用共享推理层，再把 Chat Completions 语义的 reasoning_effort
    // 翻译成 Responses 的 reasoning:{effort}。thinking / enable_thinking /
    // output_config 等 Chat Completions / Anthropic 专属字段对 Responses 无效，丢弃。
    const manualReasoning = normalizeManualReasoningConfig(cfg.manualReasoning);
    const reasoningCap = resolveConfiguredReasoningCapability(this.capability.id, cfg.model, manualReasoning);
    const scratch = applyReasoningPreference(
      { ...body },
      cfg.reasoning ?? { mode: "auto" },
      reasoningCap,
      {
        hasTools: Boolean(req.tools?.length),
        providerId: this.capability.id,
        model: cfg.model,
        ignoreThinkingOverride: Boolean(manualReasoning),
      },
    );
    const effort = scratch.reasoning_effort;
    // thinking 字段删除前捕获开关状态：thinking-type / anthropic-adaptive 风格模型
    // （如 MiniMax-M3）的 on 会落在这里。Responses API 无 thinking 字段，
    // 语义映射：effort 非 none 值 = 开启推理（不调深度）。
    const scratchThinking = scratch.thinking as { type?: unknown } | undefined;
    const thinkingOn = scratchThinking?.type === "adaptive" || scratchThinking?.type === "enabled";
    const thinkingOff = scratchThinking?.type === "disabled";
    delete scratch.reasoning_effort;
    delete scratch.thinking;
    delete scratch.enable_thinking;
    delete scratch.output_config;
    // pro 模式（gpt-5.6 系列）：reasoning.mode="pro"，与 effort 正交。
    // 仅 Responses 协议有此字段，openai transport 静默忽略 proMode。
    const proMode = resolveEffectiveReasoning(
      cfg.reasoning ?? { mode: "auto" },
      reasoningCap,
      manualReasoning ? 0 : getVendorRuntimeSettings().thinkingOverride,
    ).proMode === true;
    // thinking on 且无显式 effort（M3 无 effort 档）→ effort:"minimal" 开启推理；
    // thinking off 映射为 effort:"none"；不可调模型继续使用接口默认值。
    const resolvedEffort = typeof effort === "string"
      ? effort
      : thinkingOn
        ? "minimal"
        : thinkingOff
          ? "none"
          : undefined;
    if (resolvedEffort !== undefined || proMode) {
      scratch.reasoning = {
        ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
        ...(proMode ? { mode: "pro" } : {}),
      };
    }
    Object.assign(body, scratch);

    // 结构化输出：response_format → text.format
    if (req.structuredOutput?.mode === "json_schema") {
      body.text = {
        format: {
          type: "json_schema",
          name: req.structuredOutput.name,
          strict: req.structuredOutput.strict,
          schema: req.structuredOutput.schema,
        },
      };
    } else if (
      req.structuredOutput?.mode === "json_object"
      || req.structuredOutput?.mode === "prompt_json" && req.structuredOutput.sendJsonObjectHint
    ) {
      body.text = { format: { type: "json_object" } };
    }

    if (req.extraBody) Object.assign(body, req.extraBody);
    const wireBody = applyManualReasoningBody(body, manualReasoning, cfg.reasoning ?? { mode: "auto" });

    return {
      url: resolveApiEndpoint(cfg.baseUrl, "responses").url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaderFor(this.capability, cfg.apiKey, "responses"),
      },
      body: JSON.stringify(wireBody),
    };
  }

  buildStreamRequest(req: ChatRequest, cfg: VendorConfig): HttpRequest {
    return this.buildRequest({ ...req, stream: true }, cfg);
  }

  parseResponse(raw: unknown): ChatResponse {
    const data = (raw ?? {}) as WireResponse;
    const items = Array.isArray(data.output) ? data.output : [];

    let text = "";
    let refusal: string | undefined;
    const thinkingParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const item of items) {
      if (item.type === "message") {
        const msg = item as WireMessageItem;
        for (const block of msg.content ?? []) {
          if (block.type === "output_text") text += block.text;
          else if (block.type === "refusal") refusal = (refusal ?? "") + block.refusal;
        }
      } else if (item.type === "function_call") {
        const fc = item as WireFunctionCallItem;
        toolCalls.push({ id: fc.call_id, name: fc.name, arguments: fc.arguments });
      } else if (item.type === "reasoning") {
        const rs = item as WireReasoningItem;
        for (const s of rs.summary ?? []) {
          if (typeof s.text === "string") thinkingParts.push(s.text);
        }
        for (const c of rs.content ?? []) {
          if (typeof c.text === "string") thinkingParts.push(c.text);
        }
      }
    }

    const thinking = thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined;
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(thinking ? { thinking } : {}),
      // 多轮保真核心：完整 output items 原样保存，下一轮 replayRawAssistant 原顺序重放
      rawAssistant: items,
    };

    const finishReason = data.status === "incomplete"
      ? (data.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop")
      : "stop";

    const usage = data.usage
      ? {
          input: data.usage.input_tokens ?? 0,
          output: data.usage.output_tokens ?? 0,
          ...(typeof data.usage.input_tokens_details?.cached_tokens === "number"
            ? { cachedInput: data.usage.input_tokens_details.cached_tokens }
            : {}),
        }
      : undefined;

    return {
      assistantMessage,
      text,
      thinking,
      refusal,
      toolCalls,
      finishReason,
      raw,
      usage,
    };
  }

  parseStreamEvent(event: StreamEvent): StreamChunk | null {
    // Responses SSE：event: <type>\ndata: {...}（createSseReader 已切好）
    const jsonStr = event.data.trim();
    if (!jsonStr) return null;
    let parsed: {
      type?: string;
      delta?: string;
      response?: WireResponse;
      error?: { message?: string };
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return null;
    }

    const type = parsed.type ?? event.eventType;
    switch (type) {
      case "response.output_text.delta":
        return typeof parsed.delta === "string" ? { deltaText: parsed.delta } : null;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return typeof parsed.delta === "string" ? { deltaThinking: parsed.delta } : null;
      case "response.completed":
        return {
          done: true,
          finishReason: "stop",
          ...(parsed.response?.usage ? { usage: wireUsageToUnified(parsed.response.usage) } : {}),
        };
      case "response.incomplete":
        return {
          done: true,
          finishReason: parsed.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop",
          ...(parsed.response?.usage ? { usage: wireUsageToUnified(parsed.response.usage) } : {}),
        };
      case "response.failed":
        return { error: parsed.response?.error?.message ?? "模型流式响应失败" };
      case "error":
        return { error: parsed.error?.message ?? "模型流式响应返回错误" };
      default:
        // 其余事件（output_item.added / function_call_arguments.delta 等）
        // 由 sdk-stream responses-normalizer（Commit 3）处理；此处静默忽略
        return null;
    }
  }

  appendToolResults(messages: ChatMessage[], results: ToolExecutionResult[]): ChatMessage[] {
    // 统一结构追加；buildRequest 里 tool → function_call_output（call_id = toolCallId）
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

  async testConnection(cfg: VendorConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getTimeoutSettings().testTimeout);
    try {
      const req: ChatRequest = {
        model: cfg.model,
        messages: [{ role: "user", content: "ping，请只回复两个字符：ok" }],
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

function wireUsageToUnified(usage: NonNullable<WireResponse["usage"]>): NonNullable<StreamChunk["usage"]> {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    ...(typeof usage.input_tokens_details?.cached_tokens === "number"
      ? { cachedInput: usage.input_tokens_details.cached_tokens }
      : {}),
  };
}
