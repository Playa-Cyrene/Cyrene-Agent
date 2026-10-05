import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { resolveApiEndpoint } from "../../../shared/api-endpoint";
import { AgentRuntimeError } from "../agent-runtime-error";
import { originDigest, projectModelHistory, type HistoryProjectionDiagnostic } from "./model-history";
import { dumpRequest } from "./prompt-dump";
import { createStreamActivityFetch } from "./sdk-stream/stream-activity-fetch";
import type { ChatRequest, ChatVendorAdapter, ModelMessageOrigin, VendorConfig } from "./types";

export function modelMessageOrigin(adapter: ChatVendorAdapter, config: VendorConfig): ModelMessageOrigin {
  return { transport: adapter.transport, provider: adapter.id, model: config.model,
    endpoint: originDigest(resolveApiEndpoint(config.baseUrl, adapter.transport).url),
    credentialScope: originDigest(config.apiKey) };
}

const STRUCTURAL_FIELDS = new Set(["model", "messages", "input", "system", "instructions", "tools", "stream"]);
const POLICY_FIELDS = ["temperature", "top_p", "frequency_penalty", "repetition_penalty", "max_tokens",
  "max_completion_tokens", "max_output_tokens", "tool_choice", "thinking", "enable_thinking", "reasoning_effort", "reasoning", "include"];

