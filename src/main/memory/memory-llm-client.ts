/**
 * Memory LLM Client — 统一 Memory 子系统的网络 LLM 调用层。
 *
 * 提供两种调用模式：
 *   1. invokeMemoryLlm()          — 旧链路：直接调用，返回原始文本
 *   2. invokeMemoryStructuredOutput() — 新链路：接入现有 A/B/D/M Structured Output Pipeline
 *
 * 业务模块应优先使用 invokeMemoryStructuredOutput，
 * 它会自动处理：厂商请求格式、JSON Schema/JSON Object/Prompt JSON 选择、
 * <think> 清理、JSON 候选提取、Repair、reasoning 关闭、temperature 兼容等。
 */

import { assertTermsExecutionAllowed, TermsConsentRequiredError } from "../terms/terms-runtime";
import { getAdapterForConfig } from "../orchestrator/vendors";
import type { VendorConfig, ChatMessage, ChatRequest } from "../orchestrator/vendors";
import { recordUsage, recordRequest } from "../token-usage-store";
import { resolveTimeoutPolicy, resolveMaxOutputTokens } from "../runtime-policy";
import type { RuntimeStage } from "../runtime-policy";
import { runStructuredOutput } from "../orchestrator/structured-output/runner";
import type {
  BusinessValidationResult,
  StructuredRepairContext,
} from "../orchestrator/structured-output/runner";
import type { StructuredOutputProfile, StructuredOutputStage } from "../orchestrator/structured-output/types";
import { resolveStructuredOutputProfile, classifyStructuredOutputEndpoint } from "../orchestrator/structured-output/profiles";
import { getCapability } from "../orchestrator/vendors/capabilities";
import { loadMemoryModelConfig, stripThinkBlocks } from "./memory-llm-shared";
import type { MemoryModelConfig, MemoryModelConfigSource } from "./memory-llm-shared";
import {
  MemoryLlmTimeoutError,
  MemoryLlmHttpError,
  MemoryLlmProtocolError,
  MemoryLlmConfigurationError,
} from "./memory-llm-errors";
import {
  MEMORY_JUDGE_JSON_SCHEMA,
  MEMORY_REFLECTION_JSON_SCHEMA,
  MEMORY_RESOLVE_JSON_SCHEMA,
  SUMMARY_MEMORY_JSON_SCHEMA,
  WIKI_MEMORY_JSON_SCHEMA,
} from "./memory-schemas";

// ── 类型 ──

export type MemoryLlmOperation = "judge" | "compress" | "reflect" | "resolve" | "summary" | "wiki";

export interface MemoryLlmRequest {
  operation: MemoryLlmOperation;
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxOutputTokens: number;
  signal?: AbortSignal;
  config?: MemoryModelConfig;
}

export interface MemoryLlmResponse {
  text: string;
  provider: string;
  model: string;
}

export interface InvokeMemoryStructuredOutputOptions<T> {
  operation: MemoryLlmOperation;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  parseSchema: (value: unknown) => T;
  validateBusiness: (value: T) => BusinessValidationResult<T>;
  signal?: AbortSignal;
  config?: MemoryModelConfig;
}

// ── 操作 → 运行时阶段映射 ──

const OPERATION_TO_TOKEN_STAGE: Record<MemoryLlmOperation, RuntimeStage> = {
  judge: "memory-judge",
  compress: "memory-compressor",
  reflect: "memory-reflect",
  resolve: "memory-resolver",
  summary: "memory-summary",
  wiki: "memory-wiki",
};

const OPERATION_TO_SO_STAGE: Record<MemoryLlmOperation, StructuredOutputStage> = {
  judge: "memory_judge",
  compress: "memory_compress",
  reflect: "memory_reflect",
  resolve: "memory_resolve",
  summary: "memory_summary",
  wiki: "memory_wiki",
};

const OPERATION_REPAIR_FORMAT: Record<MemoryLlmOperation, string> = {
  judge: '顶层必须是 JSON 对象，格式为 {"candidates":[...],"entities":[...]}；没有候选时返回 {"candidates":[],"entities":[]}。',
  compress: '顶层必须是 JSON 对象，格式为 {"groups":[...]}。',
  reflect: '顶层必须是 JSON 对象，格式为 {"updates":[...]}；没有更新时返回 {"updates":[]}。',
  resolve: "顶层必须是一个符合原始字段要求的 JSON 对象。",
  summary: '顶层必须是 JSON 对象，格式为 {"sessionSummary":"...","workspaceSummary":"..."}；超出长度限制时必须压缩内容。',
  wiki: '顶层必须是 JSON 对象，格式为 {"candidates":[{"sourceId":"...","subject":"...","predicate":"...","value":"...","scope":"global","statementKind":"assertion","pageType":"self","tags":["chat"],"aliases":[],"validFrom":"","validTo":"","evidenceQuote":"原文片段"}]}；没有可保存知识时 candidates 为空数组。',
};

