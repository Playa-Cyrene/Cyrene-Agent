import { stripLeakedChatTimeContext } from "../chat-time-context";
import { ChatTimeStreamPrefixFilter } from "../chat-time-stream-filter";
import { recordUsage, recordRequest } from "../token-usage-store";
import { AgentRuntimeError } from "./agent-runtime-error";
import type {
  AgentLoopSettings,
  AgentLoopEvent,
  AgentLoopResult,
} from "./cyrene-agent";
import type {
  ChatMessage,
  ChatRequest,
  ChatVendorAdapter,
  ChatResponse,
  VendorConfig,
} from "./vendors/types";
import type { ModelRetryStatus } from "../../shared/model-retry";
import { streamChatWithSdk } from "./vendors/sdk-stream/runtime";
import { generateChatWithAiSdk } from "./vendors/model-runtime";
import { classifyModelFailure } from "./vendors/model-error-classifier";
import { runModelRequestWithRetry, type ModelRetryAttemptInput } from "./vendors/model-retry-runner";
import { readRetryAfterMs } from "./vendors/model-retry-policy";
import type { UnifiedStreamDelta } from "./vendors/sdk-stream/types";
import type { ApprovedStyleSampling } from "./vendors/style-sampling";
import { getTimeoutSettings } from "../timeout-manager";
import { resolveModelRequestTimeoutMs } from "./config/model-timeout";
import { buildContextUsageSnapshot } from "./context-usage";
import { isExplicitStreamUnsupported } from "./vendors/stream-support";
import { composePromptLayers } from "./prompt-layers";
import type { TranscriptSink } from "./transcript-sink";
import { persistGeneratedImages, type GeneratedImageStore } from "../chats/generated-image-store";

export interface ChatLoopOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
  soulSystemBaseContent: string;
  /** 每次请求才注入的本轮上下文，不能写回对话历史或稳定前缀。 */
  runtimeContext?: string;
  soulSampling?: ApprovedStyleSampling;
  timeoutMs: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  onEvent?: (event: AgentLoopEvent) => void;
  recordUsage?: (input: number, output: number, calls: number, cachedInput?: number, cacheCreation?: number) => void;
  signal?: AbortSignal;
  /** 非流式降级时的展示节奏；测试可设为 0，生产默认 20ms。 */
  fallbackRevealIntervalMs?: number;
  /** 默认使用统一 SDK 执行入口；调用方可注入流实现。 */
  streamChat?: typeof streamChatWithSdk;
  generateChat?: typeof generateChatWithAiSdk;
  /** 当前对话模式：composePromptLayers 按模式选择提示词层组合。 */
  mode?: string;
  /** 权威轨迹提交端：canonical assistant 落盘（CTA Phase 1）。 */
  transcriptSink?: TranscriptSink;
  conversationId?: string;
  assistantTurnId?: string;
  generatedImageStore?: GeneratedImageStore;
}

class StreamUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamUnavailableError";
  }
}