/** 复用现有厂商策略；消息与工具的编解码始终交给 SDK。 */
export function prepareModelCall(input: {
  adapter: ChatVendorAdapter; config: VendorConfig; request: ChatRequest; stream: boolean;
  onStreamActivity?: () => void;
  onHistoryDiagnostic?: (diagnostic: HistoryProjectionDiagnostic) => void;
  onRequest?: (traceId: string) => void;
}) {
  const { adapter, config, request } = input;
  const imageGeneration = request.imageGeneration?.enabled ? request.imageGeneration : undefined;
  if (imageGeneration && adapter.transport !== "responses") {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "图片生成当前只支持 Responses 协议");
  }
  if (imageGeneration && !imageGeneration.model.trim()) {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "图片生成模型不能为空");
  }
  if ((request.tools ?? []).some(spec => spec.name === "image_generation")) {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "本地工具名 image_generation 与原生图片生成工具冲突");
  }
  for (const key of Object.keys(request.extraBody ?? {})) {
    if (STRUCTURAL_FIELDS.has(key)) throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", `额外参数不能覆盖会话结构：${key}`);
  }
  // 空历史只用于读取参数、鉴权和端点策略，不编码真实会话。
  const policyHttp = adapter.buildRequest({ ...request, messages: [], stream: input.stream }, config);
  const policy = JSON.parse(policyHttp.body) as Record<string, unknown>;
  const controls = Object.fromEntries(Object.entries(policy).filter(([key]) => !STRUCTURAL_FIELDS.has(key)));
  const delegate = input.onStreamActivity ? createStreamActivityFetch(input.onStreamActivity, fetch) : fetch;
  const compatibilityFetch: typeof fetch = async (url, init) => {
    const original = new Request(url, init);
    const body = JSON.parse(await original.text()) as Record<string, unknown>;
    // SDK 可能补默认值；输出预算、采样和工具策略以项目现有规则为准。
    for (const key of POLICY_FIELDS) if (!(key in controls)) delete body[key];
    Object.assign(body, controls);
    if (adapter.transport === "responses") body.store = false;
    const hasEmailTools = (request.tools ?? []).some(({ name }) =>
      name === "send_email" || name === "email_create_draft" || name.startsWith("gmail_"));
    // Requests and responses in a run with email tools can contain private mail data.
    // Do not write either side of that exchange to the optional prompt dump.
    input.onRequest?.(hasEmailTools ? "" : dumpRequest({ transport: adapter.transport, endpoint: policyHttp.url, body }));
    const headers = new Headers(original.headers);
    for (const [name, value] of Object.entries(policyHttp.headers)) headers.set(name, value);
    return delegate(policyHttp.url, { method: "POST", headers, body: JSON.stringify(body), signal: original.signal });
  };
  const baseURL = new URL(policyHttp.url).origin;
  const origin = modelMessageOrigin(adapter, { ...config, model: request.model });
  const messages = projectModelHistory(request.messages, origin, input.onHistoryDiagnostic);
  applyAnthropicCache(messages, adapter, request.model);
  const openai = adapter.transport === "responses"
    ? createOpenAI({ baseURL, apiKey: config.apiKey, fetch: compatibilityFetch })
    : undefined;
  const model = adapter.transport === "responses"
    ? openai!.responses(request.model)
    : adapter.transport === "anthropic"
      ? createAnthropic({ baseURL, fetch: compatibilityFetch,
        ...((adapter.capability.anthropicAuthStyle ?? adapter.capability.authStyle) === "bearer"
          ? { authToken: config.apiKey } : { apiKey: config.apiKey }) })(request.model)
      : new URL(policyHttp.url).hostname === "api.openai.com"
        ? createOpenAI({ baseURL, apiKey: config.apiKey, fetch: compatibilityFetch }).chat(request.model)
        : createOpenAICompatible({ name: "cyrene", baseURL, apiKey: config.apiKey, fetch: compatibilityFetch,
          includeUsage: true, supportedUrls: () => ({ "image/*": [/^https?:\/\//] }) })(request.model);
  const tools: ToolSet = Object.fromEntries((request.tools ?? []).map(spec => [spec.name, tool({
    description: spec.description, inputSchema: jsonSchema<Record<string, unknown>>(spec.parameters),
    ...(adapter.transport !== "anthropic" ? { strict: false } : {}),
  })]));
  if (imageGeneration) {
    tools.image_generation = openai!.tools.imageGeneration({ model: imageGeneration.model.trim(), outputFormat: "png",
      size: "auto", quality: "auto", partialImages: 0 });
  }
  const choice = policy.tool_choice;
  const named = typeof choice === "object" && choice !== null
    ? (choice as { name?: string; function?: { name?: string } }).name ?? (choice as { function?: { name?: string } }).function?.name
    : undefined;
  const toolChoice = named ? { type: "tool" as const, toolName: named }
    : choice === "required" || (choice as { type?: string } | undefined)?.type === "any" ? "required" as const : "auto" as const;
  const maxTokens = policy.max_tokens ?? policy.max_output_tokens;
  return { origin, model, messages, tools, toolChoice,
    ...(typeof maxTokens === "number" ? { maxOutputTokens: maxTokens } : {}),
    providerOptions: adapter.transport === "responses" ? { openai: {
      store: false, ...(policy.include ? { include: policy.include as string[] } : {}),
    } } : undefined,
  };
}

function applyAnthropicCache(messages: ModelMessage[], adapter: ChatVendorAdapter, model: string): void {
  if (adapter.transport !== "anthropic") return;
  const cache = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;
  if (adapter.capability.cacheStrategy === "cache_control") {
    for (const message of messages) if (message.role === "system") message.providerOptions = cache;
    if (adapter.id === "claude" || adapter.id === "minimax" && /^minimax-m2(?:$|[.-])/i.test(model.trim())) {
      let marked = 0;
      for (let index = messages.length - 1; index >= 0 && marked < 2; index--) {
        const message = messages[index];
        if (message.role === "system") continue;
        if (typeof message.content === "string") {
          if (!message.content) continue;
          message.providerOptions = cache;
        } else {
          const part = [...message.content].reverse().find(part => part.type === "text" || part.type === "image" || part.type === "file" || part.type === "tool-call" || part.type === "tool-result");
          if (!part) continue;
          if ("providerOptions" in part || part.type === "text" || part.type === "tool-result" || part.type === "tool-call" || part.type === "file" || part.type === "image") {
            part.providerOptions = { ...part.providerOptions, ...cache };
          }
        }
        marked++;
      }
    }
  }
  // 保留现有不支持的图片格式降级规则，避免 SDK 直接发送后被接口拒绝。
  for (const message of messages) if (message.role === "user" && Array.isArray(message.content)) {
    message.content = message.content.map(part => {
      if (part.type !== "file" || typeof part.data !== "object" || part.data === null || !("type" in part.data) || part.data.type !== "data") return part;
      return !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(part.mediaType)
        ? { type: "text", text: `[图片格式 ${part.mediaType} 暂不支持直发，已跳过]`, providerOptions: part.providerOptions } : part;
    });
  }
}