function buildRepairMessage(
  operation: MemoryLlmOperation,
  repair: StructuredRepairContext,
): ChatMessage | undefined {
  if (repair.attempt === 0) return undefined;
  const errorCodes = repair.errors.map((error) => error.code).join(", ") || "UNKNOWN_VALIDATION_ERROR";
  return {
    role: "user",
    content: [
      `上一次输出未通过结构化校验，错误代码：${errorCodes}。`,
      OPERATION_REPAIR_FORMAT[operation],
      "请重新生成完整结果，只输出 JSON，不要附加 Markdown 代码围栏或解释文字。",
    ].join("\n"),
  };
}

export function getDefaultMaxOutputTokens(operation: MemoryLlmOperation): number {
  return resolveMaxOutputTokens({ stage: OPERATION_TO_TOKEN_STAGE[operation] });
}

// ── 配置解析 ──

function resolveMemoryProfile(config: MemoryModelConfig): StructuredOutputProfile {
  const cap = getCapability(config.provider);
  const endpointKind = cap
    ? classifyStructuredOutputEndpoint({
        providerId: cap.id,
        configuredBaseUrl: config.baseUrl,
        officialBaseUrl: cap.baseUrl,
      })
    : "custom";

  return resolveStructuredOutputProfile({
    provider: cap?.id ?? config.provider,
    model: config.model,
    transport: cap?.transport ?? "openai",
    endpointKind,
  });
}

function buildVendorConfig(config: MemoryModelConfig): VendorConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    explicitTransport: config.explicitTransport,
  };
}

// ── Structured Output 调用入口 ──

/**
 * 通过现有 A/B/D/M Structured Output Pipeline 调用 Memory LLM。
 *
 * 业务模块拿到的直接是校验过的结构化对象，不再自行 JSON.parse。
 */
export async function invokeMemoryStructuredOutput<T>(options: InvokeMemoryStructuredOutputOptions<T>): Promise<T> {
  assertTermsExecutionAllowed();
  const { operation, systemPrompt, userPrompt, maxOutputTokens, parseSchema, validateBusiness, signal } = options;
  const config = options.config ?? loadMemoryModelConfig();

  if (!config.apiKey) {
    throw new MemoryLlmConfigurationError(`missing API key for Memory LLM (source: ${config.source})`);
  }

  const profile = resolveMemoryProfile(config);
  const cfg = buildVendorConfig(config);
  const adapter = getAdapterForConfig(cfg);
  const soStage = OPERATION_TO_SO_STAGE[operation];

  // 修复重试也是新请求；保留专用错误，不被结构化输出层包装成网络/协议错误。
  let consentError: TermsConsentRequiredError | undefined;
  const checkConsent = () => {
    try { assertTermsExecutionAllowed(); } catch (error) {
      if (error instanceof TermsConsentRequiredError) consentError = error;
      throw error;
    }
  };
  const result = await runStructuredOutput<T, ChatRequest>({
    stage: soStage,
    profile,
    signal,
    buildRequest: (repair) => {
      checkConsent();
      const structuredOutput = buildStructuredOutputRequest(profile, operation);
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];
      const repairMessage = buildRepairMessage(operation, repair);
      if (repairMessage) messages.push(repairMessage);
      return {
        model: cfg.model,
        messages,
        stream: false,
        maxTokens: maxOutputTokens,
        structuredOutput,
        ...(profile.requestHints.reasoningSplit ? { extraBody: { reasoning_split: true } } : {}),
      };
    },
    generate: async (request, generateSignal) => {
      checkConsent();
      const http = adapter.buildRequest(request, cfg);

      const timeoutMs = resolveTimeoutPolicy({ stage: "memory-llm" }).totalMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // 合并外部 signal
      if (generateSignal.aborted) controller.abort();
      const onExternalAbort = () => controller.abort();
      generateSignal.addEventListener("abort", onExternalAbort);

      let response: Response;
      try {
        response = await fetch(http.url, {
          method: "POST",
          signal: controller.signal,
          headers: http.headers,
          body: http.body,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          if (generateSignal.aborted) {
            throw new Error(`Memory LLM [${operation}] cancelled by external signal`);
          }
          throw new MemoryLlmTimeoutError(timeoutMs, operation);
        }
        throw err;
      } finally {
        clearTimeout(timer);
        generateSignal.removeEventListener("abort", onExternalAbort);
      }

      if (!response.ok) {
        let responseBody: string | undefined;
        try {
          const errorData = await response.json() as Record<string, unknown>;
          const rawMessage = (errorData as { error?: { message?: string } }).error?.message;
          responseBody = rawMessage && rawMessage.length > 1500 ? rawMessage.slice(0, 1500) + "…(truncated)" : rawMessage;
        } catch { /* ignore */ }
        throw new MemoryLlmHttpError(response.status, operation, responseBody);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new MemoryLlmProtocolError(operation, "failed to parse response JSON");
      }

      const parsed = adapter.parseResponse(data);

      // best-effort usage recording
      recordRequest(cfg.model);
      if (parsed.usage) {
        try {
          recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput, cfg.model, parsed.usage.cacheCreation);
        } catch { /* ignore */ }
      }

      return {
        text: parsed.text ?? "",
        finishReason: parsed.finishReason,
        refusal: parsed.refusal,
        structuredValue: parsed.structuredValue,
      };
    },
    parseSchema,
    validateBusiness,
  });

  if (consentError) throw consentError;
  if (result.outcome === "failure") {
    throw new MemoryLlmProtocolError(
      operation,
      `structured output failed: ${result.failure.code} (stage: ${result.failure.stage})`,
    );
  }

  return result.value;
}

