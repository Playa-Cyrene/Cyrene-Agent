/**
 * Harness LLM 调用层
 *
 * 职责：怎么跟模型供应商对话——流式优先、非流式兜底、用量记账、压缩摘要请求。
 * 全部为显式参数的纯函数，不依赖 HarnessRun 运行上下文。
 *
 * 调用方：
 * - cyrene-harness.ts 的 callRoundLLM（主循环每轮请求）
 * - cyrene-harness.ts 的 runCompaction（mid-loop 压缩摘要）
 */

import { getAdapterForConfig, streamChatWithSdk, resolveTransport } from "../vendors";
import { recordUsage, recordRequest } from "../../token-usage-store";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolSpec,
  VendorConfig,
} from "../vendors/types";
import type { HarnessConfig } from "./types";
import { AGENT_COMPACTION_PROMPT } from "./compaction";
import { isExplicitStreamUnsupported } from "../vendors/stream-support";
import {
  composePromptLayers,
  normalizeToolSpecsForCache,
  type PromptLayers,
} from "../prompt-layers";

/**
 * 输出上限策略（docs/design/2026-08-26-maxtoken-model-switch-glm53-known-issues.md 问题 1）：
 * - OpenAI / Responses 协议：max_tokens 可选，缺省即模型自身输出上限。
 *   不传，避免固定预算把长思维链拦腰截断。
 * - Anthropic 协议：max_tokens 必填（缺字段直接 400），传模型级安全大值。
 *   32k 对 Claude Sonnet 4.6+（64k）/ MiniMax M3 / GLM-5.x / DeepSeek V4 均在限内。
 *
 * config.reservedOutputTokens 仅参与压缩预算计算（computeTokenBudget），不再限流。
 */
const ANTHROPIC_REQUIRED_MAX_TOKENS = 32_768;

function resolveRequestMaxTokens(vendorConfig: VendorConfig): number | undefined {
  return resolveTransport(vendorConfig) === "anthropic"
    ? ANTHROPIC_REQUIRED_MAX_TOKENS
    : undefined;
}

/**
 * 单次 LLM 调用（流式优先）。
 * 部分兼容模型明确拒绝 stream + tools；只在零增量、明确不支持时降级为非流式，绝不重放半截流。
 */
export async function callLLM(
  vendorConfig: VendorConfig,
  promptLayers: PromptLayers,
  messages: ChatMessage[],
  tools: ToolSpec[],
  config: HarnessConfig,
  signal?: AbortSignal,
  onReasoningDelta?: (delta: string) => void,
  onTextDelta?: (delta: string) => void,
): Promise<ChatResponse> {
  const adapter = getAdapterForConfig(vendorConfig);
  const composed = composePromptLayers(promptLayers, messages);
  const requestMaxTokens = resolveRequestMaxTokens(vendorConfig);
  const baseRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: composed.messages,
    tools: normalizeToolSpecsForCache(tools),
    stream: true,
    ...(requestMaxTokens !== undefined ? { maxTokens: requestMaxTokens } : {}),
    promptLayers: composed.metadata,
  };
  // 缓存路由 hints（Kimi prompt_cache_key 等）：此前只有 ChatLoop / 压缩摘要链路注入，
  // Harness 工具循环整条链漏发；在这里统一补上，下方流式与非流式兜底共用同一份 hints。
  const chatRequest = adapter.applyCacheHints?.(baseRequest, vendorConfig) ?? baseRequest;

  let receivedStreamDelta = false;
  const recordResponseUsage = (response: ChatResponse): ChatResponse => {
    recordRequest(vendorConfig.model);
    if (!response.usage) return response;
    recordUsage(
      response.usage.input,
      response.usage.output,
      1,
      response.usage.cachedInput,
      vendorConfig.model,
      response.usage.cacheCreation,
    );
    return response;
  };
  try {
    return recordResponseUsage(await streamChatWithSdk({
      adapter,
      request: chatRequest,
      config: vendorConfig,
      timeoutMs: config.totalTimeoutMs,
      signal,
      onDelta: (delta) => {
        receivedStreamDelta = true;
        if (delta.type === "reasoning_delta" && delta.delta) onReasoningDelta?.(delta.delta);
        if (delta.type === "text_delta" && delta.delta) onTextDelta?.(delta.delta);
      },
    }));
  } catch (error) {
    if (receivedStreamDelta || !isExplicitStreamUnsupported(error)) throw error;
  }

  // 非流式兜底
  const fallbackRequest: ChatRequest = { ...chatRequest, stream: false };
  const http = adapter.buildRequest(fallbackRequest, vendorConfig);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });
  if (!response.ok) {
    // [image-send] 链路日志④：服务端拒绝时带上模型名、请求地址与完整错误体（Anthropic 400 会带具体 reason）。
    const rawBody = await response.text().catch(() => "");
    console.error(
      "[image-send] LLM 请求被拒:",
      `\n  model id: ${vendorConfig.model}`,
      `\n  baseUrl: ${http.url}`,
      `\n  error: HTTP ${response.status} ${rawBody.slice(0, 500) || "(无响应体)"}`,
    );
    const errorData = JSON.parse(rawBody || "{}") as { error?: { message?: string } };
    throw new Error(errorData.error?.message || `模型请求失败：HTTP ${response.status}`);
  }
  return recordResponseUsage(adapter.parseResponse(await response.json()));
}

/** 历史摘要（用于 mid-loop compaction）。 */
export async function summarizeHistory(
  vendorConfig: VendorConfig,
  systemPrompt: string,
  history: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
): Promise<string> {
  const adapter = getAdapterForConfig(vendorConfig);

  const chatRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: AGENT_COMPACTION_PROMPT },
    ],
    tools: normalizeToolSpecsForCache(tools),
    stream: false,
    // 摘要输出同样不受固定预算限制（见 resolveRequestMaxTokens 注释）。
    ...(resolveRequestMaxTokens(vendorConfig) !== undefined
      ? { maxTokens: resolveRequestMaxTokens(vendorConfig) }
      : {}),
  };

  const http = adapter.buildRequest(chatRequest, vendorConfig);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });

  if (!response.ok) {
    // 摘要请求被拒：与主链路失败日志同格式，带上模型名与请求地址。
    const rawBody = await response.text().catch(() => "");
    console.error(
      "[image-send] 摘要请求被拒:",
      `\n  model id: ${vendorConfig.model}`,
      `\n  baseUrl: ${http.url}`,
      `\n  error: HTTP ${response.status} ${rawBody.slice(0, 500) || "(无响应体)"}`,
    );
    throw new Error(`摘要请求失败：HTTP ${response.status}`);
  }

  const result = adapter.parseResponse(await response.json());
  return result.text;
}