function waitForReveal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("E_SOUL_ONLY_CANCELLED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("E_SOUL_ONLY_CANCELLED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function emitFallbackText(
  onEvent: ChatLoopOptions["onEvent"],
  messageId: string,
  text: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const chars = Array.from(text);
  // 最长约 1.2 秒；短回复保持逐字感，长回复按小块展示。
  const targetFrames = Math.max(1, Math.min(60, Math.ceil(chars.length / 2)));
  const chunkSize = Math.max(1, Math.ceil(chars.length / targetFrames));
  for (let index = 0; index < chars.length; index += chunkSize) {
    onEvent?.({
      type: "text_message_content",
      messageId,
      delta: chars.slice(index, index + chunkSize).join(""),
    });
    if (index + chunkSize < chars.length) await waitForReveal(intervalMs, signal);
  }
}

function stripToolProtocol(text: string): string {
  return text
    .split("]<]minimax[>[").join("")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .trim();
}

export async function runChatLoop(options: ChatLoopOptions): Promise<AgentLoopResult> {
  const startedAt = Date.now();
  const usageRecorder = options.recordUsage ?? ((input, output, calls, cachedInput, cacheCreation) => recordUsage(input, output, calls, cachedInput, options.settings.model, cacheCreation));
  let usedImageCaptionFallback = false;

  const messages = options.messages;

  // 上下文容量快照（preRequest）：请求前。
  // 消息即实际请求所用的历史（超预算压缩已在 buildAgentRunOptions 阶段
  // 由 transcript 压缩链路完成，产出直接进入 options.messages），
  // 不含 composePromptLayers 追加的 runtime_context 尾部（不变量），
  // runtimeContext 由独立参数计量，避免双重计数。
  const emitContextUsage = (phase: "preRequest" | "terminal", extraAssistantReply?: string): void => {
    options.onEvent?.({
      type: "context_usage",
      contextUsage: buildContextUsageSnapshot({
        phase,
        contextWindowTokens: options.settings.contextWindowTokens,
        personaContent: options.soulSystemBaseContent,
        ...(options.runtimeContext ? { runtimeContext: options.runtimeContext } : {}),
        ...(extraAssistantReply !== undefined
          ? { messages: [...messages, { role: "assistant" as const, content: extraAssistantReply }] }
          : { messages }),
      }),
    });
  };
  emitContextUsage("preRequest");

  const timeout = getTimeoutSettings().chatRequestTimeout;

  const remainingBudget = (): number => {
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
    // 0 表示没有整轮预算；单次请求仍使用局部请求超时。
    if (options.timeoutMs <= 0 || !Number.isFinite(options.timeoutMs)) return timeout;
    const remaining = options.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("E_SOUL_ONLY_TIMEOUT");
    return Math.max(1, Math.min(timeout, remaining));
  };

  const vendorConfig: VendorConfig = {
    provider: options.settings.provider,
    baseUrl: options.settings.baseUrl,
    model: options.settings.model,
    apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport,
    reasoning: options.settings.reasoning,
    manualReasoning: options.settings.manualReasoning,
    imageGeneration: options.settings.imageGeneration,
  };

  const buildRequest = (reqMessages: ChatMessage[], stream: boolean): ChatRequest => ({
    model: options.settings.model,
    ...composePromptLayers({
      stablePrefix: options.soulSystemBaseContent,
      runtimeContext: options.runtimeContext,
      mode: options.mode,
    }, reqMessages),
    stream,
    ...(options.settings.imageGeneration?.enabled ? { imageGeneration: options.settings.imageGeneration } : {}),
    ...(options.soulSampling ?? {}),
  });

  const invokeNonStreaming = async (messages: ChatMessage[], signal: AbortSignal): Promise<ChatResponse> => {
    const request: ChatRequest = {
      ...buildRequest(messages, false),
    };
    const effectiveRequest = options.adapter.applyCacheHints?.(request, vendorConfig) ?? request;
    return (options.generateChat ?? generateChatWithAiSdk)({
      adapter: options.adapter, request: effectiveRequest, config: vendorConfig,
      timeoutMs: remainingBudget(), signal,
    });
  };

  const messageId = options.assistantTurnId ?? `msg-${Date.now()}`;
  const reasoningMessageId = `${messageId}-reasoning`;
  let emittedStreamContent = false;
  let reasoningStarted = false;
  let reasoningEnded = false;
  let textStarted = false;
  let textEnded = false;

  const startReasoning = () => {
    if (reasoningStarted) return;
    reasoningStarted = true;
    options.onEvent?.({ type: "reasoning_message_start", messageId: reasoningMessageId, role: "reasoning" });
  };
  const endReasoning = () => {
    if (!reasoningStarted || reasoningEnded) return;
    reasoningEnded = true;
    options.onEvent?.({ type: "reasoning_message_end", messageId: reasoningMessageId });
  };
  const startText = () => {
    if (textStarted) return;
    endReasoning();
    textStarted = true;
    options.onEvent?.({ type: "text_message_start", messageId, role: "assistant" });
  };
  const endText = () => {
    if (!textStarted || textEnded) return;
    textEnded = true;
    options.onEvent?.({ type: "text_message_end", messageId });
  };

  const invokeStreaming = async (messages: ChatMessage[], attempt: ModelRetryAttemptInput): Promise<{
    response: ChatResponse;
    needsReveal: boolean;
  }> => {
    const request = buildRequest(messages, true);
    const effectiveRequest = options.adapter.applyCacheHints?.(request, vendorConfig) ?? request;
    const timePrefixFilter = new ChatTimeStreamPrefixFilter();
    let text = "";
    const emitTextDelta = (delta: string) => {
      if (!delta) return;
      text += delta;
      emittedStreamContent = true;
      attempt.onVisibleDelta();
      startText();
      options.onEvent?.({ type: "text_message_content", messageId, delta });
    };
    const onDelta = (delta: UnifiedStreamDelta) => {
      attempt.onStreamActivity();
      if (delta.type === "reasoning_delta" && delta.delta) {
        emittedStreamContent = true;
        attempt.onVisibleDelta();
        startReasoning();
        options.onEvent?.({
          type: "reasoning_message_content",
          messageId: reasoningMessageId,
          delta: delta.delta,
        });
      } else if (delta.type === "text_delta" && delta.delta) {
        emitTextDelta(timePrefixFilter.push(delta.delta));
      }
    };
    try {
      const response = await (options.streamChat ?? streamChatWithSdk)({
        adapter: options.adapter,
        request: effectiveRequest,
        config: vendorConfig,
        timeoutMs: remainingBudget(),
        signal: attempt.signal,
        onStreamActivity: attempt.onStreamActivity,
        onDelta,
      });
      emitTextDelta(timePrefixFilter.finish());
      if (!text.trim() && !response.generatedImages?.length) {
        if (response.text.trim()) return { response, needsReveal: true };
        throw new AgentRuntimeError("E_MODEL_RESPONSE_PARSE_FAILED", "模型流式响应没有返回可见文本");
      }
      return {
        response: {
          ...response,
          text,
          assistantMessage: { ...response.assistantMessage, content: text },
        },
        needsReveal: false,
      };
    } catch (error) {
      if (!emittedStreamContent && isExplicitStreamUnsupported(error)) {
        throw new StreamUnavailableError("流式请求不受支持", { cause: error });
      }
      if (error instanceof AgentRuntimeError && error.modelFailure) throw error;
      if (error instanceof Error && (error.message === "E_SOUL_ONLY_CANCELLED" || error.message === "E_SOUL_ONLY_TIMEOUT")) {
        throw error;
      }
      const modelFailure = classifyModelFailure({ provider: options.adapter.id, model: effectiveRequest.model, error });
      throw new AgentRuntimeError(
        "E_MODEL_REQUEST_FAILED",
        modelFailure.status ? `模型请求失败：HTTP ${modelFailure.status}` : "模型服务请求失败。",
        {
        cause: error,
        modelFailure,
        retryAfterMs: readRetryAfterMs(error),
        },
      );
    }
  };

  let forceNonStreaming = false;
  const invokeWithStreamFallback = async (messages: ChatMessage[], attempt: ModelRetryAttemptInput) => {
    if (forceNonStreaming) {
      return { response: await invokeNonStreaming(messages, attempt.signal), needsReveal: true };
    }
    try {
      return await invokeStreaming(messages, attempt);
    } catch (error) {
      if (!(error instanceof StreamUnavailableError) || emittedStreamContent) throw error;
      forceNonStreaming = true;
      return { response: await invokeNonStreaming(messages, attempt.signal), needsReveal: true };
    }
  };

  const invokeWithRetry = (messages: ChatMessage[]) => runModelRequestWithRetry(
    (attempt) => invokeWithStreamFallback(messages, attempt),
    {
      provider: options.adapter.id,
      model: options.settings.model,
      maxRetries: options.settings.modelRequestMaxRetries ?? 5,
      idleTimeoutMs: resolveModelRequestTimeoutMs(getTimeoutSettings()),
      signal: options.signal,
      getRemainingBudgetMs: remainingBudget,
      onStatus: (status: ModelRetryStatus) => options.onEvent?.({ type: "model_retry", status }),
    },
  );

  options.onEvent?.({ type: "step_started", stepName: "chat" });
  try {
    let result;
    try {
      result = await invokeWithRetry(options.messages);
    } catch (error) {
      const failure = error instanceof AgentRuntimeError ? error.modelFailure : undefined;
      const canCaptionFallback = failure?.status === 400 && failure.category === "INVALID_REQUEST";
      if (emittedStreamContent || options.signal?.aborted || !canCaptionFallback || !options.imageCaptionFallback || usedImageCaptionFallback) {
        throw error;
      }
      usedImageCaptionFallback = true;
      result = await invokeWithRetry(await options.imageCaptionFallback());
    }

    const response = result.response;
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");

    if (result.needsReveal && response.thinking) {
      startReasoning();
      options.onEvent?.({
        type: "reasoning_message_content",
        messageId: reasoningMessageId,
        delta: response.thinking,
      });
      endReasoning();
    }

    recordRequest(options.settings.model);
    if (response.usage) {
      usageRecorder(response.usage.input, response.usage.output, 1, response.usage.cachedInput, response.usage.cacheCreation);
    }
    // 推理展示回调也可能触发取消，不提交已取消请求的 assistant 历史。
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
    const persistedImages = await persistGeneratedImages(
      options.generatedImageStore,
      options.conversationId ?? "default",
      response.generatedImages,
    );
    if (options.signal?.aborted) throw new Error("E_SOUL_ONLY_CANCELLED");
    const visibleResponseText = stripLeakedChatTimeContext(stripToolProtocol(response.text));
    const imageSaveNotice = persistedImages.failedCount > 0
      ? persistedImages.attachments.length > 0
        ? "部分生成图片保存失败。"
        : "图片生成失败，图片未能保存，请重试。"
      : "";
    let reply = [visibleResponseText, imageSaveNotice].filter(Boolean).join("\n\n");
    if (!reply && persistedImages.attachments.length === 0) {
      reply = "刚才没有生成正常回复，请再试一次。";
    }
    // 权威轨迹：归一化后的可见回复作为 canonical assistant 提交。
    // 不从流式展示文本重建 rawAssistant / thinking / 厂商原始块，原样保留。
    const canonicalAssistant: ChatMessage = {
      ...response.assistantMessage,
      role: "assistant",
      content: reply,
      ...(persistedImages.attachments.length ? { attachments: persistedImages.attachments } : {}),
    };
    await options.transcriptSink?.appendAssistant({ message: canonicalAssistant });
    if (persistedImages.attachments.length > 0) {
      options.onEvent?.({
        type: "image_attachments",
        messageId,
        attachments: persistedImages.attachments,
      });
    }
    // 终态快照：把最终回复并入历史口径（与下一轮进入历史的文本一致）。
    emitContextUsage("terminal", reply);
    if (imageSaveNotice && textStarted) {
      const delta = `${visibleResponseText ? "\n\n" : ""}${imageSaveNotice}`;
      await emitFallbackText(
        options.onEvent,
        messageId,
        delta,
        options.fallbackRevealIntervalMs ?? 20,
        options.signal,
      );
    } else if (result.needsReveal || (!textStarted && reply.length > 0)) {
      startText();
      if (reply) {
        await emitFallbackText(
          options.onEvent,
          messageId,
          reply,
          options.fallbackRevealIntervalMs ?? 20,
          options.signal,
        );
      }
    }
    endText();
    return {
      reply,
      toolResults: [],
      totalUsage: response.usage,
      completionReason: "no_tool",
    };
  } finally {
    endReasoning();
    endText();
    options.onEvent?.({ type: "step_finished", stepName: "chat" });
  }
}