const OPERATION_JSON_SCHEMA: Record<
  Exclude<MemoryLlmOperation, "compress">,
  Record<string, unknown>
> = {
  judge: MEMORY_JUDGE_JSON_SCHEMA,
  reflect: MEMORY_REFLECTION_JSON_SCHEMA,
  resolve: MEMORY_RESOLVE_JSON_SCHEMA,
  summary: SUMMARY_MEMORY_JSON_SCHEMA,
  wiki: WIKI_MEMORY_JSON_SCHEMA,
};

function buildStructuredOutputRequest(
  profile: StructuredOutputProfile,
  operation: MemoryLlmOperation,
): ChatRequest["structuredOutput"] {
  const name = `memory_${operation}`;
  if (profile.mode === "provider_json_schema") {
    const schema = operation === "compress" ? {} : OPERATION_JSON_SCHEMA[operation];
    return { mode: "json_schema", name, schema, strict: true };
  }
  if (profile.mode === "provider_json_object") {
    return { mode: "json_object", name };
  }
  return { mode: "prompt_json", sendJsonObjectHint: profile.requestHints.sendJsonObject };
}

// ── 旧链路兼容 ──
// 以下保留 invokeMemoryLlm 供尚未迁移到 Structured Output 的调用方使用。

export async function invokeMemoryLlm(request: MemoryLlmRequest): Promise<MemoryLlmResponse> {
  assertTermsExecutionAllowed();
  const { operation, messages, maxOutputTokens, signal } = request;
  const config = request.config ?? loadMemoryModelConfig();

  if (!config.apiKey) {
    throw new MemoryLlmConfigurationError(`missing API key for Memory LLM (source: ${config.source})`);
  }

  const cfg = buildVendorConfig(config);
  const adapter = getAdapterForConfig(cfg);
  const http = adapter.buildRequest({
    model: cfg.model,
    messages: messages as ChatMessage[],
    maxTokens: maxOutputTokens,
    stream: false,
  }, cfg);

  const timeoutMs = resolveTimeoutPolicy({ stage: "memory-llm" }).totalMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal?.aborted) controller.abort();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort);

  let response: Response;
  try {
    response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (signal?.aborted) throw new Error(`Memory LLM [${operation}] cancelled by external signal`);
      throw new MemoryLlmTimeoutError(timeoutMs, operation);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    let responseBody: string | undefined;
    try {
      const errorData = await response.json() as Record<string, unknown>;
      const rawMessage = (errorData as { error?: { message?: string } }).error?.message;
      responseBody = rawMessage && rawMessage.length > 1500 ? rawMessage.slice(0, 1500) + "…(truncated)" : rawMessage;
    } catch { /* ignore */ }
    throw new MemoryLlmHttpError(response.status, operation, responseBody);
  }

  let data: unknown;
  try { data = await response.json(); } catch {
    throw new MemoryLlmProtocolError(operation, "failed to parse response JSON");
  }

  const parsed = adapter.parseResponse(data);
  recordRequest(cfg.model);
  if (parsed.usage) {
    try {
      recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput, cfg.model, parsed.usage.cacheCreation);
    } catch { /* ignore */ }
  }

  return {
    text: stripThinkBlocks(parsed.text ?? ""),
    provider: config.provider,
    model: config.model,
  };
}
