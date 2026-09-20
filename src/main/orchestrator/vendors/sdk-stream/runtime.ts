import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createThinkFilter } from "../../../chat/think-filter";
import { AgentRuntimeError } from "../../agent-runtime-error";
import type { ChatRequest, ChatResponse, ChatVendorAdapter, VendorConfig } from "../types";
import { CyreneStreamAccumulator } from "./accumulator";
import { AnthropicEventNormalizer, reconcileAnthropicTerminal } from "./anthropic-normalizer";
import { dumpRequest, dumpResponse } from "../prompt-dump";
import {
  deriveAnthropicClientConfig,
  deriveOpenAIClientConfig,
  deriveResponsesClientConfig,
  type AnthropicClientConfig,
  type OpenAIClientConfig,
} from "./client-config";
import { normalizeOpenAIChunk } from "./openai-normalizer";
import { normalizeResponsesEvent } from "./responses-normalizer";
import {
  ProviderProtocolError,
  type StreamDiagnostic,
  type UnifiedStreamDelta,
} from "./types";

export interface OpenAIStreamFactoryInput {
  client: OpenAIClientConfig;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AnthropicStreamFactoryInput {
  client: AnthropicClientConfig;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export interface SdkStreamRuntimeDeps {
  openAI: (input: OpenAIStreamFactoryInput) => Promise<AsyncIterable<unknown>>;
  responses: (input: OpenAIStreamFactoryInput) => Promise<AsyncIterable<unknown>>;
  anthropic: (input: AnthropicStreamFactoryInput) => Promise<{
    events: AsyncIterable<unknown>;
    finalMessage: () => Promise<unknown>;
  }>;
}

export interface SdkStreamRunInput {
  adapter: ChatVendorAdapter;
  request: ChatRequest;
  config: VendorConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  onDelta?: (delta: UnifiedStreamDelta) => void;
  onDiagnostic?: (diagnostic: StreamDiagnostic) => void;
}

const defaultDeps: SdkStreamRuntimeDeps = {
  openAI: async ({ client: options, body, signal }) => {
    const client = new OpenAI(options);
    const stream = await client.chat.completions.create(body as never, { signal });
    return stream as unknown as AsyncIterable<unknown>;
  },
  responses: async ({ client: options, body, signal }) => {
    const client = new OpenAI(options);
    // stream 是 body 字段不是第二个参数（SDK 7.5 重载签名，施工文档已核实）
    const stream = await client.responses.create({ ...body, stream: true } as never, { signal });
    return stream as unknown as AsyncIterable<unknown>;
  },
  anthropic: async ({ client: options, body, signal }) => {
    const client = new Anthropic(options);
    const stream = client.messages.stream(body as never, { signal });
    return {
      events: stream as unknown as AsyncIterable<unknown>,
      finalMessage: () => stream.finalMessage(),
    };
  },
};

function requestBody(adapter: ChatVendorAdapter, request: ChatRequest, config: VendorConfig): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const http = adapter.buildStreamRequest({ ...request, stream: true }, config);
  const parsed = JSON.parse(http.body) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型请求体不是 JSON 对象");
  }
  return { endpoint: http.url, body: parsed as Record<string, unknown> };
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

/** 模型错误摘要：SDK 错误自带 status / code / type（如 500 + do_request_failed + AgnesAI_error），
 * 拼成一行，让失败原因脱离堆栈也能直接读。 */
function describeModelError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { status?: unknown; code?: unknown; type?: unknown };
  const parts: string[] = [];
  if (detail.status !== undefined && detail.status !== null) parts.push(`status=${String(detail.status)}`);
  if (detail.code) parts.push(`code=${String(detail.code)}`);
  if (detail.type) parts.push(`type=${String(detail.type)}`);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${error.name}: ${error.message}${suffix}`;
}

/**
 * 捕获 Responses 流的终态事件本体（response.completed / response.incomplete 都带完整 Response）。
 * 这是 rawAssistant 补挂的 canonical source；incomplete（如 max_output_tokens 截断）时 output
 * 已含 reasoning/message/部分工具链，与 completed 同等地位，不应丢弃退化。
 */
function responsesTerminalResponse(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "response.completed" && record.type !== "response.incomplete") return undefined;
  const response = record.response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined;
  return response as Record<string, unknown>;
}

export async function streamChatWithSdk(
  input: SdkStreamRunInput,
  deps: SdkStreamRuntimeDeps = defaultDeps,
): Promise<ChatResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Model request timed out", "TimeoutError"));
    }, input.timeoutMs)
    : undefined;

  const accumulator = new CyreneStreamAccumulator();
  const taggedThinkFilter = createThinkFilter("leading-only");
  // LLM 调用原文 traceId —— 即使 dump 关闭也会生成，方便上层日志关联。
  let traceId = "";
  // 本次请求的完整地址 —— 失败日志要带上；catch 块读不到 try 内的局部变量，提升到外层。
  let requestEndpoint = "";
  const commitDelta = (delta: UnifiedStreamDelta) => {
    if (delta.type === "finish"
      && (input.adapter.transport === "openai" || input.adapter.transport === "responses")) {
      for (const toolCall of accumulator.snapshot().toolCalls) {
        if (!toolCall.ended) {
          const end: UnifiedStreamDelta = {
            type: "tool_call_end",
            index: toolCall.index,
            ...(toolCall.id ? { id: toolCall.id } : {}),
          };
          accumulator.apply(end);
          input.onDelta?.(end);
        }
      }
    }
    accumulator.apply(delta);
    input.onDelta?.(delta);
  };
  const flushTaggedThink = () => {
    const visibleTail = taggedThinkFilter.flush();
    const thinkingTail = taggedThinkFilter.takeThinking();
    if (thinkingTail) commitDelta({ type: "reasoning_delta", delta: thinkingTail });
    if (visibleTail) commitDelta({ type: "text_delta", delta: visibleTail });
  };
  const dispatch = (delta: UnifiedStreamDelta) => {
    if (delta.type === "text_delta") {
      const visible = taggedThinkFilter.push(delta.delta);
      const thinking = taggedThinkFilter.takeThinking();
      if (thinking) commitDelta({ type: "reasoning_delta", delta: thinking });
      if (visible) commitDelta({ type: "text_delta", delta: visible });
      return;
    }
    if (delta.type !== "reasoning_delta") flushTaggedThink();
    commitDelta(delta);
  };

  try {
    const prepared = requestBody(input.adapter, input.request, input.config);
    requestEndpoint = prepared.endpoint;
    traceId = dumpRequest({
      transport: input.adapter.transport,
      endpoint: prepared.endpoint,
      body: prepared.body,
    });
    if (input.adapter.transport === "openai") {
      const chunks = await deps.openAI({
        client: deriveOpenAIClientConfig(prepared.endpoint, input.config.apiKey),
        body: prepared.body,
        signal: controller.signal,
      });
      let lastChunk: unknown = null;
      for await (const chunk of chunks) {
        lastChunk = chunk;
        for (const delta of normalizeOpenAIChunk(chunk)) dispatch(delta);
      }
      flushTaggedThink();
      const openaiFinal = accumulator.finalize(lastChunk);
      dumpResponse(traceId, {
        transport: "openai",
        ok: true,
        text: openaiFinal.text,
        thinking: openaiFinal.thinking,
        toolCalls: openaiFinal.toolCalls,
        usage: openaiFinal.usage,
        raw: openaiFinal.raw,
      });
      return openaiFinal;
    }

    if (input.adapter.transport === "responses") {
      const chunks = await deps.responses({
        client: deriveResponsesClientConfig(prepared.endpoint, input.config.apiKey),
        body: prepared.body,
        signal: controller.signal,
      });
      let finalResponse: Record<string, unknown> | undefined;
      for await (const event of chunks) {
        const terminal = responsesTerminalResponse(event);
        if (terminal) finalResponse = terminal;
        for (const delta of normalizeResponsesEvent(event)) dispatch(delta);
      }
      flushTaggedThink();
      const finalized = accumulator.finalize(finalResponse);
      // rawAssistant 补挂：完整 output items 是 Responses 多轮保真的核心（accumulator 不产出该字段）。
      // 真正传输中断（无终态事件）时 finalResponse 为空 → rawAssistant 缺失 → 下轮退化构造，安全降级。
      const outputItems = finalResponse !== undefined && Array.isArray(finalResponse.output)
        ? finalResponse.output
        : undefined;
      const responsesFinal: ChatResponse = outputItems !== undefined
        ? {
            ...finalized,
            assistantMessage: { ...finalized.assistantMessage, rawAssistant: outputItems },
          }
        : finalized;
      dumpResponse(traceId, {
        transport: "responses",
        ok: true,
        text: responsesFinal.text,
        thinking: responsesFinal.thinking,
        toolCalls: responsesFinal.toolCalls,
        usage: responsesFinal.usage,
        raw: responsesFinal.raw,
      });
      return responsesFinal;
    }

    const authStyle = input.adapter.capability.anthropicAuthStyle ?? input.adapter.capability.authStyle;
    const stream = await deps.anthropic({
      client: deriveAnthropicClientConfig(prepared.endpoint, input.config.apiKey, authStyle),
      body: prepared.body,
      signal: controller.signal,
    });
    const normalizer = new AnthropicEventNormalizer();
    for await (const event of stream.events) {
      for (const delta of normalizer.normalize(event)) dispatch(delta);
    }
    flushTaggedThink();
    const finalMessage = await stream.finalMessage();
    const reconciled = reconcileAnthropicTerminal(
      accumulator.snapshot(),
      finalMessage,
      input.adapter,
      input.onDiagnostic,
    );
    dumpResponse(traceId, {
      transport: "anthropic",
      ok: true,
      text: reconciled.text,
      thinking: reconciled.thinking,
      toolCalls: reconciled.toolCalls,
      usage: reconciled.usage,
      raw: reconciled.raw,
    });
    return reconciled;
  } catch (error) {
    // [image-send] 链路日志④（流式）：失败时带上模型名、请求地址、错误码，
    // 排查"谁挂了、挂在哪"不用再翻设置或记账文件。
    console.error(
      "[image-send] 流式请求失败:",
      `\n  model id: ${input.request.model}`,
      `\n  baseUrl: ${requestEndpoint || "请求未发出"}`,
      `\n  error: ${describeModelError(error)}`,
    );
    if (traceId) {
      dumpResponse(traceId, {
        transport: input.adapter.transport,
        ok: false,
        raw: null,
        error: describeModelError(error),
      });
    }
    if (timedOut) {
      throw new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "模型响应超时，请稍后重试。", { cause: error });
    }
    if (input.signal?.aborted) throw cancellationError(input.signal);
    if (error instanceof ProviderProtocolError || error instanceof AgentRuntimeError) throw error;
    throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型服务请求失败。", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
