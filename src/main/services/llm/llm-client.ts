import type { ModelSettings } from "../../settings/model-settings";
import { getAdapterForConfig, generateChatWithAiSdk, streamChatWithSdk } from "../../orchestrator/vendors";
import type {
  ChatResponse,
  StructuredOutputRequest,
  VendorConfig,
} from "../../orchestrator/vendors";
import { AgentRuntimeError } from "../../orchestrator/agent-runtime-error";
import {
  createVisibleStreamFilter,
  stripThinkBlocks,
} from "../../chat-stream-utils";
import { recordUsage, recordRequest } from "../../token-usage-store";
import { appendApiLog } from "../../chat-api-utils";

export interface LlmClient {
  chat(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    logTiming?: boolean,
  ): Promise<string>;

  stream(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    onChunk: (text: string) => void,
    logTiming?: boolean,
  ): Promise<string>;

  chatNonStream(
    settings: LlmRequestSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    reasoningOverride?: ModelSettings["reasoning"],
    options?: {
      structuredOutput?: StructuredOutputRequest;
      maxTokens?: number;
      extraBody?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    thinking?: string;
    finishReason: string;
    refusal?: string;
    structuredValue?: unknown;
  }>;
}

/** 模型请求所需的已解析配置子集；供非聊天业务复用同一套厂商请求实现。 */
export type LlmRequestSettings = Pick<
  ModelSettings,
  "provider" | "baseUrl" | "model" | "apiKey" | "explicitTransport" | "reasoning" | "manualReasoning"
>;

function buildVendorConfig(settings: LlmRequestSettings): VendorConfig {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning,
    manualReasoning: settings.manualReasoning,
  };
}

function recordModelUsage(model: string, response: ChatResponse): void {
  recordRequest(model);
  if (response.usage) {
    recordUsage(response.usage.input, response.usage.output, 1, response.usage.cachedInput, model, response.usage.cacheCreation);
  }
}

function logRequestFailure(label: string, startedAt: number, error: unknown, signal?: AbortSignal): void {
  const elapsed = Date.now() - startedAt;
  if (signal?.aborted) {
    console.log(`[TIMING] ${label} CANCELLED at ${elapsed}ms`);
  } else if (error instanceof AgentRuntimeError && error.code === "E_MODEL_REQUEST_TIMEOUT") {
    console.log(`[TIMING] ${label} TIMEOUT at ${elapsed}ms`);
  } else {
    console.log(`[TIMING] ${label} ERROR at ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createLlmClient(): LlmClient {
  async function stream(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    onChunk: (text: string) => void,
    logTiming = true,
  ): Promise<string> {
    const startTime = Date.now();
    if (logTiming) {
      console.log(
        `[TIMING] ${label} START timeout=${timeoutMs}ms msgLen=${messages.length} sysLen=${messages[0]?.content?.length ?? 0}`,
      );
    }

    const cfg = buildVendorConfig(settings);

    try {
      const adapter = getAdapterForConfig(cfg);
      const visibleFilter = createVisibleStreamFilter();
      const response = await streamChatWithSdk({
        adapter,
        config: cfg,
        request: {
          model: cfg.model,
          messages,
          ...(temperature !== undefined ? { temperature } : {}),
          stream: true,
        },
        timeoutMs,
        onDelta: (delta) => {
          if (delta.type !== "text_delta") return;
          const visibleDelta = visibleFilter.push(delta.delta);
          if (visibleDelta) onChunk(visibleDelta);
        },
      });
      recordModelUsage(settings.model, response);

      const visibleTail = visibleFilter.flush();
      if (visibleTail) {
        onChunk(visibleTail);
      }

      const result = stripThinkBlocks(response.text);
      if (logTiming) {
        console.log(`[TIMING] ${label} OK in ${Date.now() - startTime}ms resultLen=${result.length}`);
      }
      appendApiLog(label, messages, response.text, result);
      return result;
    } catch (err) {
      if (logTiming) logRequestFailure(label, startTime, err);
      throw err;
    }
  }

  async function chat(
    settings: ModelSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    logTiming = true,
  ): Promise<string> {
    return stream(settings, messages, temperature, timeoutMs, label, () => {}, logTiming);
  }

  async function chatNonStream(
    settings: LlmRequestSettings,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    temperature: number | undefined,
    timeoutMs: number,
    label: string,
    reasoningOverride?: ModelSettings["reasoning"],
    options?: {
      structuredOutput?: StructuredOutputRequest;
      maxTokens?: number;
      extraBody?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    thinking?: string;
    finishReason: string;
    refusal?: string;
    structuredValue?: unknown;
  }> {
    const cfg: VendorConfig = {
      ...buildVendorConfig(settings),
      reasoning: reasoningOverride ?? settings.reasoning,
    };
    const adapter = getAdapterForConfig(cfg);
    const chatRequest = {
      model: cfg.model,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      stream: false,
      ...(options?.structuredOutput ? { structuredOutput: options.structuredOutput } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.extraBody ? { extraBody: options.extraBody } : {}),
    };

    const startTime = Date.now();
    console.log(
      `[TIMING] ${label} START (non-stream) timeout=${timeoutMs}ms msgLen=${messages.length} sysLen=${messages[0]?.content?.length ?? 0}`,
    );

    try {
      const parsed = await generateChatWithAiSdk({
        adapter,
        config: cfg,
        request: chatRequest,
        timeoutMs,
        signal,
      });
      recordModelUsage(settings.model, parsed);
      const totalTime = Date.now() - startTime;
      console.log(`[TIMING] ${label} OK in ${totalTime}ms resultLen=${parsed.text.length}`);
      return {
        text: parsed.text,
        thinking: parsed.thinking,
        finishReason: parsed.finishReason,
        refusal: parsed.refusal,
        structuredValue: parsed.structuredValue,
      };
    } catch (error) {
      logRequestFailure(label, startTime, error, signal);
      throw error;
    }
  }

  return { chat, stream, chatNonStream };
}
